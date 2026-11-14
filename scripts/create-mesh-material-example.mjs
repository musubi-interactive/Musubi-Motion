import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "examples", "textures");
const server = await createServer({
  root, configLoader: "runner", cacheDir: join(process.env.TEMP ?? root, "mesh-material-example-cache"),
  server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { createMeshPrimitive } = await server.ssrLoadModule("/src/mesh-modeling.ts");
  const { setMeshMaterialTexture } = await server.ssrLoadModule("/src/mesh-materials.ts");
  const { prepareTexture, addTexture } = await server.ssrLoadModule("/src/texture-assets.ts");
  const { encodeProjectBlob, decodeProjectBlob } = await server.ssrLoadModule("/src/project-archive.ts");
  const checker = await readFile(join(out, "musubi-checker.png"));
  const thumbnail = `data:image/png;base64,${checker.toString("base64")}`;
  const asset = await prepareTexture(new File([checker], "Musubi Checker.png"), "color", async () => ({ alpha: true, thumbnail }));
  const store = createSceneStore();
  createMeshPrimitive(store, "plane", { name: "Texture Plane", size: 3, rotation: [90, 0, 0], color: "#ffffff" });
  const library = addTexture(store.getState().document, asset);
  const shape = Object.values(library.nodes).find(node => node.type === "meshShape");
  const target = { shapeId: shape.id, index: 0, slot: "map" };
  const assigned = setMeshMaterialTexture(library, target, { assetId: asset.id });
  const scene = setMeshMaterialTexture(assigned, target, { settings: { wrapS: 1000, repeat: [2, 1], filter: "nearest" } });
  const editor = { camera: { position: [0, 0, 6], target: [0, 0, 0], view: "front", height: 5, fov: 42, near: .01, far: 1000 }, time: 0 };
  const blob = await encodeProjectBlob(scene, new Map(), editor);
  await decodeProjectBlob(blob);
  await writeFile(join(out, "mesh-materials.msb"), Buffer.from(await blob.arrayBuffer()));
  console.log("Generated the original textured plane MSB.");
} finally {
  await server.close();
}
