import { describe, expect, it, vi } from "vitest";
import { Group, LineSegments, Mesh, MeshStandardMaterial, Points } from "three";
import { captureMaterials } from "../src/mesh-materials.ts";
import { prepareMeshBevel } from "../src/mesh-bevel.ts";
import { createMeshComponentPreview } from "../src/mesh-component-preview.ts";
import { createMeshRenderable } from "../src/mesh-renderer.ts";
import { createMeshPrimitive, extrudeMeshFaces, findMeshShape, meshEdges, setMeshVertexPositions, updateMeshAppearance } from "../src/mesh-modeling.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture() {
  const store = createSceneStore(), id = createMeshPrimitive(store, "cube", { size: 2 });
  const shape = findMeshShape(store.getState().document, id)!;
  return { store, id, shape, renderer: createMeshRenderable(shape) };
}

describe("imported mesh material batches", () => {
  it("retains UV coordinates and batches adjacent triangles into material groups", () => {
    const { shape, renderer } = fixture();
    const materials = captureMaterials([new MeshStandardMaterial({ color: "#ff0000" }), new MeshStandardMaterial({ color: "#0000ff" })]);
    const uvs = Object.fromEntries(shape.vertices.map((v, i) => [v.id, [i / 8, i / 16] as [number, number]]));
    const next = { ...shape, materials, uvs, faces: shape.faces.map((f, i) => ({ ...f, materialIndex: i < 3 ? 0 : 1 })) };
    renderer.update(next);
    expect(Array.isArray(renderer.mesh.material)).toBe(true);
    expect(renderer.mesh.geometry.groups).toEqual([{ start: 0, count: 18, materialIndex: 0 }, { start: 18, count: 18, materialIndex: 1 }]);
    expect(Array.from(renderer.mesh.geometry.getAttribute("uv").array)).toEqual(shape.vertices.flatMap(v => uvs[v.id]));
    expect(renderer.triangleFaceIds).toHaveLength(12);
    expect(renderer.triangleFaceIds.slice(0, 2)).toEqual([shape.faces[0].id, shape.faces[0].id]);
    renderer.update({ ...next, uvSets: { "1": uvs, "2": uvs, "3": uvs } });
    for (const channel of [1, 2, 3]) expect(Array.from(renderer.mesh.geometry.getAttribute(`uv${channel}`).array)).toEqual(shape.vertices.flatMap(v => uvs[v.id]));
    renderer.dispose();
  });
  it("uses a single material draw for single-material imported meshes and updates back to defaults", () => {
    const { shape, renderer } = fixture();
    const materials = captureMaterials([new MeshStandardMaterial({ color: "#ff0000" })]);
    const next = { ...shape, materials, faces: shape.faces.map(f => ({ ...f, materialIndex: 0 })) };
    renderer.update(next);
    expect(Array.isArray(renderer.mesh.material)).toBe(false);
    expect(renderer.mesh.geometry.groups).toEqual([]);
    expect(renderer.mesh.material.color.getHexString()).toBe("ff0000");
    const dispose = vi.spyOn(renderer.mesh.material, "dispose");
    renderer.update(shape); expect(dispose).toHaveBeenCalledTimes(1);
    expect(renderer.mesh.material.color.getHexString()).toBe(shape.color.slice(1));
    renderer.dispose();
  });
});

describe("polygon mesh rendering", () => {
  it("restores exact buffers after repeated replacement-topology previews and releases transient resources", () => {
    const { shape, renderer } = fixture();
    const { mesh, centers, triangleFaceIds } = renderer;
    const edges = mesh.children[0] as LineSegments;
    const source = mesh.geometry, sourceEdges = edges.geometry, baselineBounds = renderer.bounds.clone();
    const prepared = prepareMeshBevel(shape, [meshEdges(shape)[0].id]);
    const first = prepared.evaluate({ width: 0.25, segments: 1 }).shape;
    const second = prepared.evaluate({ width: 0.4, segments: 3 }).shape;
    renderer.previewTopology(first);
    expect(mesh.geometry).not.toBe(source);
    expect(renderer.triangleFaceIds.length).toBeGreaterThan(triangleFaceIds.length);
    const disposeFirst = vi.spyOn(mesh.geometry, "dispose");
    const disposeFirstEdges = vi.spyOn(edges.geometry, "dispose");
    const invalid = { ...first, faces: [{ ...first.faces[0], vertices: ["missing", "other", "bad"] }] };
    expect(() => renderer.previewTopology(invalid)).toThrow(/existing vertex/);
    expect(disposeFirst).not.toHaveBeenCalled();
    renderer.previewTopology(second);
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(disposeFirstEdges).toHaveBeenCalledTimes(1);
    const disposeSecond = vi.spyOn(mesh.geometry, "dispose");
    renderer.clearPreview();
    expect(disposeSecond).toHaveBeenCalledTimes(1);
    expect(mesh.geometry).toBe(source);
    expect(edges.geometry).toBe(sourceEdges);
    expect(renderer.centers).toBe(centers);
    expect(renderer.triangleFaceIds).toBe(triangleFaceIds);
    expect(renderer.bounds.equals(baselineBounds)).toBe(true);
    renderer.previewTopology(first);
    const disposeLast = vi.spyOn(mesh.geometry, "dispose");
    const disposeSource = vi.spyOn(source, "dispose");
    renderer.dispose();
    expect(disposeLast).toHaveBeenCalledTimes(1);
    expect(disposeSource).toHaveBeenCalledTimes(1);
  });

  it("keeps mesh, material and buffers stable through appearance-only commands", () => {
    const { store, shape, renderer } = fixture();
    const { mesh, bounds, centers, triangleFaceIds } = renderer;
    const geometry = mesh.geometry, material = mesh.material, edges = mesh.children[0] as LineSegments, edgeGeometry = edges.geometry;
    const oldVersion = material.version;
    updateMeshAppearance(store, shape.id, { color: "#ff8800", shading: "smooth", wireframe: true });
    renderer.update({ ...findMeshShape(store.getState().document, shape.id)!, name: "Renamed mesh" });
    expect(renderer.mesh).toBe(mesh); expect(renderer.bounds).toBe(bounds);
    expect(renderer.centers).toBe(centers); expect(renderer.triangleFaceIds).toBe(triangleFaceIds);
    expect(mesh.geometry).toBe(geometry); expect(mesh.material).toBe(material); expect(edges.geometry).toBe(edgeGeometry);
    expect(material.color.getHexString()).toBe("ff8800"); expect(material.flatShading).toBe(false);
    expect(material.version).toBeGreaterThan(oldVersion); expect(edges.visible).toBe(true); expect(mesh.name).toBe("Renamed mesh");
    renderer.dispose();
  });

  it("replaces edited geometry and face mapping while disposing superseded buffers", () => {
    const { store, shape, renderer } = fixture();
    const { mesh, bounds } = renderer, edges = mesh.children[0] as LineSegments;
    const geometry = mesh.geometry, edgeGeometry = edges.geometry;
    const oldMeshDisposed = vi.spyOn(geometry, "dispose"), oldEdgesDisposed = vi.spyOn(edgeGeometry, "dispose");
    const vertex = shape.vertices[0];
    setMeshVertexPositions(store, shape.id, [{ id: vertex.id, position: [1.2, 1, 1] }]);
    const edited = findMeshShape(store.getState().document, shape.id)!;
    renderer.update(edited);
    expect(renderer.mesh).toBe(mesh); expect(renderer.bounds).toBe(bounds);
    expect(mesh.geometry).not.toBe(geometry); expect(edges.geometry).not.toBe(edgeGeometry);
    expect(oldMeshDisposed).toHaveBeenCalledTimes(1); expect(oldEdgesDisposed).toHaveBeenCalledTimes(1);
    expect(bounds.max.x).toBeCloseTo(1.2); expect(mesh.geometry.boundingSphere!.radius).toBeGreaterThan(1);
    const topIds = extrudeMeshFaces(store, shape.id, [edited.faces[0].id], 0.3);
    renderer.update(findMeshShape(store.getState().document, shape.id)!);
    expect(renderer.triangleFaceIds).not.toContain(edited.faces[0].id);
    for (const id of topIds) expect(renderer.triangleFaceIds.filter(face => face === id)).toHaveLength(2);
    expect(mesh.geometry.getIndex()!.count).toBe(renderer.triangleFaceIds.length * 3);
    renderer.dispose();
  });

  it("rejects invalid replacements without disposing or changing the visible mesh", () => {
    const { shape, renderer } = fixture();
    const { mesh, centers, triangleFaceIds } = renderer, geometry = mesh.geometry;
    const disposed = vi.spyOn(geometry, "dispose"), beforeBounds = renderer.bounds.clone();
    const invalid = { ...shape, color: "#ff0000", faces: [{ ...shape.faces[0], vertices: ["missing", ...shape.faces[0].vertices.slice(1)] }] };
    expect(() => renderer.update(invalid)).toThrow(/existing vertex/);
    expect(mesh.geometry).toBe(geometry); expect(renderer.centers).toBe(centers); expect(renderer.triangleFaceIds).toBe(triangleFaceIds);
    expect(renderer.bounds.equals(beforeBounds)).toBe(true); expect(mesh.material.color.getHexString()).toBe(shape.color.slice(1));
    expect(disposed).not.toHaveBeenCalled(); renderer.dispose();
  });

  it("releases current surface and edge resources once and detaches from its parent", () => {
    const { shape, renderer } = fixture(), parent = new Group(); parent.add(renderer.mesh);
    const edges = renderer.mesh.children[0] as LineSegments;
    const resources = [renderer.mesh.geometry, renderer.mesh.material, edges.geometry, edges.material as Exclude<typeof edges.material, unknown[]>];
    const dispose = resources.map(resource => vi.spyOn(resource, "dispose"));
    renderer.dispose(); renderer.dispose();
    for (const spy of dispose) expect(spy).toHaveBeenCalledTimes(1);
    expect(renderer.mesh.parent).toBeNull(); expect(() => renderer.update(shape)).toThrow(/disposed/);
  });
});

describe("temporary mesh component overlays", () => {
  it("keeps authored local positions, follows the mesh transform and replaces only changed selection buffers", () => {
    const { store, shape, renderer } = fixture(), preview = createMeshComponentPreview();
    const document = store.getState().document, before = JSON.stringify(document);
    renderer.mesh.position.set(10, 20, 30); renderer.mesh.rotation.z = Math.PI / 2;
    const selectedIds = [shape.vertices[0].id, shape.vertices[5].id];
    preview.update(shape, renderer.mesh, renderer.triangleFaceIds, "vertex", selectedIds);
    const group = renderer.mesh.children.find(child => child.name === "Mesh component selection") as Group;
    const points = group.children.find(child => child instanceof Points && child.renderOrder === 100005) as Points;
    const allPoints = group.children.find(child => child instanceof Points && child.renderOrder === 100004) as Points;
    const oldSelected = points.geometry, oldAll = allPoints.geometry;
    expect(group.parent).toBe(renderer.mesh); expect(group.position.toArray()).toEqual([0, 0, 0]);
    expect(Array.from(points.geometry.getAttribute("position").array)).toEqual([shape.vertices[0].position, shape.vertices[5].position].flat());
    preview.update(shape, renderer.mesh, renderer.triangleFaceIds, "vertex", [...selectedIds]);
    expect(points.geometry).toBe(oldSelected); expect(allPoints.geometry).toBe(oldAll);
    const dispose = vi.spyOn(oldSelected, "dispose");
    preview.update(shape, renderer.mesh, renderer.triangleFaceIds, "vertex", [shape.vertices[1].id]);
    expect(dispose).toHaveBeenCalledTimes(1); expect(allPoints.geometry).toBe(oldAll);
    expect(store.getState().document).toBe(document); expect(JSON.stringify(document)).toBe(before);
    preview.dispose(); renderer.dispose();
  });

  it("maps selected polygons to overlay triangles and cleans resources after clear and reuse", () => {
    const { shape, renderer } = fixture(), preview = createMeshComponentPreview();
    preview.update(shape, renderer.mesh, renderer.triangleFaceIds, "face", [shape.faces[0].id]);
    const group = renderer.mesh.children.find(child => child.name === "Mesh component selection") as Group;
    const faceOverlay = group.children.find(child => child instanceof Mesh) as Mesh;
    expect(faceOverlay.geometry.getAttribute("position").count).toBe(6);
    expect(faceOverlay.visible).toBe(true);
    preview.setVisible(false); expect(group.visible).toBe(false);
    preview.clear(); expect(group.parent).toBeNull();
    preview.setVisible(true);
    preview.update(shape, renderer.mesh, renderer.triangleFaceIds, "edge", [JSON.stringify([...shape.faces[0].vertices.slice(0, 2)].sort())]);
    expect(group.parent).toBe(renderer.mesh); expect(faceOverlay.visible).toBe(false);
    const selectedLines = group.children.find(child => child instanceof LineSegments && child.renderOrder === 100005) as LineSegments;
    expect(selectedLines.geometry.getAttribute("position").count).toBe(2);
    const disposals = group.children.flatMap(child => {
      const object = child as Points;
      return [vi.spyOn(object.geometry, "dispose"), vi.spyOn(object.material, "dispose")];
    });
    preview.dispose();
    expect(group.parent).toBeNull(); for (const spy of disposals) expect(spy).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });
});
