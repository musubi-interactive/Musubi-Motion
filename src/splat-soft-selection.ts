import { Matrix4, Vector3 } from "three";
import { scanProjectedComponents, type ComponentProjectionOptions } from "./component-picking.ts";
import { SPLAT_SELECTION_LIMIT, type SplatSelectionDepth, type SplatSelectionOperation } from "./splat-component-selection.ts";

export type WeightedSplatSelection = { indices: Uint32Array; weights: Float32Array };
export type SplatSoftSettings = { enabled: boolean; curve: "linear" | "smooth" | "sharp"; core: number; worldRadius: number; screenRadius: number; center: [number, number, number] };
export const defaultSplatSoftSettings = (): SplatSoftSettings => ({ enabled: false, curve: "smooth", core: 0, worldRadius: 1, screenRadius: 100, center: [0, 0, 0] });
export function validateSplatSoftSettings(value: SplatSoftSettings): void {
  if (!value || typeof value.enabled !== "boolean" || !["linear", "smooth", "sharp"].includes(value.curve)
    || !Number.isFinite(value.core) || value.core < 0 || value.core > .95
    || !Number.isFinite(value.worldRadius) || value.worldRadius < .000001 || value.worldRadius > 1e6
    || !Number.isFinite(value.screenRadius) || value.screenRadius < 1 || value.screenRadius > 16384
    || !Array.isArray(value.center) || value.center.length !== 3 || !value.center.every(v => Number.isFinite(v) && Math.abs(v) <= 1e6))
    throw Error("Use a sphere radius 0.000001–1,000,000 world units, radial radius 1–16,384 px, finite center within +/-1,000,000 and core 0–0.95.");
}
export function splatFalloff(distance: number, radius: number, settings: Pick<SplatSoftSettings, "enabled" | "curve" | "core">): number {
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(radius) || radius <= 0) throw Error("Selection distance and radius must be finite and nonnegative.");
  if (distance > radius) return 0;
  if (!settings.enabled) return 1;
  const t = Math.max(0, Math.min(1, (distance / radius - settings.core) / (1 - settings.core)));
  const weight = settings.curve === "linear" ? 1 - t : settings.curve === "sharp" ? (1 - t) ** 2 : 1 - t * t * (3 - 2 * t);
  return Math.max(0, Math.min(1, weight));
}
export function validateWeightedSplatSelection(value: WeightedSplatSelection, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > 134217728) throw Error("Invalid original source count for weighted selection.");
  if (!(value.indices instanceof Uint32Array) || !(value.weights instanceof Float32Array) || value.indices.length !== value.weights.length || value.indices.length > SPLAT_SELECTION_LIMIT) throw Error("Invalid or excessive weighted splat selection.");
  let previous = -1;
  for (let i = 0; i < value.indices.length; i++) {
    const index = value.indices[i], weight = value.weights[i];
    if (index <= previous || index >= count || !Number.isFinite(weight) || weight <= 0 || weight > 1) throw Error("Soft selection needs ordered original IDs and weights above zero through one.");
    previous = index;
  }
}
export function hardSplatSelection(indices: Uint32Array): WeightedSplatSelection { return { indices, weights: new Float32Array(indices.length).fill(1) }; }
export function splatSelectionWeight(selection: WeightedSplatSelection, index: number): number {
  let low = 0, high = selection.indices.length;
  while (low < high) { const mid = (low + high) >>> 1; if (selection.indices[mid] < index) low = mid + 1; else high = mid; }
  return selection.indices[low] === index ? selection.weights[low] : 0;
}
/** Weighted union=max, subtraction=max(0,a-b), toggle membership. Hard inputs
 * reduce exactly to existing add/subtract/toggle selection behavior. */
export function combineWeightedSplatSelection(current: WeightedSplatSelection, incoming: WeightedSplatSelection, operation: SplatSelectionOperation, count: number): WeightedSplatSelection {
  validateWeightedSplatSelection(current, count); validateWeightedSplatSelection(incoming, count);
  if (operation === "replace") return { indices: incoming.indices.slice(), weights: incoming.weights.slice() };
  const size = Math.min(SPLAT_SELECTION_LIMIT + 1, current.indices.length + incoming.indices.length);
  const indices = new Uint32Array(size), weights = new Float32Array(size);
  let a = 0, b = 0, length = 0;
  const append = (index: number, weight: number) => {
    if (weight <= 0) return;
    if (length >= SPLAT_SELECTION_LIMIT) throw Error("Selection exceeds 1,000,000 original IDs. Previous weights and selection are unchanged.");
    indices[length] = index; weights[length++] = weight;
  };
  while (a < current.indices.length || b < incoming.indices.length) {
    const left = current.indices[a] ?? Infinity, right = incoming.indices[b] ?? Infinity;
    if (left < right) { append(left, current.weights[a++]); }
    else if (right < left) { if (operation !== "subtract") append(right, incoming.weights[b]); b++; }
    else {
      append(left, operation === "add" ? Math.max(current.weights[a], incoming.weights[b]) : operation === "subtract" ? Math.max(0, current.weights[a] - incoming.weights[b]) : 0); a++; b++;
    }
  }
  return { indices: indices.slice(0, length), weights: weights.slice(0, length) };
}

type ReadOptions = Pick<ComponentProjectionOptions, "componentCount" | "readPositions" | "matrixWorld" | "cancelled" | "yieldTask">;
function resultFromRows(rows: [number, number][]): WeightedSplatSelection {
  rows.sort((a, b) => a[0] - b[0]);
  return { indices: Uint32Array.from(rows, row => row[0]), weights: Float32Array.from(rows, row => row[1]) };
}
export async function selectSplatSphere(options: ReadOptions, settings: SplatSoftSettings): Promise<WeightedSplatSelection> {
  validateSplatSoftSettings(settings);
  const rows: [number, number][] = [], center = new Vector3(...settings.center), point = new Vector3();
  const matrix = options.matrixWorld.clone();
  if (!matrix.elements.every(Number.isFinite) || !Number.isSafeInteger(options.componentCount) || options.componentCount < 0) throw Error("Sphere selection requires finite world coordinates and a valid original count.");
  const check = () => { if (options.cancelled?.()) throw new DOMException("Sphere selection cancelled; previous selection unchanged.", "AbortError"); };
  for (let start = 0; start < options.componentCount; start += 4096) {
    check(); const count = Math.min(4096, options.componentCount - start), positions = options.readPositions(start, count);
    if (!(positions instanceof Float32Array) || positions.length !== count * 3) throw Error("Sphere position reader must return exactly the requested original centers.");
    for (let offset = 0; offset < count; offset++) {
      point.fromArray(positions, offset * 3);
      if (!point.toArray().every(Number.isFinite)) continue;
      const weight = splatFalloff(point.applyMatrix4(matrix).distanceTo(center), settings.worldRadius, settings);
      if (weight > 0) {
        if (rows.length >= SPLAT_SELECTION_LIMIT) throw Error("Sphere selection exceeds 1,000,000 original IDs. Previous selection unchanged.");
        rows.push([start + offset, weight]);
      }
    }
    if (start + count < options.componentCount) await (options.yieldTask?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
  }
  check(); return resultFromRows(rows);
}
export async function selectSplatRadial(options: ComponentProjectionOptions & { depth: SplatSelectionDepth }, center: { x: number; y: number }, settings: SplatSoftSettings): Promise<WeightedSplatSelection> {
  validateSplatSoftSettings(settings);
  if (![center.x, center.y].every(Number.isFinite)) throw Error("Radial center must be finite CSS pixels.");
  const rows: [number, number][] = [], cells = new Map<number, { index: number; depth: number; weight: number }>();
  const columns = Math.ceil(options.width / 4) + 1, cellsCount = columns * (Math.ceil(options.height / 4) + 1);
  if (options.depth === "front-centers" && cellsCount > 2000000) throw Error("Front-center radial selection exceeds 2,000,000 screen cells. Use Through.");
  const append = (index: number, weight: number) => {
    if (rows.length >= SPLAT_SELECTION_LIMIT) throw Error("Radial selection exceeds 1,000,000 original IDs. Previous selection unchanged.");
    rows.push([index, weight]);
  };
  await scanProjectedComponents(options, (index, x, y, depth) => {
    const weight = splatFalloff(Math.hypot(x - center.x, y - center.y), settings.screenRadius, settings);
    if (!weight) return;
    if (options.depth === "front-centers") {
      const key = Math.floor(y / 4) * columns + Math.floor(x / 4), old = cells.get(key);
      if (!old || depth < old.depth || depth === old.depth && index < old.index) cells.set(key, { index, depth, weight });
    } else append(index, weight);
  });
  for (const value of cells.values()) append(value.index, value.weight);
  return resultFromRows(rows);
}
