import { ExtSplats, SplatMesh, utils } from "@sparkjsdev/spark";
import { POSE_ANIMATION_CHANNELS, type PoseAnimationChannel } from "./animation.ts";
import { uniqueName, type SceneDocument, type SplatShapeNode, type TransformNode } from "./scene-document.ts";
import { isSplatComponentActive, SPLAT_EDIT_SOURCE_LIMIT } from "./splat-component-edits.ts";
import type { SplatSelectionIdentity } from "./splat-component-selection.ts";
import { encodeMaskData, maskValue, rangeContains, splatRanges } from "./splat-masks.ts";

export const SPLAT_EXTRACTION_LIMIT = 100_000;
export const SPLAT_EXTRACTION_RETAINED_BYTES = 64 * 1024 * 1024;
export const SPLAT_EXTRACTION_NAME = "selection.msext";
export const SPLAT_EXTRACTION_LABEL = "Duplicate Selected Splats";
const MAGIC = 0x3153454d; // "MES1", Musubi Extended Splats version 1.
const HEADER = 20;
const ROW_WORDS = 4;
const SH = ["sh1", "sh2", "sh3a", "sh3b"] as const;
const SH_ARRAY_COUNT = [0, 1, 2, 4] as const;
const validId = (id: string) => /^[A-Za-z0-9_-]{1,100}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id);
const padded = (bytes: number) => Math.ceil(bytes / 4) * 4;
export const SPLAT_EXTRACTION_MAX_FILE_BYTES = padded(HEADER + 200) + SPLAT_EXTRACTION_LIMIT * 100;
const fileBytes = (header: number, count: number, shArrays: number) => header + count * (1 + (2 + shArrays) * ROW_WORDS) * 4;

export const isSplatExtractionFile = (name: string) => /\.msext$/i.test(name);
// Includes the file, CPU and GPU Gaussian/SH words, centers, and worst-case
// padding for one 2048-record Spark texture row plus skin buffers.
export const splatExtractionRetainedBytes = (size: number) => 4 * size + 1024 * 1024;

export function assertSplatExtractionBudget(retained: Iterable<Pick<File, "name" | "size">>, nextSize: number) {
  let bytes = splatExtractionRetainedBytes(nextSize);
  for (const file of retained) if (isSplatExtractionFile(file.name)) bytes += splatExtractionRetainedBytes(file.size);
  if (bytes > SPLAT_EXTRACTION_RETAINED_BYTES)
    throw Error("Duplicated splats would exceed the 64 MiB retained asset budget. Select fewer splats or start a new scene.");
}

function validateCounts(count: number, sourceCount: number) {
  if (!Number.isInteger(count) || count < 1 || count > SPLAT_EXTRACTION_LIMIT)
    throw Error("Duplicate between 1 and 100,000 selected splats at a time.");
  if (!Number.isInteger(sourceCount) || sourceCount < count || sourceCount > SPLAT_EDIT_SOURCE_LIMIT)
    throw Error("The duplicated splat source count is invalid.");
}

function validateSelection(ids: Uint32Array, sourceCount: number) {
  validateCounts(ids.length, sourceCount);
  let previous = -1;
  for (const id of ids) {
    if (id <= previous || id >= sourceCount)
      throw Error("The selection no longer contains ordered original splat IDs. Select the splats again.");
    previous = id;
  }
}

export function splatExtractionFileSize(source: ExtSplats, identity: SplatSelectionIdentity, count: number) {
  validateCounts(count, identity.count);
  if (!validId(identity.assetId) || !validId(identity.shapeId) || source.numSplats !== identity.count)
    throw Error("The loaded splats no longer match this selection.");
  return fileBytes(padded(HEADER + identity.assetId.length + identity.shapeId.length), count, SH_ARRAY_COUNT[source.getNumSh()]);
}

export async function encodeSplatExtraction(
  source: ExtSplats, identity: SplatSelectionIdentity, ids: Uint32Array, signal: AbortSignal,
): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  ids = ids.slice();
  validateSelection(ids, identity.count);
  const buffer = new ArrayBuffer(splatExtractionFileSize(source, identity, ids.length));
  const degree = source.getNumSh();
  const sh = SH.map(key => source.extra[key]);
  const arrays = [...source.extArrays, ...sh.slice(0, SH_ARRAY_COUNT[degree])];
  if (sh.slice(SH_ARRAY_COUNT[degree]).some(Boolean) || arrays.some(array => !array || array.length < identity.count * ROW_WORDS))
    throw Error("The original Gaussian or spherical-harmonic records are incomplete.");
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, ids.length, true);
  view.setUint32(8, identity.count, true);
  view.setUint32(12, degree, true);
  view.setUint16(16, identity.assetId.length, true);
  view.setUint16(18, identity.shapeId.length, true);
  const encoder = new TextEncoder();
  const header = padded(HEADER + identity.assetId.length + identity.shapeId.length);
  const bytes = new Uint8Array(buffer);
  bytes.set(encoder.encode(identity.assetId), HEADER);
  bytes.set(encoder.encode(identity.shapeId), HEADER + identity.assetId.length);
  // Preserve the full original Gaussian and directional color words. The
  // Spark 2.4 extractSplats helper re-encodes DC and omits the SH arrays.
  const rowSize = 4 + arrays.length * ROW_WORDS * 4;
  for (let start = 0; start < ids.length; start += 4096) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    signal.throwIfAborted();
    const end = Math.min(ids.length, start + 4096);
    for (let i = start; i < end; i++) {
      const original = ids[i];
      let write = header + i * rowSize;
      view.setUint32(write, original, true);
      write += 4;
      for (const array of arrays) for (let k = 0; k < ROW_WORDS; k++, write += 4)
        view.setUint32(write, array![original * ROW_WORDS + k], true);
    }
  }
  return buffer;
}

export function decodeSplatExtraction(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  if (view.byteLength < HEADER || view.getUint32(0, true) !== MAGIC)
    throw Error("Unsupported duplicated splat asset. This build opens Musubi Extended Splats version 1.");
  const count = view.getUint32(4, true), sourceCount = view.getUint32(8, true), degree = view.getUint32(12, true);
  validateCounts(count, sourceCount);
  const assetLength = view.getUint16(16, true), shapeLength = view.getUint16(18, true);
  const header = padded(HEADER + assetLength + shapeLength);
  if (degree > 3 || !assetLength || assetLength > 100 || !shapeLength || shapeLength > 100 ||
      buffer.byteLength !== fileBytes(header, count, SH_ARRAY_COUNT[degree]))
    throw Error("Invalid duplicated splat asset header or size.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const sourceAssetId = decoder.decode(new Uint8Array(buffer, HEADER, assetLength));
  const sourceShapeId = decoder.decode(new Uint8Array(buffer, HEADER + assetLength, shapeLength));
  if (!validId(sourceAssetId) || !validId(sourceShapeId)) throw Error("Invalid duplicated splat source identity.");

  const originalIds = new Uint32Array(count);
  const capacity = utils.getTextureSize(count).maxSplats * ROW_WORDS;
  const planes = Array.from({ length: 2 + SH_ARRAY_COUNT[degree] }, () => new Uint32Array(capacity));
  let offset = header, previous = -1;
  for (let i = 0; i < count; i++) {
    const id = view.getUint32(offset, true);
    if (id <= previous || id >= sourceCount) throw Error("Invalid duplicated splat original ID map.");
    originalIds[i] = previous = id;
    offset += 4;
    for (const plane of planes) for (let k = 0; k < ROW_WORDS; k++, offset += 4)
      plane[i * ROW_WORDS + k] = view.getUint32(offset, true);
  }
  const extra = Object.fromEntries(SH.slice(0, SH_ARRAY_COUNT[degree]).map((key, i) => [key, planes[i + 2]]));
  const splats = new ExtSplats({ extArrays: [planes[0], planes[1]], numSplats: count, extra });
  try {
    splats.forEachSplat((_index, center, scale, rotation, opacity, color) => {
      if (![center.x, center.y, center.z, scale.x, scale.y, scale.z, rotation.x, rotation.y, rotation.z, rotation.w, opacity, color.r, color.g, color.b].every(Number.isFinite))
        throw Error("The duplicated splat asset contains a non-finite Gaussian.");
    });
  } catch (error) {
    splats.dispose();
    throw error;
  }
  return { splats, sourceAssetId, sourceShapeId, sourceCount, originalIds };
}

export function createExtractedSplatMesh(buffer: ArrayBuffer) {
  const { splats } = decodeSplatExtraction(buffer);
  try {
    return new SplatMesh({ extSplats: splats, covSplats: true });
  } catch (error) {
    splats.dispose();
    throw error;
  }
}

export function splatExtractionSource(doc: SceneDocument, identity: SplatSelectionIdentity, ids: Uint32Array) {
  const source = doc.nodes[identity.shapeId];
  if (source?.type !== "splatShape" || source.assetId !== identity.assetId || !doc.assets[identity.assetId])
    throw Error("Select original components on a loaded splat object.");
  const owner = doc.nodes[source.parentId];
  if (owner?.type !== "transform") throw Error("The selected splats have no object transform.");
  if (source.elasticity)
    throw Error("Turn off elasticity before duplicating splats. Elastic stretch and fill depend on the entire source neighborhood.");
  if (doc.constraints?.some(row => row.enabled && row.targetId === owner.id) ||
      doc.drivenKeys?.some(row => row.driven.targetId === owner.id && (POSE_ANIMATION_CHANNELS as readonly string[]).includes(row.driven.channel)))
    throw Error("Duplicate splats from an object with direct transform channels. Remove its incoming constraints or driven transform keys first.");
  validateSelection(ids, identity.count);
  if (ids.length * (source.binding?.jointIds.length ?? 0) > 1_000_000)
    throw Error("The selected splat count × bound joint count exceeds 1,000,000. Select a smaller region.");
  if (ids.some(id => !isSplatComponentActive(source.componentEdits, id)))
    throw Error("The selection includes hidden or deleted original splats. Show or restore them first.");
  return { source, owner };
}

export function addSplatExtraction(doc: SceneDocument, identity: SplatSelectionIdentity, ids: Uint32Array, size: number) {
  const { source, owner } = splatExtractionSource(doc, identity, ids);
  if (!Number.isSafeInteger(size) || size <= HEADER || size > SPLAT_EXTRACTION_MAX_FILE_BYTES)
    throw Error("The duplicated splat asset has an invalid byte length.");
  const id = crypto.randomUUID(), shapeId = crypto.randomUUID(), assetId = crypto.randomUUID();
  const name = uniqueName(doc, `${owner.name.slice(0, 69)}_selection`, owner.parentId);
  const node: TransformNode = { ...structuredClone(owner), id, name };
  const shape: SplatShapeNode = {
    id: shapeId, type: "splatShape", parentId: id, assetId, name: `${name}Shape`, offset: [...source.offset],
  };
  const subset = new Map<number, number>();
  ids.forEach((original, index) => subset.set(original, index));
  const remapRanges = (ranges: readonly number[]) => {
    if (!ranges.length) return [];
    const members: number[] = [];
    ids.forEach((original, index) => { if (rangeContains(ranges, original)) members.push(index); });
    return splatRanges(members, ids.length);
  };

  if (source.binding) {
    const { weights, ...binding } = source.binding;
    shape.binding = structuredClone(binding);
    if (weights) {
      const remapped = { count: ids.length, overrides: {} as typeof weights.overrides };
      for (const [original, index] of subset) {
        const row = weights.overrides[original];
        if (row) remapped.overrides[index] = structuredClone(row);
      }
      shape.binding.weights = remapped;
    }
  }
  const transforms = source.componentTransforms?.records.flatMap(record => {
    const index = subset.get(record.index);
    return index === undefined ? [] : [{ index, matrix: [...record.matrix] }];
  });
  if (transforms?.length) shape.componentTransforms = { version: 1, sourceCount: ids.length, records: transforms };
  const paint = source.attributePaint?.records.flatMap(([original, ...channels]) => {
    const index = subset.get(original);
    return index === undefined ? [] : [[index, ...channels] as const];
  });
  if (paint?.length) shape.attributePaint = { version: 1, sourceCount: ids.length, records: paint };

  const maskIds = new Map<string, string>();
  shape.selectionSets = source.selectionSets?.map(set => ({
    ...set, id: crypto.randomUUID(), assetId, sourceCount: ids.length, members: remapRanges(set.members),
  }));
  shape.scalarMasks = source.scalarMasks?.map(mask => {
    const maskId = crypto.randomUUID();
    maskIds.set(mask.id, maskId);
    const fallback = mask.data.kind === "sparse" ? mask.data.defaultValue : 0;
    const values = new Map<number, number>();
    ids.forEach((original, index) => {
      const value = maskValue(mask, original);
      if (value !== fallback) values.set(index, value);
    });
    return {
      ...mask, id: maskId, assetId, sourceCount: ids.length,
      data: encodeMaskData(ids.length, fallback, values), componentLocks: remapRanges(mask.componentLocks),
    };
  });
  if (source.appearance) shape.appearance = {
    version: 1, sourceCount: ids.length,
    layers: source.appearance.layers.map(layer => ({
      ...layer, id: crypto.randomUUID(), maskId: layer.maskId ? maskIds.get(layer.maskId)! : null,
    })),
  };

  const document: SceneDocument = {
    ...doc, rootIds: owner.parentId === null ? [...doc.rootIds, id] : doc.rootIds,
    nodes: { ...doc.nodes, [id]: node, [shapeId]: shape },
    assets: { ...doc.assets, [assetId]: { id: assetId, kind: "file", fileName: SPLAT_EXTRACTION_NAME, byteLength: size } },
  };
  const tracks = doc.animation?.tracks.filter(track =>
    track.targetId === owner.id && POSE_ANIMATION_CHANNELS.includes(track.channel as PoseAnimationChannel));
  if (doc.animation && tracks?.length) document.animation = {
    ...doc.animation,
    tracks: [...doc.animation.tracks, ...tracks.map(track => ({
      ...track, id: crypto.randomUUID(), targetId: id, keys: track.keys.map(key => ({ ...key, id: crypto.randomUUID() })),
    }))],
  };
  return { document, id, shape, assetId };
}
