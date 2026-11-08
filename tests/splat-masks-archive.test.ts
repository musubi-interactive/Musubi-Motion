import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { createSceneStore } from "../src/scene-store.ts";
import type { SplatShapeNode } from "../src/scene-document.ts";
import { maskValue, validateSplatMaskCollections } from "../src/splat-masks.ts";
const example = new URL("../examples/splat-mask-regions.msb", import.meta.url);
describe("native saved sets/scalar mask archives", () => {
  it("reopens sparse/dense masks and sets with exact original source bytes and independent instances", async () => {
    const original = await decodeProject(new Uint8Array(await readFile(example))), bytes = await encodeProject(original.scene, original.files, original.editor), reopened = await decodeProject(bytes);
    expect(reopened.scene).toEqual(original.scene); expect(reopened.editor).toEqual(original.editor);
    expect(Object.keys(reopened.scene.assets)).toEqual(["mask-regions-source"]);
    expect(new Uint8Array(await reopened.files.get("mask-regions-source")!.arrayBuffer())).toEqual(new Uint8Array(await original.files.get("mask-regions-source")!.arrayBuffer()));
    const shape = reopened.scene.nodes["regions-shape"] as SplatShapeNode, other = reopened.scene.nodes["instance-shape"] as SplatShapeNode;
    validateSplatMaskCollections(shape, 513); expect(shape.selectionSets![0].members).toEqual([0, 256]); expect(shape.scalarMasks!.map(m => m.data.kind)).toContain("dense"); expect(maskValue(shape.scalarMasks![0], 1)).toBe(1); expect(maskValue(other.scalarMasks![0], 1)).toBe(0); expect(shape.scalarMasks![0].componentLocks).toEqual([0, 1]);
  });
  it("rejects invalid metadata before replacing a store and stages decoded-count mismatch separately", async () => {
    const source = new Uint8Array(await readFile(example)), original = await decodeProject(source), store = createSceneStore(original.scene), before = store.getState().document;
    for (const mutate of [(shape: SplatShapeNode) => { shape.scalarMasks![0].assetId = "wrong-source"; }, (shape: SplatShapeNode) => { shape.scalarMasks![0].data = { kind: "sparse", defaultValue: 0, indices: [1, 1], values: [.2, .4] }; }, (shape: SplatShapeNode) => { shape.scalarMasks![0].data.values[0] = NaN; }, (shape: SplatShapeNode) => { shape.selectionSets![0].members = [0, 600]; }]) {
      const entries = unzipSync(source), manifest = JSON.parse(strFromU8(entries["scene.json"])); mutate(manifest.scene.nodes["regions-shape"]); entries["scene.json"] = strToU8(JSON.stringify(manifest));
      await expect(decodeProject(zipSync(entries))).rejects.toThrow(); expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(0);
    }
    const malformed = structuredClone(original.scene.nodes["regions-shape"] as SplatShapeNode); for (const item of [...malformed.selectionSets!, ...malformed.scalarMasks!]) item.sourceCount = 514;
    expect(() => validateSplatMaskCollections(malformed, 513)).toThrow(/decoded/);
  });
});
