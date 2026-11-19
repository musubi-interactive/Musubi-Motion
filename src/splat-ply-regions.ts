import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BlobReader, ZipWriter } from "@zip.js/zip.js";
import { containsCenter, MAX_FILE_BYTES, MAX_RECORDS, type CropAsset, type CropBounds, type Point } from "./splat-ply-crop";
import { checkRegionName, MAX_REGIONS, type CaptureRegion } from "./splat-ply-region-spec";

const RECIPE_BYTES = 64 * 1024;
const CHUNK_BYTES = 2 * 1024 * 1024;
const COUNT_BATCH = 65_536;
const MAX_PACKAGE_BYTES = MAX_FILE_BYTES + 4 * 1024 * 1024;
const RECIPE_FORMAT = "musubi-splat-regions";

export type PartitionSummary = { regions: number[]; overlap: number; remainder: number };
type SourceIdentity = { sha256: string; bytes: number; count: number; bounds: CropBounds };
export type PartitionRecipe = {
  format: typeof RECIPE_FORMAT;
  version: 1;
  source: SourceIdentity;
  regions: CaptureRegion[];
};

type Work = { signal?: AbortSignal; progress?: (ratio: number) => void };

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    throw new Error("Invalid fields in the regions recipe.");
  }
  return value as Record<string, unknown>;
}

function points(value: unknown): Point {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(item => Number.isFinite(item))) {
    throw new Error("Each box needs three finite Min and Max values.");
  }
  return [value[0], value[1], value[2]];
}

function readBounds(value: unknown): CropBounds {
  const fields = record(value, ["min", "max"]);
  const min = points(fields.min);
  const max = points(fields.max);
  if (min.some((item, axis) => item > max[axis])) throw new Error("Region Min must be at or below Max on each axis.");
  return { min, max };
}

function readRegions(value: unknown): CaptureRegion[] {
  if (!Array.isArray(value) || value.length > MAX_REGIONS) throw new Error("A recipe can contain up to 32 regions.");
  const names: string[] = [];
  return value.map(item => {
    const fields = record(item, ["name", "enabled", "bounds"]);
    if (typeof fields.name !== "string" || typeof fields.enabled !== "boolean") {
      throw new Error("Each region needs a name and an enabled flag.");
    }
    checkRegionName(fields.name, names);
    names.push(fields.name);
    return { name: fields.name, enabled: fields.enabled, bounds: readBounds(fields.bounds) };
  });
}

function readRecipe(value: unknown): PartitionRecipe {
  const fields = record(value, ["format", "version", "source", "regions"]);
  if (fields.format !== RECIPE_FORMAT || fields.version !== 1) {
    throw new Error("Unsupported regions recipe format or version.");
  }
  const source = record(fields.source, ["sha256", "bytes", "count", "bounds"]);
  if (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)
      || typeof source.bytes !== "number" || !Number.isInteger(source.bytes) || source.bytes < 1 || source.bytes > MAX_FILE_BYTES
      || typeof source.count !== "number" || !Number.isInteger(source.count) || source.count < 1 || source.count > MAX_RECORDS) {
    throw new Error("Invalid source identity in the regions recipe.");
  }
  return {
    format: RECIPE_FORMAT, version: 1,
    source: { sha256: source.sha256, bytes: source.bytes, count: source.count, bounds: readBounds(source.bounds) },
    regions: readRegions(fields.regions),
  };
}

async function yieldToJobs(signal?: AbortSignal): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}

const fingerprints = new WeakMap<CropAsset, string>();

async function identify(asset: CropAsset, { signal, progress }: Work): Promise<SourceIdentity> {
  signal?.throwIfAborted();
  const { file, layout, bounds } = asset;
  let fingerprint = fingerprints.get(asset);
  if (!fingerprint) {
    const hasher = sha256.create();
    try {
      for (let start = 0; start < file.size; start += CHUNK_BYTES) {
        const end = Math.min(start + CHUNK_BYTES, file.size);
        const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
        signal?.throwIfAborted();
        hasher.update(bytes);
        progress?.(end / file.size);
        await yieldToJobs(signal);
      }
      fingerprint = bytesToHex(hasher.digest());
      fingerprints.set(asset, fingerprint);
    } finally {
      hasher.destroy();
    }
  }
  return { sha256: fingerprint, bytes: file.size, count: layout.vertexCount, bounds };
}

export async function createPartitionRecipe(asset: CropAsset, regions: CaptureRegion[], work: Work = {}): Promise<PartitionRecipe> {
  const validated = readRegions(regions);
  return { format: RECIPE_FORMAT, version: 1, source: await identify(asset, work), regions: validated };
}

export async function openPartitionRecipe(asset: CropAsset, file: Blob, work: Work = {}): Promise<PartitionRecipe> {
  work.signal?.throwIfAborted();
  if (file.size > RECIPE_BYTES) throw new Error("The regions recipe exceeds 64 KiB.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()));
  } catch {
    throw new Error("Expected a valid UTF-8 JSON regions recipe.");
  }
  work.signal?.throwIfAborted();
  const recipe = readRecipe(value);
  const { source } = recipe;
  const actual = await identify(asset, work);
  const equalBounds = source.bounds.min.every((min, axis) => min === actual.bounds.min[axis]
    && source.bounds.max[axis] === actual.bounds.max[axis]);
  if (!equalBounds || source.bytes !== actual.bytes || source.count !== actual.count || source.sha256 !== actual.sha256) {
    throw new Error("This recipe belongs to a different source PLY. Open the exact original capture first.");
  }
  return recipe;
}

async function scanPartition(asset: CropAsset, regions: CaptureRegion[], work: Work, owners?: Uint8Array): Promise<PartitionSummary> {
  const { signal, progress } = work;
  signal?.throwIfAborted();
  const { centers, layout: { vertexCount } } = asset;
  const active = regions.flatMap((region, index) => region.enabled ? [{ bounds: region.bounds, index }] : []);
  const counts = Array<number>(regions.length).fill(0);
  let overlap = 0;
  let remainder = 0;
  for (let start = 0; start < vertexCount; start += COUNT_BATCH) {
    const end = Math.min(start + COUNT_BATCH, vertexCount);
    for (let index = start; index < end; index++) {
      let owner = regions.length;
      for (const region of active) {
        if (!containsCenter(centers, index * 3, region.bounds)) continue;
        if (owner !== regions.length) {
          overlap++;
          break;
        }
        owner = region.index;
      }
      if (owner === regions.length) remainder++;
      else counts[owner]++;
      if (owners) owners[index] = owner;
    }
    progress?.(end / vertexCount);
    await yieldToJobs(signal);
  }
  return { regions: counts, overlap, remainder };
}

export function countPartition(asset: CropAsset, regions: CaptureRegion[], work: Work = {}): Promise<PartitionSummary> {
  return scanPartition(asset, readRegions(regions), work);
}

async function partitionParts(asset: CropAsset, owners: Uint8Array, counts: number[], { signal, progress }: Work): Promise<Blob[][]> {
  const { file, layout } = asset;
  const { vertexCount, stride, dataOffset, beforeCount, afterCount } = layout;
  const parts = counts.map(count => count === 0 ? [] : [new Blob([beforeCount + count + afterCount])]);
  const windowRecords = Math.floor(CHUNK_BYTES / stride);
  for (let start = 0; start < vertexCount; start += windowRecords) {
    const end = Math.min(start + windowRecords, vertexCount);
    const sizes = counts.map(() => 0);
    for (let index = start; index < end; index++) sizes[owners[index]]++;
    const source = file.slice(dataOffset + start * stride, dataOffset + end * stride);
    const single = sizes.indexOf(end - start);
    if (single !== -1) {
      parts[single].push(source);
    } else {
      const data = new Uint8Array(await source.arrayBuffer());
      signal?.throwIfAborted();
      const chunks = sizes.map(size => new Uint8Array(size * stride));
      const offsets = sizes.map(() => 0);
      for (let index = start; index < end; index++) {
        const owner = owners[index];
        const byte = (index - start) * stride;
        chunks[owner].set(data.subarray(byte, byte + stride), offsets[owner]);
        offsets[owner] += stride;
      }
      for (const [index, chunk] of chunks.entries()) {
        if (chunk.length) parts[index].push(new Blob([chunk]));
      }
    }
    progress?.(end / vertexCount);
    await yieldToJobs(signal);
  }
  return parts;
}

function readParts(parts: Blob[], signal?: AbortSignal): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    async pull(controller) {
      signal?.throwIfAborted();
      const part = parts.shift();
      if (!part) {
        controller.close();
        return;
      }
      const data = await part.arrayBuffer();
      signal?.throwIfAborted();
      controller.enqueue(new Uint8Array(data));
    },
  });
}

export async function exportPartition(asset: CropAsset, regions: CaptureRegion[], { signal, progress }: Work = {}): Promise<Blob> {
  const recipe = await createPartitionRecipe(asset, regions, { signal, progress: ratio => progress?.(ratio * 0.2) });
  const owners = new Uint8Array(asset.layout.vertexCount);
  const summary = await scanPartition(asset, recipe.regions, { signal, progress: ratio => progress?.(0.2 + ratio * 0.2) }, owners);
  const counts = [...summary.regions, summary.remainder];
  const parts = await partitionParts(asset, owners, counts, { signal, progress: ratio => progress?.(0.4 + ratio * 0.3) });
  const outputs = [...recipe.regions.map(region => region.name), "Remainder"].map((name, index) => ({
    name, count: counts[index], file: counts[index] ? name + ".ply" : null,
  }));

  const packageParts: Blob[] = [];
  let packageBytes = 0;
  const outputStream = new WritableStream<Uint8Array<ArrayBuffer>>({
    write(bytes) {
      signal?.throwIfAborted();
      packageBytes += bytes.length;
      if (packageBytes > MAX_PACKAGE_BYTES) throw new Error("The ZIP exceeds 260 MiB.");
      packageParts.push(new Blob([bytes]));
      progress?.(0.7 + Math.min(0.299, 0.3 * packageBytes / asset.file.size));
    },
  });
  const writer = new ZipWriter(outputStream, {
    level: 0, useWebWorkers: false, bufferedWrite: false, extendedTimestamp: false,
  });
  const options = { signal, lastModDate: new Date(2000, 0, 1) };
  try {
    await writer.add("recipe.json", new BlobReader(new Blob([JSON.stringify(recipe, null, 2)])), options);
    await writer.add("manifest.json", new BlobReader(new Blob([JSON.stringify({
      format: "musubi-splat-partition", version: 1, source: recipe.source,
      overlap: summary.overlap, outputs,
    }, null, 2)])), options);
    for (const [index, output] of outputs.entries()) {
      signal?.throwIfAborted();
      if (!output.file) continue;
      const ply = parts[index];
      const size = ply.reduce((total, blob) => total + blob.size, 0);
      await writer.add(output.file, readParts(ply, signal), {
        ...options, uncompressedSize: size,
      });
      await yieldToJobs(signal);
    }
    await writer.close();
    await yieldToJobs(signal);
    progress?.(1);
    return new Blob(packageParts, { type: "application/zip" });
  } finally {
    packageParts.length = 0;
    for (const ply of parts) ply.length = 0;
  }
}
