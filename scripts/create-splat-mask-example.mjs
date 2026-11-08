// Original two-region Gaussian grid, embedded once and instanced twice.
import { createServer } from "vite";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, configLoader: "runner", cacheDir: (process.env.TEMP ?? root) + "/mask-example-cache", server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const mod = name => server.ssrLoadModule("/src/" + name + ".ts"), { addSplat, emptyScene } = await mod("scene-document"), { createSceneStore } = await mod("scene-store"), masks = await mod("splat-masks"), { encodeProject, decodeProject } = await mod("project-archive");
  const count = 513, bytes = new Uint8Array(count * 32), view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) { const index = i % 256, column = index % 16, row = Math.floor(index / 16), offset = i * 32;
    const position = i === 512 ? [0, 1, 0] : [(i < 256 ? -.8 : .8) + (column - 7.5) * .035, (row - 7.5) * .035, 0];
    [...position, .018, .018, .009].forEach((value, j) => view.setFloat32(offset + j * 4, value, true)); bytes.set([190, 195, 200, i === 512 ? 0 : 255, 255, 128, 128, 128], offset + 24);
  }
  const asset = { id: "mask-regions-source", kind: "file", fileName: "original-mask-regions.splat", byteLength: bytes.length };
  let doc = addSplat(emptyScene(), asset, "Mask Regions", [0, .55, 0], "regions", "regions-shape").document;
  doc = addSplat(doc, asset, "Shared Source Instance", [0, -.55, 0], "instance", "instance-shape").document;
  const store = createSceneStore(doc), identity = { shapeId: "regions-shape", assetId: asset.id, count }, left = Uint32Array.from({ length: 256 }, (_, i) => i);
  masks.createSplatSet(store, identity, "Left originals", left);
  const binary = masks.createSplatMask(store, identity, "Left density", left); masks.setSplatMaskComponentLocks(store, identity, binary, [0], true);
  const ramp = masks.createSplatMask(store, identity, "Ramp", []);
  masks.applySplatMaskStroke(store, identity, ramp, { indices: Uint32Array.from({ length: 512 }, (_, i) => i), values: Float32Array.from({ length: 512 }, (_, i) => (i % 16) / 15) });
  masks.createSplatMask(store, identity, "Paint study", []);
  const other = { ...identity, shapeId: "instance-shape" }; masks.createSplatSet(store, other, "Instance right", [256, 257]); masks.createSplatMask(store, other, "Independent", [256, 257]);
  const editor = { camera: { position: [0, 0, 8], target: [0, 0, 0], view: "front", height: 3, fov: 42, near: .01, far: 1000 }, time: 0 };
  const file = new File([bytes], asset.fileName), archive = await encodeProject(store.getState().document, new Map([[asset.id, file]]), editor); await decodeProject(archive);
  await writeFile(new URL("../examples/splat-mask-regions.msb", import.meta.url), archive); console.log(`Wrote original513-record shared source, named sets, binary/ramp/empty masks (${archive.length} bytes).`);
} finally { await server.close(); }
