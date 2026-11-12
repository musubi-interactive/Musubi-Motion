import type { SceneDocument, SplatShapeNode } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import { combineSplatSelection, SPLAT_SELECTION_LIMIT, type SplatSelectionIdentity, type SplatSelectionIndices, type SplatSelectionOperation } from "./splat-component-selection.ts";
import { isSplatComponentActive, SPLAT_EDIT_SOURCE_LIMIT } from "./splat-component-edits.ts";

export const SPLAT_MASK_LIMITS = { setsPerShape: 32, masksPerShape: 16, collections: 256, values: 1_000_000, numbers: 4_000_000, stroke: 100_000, projected: 1_000_000, historyBytes: 128 * 1024 * 1024 } as const;
type Identity = { version: 1; id: string; name: string; assetId: string; sourceCount: number; locked: boolean };
export type SplatSelectionSet = Identity & { members: number[] };
export type SplatMaskData = { kind: "sparse"; defaultValue: number; indices: number[]; values: number[] } | { kind: "dense"; values: number[] };
export type SplatScalarMask = Identity & { data: SplatMaskData; componentLocks: number[] };
export type SplatMaskValues = { indices: Uint32Array; values: Float32Array };
export type SplatMaskCombine = "add" | "subtract" | "multiply" | "min" | "max";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v) && !["__proto__", "constructor", "prototype"].includes(v);
const scalar = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const clamp = (v: number) => Math.fround(Math.max(0, Math.min(1, v)));
const keys = (value: object, expected: string[]) => Object.keys(value).sort().join() === expected.sort().join();
const identityKeys = ["version", "id", "name", "assetId", "sourceCount", "locked"];
export function rangeContains(ranges: readonly number[], index: number): boolean {
  let lo = 0, hi = ranges.length / 2;
  while (lo < hi) { const mid = (lo + hi) >>> 1, start = ranges[mid * 2]; if (index < start) hi = mid; else if (index >= ranges[mid * 2 + 1]) lo = mid + 1; else return true; }
  return false;
}
export function rangesCount(ranges: readonly number[]) { let count = 0; for (let i = 0; i < ranges.length; i += 2) count += ranges[i + 1] - ranges[i]; return count; }
function validateRanges(value: unknown, count: number): asserts value is number[] {
  if (!Array.isArray(value) || value.length % 2 || value.length > SPLAT_SELECTION_LIMIT * 2) throw Error("Invalid splat set/component lock ranges.");
  let previous = -1, total = 0;
  for (let i = 0; i < value.length; i += 2) { const a = value[i], b = value[i + 1]; if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || a <= previous || b <= a || b > count) throw Error("Splat ranges must be ordered, separate and within the original source."); previous = b; total += b - a; }
  if (total > SPLAT_SELECTION_LIMIT) throw Error("Sets and component locks support at most 1,000,000 original IDs.");
}
export function splatRanges(indices: SplatSelectionIndices, count: number): number[] {
  const sorted = combineSplatSelection([], indices, "replace", count), ranges: number[] = [];
  for (const index of sorted) { if (ranges[ranges.length - 1] === index) ranges[ranges.length - 1]++; else ranges.push(index, index + 1); }
  return ranges;
}
export function rangeIndices(ranges: readonly number[]): Uint32Array {
  const values = new Uint32Array(rangesCount(ranges)); let offset = 0;
  for (let i = 0; i < ranges.length; i += 2) for (let index = ranges[i]; index < ranges[i + 1]; index++) values[offset++] = index;
  return values;
}
function checkIdentity(item: unknown, shape: SplatShapeNode, decodedCount?: number): asserts item is Identity {
  if (!object(item) || item.version !== 1 || !validId(item.id) || typeof item.name !== "string" || item.name.trim() !== item.name || !item.name || item.name.length > 80 || typeof item.locked !== "boolean"
    || item.assetId !== shape.assetId || !Number.isSafeInteger(item.sourceCount) || (item.sourceCount as number) < 1 || (item.sourceCount as number) > SPLAT_EDIT_SOURCE_LIMIT) throw Error("Invalid saved splat set/mask identity, name or version (supported version 1).");
  if (decodedCount !== undefined && item.sourceCount !== decodedCount) throw Error("Saved splat sets/masks do not match the original asset's decoded splat count.");
}
export function validateSplatMaskCollections(shape: SplatShapeNode, decodedCount?: number): number {
  const sets = shape.selectionSets ?? [], masks = shape.scalarMasks ?? [];
  if (!Array.isArray(sets) || !Array.isArray(masks) || sets.length > SPLAT_MASK_LIMITS.setsPerShape || masks.length > SPLAT_MASK_LIMITS.masksPerShape) throw Error("A splat object supports at most 32 selection sets and 16 scalar masks.");
  const ids = new Set<string>(), setNames = new Set<string>(), maskNames = new Set<string>(); let numbers = 0;
  const expectedCount = decodedCount ?? shape.componentEdits?.sourceCount ?? shape.componentTransforms?.sourceCount ?? sets[0]?.sourceCount ?? masks[0]?.sourceCount;
  for (const set of sets) {
    checkIdentity(set, shape, expectedCount);
    if (!keys(set, [...identityKeys, "members"]) || ids.has(set.id) || setNames.has(set.name.toLowerCase())) throw Error("Duplicate or malformed splat selection set.");
    validateRanges(set.members, set.sourceCount); numbers += set.members.length; ids.add(set.id); setNames.add(set.name.toLowerCase());
  }
  for (const mask of masks) {
    checkIdentity(mask, shape, expectedCount);
    if (!keys(mask, [...identityKeys, "data", "componentLocks"]) || ids.has(mask.id) || maskNames.has(mask.name.toLowerCase()) || !object(mask.data)) throw Error("Duplicate or malformed splat scalar mask.");
    const data = mask.data;
    if (!Array.isArray(data.values) || data.values.length > SPLAT_MASK_LIMITS.values || !data.values.every(scalar)) throw Error("Mask values must be finite 0–1 numbers with at most 1,000,000 stored values.");
    if (data.kind === "dense") { if (!keys(data, ["kind", "values"]) || data.values.length !== mask.sourceCount) throw Error("Dense mask length does not match its original source."); }
    else if (data.kind === "sparse") {
      if (!keys(data, ["kind", "defaultValue", "indices", "values"]) || !scalar(data.defaultValue) || !Array.isArray(data.indices) || data.indices.length !== data.values.length) throw Error("Invalid sparse splat mask.");
      let previous = -1;
      data.indices.forEach((id, i) => { if (!Number.isSafeInteger(id) || id <= previous || id >= mask.sourceCount || data.values[i] === data.defaultValue) throw Error("Sparse mask IDs must be unique, ordered original indices with non-default values."); previous = id; });
      numbers += data.indices.length;
    } else throw Error("Unsupported splat mask storage. Use sparse or dense mask version 1.");
    validateRanges(mask.componentLocks, mask.sourceCount); numbers += data.values.length + mask.componentLocks.length; ids.add(mask.id); maskNames.add(mask.name.toLowerCase());
  }
  return numbers;
}
export function validateSceneSplatMasks(doc: SceneDocument): void {
  let numbers = 0, collections = 0;
  for (const shape of Object.values(doc.nodes)) if (shape.type === "splatShape") { numbers += validateSplatMaskCollections(shape); collections += (shape.selectionSets?.length ?? 0) + (shape.scalarMasks?.length ?? 0); }
  if (numbers > SPLAT_MASK_LIMITS.numbers || collections > SPLAT_MASK_LIMITS.collections) throw Error("Scene splat sets/masks exceed 4,000,000 stored numbers (32 MiB numeric payload) or 256 collections. Nothing changed.");
}
export function maskValue(mask: SplatScalarMask, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= mask.sourceCount) throw Error("Invalid original index for scalar mask.");
  const data = mask.data; if (data.kind === "dense") return data.values[index];
  let lo = 0, hi = data.indices.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (data.indices[mid] < index) lo = mid + 1; else hi = mid; }
  return data.indices[lo] === index ? data.values[lo] : data.defaultValue;
}
export function maskLocked(mask: SplatScalarMask, index: number) { return mask.locked || rangeContains(mask.componentLocks, index); }
function maskMap(data: SplatMaskData): { fallback: number; values: Map<number, number> } {
  return data.kind === "sparse" ? { fallback: data.defaultValue, values: new Map(data.indices.map((id, i) => [id, data.values[i]])) } : { fallback: 0, values: new Map(data.values.flatMap((value, i) => value === 0 ? [] : [[i, value] as [number, number]])) };
}
export function encodeMaskData(count: number, fallback: number, values: ReadonlyMap<number, number>): SplatMaskData {
  const entries = [...values].filter(([, value]) => value !== fallback).sort(([a], [b]) => a - b);
  if (entries.length > SPLAT_MASK_LIMITS.values) throw Error("Mask would exceed 1,000,000 stored values. Nothing changed.");
  if (count <= SPLAT_MASK_LIMITS.values && entries.length * 2 >= count) {
    const dense = new Array<number>(count).fill(fallback); for (const [index, value] of entries) dense[index] = value; return { kind: "dense", values: dense };
  }
  return { kind: "sparse", defaultValue: fallback, indices: entries.map(([id]) => id), values: entries.map(([, value]) => value) };
}
function currentShape(doc: SceneDocument, identity: SplatSelectionIdentity): SplatShapeNode {
  const shape = doc.nodes[identity.shapeId];
  if (shape?.type !== "splatShape" || shape.assetId !== identity.assetId || !doc.assets[identity.assetId] || !Number.isSafeInteger(identity.count) || identity.count < 1 || identity.count > SPLAT_EDIT_SOURCE_LIMIT) throw Error("Load the original splat source before editing saved sets/masks.");
  validateSplatMaskCollections(shape, identity.count); return shape;
}
function commit(store: SceneStore, identity: SplatSelectionIdentity, editLabel: string, edit: (shape: SplatShapeNode) => SplatShapeNode) {
  const before = store.getState().document, shape = currentShape(before, identity), next = edit(shape);
  if (next === shape) return false;
  const document = { ...before, nodes: { ...before.nodes, [shape.id]: next } }; validateSceneSplatMasks(document);
  assertSplatMaskUndoFits(before, document);
  store.setState({ document, editLabel }); trimSplatMaskHistory(store); return true;
}
function descriptor(identity: SplatSelectionIdentity, name: string): Identity { return { version: 1, id: crypto.randomUUID(), name: name.trim(), assetId: identity.assetId, sourceCount: identity.count, locked: false }; }
export function createSplatSet(store: SceneStore, identity: SplatSelectionIdentity, name: string, indices: SplatSelectionIndices): string {
  const item: SplatSelectionSet = { ...descriptor(identity, name), members: splatRanges(indices, identity.count) };
  commit(store, identity, "Create splat selection set", shape => ({ ...shape, selectionSets: [...shape.selectionSets ?? [], item] })); return item.id;
}
export function editSplatSet(store: SceneStore, identity: SplatSelectionIdentity, id: string, operation: SplatSelectionOperation, selected: SplatSelectionIndices) {
  return commit(store, identity, "Edit splat selection set", shape => {
    const set = shape.selectionSets?.find(set => set.id === id); if (!set) throw Error("Choose an existing selection set."); if (set.locked) throw Error("Unlock this selection set first.");
    const members = splatRanges(combineSplatSelection(rangeIndices(set.members), selected, operation, identity.count), identity.count);
    if (members.length === set.members.length && members.every((value, i) => value === set.members[i])) return shape;
    return { ...shape, selectionSets: shape.selectionSets!.map(item => item.id === id ? { ...item, members } : item) };
  });
}
export function createSplatMask(store: SceneStore, identity: SplatSelectionIdentity, name: string, selected: SplatSelectionIndices): string {
  const sorted = combineSplatSelection([], selected, "replace", identity.count), item: SplatScalarMask = { ...descriptor(identity, name), componentLocks: [], data: encodeMaskData(identity.count, 0, new Map(Array.from(sorted, index => [index, 1]))) };
  commit(store, identity, "Create splat scalar mask", shape => ({ ...shape, scalarMasks: [...shape.scalarMasks ?? [], item] })); return item.id;
}
export function editSplatCollection(store: SceneStore, identity: SplatSelectionIdentity, kind: "set" | "mask", id: string, action: "rename" | "delete" | "lock", value?: string | boolean) {
  return commit(store, identity, `${action === "rename" ? "Rename" : action === "delete" ? "Delete" : "Lock/Unlock"} splat ${kind}`, shape => {
    const field = kind === "set" ? "selectionSets" : "scalarMasks", entries = shape[field] ?? [], item = entries.find(item => item.id === id);
    if (!item) throw Error("Choose an existing set or mask."); if (item.locked && action !== "lock") throw Error("Unlock the collection first.");
    if (kind === "mask" && action === "delete" && shape.appearance?.layers.some(layer => layer.maskId === id))
      throw Error("The scalar mask is assigned to a splat appearance layer. Change the layer's mask before deleting it.");
    return { ...shape, [field]: action === "delete" ? entries.filter(item => item.id !== id) : entries.map(item => item.id !== id ? item : action === "lock" ? { ...item, locked: !!value } : { ...item, name: String(value).trim() }) };
  });
}
export function updateSplatMask(store: SceneStore, identity: SplatSelectionIdentity, id: string, label: string, edit: (mask: SplatScalarMask) => SplatScalarMask) {
  return commit(store, identity, label, shape => {
    const old = shape.scalarMasks?.find(mask => mask.id === id); if (!old) throw Error("Choose a scalar mask first."); if (old.locked) throw Error("Unlock this scalar mask first.");
    const next = edit(old); if (next === old) return shape;
    return { ...shape, scalarMasks: shape.scalarMasks!.map(mask => mask.id === id ? next : mask) };
  });
}
export function withMaskStroke(mask: SplatScalarMask, changes: SplatMaskValues, active: (id: number) => boolean): SplatScalarMask {
  if (changes.indices.length !== changes.values.length || changes.indices.length > SPLAT_MASK_LIMITS.stroke) throw Error("One paint stroke supports at most 100,000 edited original IDs. Nothing changed.");
  if (mask.locked) throw Error("Unlock this scalar mask first.");
  const { fallback, values } = maskMap(mask.data); let changed = false, previous = -1;
  changes.indices.forEach((id, i) => {
    const value = changes.values[i]; if (!Number.isSafeInteger(id) || id <= previous || id >= mask.sourceCount || !scalar(value)) throw Error("Invalid scalar mask stroke IDs/values."); previous = id;
    if (!active(id) || maskLocked(mask, id)) return; const before = values.get(id) ?? fallback;
    if (before !== value) { changed = true; if (value === fallback) values.delete(id); else values.set(id, value); }
  });
  return changed ? { ...mask, data: encodeMaskData(mask.sourceCount, fallback, values) } : mask;
}
export function applySplatMaskStroke(store: SceneStore, identity: SplatSelectionIdentity, id: string, changes: SplatMaskValues) {
  const shape = currentShape(store.getState().document, identity);
  return updateSplatMask(store, identity, id, "Paint splat scalar mask", mask => withMaskStroke(mask, changes, index => isSplatComponentActive(shape.componentEdits, index)));
}
export function setSplatMaskComponentLocks(store: SceneStore, identity: SplatSelectionIdentity, id: string, selected: SplatSelectionIndices, lock: boolean) {
  return updateSplatMask(store, identity, id, lock ? "Lock mask components" : "Unlock mask components", mask => ({ ...mask,
    componentLocks: splatRanges(combineSplatSelection(rangeIndices(mask.componentLocks), selected, lock ? "add" : "subtract", identity.count), identity.count) }));
}
export function transformMask(mask: SplatScalarMask, operation: "invert" | "flood" | SplatMaskCombine, value = 1, other?: SplatScalarMask): SplatScalarMask {
  if (mask.locked) throw Error("Unlock this scalar mask first.");
  if (!["invert", "flood", "add", "subtract", "multiply", "min", "max"].includes(operation)) throw Error("Choose a valid mask operation.");
  if (!scalar(value)) throw Error("Mask flood value must be finite and within 0–1.");
  if (other && (other.sourceCount !== mask.sourceCount || other.assetId !== mask.assetId)) throw Error("Combine masks on the same original source.");
  const a = maskMap(mask.data), b = other ? maskMap(other.data) : undefined;
  const apply = (left: number, right: number) => operation === "invert" ? 1 - left : operation === "flood" ? value : operation === "add" ? left + right : operation === "subtract" ? left - right : operation === "multiply" ? left * right : operation === "min" ? Math.min(left, right) : Math.max(left, right);
  if (operation !== "invert" && operation !== "flood" && !b) throw Error("Choose another scalar mask to combine.");
  const fallback = clamp(apply(a.fallback, b?.fallback ?? 0)), candidates = new Set([...a.values.keys(), ...b?.values.keys() ?? [], ...rangeIndices(mask.componentLocks)]), values = new Map<number, number>();
  for (const id of candidates) { const before = a.values.get(id) ?? a.fallback, next = maskLocked(mask, id) ? before : clamp(apply(before, b?.values.get(id) ?? b?.fallback ?? 0)); if (next !== fallback) values.set(id, next); }
  return { ...mask, data: encodeMaskData(mask.sourceCount, fallback, values) };
}
export function maskSelection(mask: SplatScalarMask, threshold: number): Uint32Array {
  if (!scalar(threshold)) throw Error("Mask selection threshold must be within 0–1.");
  const data = mask.data;
  const background = data.kind === "sparse" && data.defaultValue >= threshold;
  const count = data.kind === "dense" ? data.values.filter(v => v >= threshold).length : (background ? mask.sourceCount - data.indices.length : 0) + data.values.filter(v => v >= threshold).length;
  if (count > SPLAT_SELECTION_LIMIT) throw Error("Mask threshold selects more than 1,000,000 original IDs. Increase the threshold; selection unchanged.");
  const result = new Uint32Array(count); let offset = 0;
  if (data.kind === "sparse" && !background) data.indices.forEach((id, i) => { if (data.values[i] >= threshold) result[offset++] = id; });
  else for (let id = 0; id < mask.sourceCount; id++) if (maskValue(mask, id) >= threshold) result[offset++] = id;
  return result;
}
function payload(doc: SceneDocument, seen: Set<object>): number {
  let bytes = 0;
  const array = (value: readonly number[]) => { if (!seen.has(value)) { seen.add(value); bytes += value.length * 8; } };
  for (const shape of Object.values(doc.nodes)) if (shape.type === "splatShape") { for (const set of shape.selectionSets ?? []) array(set.members); for (const mask of shape.scalarMasks ?? []) { array(mask.data.values); if (mask.data.kind === "sparse") array(mask.data.indices); array(mask.componentLocks); } }
  return bytes;
}
export function splatMaskHistoryBytes(documents: readonly SceneDocument[]): number {
  const seen = new Set<object>(); return documents.reduce((sum, doc) => sum + payload(doc, seen), 0);
}
/** Preflight precedes publication. With the32MiB scene limit a valid current+
 * next pair fits within128MiB, independently of older history being trimmed. */
export function assertSplatMaskUndoFits(before: SceneDocument, next: SceneDocument): void {
  if (splatMaskHistoryBytes([before, next]) > SPLAT_MASK_LIMITS.historyBytes) throw Error("This mask edit cannot retain its immediate undo within 128 MiB. Use a smaller mask edit; nothing changed.");
}
export function trimSplatMaskHistory(store: SceneStore) {
  const history = store.temporal.getState(), seen = new Set<object>(); let bytes = payload(store.getState().document, seen), first = history.pastStates.length;
  for (let i = history.pastStates.length - 1; i >= 0; i--) { const doc = history.pastStates[i].document; if (doc) bytes += payload(doc, seen); if (bytes > SPLAT_MASK_LIMITS.historyBytes) break; first = i; }
  if (first) store.temporal.setState({ pastStates: history.pastStates.slice(first) });
}
