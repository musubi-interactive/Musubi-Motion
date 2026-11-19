import { Box3, Color, Quaternion, Vector3 } from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import { createServer } from "vite";

const server = await createServer({ appType: "custom", server: { middlewareMode: true } });
let mesh, transforms;
try {
  const { prepareSplat } = await server.ssrLoadModule("/src/splat-assets.ts");
  const { createSplatTransformRuntime } = await server.ssrLoadModule("/src/splat-transform-runtime.ts");
  const { getSplatDeformerDefinition } = await server.ssrLoadModule("/src/splat-deformers.ts");
  const count = 80_000;
  mesh = new SplatMesh({
    extSplats: true, covSplats: true,
    constructSplats(source) {
      const center = new Vector3(), scale = new Vector3(.01, .008, .006);
      const rotation = new Quaternion(), color = new Color(.8, .6, .45);
      for (let index = 0; index < count; index++) {
        const y = 2 * (Math.floor(index / 200) / 399 - .5), angle = (index % 200) * Math.PI / 100;
        const radius = .23 + .12 * Math.sin(3 * y + 1) + .1 * Math.max(0, Math.cos(angle)) ** 8;
        source.pushSplat(center.set(radius * Math.cos(angle), y, radius * Math.sin(angle)), scale, rotation, .9, color);
      }
    },
  });
  await prepareSplat(mesh);
  transforms = createSplatTransformRuntime(mesh);
  const bounds = new Box3(new Vector3(-.65, -1, -.5), new Vector3(.65, 1, .5));
  const settings = [{ curvature: 75 }, { startAngle: -60, endAngle: 120 }, { factor: -1.2, expand: 1.6, preserveVolume: true }];
  const stack = ["bend", "twist", "squash"].map((kind, i) => ({
    id: kind, name: kind, kind, sourceCount: count, envelope: .6,
    params: { ...getSplatDeformerDefinition(kind).create(bounds), ...settings[i] },
  }));
  stack[0].keys = [{ frame: 0, value: -100 }, { frame: 12, value: 150 }, { frame: 210, value: -160 }]
    .map(key => ({ ...key, channel: "curvature" }));
  const times = [];
  for (let frame = 0; frame < 30; frame++) {
    const start = performance.now();
    transforms.update(undefined, stack, undefined, frame);
    if (frame >= 5) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ originals: count, layers: stack.length, measuredFrames: times.length,
    medianMs: Number(times[12].toFixed(2)), p95Ms: Number(times[23].toFixed(2)),
    measures: "CPU pose evaluation and packing. Browser scheduling, GPU uploads, sorting and drawing are excluded." }, null, 2));
} finally {
  transforms?.dispose();
  mesh?.dispose();
  await server.close();
}
