import type { SplatMesh } from "@sparkjsdev/spark";
import { scanProjectedComponents, type ComponentPickOptions, type ComponentPickPoint, type ComponentProjectionOptions } from "./component-picking.ts";

export const SPLAT_SELECTION_LIMIT = 1_000_000;
export const SPLAT_HIGHLIGHT_LIMIT = 20_000;
export type SplatSelectionIndices = readonly number[] | Uint32Array;
export type SplatSelectionOperation = "replace" | "add" | "subtract" | "toggle";
export type SplatSelectionIdentity = { shapeId: string; assetId: string; count: number };
export type SplatSelectionDepth = "through" | "front-centers" | "scene-visible";
export type SplatSelectionRegion = (x: number, y: number) => boolean;

/** Stable source indices only. Never persist renderer order, LoD or elastic fill IDs. */
export function combineSplatSelection(current: SplatSelectionIndices, hits: SplatSelectionIndices, operation: SplatSelectionOperation, count: number): Uint32Array {
  if (!Number.isSafeInteger(count) || count < 0) throw Error("Invalid original splat count.");
  for (const values of [current, hits]) for (const index of values) if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw Error("Splat selection contains an invalid original index.");
  const a = operation === "replace" ? new Uint32Array() : Uint32Array.from(current).sort(), b = Uint32Array.from(hits).sort();
  const output = new Uint32Array(Math.min(a.length + b.length, SPLAT_SELECTION_LIMIT + 1));
  let i = 0, j = 0, length = 0, last = -1;
  const append = (index: number) => {
    if (index === last) return;
    if (length >= SPLAT_SELECTION_LIMIT) throw Error("Selection exceeds 1,000,000 original splats. Select a smaller region; the previous selection is unchanged.");
    output[length++] = index; last = index;
  };
  while (i < a.length || j < b.length) {
    const left = a[i] ?? Infinity, right = b[j] ?? Infinity;
    if (left < right) { append(left); do { i++; } while (a[i] === left); }
    else if (right < left) { if (operation !== "subtract") append(right); do { j++; } while (b[j] === right); }
    else {
      if (operation === "add" || operation === "replace") append(left);
      do { i++; } while (a[i] === left); do { j++; } while (b[j] === right);
    }
  }
  return output.slice(0, length);
}

/** Deterministic even sampling affects only markers, never selection membership. */
export function splatHighlightIndices(indices: Uint32Array): number[] {
  const count = Math.min(indices.length, SPLAT_HIGHLIGHT_LIMIT);
  return Array.from({ length: count }, (_, offset) => indices[Math.floor(offset * indices.length / count)]);
}

export function splatSelectionOperation(shift: boolean, control: boolean): SplatSelectionOperation {
  return control ? shift ? "add" : "subtract" : shift ? "toggle" : "replace";
}

/** Unbound originals; opacity threshold is also used by the existing skinned reader. */
export function readOriginalSplatPositions(mesh: SplatMesh, indices: readonly number[]): Float32Array {
  const source = mesh.extSplats ?? mesh.packedSplats;
  if (!source) throw Error("Load the original splat asset before selecting components.");
  const positions = new Float32Array(indices.length * 3);
  indices.forEach((index, output) => {
    if (!Number.isInteger(index) || index < 0 || index >= source.numSplats) throw Error("Invalid original splat index.");
    const splat = source.getSplat(index);
    if (splat.opacity * mesh.opacity < mesh.minRaycastOpacity) positions.fill(NaN, output * 3, output * 3 + 3);
    else positions.set(splat.center.toArray(), output * 3);
  });
  return positions;
}

/** Center projection, with optional nearest center in each 4 CSS pixel cell.
 * Front-centers deliberately does not claim alpha, ellipsoid or scene occlusion. */
export async function pickSplatComponents(options: ComponentPickOptions & { depth: SplatSelectionDepth }): Promise<Uint32Array> {
  const { x: sx, y: sy } = options.start, { x: ex, y: ey } = options.end;
  if (![sx, sy, ex, ey].every(Number.isFinite)) throw Error("Selection coordinates must be finite.");
  const click = Math.hypot(ex - sx, ey - sy) < 4;
  const left = Math.min(sx, ex), right = Math.max(sx, ex), top = Math.min(sy, ey), bottom = Math.max(sy, ey);
  return pickSplatRegion(options, click ? (x, y) => (x - ex) ** 2 + (y - ey) ** 2 <= 64
    : (x, y) => x >= left && x <= right && y >= top && y <= bottom, click ? options.end : undefined);
}

/** Shared stable-ID hit scan for click, box, lasso, and brush regions. */
export async function pickSplatRegion(options: ComponentProjectionOptions & { depth: SplatSelectionDepth }, contains: SplatSelectionRegion, click?: ComponentPickPoint): Promise<Uint32Array> {
  if (options.depth === "scene-visible" && !options.readDepth) throw Error("Scene depth is unavailable. Choose Front centers or Through.");
  let nearest = -1, distance = Infinity, depth = Infinity;
  const hits = new Uint32Array(click ? 0 : Math.min(options.componentCount, SPLAT_SELECTION_LIMIT)); let hitCount = 0; const cells = new Map<number, { index: number; depth: number; distance: number }>();
  // Bound memory independently of scene size and display resolution.
  const columns = Math.ceil(options.width / 4) + 1, rows = Math.ceil(options.height / 4) + 1;
  if (options.depth === "front-centers" && columns * rows > 2_000_000) throw Error("Front-center selection supports up to 2,000,000 screen cells. Reduce the viewport size or use Through.");
  await scanProjectedComponents(options, (index, x, y, z) => {
    if (!contains(x, y)) return;
    const d = click ? (x - click.x) ** 2 + (y - click.y) ** 2 : 0;
    if (options.depth === "front-centers") {
      const key = Math.floor(y / 4) * columns + Math.floor(x / 4), previous = cells.get(key);
      if (!previous || z < previous.depth || (z === previous.depth && index < previous.index)) cells.set(key, { index, depth: z, distance: d });
    } else if (click) {
      if (d < distance || (d === distance && (z < depth || (z === depth && index < nearest)))) { nearest = index; distance = d; depth = z; }
    } else {
      if (hitCount >= SPLAT_SELECTION_LIMIT) throw Error("Selection exceeds 1,000,000 original splats. Select a smaller region; the previous selection is unchanged.");
      hits[hitCount++] = index;
    }
  });
  if (options.depth === "front-centers") for (const value of cells.values()) {
    if (click) {
      if (value.distance < distance || (value.distance === distance && (value.depth < depth || (value.depth === depth && value.index < nearest)))) {
        nearest = value.index; distance = value.distance; depth = value.depth;
      }
    } else {
      if (hitCount >= SPLAT_SELECTION_LIMIT) throw Error("Selection exceeds 1,000,000 original splats. Select a smaller region; the previous selection is unchanged.");
      hits[hitCount++] = value.index;
    }
  }
  return click ? nearest < 0 ? new Uint32Array() : new Uint32Array([nearest]) : hits.slice(0, hitCount).sort();
}
