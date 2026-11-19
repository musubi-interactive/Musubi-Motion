import { BlobReader, BlobWriter, ZipReader, type FileEntry } from "@zip.js/zip.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadCropAsset, type CropBounds } from "../src/splat-ply-crop";
import {
  countPartition, createPartitionRecipe, exportPartition, openPartitionRecipe,
} from "../src/splat-ply-regions";
import { checkRegionName, MAX_REGIONS, type CaptureRegion } from "../src/splat-ply-region-spec";

const properties = [
  "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
  ...Array.from({ length: 9 }, (_, index) => "f_rest_" + index),
];
const stride = properties.length * 4 + 6;
const centers = [0, -4, 4, -3, 3, 1, -5, 5];
function fixture(count = centers.length, altered = false) {
  const header = [
    "ply", "format binary_little_endian 1.0", "comment Musubi interleaved regions fixture",
    "element vertex " + count, ...properties.map(name => "property float " + name),
    "property ushort intensity", "property int record_id", "end_header", "",
  ].join("\n");
  const rows = new Uint8Array(stride * count);
  const view = new DataView(rows.buffer);
  for (let index = 0; index < count; index++) {
    const start = index * stride;
    view.setFloat32(start, centers[index % centers.length], true);
    for (let channel = 3; channel < properties.length; channel++) {
      view.setFloat32(start + channel * 4, Math.sin(index + channel) * 0.2, true);
    }
    view.setUint16(start + stride - 6, index + (altered ? 1 : 0), true);
    view.setInt32(start + stride - 4, index, true);
  }
  return { file: new Blob([header, rows]), rows };
}

function box(min: number, max: number): CropBounds {
  return { min: [min, -1, -1], max: [max, 1, 1] };
}
const regions: CaptureRegion[] = [
  { name: "Center-left", enabled: true, bounds: box(-4, 1) },
  { name: "Center-right", enabled: true, bounds: box(0, 4) },
  { name: "Empty", enabled: true, bounds: box(6, 7) },
  { name: "Disabled", enabled: false, bounds: box(-10, 10) },
];

const recipeFile = (value: unknown) => new Blob([JSON.stringify(value)]);

async function readPackage(file: Blob) {
  const reader = new ZipReader(new BlobReader(file), { strictness: "strict", useWebWorkers: false });
  const entries = new Map((await reader.getEntries()).map(entry => [entry.filename, entry]));
  reader.close();
  const read = async (name: string) => {
    const entry = entries.get(name) as FileEntry;
    return entry.getData(new BlobWriter(), { checkSignature: true });
  };
  return { entries, read };
}

describe("source-space Gaussian partitions", () => {
  it("owns shared boundaries by priority and ignores disabled regions", async () => {
    const asset = await loadCropAsset(fixture().file);
    await expect(countPartition(asset, regions)).resolves.toEqual({ regions: [4, 2, 0, 0], overlap: 2, remainder: 2 });
    await expect(countPartition(asset, [regions[1], regions[0]])).resolves.toEqual({ regions: [4, 2], overlap: 2, remainder: 2 });
    await expect(countPartition(asset, [])).resolves.toEqual({ regions: [], overlap: 0, remainder: 8 });
  });

  it("writes deterministic ZIP assets with exact ordered Gaussian, SH and scalar bytes", async () => {
    const source = fixture();
    const asset = await loadCropAsset(source.file);
    const zipped = await exportPartition(asset, regions);
    const again = await exportPartition(asset, regions);
    expect(new Uint8Array(await zipped.arrayBuffer())).toEqual(new Uint8Array(await again.arrayBuffer()));
    const { entries, read } = await readPackage(zipped);
    expect([...entries.keys()]).toEqual(["recipe.json", "manifest.json", "Center-left.ply", "Center-right.ply", "Remainder.ply"]);
    const manifest = JSON.parse(await (await read("manifest.json")).text());
    expect(manifest.overlap).toBe(2);
    expect(manifest.outputs).toEqual([
      { name: "Center-left", count: 4, file: "Center-left.ply" },
      { name: "Center-right", count: 2, file: "Center-right.ply" },
      { name: "Empty", count: 0, file: null },
      { name: "Disabled", count: 0, file: null },
      { name: "Remainder", count: 2, file: "Remainder.ply" },
    ]);
    const recipe = await openPartitionRecipe(asset, await read("recipe.json"));
    expect(recipe.source).toEqual(manifest.source);
    expect(recipe.source.sha256).toBe(createHash("sha256").update(new Uint8Array(await source.file.arrayBuffer())).digest("hex"));
    const allIndices: number[] = [];
    for (const [name, indices] of Object.entries({ "Center-left": [0, 1, 3, 5], "Center-right": [2, 4], Remainder: [6, 7] })) {
      const result = await read(name + ".ply");
      const output = await loadCropAsset(result);
      expect(output.layout.vertexCount).toBe(indices.length);
      expect(output.layout.beforeCount).toBe(asset.layout.beforeCount);
      expect(output.layout.afterCount).toBe(asset.layout.afterCount);
      const resultRows = new Uint8Array(await result.slice(output.layout.dataOffset).arrayBuffer());
      const view = new DataView(resultRows.buffer);
      for (const [offset, row] of indices.entries()) {
        expect(resultRows.slice(offset * stride, (offset + 1) * stride)).toEqual(source.rows.slice(row * stride, (row + 1) * stride));
        allIndices.push(view.getInt32((offset + 1) * stride - 4, true));
      }
    }
    expect(allIndices.sort((a, b) => a - b)).toEqual(Array.from(centers.keys()));
  });

  it("marks an empty remainder explicitly and omits its non-importable PLY", async () => {
    const asset = await loadCropAsset(fixture().file);
    const { entries, read } = await readPackage(await exportPartition(asset, [{ name: "All", enabled: true, bounds: box(-5, 5) }]));
    expect(entries.has("Remainder.ply")).toBe(false);
    const manifest = JSON.parse(await (await read("manifest.json")).text());
    expect(manifest.outputs.at(-1)).toEqual({ name: "Remainder", count: 0, file: null });
  });

  it("validates recipes against source bytes, bounds and strict versioned fields", async () => {
    const asset = await loadCropAsset(fixture().file);
    const recipe = await createPartitionRecipe(asset, regions);
    await expect(openPartitionRecipe(asset, recipeFile(recipe))).resolves.toEqual(recipe);
    const alteredSource = await loadCropAsset(fixture(centers.length, true).file);
    await expect(openPartitionRecipe(alteredSource, recipeFile(recipe))).rejects.toThrow(/exact original capture/);
    const mismatched = { ...recipe, source: { ...recipe.source, bounds: box(-20, 20) } };
    await expect(openPartitionRecipe(asset, recipeFile(mismatched))).rejects.toThrow(/exact original capture/);
    await expect(openPartitionRecipe(asset, recipeFile({ ...recipe, version: 2 }))).rejects.toThrow(/Unsupported/);
    await expect(openPartitionRecipe(asset, recipeFile({ ...recipe, extra: "field" }))).rejects.toThrow(/Invalid fields/);
    await expect(openPartitionRecipe(asset, new Blob([new Uint8Array(65_537)]))).rejects.toThrow(/64 KiB/);
    await expect(openPartitionRecipe(asset, new Blob([new Uint8Array([0xff])]))).rejects.toThrow(/UTF-8 JSON/);
    await expect(openPartitionRecipe(asset, recipeFile({ ...recipe, regions: [{ ...regions[0], enabled: 1 }] }))).rejects.toThrow(/enabled flag/);
    await expect(openPartitionRecipe(asset, recipeFile({
      ...recipe, regions: [{ ...regions[0], bounds: { min: [1, 2, 3], max: [1, 2, 2] } }],
    }))).rejects.toThrow(/below Max/);
    await expect(openPartitionRecipe(asset, recipeFile({ ...recipe, regions: Array(MAX_REGIONS + 1).fill(regions[0]) }))).rejects.toThrow(/32 regions/);
  });

  it("rejects invalid filenames before they reach ZIP generation", async () => {
    for (const name of ["../bad", "path/name", "path\\name", "Remainder", "COM1", "not.safe", "trail ", "x".repeat(49)]) {
      expect(() => checkRegionName(name, [])).toThrow();
    }
    expect(() => checkRegionName("center-left", ["Center-left"])).toThrow(/unique/);
    const asset = await loadCropAsset(fixture().file);
    await expect(exportPartition(asset, [{ ...regions[0], name: "../outside" }])).rejects.toThrow();
    const invalid = new Blob(["ply\nformat ascii 1.0\nend_header\n"]);
    await expect(loadCropAsset(invalid)).rejects.toThrow(/little-endian/);
  });

  it("cancels a batched count, record copy, and in-progress archive without changing the source", async () => {
    const asset = await loadCropAsset(fixture(100_000).file);
    for (const [run, threshold] of [[countPartition, 0.1], [exportPartition, 0.45], [exportPartition, 0.8]] as const) {
      const controller = new AbortController();
      const result = run(asset, regions, {
        signal: controller.signal,
        progress: ratio => { if (ratio >= threshold) controller.abort(); },
      });
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
    }
    await expect(countPartition(asset, regions)).resolves.toEqual({ regions: [50_000, 25_000, 0, 0], overlap: 25_000, remainder: 25_000 });
  });
});
