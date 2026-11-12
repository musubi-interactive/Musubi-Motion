import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const toolsDirectory = new URL("./tools/", import.meta.url);
const toolsLauncher = fileURLToPath(new URL("index.html", toolsDirectory));
const toolEntries = existsSync(toolsDirectory)
  ? readdirSync(toolsDirectory, { withFileTypes: true })
    .filter(directory => directory.isDirectory())
    .map(directory => fileURLToPath(new URL(`${encodeURIComponent(directory.name)}/index.html`, toolsDirectory)))
    .filter(entry => existsSync(entry))
  : [];

export default defineConfig({
  build: { rolldownOptions: { input: [
    fileURLToPath(new URL("./index.html", import.meta.url)),
    ...(existsSync(toolsLauncher) ? [toolsLauncher] : []),
    ...toolEntries,
  ] } },
  // Discover the complete importer/archive graph at startup, avoiding a dependency
  // optimization restart when the first FBX is selected in a running editor.
  optimizeDeps: { include: ["three/addons/loaders/FBXLoader.js", "@zip.js/zip.js", "@noble/hashes/sha2.js"] },
  test: { server: { deps: { inline: ["zundo"] } } },
  // Example generators load the editor commands through Vite's server loader.
  // Keep the framework-free Zustand alias effective inside Zundo there too.
  ssr: { noExternal: ["zundo"] },
  resolve: {
    // Zundo imports createStore from Zustand's root (which also exports React hooks).
    // This editor uses the same public store API from the framework-free entry point.
    alias: [{ find: /^zustand$/, replacement: "zustand/vanilla" }],
  },
});
