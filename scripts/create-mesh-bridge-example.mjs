import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, configLoader: "runner", server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });

try {
  const { bridgeFixtureScene } = await server.ssrLoadModule("/src/mesh-bridge-fixtures.ts");
  const { encodeProject, decodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const scene = bridgeFixtureScene();
  const bytes = await encodeProject(scene, new Map(), {
    camera: { position: [2.9, 2.5, 8.4], target: [0, 0, 0], fov: 41, near: .01, far: 1000 }, time: 0,
  });
  assert.deepEqual((await decodeProject(bytes)).scene, scene);
  await writeFile(new URL("../examples/modeling/mesh-bridge.msb", import.meta.url), bytes);
  console.log(`Wrote and verified examples/modeling/mesh-bridge.msb (${bytes.length} bytes).`);
} finally {
  await server.close();
}
