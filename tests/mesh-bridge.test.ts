import { describe, expect, it, vi } from "vitest";
import { Vector3 } from "three";
import { commitMeshBridge, expandBridgeBoundaryEdges, prepareMeshBridge } from "../src/mesh-bridge.ts";
import { bridgeFixture, bridgeFixtureScene } from "../src/mesh-bridge-fixtures.ts";
import { meshEdges, triangulateMesh, validateMeshShape } from "../src/mesh-modeling.ts";
import { createMeshRenderable } from "../src/mesh-renderer.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import type { MeshShapeNode, Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

const options = { direction: "auto", offset: 0, segments: 3 } as const;

describe("matched boundary Bridge", () => {
  it.each(["cylinder", "boxes"] as const)("bridges %s with outward winding, stable IDs and preserved materials", kind => {
    const { shape, edgeIds } = bridgeFixture(kind);
    const snapshot = structuredClone(shape);
    const seeds = [edgeIds[1], edgeIds.at(-1)!];
    expect(new Set(expandBridgeBoundaryEdges(shape, seeds))).toEqual(new Set(edgeIds));
    const prepared = prepareMeshBridge(shape, edgeIds);
    const result = prepared.evaluate(options);
    const n = edgeIds.length / 2;
    expect(result.faceIds).toHaveLength(n * options.segments);
    expect(result.rings).toHaveLength(options.segments + 1);
    expect(result.shape.vertices).toHaveLength(shape.vertices.length + n * (options.segments - 1));
    expect(result).toEqual(prepareMeshBridge(shape, [...edgeIds].reverse()).evaluate({ ...options, direction: prepared.direction }));
    expect(shape).toEqual(snapshot);
    expect(result.shape.materials).toBe(shape.materials);
    expect(result.shape.faces.slice(0, shape.faces.length).every((face, i) => face === shape.faces[i])).toBe(true);
    expect(result.shape.vertices.slice(0, shape.vertices.length).every((vertex, i) => vertex === shape.vertices[i])).toBe(true);
    expect(result.shape.faces.slice(shape.faces.length).map(face => face.materialIndex)).toEqual(Array.from({ length: n * options.segments }, (_, i) => i % n % 2));
    expect(meshEdges(result.shape).filter(edge => edgeIds.includes(edge.id)).every(edge => edge.faceIds.length === 2)).toBe(true);
    if (kind === "boxes") expect(meshEdges(result.shape).every(edge => edge.faceIds.length === 2)).toBe(true);
    const { indices, triangleFaceIds, positions } = triangulateMesh(result.shape);
    for (const [i, face] of triangleFaceIds.entries()) if (result.faceIds.includes(face)) {
      const [a, b, c] = indices.slice(i * 3, i * 3 + 3).map(index => new Vector3().fromArray(positions, index * 3));
      const outward = new Vector3(a.x, 0, a.z);
      expect(b.sub(a).cross(c.sub(a)).dot(outward)).toBeGreaterThan(0);
    }
    const few = prepared.evaluate({ ...options, segments: 2 });
    expect(result.rings[1]).toEqual(few.rings[1]);
    expect(result.faceIds.slice(0, n)).toEqual(few.faceIds.slice(0, n));
  });

  it("uses explicit reversed correspondence when the target's canonical IDs run the other way", () => {
    const { shape } = bridgeFixture("boxes");
    const lookup = (id: string) => id.startsWith("upper_gap_") ? `upper_gap_0${(4 - Number(id.slice(-2))) % 4}` : id;
    const renamed = { ...shape, vertices: shape.vertices.map(vertex => ({ ...vertex, id: lookup(vertex.id) })),
      faces: shape.faces.map(face => ({ ...face, vertices: face.vertices.map(lookup) })) };
    const edgeIds = meshEdges(renamed).filter(edge => edge.faceIds.length === 1).map(edge => edge.id);
    const prepared = prepareMeshBridge(renamed, edgeIds);
    expect(prepared.direction).toBe("reverse");
    expect(prepared.evaluate({ ...options, direction: "reverse" })).toEqual(prepared.evaluate(options));
    expect(() => prepared.evaluate({ ...options, direction: "forward" })).toThrow(/winding/);
  });

  it("repairs two holes in one connected shell without replacing its faces", () => {
    const { shape, edgeIds } = bridgeFixture("boxes");
    // Connect one side of each shell along an offset detour, leaving the two
    // original box openings untouched.
    const source: MeshShapeNode = { ...shape, faces: shape.faces.filter(face => face.id !== "lower_1" && face.id !== "upper_1") };
    const lower = shape.faces.find(face => face.id === "lower_1")!.vertices;
    const upper = shape.faces.find(face => face.id === "upper_1")!.vertices;
    // Restore the omitted walls with recessed square holes. A tube through
    // those holes joins the two disconnected fixture shells on the outside.
    function inset(ids: string[], name: string) {
      const points = ids.map(id => new Vector3(...shape.vertices.find(vertex => vertex.id === id)!.position));
      const center = points.reduce((sum, point) => sum.add(point), new Vector3()).multiplyScalar(.25);
      const hole = points.map((point, i) => {
        const id = `${name}_${i}`;
        source.vertices.push({ id, position: center.clone().lerp(point, .35).toArray() });
        return id;
      });
      ids.forEach((id, i) => source.faces.push({ id: `${name}_rim_${i}`, vertices: [id, ids[(i + 1) % 4], hole[(i + 1) % 4], hole[i]] }));
      return { hole, center };
    }
    source.vertices = [...shape.vertices];
    const a = inset(lower, "a"), b = inset(upper, "b");
    const out = a.hole.map((id, i) => {
      const point = source.vertices.find(vertex => vertex.id === id)!.position;
      const next = `outside_${i}`;
      source.vertices.push({ id: next, position: [point[0] - 1 + point[1] - a.center.y, point[1], point[2]] });
      return next;
    });
    const end = [b.hole[1], b.hole[0], b.hole[3], b.hole[2]];
    const far = end.map((id, i) => {
      const point = source.vertices.find(vertex => vertex.id === id)!.position;
      const next = `far_${i}`;
      source.vertices.push({ id: next, position: [point[0] - 1 - point[1] + b.center.y, point[1], point[2]] });
      return next;
    });
    for (const [r, [from, to]] of [[a.hole, out], [out, far], [far, end]].entries()) for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      source.faces.push({ id: `detour_${r}_${i}`, vertices: [from[i], from[next], to[next], to[i]] });
    }
    const result = prepareMeshBridge(source, edgeIds).evaluate(options);
    expect(meshEdges(result.shape).every(edge => edge.faceIds.length === 2)).toBe(true);
    expect(result.shape.faces.slice(0, source.faces.length)).toEqual(source.faces);
  });

  it("rejects incomplete, mismatched, nonmanifold, attributed and stale selections", () => {
    const { shape, edgeIds } = bridgeFixture("boxes");
    expect(() => prepareMeshBridge(shape, [edgeIds[0], edgeIds.at(-1)!])).toThrow(/two complete/);
    expect(() => prepareMeshBridge(shape, ["stale"])).toThrow(/no longer exists/);
    expect(() => expandBridgeBoundaryEdges(shape, [meshEdges(shape).find(edge => edge.faceIds.length === 2)!.id])).toThrow(/boundary/);
    const invalid = { ...shape, faces: [...shape.faces, { ...shape.faces[0], id: "extra" }] };
    expect(() => prepareMeshBridge(invalid, edgeIds)).toThrow(/boundary edges|nonmanifold|winding/);
    const open = { ...shape, faces: shape.faces.filter(face => face.id !== "upper_1") };
    const mismatched = meshEdges(open).filter(edge => edge.faceIds.length === 1).map(edge => edge.id);
    expect(() => prepareMeshBridge(open, mismatched)).toThrow(/equal edge counts/);
    expect(() => prepareMeshBridge({ ...shape, normals: {} }, edgeIds)).toThrow(/imported normals/);
    expect(() => prepareMeshBridge({ ...shape, skin: {} as MeshShapeNode["skin"] }, edgeIds)).toThrow(/unskinned/);
    const tilted = { ...shape, vertices: shape.vertices.map(vertex => vertex.id.startsWith("upper_gap")
      ? { ...vertex, position: [vertex.position[0], vertex.position[1] + .2 * vertex.position[0], vertex.position[2]] as Vec3 } : vertex) };
    expect(() => prepareMeshBridge(tilted, edgeIds)).toThrow(/parallel/);
  });

  it("rejects folded offsets and occupied joins atomically", () => {
    const { shape, edgeIds } = bridgeFixture("boxes");
    const prepared = prepareMeshBridge(shape, edgeIds);
    const result = prepared.evaluate(options);
    expect(() => prepared.evaluate({ ...options, offset: 1 })).toThrow(/fold|intersects/);
    expect(() => prepared.evaluate({ ...options, offset: 2 })).toThrow(/fold|intersects|area|degenerate/);
    expect(() => prepared.evaluate({ ...options, segments: 9 })).toThrow(/segments/);
    const obstructed = { ...shape, vertices: [...shape.vertices, { id: "a", position: [0, 0, .4] as Vec3 },
      { id: "b", position: [1, 0, .4] as Vec3 }, { id: "c", position: [1, .2, .4] as Vec3 }],
      faces: [...shape.faces, { id: "obstruction", vertices: ["a", "b", "c"] }] };
    expect(() => prepareMeshBridge(obstructed, edgeIds).evaluate(options)).toThrow(/intersect the source/);
    expect(prepared.evaluate(options)).toEqual(result);
  });

  it("restores exact viewport buffers on Cancel/replacement and stores one undoable archive edit", async () => {
    const store = createSceneStore(bridgeFixtureScene()), original = store.getState().document;
    const { edgeIds } = bridgeFixture("boxes");
    const shape = original.nodes.boxes_shape as MeshShapeNode;
    const prepared = prepareMeshBridge(shape, edgeIds), result = prepared.evaluate(options);
    const viewport = createMeshRenderable(shape);
    const geometry = viewport.mesh.geometry, wireframe = viewport.mesh.children[0];
    const material = viewport.mesh.material;
    const baselineFaces = viewport.triangleFaceIds;
    viewport.previewTopology(result.shape);
    expect(viewport.mesh.material).toBe(material);
    expect(viewport.mesh.geometry.groups.some(group => group.materialIndex === 1)).toBe(true);
    const disposed = vi.fn(); viewport.mesh.geometry.addEventListener("dispose", disposed);
    viewport.previewTopology(prepared.evaluate({ ...options, segments: 4 }).shape);
    expect(disposed).toHaveBeenCalledOnce();
    viewport.clearPreview();
    expect(viewport.mesh.geometry).toBe(geometry);
    expect(viewport.mesh.children[0]).toBe(wireframe);
    expect(viewport.triangleFaceIds).toBe(baselineFaces);
    expect(store.getState().document).toBe(original);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    commitMeshBridge(store, shape, result);
    const committed = store.getState().document;
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    expect(() => commitMeshBridge(store, shape, result)).toThrow(/changed during Bridge/);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(original);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(committed);
    const reopened = await decodeProject(await encodeProject(committed, new Map(), {
      camera: { position: [4, 2, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0,
    }));
    expect(reopened.scene.nodes[shape.id]).toEqual(result.shape);
    validateMeshShape(reopened.scene.nodes[shape.id]);
    viewport.dispose();
  });
});
