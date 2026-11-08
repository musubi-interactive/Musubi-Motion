import { describe, expect, it } from "vitest";
import { addSplat, emptyScene, type SceneDocument, type SplatShapeNode } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { editSplatComponents } from "../src/splat-component-edits.ts";
import { createSplatSet, editSplatSet, createSplatMask, editSplatCollection, applySplatMaskStroke, maskValue, maskSelection, rangeIndices, setSplatMaskComponentLocks, updateSplatMask, transformMask, validateSplatMaskCollections, validateSceneSplatMasks, splatMaskHistoryBytes, assertSplatMaskUndoFits, SPLAT_MASK_LIMITS } from "../src/splat-masks.ts";
function fixture(count = 20) {
  const asset = { id: "source", kind: "file" as const, fileName: "original.splat", byteLength: count * 32 };
  let doc = addSplat(emptyScene(), asset, "First", [0, 0, 0], "first", "shape").document; doc = addSplat(doc, asset, "Second", [0, 0, 0], "second", "other").document;
  const store = createSceneStore(doc), identity = { shapeId: "shape", assetId: asset.id, count };
  const shape = () => store.getState().document.nodes.shape as SplatShapeNode;
  return { store, identity, shape, mask: () => shape().scalarMasks![0] };
}
describe("authored original-index splat sets and scalar masks", () => {
  it("stores canonical sets, recalls original IDs, edits/renames/locks/deletes in one undo and isolates instances", () => {
    const f = fixture(), before = f.store.getState().document, id = createSplatSet(f.store, f.identity, "Region", [4, 1, 2, 2]);
    expect(f.shape().selectionSets![0].members).toEqual([1, 3, 4, 5]); expect([...rangeIndices(f.shape().selectionSets![0].members)]).toEqual([1, 2, 4]);
    expect((f.store.getState().document.nodes.other as SplatShapeNode).selectionSets).toBeUndefined(); expect(f.store.getState().document.assets).toBe(before.assets);
    const old = f.store.getState().document; editSplatSet(f.store, f.identity, id, "add", [2]); expect(f.store.getState().document).toBe(old);
    editSplatSet(f.store, f.identity, id, "add", [7]); expect([...rangeIndices(f.shape().selectionSets![0].members)]).toEqual([1, 2, 4, 7]);
    f.store.temporal.getState().undo(); expect(f.store.getState().document).toBe(old); f.store.temporal.getState().redo();
    editSplatCollection(f.store, f.identity, "set", id, "rename", "SavedRegion"); expect(f.shape().selectionSets![0].id).toBe(id);
    editSplatCollection(f.store, f.identity, "set", id, "lock", true); expect(() => editSplatSet(f.store, f.identity, id, "replace", [])).toThrow(/Unlock/);
    editSplatCollection(f.store, f.identity, "set", id, "lock", false); editSplatCollection(f.store, f.identity, "set", id, "delete"); expect(f.shape().selectionSets).toEqual([]);
    f.store.temporal.getState().undo(); expect(f.shape().selectionSets![0].name).toBe("SavedRegion");
    expect((before.nodes.shape as SplatShapeNode).selectionSets).toBeUndefined();
  });
  it("imports selection as scalar1, adapts dense/sparse data and exposes deterministic threshold reads", () => {
    const f = fixture(10), id = createSplatMask(f.store, f.identity, "Binary", [1, 3, 5]); expect(f.mask().data.kind).toBe("sparse");
    expect([0, 1, 3, 8].map(i => maskValue(f.mask(), i))).toEqual([0, 1, 1, 0]); expect([...maskSelection(f.mask(), .5)]).toEqual([1, 3, 5]);
    applySplatMaskStroke(f.store, f.identity, id, { indices: new Uint32Array([0, 2, 4, 6, 8]), values: new Float32Array(5).fill(.5) }); expect(f.mask().data.kind).toBe("dense");
    expect(maskValue(f.mask(), 2)).toBe(.5); expect(() => maskValue(f.mask(), 10)).toThrow(/index/);
    const before = f.store.getState().document; applySplatMaskStroke(f.store, f.identity, id, { indices: new Uint32Array([2]), values: new Float32Array([.5]) }); expect(f.store.getState().document).toBe(before);
  });
  it("paint/invert/combine/flood honor layer and original-component locks without normalizing values", () => {
    const f = fixture(5), id = createSplatMask(f.store, f.identity, "Mask", [1]);
    setSplatMaskComponentLocks(f.store, f.identity, id, [1], true);
    applySplatMaskStroke(f.store, f.identity, id, { indices: new Uint32Array([0, 1]), values: new Float32Array([.25, 0]) }); expect(maskValue(f.mask(), 0)).toBe(.25); expect(maskValue(f.mask(), 1)).toBe(1);
    updateSplatMask(f.store, f.identity, id, "Invert", mask => transformMask(mask, "invert")); expect([0, 1, 2].map(i => maskValue(f.mask(), i))).toEqual([.75, 1, 1]);
    const source = { ...f.mask(), locked: false, componentLocks: [], data: { kind: "sparse" as const, defaultValue: .5, indices: [], values: [] } };
    updateSplatMask(f.store, f.identity, id, "Multiply", mask => transformMask(mask, "multiply", 1, source)); expect(maskValue(f.mask(), 0)).toBe(.375); expect(maskValue(f.mask(), 1)).toBe(1);
    updateSplatMask(f.store, f.identity, id, "Flood", mask => transformMask(mask, "flood", 0)); expect([0, 1, 2].map(i => maskValue(f.mask(), i))).toEqual([0, 1, 0]);
    editSplatCollection(f.store, f.identity, "mask", id, "lock", true); const before = f.store.getState().document;
    expect(() => updateSplatMask(f.store, f.identity, id, "Invert", mask => transformMask(mask, "invert"))).toThrow(/Unlock/); expect(f.store.getState().document).toBe(before);
  });
  it("hide/delete/restore preserve saved correspondence and source/other-instance data", () => {
    const f = fixture(), id = createSplatMask(f.store, f.identity, "Mask", [1, 2]); createSplatSet(f.store, f.identity, "Set", [1, 2]);
    const authored = f.shape(), original = f.store.getState().document;
    let hidden = editSplatComponents(original, f.identity, "hide", [1]); hidden = editSplatComponents(hidden, f.identity, "delete", [2]); f.store.setState({ document: hidden });
    applySplatMaskStroke(f.store, f.identity, id, { indices: new Uint32Array([1, 2]), values: new Float32Array([0, 0]) }); expect(f.shape().scalarMasks).toBe(authored.scalarMasks);
    const shown = editSplatComponents(editSplatComponents(f.store.getState().document, f.identity, "show"), f.identity, "restore"); f.store.setState({ document: shown });
    expect(f.shape().scalarMasks).toBe(authored.scalarMasks); expect(f.shape().selectionSets).toBe(authored.selectionSets); expect(maskValue(f.mask(), 1)).toBe(1); expect(shown.nodes.other).toBe(original.nodes.other); expect(shown.assets).toBe(original.assets);
  });
  it("rejects malformed identity/storage, duplicates, nonfinite/invalid stroke and unsupported versions atomically", () => {
    const f = fixture(), id = createSplatMask(f.store, f.identity, "Mask", [1]), before = f.store.getState().document, history = f.store.temporal.getState().pastStates.length;
    for (const values of [new Float32Array([NaN]), new Float32Array([2]), new Float32Array([-1])]) expect(() => applySplatMaskStroke(f.store, f.identity, id, { indices: new Uint32Array([2]), values })).toThrow();
    expect(() => createSplatMask(f.store, f.identity, "Mask", [])).toThrow(/Duplicate/); expect(() => createSplatSet(f.store, f.identity, "", [])).toThrow(); expect(() => createSplatSet(f.store, { ...f.identity, assetId: "missing" }, "Set", [])).toThrow();
    for (const mutate of [(s: SplatShapeNode) => { s.scalarMasks![0].assetId = "other"; }, (s: SplatShapeNode) => { s.scalarMasks![0].sourceCount++; }, (s: SplatShapeNode) => { s.scalarMasks![0].data = { kind: "dense", values: [0] }; }, (s: SplatShapeNode) => { s.scalarMasks![0].version = 2 as 1; }]) { const shape = structuredClone(f.shape()); mutate(shape); expect(() => validateSplatMaskCollections(shape, f.identity.count)).toThrow(); }
    expect(f.store.getState().document).toBe(before); expect(f.store.temporal.getState().pastStates.length).toBe(history);
  });
  it("paints100k per stroke, accumulates200k authored IDs and preserves exact whole-stroke undo", () => {
    const f = fixture(300_000), id = createSplatMask(f.store, f.identity, "Large", []), before = f.store.getState().document;
    applySplatMaskStroke(f.store, f.identity, id, { indices: Uint32Array.from({ length: 100_000 }, (_, i) => i), values: new Float32Array(100_000).fill(.25) });
    const first = f.store.getState().document; expect(maskValue(f.mask(), 99_999)).toBe(.25); f.store.temporal.getState().undo(); expect(f.store.getState().document).toBe(before); f.store.temporal.getState().redo(); expect(f.store.getState().document).toBe(first);
    applySplatMaskStroke(f.store, f.identity, id, { indices: Uint32Array.from({ length: 100_000 }, (_, i) => i + 100_000), values: new Float32Array(100_000).fill(.5) });
    expect([...maskSelection(f.mask(), .25)].length).toBe(200_000); expect(f.mask().data.kind).toBe("dense");
    const last = f.store.getState().document; expect(() => applySplatMaskStroke(f.store, f.identity, id, { indices: new Uint32Array(100_001), values: new Float32Array(100_001) })).toThrow(/100,000/); expect(f.store.getState().document).toBe(last);
  });
  it("retains immediate undo at maximum scene payload, counts shared arrays once, rejects excess before mutation and trims only older history", () => {
    const f = fixture(1_000_000); for (let i = 0; i < 4; i++) { const id = createSplatMask(f.store, f.identity, `Dense${i}`, []); updateSplatMask(f.store, f.identity, id, "Fixture dense", mask => ({ ...mask, data: { kind: "dense", values: new Array(1_000_000).fill(.5) } })); }
    const max = f.store.getState().document, mask = f.mask(), bytes = splatMaskHistoryBytes([max]); expect(bytes).toBe(32_000_000); expect(splatMaskHistoryBytes([max, { ...max }])).toBe(bytes);
    applySplatMaskStroke(f.store, f.identity, mask.id, { indices: Uint32Array.from({ length: 100_000 }, (_, i) => i), values: new Float32Array(100_000).fill(.25) });
    const next = f.store.getState().document; expect(splatMaskHistoryBytes([max, next])).toBe(40_000_000); assertSplatMaskUndoFits(max, next); f.store.temporal.getState().undo(); expect(f.store.getState().document).toBe(max); f.store.temporal.getState().redo(); expect(f.store.getState().document).toBe(next);
    expect(() => createSplatMask(f.store, f.identity, "OverBudget", [1])).toThrow(/exceed/); expect(f.store.getState().document).toBe(next);
    for (let i = 0; i < 20; i++) updateSplatMask(f.store, f.identity, mask.id, "Large version", m => ({ ...m, data: { kind: "dense", values: new Array(1_000_000).fill(i / 20) } }));
    const history = f.store.temporal.getState(); expect(splatMaskHistoryBytes([f.store.getState().document, ...history.pastStates.map(s => s.document!).filter(Boolean)])).toBeLessThanOrEqual(SPLAT_MASK_LIMITS.historyBytes); const immediate = history.pastStates.at(-1)!.document; f.store.temporal.getState().undo(); expect(f.store.getState().document).toBe(immediate);
    validateSceneSplatMasks(f.store.getState().document);
  });
});
