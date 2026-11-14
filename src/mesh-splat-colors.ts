import { Color, Texture, Vector2 } from "three";
import type { MeshShapeNode } from "./scene-document";
import { applyMeshTextureUV, materialBlendsAlpha, materialTextureColorSpace, meshUVCoordinates, readMeshTexturePixels, validateMeshMaterials, meshTextureURI, type MeshTextureData } from "./mesh-materials";

export type SplatColorRaster = { width: number; height: number; data: Uint8ClampedArray };
type TriangleIds = [string, string, string];
type Barycentric = [number, number, number];

/** Pure CPU sampler; the texture matrix/wrap conventions match Three's mesh materials. */
export function sampleSplatTexture(raster: SplatColorRaster, source: MeshTextureData, uv: Vector2): Color {
  uv.applyMatrix3(cpuTextureMatrix(source));
  return rasterColor(raster, uv, source);
}

function cpuTextureMatrix(source: MeshTextureData) {
  const texture = new Texture();
  applyMeshTextureUV(texture, source);
  return texture.matrix;
}

function address(value: number, size: number, wrap: number) {
  if (wrap === 1000) return ((value % size) + size) % size;
  if (wrap === 1002) {
    const mirrored = ((value % (size * 2)) + size * 2) % (size * 2);
    return mirrored < size ? mirrored : size * 2 - mirrored - 1;
  }
  return Math.max(0, Math.min(size - 1, value));
}

function visitTexels(raster: SplatColorRaster, uv: Vector2, source: MeshTextureData, visit: (offset: number, weight: number) => void) {
  const index = (x: number, y: number) => {
    const row = address(y, raster.height, source.wrapT);
    const imageRow = source.flipY ? raster.height - 1 - row : row;
    return (imageRow * raster.width + address(x, raster.width, source.wrapS)) * 4;
  };
  if (source.filter === "nearest") {
    visit(index(Math.floor(uv.x * raster.width), Math.floor(uv.y * raster.height)), 1);
    return;
  }
  // Surface samples lack screen-space derivatives. Linear and mipmapped modes use
  // level zero, blending neighboring texels across repeat seams.
  const x = uv.x * raster.width - .5;
  const y = uv.y * raster.height - .5;
  const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top;
  visit(index(left, top), (1 - fx) * (1 - fy));
  visit(index(left + 1, top), fx * (1 - fy));
  visit(index(left, top + 1), (1 - fx) * fy);
  visit(index(left + 1, top + 1), fx * fy);
}

function rasterColor(raster: SplatColorRaster, uv: Vector2, source: MeshTextureData): Color {
  const result = new Color(0, 0, 0);
  const color = new Color(), srgb = materialTextureColorSpace(source, "map") === "srgb";
  visitTexels(raster, uv, source, (offset, weight) => {
    color.setRGB(raster.data[offset] / 255, raster.data[offset + 1] / 255, raster.data[offset + 2] / 255);
    if (srgb) color.convertSRGBToLinear();
    result.r += color.r * weight; result.g += color.g * weight; result.b += color.b * weight;
  });
  return result;
}

async function decodeRaster(dataURI: string, reserve: (pixels: number) => void): Promise<SplatColorRaster> {
  if (typeof document === "undefined" || typeof Image === "undefined") throw Error("Textured splat conversion requires a browser.");
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(Error("Could not decode the embedded material texture.")); image.src = dataURI; });
  const width = image.naturalWidth, height = image.naturalHeight;
  if (!width || !height || width * height > 16_777_216) throw Error("Material textures must be at most 16 million pixels for conversion.");
  reserve(width * height);
  return { width, height, data: new Uint8ClampedArray(readMeshTexturePixels(image, width, height).buffer) };
}

/** Raw alpha/opacity values are linear data, unlike base-color RGB. */
function rasterChannel(raster: SplatColorRaster, uv: Vector2, source: MeshTextureData, channel: number): number {
  let result = 0;
  visitTexels(raster, uv, source, (offset, weight) => { result += raster.data[offset + channel] / 255 * weight; });
  // Bilinear weights sum to one mathematically; roundoff can overshoot it.
  return Math.min(1, result);
}
export type SplatSurfaceAppearance = { color: Color; opacity: number };

/** Sample material appearance only where the mesh surface uses each texture. */
export async function createMeshSplatColors(shape: MeshShapeNode, assets?: Readonly<Record<string, import("./texture-assets.ts").TextureAsset>>) {
  if (shape.materials) validateMeshMaterials(shape.materials);
  const warnings = new Set<string>(), rasters = new Map<string, Promise<SplatColorRaster>>();
  let pixels = 0, decodeQueue: Promise<unknown> = Promise.resolve();
  function reserve(pendingPixels: number) {
    if (pixels + pendingPixels > 33_554_432) throw Error("Mesh-to-splat conversion supports up to 32 million decoded texture pixels per mesh.");
    pixels += pendingPixels;
  }
  const usedMaterials = shape.faces ? new Set(shape.faces.map(face => face.materialIndex ?? 0)) : undefined;
  async function prepareMap(source: MeshTextureData | undefined) {
    if (!source) return undefined;
    const coordinates = meshUVCoordinates(shape, source.channel);
    if (!coordinates) throw Error(`Texture uses a missing UV set (${source.channel}).`);
    for (const vertex of shape.vertices) if (!coordinates[vertex.id]) throw Error("Texture is missing mesh UV coordinates.");
    const uri = meshTextureURI(source, assets);
    if (!rasters.has(uri)) {
      const queued = decodeQueue.then(() => decodeRaster(uri, reserve));
      rasters.set(uri, queued);
      decodeQueue = queued;
    }
    const raster = await rasters.get(uri)!;
    const matrix = cpuTextureMatrix(source);
    return { raster, source, uv(ids: TriangleIds, bary: Barycentric) {
      const uv = new Vector2();
      ids.forEach((id, i) => { uv.x += coordinates[id][0]*bary[i]; uv.y += coordinates[id][1]*bary[i]; });
      return uv.applyMatrix3(matrix);
    } };
  }
  const entries = await Promise.all((shape.materials ?? []).map(async (material, index) => {
    if (usedMaterials && !usedMaterials.has(index)) return undefined;
    if (material.normalMap || material.bumpMap || material.roughnessMap || material.metalnessMap || material.metalness > 0) warnings.add("Only base color and opacity are converted; surface detail and reflections are not preserved.");
    if (material.emissiveMap || new Color(material.emissive).getHex() !== 0) warnings.add("Emissive appearance is not preserved.");
    const transparent = materialBlendsAlpha(material, assets);
    const [map, alphaMap] = await Promise.all([prepareMap(material.map), prepareMap(transparent || material.alphaTest > 0 ? material.alphaMap : undefined)]);
    return { material, map, alphaMap, transparent };
  }));
  const sampleSurface = (ids: TriangleIds, bary: Barycentric, materialIndex: number): SplatSurfaceAppearance => {
    if (!entries.length) return { color: new Color(shape.color), opacity: 1 };
    const entry = entries[materialIndex];
    if (!entry) throw Error("Triangle references a missing or unused material.");
    const { material, map, alphaMap, transparent } = entry;
    const color = new Color(material.color);
    let opacity = material.opacity;
    if (map) {
      const uv = map.uv(ids,bary);
      color.multiply(rasterColor(map.raster,uv,map.source));
      opacity *= rasterChannel(map.raster,uv,map.source,3);
    }
    if (alphaMap) opacity *= rasterChannel(alphaMap.raster,alphaMap.uv(ids,bary),alphaMap.source,1);
    if (opacity < material.alphaTest) return { color, opacity: 0 };
    // Three's opaque shader forces surviving fragments to alpha=1.
    return { color, opacity: transparent ? opacity : 1 };
  };
  return { warnings: [...warnings], sampleSurface,
    sample(ids: TriangleIds, bary: Barycentric, materialIndex: number): Color { return sampleSurface(ids,bary,materialIndex).color; },
  };
}
