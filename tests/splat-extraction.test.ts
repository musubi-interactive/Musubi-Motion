import { ExtSplats, SplatMesh, utils } from "@sparkjsdev/spark";
import { Color, Matrix4, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { defaultAnimation, evaluateChannels, type CurveKey } from "../src/animation.ts";
import { objectLocalMatrix } from "../src/object-pivot.ts";
import { createProceduralGraph } from "../src/procedural-graph.ts";
import { decodeProject, encodeProject, validateScene, type EditorSnapshot } from "../src/project-archive.ts";
import { addSplat, emptyScene, type SplatShapeNode, type TransformNode } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { newSplatAppearanceLayer } from "../src/splat-appearance.ts";
import { createBinding } from "../src/splat-binding.ts";
import {
  addSplatExtraction, assertSplatExtractionBudget, decodeSplatExtraction, encodeSplatExtraction,
  splatExtractionFileSize, splatExtractionSource, SPLAT_EXTRACTION_LIMIT, SPLAT_EXTRACTION_NAME,
} from "../src/splat-extraction.ts";
import { maskValue } from "../src/splat-masks.ts";
import { createSplatTransformRuntime } from "../src/splat-transform-runtime.ts";

const bands = ["sh1", "sh2", "sh3a", "sh3b"] as const;
const identity = { assetId: "original-asset", shapeId: "original-shape", count: 5 };
const chosen = Uint32Array.of(1, 3);

function sourceSplats(degree: number) {
  const count = identity.count;
  const words = utils.getTextureSize(count).maxSplats * 4;
  const extArrays: [Uint32Array, Uint32Array] = [new Uint32Array(words), new Uint32Array(words)];
  const extra = Object.fromEntries(bands.slice(0, [0, 1, 2, 4][degree]).map((band, i) => {
    const values = new Uint32Array(words);
    for (let k = 0; k < count * 4; k++) values[k] = 0x3200000 * (i + 1) + k * 2347;
    return [band, values];
  }));
  const source = new ExtSplats({ extArrays, extra, numSplats: count });
  for (let i = 0; i < count; i++) {
    const orientation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), i * .12);
    source.setSplat(i, new Vector3(i / 4, -i / 8, .2), new Vector3(.2, .3, .14), orientation, .2 + i / 10, new Color(.1 + i / 10, .2, .6));
  }
  return source;
}

const key = (id: string, time: number, value: number): CurveKey =>
  ({ id, time, value, interpolation: "linear", tangentMode: "auto" });

function sceneFixture() {
  const asset = { id: identity.assetId, kind: "file" as const, fileName: "source.ply", byteLength: 4 };
  const { document } = addSplat(emptyScene(), asset, "Original", [.1, .2, .3], "original", identity.shapeId);
  const original = document.nodes.original as TransformNode;
  original.parentId = "group";
  original.position = [2, -1, .5];
  original.rotation = [12, 7, 18];
  original.scale = [1.2, .95, 1.1];
  original.pivot = [.2, .4, -.6];
  original.pivotCompensation = [.2, 0, 0];
  original.affine = [1, 0, 0, .1, 1, 0, .2, 0, 1];
  document.rootIds = ["group"];
  document.nodes.group = { ...original, id: "group", parentId: null, name: "Group", position: [-4, 0, 0] };
  document.joints = [
    { id: "one", name: "One", parentId: null, position: [0, 0, 0] },
    { id: "two", name: "Two", parentId: "one", position: [.25, .5, 0] },
  ];
  document.animation = {
    ...defaultAnimation(),
    layers: [{ id: "additive", name: "Additive", mode: "additive", weight: .4, mute: false, solo: false, locked: false }],
    tracks: [
      { id: "original-x", targetId: original.id, channel: "position.x", keys: [key("x-start", 0, 2), key("x-end", 24, 3)] },
      { id: "original-rz", targetId: original.id, layerId: "additive", channel: "rotation.z", keys: [key("z-start", 0, 0), key("z-end", 24, 23)] },
      { id: "original-visible", targetId: original.id, channel: "visibility", keys: [
        { ...key("v-start", 0, 1), interpolation: "step" }, { ...key("v-end", 24, 0), interpolation: "step" },
      ] },
      { id: "joint-motion", targetId: "two", channel: "rotation.z", keys: [key("j-start", 0, 0), key("j-end", 24, 45)] },
    ],
  };
  const shape = document.nodes[identity.shapeId] as SplatShapeNode;
  shape.binding = {
    jointIds: ["one", "two"],
    restMatrices: [new Matrix4().toArray(), new Matrix4().makeTranslation(.25, .5, 0).toArray()],
    weights: { count: 5, overrides: { 1: [{ jointId: "one", weight: .25 }, { jointId: "two", weight: .75 }], 4: [{ jointId: "two", weight: 1 }] } },
  };
  shape.componentEdits = { version: 1, sourceCount: 5, hidden: [0, 1], deleted: [2, 3] };
  shape.componentTransforms = { version: 1, sourceCount: 5, records: [
    { index: 1, matrix: new Matrix4().makeTranslation(.125, .25, .5).toArray() },
    { index: 4, matrix: new Matrix4().makeScale(1.1, .8, 1).toArray() },
  ] };
  shape.attributePaint = { version: 1, sourceCount: 5, records: [[1, .3, 0, .1, .5, .2, .4], [2, .1, .2, 0, .5, .1, .2]] };
  const collection = { version: 1 as const, name: "Region", locked: false, assetId: identity.assetId, sourceCount: 5 };
  shape.selectionSets = [{ ...collection, id: "set", members: [0, 2, 4, 5] }];
  shape.scalarMasks = [{ ...collection, id: "mask", locked: true, data: { kind: "dense", values: [.2, .3, 0, .9, 1] }, componentLocks: [3, 5] }];
  shape.appearance = { version: 1, sourceCount: 5, layers: [{ ...newSplatAppearanceLayer(), maskId: "mask" }] };
  document.proceduralGraph = createProceduralGraph();
  return { document, shape, original };
}

const signal = () => new AbortController().signal;
const editor: EditorSnapshot = { camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45, near: .01, far: 500 }, time: 0 };

describe("duplicate selected original splats", () => {
  it.each([0, 1, 2, 3])("copies independent Gaussian and SH%d source words exactly", async degree => {
    const source = sourceSplats(degree);
    const before = source.extArrays.map(array => array.slice());
    const data = await encodeSplatExtraction(source, identity, chosen, signal());
    const { splats, originalIds, sourceAssetId, sourceShapeId, sourceCount } = decodeSplatExtraction(data);
    expect([sourceAssetId, sourceShapeId, sourceCount]).toEqual([identity.assetId, identity.shapeId, 5]);
    expect(originalIds).toEqual(chosen);
    expect(splats.numSplats).toBe(2);
    expect(splats.getNumSh()).toBe(degree);
    chosen.forEach((id, index) => {
      expect(splats.getSplat(index)).toEqual(source.getSplat(id));
      source.extArrays.forEach((array, plane) =>
        expect(splats.extArrays[plane].slice(index * 4, index * 4 + 4)).toEqual(array.slice(id * 4, id * 4 + 4)));
      for (const band of bands) if (source.extra[band])
        expect(splats.extra[band]!.slice(index * 4, index * 4 + 4)).toEqual(source.extra[band]!.slice(id * 4, id * 4 + 4));
    });
    splats.extArrays[0][0] = 42;
    expect(source.extArrays).toEqual(before);
    source.dispose();
    splats.dispose();
  });

  it("copies hierarchy and animation and projects authored edits and exact posed skinning", async () => {
    const { document, shape, original } = sceneFixture();
    const previous = JSON.stringify(document);
    const source = sourceSplats(3);
    const data = await encodeSplatExtraction(source, identity, chosen, signal());
    const next = addSplatExtraction(document, identity, chosen, data.byteLength);
    const duplicate = next.shape, duplicateOwner = next.document.nodes[next.id] as TransformNode;
    expect(validateScene(next.document)).toBe(next.document);
    expect(next.document.nodes[shape.id]).toBe(shape);
    expect(JSON.stringify(document)).toBe(previous);
    expect(next.document.rootIds).toEqual(["group"]);
    expect(duplicateOwner).toEqual({ ...original, id: next.id, name: "Original_selection" });
    expect(duplicate.offset).toEqual(shape.offset);
    expect(duplicate.componentEdits).toBeUndefined();
    expect(duplicate.componentTransforms?.records).toEqual([{ ...shape.componentTransforms!.records[0], index: 0 }]);
    expect(duplicate.binding?.weights).toEqual({ count: 2, overrides: { 0: shape.binding!.weights!.overrides[1] } });
    expect(duplicate.attributePaint?.records).toEqual([[0, .3, 0, .1, .5, .2, .4]]);
    expect(duplicate.selectionSets?.[0].members).toEqual([0, 1]);
    expect(duplicate.scalarMasks?.[0].componentLocks).toEqual([1, 2]);
    expect(duplicate.scalarMasks?.[0].locked).toBe(true);
    expect(chosen.map((_, i) => Math.round(maskValue(duplicate.scalarMasks![0], i) * 10))).toEqual(Uint32Array.of(3, 9));
    expect(duplicate.appearance?.layers[0].maskId).toBe(duplicate.scalarMasks?.[0].id);

    const originalMesh = new SplatMesh({ extSplats: source, covSplats: true });
    const duplicateMesh = new SplatMesh({ extSplats: decodeSplatExtraction(data).splats, covSplats: true });
    await Promise.all([originalMesh.initialized, duplicateMesh.initialized]);
    const a = createSplatTransformRuntime(originalMesh), b = createSplatTransformRuntime(duplicateMesh);
    a.update(shape.componentTransforms);
    b.update(duplicate.componentTransforms);
    const originalSkin = createBinding(originalMesh, shape.binding!, undefined, document.joints, a);
    const duplicateSkin = createBinding(duplicateMesh, duplicate.binding!, undefined, document.joints, b);
    for (const frame of [0, 7.5, 16, 24]) {
      const originalPose = evaluateChannels(document, original.id, frame);
      const duplicatePose = evaluateChannels(next.document, next.id, frame);
      expect(duplicatePose).toEqual(originalPose);
      const skinMatrix = (joint: string) => joint === "one" ? new Matrix4().makeTranslation(2, 1, .2)
        : new Matrix4().makeRotationZ(evaluateChannels(document, joint, frame).rotation[2] * Math.PI / 180);
      for (const [mesh, owner, pose] of [[originalMesh, original, originalPose], [duplicateMesh, duplicateOwner, duplicatePose]] as const) {
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(objectLocalMatrix(owner, pose)).multiply(new Matrix4().makeTranslation(...shape.offset));
        mesh.updateMatrixWorld(true);
      }
      originalSkin.update(skinMatrix);
      duplicateSkin.update(skinMatrix);
      expect(duplicateSkin.getComponentPositions([0, 1])).toEqual(originalSkin.getComponentPositions([1, 3]));
      expect(duplicateSkin.getSkinMatrix(0).elements).toEqual(originalSkin.getSkinMatrix(1).elements);
      expect(duplicateSkin.getSkinMatrix(1).elements).toEqual(originalSkin.getSkinMatrix(3).elements);
    }
    originalSkin.dispose();
    duplicateSkin.dispose();
    a.dispose();
    b.dispose();
    originalMesh.dispose();
    duplicateMesh.dispose();
  });

  it("undoes the scene and asset together, redoes the same identity, and round trips both bytes and binding", async () => {
    const { document } = sceneFixture();
    const source = sourceSplats(3), store = createSceneStore(document);
    const buffer = await encodeSplatExtraction(source, identity, chosen, signal());
    const added = addSplatExtraction(document, identity, chosen, buffer.byteLength);
    store.setState({ document: added.document, editLabel: "Duplicate Selected Splats" });
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(document);
    expect(store.getState().document.assets[added.assetId]).toBeUndefined();
    store.temporal.getState().redo();
    expect(store.getState().document).toBe(added.document);
    const originalBytes = Uint8Array.of(112, 108, 121, 10);
    const files = new Map([
      [identity.assetId, new File([originalBytes], "source.ply")],
      [added.assetId, new File([buffer], SPLAT_EXTRACTION_NAME)],
    ]);
    const { scene, files: reopened } = await decodeProject(await encodeProject(added.document, files, editor));
    expect(scene.nodes[added.shape.id]).toEqual(JSON.parse(JSON.stringify(added.shape)));
    expect(new Uint8Array(await reopened.get(identity.assetId)!.arrayBuffer())).toEqual(originalBytes);
    const extractedBytes = await reopened.get(added.assetId)!.arrayBuffer();
    expect(new Uint8Array(extractedBytes)).toEqual(new Uint8Array(buffer));
    const decoded = decodeSplatExtraction(extractedBytes);
    expect(decoded.originalIds).toEqual(chosen);
    decoded.splats.dispose();
    source.dispose();
  });

  it("rejects inactive/elastic/stale sources, bad maps, canceled work, and limits", async () => {
    const { document, shape } = sceneFixture();
    expect(() => splatExtractionSource(document, identity, Uint32Array.of(0))).toThrow(/hidden or deleted/);
    expect(() => splatExtractionSource(document, { ...identity, assetId: "stale" }, chosen)).toThrow(/loaded splat/);
    shape.elasticity = { stretch: 1, spacing: 2, expansion: 0, budget: 0, joints: null };
    expect(() => splatExtractionSource(document, identity, chosen)).toThrow(/elasticity/i);
    const source = sourceSplats(0);
    expect(() => splatExtractionFileSize(source, identity, SPLAT_EXTRACTION_LIMIT + 1)).toThrow(/100,000/);
    await expect(encodeSplatExtraction(source, identity, Uint32Array.of(3, 1), signal())).rejects.toThrow(/ordered original/);
    const controller = new AbortController();
    const task = encodeSplatExtraction(source, identity, chosen, controller.signal);
    controller.abort();
    await expect(task).rejects.toThrow();
    const mutable = Uint32Array.of(1, 3);
    const copying = encodeSplatExtraction(source, identity, mutable, signal());
    mutable[1] = 0;
    const bytes = await copying;
    const decoded = decodeSplatExtraction(bytes);
    expect(decoded.originalIds).toEqual(chosen);
    decoded.splats.dispose();
    expect(() => decodeSplatExtraction(bytes.slice(0, -1))).toThrow(/header or size/);
    new DataView(bytes).setUint32(20 + "original-assetoriginal-shape".length, 99, true);
    expect(() => decodeSplatExtraction(bytes)).toThrow(/original ID map/);
    const tiny = { name: SPLAT_EXTRACTION_NAME, size: 64 };
    expect(() => assertSplatExtractionBudget(Array(62).fill(tiny), 64)).not.toThrow();
    expect(() => assertSplatExtractionBudget(Array(63).fill(tiny), 64)).toThrow(/64 MiB/);
    source.dispose();
  });
});
