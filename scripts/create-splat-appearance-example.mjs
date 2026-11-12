// Original projection scene. --benchmark <path> uses a denser source.
import { createServer } from "vite";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const stress = process.argv[2] === "--benchmark";
const destination = stress ? resolve(process.argv[3]) : resolve(root, "examples/textures/splat-appearance.msb");
const server = await createServer({
  root, configLoader: "runner", cacheDir: resolve(process.env.TEMP ?? root, "appearance-example-cache"),
  server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const load = name => server.ssrLoadModule("/src/" + name + ".ts");
  const { addSplat, emptyScene } = await load("scene-document");
  const { defaultAnimation } = await load("animation");
  const { animatedNoiseGraph, createGraphNode, connectGraphPorts } = await load("procedural-graph");
  const { prepareTexture } = await load("texture-assets");
  const { newSplatAppearanceLayer, replaceSplatAppearance } = await load("splat-appearance");
  const { encodeProject, decodeProject } = await load("project-archive");
  // An original 2×2 RGBA split with opaque orange on the left and transparent blue on the right.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4XyHyn2HLfwYGGAMAT9EIe3Di2MgAAAAASUVORK5CYII=";
  const thumbnail = "data:image/png;base64," + png;
  const image = await prepareTexture(new File([Buffer.from(png, "base64")], "Projection Split.png"), "color", async () => ({ alpha: true, thumbnail }));
  let graph = animatedNoiseGraph(image.id);
  const multiplier = createGraphNode("multiply", "time-multiplier", 24, 286);
  multiplier.params = { type: "scalar", a: 0, b: 1.5 };
  graph = { ...graph, nodes: [...graph.nodes, multiplier].map(node => node.kind === "gradient"
    ? { ...node, params: { start: [1, .12, .035], end: [.06, .35, 1] } }
    : node) };
  graph = connectGraphPorts(graph, { node: "time", port: "value" }, { node: multiplier.id, port: "a" });
  graph = connectGraphPorts(graph, { node: multiplier.id, port: "value" }, { node: "noise", port: "time" });

  const columns = stress ? 128 : 20, rows = stress ? 192 : 22, half = columns * rows, count = half * 2 + 1;
  const bytes = new Uint8Array(count * 32), view = new DataView(bytes.buffer);
  const radius = stress ? .0017 : .012;
  for (let index = 0; index < count; index++) {
    const local = index % half, column = local % columns, row = Math.floor(local / columns), offset = index * 32;
    const center = index === count - 1 ? [0, .65, 0] : [
      (index < half ? -.62 : .62) + (column / (columns - 1) - .5) * .54,
      (row / (rows - 1) - .5) * .64, 0,
    ];
    [...center, radius, radius, radius / 2].forEach((value, axis) => view.setFloat32(offset + axis * 4, value, true));
    bytes.set([195, 195, 195, 255, 255, 128, 128, 128], offset + 24);
  }
  const asset = { id: "appearance-source", kind: "file", fileName: "original-appearance.splat", byteLength: bytes.length };
  const { document } = addSplat(emptyScene(), asset, "Planar Appearance", [0, 0, 0], "projected", "projected-shape");
  const identity = { shapeId: "projected-shape", assetId: asset.id, count };
  const mask = {
    version: 1, id: "left-mask", name: "Left Region", assetId: asset.id, sourceCount: count, locked: false,
    data: { kind: "sparse", defaultValue: 0, indices: Array.from({ length: half }, (_, index) => index), values: new Array(half).fill(1) },
    componentLocks: [],
  };
  const key = (time, value) => ({ id: "translation-" + time, time, value, interpolation: "linear", tangentMode: "auto" });
  const initial = {
    ...document,
    animation: { ...defaultAnimation(), end: 96, tracks: [{ id: "projected-track", targetId: "projected", channel: "position.x", keys: [key(0, 0), key(48, 1.1), key(96, 0)] }] },
    textureAssets: { [image.id]: image }, proceduralGraph: graph,
    nodes: { ...document.nodes, [identity.shapeId]: {
      ...document.nodes[identity.shapeId], scalarMasks: [mask],
      componentEdits: { version: 1, sourceCount: count, hidden: [], deleted: [count - 1, count] },
    } },
  };
  const scene = replaceSplatAppearance(initial, identity, [
    { ...newSplatAppearanceLayer(), id: "recolor-scale", maskId: mask.id, scale: true, scaleMin: .4, scaleMax: 1.65 },
    { ...newSplatAppearanceLayer(), id: "world-reveal", maskId: mask.id, space: "world", color: false, opacity: true },
  ]);
  const editor = { camera: { position: [0, 0, 8], target: [0, 0, 0], view: "front", height: 2.8, fov: 42, near: .01, far: 1000 }, time: 0 };
  const archive = await encodeProject(scene, new Map([[asset.id, new File([bytes], asset.fileName)]]), editor);
  await decodeProject(archive);
  await writeFile(destination, archive);
  console.log("Wrote " + count + " original splats, masked animated appearance and embedded projection texture.");
} finally {
  await server.close();
}
