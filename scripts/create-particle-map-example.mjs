// Original geometric M logo and procedural noise × ramp. No external artwork.
import { createServer } from "vite";
import { zlibSync } from "fflate";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, configLoader: "runner", cacheDir: resolve(process.env.TEMP ?? root, "particle-map-example-cache"), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
function crc(bytes) { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; } return (n ^ 0xffffffff) >>> 0; }
function chunk(name, bytes) { const type = Buffer.from(name), data = Buffer.concat([type, bytes]), out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); data.copy(out, 4); out.writeUInt32BE(crc(data), bytes.length + 8); return out; }
function logo() {
  const size = 64, rgba = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / 63, v = y / 63;
    const on = v > .12 && v < .88 && (u > .12 && u < .25 || u > .75 && u < .88 || u >= .25 && u <= .5 && Math.abs(v - (.18 + (u - .25) * 1.5)) < .085 || u > .5 && u <= .75 && Math.abs(v - (.555 - (u - .5) * 1.5)) < .085);
    const i = y * (size * 4 + 1) + 1 + x * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = on ? 255 : 0; rgba[i + 3] = 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", Buffer.from(zlibSync(rgba))), chunk("IEND", Buffer.alloc(0))]);
}
try {
  const load = path => server.ssrLoadModule("/src/" + path + ".ts");
  const { createSceneStore } = await load("scene-store"), { createMeshPrimitive, findMeshShape } = await load("mesh-modeling");
  const { createParticleEmitter, findParticleShape, updateParticleEmitter } = await load("particle-emitter");
  const { defaultParticleEmissionMap } = await load("particle-map-emission"), { animatedNoiseGraph } = await load("procedural-graph");
  const { prepareTexture } = await load("texture-assets"), { encodeProject, decodeProject } = await load("project-archive");
  const { setAnimationSettings } = await load("animation");
  const bytes = logo(), thumbnail = "data:image/png;base64," + bytes.toString("base64");
  const asset = await prepareTexture(new File([bytes], "Musubi M density.png"), "data", async () => ({ alpha: false, thumbnail }));
  const store = createSceneStore();
  store.setState({ document: { ...store.getState().document, textureAssets: { [asset.id]: asset }, proceduralGraph: animatedNoiseGraph() } });
  setAnimationSettings(store, { end: 144, fps: 24 });
  for (const [index, name, source] of [[0, "Image logo", "image"], [1, "Animated noise ramp", "graph"]]) {
    const parent = createMeshPrimitive(store, "plane", { name: name + " surface", size: 3, position: [index ? 2 : -2, 0, 0], color: "#282b30" });
    const mesh = findMeshShape(store.getState().document, parent), emitter = createParticleEmitter(store, "surface", { name, surfaceId: mesh.id });
    updateParticleEmitter(store, findParticleShape(store.getState().document, emitter).id, { rate: 1800, lifetime: 1.8, endFrame: 120, speed: .6, speedRandom: 0, spread: 0, acceleration: [0, 0, 0], drag: 0, sizes: [.035, .02], colors: ["#eeeeee", "#a0a8b0"], opacities: [1, .7], emissionMap: { ...defaultParticleEmissionMap(), enabled: true, source, assetId: source === "image" ? asset.id : "", bounds: [-1.5, -1.5, 1.5, 1.5] } });
  }
  const doc = store.getState().document, graph = doc.proceduralGraph;
  graph.nodes = graph.nodes.map(n => n.kind === "gradient" ? { ...n, params: { start: [0, 0, 0], end: [1, 1, 1] } } : n.kind === "noise" ? { ...n, params: { seed: 7, scale: 1.8, speed: 2 } } : n);
  const archive = await encodeProject(doc, new Map(), { camera: { position: [0, 8, 6], target: [0, 0, 0], fov: 45, near: .01, far: 1000 }, time: 1.5 });
  await decodeProject(archive);
  await writeFile(resolve(root, "examples/particle-map-study.msb"), archive);
  console.log(`Wrote original logo + animated noise/ramp scene (${archive.length} bytes).`);
} finally { await server.close(); }
