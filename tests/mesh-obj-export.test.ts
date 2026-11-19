import { Box3, Mesh } from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { describe, expect, it } from "vitest";
import { defaultAnimation, type CurveKey } from "../src/animation.ts";
import { exportMeshObj, listMeshExportRows, type MeshExportOptions } from "../src/mesh-export/obj.ts";
import { decodeProjectBlob, encodeProjectBlob, validateScene, type EditorSnapshot } from "../src/project-archive.ts";
import { emptyScene, type MeshShapeNode, type SceneDocument, type TransformNode, type Vec3 } from "../src/scene-document.ts";

const editor: EditorSnapshot = {
  time: 5 / 24,
  camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: 0.01, far: 1000 },
};
const local = { space: "local", topology: "polygons", frame: 5 } as const;
const world = { ...local, space: "world" } as const;
const unit = Math.SQRT1_2;
function transform(id: string, name: string, patch: Partial<TransformNode> = {}): TransformNode {
  return { id, name, type: "transform", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ", ...patch };
}
function mesh(id: string, parentId: string, points: Vec3[], faces: number[][]): MeshShapeNode {
  return {
    id, parentId, type: "meshShape", name: id + "Shape", color: "#d0d0d0", shading: "flat", wireframe: false,
    vertices: points.map((position, index) => ({ id: "v" + index, position })),
    faces: faces.map((vertices, index) => ({ id: "f" + index, vertices: vertices.map(i => "v" + i) })),
  };
}
function fixture(): SceneDocument {
  const parent = transform("parent", "Parent", { position: [10, 2, 3], scale: [2, 3, 4], rotation: [0, 0, 90] });
  const first = transform("first", "Shared #mesh", { parentId: parent.id, position: [1, 0, 0] });
  const second = transform("second", "Shared #mesh", { position: [5, 0, 0] });
  const third = transform("third", "Stored normals", { position: [0, 0, 8] });
  const fourth = transform("fourth", "Plain concave");
  const withBoth = mesh("both", first.id, [
    [0, 0, 0], [1, 0, 0], [1, 1, 1], [0, 1, 1],
    [0, 0, 0], [-1, 0, 0], [0, -1, -1],
  ], [[0, 1, 2, 3], [4, 5, 6]]);
  const uvOnly = mesh("uvOnly", second.id, [[0, 0, 0], [2, 0, 0], [0, 1, 0]], [[0, 1, 2]]);
  const normalsOnly = mesh("normalsOnly", third.id, [[0, 0, 0], [3, 0, 0], [0, 2, 0]], [[0, 1, 2]]);
  const plain = mesh("plain", fourth.id, [[0, 0, 0], [2, 0, 0], [2, 2, 0], [1, .5, 0], [0, 2, 0]], [[0, 1, 2, 3, 4]]);
  withBoth.uvs = { v0: [0, 0], v1: [1, 0], v2: [1, 1], v3: [0, 1], v4: [.5, .5], v5: [-1, 0], v6: [0, -1] };
  withBoth.normals = Object.fromEntries(withBoth.vertices.map(v => [v.id, [0, -unit, unit]]));
  uvOnly.uvs = { v0: [0, .25], v1: [1, .25], v2: [0, 1.25] };
  uvOnly.uvSets = { "1": { v0: [10, 10], v1: [11, 10], v2: [10, 11] } };
  normalsOnly.normals = { v0: [0, 0, 1], v1: [0, 0, 1], v2: [0, 0, 1] };
  const key = (id: string, time: number, value: number): CurveKey => ({
    id, time, value, interpolation: "linear", tangentMode: "auto",
  });
  const nodes = [parent, first, second, third, fourth, withBoth, uvOnly, normalsOnly, plain];
  return {
    ...emptyScene(), nodes: Object.fromEntries(nodes.map(node => [node.id, node])),
    rootIds: [parent.id, second.id, third.id, fourth.id],
    animation: { ...defaultAnimation(), tracks: [
      { id: "translation", targetId: parent.id, channel: "position.x", keys: [key("from", 0, 10), key("to", 10, 30)] },
    ] },
  };
}
function records(text: string, prefix: string): string[] {
  return text.split("\n").filter(line => line.startsWith(prefix + " ")).map(line => line.slice(prefix.length + 1));
}
function vector(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  for (const [i, value] of actual.entries()) expect(value).toBeCloseTo(expected[i], 6);
}
function readMeshes(obj: string): Mesh[] {
  return new OBJLoader().parse(obj).children.map(child => {
    expect(child).toBeInstanceOf(Mesh);
    return child as Mesh;
  });
}
async function exportText(scene: SceneDocument, ids: string[], options: MeshExportOptions = local) {
  return exportMeshObj(scene, new Set(ids), options).text();
}

describe("MSB polygon mesh OBJ export", () => {
  it("re-imports a current archive's mixed selection with independent attribute indices and stable names", async () => {
    const { scene } = await decodeProjectBlob(await encodeProjectBlob(fixture(), new Map(), editor));
    const before = structuredClone(scene);
    const obj = await exportText(scene, ["plain", "normalsOnly", "uvOnly", "both"]);
    expect(records(obj, "o")).toEqual(["1_Shared_mesh", "2_Shared_mesh", "3_Stored_normals", "4_Plain_concave"]);
    expect(records(obj, "f")).toEqual([
      "1/1/1 2/2/2 3/3/3 4/4/4",
      "5/5/5 6/6/6 7/7/7",
      "8/8 9/9 10/10",
      "11//8 12//9 13//10",
      "14 15 16 17 18",
    ]);
    expect(records(obj, "vt")).toHaveLength(10);
    expect(records(obj, "vn")).toHaveLength(10);
    expect(obj).not.toMatch(/^(usemtl|mtllib) /m);
    const [both, uvOnly, normalsOnly, plain] = readMeshes(obj);
    expect([both, uvOnly, normalsOnly, plain].map(item => item.name)).toEqual(records(obj, "o"));
    // The imported quad and triangle share a position but have separate UVs.
    const positions = both.geometry.attributes.position, uvs = both.geometry.attributes.uv;
    expect(positions.count).toBe(9);
    vector([positions.getX(0), positions.getY(0), positions.getZ(0)], [0, 0, 0]);
    vector([positions.getX(6), positions.getY(6), positions.getZ(6)], [0, 0, 0]);
    vector([uvs.getX(0), uvs.getY(0), uvs.getX(6), uvs.getY(6)], [0, 0, .5, .5]);
    vector(Array.from(uvOnly.geometry.attributes.uv.array), [0, .25, 1, .25, 0, 1.25]);
    vector(Array.from(normalsOnly.geometry.attributes.normal.array), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(plain.geometry.attributes.uv).toBeUndefined();
    const subset = await exportText(scene, ["uvOnly", "plain"]);
    expect(records(subset, "o")).toEqual(["2_Shared_mesh", "4_Plain_concave"]);
    expect(records(subset, "f")).toEqual(["1/1 2/2 3/3", "4 5 6 7 8"]);
    expect(scene).toEqual(before);
  });

  it("bakes a parented pose, world bounds and inverse-transpose normals at independent frame samples", async () => {
    const { scene } = await decodeProjectBlob(await encodeProjectBlob(fixture(), new Map(), editor));
    const before = structuredClone(scene);
    const [animated] = readMeshes(await exportText(scene, ["both"], world));
    const position = animated.geometry.attributes.position;
    // T(20,2,3) · Rz(90°) · S(2,3,4) · T(1,0,0), calculated independently.
    vector(Array.from(position.array).slice(0, 9), [20, 4, 3, 20, 6, 3, 17, 6, 7]);
    vector(Array.from(animated.geometry.attributes.normal.array).slice(0, 3), [.8, 0, .6]);
    const bounds = new Box3().setFromObject(animated);
    vector(bounds.min.toArray(), [17, 2, -1]);
    vector(bounds.max.toArray(), [23, 6, 7]);
    const [atStart] = readMeshes(await exportText(scene, ["both"], { ...world, frame: 0 }));
    vector(Array.from(atStart.geometry.attributes.position.array).slice(0, 3), [10, 4, 3]);
    const [atSource] = readMeshes(await exportText(scene, ["both"], { ...local, frame: NaN }));
    vector(new Box3().setFromObject(atSource).min.toArray(), [-1, -1, -1]);
    vector(new Box3().setFromObject(atSource).max.toArray(), [1, 1, 1]);
    vector(Array.from(atSource.geometry.attributes.normal.array).slice(0, 3), [0, -unit, unit]);
    expect(scene).toEqual(before);
  });

  it("evaluates point constraints after animation for world output", async () => {
    const scene = fixture();
    scene.constraints = [{
      id: "follow", name: "Follow Parent", type: "point", enabled: true, maintainOffset: false,
      sourceId: "parent", targetId: "second",
      offset: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    }];
    validateScene(scene);
    const [followed] = readMeshes(await exportText(scene, ["uvOnly"], world));
    vector(Array.from(followed.geometry.attributes.position.array).slice(0, 9), [20, 2, 3, 22, 2, 3, 20, 3, 3]);
  });

  it("uses the editor's triangulation for a concave polygon without touching source face order", async () => {
    const scene = fixture();
    const preserve = await exportText(scene, ["plain"]);
    const triangulated = await exportText(scene, ["plain"], { ...local, topology: "triangles" });
    expect(records(preserve, "f")).toEqual(["1 2 3 4 5"]);
    const triangles = records(triangulated, "f");
    expect(triangles).toHaveLength(3);
    expect(triangles.every(face => face.split(" ").length === 3)).toBe(true);
    const [triangulatedMesh] = readMeshes(triangulated);
    const positions = triangulatedMesh.geometry.attributes.position;
    let area = 0;
    for (let index = 0; index < positions.count; index += 3) {
      const ax = positions.getX(index), ay = positions.getY(index);
      const bx = positions.getX(index + 1), by = positions.getY(index + 1);
      const cx = positions.getX(index + 2), cy = positions.getY(index + 2);
      const signedTriangleArea = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
      expect(signedTriangleArea).toBeGreaterThan(0);
      area += signedTriangleArea;
    }
    expect(area).toBe(2.5);
    expect(await exportText(scene, ["plain"])).toBe(preserve);
  });

  it("reverses polygon and triangle corner winding as units under a reflected world transform", async () => {
    const scene = fixture();
    // The current MSB validator excludes reflected transforms. Check the OBJ
    // safeguard directly without introducing a separate archive reader.
    const third = scene.nodes.third as TransformNode;
    third.scale[0] = -1;
    expect(() => validateScene(scene)).toThrow("scale");
    for (const topology of ["polygons", "triangles"] as const) {
      const localObj = await exportText(scene, ["normalsOnly"], { ...local, topology });
      const reflected = await exportText(scene, ["normalsOnly"], { ...world, topology });
      expect(records(reflected, "f")).toEqual(records(localObj, "f").map(face => face.split(" ").reverse().join(" ")));
      const [reflectedMesh] = readMeshes(reflected);
      vector(new Box3().setFromObject(reflectedMesh).min.toArray(), [-3, 0, 8]);
      vector(Array.from(reflectedMesh.geometry.attributes.normal.array).slice(0, 3), [0, 0, 1]);
    }
  });

  it("lists actionable reasons for empty, skinned and blend-shape rows and refuses unavailable selections", async () => {
    const scene = fixture();
    const skinned = scene.nodes.both as MeshShapeNode;
    const morph = scene.nodes.uvOnly as MeshShapeNode;
    skinned.skin = {
      jointIds: ["joint"], inverseBindMatrices: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
      weights: Object.fromEntries(skinned.vertices.map(v => [v.id, [{ joint: 0, weight: 1 }]])),
    };
    morph.morphTargets = [{
      name: "Smile", weight: 0,
      deltas: Object.fromEntries(morph.vertices.map(v => [v.id, [0, 0, 0]])),
    }];
    scene.nodes.empty = mesh("empty", "third", [], []);
    expect(listMeshExportRows(emptyScene())).toEqual([]);
    expect(listMeshExportRows(scene).map(row => [row.label, row.unavailable?.split(".")[0]])).toEqual([
      ["Shared #mesh", "Skinned mesh"],
      ["Shared #mesh", "Blend-shape mesh"],
      ["Stored normals / normalsOnlyShape", undefined],
      ["Plain concave", undefined],
      ["Stored normals / emptyShape", "Empty mesh"],
    ]);
    await expect(exportText(scene, ["plain", "empty"])).rejects.toThrow("Add polygon faces");
    await expect(exportText(scene, [])).rejects.toThrow("Select at least one");
    await expect(exportText(scene, ["plain"], { ...world, frame: NaN })).rejects.toThrow("Enter a finite frame");
  });
});
