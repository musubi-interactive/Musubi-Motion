import { describe, expect, it } from "vitest";
import { MeshStandardMaterial, Vector3 } from "three";
import { commitMeshBevel, prepareMeshBevel } from "../src/mesh-bevel.ts";
import { captureMaterials } from "../src/mesh-materials.ts";
import { createMeshPrimitive, findMeshShape, meshEdges, setMeshVertexPositions, triangulateMesh, validateMeshShape } from "../src/mesh-modeling.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import type { MeshShapeNode, Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function cube() {
  const store = createSceneStore();
  const id = createMeshPrimitive(store, "cube", { size: 2 });
  const shape = findMeshShape(store.getState().document, id)!;
  return { store, shape, edges: meshEdges(shape) };
}

function verifyClosed(shape: MeshShapeNode, winding = 1) {
  validateMeshShape(shape);
  const edges = meshEdges(shape);
  expect(edges.every(edge => edge.faceIds.length === 2)).toBe(true);
  expect(shape.vertices.length - edges.length + shape.faces.length).toBe(2);
  const triangulation = triangulateMesh(shape);
  const positions = shape.vertices.map(vertex => new Vector3(...vertex.position));
  for (let index = 0; index < triangulation.indices.length; index += 3) {
    const [a, b, c] = triangulation.indices.slice(index, index + 3).map(vertex => positions[vertex]);
    const normal = b.clone().sub(a).cross(c.clone().sub(a));
    expect(normal.dot(a) * winding).toBeGreaterThan(0);
  }
}

describe("selected edge bevel", () => {
  it("chamfers one cube edge, retaining original face IDs and deterministic material/edge mappings", () => {
    const { shape, edges } = cube();
    const sourceMaterials = [new MeshStandardMaterial({ color: "#e67d3b" }), new MeshStandardMaterial({ color: "#4c8aab" })];
    const materials = captureMaterials(sourceMaterials);
    sourceMaterials.forEach(material => material.dispose());
    const original = { ...shape, materials, faces: shape.faces.map((face, index) => ({ ...face, materialIndex: index % 2 })) };
    const snapshot = structuredClone(original);
    const edge = edges[0];
    const { shape: result, edgeMap, bandFaces } = prepareMeshBevel(original, [edge.id]).evaluate({ width: 0.5, segments: 1 });
    expect(original).toEqual(snapshot);
    expect(result.faces).toHaveLength(7);
    expect(result.vertices).toHaveLength(10);
    expect(result.materials).toBe(original.materials);
    expect(result.faces.slice(0, 6).map(face => [face.id, face.materialIndex])).toEqual(original.faces.map(face => [face.id, face.materialIndex]));
    const band = result.faces.find(face => face.id === bandFaces.get(edge.id)![0]);
    expect(band?.materialIndex).toBe(original.faces.find(face => face.id === edge.faceIds[0])!.materialIndex);
    expect(edgeMap.get(edge.id)).toHaveLength(2);
    expect(edgeMap.size).toBe(edges.length);
    for (const ids of edgeMap.values()) for (const id of ids) expect(meshEdges(result).some(candidate => candidate.id === id)).toBe(true);
    verifyClosed(result);
  });

  it("joins three adjacent rounded bevels and accepts disconnected edge picks in either order", () => {
    const { shape, edges } = cube();
    const corner = edges.filter(edge => edge.vertices.includes(shape.vertices[0].id));
    const disjoint = edges.find(edge => edge.vertices.every(id => !corner[0].vertices.includes(id)))!;
    for (const group of [corner, [corner[0], disjoint], edges]) {
      const ids = group.map(edge => edge.id);
      const options = { width: 0.25, segments: 3 };
      const first = prepareMeshBevel(shape, ids).evaluate(options);
      const reversed = prepareMeshBevel(shape, [...ids].reverse()).evaluate(options);
      expect(first).toEqual(reversed);
      expect(first.shape.faces).toHaveLength(shape.faces.length + ids.length * options.segments);
      for (const id of ids) {
        expect(first.bandFaces.get(id)).toHaveLength(options.segments);
        expect(first.edgeMap.get(id)).toHaveLength(options.segments + 1);
      }
      verifyClosed(first.shape);
    }
  });

  it("keeps reversed source winding and does not touch an unrelated open shell", () => {
    const { shape, edges } = cube();
    const reversed = { ...shape, faces: shape.faces.map(face => ({ ...face, vertices: [...face.vertices].reverse() })) };
    const result = prepareMeshBevel(reversed, [edges[0].id]).evaluate({ width: 0.3, segments: 2 });
    verifyClosed(result.shape, -1);

    const triangle = { id: "open", vertices: ["open_a", "open_b", "open_c"] };
    const detached = { ...shape, faces: [...shape.faces, triangle], vertices: [
      ...shape.vertices,
      { id: "open_a", position: [2, 0, 0] as Vec3 },
      { id: "open_b", position: [3, 0, 0] as Vec3 },
      { id: "open_c", position: [2, 1, 0] as Vec3 },
    ] };
    const openResult = prepareMeshBevel(detached, [edges[0].id]).evaluate({ width: 0.3, segments: 2 });
    expect(openResult.shape.faces.find(face => face.id === triangle.id)).toBe(triangle);
    expect(openResult.shape.vertices.filter(vertex => vertex.id.startsWith("open_"))).toEqual(detached.vertices.slice(-3));
  });

  it("rejects a width within the numeric range when the cut would consume a face", () => {
    const { shape } = cube();
    const narrow: MeshShapeNode = {
      ...shape,
      vertices: ([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0.8, 0.1, 0.04]] as Vec3[]).map((position, index) => ({ id: `v${index}`, position })),
      faces: [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]].map((vertices, index) => ({ id: `f${index}`, vertices: vertices.map(id => `v${id}`) })),
    };
    const source = structuredClone(narrow);
    const prepared = prepareMeshBevel(narrow, [JSON.stringify(["v1", "v2"])]);
    const small = { width: 0.05, segments: 1 };
    const first = prepared.evaluate(small);
    expect(() => prepared.evaluate({ width: 1, segments: 1 })).toThrow(/removes a face/);
    expect(prepared.evaluate(small)).toEqual(first);
    expect(narrow).toEqual(source);
  });

  it("maps a clipped neighbor to its own segment when two faces share collinear edges", () => {
    const { shape, edges } = cube(), edge = edges[0];
    const [a, b] = edge.vertices.map(id => shape.vertices.find(vertex => vertex.id === id)!);
    const midpoint = { id: "midpoint", position: a.position.map((value, axis) => (value + b.position[axis]) / 2) as Vec3 };
    const split = { ...shape, vertices: [...shape.vertices, midpoint], faces: shape.faces.map(face => ({
      ...face, vertices: face.vertices.flatMap((id, index) => edge.vertices.includes(id) && edge.vertices.includes(face.vertices[(index + 1) % face.vertices.length])
        ? [id, midpoint.id] : [id]),
    })) };
    const splitEdges = meshEdges(split);
    const clipped = splitEdges.find(candidate => candidate.vertices.includes(midpoint.id) && candidate.vertices.includes(a.id))!;
    const intact = splitEdges.find(candidate => candidate.vertices.includes(midpoint.id) && candidate.vertices.includes(b.id))!;
    const pick = splitEdges.find(candidate => candidate.vertices.includes(a.id) && !candidate.vertices.includes(midpoint.id))!;
    expect(() => prepareMeshBevel(split, [clipped.id])).toThrow(/unsplit/);
    const result = prepareMeshBevel(split, [pick.id]).evaluate({ width: 0.8, segments: 2 });
    expect(result.edgeMap.get(clipped.id)).toHaveLength(1);
    expect(result.edgeMap.get(clipped.id)).not.toContain(intact.id);
    expect(result.edgeMap.get(intact.id)).toEqual([intact.id]);
    verifyClosed(result.shape);
  });

  it("adds no history for previews, zero width or rejected values, then commits once and reopens exactly", async () => {
    const { store, shape, edges } = cube();
    const baseline = store.getState().document;
    const history = store.temporal.getState().pastStates.length;
    const prepared = prepareMeshBevel(shape, [edges[0].id]);
    const zero = prepared.evaluate({ width: 0, segments: 2 });
    expect(zero.shape).toBe(shape);
    commitMeshBevel(store, shape, zero);
    for (const width of [-0.2, 1.1, Infinity, NaN, 1e-10]) {
      expect(() => prepared.evaluate({ width, segments: 2 })).toThrow(/Width/);
    }
    for (const segments of [0, 2.5, 9, Infinity]) {
      expect(() => prepared.evaluate({ width: 0.2, segments })).toThrow(/Segments/);
    }
    const result = prepared.evaluate({ width: 0.3, segments: 8 });
    expect(result.shape.faces).toHaveLength(14);
    expect(store.getState().document).toBe(baseline);
    expect(store.temporal.getState().pastStates).toHaveLength(history);
    commitMeshBevel(store, shape, result);
    const committed = store.getState().document;
    expect(store.temporal.getState().pastStates).toHaveLength(history + 1);
    expect(store.getState().editLabel).toBe("Bevel edges");
    expect(committed.nodes[shape.id]).toEqual(result.shape);
    expect(() => commitMeshBevel(store, shape, result)).toThrow(/changed during Bevel/);
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(baseline);
    store.temporal.getState().redo();
    expect(store.getState().document).toBe(committed);
    const opened = await decodeProject(await encodeProject(committed, new Map(), {
      camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: 0.01, far: 1000 }, time: 0,
    }));
    expect(opened.scene.nodes[shape.id]).toEqual(result.shape);
  });

  it("rejects boundary, nonmanifold, skin, attributed, concave, and stale topology without mutation", () => {
    const { store, shape, edges } = cube(), source = store.getState().document;
    const edge = edges[0];
    const boundary = { ...shape, faces: shape.faces.filter(face => face.id !== edge.faceIds[0]) };
    const stillInside = meshEdges(boundary).find(edge => edge.faceIds.length === 2)!;
    const invalid = { ...shape, faces: [...shape.faces, { ...shape.faces[0], id: "extra_face" }] };
    const concave = { ...shape, vertices: shape.vertices.map((vertex, index) => index === 0
      ? { ...vertex, position: [0, 0, 0] as Vec3 } : vertex) };
    const uvs = Object.fromEntries(shape.vertices.map(vertex => [vertex.id, [0, 0] as [number, number]]));
    expect(() => prepareMeshBevel(boundary, [edge.id])).toThrow(/boundary/i);
    expect(() => prepareMeshBevel(boundary, [stillInside.id])).toThrow(/boundary/i);
    expect(() => prepareMeshBevel(invalid, [edge.id])).toThrow(/winding|nonmanifold/i);
    expect(() => prepareMeshBevel({ ...shape, skin: {} as MeshShapeNode["skin"] }, [edge.id])).toThrow(/unskinned/);
    expect(() => prepareMeshBevel({ ...shape, uvs }, [edge.id])).toThrow(/UVs/);
    expect(() => prepareMeshBevel(concave, [edge.id])).toThrow(/convex|planar/);
    expect(() => prepareMeshBevel(shape, ["stale"])).toThrow(/no longer exists/);
    expect(() => prepareMeshBevel(shape, Array(25).fill(edge.id))).toThrow(/1–24/);
    expect(store.getState().document).toBe(source);
    const result = prepareMeshBevel(shape, [edge.id]).evaluate({ width: 0.2, segments: 1 });
    setMeshVertexPositions(store, shape.id, [{ id: shape.vertices[0].id, position: [1.2, 1, 1] }]);
    const edited = store.getState().document;
    expect(() => commitMeshBevel(store, shape, result)).toThrow(/changed during Bevel/);
    expect(store.getState().document).toBe(edited);
  });
});
