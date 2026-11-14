import { ClampToEdgeWrapping, Color, DoubleSide, LinearFilter, LinearMipmapLinearFilter, Material, MeshStandardMaterial, NearestFilter, NoColorSpace, SRGBColorSpace, Texture, TextureLoader, Vector2, Vector3, type Side, type Wrapping } from "three";
import type { MeshShapeNode, SceneDocument } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import type { TextureAsset } from "./texture-assets.ts";

export type MeshTextureData = {
  dataURI?: string;
  assetId?: string;
  wrapS: number; wrapT: number;
  repeat: [number, number]; offset: [number, number]; center: [number, number];
  rotation: number; flipY: boolean; channel: number;
  colorSpace?: "srgb" | "raw";
  filter?: "nearest" | "linear" | "mipmap";
  useImageAlpha?: boolean;
};
export type MeshMaterialData = {
  name: string; color: string; emissive: string; emissiveIntensity: number;
  roughness: number; metalness: number; opacity: number; transparent: boolean;
  alphaTest: number; side: number; depthWrite: boolean; normalScale: [number, number]; bumpScale?: number;
  map?: MeshTextureData; emissiveMap?: MeshTextureData; normalMap?: MeshTextureData;
  roughnessMap?: MeshTextureData; metalnessMap?: MeshTextureData; alphaMap?: MeshTextureData; bumpMap?: MeshTextureData;
};
export const MESH_TEXTURE_SLOTS = ["map", "emissiveMap", "normalMap", "roughnessMap", "metalnessMap", "alphaMap", "bumpMap"] as const;
type Slot = typeof MESH_TEXTURE_SLOTS[number];
export const EDITABLE_TEXTURE_SLOTS = ["map", "alphaMap", "normalMap", "roughnessMap"] as const;
export type EditableTextureSlot = typeof EDITABLE_TEXTURE_SLOTS[number];
export type TextureUVField = "repeatU" | "repeatV" | "offsetU" | "offsetV" | "centerU" | "centerV" | "rotation";
export type MeshTextureSettings = Partial<Pick<MeshTextureData, "wrapS" | "wrapT" | "repeat" | "offset" | "center" | "rotation" | "channel" | "flipY" | "colorSpace" | "filter">>;
export type MaterialTextureTarget = { shapeId: string; index: number; slot: EditableTextureSlot };
type TextureLibrary = Readonly<Record<string, TextureAsset>>;
const dataURI = /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/;
const finite = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
const pair = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && value.every(n => finite(n, -1e6, 1e6));
const hex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

export function validateMeshMaterials(value: unknown): asserts value is MeshMaterialData[] {
  if (!Array.isArray(value) || !value.length || value.length > 256) throw Error("Meshes require between 1 and 256 materials.");
  for (const material of value) {
    if (!material || typeof material !== "object" || typeof material.name !== "string" || material.name.length > 200
      || !hex(material.color) || !hex(material.emissive) || !finite(material.emissiveIntensity, 0, 1e6)
      || !finite(material.roughness, 0, 1) || !finite(material.metalness, 0, 1) || !finite(material.opacity, 0, 1)
      || typeof material.transparent !== "boolean" || !finite(material.alphaTest, 0, 1)
      || ![0, 1, 2].includes(material.side) || typeof material.depthWrite !== "boolean" || !pair(material.normalScale)
      || (material.bumpScale !== undefined && !finite(material.bumpScale, -1e6, 1e6)))
      throw Error("Invalid mesh material.");
    for (const slot of MESH_TEXTURE_SLOTS) {
      const texture = material[slot]; if (texture === undefined) continue;
      if (!texture || typeof texture !== "object" || !(typeof texture.dataURI === "string" && texture.dataURI.length <= 32 * 1024 * 1024 && dataURI.test(texture.dataURI) && texture.assetId === undefined
          || typeof texture.assetId === "string" && /^tex_[a-f0-9]{64}$/.test(texture.assetId) && texture.dataURI === undefined) || ![1000, 1001, 1002].includes(texture.wrapS) || ![1000, 1001, 1002].includes(texture.wrapT)
        || !pair(texture.repeat) || !pair(texture.offset) || !pair(texture.center) || !finite(texture.rotation, -1e6, 1e6)
        || typeof texture.flipY !== "boolean" || !Number.isInteger(texture.channel) || texture.channel < 0 || texture.channel > 3
        || (texture.colorSpace !== undefined && !(texture.colorSpace === "raw" || texture.colorSpace === "srgb" && (slot === "map" || slot === "emissiveMap")))
        || (texture.filter !== undefined && !["nearest", "linear", "mipmap"].includes(texture.filter))
        || (texture.useImageAlpha !== undefined && (typeof texture.useImageAlpha !== "boolean" || slot !== "map" && slot !== "alphaMap")))
        throw Error("Invalid mesh texture: only embedded raster images are supported.");
    }
  }
}

export function materialTextureColorSpace(texture: MeshTextureData, slot: Slot): "srgb" | "raw" {
  return texture.colorSpace ?? (slot === "map" || slot === "emissiveMap" ? "srgb" : "raw");
}

export function materialBlendsAlpha(material: MeshMaterialData, assets?: TextureLibrary): boolean {
  const baseAlpha = material.map?.useImageAlpha && material.map.assetId && assets?.[material.map.assetId]?.alpha;
  return material.transparent || (material.alphaTest === 0 && Boolean(baseAlpha || material.alphaMap?.useImageAlpha));
}

let rasterContext: WebGL2RenderingContext | null = null;

/** Read the same unpremultiplied RGBA8 texels as Three uploads for these image maps. */
export function readMeshTexturePixels(image: TexImageSource, width: number, height: number): Uint8Array<ArrayBuffer> {
  if (!rasterContext || rasterContext.isContextLost()) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    rasterContext = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false });
  }
  const gl = rasterContext;
  if (!gl) throw Error("WebGL2 is required to read material texture channels.");
  const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (width < 1 || height < 1 || width * height > 16_777_216 || width > limit || height > limit)
    throw Error("Material texture exceeds the supported pixel count or GPU dimension limit.");
  const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
  try {
    if (!texture || !framebuffer) throw Error("Could not allocate material texture readback.");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw Error("Could not read the material texture pixels.");
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError() !== gl.NO_ERROR) throw Error("Could not read the material texture pixels.");
    return pixels;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  }
}

export function applyMeshTextureUV(texture: Texture, source: MeshTextureData): void {
  texture.repeat.fromArray(source.repeat);
  texture.offset.fromArray(source.offset);
  texture.center.fromArray(source.center);
  texture.rotation = source.rotation;
  texture.updateMatrix();
}

export function meshTextureUVEdit(source: MeshTextureData, field: TextureUVField, value: number): MeshTextureSettings {
  if (field === "rotation") return { rotation: value };
  const key = field.slice(0, -1) as "repeat" | "offset" | "center";
  const pair: [number, number] = [...source[key]];
  pair[field.endsWith("U") ? 0 : 1] = value;
  return { [key]: pair };
}

export function meshUVCoordinates(shape: MeshShapeNode, channel: number) {
  return channel === 0 ? shape.uvs : shape.uvSets?.[String(channel)];
}

export function meshMaterialSlots(shape: MeshShapeNode): MeshMaterialData[] {
  return shape.materials ?? [{
    name: "Default Material", color: shape.color, emissive: "#000000", emissiveIntensity: 1,
    roughness: .8, metalness: 0, opacity: 1, transparent: false, alphaTest: 0,
    side: DoubleSide, depthWrite: true, normalScale: [1, 1],
  }];
}

/** Give a bare single planar polygon UV0 on first assignment. Multi-face UV authoring is separate. */
function planarUVs(shape: MeshShapeNode): MeshShapeNode["uvs"] {
  if (shape.skin || shape.morphTargets || shape.faces.length !== 1) return;
  const vertices = new Map(shape.vertices.map(vertex => [vertex.id, vertex.position]));
  const ids = shape.faces[0].vertices;
  if (ids.length !== vertices.size) return;
  const origin = new Vector3(...vertices.get(ids[0])!);
  const points = ids.map(id => new Vector3(...vertices.get(id)!).sub(origin));
  const u = points[1].clone().normalize(), normal = new Vector3();
  for (let i = 1; i < points.length - 1; i++) normal.add(new Vector3().crossVectors(points[i], points[i + 1]));
  if (!u.lengthSq() || !normal.lengthSq()) return;
  normal.normalize();
  const v = new Vector3().crossVectors(normal, u).normalize();
  const scale = Math.max(...points.map(point => point.length()));
  if (points.some(point => Math.abs(point.dot(normal)) > scale * 1e-8)) return;
  const uv = points.map(point => [point.dot(u), point.dot(v)] as const);
  const minU = Math.min(...uv.map(point => point[0])), minV = Math.min(...uv.map(point => point[1]));
  const width = Math.max(...uv.map(point => point[0])) - minU, height = Math.max(...uv.map(point => point[1])) - minV;
  if (!width || !height) return;
  return Object.fromEntries(ids.map((id, i) => [id, [(uv[i][0] - minU) / width, (uv[i][1] - minV) / height]]));
}

const settingKeys = ["wrapS", "wrapT", "repeat", "offset", "center", "rotation", "channel", "flipY", "colorSpace", "filter"] as const;
type TextureEdit = { assetId: string | null } | { settings: MeshTextureSettings };

export function setMeshMaterialTexture(doc: SceneDocument, target: MaterialTextureTarget, edit: TextureEdit): SceneDocument {
  const { shapeId, index, slot } = target, shape = doc.nodes[shapeId];
  if (shape?.type !== "meshShape") throw Error("Select one polygon mesh.");
  if (!EDITABLE_TEXTURE_SLOTS.includes(slot)) throw Error("Choose an editable texture slot.");
  const materials = meshMaterialSlots(shape), material = materials[index];
  if (!Number.isInteger(index) || !material) throw Error("The selected material slot no longer exists.");
  const source = material[slot];
  let uvs = shape.uvs, next: MeshTextureData | undefined;
  if ("assetId" in edit) {
    if (edit.assetId === null && !source) return doc;
    if (edit.assetId !== null) {
      const asset = typeof edit.assetId === "string" && doc.textureAssets?.[edit.assetId];
      if (!asset) throw Error("The texture asset is missing. Import it in Texture Assets first.");
      if (source?.assetId === asset.id) return doc;
      const previous: MeshTextureData = source ?? {
        repeat: [1, 1], offset: [0, 0], center: [0, 0],
        rotation: 0, flipY: true, channel: 0, wrapS: ClampToEdgeWrapping, wrapT: ClampToEdgeWrapping,
      };
      const { dataURI: _embedded, ...sampler } = previous;
      next = {
        ...sampler, assetId: asset.id,
        colorSpace: slot === "map" ? source?.colorSpace ?? (asset.role === "color" ? "srgb" : "raw") : "raw",
        ...(slot === "map" || slot === "alphaMap" ? { useImageAlpha: true } : {}),
      };
      if (next.channel === 0 && !uvs) uvs = planarUVs(shape);
    }
  } else {
    if (!source) throw Error("Assign an image before editing its mapping.");
    const { settings } = edit;
    if (!settings || Object.keys(settings).some(key => !(settingKeys as readonly string[]).includes(key)))
      throw Error("Invalid texture mapping settings.");
    next = { ...source, ...structuredClone(settings) };
  }
  const replacement = { ...material };
  if (next) replacement[slot] = next;
  else delete replacement[slot];
  validateMeshMaterials([replacement]);
  if (next) {
    meshTextureURI(next, doc.textureAssets);
    if (!(next.channel === 0 ? uvs : meshUVCoordinates(shape, next.channel))) {
      throw Error(`UV set ${next.channel} is missing. Assign a mesh UV set or use a single planar face.`);
    }
  }
  if (JSON.stringify(next) === JSON.stringify(source)) return doc;
  const updated = materials.slice();
  updated[index] = replacement;
  return { ...doc, nodes: { ...doc.nodes, [shapeId]: { ...shape, materials: updated, uvs } } };
}

export function commitMeshMaterialTexture(store: SceneStore, target: MaterialTextureTarget, edit: TextureEdit) {
  const before = store.getState().document, document = setMeshMaterialTexture(before, target, edit);
  if (document === before) return false;
  const editLabel = "settings" in edit ? "Edit texture mapping" : edit.assetId === null ? "Clear material texture" : "Assign material texture";
  store.setState({ document, editLabel });
  return true;
}

function captureTexture(texture: Texture | undefined | null): MeshTextureData | undefined {
  const uri = texture?.userData.musubiDataURI;
  if (!texture || typeof uri !== "string" || !dataURI.test(uri)) return undefined;
  return { dataURI: uri, wrapS: texture.wrapS, wrapT: texture.wrapT,
    repeat: texture.repeat.toArray(), offset: texture.offset.toArray(), center: texture.center.toArray(),
    rotation: texture.rotation, flipY: texture.flipY, channel: texture.channel };
}

/** Convert common FBX Phong/Lambert properties to the native standard material. */
export function captureMaterials(materials: Material[]): MeshMaterialData[] {
  const captured = materials.map(material => {
    const m = material as Material & Partial<Record<Slot, Texture | null>> & {
      color?: Color; emissive?: Color; emissiveIntensity?: number; roughness?: number; metalness?: number; shininess?: number; normalScale?: Vector2; bumpScale?: number;
    };
    const result: MeshMaterialData = {
      name: m.name.slice(0, 200), color: `#${(m.color ?? new Color(0xffffff)).getHexString()}`,
      emissive: `#${(m.emissive ?? new Color(0)).getHexString()}`, emissiveIntensity: m.emissiveIntensity ?? 1,
      roughness: m.roughness ?? (m.shininess === undefined ? .8 : Math.max(.04, Math.min(1, Math.sqrt(2 / (m.shininess + 2))))),
      metalness: m.metalness ?? 0, opacity: m.opacity, transparent: m.transparent, alphaTest: m.alphaTest,
      side: m.side, depthWrite: m.depthWrite, normalScale: m.normalScale?.toArray() ?? [1, 1],
      ...(m.bumpScale !== undefined ? { bumpScale: m.bumpScale } : {}),
    };
    for (const slot of MESH_TEXTURE_SLOTS) {
      const texture = captureTexture(m[slot]); if (texture) result[slot] = texture;
    }
    return result;
  });
  validateMeshMaterials(captured); return captured;
}

/** Conservative image check: unknown/unreadable textures retain their authored blending. */
const opaqueGreen = new WeakMap<TextureAsset, boolean>();
function opaqueTextureChannel(texture: Texture | null, channel: 1 | 3, asset?: TextureAsset): boolean {
  if (!texture) return true;
  if (channel === 3 && asset) return !asset.alpha;
  const cached = asset ? opaqueGreen.get(asset) : undefined;
  if (cached !== undefined) return cached;
  const image = texture.image;
  const width = image?.naturalWidth ?? image?.width, height = image?.naturalHeight ?? image?.height;
  if (!width || !height || width * height > 16_777_216 || typeof document === "undefined") return false;
  try {
    const pixels = readMeshTexturePixels(image, width, height);
    let opaque = true;
    for (let i = channel; i < pixels.length; i += 4) {
      if (pixels[i] !== 255) { opaque = false; break; }
    }
    if (asset) opaqueGreen.set(asset, opaque);
    return opaque;
  } catch { return false; }
}

/** The only loadable sources are validated data URIs; never resolve file or web URLs. */
export function createMaterials(data: MeshMaterialData[], flat: boolean, wire: boolean, assets?: TextureLibrary): MeshStandardMaterial[] {
  validateMeshMaterials(data);
  return data.map(d => {
    const transparent = materialBlendsAlpha(d, assets);
    const material = new MeshStandardMaterial({ color: d.color, emissive: d.emissive, emissiveIntensity: d.emissiveIntensity,
      roughness: d.roughness, metalness: d.metalness, opacity: d.opacity, transparent, alphaTest: d.alphaTest,
      side: d.side as Side, depthWrite: transparent && !d.transparent ? false : d.depthWrite, normalScale: new Vector2(...d.normalScale),
      bumpScale: d.bumpScale ?? 1,
      flatShading: flat, polygonOffset: wire, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    material.name = d.name;
    let disposed = false;
    material.addEventListener("dispose", () => { disposed = true; });
    const updateBlending = () => {
      if (disposed || !transparent) return;
      // Opaque FBX parts sometimes carry transparent=true. Put those parts in
      // Three's opaque pass so their depth is available when Spark blends splats.
      const baseAsset = d.map?.assetId ? assets?.[d.map.assetId] : undefined;
      const opacityAsset = d.alphaMap?.assetId ? assets?.[d.alphaMap.assetId] : undefined;
      const opaque = d.opacity === 1 && opaqueTextureChannel(material.map, 3, baseAsset) && opaqueTextureChannel(material.alphaMap, 1, opacityAsset);
      const blend = !opaque;
      if (material.transparent !== blend) {
        material.transparent = blend;
        material.depthWrite = blend && !d.transparent ? false : d.depthWrite;
        material.needsUpdate = true;
      }
    };
    for (const slot of MESH_TEXTURE_SLOTS) {
      const source = d[slot]; if (!source) continue;
      const uri = meshTextureURI(source, assets);
      // Headless conversion/tests retain the serializable source without decoding.
      const texture = typeof document === "undefined" ? new Texture() : new TextureLoader().load(uri, () => { if (slot === "map" || slot === "alphaMap") updateBlending(); });
      texture.userData.musubiDataURI = uri;
      texture.wrapS = source.wrapS as Wrapping; texture.wrapT = source.wrapT as Wrapping;
      applyMeshTextureUV(texture, source);
      texture.flipY = source.flipY; texture.channel = source.channel;
      texture.colorSpace = materialTextureColorSpace(source, slot) === "srgb" ? SRGBColorSpace : NoColorSpace;
      texture.magFilter = source.filter === "nearest" ? NearestFilter : LinearFilter;
      texture.minFilter = source.filter === "nearest" ? NearestFilter : source.filter === "linear" ? LinearFilter : LinearMipmapLinearFilter;
      texture.generateMipmaps = texture.minFilter === LinearMipmapLinearFilter;
      material[slot] = texture;
    }
    updateBlending();
    return material;
  });
}

/** Dispose shared material/texture instances once, including imported source maps. */
export function disposeMaterials(input: Material | Material[]) {
  const textures = new Set<Texture>();
  for (const material of new Set(Array.isArray(input) ? input : [input])) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    material.dispose();
  }
  textures.forEach(texture => texture.dispose());
}

/** Resolve only embedded validated sources; never fetch a filesystem or network path. */
export function meshTextureURI(source: MeshTextureData, assets?: TextureLibrary): string {
  const uri = source.assetId ? assets?.[source.assetId]?.dataURI : source.dataURI;
  if (!uri || !dataURI.test(uri)) throw Error("Missing texture asset. Relink the material texture before continuing.");
  return uri;
}
