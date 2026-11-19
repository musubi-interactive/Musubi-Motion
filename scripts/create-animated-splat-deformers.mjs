import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Box3, Vector3 } from "three";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceName = "splat-deformer-tower.splat";
const source = await readFile(new URL("../examples/" + sourceName, import.meta.url));
const server = await createServer({ root, configLoader: "runner", server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const load = name => server.ssrLoadModule("/src/" + name + ".ts");
  const { addSplat, emptyScene } = await load("scene-document");
  const { defaultAnimation } = await load("animation");
  const { getSplatDeformerDefinition } = await load("splat-deformers");
  const { decodeProject, encodeProject } = await load("project-archive");
  const count = source.byteLength / 32;
  const asset = { id: "tower-source", kind: "file", fileName: sourceName, byteLength: source.byteLength };
  const { document } = addSplat(emptyScene(), asset, "Animated Tower", [0, 0, 0], "tower", "tower-shape");
  const shape = document.nodes["tower-shape"];
  const bounds = new Box3(new Vector3(-.8, -1.25, -.8), new Vector3(.8, 1.25, .8));
  function layer(kind, name) {
    return { id: kind, name, kind, envelope: 1, sourceCount: count, params: getSplatDeformerDefinition(kind).create(bounds) };
  }
  function pulse(channel, rest, peak) {
    return [0, 24, 48].map(frame => ({ frame, channel, value: frame === 24 ? peak : rest }));
  }
  const cluster = layer("cluster", "Weighted upper rings");
  cluster.weights = [];
  for (let index = 0; index < count; index++) {
    const y = source.readFloatLE(index * 32 + 4);
    if (y > 0) cluster.weights.push({ index, weight: y });
  }
  cluster.keys = pulse("position.x", 0, .24);
  const bend = layer("bend", "Bend the tower");
  bend.keys = pulse("curvature", 0, 25);
  const twist = layer("twist", "Twist the gold seam");
  twist.keys = pulse("endAngle", 0, 70);
  const squash = layer("squash", "Stretch with volume");
  squash.params.preserveVolume = true;
  squash.keys = pulse("factor", 0, .2);
  const lattice = layer("lattice", "Pull one lattice point");
  const last = lattice.params.offsets.length - 1;
  const control = getSplatDeformerDefinition("lattice").controls(lattice.params, last)[0];
  lattice.keys = pulse(control.id, control.value, control.value + .6);
  const cage = layer("cage", "Lift a cage vertex");
  const vertex = getSplatDeformerDefinition("cage").controls(cage.params, 6)[1];
  cage.keys = pulse(vertex.id, vertex.value, vertex.value + .2);
  shape.deformers = [cluster, bend, twist, squash, lattice, cage];
  document.animation = { ...defaultAnimation(), start: 0, end: 48 };
  const editor = { camera: { position: [0, 0, 6], target: [0, 0, 0], view: "front", height: 3.4, fov: 45, near: .01, far: 100 }, time: 0 };
  const archive = await encodeProject(document, new Map([[asset.id, new File([source], sourceName)]]), editor);
  await decodeProject(archive);
  await writeFile(new URL("../examples/animated-splat-deformers.msb", import.meta.url), archive);
} finally {
  await server.close();
}
