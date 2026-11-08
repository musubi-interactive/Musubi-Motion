import { Line3, MathUtils, Vector3 } from "three";
import { scanProjectedComponents, type ComponentPickPoint, type ComponentProjectionOptions } from "./component-picking.ts";

export type SkinBrushIndex = {
  readonly componentCount: number;
  readonly visibleCount: number;
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  query(left: number, top: number, right: number, bottom: number, visit: (index: number, x: number, y: number) => void): void;
};
export type SkinBrushOptions = {
  radius: number;
  strength: number;
  value: number;
  mode: "replace" | "add" | "subtract";
  getWeight: (index: number) => number;
  limit?: number;
};
export type SkinBrushValue = { index: number; weight: number };
export type SkinBrushStroke = {
  addSegment(start: ComponentPickPoint, end: ComponentPickPoint): void;
  values(): SkinBrushValue[];
  readonly affectedCount: number;
};

const CELL_SIZE = 32;
const MAX_AFFECTED = 20_000;
type Bucket = { column: number; row: number; chunks: Float64Array[]; used: number };

/** Builds an immutable X-ray screen index; cancelled scans never return a partial index. */
export async function createSkinBrushIndex(options: ComponentProjectionOptions & { projectedLimit?: number }): Promise<SkinBrushIndex> {
  const { componentCount, width, height } = options;
  const buckets = new Map<string, Bucket>();
  let visibleCount = 0;
  if (options.projectedLimit !== undefined && (!Number.isSafeInteger(options.projectedLimit) || options.projectedLimit < 1)) throw Error("Invalid projected brush index limit.");
  await scanProjectedComponents(options, (index, x, y) => {
    if (visibleCount >= (options.projectedLimit ?? Infinity)) throw Error("Brush index exceeds its projected component budget. Use a smaller viewport region; nothing changed.");
    const column = Math.floor(x / CELL_SIZE), row = Math.floor(y / CELL_SIZE), key = `${column}/${row}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { column, row, chunks: [new Float64Array(8 * 3)], used: 0 }; buckets.set(key, bucket); }
    let data = bucket.chunks[bucket.chunks.length - 1];
    if (bucket.used === data.length) {
      data = new Float64Array(Math.min(256 * 3, data.length * 2));
      bucket.chunks.push(data); bucket.used = 0;
    }
    data[bucket.used++] = index; data[bucket.used++] = x; data[bucket.used++] = y; visibleCount++;
  });
  // Bounded typed chunks preserve IDs/precision without a final full-index copy or per-point objects.
  if (options.cancelled?.()) throw new DOMException("Brush indexing cancelled; no index was created.", "AbortError");
  return {
    componentCount, visibleCount, width, height, cellSize: CELL_SIZE,
    query(left, top, right, bottom, visit) {
      if (![left, top, right, bottom].every(Number.isFinite) || left > right || top > bottom) throw Error("Brush query requires finite ordered screen bounds.");
      left = Math.max(0, left); top = Math.max(0, top); right = Math.min(width, right); bottom = Math.min(height, bottom);
      if (left > right || top > bottom) return;
      const firstColumn = Math.floor(left / CELL_SIZE), lastColumn = Math.floor(right / CELL_SIZE);
      const firstRow = Math.floor(top / CELL_SIZE), lastRow = Math.floor(bottom / CELL_SIZE);
      const inspect = (bucket: Bucket | undefined) => {
        if (!bucket) return;
        for (let chunk = 0; chunk < bucket.chunks.length; chunk++) {
          const data = bucket.chunks[chunk], length = chunk === bucket.chunks.length - 1 ? bucket.used : data.length;
          for (let offset = 0; offset < length; offset += 3) {
            const x = data[offset + 1], y = data[offset + 2];
            if (x >= left && x <= right && y >= top && y <= bottom) visit(data[offset], x, y);
          }
        }
      };
      // A sparse index can cover a very large canvas. Avoid enumerating empty cells.
      const area = (lastColumn - firstColumn + 1) * (lastRow - firstRow + 1);
      if (area > buckets.size * 4 + 1024) {
        for (const bucket of buckets.values()) if (bucket.column >= firstColumn && bucket.column <= lastColumn && bucket.row >= firstRow && bucket.row <= lastRow) inspect(bucket);
      } else {
        for (let row = 0; row < lastRow - firstRow + 1; row++) for (let column = 0; column < lastColumn - firstColumn + 1; column++) inspect(buckets.get(`${firstColumn + column}/${firstRow + row}`));
      }
    },
  };
}

/** Coverage is the strongest capsule hit in one stroke, always applied to its original weight. */
export function createSkinBrushStroke(index: SkinBrushIndex, options: SkinBrushOptions): SkinBrushStroke {
  const { radius, strength, value, mode, getWeight } = options, limit = options.limit ?? MAX_AFFECTED;
  if (!Number.isFinite(radius) || radius < 1 || radius > 256) throw Error("Brush radius must be between 1 and 256 pixels.");
  if (![strength, value].every(number => Number.isFinite(number) && number >= 0 && number <= 1)) throw Error("Brush strength and value must be between zero and one.");
  if (!["replace", "add", "subtract"].includes(mode) || typeof getWeight !== "function") throw Error("Choose a valid brush mode and weight reader.");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AFFECTED) throw Error("A brush stroke supports at most 20,000 components.");
  const affected = new Map<number, { base: number; coverage: number }>();
  const line = new Line3(), point = new Vector3(), closest = new Vector3();
  let failure: Error | undefined;
  function check() { if (failure) throw failure; }
  return {
    get affectedCount() { return affected.size; },
    addSegment(start, end) {
      check();
      try {
        if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) throw Error("Brush segment positions must be finite canvas pixels.");
        if (strength === 0) return;
        line.start.set(start.x, start.y, 0); line.end.set(end.x, end.y, 0);
        const stationary = line.start.equals(line.end);
        index.query(Math.min(start.x, end.x) - radius, Math.min(start.y, end.y) - radius,
          Math.max(start.x, end.x) + radius, Math.max(start.y, end.y) + radius, (component, x, y) => {
            point.set(x, y, 0);
            if (stationary) closest.copy(line.start); else line.closestPointToPoint(point, true, closest);
            const distance = point.distanceTo(closest), coverage = strength * (1 - MathUtils.smoothstep(distance, 0, radius));
            if (!Number.isFinite(coverage)) throw Error("Brush segment could not be evaluated.");
            if (coverage <= 0) return;
            const previous = affected.get(component);
            if (previous) { previous.coverage = Math.max(previous.coverage, coverage); return; }
            if (affected.size >= limit) throw Error(`Brush stroke exceeds the ${limit.toLocaleString("en-US")} component limit. Use a smaller brush or shorter stroke.`);
            const base = getWeight(component);
            if (!Number.isFinite(base) || base < 0 || base > 1) throw Error("Brush component weights must be finite values between zero and one.");
            affected.set(component, { base, coverage });
          });
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        affected.clear(); throw failure;
      }
    },
    values() {
      check();
      return [...affected].sort(([a], [b]) => a - b).map(([index, { base, coverage }]) => ({ index, base,
        weight: mode === "replace" ? base === value ? base : MathUtils.lerp(base, value, coverage)
          : MathUtils.clamp(base + (mode === "add" ? 1 : -1) * value * coverage, 0, 1),
      })).filter(({ weight, base }) => weight !== base).map(({ index, weight }) => ({ index, weight }));
    },
  };
}
