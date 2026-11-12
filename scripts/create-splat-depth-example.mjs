// Generate the original known-distance depth scene from local procedural data.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Matrix4 } from "three";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root, configLoader: "runner", appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { addSplat, emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { encodeProject, decodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const { defaultAnimation } = await server.ssrLoadModule("/src/animation.ts");
  let scene = emptyScene();
  const files = new Map();

  function addSource(id, name, rows) {
    const bytes = new Uint8Array(rows.length * 32), data = new DataView(bytes.buffer);
    rows.forEach(([x, y, z, radius, alpha, color], index) => {
      const offset = index * 32;
      [x, y, z, radius, radius, radius * .25].forEach((value, axis) => data.setFloat32(offset + axis * 4, value, true));
      bytes.set([...color, alpha, 255, 128, 128, 128], offset + 24);
    });
    const asset = { id: id + "-source", kind: "file", fileName: id + ".splat", byteLength: bytes.length };
    scene = addSplat(scene, asset, name, [0, 0, 0], id, id + "-shape").document;
    files.set(asset.id, new File([bytes], asset.fileName));
  }

  addSource("distance", "Depth reference splats", [
    [-1.6, .95, 0, .43, 250, [220, 105, 45]],
    [0, .8, 0, .52, 250, [205, 225, 45]],
    [2.6, -2.3, -16, 1.25, 250, [65, 145, 245]],
    [-.95, -1.2, 0, .42, 102, [200, 80, 195]],
    [-1.06875, -1.35, -1, .47, 102, [230, 125, 220]],
  ]);
  addSource("affine", "Transformed splat", [[1.35, 1.05, 0, .45, 250, [200, 195, 90]]]);
  scene.nodes.affine.position = [0, 0, .25];
  scene.nodes["affine-shape"].componentTransforms = {
    version: 1, sourceCount: 1, records: [{ index: 0, matrix: new Matrix4().makeTranslation(0, 0, .55).toArray() }],
  };

  addSource("posed", "One-joint posed splat", [[1.5, -.85, 0, .45, 250, [35, 235, 165]]]);
  scene.nodes.posed.position = [0, 0, .25];
  scene.joints = [{ id: "depth-joint", name: "Depth Joint", parentId: null, position: [0, 0, 0] }];
  scene.nodes["posed-shape"].binding = {
    meshSpace: true, jointIds: ["depth-joint"], restMatrices: [new Matrix4().toArray()],
  };
  scene.animation = {
    ...defaultAnimation(), end: 24,
    tracks: [{
      id: "pose-depth-motion", targetId: "depth-joint", channel: "position.z",
      keys: [0, 24].map((time, index) => ({
        id: "pose-depth-key-" + index, time, value: index * 1.25, interpolation: "linear", tangentMode: "auto",
      })),
    }],
  };

  scene.rootIds.push("occluder");
  scene.nodes.occluder = {
    id: "occluder", type: "transform", name: "Opaque occluder", parentId: null,
    rotationOrder: "XYZ", position: [0, .65, 2], rotation: [0, 0, 0], scale: [1, 1, 1],
  };
  scene.nodes["occluder-shape"] = {
    id: "occluder-shape", type: "meshShape", name: "Opaque occluderShape", parentId: "occluder",
    vertices: [[-.3, -.3, 0], [.3, -.3, 0], [.3, .3, 0], [-.3, .3, 0]].map((position, index) => ({ id: "plane-v" + index, position })),
    faces: [{ id: "plane-face", vertices: ["plane-v0", "plane-v1", "plane-v2", "plane-v3"] }],
    color: "#777777", shading: "flat", wireframe: true,
  };
  const editor = { camera: { position: [0, 0, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0 };
  const archive = await encodeProject(scene, files, editor);
  await decodeProject(archive);
  await writeFile(new URL("../examples/splat-depth-study.msb", import.meta.url), archive);
  console.log("Wrote depth reference scene with seven original splats, an animated joint and one opaque plane.");
} finally {
  await server.close();
}
