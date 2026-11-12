import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zlibSync } from "fflate";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root, configLoader: "runner", cacheDir: resolve(process.env.TEMP ?? root, "particle-fields-example"),
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
});

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const payload = Buffer.concat([Buffer.from(name), bytes]), result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  payload.copy(result, 4);
  result.writeUInt32BE(crc(payload), bytes.length + 8);
  return result;
}
function imageRamp() {
  const width = 64, height = 1, rgba = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const u = i / (width - 1);
    rgba.set([255 - Math.round(120 * u), 176 + Math.round(79 * u), 144 + Math.round(111 * u), Math.round(255 * (1 - .85 * u))], i * 4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", Buffer.from(zlibSync(new Uint8Array([0, ...rgba])))), chunk("IEND", Buffer.alloc(0))]);
  return { width, height, rgba, bytes };
}
try {
  const load = name => server.ssrLoadModule("/src/" + name + ".ts");
  const { createSceneStore } = await load("scene-store");
  const { createParticleEmitter, findParticleShape, updateParticleEmitter } = await load("particle-emitter");
  const { defaultParticleGraphAppearance, defaultParticleGraphField } = await load("particle-map-fields");
  const { createGraphNode } = await load("procedural-graph");
  const { setAnimationSettings } = await load("animation");
  const { prepareTexture } = await load("texture-assets");
  const { encodeProject, decodeProject } = await load("project-archive");
  const { createParticleSimulation } = await load("particle-simulation");
  const { ParticleCheckpointCache } = await load("particle-checkpoints");
  const image = imageRamp();
  const thumbnail = "data:image/png;base64," + image.bytes.toString("base64");
  const asset = await prepareTexture(new File([image.bytes], "Lifetime tint.png"), "color", async () => ({ alpha: true, thumbnail }));
  const nodes = [], edges = [];
  function node(kind, id, x, y, params) {
    const value = createGraphNode(kind, id, x, y);
    Object.assign(value.params, params);
    nodes.push(value);
  }
  function wire(node, port, target, input) {
    edges.push({ from: { node, port }, to: { node: target, port: input } });
  }
  node("particle", "age", 16, 18);
  node("time", "scene-time", 16, 165);
  node("multiply", "phase", 210, 150, { type: "scalar", b: .16 });
  node("add", "phase-age", 390, 26, { type: "scalar" });
  node("gradient", "tint-ramp", 570, 18, { start: [1, .16, .025], end: [.04, .9, .95] });
  node("texture", "lifetime-image", 390, 160, { assetId: asset.id });
  node("multiply", "tint", 750, 18, { type: "color" });
  node("add", "diameter", 570, 168, { type: "scalar", b: .45 });
  node("output", "output", 950, 65);
  node("position", "position", 16, 324);
  node("multiply", "noise-time", 210, 314, { type: "scalar", b: .65 });
  node("noise", "noise-x", 390, 312, { scale: .9, speed: 1.1, seed: 13 });
  node("noise", "noise-z", 390, 460, { scale: 1.25, speed: 1.3, seed: 47 });
  node("add", "signed-x", 570, 312, { type: "scalar", b: -.52 });
  node("add", "signed-z", 570, 464, { type: "scalar", b: -.5 });
  node("add", "lift", 570, 614, { type: "scalar", a: .22 });
  node("vector", "force", 750, 337);
  wire("scene-time", "value", "phase", "a");
  wire("age", "normalizedAge", "phase-age", "a");
  wire("phase", "value", "phase-age", "b");
  wire("phase-age", "value", "tint-ramp", "factor");
  wire("tint-ramp", "color", "tint", "a");
  wire("lifetime-image", "color", "tint", "b");
  wire("tint", "value", "output", "color");
  wire("lifetime-image", "alpha", "output", "alpha");
  wire("age", "normalizedAge", "diameter", "a");
  wire("diameter", "value", "output", "size");
  wire("scene-time", "value", "noise-time", "a");
  for (const side of ["x", "z"]) {
    wire("position", "position", "noise-" + side, "position");
    wire("noise-time", "value", "noise-" + side, "time");
    wire("noise-" + side, "value", "signed-" + side, "a");
    wire("signed-" + side, "value", "force", side);
  }
  wire("lift", "value", "force", "y");
  wire("force", "vector", "output", "field");

  const benchmark = process.argv[2] === "--benchmark";
  const store = createSceneStore();
  store.setState({ document: { ...store.getState().document, textureAssets: { [asset.id]: asset }, proceduralGraph: { nodes, edges } } });
  setAnimationSettings(store, { end: 120, fps: 24 });
  const photo = createParticleEmitter(store, "omni", { name: "Image and Ramp", position: [-2, .5, 0] });
  const force = createParticleEmitter(store, "directional", { name: "Noise Force", position: [2, -.4, 0], rotation: [0, 0, 17] });
  const shapeId = id => findParticleShape(store.getState().document, id).id;
  const base = { lifetime: 1.8, endFrame: 109, acceleration: [0, 0, 0], opacities: [1, .5] };
  updateParticleEmitter(store, shapeId(photo), { ...base, rate: benchmark ? 1100 : 165, speed: .95, speedRandom: .7,
    seed: 17, sizes: [.18, .10], appearanceMap: { ...defaultParticleGraphAppearance(), enabled: true } });
  updateParticleEmitter(store, shapeId(force), { ...base, rate: benchmark ? 1000 : 120, speed: 1.2, speedRandom: .35,
    spread: .2, seed: 91, sizes: [.105, .067], colors: ["#a7c9ff", "#6e79b5"],
    forceField: { ...defaultParticleGraphField(), enabled: true, space: "emitter", strength: 6 } });
  const doc = store.getState().document;
  const editor = { camera: { position: [4.5, 4.1, 10], target: [0, 1.4, 0], fov: 43, near: .01, far: 1000 }, time: 2 };
  const encoded = await encodeProject(doc, new Map(), editor);
  const roundTrip = await decodeProject(encoded);
  assert.deepEqual(roundTrip.scene, doc);
  if (!benchmark) {
    const path = resolve(process.argv[2] ?? resolve(root, "examples/particle-map-fields.msb"));
    await writeFile(path, encoded);
    assert.deepEqual((await decodeProject(new Uint8Array(await readFile(path)))).scene, doc);
    console.log("Generated original image, lifetime ramp and animated vector field fixture", encoded.length, "bytes");
  } else {
    if (process.argv[3]) await writeFile(resolve(process.argv[3]), encoded);
    const pixels = new Map([[asset.id, image]]);
    const results = [];
    for (const id of [photo, force]) {
      const shape = findParticleShape(doc, id), warm = createParticleSimulation(doc, shape, undefined, pixels, new ParticleCheckpointCache());
      try {
        const primeStart = performance.now();
        await warm.snapshotAt(105);
        const primeMs = performance.now() - primeStart;
        for (const frame of [86, 52, 76]) {
          const cold = createParticleSimulation(doc, shape, undefined, pixels, null);
          try {
            const coldStart = performance.now(), expected = await cold.snapshotAt(frame), coldMs = performance.now() - coldStart;
            const warmStart = performance.now(), actual = await warm.snapshotAt(frame), warmMs = performance.now() - warmStart;
            assert.deepEqual(actual, expected);
            results.push({ emitter: shape.name, rate: shape.rate, frame, count: actual.count,
              primeMs: +primeMs.toFixed(2), coldMs: +coldMs.toFixed(2), warmMs: +warmMs.toFixed(2) });
          } finally { cold.dispose(); }
        }
      } finally { warm.dispose(); }
    }
    console.log(JSON.stringify({ platform: process.platform, node: process.version, cpu: cpus()[0]?.model.trim(),
      ramGiB: Math.round(totalmem() / 2 ** 30), results,
      limits: "Node CPU replay and appearance evaluation with original raw pixels and cooperative yields. Excludes browser decode and viewport. Warm unique targets miss the exact output cache." }, null, 2));
  }
} finally {
  await server.close();
}
