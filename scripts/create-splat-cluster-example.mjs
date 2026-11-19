// Original two-patch splat fixture with a masked, animated weighted cluster.
import { createServer } from "vite";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root, configLoader: "runner", cacheDir: (process.env.TEMP ?? root) + "/cluster-example-cache",
  server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const load = name => server.ssrLoadModule("/src/" + name + ".ts");
  const { addSplat, emptyScene } = await load("scene-document");
  const { encodeProject, decodeProject } = await load("project-archive");
  const { keySplatDeformer } = await load("splat-deformers");
  const cells = 12, patchSize = cells * cells, count = patchSize * 2;
  const bytes = new Uint8Array(count * 32), data = new DataView(bytes.buffer);
  for (let index = 0; index < count; index++) {
    const left = index < patchSize, column = index % cells, row = Math.floor(index % patchSize / cells);
    const x = (left ? -.9 : .9) + (column - (cells - 1) / 2) * .07, y = (row - (cells - 1) / 2) * .07;
    [x, y, .12 * Math.cos(column / 3), .05, .045, .025]
      .forEach((value, entry) => data.setFloat32(index * 32 + entry * 4, value, true));
    bytes.set([...(left ? [98, 178, 222] : [218, 163, 96]), 255, 255, 128, 128, 128], index * 32 + 24);
  }
  const asset = { id: "cluster-source", kind: "file", fileName: "original-weighted-patches.splat", byteLength: bytes.byteLength };
  const { document } = addSplat(emptyScene(), asset, "Weighted Patches", [0, 0, 0], "weighted-patches", "weighted-patches-shape");
  const shape = document.nodes["weighted-patches-shape"];
  shape.scalarMasks = [{
    id: "left-ramp", assetId: asset.id, sourceCount: count, version: 1, name: "Left Ramp", locked: false, componentLocks: [],
    data: { kind: "dense", values: Array.from({ length: count }, (_, index) => index < patchSize ? 1 - .75 * (index % cells) / (cells - 1) : 0) },
  }];
  let cluster = {
    id: "left-cluster", name: "Left Cluster", kind: "cluster", envelope: 1, sourceCount: count, maskId: "left-ramp",
    weights: Array.from({ length: patchSize }, (_, index) => ({ index, weight: .25 + .75 * Math.floor(index / cells) / (cells - 1) })),
    params: { pivot: [-.9, 0, 0], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  };
  for (const [channel, first, last] of [["envelope", 0, 1], ["position.y", 0, 1.1], ["rotation.z", 0, 40]]) {
    cluster = keySplatDeformer(cluster, channel, 0, first);
    cluster = keySplatDeformer(cluster, channel, 24, last);
  }
  shape.deformers = [cluster];
  const editor = { camera: { position: [0, 0, 6], target: [0, 0, 0], view: "front", height: 4, fov: 42, near: .01, far: 1000 }, time: 0 };
  const archive = await encodeProject(document, new Map([[asset.id, new File([bytes], asset.fileName)]]), editor);
  await decodeProject(archive);
  await writeFile(new URL("../examples/splat-cluster.msb", import.meta.url), archive);
  console.log(`Wrote original ${count}-splat cluster fixture (${archive.length} bytes).`);
} finally { await server.close(); }
