import { compileGraph, type GraphProgram, type PixelSource } from "./procedural-graph-runtime.ts";
import { createGraphNode, type ProceduralGraph } from "./procedural-graph.ts";
import type { MeshShapeNode, SceneDocument, Vec3 } from "./scene-document.ts";
import type { TextureAsset } from "./texture-assets.ts";

/** Candidate density, never an amplification of the emitter's bounded base rate. */
export type ParticleEmissionMap = {
  enabled: boolean;
  source: "image" | "graph";
  assetId: string;
  projection: "uv" | "xy" | "xz" | "yz";
  bounds: [number, number, number, number];
  channel: "luminance" | "alpha";
  invert: boolean;
  strength: number;
};
export const PARTICLE_MAP_PIXELS = 8_388_608;
export function defaultParticleEmissionMap(): ParticleEmissionMap {
  return { enabled: false, source: "image", assetId: "", projection: "xz", bounds: [-.5, -.5, .5, .5], channel: "luminance", invert: false, strength: 1 };
}
export function validateParticleEmissionMap(value: unknown): asserts value is ParticleEmissionMap {
  const m = value as ParticleEmissionMap;
  if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).sort().join() !== "assetId,bounds,channel,enabled,invert,projection,source,strength"
    || typeof m.enabled !== "boolean" || !["image", "graph"].includes(m.source) || typeof m.assetId !== "string"
    || m.assetId !== "" && !/^tex_[a-f0-9]{64}$/.test(m.assetId) || !["uv", "xy", "xz", "yz"].includes(m.projection)
    || !["luminance", "alpha"].includes(m.channel) || typeof m.invert !== "boolean" || !Number.isFinite(m.strength) || m.strength < 0 || m.strength > 1
    || !Array.isArray(m.bounds) || m.bounds.length !== 4 || m.bounds.some(n => !Number.isFinite(n) || Math.abs(n) > 1e6)
    || m.bounds[2] <= m.bounds[0] || m.bounds[3] <= m.bounds[1]) throw Error("Invalid texture emission map. Density strength must be 0–1 and projection bounds must have positive finite extent.");
}
export function particleMapReferences(doc: SceneDocument, id: string) {
  return Object.values(doc.nodes).filter(n => n.type === "particleShape" && n.emissionMap?.source === "image" && n.emissionMap.assetId === id);
}
export function particleMapProgram(doc: SceneDocument, map: ParticleEmissionMap): GraphProgram {
  if (map.source === "graph") {
    if (!doc.proceduralGraph) throw Error("Texture emission needs a Texture Graph. Create one in View > Texture Graph.");
    return compileGraph(doc.proceduralGraph, doc.textureAssets);
  }
  const asset = doc.textureAssets?.[map.assetId];
  if (!asset) throw Error("Texture emission references a missing image. Choose an image from Texture Assets.");
  const texture = createGraphNode("texture", "particle_image", 0, 0); if (texture.kind === "texture") texture.params.assetId = asset.id;
  const graph: ProceduralGraph = { nodes: [texture, createGraphNode("output", "particle_output", 300, 0)], edges: [
    { from: { node: texture.id, port: "color" }, to: { node: "particle_output", port: "color" } },
    { from: { node: texture.id, port: "alpha" }, to: { node: "particle_output", port: "alpha" } },
  ] };
  return compileGraph(graph, doc.textureAssets);
}
export function validateParticleMapSource(doc: SceneDocument, map: ParticleEmissionMap, source: MeshShapeNode) {
  validateParticleEmissionMap(map);
  // Retain image references even while disabled, so relink/delete stays safe.
  if (map.source === "image" && map.assetId && !doc.textureAssets?.[map.assetId]) throw Error("Particle texture emission references a missing image asset.");
  if (!map.enabled) return;
  if (map.projection === "uv" && !source.uvs) throw Error("Texture emission requires mesh UV coordinates. Choose an explicit local projection or author UVs first.");
  const program = particleMapProgram(doc, map);
  if (program.images.reduce((sum, asset) => sum + asset.width * asset.height, 0) > PARTICLE_MAP_PIXELS) throw Error("Particle emission maps support at most 8,388,608 decoded pixels. Resize the source images.");
  return program;
}
export function particleMapUV(map: ParticleEmissionMap, position: Vec3, uv: [number, number]): [number, number] {
  if (map.projection === "uv") return uv;
  const axes = map.projection === "xy" ? [0, 1] : map.projection === "xz" ? [0, 2] : [1, 2];
  return [(position[axes[0]] - map.bounds[0]) / (map.bounds[2] - map.bounds[0]), (position[axes[1]] - map.bounds[1]) / (map.bounds[3] - map.bounds[1])];
}
export function particleMapDensity(map: ParticleEmissionMap, rgba: readonly number[]): number {
  const value = map.channel === "alpha" ? rgba[3] : (rgba[0] + rgba[1] + rgba[2]) / 3;
  if (!Number.isFinite(value)) throw Error("Texture emission produced a non-finite density.");
  const density = Math.min(1, Math.max(0, value));
  return map.strength * (map.invert ? 1 - density : density);
}
/** A separate RNG stream leaves Nebula's untextured emission untouched. */
export function particleCandidateRandom(seed: number, index: number) {
  let state = (Math.imul(seed ^ 0xa511e9b3, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca77)) >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let bits = Math.imul(state ^ state >>> 15, state | 1); bits ^= bits + Math.imul(bits ^ bits >>> 7, bits | 61); return ((bits ^ bits >>> 14) >>> 0) / 4294967296; };
}
export async function decodeParticleMapImages(assets: readonly TextureAsset[], check: () => void): Promise<ReadonlyMap<string, PixelSource>> {
  if (assets.reduce((n, a) => n + a.width * a.height, 0) > PARTICLE_MAP_PIXELS) throw Error("Particle emission map pixel budget exceeded.");
  const pixels = new Map<string, PixelSource>();
  for (const asset of assets) {
    check();
    const image = new Image(), canvas = document.createElement("canvas"); image.src = asset.dataURI;
    try {
      await image.decode(); check();
      if (image.naturalWidth !== asset.width || image.naturalHeight !== asset.height) throw Error("Particle map image dimensions do not match the authored asset.");
      canvas.width = asset.width; canvas.height = asset.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw Error("Could not decode particle map pixels.");
      context.drawImage(image, 0, 0);
      pixels.set(asset.id, { width: asset.width, height: asset.height, rgba: context.getImageData(0, 0, asset.width, asset.height).data });
    } finally { image.removeAttribute("src"); canvas.width = canvas.height = 0; }
  }
  check(); return pixels;
}
