import { Matrix3, Matrix4, Vector3 } from "three";
import { Behaviour, type Particle } from "three-nebula";
import type { PixelSource } from "./procedural-graph-runtime.ts";
import type { Vec3 } from "./scene-document.ts";

export type ParticleGraphSpace = "world" | "emitter";
export type ParticleGraphAppearance = {
  enabled: boolean;
  space: ParticleGraphSpace;
  blend: number;
  color: boolean;
  opacity: boolean;
  size: boolean;
};
export type ParticleGraphField = {
  enabled: boolean;
  space: ParticleGraphSpace;
  strength: number;
};

export const MAX_PARTICLE_FIELD_STRENGTH = 100;
export const MAX_PARTICLES_PER_GRAPH_FIELD = 2000;
export const MAX_TOTAL_GRAPH_FIELD_PARTICLES = 5000;
export const MAX_PARTICLE_GRAPH_SIZE = 8;

export function defaultParticleGraphAppearance(): ParticleGraphAppearance {
  return { enabled: false, space: "world", blend: 1, color: true, opacity: true, size: true };
}
export function defaultParticleGraphField(): ParticleGraphField {
  return { enabled: false, space: "world", strength: 5 };
}
export function activeParticleGraphAppearance(setting?: ParticleGraphAppearance) {
  return setting?.enabled && setting.blend > 0 && (setting.color || setting.opacity || setting.size) ? setting : undefined;
}
export function activeParticleGraphField(setting?: ParticleGraphField) {
  return setting?.enabled && setting.strength !== 0 ? setting : undefined;
}

const keysMatch = (value: unknown, template: object): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === Object.keys(template).length && Object.keys(template).every(key => Object.hasOwn(value, key));
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const isSpace = (value: unknown) => value === "world" || value === "emitter";

export function validateParticleGraphAppearance(value: unknown): asserts value is ParticleGraphAppearance {
  if (!keysMatch(value, defaultParticleGraphAppearance()) || !isSpace(value.space) || !finite(value.blend, 0, 1) ||
      ![value.enabled, value.color, value.opacity, value.size].every(flag => typeof flag === "boolean"))
    throw Error("Invalid particle Texture Appearance. Use World or Emitter space and a blend from 0 to 1.");
}

export function validateParticleGraphField(value: unknown): asserts value is ParticleGraphField {
  if (!keysMatch(value, defaultParticleGraphField()) || typeof value.enabled !== "boolean" || !isSpace(value.space) ||
      !finite(value.strength, -MAX_PARTICLE_FIELD_STRENGTH, MAX_PARTICLE_FIELD_STRENGTH))
    throw Error("Invalid particle Texture Force Field. Use World or Emitter space and a strength from -100 to 100.");
}

export type ParticleGraphSample = {
  uv: [number, number];
  position: Vec3;
  frame: number;
  fps: number;
  particleAge: number;
  particleLifetime: number;
};
export type ParticleGraphValues = {
  rgba: [number, number, number, number];
  size: number;
  field: Vec3;
};
export type SampleParticleGraph = (point: ParticleGraphSample, values: ParticleGraphValues, images?: ReadonlyMap<string, PixelSource>) => void;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** A stateless graph consumer with scratch storage for one serial replay or display loop. */
export function createParticleGraphSampler(sampleGraph: SampleParticleGraph, space: ParticleGraphSpace, fps: number, images?: ReadonlyMap<string, PixelSource>) {
  const point: ParticleGraphSample = { uv: [0, .5], position: [0, 0, 0], frame: 0, fps, particleAge: 0, particleLifetime: 0 };
  const values: ParticleGraphValues = { rgba: [0, 0, 0, 1], size: 1, field: [0, 0, 0] };
  const position = new Vector3(), inverse = new Matrix4(), basis = new Matrix3();
  return {
    setFrame(frame: number, world?: Matrix4) {
      point.frame = frame;
      if (space === "world") return;
      if (!world || !world.elements.every(Number.isFinite)) throw Error("Historical particle graph transform is missing or non-finite.");
      const determinant = world.determinant();
      if (!Number.isFinite(determinant) || determinant === 0) throw Error("Emitter-space particle graphs require an invertible emitter transform.");
      inverse.copy(world).invert();
      basis.setFromMatrix4(world);
    },
    sample(center: { x: number; y: number; z: number }, age: number, lifetime: number): ParticleGraphValues {
      position.set(center.x, center.y, center.z);
      if (space === "emitter") position.applyMatrix4(inverse);
      if (![position.x, position.y, position.z, age, lifetime].every(Number.isFinite)) throw Error("Particle graph input is non-finite.");
      position.toArray(point.position);
      point.particleAge = Math.max(0, age);
      point.particleLifetime = lifetime;
      point.uv[0] = lifetime > 0 ? clamp01(age / lifetime) : 0;
      sampleGraph(point, values, images);
      return values;
    },
    force(field: Vec3, strength: number, output: Vector3): Vector3 {
      if (!field.every(Number.isFinite)) throw Error("Texture Graph returned a non-finite particle force.");
      output.fromArray(field);
      const magnitude = Math.min(1, Math.hypot(...field));
      if (magnitude === 0) return output;
      // Transform the direction through the emitter basis, keeping the local
      // field magnitude independent of object scale.
      if (space === "emitter") output.applyMatrix3(basis);
      const length = Math.hypot(output.x, output.y, output.z);
      if (!Number.isFinite(length) || length === 0) throw Error("Particle force transform produced an invalid direction.");
      const gain = magnitude * strength;
      return output.set(output.x / length * gain, output.y / length * gain, output.z / length * gain);
    },
  };
}

/** Nebula advances age before applying behaviours and integrates immediately after.
 * Sample the pre-integration state at the beginning of this fixed step. */
export class ParticleGraphForce extends Behaviour {
  private readonly sampler;
  private readonly acceleration = new Vector3();
  private prepared = new Float64Array();
  private preparedCount = 0;

  constructor(private readonly field: ParticleGraphField, sample: SampleParticleGraph, fps: number, pixels?: ReadonlyMap<string, PixelSource>) {
    super();
    this.sampler = createParticleGraphSampler(sample, field.space, fps, pixels);
  }

  setFrame(frame: number, world?: Matrix4) {
    this.sampler.setFrame(frame, world);
  }

  private sample(particle: Particle, age: number) {
    const values = this.sampler.sample(particle.position, age, particle.life);
    return this.sampler.force(values.field, this.field.strength, this.acceleration);
  }

  /** Existing particles keep their list indices through the integration step.
   * Nebula appends new births first, then removes dead rows after integration. */
  async prepare(particles: readonly Particle[], dt: number, yieldIfNeeded: () => Promise<void>, check: () => void) {
    const count = particles.length;
    this.preparedCount = 0;
    if (count > MAX_PARTICLES_PER_GRAPH_FIELD) throw Error("Particle force work exceeded the per-emitter live particle limit.");
    if (count * 3 > this.prepared.length) {
      const capacity = Math.min(MAX_PARTICLES_PER_GRAPH_FIELD, Math.max(count, 64, this.prepared.length * 2 / 3));
      this.prepared = new Float64Array(capacity * 3);
    }
    for (let index = 0; index < count; index++) {
      const particle = particles[index];
      // Match the integrator's add/subtract order for exactly the same age.
      this.sample(particle, (particle.age + dt) - dt).toArray(this.prepared, index * 3);
      if ((index + 1) % 64 === 0) {
        await yieldIfNeeded();
        check();
      }
    }
    check();
    this.preparedCount = count;
  }

  override mutate(particle: Particle, dt: number, index?: number) {
    if (index !== undefined && index < this.preparedCount) {
      const offset = index * 3;
      particle.acceleration.x += this.prepared[offset];
      particle.acceleration.y += this.prepared[offset + 1];
      particle.acceleration.z += this.prepared[offset + 2];
    } else {
      const { x, y, z } = this.sample(particle, particle.age - dt);
      particle.acceleration.x += x;
      particle.acceleration.y += y;
      particle.acceleration.z += z;
    }
  }
}

export function applyParticleGraphAppearance(
  setting: ParticleGraphAppearance, sample: ParticleGraphValues,
  color: { r: number; g: number; b: number }, opacity: number, diameter: number,
) {
  const { rgba, size } = sample, { blend } = setting;
  if (setting.opacity && !Number.isFinite(rgba[3])) throw Error("Texture Graph returned a non-finite particle opacity.");
  if (setting.size && !Number.isFinite(size)) throw Error("Texture Graph returned a non-finite particle size.");
  if (setting.color) {
    if (![rgba[0], rgba[1], rgba[2]].every(Number.isFinite)) throw Error("Texture Graph returned a non-finite particle color.");
    color.r += (clamp01(rgba[0]) - color.r) * blend;
    color.g += (clamp01(rgba[1]) - color.g) * blend;
    color.b += (clamp01(rgba[2]) - color.b) * blend;
  }
  return {
    opacity: setting.opacity ? opacity * (1 + (clamp01(rgba[3]) - 1) * blend) : opacity,
    diameter: setting.size ? diameter * (1 + (Math.min(MAX_PARTICLE_GRAPH_SIZE, Math.max(0, size)) - 1) * blend) : diameter,
  };
}
