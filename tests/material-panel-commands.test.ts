import { ClampToEdgeWrapping, DoubleSide, LinearFilter, MirroredRepeatWrapping, NearestFilter, NoColorSpace } from "three";
import { expect, it } from "vitest";
import { commitMeshMaterialTexture, createMaterials, disposeMaterials, meshMaterialSlots, setMeshMaterialTexture } from "../src/mesh-materials.ts";
import { createMeshPrimitive } from "../src/mesh-modeling.ts";
import { createMeshRenderable } from "../src/mesh-renderer.ts";
import { decodeProject, encodeProject, validateScene, type EditorSnapshot } from "../src/project-archive.ts";
import type { MeshShapeNode, SceneDocument } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { addTexture, prepareTexture, textureBytes, textureReferences } from "../src/texture-assets.ts";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const editor: EditorSnapshot = { camera: { position: [2, 4, 2], target: [0, 0, 0], fov: 45, near: .01, far: 1000 }, time: 0 };
function mesh(doc: SceneDocument) {
  return Object.values(doc.nodes).find((node): node is MeshShapeNode => node.type === "meshShape")!;
}
async function fixture(kind: "plane" | "cube" = "plane") {
  const asset = await prepareTexture(new File([textureBytes(png)], "Original.png"), "color", async () => ({ alpha: true, thumbnail: png }));
  const store = createSceneStore();
  createMeshPrimitive(store, kind, { color: "#ffffff" });
  const before = addTexture(store.getState().document, asset), shape = mesh(before);
  return { store: createSceneStore(before), before, asset, shape, target: { shapeId: shape.id, index: 0, slot: "map" as const } };
}

it("authors planar UV0 and a shared image binding atomically, with current MSB and exact undo/redo", async () => {
  const { store, before, asset, shape, target } = await fixture();
  expect(shape.uvs).toBeUndefined();
  expect(commitMeshMaterialTexture(store, target, { assetId: asset.id })).toBe(true);
  const assigned = store.getState().document, authored = mesh(assigned);
  expect(authored.vertices).toBe(shape.vertices);
  expect(authored.faces).toBe(shape.faces);
  expect(new Set(Object.values(authored.uvs!).map(pair => pair.join(",")))).toEqual(new Set(["0,0", "0,1", "1,0", "1,1"]));
  expect(authored.materials![0].map).toMatchObject({ assetId: asset.id, colorSpace: "srgb", channel: 0, useImageAlpha: true, wrapS: ClampToEdgeWrapping });
  expect(assigned.textureAssets).toBe(before.textureAssets);
  expect(textureReferences(assigned, asset.id)).toEqual([{ shapeId: shape.id, material: 0, slot: "map" }]);
  expect(commitMeshMaterialTexture(store, target, { assetId: asset.id })).toBe(false);
  expect(store.temporal.getState().pastStates).toHaveLength(1);
  store.temporal.getState().undo();
  expect(store.getState().document).toBe(before);
  store.temporal.getState().redo();
  expect(store.getState().document).toBe(assigned);
  const bytes = await encodeProject(assigned, new Map(), editor);
  expect((await decodeProject(bytes)).scene).toEqual(assigned);
  expect(() => validateScene({ ...assigned, textureAssets: {} })).toThrow(/Missing material texture asset/);
  expect(commitMeshMaterialTexture(store, target, { assetId: null })).toBe(true);
  expect(mesh(store.getState().document).materials![0].map).toBeUndefined();
  expect(textureReferences(store.getState().document, asset.id)).toEqual([]);
  expect(store.getState().document.textureAssets![asset.id]).toBe(asset);
});

it("rejects invalid assignment or mapping without a document or history change", async () => {
  const { before, store, asset, target } = await fixture("cube");
  expect(() => commitMeshMaterialTexture(store, target, { assetId: "missing" })).toThrow(/texture asset is missing/);
  expect(() => commitMeshMaterialTexture(store, target, { assetId: asset.id })).toThrow(/UV set 0 is missing/);
  expect(store.getState().document).toBe(before);
  expect(store.temporal.getState().pastStates).toHaveLength(0);
  const plane = await fixture();
  const normal = { ...plane.target, slot: "normalMap" as const };
  commitMeshMaterialTexture(plane.store, normal, { assetId: plane.asset.id });
  const assigned = plane.store.getState().document;
  expect(mesh(assigned).materials![0].normalMap?.colorSpace).toBe("raw");
  expect(() => commitMeshMaterialTexture(plane.store, normal, { settings: { colorSpace: "srgb" } })).toThrow(/Invalid mesh texture/);
  expect(() => commitMeshMaterialTexture(plane.store, normal, { settings: { repeat: [Infinity, 1] } })).toThrow(/Invalid mesh texture/);
  expect(() => commitMeshMaterialTexture(plane.store, normal, { settings: { channel: 3 } })).toThrow(/UV set 3 is missing/);
  expect(plane.store.getState().document).toBe(assigned);
  expect(plane.store.temporal.getState().pastStates).toHaveLength(1);
});

it("preserves imported UVs, group mapping, unaffected slots and GPU buffers through preview and commit", async () => {
  const { before, shape, target, asset } = await fixture();
  const assigned = setMeshMaterialTexture(before, target, { assetId: asset.id }), seeded = mesh(assigned);
  const [first] = meshMaterialSlots(seeded);
  const imported: MeshShapeNode = {
    ...seeded,
    faces: seeded.faces.map(face => ({ ...face, materialIndex: 1 })),
    materials: [{ ...first, name: "Lining" }, { ...first, name: "Shell" }],
  };
  const doc = { ...assigned, nodes: { ...assigned.nodes, [shape.id]: imported } };
  const renderer = createMeshRenderable(imported, doc.textureAssets);
  const geometry = renderer.mesh.geometry, slots = renderer.mesh.material as unknown as ReturnType<typeof createMaterials>;
  const firstGPU = slots[0], secondGPU = slots[1];
  const source = imported.materials![1].map!;
  expect(geometry.groups.map(group => group.materialIndex)).toEqual([1]);
  const preview = renderer.previewTexture(1, "map", "repeatU")!;
  preview.update(3.5);
  expect(secondGPU.map!.repeat.x).toBe(3.5);
  expect(firstGPU.map!.repeat.x).toBe(1);
  expect(source.repeat[0]).toBe(1);
  preview.end();
  expect(secondGPU.map!.repeat.x).toBe(1);
  const next = setMeshMaterialTexture(doc, { ...target, index: 1 }, { settings: { repeat: [3.5, 1], wrapS: MirroredRepeatWrapping, filter: "nearest", colorSpace: "raw" } });
  const updated = mesh(next);
  expect(updated.uvs).toBe(imported.uvs);
  expect(updated.faces).toBe(imported.faces);
  expect(updated.materials![0]).toBe(imported.materials![0]);
  renderer.update(updated, next.textureAssets);
  expect(renderer.mesh.geometry).toBe(geometry);
  const updatedGPU = renderer.mesh.material as unknown as typeof slots;
  expect(updatedGPU[0]).toBe(firstGPU);
  expect(updatedGPU[1].map).toMatchObject({ colorSpace: NoColorSpace, magFilter: NearestFilter, minFilter: NearestFilter, generateMipmaps: false, wrapS: MirroredRepeatWrapping });
  expect(updatedGPU[1].map!.repeat.x).toBe(3.5);
  renderer.dispose();
});

it("uses base image alpha or opacity data for inferred blending and restores original depth behavior when cleared", async () => {
  const { before, target, asset } = await fixture();
  const assigned = setMeshMaterialTexture(before, { ...target, slot: "alphaMap" }, { assetId: asset.id });
  const [alpha] = createMaterials(mesh(assigned).materials!, false, false, before.textureAssets);
  expect(alpha).toMatchObject({ transparent: true, depthWrite: false, side: DoubleSide });
  expect(alpha.alphaMap!.colorSpace).toBe(NoColorSpace);
  const cleared = setMeshMaterialTexture(assigned, { ...target, slot: "alphaMap" }, { assetId: null });
  const [plain] = createMaterials(mesh(cleared).materials!, false, false, before.textureAssets);
  expect(plain).toMatchObject({ transparent: false, depthWrite: true });
  const normal = setMeshMaterialTexture(before, { ...target, slot: "normalMap" }, { assetId: asset.id });
  const linear = setMeshMaterialTexture(normal, { ...target, slot: "normalMap" }, { settings: { filter: "linear" } });
  const [mapped] = createMaterials(mesh(linear).materials!, false, false, before.textureAssets);
  expect(mapped.normalMap).toMatchObject({ colorSpace: NoColorSpace, magFilter: LinearFilter, minFilter: LinearFilter, generateMipmaps: false });
  disposeMaterials([alpha, plain, mapped]);
});
