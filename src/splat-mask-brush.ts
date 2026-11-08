import { Line3, Vector3 } from "three";
import type { SkinBrushIndex } from "./skin-weight-brush.ts";
import { SPLAT_MASK_LIMITS, type SplatMaskValues } from "./splat-masks.ts";

export type SplatMaskBrush = { shapeId: string; maskId: string; mode: "replace" | "add" | "erase" | "smooth"; falloff: "constant" | "linear" | "smooth"; radius: number; strength: number; value: number; selectedOnly: boolean };
export type MaskPoint = { x: number; y: number };
export function validateSplatMaskBrush(settings: SplatMaskBrush) {
  if (!Number.isFinite(settings.radius) || settings.radius < 1 || settings.radius > 512 || ![settings.strength, settings.value].every(v => Number.isFinite(v) && v >= 0 && v <= 1)
    || !["replace", "add", "erase", "smooth"].includes(settings.mode) || !["constant", "linear", "smooth"].includes(settings.falloff) || typeof settings.selectedOnly !== "boolean") throw Error("Mask brush needs radius 1–512 px, strength/value 0–1, and a valid operation/falloff.");
}
/** Strongest continuous capsule coverage per stroke, applied to immutable bases.
 * Typed rows store up to100k IDs independent of the20k overlay sample. Smooth
 * averages immutable eligible centers in the surrounding3x3 32px screen cells. */
export function createSplatMaskStroke(index: SkinBrushIndex, settings: SplatMaskBrush, read: (id: number) => number, locked: (id: number) => boolean) {
  validateSplatMaskBrush(settings);
  const capacity = SPLAT_MASK_LIMITS.stroke, ids = new Uint32Array(capacity), bases = new Float32Array(capacity), coverage = new Float32Array(capacity), targets = new Float32Array(capacity), slots = new Map<number, number>();
  const smooth = new Map<string, number>(), line = new Line3(), point = new Vector3(), closest = new Vector3(); let used = 0, failure: Error | undefined;
  const average = (x: number, y: number) => {
    const column = Math.floor(x / index.cellSize), row = Math.floor(y / index.cellSize), key = `${column}/${row}`, cached = smooth.get(key);
    if (cached !== undefined) return cached;
    let sum = 0, count = 0;
    index.query((column - 1) * index.cellSize, (row - 1) * index.cellSize, (column + 2) * index.cellSize, (row + 2) * index.cellSize, id => { const value = read(id); if (!Number.isFinite(value) || value < 0 || value > 1) throw Error("Smooth read an invalid mask value."); sum += value; count++; });
    const value = count ? sum / count : 0; smooth.set(key, value); return value;
  };
  return {
    get affectedCount() { return used; },
    addSegment(start: MaskPoint, end: MaskPoint) {
      if (failure) throw failure;
      try {
        if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) throw Error("Mask brush positions must be finite canvas pixels.");
        if (settings.strength === 0) return;
        line.start.set(start.x, start.y, 0); line.end.set(end.x, end.y, 0);
        index.query(Math.min(start.x, end.x) - settings.radius, Math.min(start.y, end.y) - settings.radius, Math.max(start.x, end.x) + settings.radius, Math.max(start.y, end.y) + settings.radius, (id, x, y) => {
          if (locked(id)) return; point.set(x, y, 0); if (line.start.equals(line.end)) closest.copy(line.start); else line.closestPointToPoint(point, true, closest);
          const distance = point.distanceTo(closest) / settings.radius; if (distance > 1) return;
          const t = Math.max(0, 1 - distance), falloff = settings.falloff === "constant" ? 1 : settings.falloff === "linear" ? t : t * t * (3 - 2 * t), influence = settings.strength * falloff;
          if (influence <= 0) return;
          let slot = slots.get(id);
          if (slot === undefined) {
            if (used >= capacity) throw Error("Mask stroke exceeds 100,000 edited original IDs. Use a smaller radius or shorter stroke; nothing changed.");
            const base = read(id); if (!Number.isFinite(base) || base < 0 || base > 1) throw Error("Mask brush read an invalid scalar value.");
            const target = settings.mode === "smooth" ? average(x, y) : settings.mode === "replace" ? settings.value : Math.min(1, Math.max(0, base + (settings.mode === "erase" ? -1 : 1) * settings.value));
            if (Math.fround(base) === Math.fround(target)) return;
            slot = used++; slots.set(id, slot); ids[slot] = id; bases[slot] = base; targets[slot] = target;
          }
          coverage[slot] = Math.max(coverage[slot], influence);
        });
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); slots.clear(); used = 0; throw failure; }
    },
    values(): SplatMaskValues {
      if (failure) throw failure;
      const sorted = Array.from({ length: used }, (_, i) => i).sort((a, b) => ids[a] - ids[b]), outputIds = new Uint32Array(used), values = new Float32Array(used); let changed = 0;
      for (const slot of sorted) { const value = Math.fround(bases[slot] + (targets[slot] - bases[slot]) * coverage[slot]); if (value !== bases[slot]) { outputIds[changed] = ids[slot]; values[changed++] = value; } }
      return { indices: outputIds.subarray(0, changed), values: values.subarray(0, changed) };
    },
  };
}
