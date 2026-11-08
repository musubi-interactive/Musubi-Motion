import { Box3, Matrix3, Matrix4, Quaternion, Vector3 } from "three";
import type { SceneDocument } from "./scene-document.ts";
import type { SplatSelectionIdentity, SplatSelectionIndices } from "./splat-component-selection.ts";
import { isSplatComponentActive } from "./splat-component-edits.ts";

/** Matrices act on original rest coordinates before elasticity/linear skinning.
 * Source indices, never renderer/LoD/generated indices, are the stable identity. */
export type SplatComponentTransforms = {
  version: 1;
  sourceCount: number;
  records: readonly { index: number; matrix: readonly number[] }[];
};
export const SPLAT_TRANSFORM_GESTURE_LIMIT = 100000;
export const SPLAT_TRANSFORM_SCENE_LIMIT = 250000;
export const SPLAT_TRANSFORM_HISTORY_BYTES = 64 * 1024 * 1024;
const ROW_BYTES = 192;
const IDENTITY = new Matrix4();

export function checkedAffine(value: Matrix4, label = "Component transform"): Matrix4 {
  const e = value.elements;
  if (e.length !== 16 || !e.every(Number.isFinite) || e.some(v => Math.abs(v) > 1e8)
    || Math.abs(e[3]) > 1e-12 || Math.abs(e[7]) > 1e-12 || Math.abs(e[11]) > 1e-12 || Math.abs(e[15] - 1) > 1e-12)
    throw Error(`${label} must be a finite affine matrix within ±100,000,000. Nothing changed.`);
  const linear = new Matrix3().setFromMatrix4(value), inverse = linear.clone().invert();
  const norm = Math.max(...linear.elements.map(Math.abs));
  const inverseNorm = Math.max(...inverse.elements.map(Math.abs));
  if (Math.abs(linear.determinant()) < 1e-15 || norm * inverseNorm > 1e7 || !inverseNorm || !Number.isFinite(inverseNorm))
    throw Error(`${label} is singular or nearly singular. Use nonzero scales or a less collapsed skin pose; nothing changed.`);
  const result = value.clone();
  result.elements[3] = result.elements[7] = result.elements[11] = 0; result.elements[15] = 1;
  return result;
}

export function validateSplatComponentTransforms(value: unknown, decodedCount?: number): asserts value is SplatComponentTransforms {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid splat component transforms.");
  const data = value as Partial<SplatComponentTransforms>;
  if (data.version !== 1) throw Error("Unsupported splat component transforms version. This build opens version 1.");
  if (!Number.isSafeInteger(data.sourceCount) || data.sourceCount! < 1 || data.sourceCount! > 134217728
    || (decodedCount !== undefined && data.sourceCount !== decodedCount)) throw Error("Splat component transforms do not match the original decoded splat count.");
  if (!Array.isArray(data.records) || !data.records.length || data.records.length > SPLAT_TRANSFORM_SCENE_LIMIT)
    throw Error("Component transforms require 1–250,000 sparse original records.");
  let previous = -1;
  for (const record of data.records) {
    if (!record || !Number.isSafeInteger(record.index) || record.index <= previous || record.index >= data.sourceCount!
      || !Array.isArray(record.matrix) || record.matrix.length !== 16) throw Error("Component transform records must have ordered unique original indices and 16-value matrices.");
    checkedAffine(new Matrix4().fromArray(record.matrix), "Saved component transform");
    previous = record.index;
  }
}

export function componentTransformLookup(value?: SplatComponentTransforms): (index: number) => Matrix4 | undefined {
  const records = new Map(value?.records.map(record => [record.index, new Matrix4().fromArray(record.matrix)]));
  return index => records.get(index);
}

/** Factor columns describe an ellipsoid exactly, including affine shear.
 * CPU bounds/rays use the factor rather than lossy TRS decomposition. */
export function gaussianFactor(center: Vector3, scales: Vector3, quaternion: Quaternion, affine?: Matrix4): Matrix4 {
  const factor = new Matrix4().compose(center, quaternion, scales);
  return affine ? factor.premultiply(affine) : factor;
}

export function gaussianBounds(factor: Matrix4, sigma = 1): Box3 {
  const e = factor.elements, center = new Vector3(e[12], e[13], e[14]);
  const extent = new Vector3(Math.hypot(e[0], e[4], e[8]), Math.hypot(e[1], e[5], e[9]), Math.hypot(e[2], e[6], e[10])).multiplyScalar(sigma);
  return new Box3(center.clone().sub(extent), center.clone().add(extent));
}

/** Symmetric Jacobi eigensolve for generated elastic fill only. Original
 * Gaussians remain exact affine covariances on CPU and GPU. */
export function transformGaussianTRS(rotation: Quaternion, scales: Vector3, affine?: Matrix4): { quaternion: Quaternion; scales: Vector3 } {
  if (!affine) return { quaternion: rotation.clone(), scales: scales.clone() };
  const factor = gaussianFactor(new Vector3(), scales, rotation, affine).elements;
  const c = Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, col) =>
    factor[row] * factor[col] + factor[row + 4] * factor[col + 4] + factor[row + 8] * factor[col + 8]));
  const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iteration = 0; iteration < 24; iteration++) {
    let p = 0, q = 1;
    for (const [a, b] of [[0, 2], [1, 2]]) if (Math.abs(c[a][b]) > Math.abs(c[p][q])) { p = a; q = b; }
    if (Math.abs(c[p][q]) < 1e-14 * Math.max(c[0][0], c[1][1], c[2][2])) break;
    const angle = .5 * Math.atan2(2 * c[p][q], c[q][q] - c[p][p]);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    basis[p][p] = basis[q][q] = cos; basis[p][q] = sin; basis[q][p] = -sin;
    const next = c.map((row, i) => row.map((_, j) => {
      let sum = 0;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) sum += basis[a][i] * c[a][b] * basis[b][j];
      return sum;
    }));
    for (let i = 0; i < 3; i++) {
      const a = vectors[i][p], b = vectors[i][q];
      vectors[i][p] = cos * a - sin * b; vectors[i][q] = sin * a + cos * b;
      for (let j = 0; j < 3; j++) c[i][j] = next[i][j];
    }
  }
  const matrix = new Matrix4().set(vectors[0][0], vectors[0][1], vectors[0][2], 0, vectors[1][0], vectors[1][1], vectors[1][2], 0, vectors[2][0], vectors[2][1], vectors[2][2], 0, 0, 0, 0, 1);
  return { quaternion: new Quaternion().setFromRotationMatrix(matrix).normalize(), scales: new Vector3(Math.sqrt(Math.max(0, c[0][0])), Math.sqrt(Math.max(0, c[1][1])), Math.sqrt(Math.max(0, c[2][2]))) };
}

export type SplatTransformSnapshot = {
  pivot: Vector3;
  indices: readonly number[];
  /** Immutable weights sampled once for the gesture; all share one pivot. */
  weights: readonly number[];
  changes(deltaWorld: Matrix4): SplatComponentTransforms | undefined;
};
export function captureSplatComponentTransform(options: {
  document: SceneDocument; identity: SplatSelectionIdentity; selected: SplatSelectionIndices;
  world: Matrix4; getRestCenter(index: number): Vector3; getGaussian?(index: number): { scales: Vector3; quaternion: Quaternion }; getSkinMatrix?(index: number): Matrix4;
  weights?: ArrayLike<number>;
  weightFrame?: { basis: Quaternion; mode: "translate" | "rotate" | "scale"; pivot?: Vector3 };
}): SplatTransformSnapshot {
  const { document, identity, selected } = options;
  const shape = document.nodes[identity.shapeId];
  if (shape?.type !== "splatShape" || shape.assetId !== identity.assetId || !document.assets[identity.assetId]) throw Error("The selected splat source changed.");
  if (!selected.length || selected.length > SPLAT_TRANSFORM_GESTURE_LIMIT) throw Error("Select 1–100,000 visible splats per transform gesture. Use smaller regions; nothing changed.");
  const indices = [...new Set(selected)].sort((a, b) => a - b);
  if (options.weights && options.weights.length !== selected.length) throw Error("Each selected original needs one soft-selection weight.");
  const weightByIndex = new Map<number, number>();
  Array.from(selected).forEach((index, offset) => {
    const weight = options.weights?.[offset] ?? 1;
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw Error("Soft-selection weights must be finite from zero to one.");
    if (weightByIndex.has(index) && weightByIndex.get(index) !== weight) throw Error("A repeated original cannot have conflicting soft weights.");
    weightByIndex.set(index, weight);
  });
  const weights = Object.freeze(indices.map(index => weightByIndex.get(index)!));
  const positiveCount = weights.filter(weight => weight > 0).length;
  const world = checkedAffine(options.world, "Object world matrix"), inverseWorld = world.clone().invert();
  const lookup = componentTransformLookup(shape.componentTransforms), pivot = new Vector3();
  const captured = indices.map((index, offset) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= identity.count || !isSplatComponentActive(shape.componentEdits, index)) throw Error("Transform only visible original splats in the current source.");
    const rest = options.getRestCenter(index).clone();
    if (!rest.toArray().every(Number.isFinite)) throw Error("A selected splat has an invalid center.");
    const skin = weights[offset] > 0 && options.getSkinMatrix ? checkedAffine(options.getSkinMatrix(index), `Skin matrix for splat ${index}`) : IDENTITY;
    const before = lookup(index) ?? IDENTITY;
    if (weights[offset] > 0) pivot.add(rest.applyMatrix4(before).applyMatrix4(skin).applyMatrix4(world).multiplyScalar(1 / positiveCount));
    const gaussian = weights[offset] > 0 ? options.getGaussian?.(index) : undefined;
    if (gaussian && (![...gaussian.scales.toArray(), ...gaussian.quaternion.toArray()].every(Number.isFinite) || Math.min(...gaussian.scales.toArray()) <= 0)) throw Error(`Splat ${index} has a degenerate Gaussian. Select valid splats; nothing changed.`);
    return { index, weight: weights[offset], rest: options.getRestCenter(index).clone(), gaussian, before, skin, inverseSkin: skin === IDENTITY ? IDENTITY : skin.clone().invert() };
  });
  // The displayed gizmo derives from Float32 evaluated positions. Capture that
  // exact pivot for pointer gestures so large world offsets cannot introduce a
  // spurious frame translation when blending rotation or nonuniform scale.
  if (options.weightFrame?.pivot) {
    if (!options.weightFrame.pivot.toArray().every(Number.isFinite)) throw Error("Weighted tool pivot must be finite.");
    pivot.copy(options.weightFrame.pivot);
  }
  return { pivot, indices, weights, changes(deltaWorld) {
    const delta = checkedAffine(deltaWorld);
    if (delta.equals(IDENTITY) || !positiveCount) return shape.componentTransforms;
    const localDelta = inverseWorld.clone().multiply(delta).multiply(world);
    const fractional = weights.some(weight => weight > 0 && weight < 1);
    let weightedDelta: ((weight: number) => Matrix4) | undefined;
    if (fractional) {
      const frame = options.weightFrame;
      if (!frame || !frame.basis.toArray().every(Number.isFinite) || Math.abs(frame.basis.lengthSq() - 1) > 1e-6) throw Error("Weighted transforms need the captured tool orientation and operation.");
      const basis = new Matrix4().compose(pivot, frame.basis, new Vector3(1, 1, 1)), inverseBasis = basis.clone().invert();
      const inFrame = checkedAffine(inverseBasis.clone().multiply(delta).multiply(basis));
      const translation = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
      inFrame.decompose(translation, rotation, scale);
      if (frame.mode === "scale") {
        const e = inFrame.elements;
        scale.set(e[0], e[5], e[10]); rotation.identity(); translation.set(0, 0, 0);
        if (Math.min(scale.x, scale.y, scale.z) <= 0) throw Error("A fractional soft-selection reflection crosses a singular scale. Use positive scale or turn Soft Selection off; nothing changed.");
      }
      const recomposed = new Matrix4().compose(translation, rotation, scale);
      if (recomposed.elements.some((value, i) => Math.abs(value - inFrame.elements[i]) > 1e-7 * Math.max(1, Math.abs(value)))) throw Error("Soft selection supports the captured Move/Rotate/Scale frame; a sheared delta cannot be blended safely.");
      weightedDelta = weight => {
        const weighted = new Matrix4().compose(translation.clone().multiplyScalar(weight), new Quaternion().slerp(rotation, weight), new Vector3(1, 1, 1).lerp(scale, weight));
        return inverseWorld.clone().multiply(basis).multiply(weighted).multiply(inverseBasis).multiply(world);
      };
    }
    const records = new Map(shape.componentTransforms?.records.map(record => [record.index, record]));
    for (const entry of captured) {
      if (entry.weight === 0) continue;
      const applied = entry.weight === 1 ? localDelta : weightedDelta!(entry.weight);
      const matrix = checkedAffine(entry.inverseSkin.clone().multiply(applied).multiply(entry.skin).multiply(entry.before));
      const center = entry.rest.clone().applyMatrix4(matrix);
      if (!center.toArray().every(value => Number.isFinite(value) && Math.abs(value) <= 1e12)) throw Error("Transformed splat centers must remain finite within +/-1 trillion; nothing changed.");
      if (entry.gaussian) {
        const factor = gaussianFactor(entry.rest, entry.gaussian.scales, entry.gaussian.quaternion, matrix);
        if (!factor.elements.every(value => Number.isFinite(value) && Math.abs(value) <= 1e12)) throw Error("Transformed Gaussian covariance exceeds the supported range; nothing changed.");
      }
      records.set(entry.index, { index: entry.index, matrix: matrix.toArray() });
    }
    const result: SplatComponentTransforms = { version: 1, sourceCount: identity.count, records: [...records.values()].sort((a, b) => a.index - b.index) };
    const total = Object.values(document.nodes).reduce((sum, node) => sum + (node.type === "splatShape" && node.id !== shape.id ? node.componentTransforms?.records.length ?? 0 : 0), result.records.length);
    if (total > SPLAT_TRANSFORM_SCENE_LIMIT) throw Error("This scene already has 250,000 transformed splats. Undo earlier edits or use a smaller region; nothing changed.");
    validateSplatComponentTransforms(result, identity.count);
    assertSplatTransformUndoFits(document, result);
    return result;
  } };
}

export function withSplatComponentTransforms(document: SceneDocument, identity: SplatSelectionIdentity, value: SplatComponentTransforms | undefined): SceneDocument {
  const shape = document.nodes[identity.shapeId];
  if (shape?.type !== "splatShape" || shape.assetId !== identity.assetId) throw Error("The selected splat source changed.");
  if (value === shape.componentTransforms) return document;
  if (value) validateSplatComponentTransforms(value, identity.count);
  assertSplatTransformUndoFits(document, value);
  const next = { ...shape };
  if (value) next.componentTransforms = value; else delete next.componentTransforms;
  return { ...document, nodes: { ...document.nodes, [shape.id]: next } };
}

type TransformRecord = SplatComponentTransforms["records"][number];
function addDocumentRows(document: SceneDocument, rows: Set<TransformRecord>): void {
  for (const node of Object.values(document.nodes)) if (node.type === "splatShape")
    for (const row of node.componentTransforms?.records ?? []) rows.add(row);
}

/** Count immutable shared rows once. Refuse before authoring if current + the
 * proposed change cannot retain its immediate undo within the declared budget. */
export function assertSplatTransformUndoFits(document: SceneDocument, next?: SplatComponentTransforms): void {
  const rows = new Set<TransformRecord>();
  addDocumentRows(document, rows);
  for (const row of next?.records ?? []) rows.add(row);
  if (rows.size * ROW_BYTES > SPLAT_TRANSFORM_HISTORY_BYTES)
    throw Error("This transform cannot retain its immediate undo within the 64 MiB component history budget. Select a smaller region or undo earlier component edits; nothing changed.");
}

/** Keep the most recent history prefix that fits with the current document.
 * Structural sharing makes adding 100k new rows to an existing 150k scene cost
 * 250k rows, not the sum of two full snapshots. The preflight above guarantees
 * that the immediate prior state fits before the document is published. */
export function trimSplatTransformHistory(store: import("./scene-store.ts").SceneStore): void {
  const temporal = store.temporal.getState();
  const rows = new Set<TransformRecord>();
  addDocumentRows(store.getState().document, rows);
  let first = temporal.pastStates.length;
  for (let i = temporal.pastStates.length - 1; i >= 0; i--) {
    const document = temporal.pastStates[i].document;
    if (document) addDocumentRows(document, rows);
    if (rows.size * ROW_BYTES > SPLAT_TRANSFORM_HISTORY_BYTES) break;
    first = i;
  }
  if (first) store.temporal.setState({ pastStates: temporal.pastStates.slice(first) });
}
