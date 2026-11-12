import { Matrix4, Vector3 } from "three";
import { scanProjectedComponents, type ComponentProjectionOptions } from "./component-picking.ts";
import { SPLAT_SELECTION_LIMIT, type SplatSelectionDepth, type SplatSelectionOperation } from "./splat-component-selection.ts";

export type WeightedSplatSelection = { indices: Uint32Array; weights: Float32Array };
export type SoftFalloffPoint = Readonly<{ distance: number; weight: number }>;
export type SoftFalloffCurve = readonly SoftFalloffPoint[];
export const MAX_SOFT_FALLOFF_POINTS = 32;
export const defaultSoftFalloffCurve = (): SoftFalloffCurve => [{ distance: 0, weight: 1 }, { distance: 1, weight: 0 }];
export type SplatSoftSettings = { enabled: boolean; curve: "linear" | "smooth" | "sharp" | "custom"; customCurve?: SoftFalloffCurve; core: number; worldRadius: number; screenRadius: number; center: [number, number, number] };
export const defaultSplatSoftSettings = (): SplatSoftSettings => ({ enabled: false, curve: "smooth", customCurve: defaultSoftFalloffCurve(), core: 0, worldRadius: 1, screenRadius: 100, center: [0, 0, 0] });

export function validateSoftFalloffCurve(value: unknown): asserts value is SoftFalloffCurve {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_SOFT_FALLOFF_POINTS)
    throw Error(`Use 2–${MAX_SOFT_FALLOFF_POINTS} falloff points.`);
  let previousDistance = -1, previousWeight = 1;
  for (const point of value) {
    if (!point || typeof point !== "object" || !Number.isFinite(point.distance) || !Number.isFinite(point.weight)
      || point.distance < 0 || point.distance > 1 || point.distance <= previousDistance || point.weight < 0 || point.weight > previousWeight)
      throw Error("Falloff distances must increase and weights must stay between 0 and 1 without increasing.");
    previousDistance = point.distance; previousWeight = point.weight;
  }
  const first = value[0], last = value[value.length - 1];
  if (first.distance !== 0 || first.weight !== 1 || last.distance !== 1 || last.weight !== 0)
    throw Error("Falloff endpoints are fixed at distance 0, weight 1 and distance 1, weight 0.");
}

/** Neighboring secants limit shared tangents so each cubic's controls remain
 * ordered by weight. Flat intervals are exact and adjacent segments are C1. */
export function prepareSoftFalloffCurve(points: SoftFalloffCurve) {
  validateSoftFalloffCurve(points);
  const distances = points.map(point => point.distance), weights = points.map(point => point.weight);
  const secants = points.slice(1).map((point, i) => (weights[i] - point.weight) / (point.distance - distances[i]));
  const slopes = points.map((_, i) => {
    const slope = Math.min(secants[i - 1] ?? Infinity, secants[i] ?? Infinity);
    return Number.isFinite(slope) ? slope : 0;
  });
  const segments = secants.map((_, i) => {
    const width = distances[i + 1] - distances[i];
    return { width, first: weights[i] - slopes[i] * width / 3, second: weights[i + 1] + slopes[i + 1] * width / 3 };
  });
  function sample(distance: number): number {
    if (distance <= 0) return 1;
    if (distance >= 1) return 0;
    let low = 0, high = distances.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (distance < distances[middle]) high = middle;
      else low = middle;
    }
    const start = weights[low], end = weights[high], segment = segments[low];
    if (distance === distances[low] || start === end) return start;
    const t = (distance - distances[low]) / segment.width, u = 1 - t;
    return Math.max(end, Math.min(start, u ** 3 * start + 3 * u * t * (u * segment.first + t * segment.second) + t ** 3 * end));
  }
  return { sample, segments };
}

export function splatSoftCoreFraction(settings: SplatSoftSettings): number {
  if (!settings.enabled) return 1;
  if (settings.curve !== "custom") return settings.core;
  let core = 0;
  for (const point of settings.customCurve ?? []) {
    if (point.weight !== 1) break;
    core = point.distance;
  }
  return core;
}

export function validateSplatSoftSettings(value: SplatSoftSettings): void {
  if (!value || typeof value.enabled !== "boolean" || !["linear", "smooth", "sharp", "custom"].includes(value.curve)
    || !Number.isFinite(value.core) || value.core < 0 || value.core > .95
    || !Number.isFinite(value.worldRadius) || value.worldRadius < .000001 || value.worldRadius > 1e6
    || !Number.isFinite(value.screenRadius) || value.screenRadius < 1 || value.screenRadius > 16384
    || !Array.isArray(value.center) || value.center.length !== 3 || !value.center.every(v => Number.isFinite(v) && Math.abs(v) <= 1e6))
    throw Error("Use a sphere radius 0.000001–1,000,000 world units, radial radius 1–16,384 px, finite center within +/-1,000,000 and core 0–0.95.");
  if (value.curve === "custom" || value.customCurve !== undefined) validateSoftFalloffCurve(value.customCurve);
}

type FalloffSettings = Pick<SplatSoftSettings, "enabled" | "curve" | "core" | "customCurve">;
function prepareSplatFalloff(radius: number, settings: FalloffSettings): (distance: number) => number {
  if (!Number.isFinite(radius) || radius <= 0) throw Error("Selection radius must be finite and positive.");
  const { enabled, curve, core, customCurve } = settings;
  const custom = enabled && curve === "custom" ? prepareSoftFalloffCurve(customCurve!).sample : undefined;
  return distance => {
    if (!Number.isFinite(distance) || distance < 0) throw Error("Selection distance must be finite and nonnegative.");
    if (distance > radius) return 0;
    if (!enabled) return 1;
    if (custom) return custom(distance / radius);
    const t = Math.max(0, Math.min(1, (distance / radius - core) / (1 - core)));
    const weight = curve === "linear" ? 1 - t : curve === "sharp" ? (1 - t) ** 2 : 1 - t * t * (3 - 2 * t);
    return Math.max(0, Math.min(1, weight));
  };
}
export function splatFalloff(distance: number, radius: number, settings: FalloffSettings): number {
  return prepareSplatFalloff(radius, settings)(distance);
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
  const falloff = prepareSplatFalloff(settings.worldRadius, settings);
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
      const weight = Math.fround(falloff(point.applyMatrix4(matrix).distanceTo(center)));
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
  const falloff = prepareSplatFalloff(settings.screenRadius, settings);
  if (![center.x, center.y].every(Number.isFinite)) throw Error("Radial center must be finite CSS pixels.");
  const rows: [number, number][] = [], cells = new Map<number, { index: number; depth: number; weight: number }>();
  const columns = Math.ceil(options.width / 4) + 1, cellsCount = columns * (Math.ceil(options.height / 4) + 1);
  if (options.depth === "front-centers" && cellsCount > 2000000) throw Error("Front-center radial selection exceeds 2,000,000 screen cells. Use Through.");
  const append = (index: number, weight: number) => {
    if (rows.length >= SPLAT_SELECTION_LIMIT) throw Error("Radial selection exceeds 1,000,000 original IDs. Previous selection unchanged.");
    rows.push([index, weight]);
  };
  await scanProjectedComponents(options, (index, x, y, depth) => {
    const weight = Math.fround(falloff(Math.hypot(x - center.x, y - center.y)));
    if (!weight) return;
    if (options.depth === "front-centers") {
      const key = Math.floor(y / 4) * columns + Math.floor(x / 4), old = cells.get(key);
      if (!old || depth < old.depth || depth === old.depth && index < old.index) cells.set(key, { index, depth, weight });
    } else append(index, weight);
  });
  for (const value of cells.values()) append(value.index, value.weight);
  return resultFromRows(rows);
}
