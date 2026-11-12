import { createServer } from "vite";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const benchmark = process.argv[2] === "--benchmark";
const destination = benchmark ? resolve(process.argv[3]) : resolve(root, "examples/splat-attribute-paint.msb");
const server = await createServer({ root, configLoader: "runner", cacheDir: resolve(process.env.TEMP ?? root, "attribute-paint-example"),
  server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const load = name => server.ssrLoadModule("/src/" + name + ".ts");
  const { addSplat, emptyScene } = await load("scene-document");
  const { defaultAnimation } = await load("animation");
  const { defaultSplatPaintSettings, withSplatPaintStroke } = await load("splat-attribute-paint");
  const { encodeProject, decodeProject } = await load("project-archive");
  const columns = benchmark ? 96 : 13, rows = benchmark ? 128 : 13, patch = columns * rows, count = 4 * patch + 2;
  const bytes = new Uint8Array(count * 32), view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index++) {
    const offset = index * 32, local = index % patch, side = Math.floor(index / patch) % 2;
    const row = Math.floor(local / columns), column = local % columns, front = index < 2 * patch;
    const center = index >= count - 2 ? [0, index === count - 2 ? -.68 : .68, 0]
      : [(side ? .66 : -.66) + (column / (columns - 1) - .5) * .48, (row / (rows - 1) - .5) * .48, front ? .18 : -.18];
    const radius = benchmark ? .0022 : .013;
    [...center, radius, radius, radius / 2].forEach((value, axis) => view.setFloat32(offset + axis * 4, value, true));
    bytes.set([...(front || index >= count - 2 ? [170, 176, 182] : [62, 109, 172]), 255, 255, 128, 128, 128], offset + 24);
  }
  const asset = { id: "paint-source", kind: "file", fileName: "original-attribute-paint.splat", byteLength: bytes.length };
  const { document } = addSplat(emptyScene(), asset, "Paint Reference", [0, 0, 0], "paint", "paint-shape");
  const shape = document.nodes["paint-shape"];
  const mask = {
    version: 1, id: "paint-left", name: "Left Patch", assetId: asset.id, sourceCount: count, locked: false,
    data: { kind: "sparse", defaultValue: 0, indices: Array.from({ length: 2 * patch }, (_, i) => i % patch + (i < patch ? 0 : 2 * patch)),
      values: new Array(2 * patch).fill(1) },
    componentLocks: [],
  };
  const key = (time, value) => ({ id: "pose-" + time, time, value, interpolation: "linear", tangentMode: "auto" });
  const attributePaint = withSplatPaintStroke(shape, count, { ...defaultSplatPaintSettings, color: "#2ad486" },
    { indices: Uint32Array.of(count - 2), values: Float32Array.of(1) });
  const scene = {
    ...document,
    ...(!benchmark ? {
      joints: [{ id: "paint-joint", name: "Paint Rig", parentId: null, position: [0, 0, 0] }],
      animation: { ...defaultAnimation(), end: 48, tracks: [{ id: "paint-joint-motion", targetId: "paint-joint", channel: "position.y", keys: [key(0, 0), key(24, .35), key(48, 0)] }] },
    } : {}),
    nodes: { ...document.nodes, [shape.id]: { ...shape, attributePaint, scalarMasks: [mask],
      componentEdits: { version: 1, sourceCount: count, hidden: [], deleted: [count - 1, count] },
      ...(!benchmark ? { binding: { jointIds: ["paint-joint"], restMatrices: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]] } } : {}),
    } },
  };
  const editor = { camera: { position: [0, 0, 8], target: [0, 0, 0], view: "front", height: 3, fov: 42, near: .01, far: 1000 }, time: 0 };
  const archive = await encodeProject(scene, new Map([[asset.id, new File([bytes], asset.fileName)]]), editor);
  await decodeProject(archive);
  await writeFile(destination, archive);
  console.log("Wrote " + count + " original splats, two overlapping depths per patch and authored reference paint.");
} finally { await server.close(); }
