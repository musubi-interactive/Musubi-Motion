import { validateCustomAttributes } from "./custom-attributes.ts";
import { validateSceneSplatMasks } from "./splat-masks.ts";
import { validateProceduralGraph } from "./procedural-graph.ts";
import { validateTextureAssets } from "./texture-assets.ts";
import { Matrix3 } from "three";
import { BlobReader, BlobWriter, ZipReader, type FileEntry } from "@zip.js/zip.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { validateJoints } from "./skeleton.ts";
import { validateElasticity } from "./elasticity";
import { validateSplatComponentTransforms, SPLAT_TRANSFORM_SCENE_LIMIT } from "./splat-component-transforms.ts";
import { validateSplatComponentEdits } from "./splat-component-edits.ts";
import { validateAnimation } from "./animation.ts";
import { validateDrivenKeys } from "./driven-keys.ts";
import { validateIKHandles } from "./ik.ts";
import { validateMeshShape } from "./mesh-modeling.ts";
import { validateMeshSkin } from "./mesh-skin.ts";
import { validateParticleShape, validateParticleEmitters } from "./particle-emitter.ts";
import { validateConstraints } from "./constraints.ts";
import { validateCurveShape } from "./controller-curves.ts";
import { validateSkinWeights } from "./skin-weights.ts";
import type { SceneDocument, Vec3 } from "./scene-document.ts";

// Retained as a compatibility export; project size is limited by the browser, not 512 MiB.
export const MAX_PROJECT_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_NODES = 10000;
export type EditorSnapshot = {
  camera: {
    position: Vec3;
    target: Vec3;
    fov: number;
    near: number;
    far: number;
    view?: import("./viewport-tools").ViewName;
    height?: number;
  };
  time: number;
};
type Manifest = {
  format: "musubi-project";
  version: 1;
  scene: SceneDocument;
  editor: EditorSnapshot;
  files: Record<string, { path: string; sha256: string }>;
};
const fail = (message: string): never => {
  throw new Error(message);
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Invalid project data.");
  return value as Record<string, unknown>;
}
function id(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    fail("Invalid object or asset ID.");
}
function vector(value: unknown): asserts value is Vec3 {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((n) => typeof n === "number" && Number.isFinite(n))
  )
    fail("Invalid transform or camera values.");
}
function finite(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail("Invalid numeric value.");
}
export function validateScene(value: unknown): SceneDocument {
  const doc = record(value);
  if (doc.joints !== undefined) validateJoints(doc.joints as import("./skeleton.ts").Joint[]);
  if (doc.format !== "musubi-scene" || doc.version !== 2)
    fail("Unsupported scene format or version. This build opens musubi-scene version 2; recreate or re-export older projects with a compatible build.");
  if (doc.upAxis !== "Y" || doc.units !== "unitless")
    fail("Unsupported scene units or axis.");
  if (doc.textureAssets !== undefined) validateTextureAssets(doc.textureAssets);
  if (doc.proceduralGraph !== undefined) validateProceduralGraph(doc.proceduralGraph, doc.textureAssets as SceneDocument["textureAssets"]);
  const nodes = record(doc.nodes),
    assets = record(doc.assets);
  for (const joint of (doc.joints ?? []) as import("./skeleton.ts").Joint[]) {
    id(joint.id);
    if (Object.hasOwn(nodes, joint.id)) fail("Joint IDs must not collide with scene node IDs.");
  }
  if (
    Object.keys(nodes).length > MAX_NODES ||
    Object.keys(assets).length > MAX_NODES
  )
    fail("Too many scene objects.");
  const parents = new Map<string, string | null>(),
    shapeCounts = new Map<string, number>();
  const siblingNames = new Set<string>();
  for (const [key, value] of Object.entries(assets)) {
    id(key);
    const asset = record(value);
    if (asset.id !== key) fail("Asset ID mismatch.");
    if (asset.kind === "procedural") {
      if (asset.generator !== "knot-v1") fail("Unsupported procedural asset.");
    } else if (asset.kind === "file") {
      if (
        typeof asset.fileName !== "string" ||
        asset.fileName.length > 255 ||
        /[\\/\x00]/.test(asset.fileName) ||
        !/\.(ply|spz|splat|ksplat|sog)$/i.test(asset.fileName)
      )
        fail("Unsupported splat filename.");
      if (
        !Number.isSafeInteger(asset.byteLength) ||
        (asset.byteLength as number) <= 0
      )
        fail(`Invalid asset size for ${asset.fileName}: expected a positive whole number of bytes.`);
    } else fail("Unsupported asset type.");
  }
  let transformedSplatCount = 0;
  for (const [key, value] of Object.entries(nodes)) {
    id(key);
    const node = record(value);
    if (
      node.id !== key ||
      typeof node.name !== "string" ||
      !node.name.trim() ||
      node.name.length > 256
    )
      fail("Invalid scene node.");
    const parent = node.parentId;
    if (parent !== null) {
      id(parent);
      if (record(nodes[parent]).type !== "transform")
        fail("Missing transform parent.");
    }
    const sibling = JSON.stringify([parent, node.name]);
    if (siblingNames.has(sibling)) fail("Duplicate sibling names.");
    siblingNames.add(sibling);
    if (node.type === "transform") {
      if (node.hidden !== undefined && typeof node.hidden !== "boolean") fail("Invalid object visibility override.");
      vector(node.position);
      vector(node.rotation);
      vector(node.scale);
      if (node.pivot !== undefined) vector(node.pivot);
      if (node.pivotCompensation !== undefined) vector(node.pivotCompensation);
      if (node.affine !== undefined) {
        if (!Array.isArray(node.affine) || node.affine.length !== 9 || node.affine.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e12)) fail("Invalid object affine transform.");
        const values = node.affine as number[], magnitude = Math.max(...values.map(Math.abs));
        if (!magnitude || new Matrix3().fromArray(values.map(n => n / magnitude)).determinant() <= 1e-15) fail("Object affine transform must be nonsingular and preserve orientation.");
      }
      if (node.rotationOrder !== "XYZ" || node.scale.some((n) => n < 0.001))
        fail("Unsupported rotation order or scale.");
      parents.set(key, parent as string | null);
    } else if (node.type === "splatShape") {
      if (node.componentEdits !== undefined) validateSplatComponentEdits(node.componentEdits);
      if (node.componentTransforms !== undefined) {
        validateSplatComponentTransforms(node.componentTransforms);
        transformedSplatCount += node.componentTransforms.records.length;
        if (transformedSplatCount > SPLAT_TRANSFORM_SCENE_LIMIT) fail("Scene exceeds 250,000 transformed splat records.");
      }
      if (node.elasticity !== undefined) {
        validateElasticity(node.elasticity);
        if (!node.binding) fail("Elasticity requires a binding.");
      }
      if (node.binding !== undefined) {
        const binding = record(node.binding);
        if (!Array.isArray(binding.jointIds) || !binding.jointIds.length || binding.jointIds.length > 256 ||
          new Set(binding.jointIds).size !== binding.jointIds.length || !Array.isArray(binding.restMatrices) ||
          binding.restMatrices.length !== binding.jointIds.length) fail("Invalid splat binding.");
        for (const jointId of binding.jointIds as unknown[]) id(jointId);
        for (const matrix of binding.restMatrices as unknown[]) {
          if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(n => typeof n === "number" && Number.isFinite(n))) fail("Invalid bind matrix.");
        }
        validateSkinWeights(binding);
      }
      if (parent === null) fail("Shape has no transform.");
      id(node.assetId);
      if (!Object.hasOwn(assets, node.assetId))
        fail("Missing asset reference.");
      vector(node.offset);
      shapeCounts.set(
        parent as string,
        (shapeCounts.get(parent as string) ?? 0) + 1,
      );
    } else if (node.type === "curveShape") {
      if (parent === null) fail("Curve shape has no transform.");
      validateCurveShape(node);
      shapeCounts.set(parent as string, (shapeCounts.get(parent as string) ?? 0) + 1);
    } else if (node.type === "meshShape") {
      if (parent === null) fail("Mesh shape has no transform.");
      validateMeshShape(node);
      for (const material of (node.materials ?? []) as import("./mesh-materials.ts").MeshMaterialData[]) for (const slot of ["map","emissiveMap","normalMap","roughnessMap","metalnessMap","alphaMap","bumpMap"] as const) {
        const assetId=material[slot]?.assetId;
        if (assetId && !Object.hasOwn((doc.textureAssets ?? {}) as object, assetId)) fail("Missing material texture asset. Relink the texture before opening.");
      }
      validateMeshSkin(node, new Set(((doc.joints ?? []) as import("./skeleton.ts").Joint[]).map(j => j.id)));
      shapeCounts.set(parent as string, (shapeCounts.get(parent as string) ?? 0) + 1);
    } else if (node.type === "particleShape") {
      if (parent === null) fail("Particle shape has no transform.");
      validateParticleShape(node);
      shapeCounts.set(parent as string, (shapeCounts.get(parent as string) ?? 0) + 1);
    } else fail("Unsupported node type.");
  }
  const visited = new Set<string>();
  for (const key of parents.keys()) {
    if ((shapeCounts.get(key) ?? 0) > 1)
      fail("A transform may have at most one renderable shape; shapeless transforms are groups.");
    const path = new Set<string>();
    let current: string | null = key;
    while (current !== null && !visited.has(current)) {
      if (path.has(current)) fail("Scene hierarchy contains a cycle.");
      path.add(current);
      current = parents.get(current) ?? null;
    }
    path.forEach((node) => visited.add(node));
  }
  if (
    !Array.isArray(doc.rootIds) ||
    doc.rootIds.some(
      (key) =>
        typeof key !== "string" ||
        !parents.has(key) ||
        parents.get(key) !== null,
    ) ||
    new Set(doc.rootIds).size !== doc.rootIds.length ||
    doc.rootIds.length !==
      [...parents.values()].filter((p) => p === null).length
  )
    fail("Invalid scene roots.");
  validateCustomAttributes(value as SceneDocument);
  validateSceneSplatMasks(value as SceneDocument);
  if (doc.animation !== undefined) validateAnimation(doc.animation, value as SceneDocument);
  if (doc.drivenKeys !== undefined) validateDrivenKeys(doc.drivenKeys, value as SceneDocument);
  if (doc.ikHandles !== undefined) validateIKHandles(doc.ikHandles, value as SceneDocument);
  if (doc.constraints !== undefined) validateConstraints(doc.constraints, value as SceneDocument);
  validateParticleEmitters(value as SceneDocument);
  return value as SceneDocument;
}
function validateEditor(value: unknown): EditorSnapshot {
  const editor = record(value),
    camera = record(editor.camera);
  vector(camera.position);
  vector(camera.target);
  finite(camera.fov);
  finite(camera.near);
  finite(camera.far);
  if(camera.view!==undefined&&!["perspective","front","back","left","right","top","bottom"].includes(camera.view as string))fail("Invalid saved camera view.");
  if(camera.height!==undefined&&(typeof camera.height!=="number"||!Number.isFinite(camera.height)||camera.height<=0))fail("Invalid orthographic height.");
  finite(editor.time);
  if (
    camera.fov < 1 ||
    camera.fov > 179 ||
    camera.near <= 0 ||
    camera.far <= camera.near ||
    Math.abs(editor.time) > 1000000 ||
    camera.position.every((n, i) => n === (camera.target as Vec3)[i])
  )
    fail("Invalid saved viewport.");
  return value as EditorSnapshot;
}
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let n = value; for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); return n >>> 0;
});
async function digestBlob(blob: Blob): Promise<{ sha256: string; crc32: number }> {
  const hash = sha256.create(); let crc = 0xffffffff;
  // Slicing bounds JS memory even for large disk-backed Files and repeated-part Blobs.
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer());
    hash.update(bytes);
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  return { sha256: Array.from(hash.digest(), n => n.toString(16).padStart(2, "0")).join(""), crc32: (crc ^ 0xffffffff) >>> 0 };
}
function bytes(size: number) { const array = new Uint8Array(size); return { array, view: new DataView(array.buffer) }; }
const ZIP32_MAX = 0xffffffff;
type StoredEntry = { name: string; source: Blob; crc32: number };

/** STORE archive made of Blob references: original asset bytes are never concatenated in JS. */
function storedArchive(entries: StoredEntry[]): Blob {
  const parts: BlobPart[] = [], directory: Uint8Array[] = []; let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name), size = entry.source.size;
    const bigSize = size >= ZIP32_MAX, bigOffset = offset >= ZIP32_MAX;
    const localExtra = bigSize ? 20 : 0, local = bytes(30 + name.length + localExtra);
    local.view.setUint32(0, 0x04034b50, true); local.view.setUint16(4, bigSize ? 45 : 20, true);
    local.view.setUint16(6, 0x800, true); local.view.setUint16(12, 33, true); local.view.setUint32(14, entry.crc32, true);
    local.view.setUint32(18, bigSize ? ZIP32_MAX : size, true); local.view.setUint32(22, bigSize ? ZIP32_MAX : size, true);
    local.view.setUint16(26, name.length, true); local.view.setUint16(28, localExtra, true); local.array.set(name, 30);
    if (bigSize) {
      const extra = 30 + name.length; local.view.setUint16(extra, 1, true); local.view.setUint16(extra + 2, 16, true);
      local.view.setBigUint64(extra + 4, BigInt(size), true); local.view.setBigUint64(extra + 12, BigInt(size), true);
    }
    parts.push(local.array.buffer, entry.source);
    const extraSize = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0), central = bytes(46 + name.length + (extraSize ? 4 + extraSize : 0));
    central.view.setUint32(0, 0x02014b50, true); central.view.setUint16(4, 45, true); central.view.setUint16(6, bigSize || bigOffset ? 45 : 20, true);
    central.view.setUint16(8, 0x800, true); central.view.setUint16(14, 33, true); central.view.setUint32(16, entry.crc32, true);
    central.view.setUint32(20, bigSize ? ZIP32_MAX : size, true); central.view.setUint32(24, bigSize ? ZIP32_MAX : size, true);
    central.view.setUint16(28, name.length, true); central.view.setUint16(30, extraSize ? 4 + extraSize : 0, true);
    central.view.setUint32(42, bigOffset ? ZIP32_MAX : offset, true); central.array.set(name, 46);
    if (extraSize) {
      let cursor = 46 + name.length; central.view.setUint16(cursor, 1, true); central.view.setUint16(cursor + 2, extraSize, true); cursor += 4;
      if (bigSize) { central.view.setBigUint64(cursor, BigInt(size), true); central.view.setBigUint64(cursor + 8, BigInt(size), true); cursor += 16; }
      if (bigOffset) central.view.setBigUint64(cursor, BigInt(offset), true);
    }
    directory.push(central.array); offset += local.array.length + size;
    if (!Number.isSafeInteger(offset)) fail("Project exceeds the browser's safely addressable size.");
  }
  const directoryOffset = offset, directorySize = directory.reduce((sum, item) => sum + item.length, 0);
  parts.push(...directory.map(part => part.buffer as ArrayBuffer)); offset += directorySize;
  const zip64 = directoryOffset >= ZIP32_MAX || directorySize >= ZIP32_MAX || entries.some(e => e.source.size >= ZIP32_MAX);
  if (zip64) {
    const end64 = bytes(56); end64.view.setUint32(0, 0x06064b50, true); end64.view.setBigUint64(4, 44n, true);
    end64.view.setUint16(12, 45, true); end64.view.setUint16(14, 45, true);
    end64.view.setBigUint64(24, BigInt(entries.length), true); end64.view.setBigUint64(32, BigInt(entries.length), true);
    end64.view.setBigUint64(40, BigInt(directorySize), true); end64.view.setBigUint64(48, BigInt(directoryOffset), true);
    const locator = bytes(20); locator.view.setUint32(0, 0x07064b50, true); locator.view.setBigUint64(8, BigInt(offset), true); locator.view.setUint32(16, 1, true);
    parts.push(end64.array.buffer, locator.array.buffer);
  }
  const end = bytes(22); end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, entries.length, true); end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, zip64 ? ZIP32_MAX : directorySize, true); end.view.setUint32(16, zip64 ? ZIP32_MAX : directoryOffset, true);
  parts.push(end.array.buffer); return new Blob(parts, { type: "application/octet-stream" });
}
export async function encodeProjectBlob(scene: SceneDocument, sources: ReadonlyMap<string, Blob>, editor: EditorSnapshot): Promise<Blob> {
  validateScene(scene); validateEditor(editor);
  const entries: StoredEntry[] = [], files: Manifest["files"] = Object.create(null);
  for (const asset of Object.values(scene.assets)) {
    if (asset.kind !== "file") continue;
    const source = sources.get(asset.id);
    if (!source || source.size !== asset.byteLength) fail(`Missing source file: ${asset.fileName}`);
    const digest = await digestBlob(source!), path = `assets/${asset.id}`;
    entries.push({ name: path, source: source!, crc32: digest.crc32 }); files[asset.id] = { path, sha256: digest.sha256 };
  }
  const manifest: Manifest = { format: "musubi-project", version: 1, scene, editor, files };
  const json = new Blob([JSON.stringify(manifest)]);
  if (json.size > MAX_JSON_BYTES) fail("Project metadata exceeds the supported size.");
  entries.push({ name: "scene.json", source: json, crc32: (await digestBlob(json)).crc32 });
  return storedArchive(entries);
}
/** Compatibility wrapper for small callers that explicitly require contiguous bytes. */
export async function encodeProject(scene: SceneDocument, sources: ReadonlyMap<string, Blob>, editor: EditorSnapshot): Promise<Uint8Array> {
  return new Uint8Array(await (await encodeProjectBlob(scene, sources, editor)).arrayBuffer());
}

export async function decodeProjectBlob(blob: Blob): Promise<{ scene: SceneDocument; editor: EditorSnapshot; files: Map<string, File> }> {
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false, strictness: "strict", checkOverlappingEntry: true });
  try {
    const entries = new Map<string, FileEntry>();
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.size >= MAX_NODES + 1 || entries.has(entry.filename) || entry.directory || entry.symlink || entry.encrypted
        || (entry.filename !== "scene.json" && !/^assets\/[a-zA-Z0-9_-]{1,100}$/.test(entry.filename))
        || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
        || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0
        || !Number.isSafeInteger(entry.offset) || entry.offset < 0)
        fail("Invalid or duplicate archive entry.");
      if (entry.filename === "scene.json" && entry.uncompressedSize > MAX_JSON_BYTES) fail("Project metadata exceeds the supported size.");
      entries.set(entry.filename, entry as FileEntry);
    }
    async function content(entry: FileEntry): Promise<Blob> {
      if (entry.compressionMethod === 0) {
        if (entry.compressedSize !== entry.uncompressedSize) fail("Invalid stored asset size.");
        // zip.js validates local headers, descriptors, ranges and overlaps without inflating STORE data.
        await entry.getData(new BlobWriter(), { checkOverlappingEntryOnly: true, checkOverlappingEntry: true });
        const start = entry.localDirectory!.dataOffset;
        return blob.slice(start, start + entry.uncompressedSize);
      }
      const writer = new BlobWriter(), output = writer.writable;
      let produced = 0;
      const bounded = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        produced += chunk.length;
        if (produced > entry.uncompressedSize) throw Error("Archive entry exceeds its declared size.");
        controller.enqueue(chunk);
      } });
      const completion = bounded.readable.pipeTo(output);
      completion.catch(() => {});
      try { await entry.getData(bounded.writable, { checkSignature: true, checkOverlappingEntry: true }); await completion; }
      catch (error) { await completion.catch(() => {}); throw error; }
      return writer.getData();
    }
    const metadataEntry = entries.get("scene.json"); if (!metadataEntry) fail("This is not an MSB scene: scene.json is missing.");
    const metadata = await content(metadataEntry!);
    if (metadata.size !== metadataEntry!.uncompressedSize || (metadataEntry!.crc32 !== undefined && (await digestBlob(metadata)).crc32 !== metadataEntry!.crc32)) fail("Project metadata integrity check failed.");
    const manifest = record(JSON.parse(await metadata.text()));
    if (manifest.format !== "musubi-project" || manifest.version !== 1) fail("Unsupported MSB project version.");
    const scene = validateScene(manifest.scene), editor = validateEditor(manifest.editor), refs = record(manifest.files);
    const fileAssets = Object.values(scene.assets).filter(asset => asset.kind === "file");
    if (Object.keys(refs).length !== fileAssets.length || entries.size !== fileAssets.length + 1) fail("Asset inventory does not match the scene.");
    for (const asset of fileAssets) {
      const ref = record(refs[asset.id]), entry = entries.get(ref.path as string);
      if (ref.path !== `assets/${asset.id}` || entry?.uncompressedSize !== asset.byteLength
        || typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256)) fail(`Missing or invalid asset: ${asset.fileName}`);
    }
    const files = new Map<string, File>();
    for (const asset of fileAssets) {
      const ref = record(refs[asset.id]), entry = entries.get(ref.path as string)!, data = await content(entry);
      const digest = await digestBlob(data);
      if (data.size !== asset.byteLength || digest.sha256 !== ref.sha256 || (entry.crc32 !== undefined && digest.crc32 !== entry.crc32)) fail(`Asset integrity check failed: ${asset.fileName}`);
      files.set(asset.id, new File([data], asset.fileName));
    }
    return { scene, editor, files };
  } catch (error) {
    if (error instanceof Error && error.message === "Unsafe filename") fail("Invalid archive entry.");
    throw error;
  } finally { await reader.close(); }
}
export async function decodeProject(bytes: Uint8Array): Promise<{ scene: SceneDocument; editor: EditorSnapshot; files: Map<string, File> }> {
  return decodeProjectBlob(new Blob([new Uint8Array(bytes).buffer]));
}
