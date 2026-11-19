import { Box3, Euler, MathUtils, Matrix3, Matrix4, Quaternion, Vector3 } from "three";
import type { SceneDocument, SplatShapeNode, Vec3 } from "./scene-document.ts";
import { componentTransformLookup, type SplatComponentTransforms } from "./splat-component-transforms.ts";
import { maskValue, type SplatScalarMask } from "./splat-masks.ts";

export type SplatDeformerWeight = { index: number; weight: number };
export type SplatDeformerKey = { channel: string; frame: number; value: number };
export type SplatDeformer = {
  id: string;
  name: string;
  kind: string;
  envelope: number;
  sourceCount: number;
  /** Missing means all originals; an empty list has no members. */
  weights?: readonly SplatDeformerWeight[];
  maskId?: string;
  params: unknown;
  keys?: readonly SplatDeformerKey[];
};

export type SplatDeformerHandleTransform = { position: Vector3; rotation: Quaternion; scale: Vector3 };
type HandleMode = "translate" | "rotate" | "scale";
export type SplatDeformerControl<P> = {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  toggle?: boolean;
  set(params: P, value: number): P;
};
export type SplatDeformerDefinition<P> = {
  kind: string;
  name: string;
  create(bounds: Box3): P;
  validate(params: unknown): void;
  prepare(params: P): (input: Vector3, output: Vector3, jacobian: Matrix3, influence: number) => void;
  controls(params: P, handle?: number): SplatDeformerControl<P>[];
  handle?: {
    get(params: P, index: number): SplatDeformerHandleTransform;
    set(params: P, index: number, transform: SplatDeformerHandleTransform): P;
    count(params: P): number;
    name?(index: number): string;
    modes?: readonly HandleMode[] | ((index: number) => readonly HandleMode[]);
  };
};
type ClusterParams = { pivot: Vec3; position: Vec3; rotation: Vec3; scale: Vec3 };
const CLUSTER_MIN_SCALE = 0.001;
const COORDINATE_LIMIT = 100000;
const axisNames = ["X", "Y", "Z"];
const clusterDefinition: SplatDeformerDefinition<ClusterParams> = {
  kind: "cluster", name: "Cluster",
  create(bounds) { return { pivot: bounds.getCenter(new Vector3()).toArray(), position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }; },
  validate(params) {
    if (!params || typeof params !== "object") throw Error("Invalid cluster handle.");
    const value = params as ClusterParams;
    for (const property of ["pivot", "position", "rotation", "scale"] as const) {
      const channel = value[property];
      if (!Array.isArray(channel) || channel.length !== 3 || channel.some(v => !Number.isFinite(v) || Math.abs(v) > COORDINATE_LIMIT) ||
        (property === "scale" && channel.some(v => v < CLUSTER_MIN_SCALE || v > 1000))) throw Error("Invalid cluster handle " + property + ".");
    }
  },
  prepare(params) {
    const pivot = new Vector3().fromArray(params.pivot), translation = new Vector3().fromArray(params.position);
    const fullScale = new Vector3().fromArray(params.scale), scale = new Vector3(), restScale = new Vector3(1, 1, 1);
    const fullRotation = clusterQuaternion(params.rotation), rotation = new Quaternion(), affine = new Matrix4();
    if (!translation.lengthSq() && fullScale.equals(restScale) && fullRotation.w === 1) return (input, output, jacobian) => {
      output.copy(input);
      jacobian.identity();
    };
    return (input, output, jacobian, influence) => {
      // Polar-style interpolation keeps positive stretches and valid rotations at
      // intermediate weights, including half influence on a 180° rotation.
      rotation.identity().slerp(fullRotation, influence);
      scale.lerpVectors(restScale, fullScale, influence);
      jacobian.setFromMatrix4(affine.makeRotationFromQuaternion(rotation).scale(scale));
      output.copy(input).sub(pivot).applyMatrix3(jacobian).add(pivot).addScaledVector(translation, influence);
    };
  },
  controls(params) {
    return (["position", "rotation", "scale", "pivot"] as const).flatMap(property => {
      const group = { position: "Move", rotation: "Rotate", scale: "Scale", pivot: "Pivot" }[property];
      return axisNames.map((axis, index) => ({
        id: property + "." + axis.toLowerCase(), label: group + " " + axis, value: params[property][index],
        min: property === "scale" ? CLUSTER_MIN_SCALE : -COORDINATE_LIMIT,
        max: property === "scale" ? 1000 : COORDINATE_LIMIT, step: property === "rotation" ? 1 : 0.01,
        set(current: ClusterParams, value: number) {
          const channel: Vec3 = [...current[property]];
          channel[index] = value;
          return { ...current, [property]: channel };
        },
      }));
    });
  },
  handle: {
    count: () => 1,
    get(params) {
      return { position: new Vector3().fromArray(params.pivot).add(new Vector3().fromArray(params.position)),
        rotation: clusterQuaternion(params.rotation), scale: new Vector3().fromArray(params.scale) };
    },
    set(params, _index, transform) {
      const angles = new Euler().setFromQuaternion(transform.rotation);
      return { ...params, position: transform.position.clone().sub(new Vector3().fromArray(params.pivot)).toArray(),
        rotation: [angles.x, angles.y, angles.z].map(MathUtils.radToDeg) as Vec3, scale: transform.scale.toArray() };
    },
  },
};

function clusterQuaternion(rotation: Vec3) {
  return new Quaternion().setFromEuler(new Euler(MathUtils.degToRad(rotation[0]), MathUtils.degToRad(rotation[1]), MathUtils.degToRad(rotation[2])));
}

// Concrete parameter types remain inside each definition. Archive validation
// runs before evaluation passes a payload to its corresponding definition.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SPLAT_DEFORMER_DEFINITIONS: readonly SplatDeformerDefinition<any>[] = [clusterDefinition];
export function getSplatDeformerDefinition(kind: string) {
  return SPLAT_DEFORMER_DEFINITIONS.find(definition => definition.kind === kind);
}

export const SPLAT_DEFORMER_LIMITS = {
  perShape: 8, sourceCount: 100000, sceneEvaluations: 250000, sceneEntries: 256,
  keys: 4096, sceneKeys: 20000, frame: 1000000, historyBytes: 64 * 1024 * 1024,
};
const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export function validateShapeDeformers(shape: Pick<SplatShapeNode, "deformers" | "scalarMasks" | "assetId">, sourceCount?: number) {
  const entries = shape.deformers;
  if (entries === undefined) return 0;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > SPLAT_DEFORMER_LIMITS.perShape)
    throw Error("A splat deformation stack supports 1–8 deformers per shape.");
  const ids = new Set<string>();
  const count = sourceCount ?? entries[0]?.sourceCount;
  let evaluations = 0;
  for (const entry of entries as readonly SplatDeformer[]) {
    const definition = entry && getSplatDeformerDefinition(entry.kind);
    if (!definition || typeof entry.id !== "string" || !entry.id || entry.id.length > 100 || ids.has(entry.id) ||
      typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 80 || !unit(entry.envelope))
      throw Error("Invalid or duplicate splat deformer.");
    ids.add(entry.id);
    if (!Number.isSafeInteger(entry.sourceCount) || entry.sourceCount < 1 || entry.sourceCount > SPLAT_DEFORMER_LIMITS.sourceCount || entry.sourceCount !== count)
      throw Error("Splat deformers require the original decoded splat count (up to 100,000 per shape).");
    if (entry.weights !== undefined) {
      if (!Array.isArray(entry.weights) || entry.weights.length > count) throw Error("Invalid splat deformer weights.");
      let previous = -1;
      for (const row of entry.weights) {
        if (!row || !Number.isSafeInteger(row.index) || row.index <= previous || row.index >= count || !unit(row.weight) || row.weight === 0)
          throw Error("Splat deformer weights require sorted, unique original indices and positive unit weights.");
        previous = row.index;
      }
    }
    if (entry.maskId !== undefined && (typeof entry.maskId !== "string" ||
      !shape.scalarMasks?.some(mask => mask.id === entry.maskId && mask.assetId === shape.assetId && mask.sourceCount === count)))
      throw Error("Splat deformer mask is missing or refers to a different source.");
    definition.validate(entry.params);
    if (entry.keys !== undefined) {
      if (!Array.isArray(entry.keys) || entry.keys.length > SPLAT_DEFORMER_LIMITS.keys) throw Error("Too many splat deformer keys.");
      const channels = new Map(splatDeformerControls(entry).filter(control => !control.toggle).map(control => [control.id, control]));
      const lastFrames = new Map<string, number>();
      for (const key of entry.keys as readonly SplatDeformerKey[]) {
        const control = key && channels.get(key.channel);
        if (!control || !Number.isSafeInteger(key.frame) || Math.abs(key.frame) > SPLAT_DEFORMER_LIMITS.frame ||
          (lastFrames.get(key.channel) ?? -Infinity) >= key.frame || !Number.isFinite(key.value) ||
          key.value < (control.min ?? -Infinity) || key.value > (control.max ?? Infinity)) throw Error("Invalid or unordered splat deformer key.");
        lastFrames.set(key.channel, key.frame);
      }
    }
    evaluations += entry.weights?.length ?? count;
  }
  return evaluations;
}

export function validateSceneSplatDeformers(doc: SceneDocument) {
  let evaluations = 0, entries = 0, keys = 0;
  for (const shape of Object.values(doc.nodes)) if (shape.type === "splatShape") {
    evaluations += validateShapeDeformers(shape);
    entries += shape.deformers?.length ?? 0;
    for (const entry of shape.deformers ?? []) keys += entry.keys?.length ?? 0;
  }
  if (evaluations > SPLAT_DEFORMER_LIMITS.sceneEvaluations) throw Error("The splat deformer scene limit is 250,000 memberships.");
  if (entries > SPLAT_DEFORMER_LIMITS.sceneEntries || keys > SPLAT_DEFORMER_LIMITS.sceneKeys)
    throw Error("The scene supports up to 256 splat deformers and 20,000 deformer keys.");
}

export function splatDeformerControls(entry: SplatDeformer, handle?: number): SplatDeformerControl<unknown>[] {
  return [
    { id: "envelope", label: "Envelope", value: entry.envelope, min: 0, max: 1, step: 0.01, set: params => params },
    ...(getSplatDeformerDefinition(entry.kind)?.controls(entry.params, handle) ?? []),
  ];
}

export function withSplatDeformerControl(entry: SplatDeformer, channel: string, value: number, field?: SplatDeformerControl<unknown>): SplatDeformer {
  if (channel === "envelope") return { ...entry, envelope: value };
  const control = field ?? splatDeformerControls(entry).find(control => control.id === channel);
  return control ? { ...entry, params: control.set(entry.params, value) } : entry;
}

export function keySplatDeformer(entry: SplatDeformer, channel: string, frame: number, value: number): SplatDeformer {
  const keys = [...(entry.keys ?? []).filter(key => key.channel !== channel || key.frame !== frame), { channel, frame, value }];
  keys.sort((a, b) => a.channel.localeCompare(b.channel) || a.frame - b.frame);
  return { ...entry, keys };
}

export function sampleSplatDeformer(entry: SplatDeformer, frame: number): SplatDeformer {
  if (!entry.keys?.length) return entry;
  const intervals = new Map<string, { before?: SplatDeformerKey; after?: SplatDeformerKey }>();
  for (const key of entry.keys) {
    const interval = intervals.get(key.channel) ?? {};
    if (key.frame <= frame) interval.before = key;
    else interval.after ??= key;
    intervals.set(key.channel, interval);
  }
  let sampled = entry;
  const controls = new Map(splatDeformerControls(entry).map(control => [control.id, control]));
  for (const [channel, { before, after }] of intervals) {
    const value = !before ? after!.value : !after ? before.value :
      MathUtils.lerp(before.value, after.value, (frame - before.frame) / (after.frame - before.frame));
    const control = controls.get(channel);
    if (control) sampled = withSplatDeformerControl(sampled, channel, value, control);
  }
  return sampled;
}

export function withSplatDeformerWeights(entry: SplatDeformer, indices: ArrayLike<number>, value: number) {
  const weights = new Map<number, number>();
  if (entry.weights) for (const row of entry.weights) weights.set(row.index, row.weight);
  else for (let index = 0; index < entry.sourceCount; index++) weights.set(index, 1);
  for (let offset = 0; offset < indices.length; offset++) {
    if (value === 0) weights.delete(indices[offset]);
    else weights.set(indices[offset], value);
  }
  return { ...entry, weights: [...weights].sort(([a], [b]) => a - b).map(([index, weight]) => ({ index, weight })) };
}

/** Collapse a local deformation chain to one affine per affected original.
 * For each source center x, A(x) = f(x), dA/dx = df/dx. The same Float32
 * coefficients feed both the Spark covariance modifier and the CPU picker. */
export function evaluateSplatDeformers(
  stack: readonly SplatDeformer[],
  masks: readonly SplatScalarMask[],
  component: SplatComponentTransforms | undefined,
  frame: number,
  readCenter: (index: number, target: Vector3) => number | void,
): SplatComponentTransforms | undefined {
  const layers = stack.map(entry => {
    const sampled = sampleSplatDeformer(entry, frame);
    return {
      apply: getSplatDeformerDefinition(sampled.kind)!.prepare(sampled.params),
      envelope: sampled.envelope,
      weights: sampled.weights && new Map(sampled.weights.map(({ index, weight }) => [index, weight])),
      mask: masks.find(mask => mask.id === sampled.maskId),
    };
  }).filter(layer => layer.envelope !== 0);
  if (!layers.length) return component;
  const sourceCount = stack[0].sourceCount, componentAt = componentTransformLookup(component);
  const source = new Vector3(), input = new Vector3(), output = new Vector3(), linear = new Matrix3(), jacobian = new Matrix3(), matrix = new Matrix4();
  const records: SplatComponentTransforms["records"][number][] = [];
  let changed = false;
  for (let index = 0; index < sourceCount; index++) {
    const prior = componentAt(index);
    let initialized = false, affected = false, sourceScale = 0;
    for (const layer of layers) {
      const weight = layer.weights ? layer.weights.get(index) ?? 0 : 1;
      const influence = layer.envelope * weight * (layer.mask && weight ? maskValue(layer.mask, index) : 1);
      if (!influence) continue;
      if (!initialized) {
        sourceScale = readCenter(index, source) ?? 0;
        input.copy(source);
        linear.identity();
        if (prior) { input.applyMatrix4(prior); linear.setFromMatrix4(prior); }
        initialized = true;
      }
      layer.apply(input, output, jacobian, influence);
      if (output.equals(input) && jacobian.equals(IDENTITY_LINEAR)) continue;
      affected = true;
      input.copy(output);
      linear.premultiply(jacobian);
    }
    if (affected) {
      output.copy(source).applyMatrix3(linear);
      matrix.setFromMatrix3(linear).setPosition(input.sub(output));
      const encoded = matrix.elements.map(Math.fround);
      linear.set(encoded[0], encoded[4], encoded[8], encoded[1], encoded[5], encoded[9], encoded[2], encoded[6], encoded[10]);
      const e = linear.elements;
      const norm = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[3], e[4], e[5]), Math.hypot(e[6], e[7], e[8]));
      if (encoded.some(value => !Number.isFinite(value) || Math.abs(value) > 1e8) ||
        !Number.isFinite(sourceScale) || norm * sourceScale > 1e17 ||
        Math.abs(linear.determinant()) <= Math.max(1e-24, norm ** 3 * 1e-15))
        throw Error("Splat deformation would produce a collapsed or out-of-range Gaussian.");
      changed = true;
      if (!matrix.equals(IDENTITY_AFFINE)) records.push({ index, matrix: encoded });
    } else if (prior) {
      records.push({ index, matrix: prior.elements });
    }
  }
  return !changed ? component : records.length ? { version: 1, sourceCount, records } : undefined;
}
const IDENTITY_AFFINE = new Matrix4();
const IDENTITY_LINEAR = new Matrix3();
