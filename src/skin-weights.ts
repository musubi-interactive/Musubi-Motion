import { Matrix4, Vector3 } from "three";
import type { SkinBinding, SkinInfluence, SkinWeights, Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
export type { SkinBinding, SkinInfluence, SkinWeights } from "./scene-document.ts";

export const MAX_WEIGHT_EDIT_COMPONENTS = 20_000;
export const MAX_WEIGHT_OVERRIDES = 200_000;
export type SkinWeightContext = { count: number; getWeights: (index: number) => SkinInfluence[] };
export type SkinWeightValue = { index: number; weight: number };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function validateRow(value: unknown, jointIds: ReadonlySet<string>): asserts value is SkinInfluence[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw Error("Skin weights require one through four active influences per component.");
  const seen = new Set<string>(); let total = 0;
  for (const influence of value) {
    if (!isRecord(influence) || typeof influence.jointId !== "string" || !jointIds.has(influence.jointId) || seen.has(influence.jointId)) throw Error("Skin influences must reference unique bound joint IDs.");
    if (typeof influence.weight !== "number" || !Number.isFinite(influence.weight) || influence.weight <= 0 || influence.weight > 1) throw Error("Skin weights must be finite, positive values at most one.");
    seen.add(influence.jointId); total += influence.weight;
  }
  if (Math.abs(total - 1) > 1e-8) throw Error("Skin weights must be normalized to a total of one.");
}

/** Validates archive data, including sparse canonical decimal component keys. */
export function validateSkinWeights(value: unknown): asserts value is SkinBinding {
  if (!isRecord(value) || !Array.isArray(value.jointIds) || !value.jointIds.length || value.jointIds.length > 256
    || new Set(value.jointIds).size !== value.jointIds.length || value.jointIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id))
    || !Array.isArray(value.restMatrices) || value.restMatrices.length !== value.jointIds.length
    || value.restMatrices.some(matrix => !Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(n => typeof n === "number" && Number.isFinite(n)))) throw Error("Invalid skin binding joints or rest matrices.");
  if (value.meshSpace !== undefined && typeof value.meshSpace !== "boolean") throw Error("Invalid skin binding coordinate space.");
  if (value.lockedJointIds !== undefined && (!Array.isArray(value.lockedJointIds)
    || new Set(value.lockedJointIds).size !== value.lockedJointIds.length
    || value.lockedJointIds.some(id => !(value.jointIds as unknown[]).includes(id)))) throw Error("Skin locks must reference unique bound joints.");
  if (value.weights === undefined) return;
  const weights = value.weights;
  if (!isRecord(weights) || !validCount(weights.count) || !isRecord(weights.overrides)) throw Error("Invalid skin weight component count or overrides.");
  const entries = Object.entries(weights.overrides);
  if (entries.length > MAX_WEIGHT_OVERRIDES) throw Error("Skin weights support at most 200,000 stored component overrides per shape.");
  const jointIds = new Set(value.jointIds as string[]);
  for (const [key, row] of entries) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= weights.count) throw Error("Skin weight indices must be canonical integers within the component count.");
    validateRow(row, jointIds);
  }
}

export function validateSkinWeightCount(binding: SkinBinding, actualCount: number): void {
  if (!validCount(actualCount)) throw Error("Invalid loaded component count.");
  if (binding.weights && binding.weights.count !== actualCount) throw Error("Saved skin weight component count does not match the loaded splat asset. Reset its weights or load the matching asset.");
}

/** Rest centers are computed once; default weighting exactly matches the legacy binder. */
export function createSkinWeightLookup(binding: SkinBinding): (index: number, position: Vec3) => SkinInfluence[] {
  validateSkinWeights(binding);
  const centers = binding.restMatrices.map(matrix => new Vector3().setFromMatrixPosition(new Matrix4().fromArray(matrix)));
  const position = new Vector3();
  return (index, point) => {
    if (!Number.isSafeInteger(index) || index < 0 || (binding.weights && index >= binding.weights.count)) throw Error("Skin component index is out of range.");
    const authored = binding.weights && Object.hasOwn(binding.weights.overrides, String(index)) ? binding.weights.overrides[String(index)] : undefined;
    if (authored) return authored.map(influence => ({ ...influence }));
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) throw Error("Skin component positions must be finite XYZ values.");
    position.set(...point);
    const nearest = centers.map((center, index) => ({ jointId: binding.jointIds[index], weight: 1 / Math.max(1e-8, center.distanceToSquared(position)) })).sort((a, b) => b.weight - a.weight).slice(0, 4);
    const total = nearest.reduce((sum, influence) => sum + influence.weight, 0);
    if (!Number.isFinite(total) || total <= 0) throw Error("Component and joint positions are too far apart to compute finite skin weights.");
    return nearest.filter(influence => influence.weight > 0).map(influence => ({ jointId: influence.jointId, weight: influence.weight / total }));
  };
}

function shapeBinding(store: SceneStore, shapeId: string) {
  const doc = store.getState().document, shape = doc.nodes[shapeId];
  if (shape?.type !== "splatShape" || !shape.binding) throw Error("Select a bound splat shape to edit skin weights.");
  validateSkinWeights(shape.binding);
  return { doc, shape, binding: shape.binding };
}
function componentIndices(components: number[], count?: number): number[] {
  if (!Array.isArray(components) || components.length > MAX_WEIGHT_EDIT_COMPONENTS) throw Error("Edit or reset at most 20,000 components per operation.");
  if (components.some(index => !Number.isSafeInteger(index) || index < 0 || (count !== undefined && index >= count))) throw Error("Skin component index is out of range.");
  return [...new Set(components)];
}

export function editSkinWeight(store: SceneStore, shapeId: string, components: number[], jointId: string, value: number, context: SkinWeightContext): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw Error("Skin weight must be between zero and one.");
  const changes = componentIndices(components, context.count).map(index => ({ index, weight: value }));
  applySkinWeightValues(store, shapeId, changes, jointId, context, "Edit skin weights");
}

/** Commits a completed paint stroke atomically; preview samples never modify the document. */
export function editSkinWeightValues(store: SceneStore, shapeId: string, changes: readonly SkinWeightValue[], jointId: string, context: SkinWeightContext): void {
  applySkinWeightValues(store, shapeId, changes, jointId, context, "Paint skin weights");
}

function applySkinWeightValues(store: SceneStore, shapeId: string, values: readonly SkinWeightValue[], jointId: string, context: SkinWeightContext, editLabel: string): void {
  const { binding } = shapeBinding(store, shapeId);
  validateSkinWeightCount(binding, context.count);
  if (binding.lockedJointIds?.includes(jointId)) throw Error("Unlock this influence before editing it.");
  if (!binding.jointIds.includes(jointId)) throw Error("The selected influence is not a bound joint.");
  if (!Array.isArray(values) || values.length > MAX_WEIGHT_EDIT_COMPONENTS) throw Error("Edit or paint at most 20,000 components per operation.");
  const indices = new Set<number>(), jointIds = new Set(binding.jointIds);
  for (const entry of values) {
    if (!isRecord(entry) || typeof entry.index !== "number" || !Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= context.count) throw Error("Skin component index is out of range.");
    if (typeof entry.weight !== "number" || !Number.isFinite(entry.weight) || entry.weight < 0 || entry.weight > 1) throw Error("Skin weight must be between zero and one.");
    if (indices.has(entry.index)) throw Error("A paint stroke must contain each component index only once.");
    indices.add(entry.index);
  }
  const changes = new Map<string, SkinInfluence[]>();
  for (const { index, weight: value } of values) {
    const key = String(index), current = binding.weights && Object.hasOwn(binding.weights.overrides, key) ? binding.weights.overrides[key] : context.getWeights(index);
    validateRow(current, jointIds);
    if ((current.find(influence => influence.jointId === jointId)?.weight ?? 0) === value) continue;
    const locked = current.filter(influence => binding.lockedJointIds?.includes(influence.jointId));
    const free = 1 - locked.reduce((sum, influence) => sum + influence.weight, 0);
    if (value > free) throw Error("This weight exceeds the portion available after locked influences.");
    const others = current.filter(influence => influence.jointId !== jointId && !binding.lockedJointIds?.includes(influence.jointId)), total = others.reduce((sum, influence) => sum + influence.weight, 0);
    if (value < free && total === 0) throw Error("Cannot reduce the sole influence: first add another bound joint with a positive weight.");
    const next = [...locked,
      ...others.map(influence => ({ jointId: influence.jointId, weight: (influence.weight / total) * (free - value) })).filter(influence => influence.weight > 0),
      ...(value > 0 ? [{ jointId, weight: value }] : []),
    ];
    if (next.length > 4) throw Error("A component supports at most four active influences. Set an existing influence to zero before adding another.");
    validateRow(next, jointIds); changes.set(key, next);
  }
  commitWeightRows(store, shapeId, context, changes, editLabel);
}

export function setInfluenceLock(store: SceneStore, shapeId: string, jointId: string, lock: boolean) {
  const {doc, shape, binding} = shapeBinding(store, shapeId);
  if (!binding.jointIds.includes(jointId)) throw Error("Select a bound influence.");
  const locked = new Set(binding.lockedJointIds);
  if (locked.has(jointId) === lock) return;
  if (lock) locked.add(jointId); else locked.delete(jointId);
  const next = { ...binding, lockedJointIds: [...locked] };
  store.setState({document: {...doc, nodes: {...doc.nodes, [shapeId]: {...shape, binding: next}}}, editLabel: lock ? "Lock skin influence" : "Unlock skin influence"});
}

export function commitWeightRows(store: SceneStore, shapeId: string, context: SkinWeightContext, changes: ReadonlyMap<string,SkinInfluence[]>, editLabel: string) {
  if (!changes.size) return;
  const {doc, shape, binding} = shapeBinding(store, shapeId);
  validateSkinWeightCount(binding, context.count);
  if (changes.size > MAX_WEIGHT_EDIT_COMPONENTS) throw Error("Edit at most 20,000 components per operation.");
  const joints = new Set(binding.jointIds);
  for (const [key, row] of changes) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(+key) || +key >= context.count) throw Error("Skin component index is out of range.");
    validateRow(row, joints);
    if (binding.lockedJointIds?.length) {
      const before = context.getWeights(+key);
      for (const id of binding.lockedJointIds) if ((before.find(v => v.jointId === id)?.weight ?? 0) !== (row.find(v => v.jointId === id)?.weight ?? 0)) throw Error("Locked skin weights must remain fixed.");
    }
  }
  const overrides = { ...binding.weights?.overrides };
  for (const [key, row] of changes) overrides[key] = row;
  if (Object.keys(overrides).length > MAX_WEIGHT_OVERRIDES) throw Error("Skin weights support at most 200,000 stored component overrides per shape.");
  const weights: SkinWeights = { count: context.count, overrides };
  store.setState({ document: { ...doc, nodes: { ...doc.nodes, [shapeId]: { ...shape, binding: { ...binding, weights } } } }, editLabel });
}

export function resetSkinWeights(store: SceneStore, shapeId: string, components: number[] | null): void {
  const { doc, shape, binding } = shapeBinding(store, shapeId);
  const indices = components === null ? null : componentIndices(components, binding.weights?.count);
  if (!binding.weights) return;
  if (binding.lockedJointIds?.length) throw Error("Unlock held influences before resetting to automatic weights.");
  const overrides = { ...binding.weights.overrides };
  if (indices) for (const index of indices) delete overrides[String(index)];
  if (indices && Object.keys(overrides).length === Object.keys(binding.weights.overrides).length) return;
  const { weights: _weights, ...base } = binding;
  const next = indices && Object.keys(overrides).length ? { ...base, weights: { count: binding.weights.count, overrides } } : base;
  store.setState({ document: { ...doc, nodes: { ...doc.nodes, [shapeId]: { ...shape, binding: next } } }, editLabel: "Reset skin weights" });
}
