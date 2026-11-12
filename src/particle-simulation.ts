import { BufferGeometry, Color as ThreeColor, Float32BufferAttribute, Matrix3, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Triangle, Vector2, Vector3 } from "three";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { Alpha, Attraction, Color, CurlNoise, Emitter, Force, Life, Mass, Particle, Position, Radius, Rate, Scale, Span, System, Vector3D, type Behaviour } from "three-nebula";
import { triangulateMesh } from "./mesh-modeling.ts";
import { MAX_PARTICLES_PER_EMITTER, PARTICLE_STEP_SECONDS, potentialParticleCount, validateParticleEmitters, validateParticleShape, type ParticleShapeNode } from "./particle-emitter.ts";
import { createParticlePoseSampler } from "./particle-pose-sampler.ts";
import type { MeshShapeNode, SceneDocument } from "./scene-document.ts";
import { decodeParticleMapImages, particleCandidateRandom, particleMapDensity, particleMapProgram, particleMapUV, validateParticleMapSource } from "./particle-map-emission.ts";
import { compileGraph, type PixelSource } from "./procedural-graph-runtime.ts";
import { activeParticleGraphAppearance, activeParticleGraphField, applyParticleGraphAppearance, createParticleGraphSampler, ParticleGraphForce } from "./particle-map-fields.ts";
import { PARTICLE_CHECKPOINT_INTERVAL, sharedParticleCheckpoints, type ParticleCheckpoint, type ParticleCheckpointCache } from "./particle-checkpoints.ts";

export type ParticleFrame = {
  positions: Float32Array;
  /** Linear RGB, ready for Three vertex attributes. */
  colors: Float32Array;
  /** World-space diameters, independent of emitter scale. */
  sizes: Float32Array;
  opacities: Float32Array;
  count: number;
  simulationFrame: number;
};
export type ParticlePoseSampler = { worldAt(frame: number): ReadonlyMap<string, Matrix4> };
export type ParticleSimulation = { snapshotAt(frame: number): Promise<ParticleFrame>; dispose(): void };

const OUTPUT_CACHE_SIZE = 4;
const Y_AXIS = new Vector3(0, 1, 0);
const abortError = () => new DOMException("Particle evaluation was superseded or disposed.", "AbortError");
const emptyFrame = (simulationFrame: number): ParticleFrame => ({ positions: new Float32Array(), colors: new Float32Array(), sizes: new Float32Array(), opacities: new Float32Array(), count: 0, simulationFrame });
const copyFrame = (frame: ParticleFrame): ParticleFrame => ({ ...frame, positions: frame.positions.slice(), colors: frame.colors.slice(), sizes: frame.sizes.slice(), opacities: frame.opacities.slice() });

/** Rate is only an integer-birth adapter. Nebula owns creation, RNG, integration,
 * lifetime and behaviours. Its stock fractional burst count is unsafe because
 * Emitter.generate uses while(count--), and its interval discards overshoot. */
class ScheduledRate extends Rate {
  pending = 0;
  constructor() { super(0, 0); }
  override getValue(): number {
    const count = this.pending;
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_PARTICLES_PER_EMITTER) throw Error("Particle birth count exceeds the safe limit.");
    this.pending = 0;
    return count;
  }
}

// r180 implements this public method; @types/three 0.180 omits it.
type SeededSurfaceSampler = MeshSurfaceSampler & { setRandomGenerator(random: () => number): SeededSurfaceSampler };
type Surface = {
  geometry: BufferGeometry;
  material: MeshBasicMaterial;
  sampler: SeededSurfaceSampler;
  metric?: number[];
  weightWorld?: Matrix4;
};

function makeSurface(shape: MeshShapeNode): Surface | undefined {
  if (!shape.faces.length) return;
  const triangles = triangulateMesh(shape);
  const positions = new Float32Array(triangles.indices.length * 3);
  for (let i = 0; i < triangles.indices.length; i++) positions.set(triangles.positions.subarray(triangles.indices[i] * 3, triangles.indices[i] * 3 + 3), i * 3);
  const geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(positions, 3));
  if (shape.uvs) geometry.setAttribute("uv", new Float32BufferAttribute(triangles.indices.flatMap(index => shape.uvs![triangles.vertexIds[index]]), 2));
  const material = new MeshBasicMaterial();
  return { geometry, material, sampler: new MeshSurfaceSampler(new Mesh(geometry, material)) as SeededSurfaceSampler };
}

/** The Gram matrix removes translation and rotation from the area-cache key.
 * Overall scale also cancels in the probability distribution. */
function surfaceMetric(matrix: Matrix4): number[] {
  const a = new Vector3().setFromMatrixColumn(matrix, 0), b = new Vector3().setFromMatrixColumn(matrix, 1), c = new Vector3().setFromMatrixColumn(matrix, 2);
  const scale = Math.max(a.lengthSq(), b.lengthSq(), c.lengthSq());
  if (!Number.isFinite(scale) || scale <= 0) throw Error("Particle surface transform has collapsed or is non-finite.");
  return [a.dot(a), a.dot(b), a.dot(c), b.dot(b), b.dot(c), c.dot(c)].map(value => value / scale);
}
function sameMetric(a: number[] | undefined, b: number[]): boolean {
  return !!a && a.every((value, i) => Math.abs(value - b[i]) <= 32 * Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(b[i])));
}

async function buildSurfaceWeights(surface: Surface, world: Matrix4, metric: number[], yieldIfNeeded: () => Promise<void>, check: () => void): Promise<void> {
  const positions = surface.geometry.getAttribute("position"), weights = new Float32Array(positions.count);
  const triangle = new Triangle(), transformed = new Triangle(), linear = new Matrix3().setFromMatrix4(world);
  let maximum = 0;
  const ratios = new Float64Array(positions.count / 3);
  for (let index = 0; index < positions.count; index += 3) {
    triangle.a.fromBufferAttribute(positions, index); triangle.b.fromBufferAttribute(positions, index + 1); triangle.c.fromBufferAttribute(positions, index + 2);
    transformed.copy(triangle); transformed.a.applyMatrix3(linear); transformed.b.applyMatrix3(linear); transformed.c.applyMatrix3(linear);
    const ratio = transformed.getArea() / triangle.getArea();
    if (!Number.isFinite(ratio) || ratio <= 0) throw Error("Particle surface area collapsed under its historical transform.");
    ratios[index / 3] = ratio; maximum = Math.max(maximum, ratio);
    if (index % 3072 === 0) await yieldIfNeeded();
  }
  for (let index = 0; index < ratios.length; index++) weights.fill(ratios[index] / maximum / 3, index * 3, index * 3 + 3);
  check();
  surface.geometry.setAttribute("particleWeight", new Float32BufferAttribute(weights, 1));
  surface.sampler.setWeightAttribute("particleWeight").build();
  surface.metric = metric;
  surface.weightWorld = world.clone();
}

class WorldSpawn extends Position {
  mapped: { point: Vector3; normal: Vector3 }[] = [];
  mappedIndex = 0;
  readonly birthDraws = new WeakMap<Particle, number>();
  restoreDraws: number | undefined;
  readonly world = new Matrix4();
  readonly rotation = new Matrix4();
  readonly normalMatrix = new Matrix3();
  readonly point = new Vector3();
  readonly direction = new Vector3();
  readonly axis = new Vector3();
  readonly orientation = new Quaternion();

  constructor(readonly shape: ParticleShapeNode, readonly surface?: Surface) { super(); }

  setWorld(world: Matrix4): void {
    if (!world.elements.every(Number.isFinite)) throw Error("Particle emitter world transform is non-finite.");
    this.world.copy(world);
    this.rotation.extractRotation(world);
    if (!this.rotation.elements.every(Number.isFinite)) throw Error("Particle emitter transform has a collapsed axis.");
    if (this.surface) {
      if (!Number.isFinite(world.determinant()) || world.determinant() === 0) throw Error("Particle surface transform must be invertible.");
      this.normalMatrix.getNormalMatrix(world);
    }
  }

  override initialize(particle: Particle | Emitter): void {
    const { shape, point, direction, axis, orientation } = this;
    if (this.restoreDraws !== undefined) {
      // Stock Nebula setup still seeds this birth and runs the other initializers.
      // Advance its stream without sampling historical world, surface or graph.
      for (let i = 0; i < this.restoreDraws; i++) particle.rng();
      this.birthDraws.set(particle, this.restoreDraws);
      return;
    }
    let draws = 0;
    const random = () => { draws++; return particle.rng(); };
    point.set(0, 0, 0);
    if (shape.emission === "box") {
      point.set((random() - .5) * shape.volume[0], (random() - .5) * shape.volume[1], (random() - .5) * shape.volume[2]);
    } else if (shape.emission === "sphere") {
      // Uniform solid angle and cube-root radius give uniform ellipsoid volume.
      point.setFromSphericalCoords(Math.cbrt(random()), Math.acos(1 - 2 * random()), 2 * Math.PI * random());
      point.multiply(new Vector3(...shape.volume)).multiplyScalar(.5);
    } else if (shape.emission === "surface") {
      if (shape.emissionMap?.enabled) {
        const sample = this.mapped[this.mappedIndex++];
        if (!sample) throw Error("Mapped particle spawn schedule is missing.");
        point.copy(sample.point); axis.copy(sample.normal);
      } else this.surface!.sampler.setRandomGenerator(random).sample(point, axis);
      axis.applyNormalMatrix(this.normalMatrix);
    }
    point.applyMatrix4(this.world);

    const spread = shape.emission === "omni" ? 1 : shape.spread;
    direction.setFromSphericalCoords(1, Math.acos(1 - random() * (1 - Math.cos(Math.PI * spread))), 2 * Math.PI * random());
    if (shape.emission !== "omni") {
      if (shape.emission !== "surface") axis.fromArray(shape.direction).normalize().transformDirection(this.rotation);
      orientation.setFromUnitVectors(Y_AXIS, axis);
      direction.applyQuaternion(orientation);
    }
    const speed = Math.max(0, shape.speed + (random() - .5) * shape.speedRandom);
    direction.multiplyScalar(speed);
    particle.position.set(point.x, point.y, point.z);
    particle.velocity.set(direction.x, direction.y, direction.z);
    this.birthDraws.set(particle, draws);
  }
}

type Engine = { system: System; emitter: Emitter; rate: ScheduledRate; spawn: WorldSpawn; field?: ParticleGraphForce; step: number };

// Nebula 13.3.0 uses a birth-addressed stream (emitter seed and accepted spawn
// index). ScheduledRate ignores the emitter RNG and the installed behaviours
// draw only in initialize. Euler overwrites old position/velocity and clears
// acceleration each step. Restore those derived fields through a fresh setup.
const PARTICLE_STATE_WIDTH = 17;
const PARTICLES_PER_RESTORE_BATCH = 128;

function captureCheckpoint(active: Engine, surface?: Surface): ParticleCheckpoint {
  const { emitter, spawn, step } = active;
  const particles = new Float64Array(emitter.particles.length * PARTICLE_STATE_WIDTH);
  let offset = 0;
  for (const particle of emitter.particles) {
    const { position, velocity, color } = particle;
    particles.set([
      particle.spawnIndex, spawn.birthDraws.get(particle)!, particle.index ?? -1,
      position.x, position.y, position.z, velocity.x, velocity.y, velocity.z,
      particle.age, particle.energy, particle.radius, particle.scale, particle.alpha,
      color.r, color.g, color.b,
    ], offset);
    offset += PARTICLE_STATE_WIDTH;
  }
  return {
    step, particles,
    emitter: new Float64Array([emitter._spawnCount, emitter.age, emitter.currentEmitTime, emitter.cID,
      ...emitter.behaviours.flatMap(behaviour => [behaviour.age, behaviour.energy, Number(behaviour.dead)])]),
    surfaceWorld: surface?.weightWorld ? new Float64Array(surface.weightWorld.elements) : undefined,
  };
}

async function restoreCheckpoint(active: Engine, checkpoint: ParticleCheckpoint, yieldIfNeeded: () => Promise<void>): Promise<void> {
  const { emitter, spawn, system } = active;
  const { particles, emitter: state } = checkpoint;
  const count = particles.length / PARTICLE_STATE_WIDTH;
  for (let i = 0; i < count; i++) {
    const offset = i * PARTICLE_STATE_WIDTH;
    const particle = system.pool.get(Particle);
    emitter._spawnCount = particles[offset];
    spawn.restoreDraws = particles[offset + 1];
    const index = particles[offset + 2];
    emitter.setupParticle(particle, index >= 0 ? index : undefined);
    particle.position.set(particles[offset + 3], particles[offset + 4], particles[offset + 5]);
    particle.velocity.set(particles[offset + 6], particles[offset + 7], particles[offset + 8]);
    particle.age = particles[offset + 9];
    particle.energy = particles[offset + 10];
    particle.radius = particles[offset + 11];
    particle.scale = particles[offset + 12];
    particle.alpha = particles[offset + 13];
    particle.color.r = particles[offset + 14];
    particle.color.g = particles[offset + 15];
    particle.color.b = particles[offset + 16];
    if ((i + 1) % PARTICLES_PER_RESTORE_BATCH === 0) await yieldIfNeeded();
  }
  spawn.restoreDraws = undefined;
  [emitter._spawnCount, emitter.age, emitter.currentEmitTime, emitter.cID] = state;
  emitter.behaviours.forEach((behaviour, i) => {
    const offset = 4 + i * 3;
    behaviour.age = state[offset];
    behaviour.energy = state[offset + 1];
    behaviour.dead = Boolean(state[offset + 2]);
  });
  active.step = checkpoint.step;
}

/** Evaluates an immutable document/settings revision. Time is quantized to the
 * last completed 120 Hz step, anchored at startFrame, with no remainder step.
 * Births are t=0/end-exclusive, grouped at the start of their containing step.
 * This deliberate policy makes forward playback and arbitrary seek identical.
 * A new request cancels an older request. Resumable checkpoints contain only
 * completed steps and belong to one simulation of one document revision. */
export function createParticleSimulation(doc: SceneDocument, shape: ParticleShapeNode, sampler: ParticlePoseSampler = createParticlePoseSampler(doc), imagePixels?: ReadonlyMap<string, PixelSource>, checkpoints: ParticleCheckpointCache | null = sharedParticleCheckpoints): ParticleSimulation {
  validateParticleShape(shape);
  const fps = doc.animation?.fps ?? 24;
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) throw Error("Particle frame rate must be within 1–240.");
  if (potentialParticleCount(shape) > MAX_PARTICLES_PER_EMITTER) throw Error("Particle simulation exceeds the 20,000 live particle limit.");
  const duration = (shape.endFrame - shape.startFrame) / fps;
  if (duration > 300) throw Error("Particle emission may span at most 300 seconds.");
  const transform = doc.nodes[shape.parentId];
  if (transform?.type !== "transform") throw Error("Particle emitter transform is missing.");
  const source = shape.emission === "surface" ? doc.nodes[shape.surfaceId!] : undefined;
  if (shape.emission === "surface" && (source?.type !== "meshShape" || transform.parentId !== source.parentId)) throw Error("Surface particles require their original mesh parent.");
  if (shape.emissionMap && source?.type === "meshShape") validateParticleMapSource(doc, shape.emissionMap, source);
  const map = shape.emissionMap?.enabled ? shape.emissionMap : undefined;
  if (map || shape.appearanceMap?.enabled || shape.forceField?.enabled) validateParticleEmitters(doc);
  const mapProgram = map ? particleMapProgram(doc, map) : undefined;
  const appearance = activeParticleGraphAppearance(shape.appearanceMap), field = activeParticleGraphField(shape.forceField);
  const effectProgram = appearance || field ? compileGraph(doc.proceduralGraph!, doc.textureAssets) : undefined;
  const images = [...new Set([
    ...(mapProgram?.images ?? []),
    ...(appearance ? effectProgram!.appearanceImages : []),
    ...(field ? effectProgram!.fieldImages : []),
  ])];
  let pixels = imagePixels;

  let surface: Surface | undefined;
  let surfacePrepared = false;
  let engine: Engine | undefined;
  let generation = 0, disposed = false;
  const outputs = new Map<number, ParticleFrame>();
  const checkpointOwner = Symbol("particle replay");

  function destroyEngine(active: Engine): void {
    active.system.destroy();
    active.emitter.particles.length = 0;
    active.emitter.initializers.length = 0;
    active.emitter.behaviours.length = 0;
  }
  function releaseEngine(): void {
    if (!engine) return;
    destroyEngine(engine);
    engine = undefined;
  }
  function makeEngine(): Engine {
    const system = new System(0, "euler", shape.seed), emitter = new Emitter(), rate = new ScheduledRate(), spawn = new WorldSpawn(shape, surface);
    emitter.bindEmitter = false;
    // Nebula's reference interval is 0.0167, not exactly 1/60. Its default
    // fixedTimeStep exposes that interval; update below still uses exactly 1/120.
    emitter.damping = 1 - Math.exp(-shape.drag * system.fixedTimeStep);
    emitter.setRate(rate);
    emitter.setInitializers([spawn, new Life(shape.lifetime), new Mass(1), new Radius(.5)]);
    const size = new Scale(...shape.sizes);
    // The library constructor uses scaleA || 1; zero is an authored value here.
    size.scaleA = new Span(shape.sizes[0]);
    const behaviours: Behaviour[] = [new Force(...shape.acceleration.map(value => value / 100) as [number, number, number]), new Alpha(...shape.opacities), new Color(...shape.colors), size];
    if (shape.turbulence.strength !== 0) behaviours.push(new CurlNoise(shape.turbulence.scale, shape.turbulence.strength, shape.seed));
    if (shape.attraction.strength !== 0) behaviours.push(new Attraction(new Vector3D(...shape.attraction.position), shape.attraction.strength / 100, shape.attraction.radius));
    const graphField = field ? new ParticleGraphForce(field, effectProgram!.sampleField, fps, pixels) : undefined;
    if (graphField) behaviours.push(graphField);
    emitter.setBehaviours(behaviours);
    system.addEmitter(emitter);
    emitter.emit();
    return { system, emitter, rate, spawn, field: graphField, step: 0 };
  }
  function remember(step: number, output: ParticleFrame): ParticleFrame {
    outputs.delete(step); outputs.set(step, output);
    if (outputs.size > OUTPUT_CACHE_SIZE) outputs.delete(outputs.keys().next().value!);
    return copyFrame(output);
  }

  return {
    async snapshotAt(frame) {
      const request = ++generation;
      const check = () => { if (disposed || request !== generation) throw abortError(); };
      check();
      if (!Number.isFinite(frame)) throw Error("Particle frame must be finite.");
      // Correct only floating point noise at integer step boundaries. A genuinely
      // fractional request always selects the preceding completed step.
      const rawStep = (frame - shape.startFrame) / fps / PARTICLE_STEP_SECONDS;
      const nearest = Math.round(rawStep);
      const roundoff = 8 * Number.EPSILON * Math.max(1, Math.abs(frame), Math.abs(shape.startFrame)) / fps / PARTICLE_STEP_SECONDS;
      const targetStep = Math.abs(rawStep - nearest) <= roundoff ? nearest : Math.floor(rawStep);
      if (!Number.isSafeInteger(targetStep)) throw Error("Particle frame is outside the supported evaluation range.");
      const simulationFrame = shape.startFrame + targetStep * PARTICLE_STEP_SECONDS * fps;
      const elapsed = targetStep * PARTICLE_STEP_SECONDS;
      if (!shape.enabled || shape.rate === 0 || targetStep <= 0 || elapsed >= duration + shape.lifetime + PARTICLE_STEP_SECONDS || (source?.type === "meshShape" && !source.faces.length)) return emptyFrame(simulationFrame);
      // Position and age still come from a completed step. An appearance graph
      // sees the precise requested scene time even within that same step.
      const outputKey = appearance ? frame : targetStep;
      const cached = outputs.get(outputKey);
      if (cached) return remember(outputKey, cached);
      let yieldedAt = performance.now();
      const yieldIfNeeded = async () => {
        check();
        if (performance.now() - yieldedAt >= 4) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          check(); yieldedAt = performance.now();
        }
      };

      try {
        if (images.length && !pixels) pixels = await decodeParticleMapImages(images, check);
        if (!surfacePrepared) {
          surface = source?.type === "meshShape" ? makeSurface(source) : undefined;
          surfacePrepared = true;
        }
        const checkpoint = checkpoints?.find(checkpointOwner, targetStep);
        if (!engine || targetStep < engine.step || (checkpoint && checkpoint.step > engine.step)) {
          releaseEngine();
          if (surface) {
            // Metric equality is approximate. Rebuild from the exact matrix
            // that produced the checkpoint's distribution, not the last seek's.
            const weightWorld = checkpoint?.surfaceWorld;
            if (weightWorld) {
              const world = new Matrix4().fromArray(weightWorld);
              if (!surface.weightWorld?.equals(world)) await buildSurfaceWeights(surface, world, surfaceMetric(world), yieldIfNeeded, check);
            } else {
              surface.metric = undefined;
              surface.weightWorld = undefined;
            }
          }
          check();
          // A superseding request may start while a large checkpoint is
          // restoring. Publish only after the entire engine is ready.
          const prepared = makeEngine();
          try {
            if (checkpoint) await restoreCheckpoint(prepared, checkpoint, yieldIfNeeded);
            check();
            engine = prepared;
          } catch (error) {
            destroyEngine(prepared);
            throw error;
          }
        }
        const active = engine;
        while (active.step < targetStep) {
          check();
          const from = Math.min(active.step * PARTICLE_STEP_SECONDS, duration), to = Math.min((active.step + 1) * PARTICLE_STEP_SECONDS, duration);
          // ceil includes t=0. Snap roundoff near positive integer boundaries,
          // but preserve the first birth even for extremely small positive rates.
          const countAt = (seconds: number) => {
            if (seconds <= 0) return 0;
            const value = seconds * shape.rate, rounded = Math.round(value);
            return rounded > 0 && Math.abs(value - rounded) <= 8 * Number.EPSILON * Math.max(1, value) ? rounded : Math.max(1, Math.ceil(value));
          };
          let births = countAt(to) - countAt(from);
          if (active.emitter.particles.length + births > MAX_PARTICLES_PER_EMITTER) throw Error("Particle simulation would exceed 20,000 live particles.");
          const birthFrame = shape.startFrame + active.step * PARTICLE_STEP_SECONDS * fps;
          let birthWorld: Matrix4 | undefined;
          if (births > 0) {
            const world = sampler.worldAt(birthFrame).get(shape.parentId);
            if (!world) throw Error("Historical particle emitter transform is missing.");
            birthWorld = world;
            active.spawn.setWorld(world);
            if (surface) {
              const metric = surfaceMetric(world);
              if (!sameMetric(surface.metric, metric)) {
                await buildSurfaceWeights(surface, world, metric, yieldIfNeeded, check);
              }
            }
            check();
            if (map && mapProgram && surface) {
              const accepted: { point: Vector3; normal: Vector3 }[] = [];
              for (let candidate = countAt(from); candidate < countAt(to); candidate++) {
                const random = particleCandidateRandom(shape.seed, candidate), point = new Vector3(), normal = new Vector3(), uv = new Vector2();
                surface.sampler.setRandomGenerator(random).sample(point, normal, undefined, uv);
                const local = point.toArray() as [number, number, number];
                const rgba = mapProgram.sample({ uv: particleMapUV(map, local, uv.toArray()), position: local, frame: birthFrame, fps }, pixels);
                if (random() < particleMapDensity(map, rgba)) accepted.push({ point, normal });
              }
              active.spawn.mapped = accepted; active.spawn.mappedIndex = 0; births = accepted.length;
            }
          }
          check();
          if (active.field && (births || active.emitter.particles.length)) {
            const world = field!.space === "emitter" ? birthWorld ?? sampler.worldAt(birthFrame).get(shape.parentId) : undefined;
            active.field.setFrame(birthFrame, world);
            // Prepare the expensive graph evaluations before Nebula advances
            // any live particle. Only newly appended births sample in update().
            await active.field.prepare(active.emitter.particles, PARTICLE_STEP_SECONDS, yieldIfNeeded, check);
            check();
          }
          active.rate.pending = births;
          // CPU work happens synchronously; the returned Promise is already
          // resolved. Explicit chunk yields, not microtask awaits, keep UI live.
          void active.system.update(PARTICLE_STEP_SECONDS);
          active.spawn.mapped = []; active.spawn.mappedIndex = 0;
          active.step++;
          if (checkpoints && active.step % PARTICLE_CHECKPOINT_INTERVAL === 0 &&
              checkpoints.find(checkpointOwner, active.step)?.step !== active.step) {
            const checkpoint = captureCheckpoint(active, surface);
            if (checkpoint.particles.every(Number.isFinite)) checkpoints.add(checkpointOwner, checkpoint);
          }
          await yieldIfNeeded();
        }
        check();
        const particles = active.emitter.particles, count = particles.length;
        const output: ParticleFrame = { count, simulationFrame, positions: new Float32Array(count * 3), colors: new Float32Array(count * 3), sizes: new Float32Array(count), opacities: new Float32Array(count) };
        const color = new ThreeColor();
        const display = appearance && count ? createParticleGraphSampler(effectProgram!.sampleAppearance, appearance.space, fps, pixels) : undefined;
        if (display) display.setFrame(frame, appearance!.space === "emitter" ? sampler.worldAt(simulationFrame).get(shape.parentId) : undefined);
        for (let i = 0; i < count; i++) {
          const particle = particles[i];
          output.positions.set([particle.position.x, particle.position.y, particle.position.z], i * 3);
          // Nebula interpolates its hex colors in sRGB; Three attributes are linear.
          color.setRGB(particle.color.r, particle.color.g, particle.color.b).convertSRGBToLinear();
          let diameter = 2 * particle.radius, opacity = particle.alpha;
          if (display && appearance) {
            ({ diameter, opacity } = applyParticleGraphAppearance(appearance, display.sample(particle.position, particle.age, particle.life), color, opacity, diameter));
            if ((i + 1) % 128 === 0) {
              await yieldIfNeeded();
              check();
            }
          }
          output.colors.set([color.r, color.g, color.b], i * 3);
          output.sizes[i] = diameter;
          output.opacities[i] = opacity;
        }
        check();
        for (const values of [output.positions, output.colors, output.sizes, output.opacities]) if (!values.every(Number.isFinite)) throw Error("Particle simulation produced non-finite output. Reduce motion or field strength.");
        return remember(outputKey, output);
      } catch (error) {
        if (request === generation && !disposed) releaseEngine();
        throw error;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++;
      releaseEngine(); outputs.clear(); checkpoints?.clear(checkpointOwner);
      surface?.geometry.dispose(); surface?.material.dispose(); surface = undefined;
      pixels = undefined;
    },
  };
}
