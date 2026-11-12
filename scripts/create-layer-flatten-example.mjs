import { writeFile } from "node:fs/promises";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { addSplat, emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { validateAnimation } = await server.ssrLoadModule("/src/animation.ts");
  const { encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const targetId = "bake-knot";
  const scene = addSplat(emptyScene(), { id: "bake-procedural-knot", kind: "procedural", generator: "knot-v1" },
    "Layer Bake Knot", [0, 0, 0], targetId, "bake-knot-shape").document;
  const layer = (id, name, options = {}) => ({ id, name, mode: "additive", weight: 1, mute: false, solo: false, locked: false, ...options });
  const keys = (prefix, samples) => samples.map(([time, value, options], index) => ({
    id: `${prefix}-key-${index}`, time, value, interpolation: "linear", tangentMode: "auto", ...options,
  }));
  const track = (id, channel, samples, layerId) => ({
    id, targetId, channel, keys: keys(id, samples), ...(layerId ? { layerId } : {}),
  });
  const accent = layer("accent", "Animated Accent", { weight: 0, weightTrack: {
    id: "accent-weight", keys: keys("accent-weight", [[0, 0, { interpolation: "bezier", tangentMode: "fixed", outSlope: .015 }],
      [24, .65, { tangentMode: "fixed", inSlope: 0 }]]),
  } });
  scene.animation = {
    fps: 24, start: 0, end: 24, loop: true, activeLayerId: accent.id,
    layers: [accent, layer("shape", "Shape Override", { mode: "override", weight: .65 }), layer("finish", "Retained Finish", { weight: .3 })],
    tracks: [
      track("base-translate", "position.x", [[0, -1], [24, .5]]),
      track("accent-translate", "position.x", [[0, 0], [24, 2]], "accent"),
      track("accent-rotate", "rotation.z", [[0, -20], [24, 140]], "accent"),
      track("shape-translate", "position.x", [[0, .2], [24, 1.4]], "shape"),
      track("shape-scale", "scale.x", [[0, .8], [24, 1.25]], "shape"),
      track("shape-visibility", "visibility", [[0, 1], [12.375, 0, { interpolation: "step" }], [16.5, 1]], "shape"),
      track("finish-rotate", "rotation.z", [[0, 10], [24, 50]], "finish"),
    ],
  };
  validateAnimation(scene.animation, scene);
  const editor = { camera: { position: [3, 2, 7], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0 };
  const bytes = await encodeProject(scene, new Map(), editor);
  await writeFile("examples/layer-flatten-study.msb", bytes);
} finally {
  await server.close();
}
