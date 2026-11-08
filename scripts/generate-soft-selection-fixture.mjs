import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, configLoader: "runner", server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { addSplat, emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { captureSplatComponentTransform, withSplatComponentTransforms } = await server.ssrLoadModule("/src/splat-component-transforms.ts");
  const { encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const { Matrix4, Quaternion, Vector3 } = await server.ssrLoadModule("three");
  const centers = Array.from({ length: 18 }, (_, index) => [(index % 9 - 4) * .25, index < 9 || index === 13 ? 0 : -.5, index < 9 ? 0 : 1.5]);
  const bytes = new Uint8Array(18 * 32), view = new DataView(bytes.buffer);
  centers.forEach((center, index) => {
    [...center, .035, .06, .02].forEach((value, field) => view.setFloat32(index * 32 + field * 4, value, true));
    bytes.set([...(index < 9 ? [245, 70, 40] : [40, 140, 245]), 255, 255, 128, 128, 128], index * 32 + 24);
  });
  const asset = { id: "soft-source", kind: "file", fileName: "original-soft-depth-study.splat", byteLength: bytes.length };
  let document = addSplat(emptyScene(), asset, "Weighted Result", [0, 0, 0], "weighted", "weighted-shape").document;
  document = addSplat(document, asset, "Original Instance", [0, 0, 0], "original", "original-shape").document;
  document.nodes.weighted.position[1] = -.8; document.nodes.original.position[1] = .8;
  const indices = [1, 2, 3, 4, 5, 6, 7], weights = indices.map(index => 1 - Math.abs(centers[index][0]));
  const identity = { shapeId: "weighted-shape", assetId: asset.id, count: 18 };
  const snapshot = captureSplatComponentTransform({ document, identity, selected: indices, weights, world: new Matrix4().makeTranslation(0, -.8, 0),
    getRestCenter: index => new Vector3(...centers[index]), weightFrame: { basis: new Quaternion(), mode: "translate" } });
  document = withSplatComponentTransforms(document, identity, snapshot.changes(new Matrix4().makeTranslation(0, .6, 0)));
  const editor = { camera: { position: [0, 0, 8], target: [0, 0, 0], fov: 42, view: "front", height: 4, near: .01, far: 1000 }, time: 0 };
  await writeFile(new URL("../examples/splat-soft-selection.msb", import.meta.url), await encodeProject(document, new Map([[asset.id, new File([bytes], asset.fileName)]]), editor));
  console.log("Saved two original depth layers plus one weighted result; selection and weights are transient and absent from archive.");
} finally { await server.close(); }
