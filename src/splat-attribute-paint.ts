import type { SceneDocument, SplatShapeNode } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import type { SplatSelectionIdentity } from "./splat-component-selection.ts";
import { isSplatComponentActive } from "./splat-component-edits.ts";
import { maskValue, type SplatScalarMask, type SplatMaskValues } from "./splat-masks.ts";
import type { SplatMaskBrush } from "./splat-mask-brush.ts";

export const ATTRIBUTE_PAINT_LIMITS = { source: 1_000_000, layer: 100_000, scene: 250_000, historyBytes: 64 * 1024 * 1024 } as const;
/** Original ID; premultiplied linear RGB and coverage; premultiplied opacity target and coverage. */
export type SplatPaintRow = readonly [number, number, number, number, number, number, number];
export type SplatAttributePaint = { version: 1; sourceCount: number; records: readonly SplatPaintRow[] };
export type SplatPaintSettings = Pick<SplatMaskBrush, "radius" | "falloff" | "strength" | "selectedOnly"> & {
  operation: "replace" | "erase";
  channels: "color" | "opacity" | "both";
  depth: "front" | "through";
  color: string;
  opacity: number;
  maskId: string | null;
};
export const defaultSplatPaintSettings: SplatPaintSettings = {
  operation: "replace", channels: "color", depth: "front", color: "#e26040", opacity: 1,
  maskId: null, selectedOnly: false, radius: 30, falloff: "smooth", strength: 1,
};
const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const originalCount = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= ATTRIBUTE_PAINT_LIMITS.source;

export function validateSplatPaintSettings(settings: SplatPaintSettings) {
  if (!Number.isFinite(settings.radius) || settings.radius < 1 || settings.radius > 512 ||
    !unit(settings.strength) || !unit(settings.opacity) || !/^#[0-9a-f]{6}$/i.test(settings.color) ||
    !["replace", "erase"].includes(settings.operation) || !["color", "opacity", "both"].includes(settings.channels) ||
    !["front", "through"].includes(settings.depth) || !["constant", "linear", "smooth"].includes(settings.falloff) ||
    typeof settings.selectedOnly !== "boolean" || settings.maskId !== null && typeof settings.maskId !== "string")
    throw Error("Invalid paint controls. Use radius 1–512 px, an RGB color, and strength and opacity between zero and one.");
}

export function validateSplatAttributePaint(shape: SplatShapeNode, decodedCount?: number) {
  const paint = shape.attributePaint;
  if (paint === undefined) return 0;
  if (!paint || typeof paint !== "object" || paint.version !== 1 || Object.keys(paint).length !== 3 ||
    !originalCount(paint.sourceCount) || !Array.isArray(paint.records) || !paint.records.length || paint.records.length > ATTRIBUTE_PAINT_LIMITS.layer)
    throw Error("Invalid splat attribute paint version, source count or layer record budget.");
  const counts = [decodedCount, shape.appearance?.sourceCount, shape.componentEdits?.sourceCount, shape.componentTransforms?.sourceCount,
    shape.scalarMasks?.[0]?.sourceCount, shape.selectionSets?.[0]?.sourceCount, shape.binding?.weights?.count];
  if (counts.some(count => count !== undefined && count !== paint.sourceCount))
    throw Error("Splat attribute paint does not match the decoded original source count.");
  let previous = -1;
  for (const record of paint.records) {
    if (!Array.isArray(record) || record.length !== 7) throw Error("Invalid splat attribute paint record.");
    const [id, red, green, blue, colorWeight, opacity, opacityWeight] = record;
    if (!Number.isSafeInteger(id) || id <= previous || id >= paint.sourceCount || !unit(colorWeight) || !unit(opacityWeight) ||
      ![red, green, blue, opacity].every(unit) || Math.max(red, green, blue) > colorWeight || opacity > opacityWeight || colorWeight + opacityWeight === 0)
      throw Error("Splat paint records need ordered original IDs and bounded premultiplied channels.");
    previous = id;
  }
  return paint.records.length;
}

export function validateSceneSplatAttributePaint(doc: SceneDocument) {
  let total = 0;
  for (const node of Object.values(doc.nodes)) if (node.type === "splatShape") total += validateSplatAttributePaint(node);
  if (total > ATTRIBUTE_PAINT_LIMITS.scene) throw Error("Scene paint exceeds 250,000 edited original splats.");
}

function linearColor(hex: string) {
  return [1, 3, 5].map(offset => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
}

function editRow(id: number, previous: SplatPaintRow | undefined, settings: SplatPaintSettings, color: number[], weight: number): SplatPaintRow | undefined {
  const [, red, green, blue, colorWeight, opacity, opacityWeight] = previous ?? [id, 0, 0, 0, 0, 0, 0];
  const target = settings.operation === "replace" ? weight : 0, keep = 1 - weight;
  const rgb = settings.channels !== "opacity", alpha = settings.channels !== "color";
  const cw = rgb ? Math.fround(colorWeight * keep + target) : colorWeight;
  const aw = alpha ? Math.fround(opacityWeight * keep + target) : opacityWeight;
  if (cw + aw === 0) return;
  return [
    id,
    rgb ? Math.min(cw, Math.fround(red * keep + color[0] * target)) : red,
    rgb ? Math.min(cw, Math.fround(green * keep + color[1] * target)) : green,
    rgb ? Math.min(cw, Math.fround(blue * keep + color[2] * target)) : blue,
    cw,
    alpha ? Math.min(aw, Math.fround(opacity * keep + settings.opacity * target)) : opacity,
    aw,
  ];
}

export function withSplatPaintStroke(
  shape: SplatShapeNode, count: number, settings: SplatPaintSettings, values: SplatMaskValues,
  selected?: ReadonlySet<number>, mask?: SplatScalarMask,
): SplatAttributePaint | undefined {
  validateSplatPaintSettings(settings);
  if (!originalCount(count) || shape.attributePaint && shape.attributePaint.sourceCount !== count)
    throw Error("Paint requires a matching source of up to 1,000,000 original splats.");
  if (settings.selectedOnly && !selected?.size) throw Error("Select original splat components before painting the selection.");
  if (settings.maskId !== null && (mask?.id !== settings.maskId || mask.sourceCount !== count || mask.assetId !== shape.assetId))
    throw Error("Choose a scalar mask on this original splat source.");
  if (values.indices.length !== values.values.length || values.indices.length > ATTRIBUTE_PAINT_LIMITS.layer)
    throw Error("A paint stroke supports up to 100,000 original IDs.");
  const before = shape.attributePaint?.records ?? [], edits: { id: number; row?: SplatPaintRow }[] = [];
  const color = linearColor(settings.color);
  let last = -1, slot = 0;
  values.indices.forEach((id, offset) => {
    const coverage = values.values[offset];
    if (!Number.isSafeInteger(id) || id <= last || id >= count || !unit(coverage)) throw Error("Invalid or unordered original splat paint coverage.");
    last = id;
    if (!isSplatComponentActive(shape.componentEdits, id) || selected && !selected.has(id)) return;
    const weight = coverage * (mask ? maskValue(mask, id) : 1);
    if (!weight) return;
    while (slot < before.length && before[slot][0] < id) slot++;
    const previous = before[slot]?.[0] === id ? before[slot] : undefined;
    const row = editRow(id, previous, settings, color, weight);
    if (previous === row || previous && row?.every((component, index) => component === previous[index])) return;
    edits.push({ id, row });
  });
  if (!edits.length) return shape.attributePaint;
  const records: SplatPaintRow[] = [];
  slot = 0;
  for (const { id, row } of edits) {
    while (slot < before.length && before[slot][0] < id) records.push(before[slot++]);
    if (before[slot]?.[0] === id) slot++;
    if (row) records.push(row);
  }
  while (slot < before.length) records.push(before[slot++]);
  if (records.length > ATTRIBUTE_PAINT_LIMITS.layer) throw Error("This layer would exceed 100,000 painted originals. Erase a region first.");
  return records.length ? { version: 1, sourceCount: count, records } : undefined;
}

function historyBytes(doc: SceneDocument, seen: Set<object>) {
  let bytes = 0;
  for (const shape of Object.values(doc.nodes)) if (shape.type === "splatShape" && shape.attributePaint) {
    const rows = shape.attributePaint.records;
    if (seen.has(rows)) continue;
    seen.add(rows);
    bytes += rows.length * 8;
    for (const row of rows) if (!seen.has(row)) { seen.add(row); bytes += 112; }
  }
  return bytes;
}

export function assertSplatPaintUndoFits(before: SceneDocument, next: SceneDocument) {
  const seen = new Set<object>();
  if (historyBytes(next, seen) + historyBytes(before, seen) > ATTRIBUTE_PAINT_LIMITS.historyBytes)
    throw Error("This edit exceeds the immediate undo budget for splat paint.");
}

export function trimSplatPaintHistory(store: SceneStore) {
  const history = store.temporal.getState();
  const seen = new Set<object>();
  let bytes = historyBytes(store.getState().document, seen);
  let keep = history.pastStates.length;
  while (keep > 0) {
    const older = history.pastStates[keep - 1].document;
    if (older) bytes += historyBytes(older, seen);
    if (bytes > ATTRIBUTE_PAINT_LIMITS.historyBytes) break;
    keep--;
  }
  if (keep > 0) store.temporal.setState({ pastStates: history.pastStates.slice(keep) });
}

export function commitSplatAttributePaint(store: SceneStore, identity: SplatSelectionIdentity, base: SplatShapeNode,
  paint: SplatAttributePaint | undefined, label = "Paint splat attributes") {
  const doc = store.getState().document, shape = doc.nodes[identity.shapeId];
  if (shape !== base || shape?.type !== "splatShape" || shape.assetId !== identity.assetId || !Object.hasOwn(doc.assets, identity.assetId))
    throw Error("The selected splat source changed; no paint was applied.");
  if (paint === shape.attributePaint) return false;
  const next = { ...shape };
  if (paint) next.attributePaint = paint;
  else delete next.attributePaint;
  validateSplatAttributePaint(next, identity.count);
  const document = { ...doc, nodes: { ...doc.nodes, [shape.id]: next } };
  const rows = Object.values(document.nodes).reduce((sum, node) => sum + (node.type === "splatShape" ? node.attributePaint?.records.length ?? 0 : 0), 0);
  if (rows > ATTRIBUTE_PAINT_LIMITS.scene) throw Error("Scene paint would exceed 250,000 edited originals; no paint was applied.");
  assertSplatPaintUndoFits(doc, document);
  store.setState({ document, editLabel: label });
  trimSplatPaintHistory(store);
  return true;
}
