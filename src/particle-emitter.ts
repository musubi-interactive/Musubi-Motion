import { normalizedChannels, uniqueName, type SceneDocument, type TransformChannels, type TransformNode, type Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import { PARTICLE_MAP_PIXELS, validateParticleEmissionMap, validateParticleMapSource, type ParticleEmissionMap } from "./particle-map-emission.ts";
import { compileGraph } from "./procedural-graph-runtime.ts";
import { activeParticleGraphAppearance, activeParticleGraphField, MAX_PARTICLES_PER_GRAPH_FIELD, MAX_TOTAL_GRAPH_FIELD_PARTICLES, validateParticleGraphAppearance, validateParticleGraphField,
  type ParticleGraphAppearance, type ParticleGraphField } from "./particle-map-fields.ts";

export const MAX_PARTICLE_EMITTERS = 32;
export const MAX_PARTICLES_PER_EMITTER = 20_000;
export const MAX_TOTAL_PARTICLES = 100_000;
export const PARTICLE_STEP_SECONDS = 1 / 120;
export type ParticleEmission = "omni" | "directional" | "box" | "sphere" | "surface";
export type ParticleEmitterSettings = {
  emissionMap?: ParticleEmissionMap;
  appearanceMap?: ParticleGraphAppearance;
  forceField?: ParticleGraphField;
  enabled: boolean;
  emission: ParticleEmission;
  rate: number;
  lifetime: number;
  startFrame: number;
  endFrame: number;
  seed: number;
  speed: number;
  /** Absolute speed variation: max(0, speed + (random - .5) * speedRandom). */
  speedRandom: number;
  spread: number;
  direction: Vec3;
  /** Full XYZ extents in emitter-local space. */
  volume: Vec3;
  /** World units per second squared. */
  acceleration: Vec3;
  drag: number;
  /** Start/end world-space diameters. */
  sizes: [number, number];
  colors: [string, string];
  opacities: [number, number];
  turbulence: { strength: number; scale: number };
  attraction: { position: Vec3; strength: number; radius: number };
};
export type ParticleShapeNode = ParticleEmitterSettings & { id: string; type: "particleShape"; name: string; parentId: string; surfaceId?: string };
export type ParticleEmitterPatch = Partial<ParticleEmitterSettings>;
export type ParticleEmitterOptions = Partial<TransformChannels> & { name?: string; surfaceId?: string };

export function defaultParticleSettings(): ParticleEmitterSettings {
  return { enabled: true, emission: "omni", rate: 60, lifetime: 2, startFrame: 0, endFrame: 120, seed: 1, speed: 2, speedRandom: 0.5, spread: 0.1,
    direction: [0, 1, 0], volume: [1, 1, 1], acceleration: [0, -3, 0], drag: 0.05, sizes: [0.06, 0.01], colors: ["#d8e1e8", "#758394"], opacities: [1, 0],
    turbulence: { strength: 0, scale: 1 }, attraction: { position: [0, 1, 0], strength: 0, radius: 5 } };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const numberIn = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const vectorIn = (value: unknown, min: number, max: number): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(component => numberIn(component, min, max));
const pairIn = (value: unknown, min: number, max: number) => Array.isArray(value) && value.length === 2 && value.every(component => numberIn(component, min, max));
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

export function potentialParticleCount(shape: Pick<ParticleShapeNode, "rate" | "lifetime">): number {
  return Math.ceil(shape.rate * (shape.lifetime + PARTICLE_STEP_SECONDS)) + 1;
}

export function validateParticleShape(value: unknown): asserts value is ParticleShapeNode {
  if (!record(value) || value.type !== "particleShape" || !validId(value.id) || !validId(value.parentId) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 256) throw Error("Invalid particle emitter node.");
  if (typeof value.enabled !== "boolean" || !["omni", "directional", "box", "sphere", "surface"].includes(value.emission as string)) throw Error("Invalid particle emission mode or enabled setting.");
  if (value.surfaceId !== undefined && !validId(value.surfaceId)) throw Error("Invalid particle surface reference.");
  if (value.emission === "surface" && value.surfaceId === undefined) throw Error("Surface emission requires a polygon mesh source. Create a surface emitter on a selected mesh.");
  if (value.emissionMap !== undefined) {
    validateParticleEmissionMap(value.emissionMap);
    if (value.emission !== "surface") throw Error("Texture emission maps require a mesh surface emitter.");
  }
  if (value.appearanceMap !== undefined) validateParticleGraphAppearance(value.appearanceMap);
  if (value.forceField !== undefined) validateParticleGraphField(value.forceField);
  if (!numberIn(value.rate, 0, 10000) || !numberIn(value.lifetime, 0.01, 60)) throw Error("Emission rate must be 0–10,000 per second and lifetime 0.01–60 seconds.");
  if (activeParticleGraphField(value.forceField) && potentialParticleCount({ rate: value.rate, lifetime: value.lifetime }) > MAX_PARTICLES_PER_GRAPH_FIELD)
    throw Error("An emitter using a Texture Force Field supports at most 2,000 potential live particles.");
  if (!numberIn(value.startFrame, -100000, 100000) || !numberIn(value.endFrame, -100000, 100000) || !Number.isInteger(value.startFrame) || !Number.isInteger(value.endFrame) || value.endFrame <= value.startFrame) throw Error("Emission frames must be integers within ±100,000, with end after start.");
  if (!numberIn(value.seed, 0, 0xffffffff) || !Number.isInteger(value.seed)) throw Error("Particle seed must be an unsigned 32-bit integer.");
  if (!numberIn(value.speed, 0, 10000) || !numberIn(value.speedRandom, 0, 10000) || !numberIn(value.spread, 0, 1)) throw Error("Speed and speed variation must be 0–10,000; spread must be 0–1.");
  if (!vectorIn(value.direction, -1e6, 1e6) || Math.hypot(...value.direction) <= 1e-12) throw Error("Emitter direction must be a nonzero finite XYZ vector within ±1,000,000.");
  if (!vectorIn(value.volume, 0, 10000) || value.volume.some(component => component <= 0)) throw Error("Emission volume extents must be positive and at most 10,000.");
  if (!vectorIn(value.acceleration, -100000, 100000) || !numberIn(value.drag, 0, 100)) throw Error("Acceleration must be within ±100,000 and drag within 0–100 per second.");
  if (!pairIn(value.sizes, 0, 10000) || !pairIn(value.opacities, 0, 1) || !Array.isArray(value.colors) || value.colors.length !== 2 || !value.colors.every(color => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))) throw Error("Particles need two valid sizes, #rrggbb colors and opacities in 0–1.");
  if (!record(value.turbulence) || !numberIn(value.turbulence.strength, 0, 10000) || !numberIn(value.turbulence.scale, Number.MIN_VALUE, 10000)) throw Error("Turbulence strength must be 0–10,000 with a positive scale at most 10,000.");
  if (!record(value.attraction) || !vectorIn(value.attraction.position, -1e6, 1e6) || !numberIn(value.attraction.strength, -10000, 10000) || !numberIn(value.attraction.radius, Number.MIN_VALUE, 10000)) throw Error("Attraction needs finite world position, strength within ±10,000 and positive radius at most 10,000.");
}

export function validateParticleEmitters(doc: SceneDocument): void {
  const emitters = Object.values(doc.nodes).filter(node => node.type === "particleShape");
  if (emitters.length > MAX_PARTICLE_EMITTERS) throw Error("A scene supports at most 32 particle emitters.");
  const fps = doc.animation?.fps ?? 24;
  if (!numberIn(fps, 1, 240)) throw Error("Particle emission requires a valid scene FPS between 1 and 240.");
  let total = 0, totalFieldParticles = 0, decodedPixels = 0;
  let graph: ReturnType<typeof compileGraph> | undefined;
  for (const shape of emitters) {
    validateParticleShape(shape);
    const parent = doc.nodes[shape.parentId];
    if (parent?.type !== "transform") throw Error("Particle emitter has no transform parent.");
    const images = new Map<string, number>();
    if (shape.surfaceId !== undefined) {
      const source = doc.nodes[shape.surfaceId];
      if (source?.type !== "meshShape" || doc.nodes[source.parentId]?.type !== "transform") throw Error("Particle surface source must reference an existing polygon mesh shape.");
      if (parent.parentId !== source.parentId) throw Error("A surface emitter must remain parented beneath its source mesh transform.");
      if (shape.emissionMap) {
        const program = validateParticleMapSource(doc, shape.emissionMap, source);
        for (const asset of program?.images ?? []) images.set(asset.id, asset.width * asset.height);
      }
    }
    if ((shape.endFrame - shape.startFrame) / fps > 300) throw Error("Particle emission duration cannot exceed 300 seconds at the scene FPS.");
    const potential = potentialParticleCount(shape);
    if (potential > MAX_PARTICLES_PER_EMITTER) throw Error("An emitter supports at most 20,000 potential live particles. Reduce its rate or lifetime.");
    total += potential;
    const appearance = shape.appearanceMap, field = shape.forceField;
    if (appearance?.enabled || field?.enabled) {
      if (!doc.proceduralGraph) throw Error("Particle texture effects need a Texture Graph. Create one in View > Texture Graph.");
      graph ??= compileGraph(doc.proceduralGraph, doc.textureAssets);
      if (activeParticleGraphAppearance(appearance))
        for (const asset of graph.appearanceImages) images.set(asset.id, asset.width * asset.height);
      if (activeParticleGraphField(field)) {
        totalFieldParticles += potential;
        for (const asset of graph.fieldImages) images.set(asset.id, asset.width * asset.height);
      }
    }
    for (const pixels of images.values()) decodedPixels += pixels;
    if (decodedPixels > PARTICLE_MAP_PIXELS) throw Error("Particle texture maps exceed the scene's 8,388,608 decoded pixel budget (32 MiB). Resize images or disable some texture effects.");
  }
  if (total > MAX_TOTAL_PARTICLES) throw Error("A scene supports at most 100,000 potential live particles across all emitters.");
  if (totalFieldParticles > MAX_TOTAL_GRAPH_FIELD_PARTICLES) throw Error("A scene supports at most 5,000 potential live particles across Texture Force Fields.");
}

export function findParticleShape(doc: SceneDocument, id: string): ParticleShapeNode | undefined {
  const node = doc.nodes[id];
  return node?.type === "particleShape" ? node : Object.values(doc.nodes).find((shape): shape is ParticleShapeNode => shape.type === "particleShape" && shape.parentId === id);
}

export function createParticleEmitter(store: SceneStore, emission: ParticleEmission, options: ParticleEmitterOptions = {}): string {
  const doc = store.getState().document, source = options.surfaceId !== undefined ? doc.nodes[options.surfaceId] : undefined;
  if (emission === "surface" && options.surfaceId === undefined) throw Error("Select a polygon mesh source when creating a surface emitter.");
  if (options.surfaceId !== undefined && source?.type !== "meshShape") throw Error("Surface emission requires a polygon mesh shape ID.");
  const parentId = source?.type === "meshShape" ? source.parentId : null;
  const id = crypto.randomUUID(), shapeId = crypto.randomUUID(), name = uniqueName(doc, options.name ?? `${emission}Emitter`, parentId);
  const node: TransformNode = { id, type: "transform", parentId, name, rotationOrder: "XYZ", ...normalizedChannels({ position: options.position ?? [0, 0, 0], rotation: options.rotation ?? [0, 0, 0], scale: options.scale ?? [1, 1, 1] }) };
  const shape: ParticleShapeNode = { ...defaultParticleSettings(), id: shapeId, type: "particleShape", name: `${name}Shape`, parentId: id, emission, ...(options.surfaceId !== undefined ? { surfaceId: options.surfaceId } : {}) };
  const next: SceneDocument = { ...doc, rootIds: parentId === null ? [...doc.rootIds, id] : doc.rootIds, nodes: { ...doc.nodes, [id]: node, [shapeId]: shape } };
  validateParticleEmitters(next);
  store.setState({ document: next, editLabel: "Create particle emitter" }); return id;
}

const settingsKeys = new Set(Object.keys(defaultParticleSettings()));
settingsKeys.add("emissionMap");
settingsKeys.add("appearanceMap");
settingsKeys.add("forceField");
export function updateParticleEmitter(store: SceneStore, shapeId: string, patch: ParticleEmitterPatch): void {
  const doc = store.getState().document, shape = doc.nodes[shapeId];
  if (shape?.type !== "particleShape") throw Error("Choose a particle emitter shape.");
  if (!record(patch) || Object.keys(patch).some(key => !settingsKeys.has(key))) throw Error("Emitter updates only change particle settings; parent and surface source cannot be retargeted.");
  const updated = { ...shape, ...structuredClone(patch) }, next = { ...doc, nodes: { ...doc.nodes, [shapeId]: updated } };
  validateParticleEmitters(next);
  if (JSON.stringify(updated) === JSON.stringify(shape)) return;
  store.setState({ document: next, editLabel: "Edit particle emitter" });
}
