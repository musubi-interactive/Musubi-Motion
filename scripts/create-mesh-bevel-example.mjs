// Regenerate the original deterministic fixture with node scripts/create-mesh-bevel-example.mjs.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root, configLoader: "runner",
  server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const load = name => server.ssrLoadModule(`/src/${name}.ts`);
  const { emptyScene, normalizedChannels } = await load("scene-document");
  const { createSceneStore } = await load("scene-store");
  const { meshEdges } = await load("mesh-modeling");
  const { commitMeshBevel, prepareMeshBevel } = await load("mesh-bevel");
  const { encodeProject, decodeProject } = await load("project-archive");
  const document = emptyScene();
  const objects = [
    { id: "source", name: "Source cube", x: -2.4, color: "#8797ac", selected: 0, segments: 1 },
    { id: "chamfer", name: "Single-edge bevel", x: 0, color: "#96a98c", selected: 1, segments: 1 },
    { id: "corner", name: "Three-edge bevel", x: 2.4, color: "#b5a08b", selected: 3, segments: 4 },
  ];
  for (const object of objects) {
    const shapeId = `${object.id}_shape`;
    const positions = [
      [-.8, -.8, -.8], [.8, -.8, -.8], [.8, .8, -.8], [-.8, .8, -.8],
      [-.8, -.8, .8], [.8, -.8, .8], [.8, .8, .8], [-.8, .8, .8],
    ];
    const loops = [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]];
    document.rootIds.push(object.id);
    document.nodes[object.id] = {
      id: object.id, name: object.name, type: "transform", parentId: null, rotationOrder: "XYZ",
      ...normalizedChannels({ position: [object.x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    };
    document.nodes[shapeId] = {
      id: shapeId, parentId: object.id, name: `${object.name}Shape`, type: "meshShape",
      vertices: positions.map((position, index) => ({ id: `v${index}`, position })),
      faces: loops.map((vertices, index) => ({ id: `f${index}`, vertices: vertices.map(vertex => `v${vertex}`) })),
      color: object.color, shading: "flat", wireframe: true,
    };
  }
  const store = createSceneStore(document);
  for (const object of objects.filter(object => object.selected)) {
    const source = document.nodes[`${object.id}_shape`];
    const ids = object.selected === 1 ? [JSON.stringify(["v5", "v6"])]
      : meshEdges(source).filter(edge => edge.vertices.includes("v6")).map(edge => edge.id);
    const result = prepareMeshBevel(source, ids).evaluate({ width: .65, segments: object.segments });
    commitMeshBevel(store, source, result);
  }
  const final = store.getState().document;
  const bytes = await encodeProject(final, new Map(), {
    camera: { position: [4, 3.1, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0,
  });
  const opened = await decodeProject(bytes);
  assert.deepEqual(opened.scene, final);
  for (const object of objects) {
    const mesh = opened.scene.nodes[`${object.id}_shape`];
    const edges = meshEdges(mesh);
    assert.equal(mesh.faces.length, 6 + object.selected * object.segments);
    assert.ok(edges.every(edge => edge.faceIds.length === 2));
    assert.equal(mesh.vertices.length - edges.length + mesh.faces.length, 2);
    console.log(`${object.name}: ${mesh.vertices.length} vertices / ${edges.length} edges / ${mesh.faces.length} faces`);
  }
  const folder = resolve(root, "examples/modeling");
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, "mesh-bevel.msb"), bytes);
  console.log(`Wrote and verified examples/modeling/mesh-bevel.msb (${bytes.length} bytes).`);
} finally {
  await server.close();
}
