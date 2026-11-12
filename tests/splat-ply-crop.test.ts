import { describe, expect, it } from "vitest";
import { countInside, exportCrop, loadCropAsset, MAX_FILE_BYTES, parsePlyLayout, type CropBounds, type Point } from "../src/splat-ply-crop";
import { createCropExample } from "../tools/splat-crop/create-example";

const attributes = [
  "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
  "rot_0", "rot_1", "rot_2", "rot_3",
  ...Array.from({ length: 45 }, (_, index) => `f_rest_${index}`),
];
const stride = 21 + 4 * attributes.length;
const encoder = new TextEncoder();

function fixture(points: Point[]) {
  const header = [
    "ply", "format binary_little_endian 1.0", "comment original fixture · preserve spacing",
    `element\tvertex ${points.length}\t`, "property uchar class_id", "property double z",
    "property float x", "property double y", ...attributes.map(name => `property float ${name}`),
    "end_header", "",
  ].join("\n");
  const data = new Uint8Array(points.length * stride);
  const view = new DataView(data.buffer);
  points.forEach(([x, y, z], index) => {
    const start = index * stride;
    view.setUint8(start, index % 256);
    view.setFloat64(start + 1, z, true);
    view.setFloat32(start + 9, x, true);
    view.setFloat64(start + 13, y, true);
    for (let i = 0; i < attributes.length; i++) view.setFloat32(start + 21 + 4 * i, index + i / 7, true);
  });
  return { header, data, file: new Blob([header, data]) };
}

const box: CropBounds = { min: [0, 0, 0], max: [1, 1, 1] };

describe("source Gaussian PLY crop", () => {
  it("retains exact headers and exact records on both sides with inclusive boundaries", async () => {
    const points: Point[] = [[0, 0, 0], [-1, 0, 0], [1, 1, 1], [0, 0, 0], [0.5, 0, 1.0000000000000002]];
    const { header, file, data } = fixture(points);
    const asset = await loadCropAsset(file);
    expect(asset.bounds).toEqual({ min: [-1, 0, 0], max: [1, 1, 1.0000000000000002] });
    expect(await countInside(asset, box)).toBe(3);
    for (const [side, indices] of [["inside", [0, 2, 3]], ["outside", [1, 4]]] as const) {
      const output = await exportCrop(asset, box, side);
      const expectedHeader = header.replace("vertex 5", `vertex ${indices.length}`);
      const expectedData = indices.map(index => data.slice(index * stride, (index + 1) * stride));
      expect(new Uint8Array(await output.arrayBuffer())).toEqual(
        new Uint8Array(await new Blob([expectedHeader, ...expectedData]).arrayBuffer()),
      );
      expect((await loadCropAsset(output)).sample).toEqual(Float64Array.from(indices.flatMap(index => points[index])));
    }
    expect(await file.arrayBuffer()).toEqual(await new Blob([header, data]).arrayBuffer());
  });

  it("treats coincident points as a valid zero-volume crop, and refuses empty exports", async () => {
    const { file } = fixture([[1, 2, 3], [1, 2, 3]]);
    const asset = await loadCropAsset(file);
    expect(await countInside(asset, asset.bounds)).toBe(2);
    expect(await countInside(asset, box)).toBe(0);
    expect(await (await exportCrop(asset, asset.bounds, "inside")).arrayBuffer()).toEqual(await file.arrayBuffer());
    await expect(exportCrop(asset, asset.bounds, "outside")).rejects.toThrow("outside region contains no splats");
    await expect(exportCrop(asset, box, "inside")).rejects.toThrow("inside region contains no splats");
    await expect(countInside(asset, { min: [1, 2, NaN], max: [2, 3, 4] })).rejects.toThrow("finite Z bounds");
    await expect(countInside(asset, { min: [2, 2, 3], max: [1, 3, 4] })).rejects.toThrow("finite X bounds");
  });

  it("reports truncation, trailing bytes, unsupported schemas and nonfinite centers", async () => {
    const { file, header, data } = fixture([[0, 1, 2]]);
    await expect(loadCropAsset(file.slice(0, -1))).rejects.toThrow("data length");
    await expect(loadCropAsset(new Blob([file, Uint8Array.of(0)]))).rejects.toThrow("data length");
    await expect(loadCropAsset(new Blob([header.replace("binary_little_endian", "ascii"), data]))).rejects.toThrow("binary little-endian");
    await expect(loadCropAsset(new Blob([header.replace("binary_little_endian", "binary_big_endian"), data]))).rejects.toThrow("binary little-endian");
    await expect(loadCropAsset(new Blob([header.replace("end_header", "element face 0\nend_header"), data]))).rejects.toThrow("single vertex element");
    await expect(loadCropAsset(new Blob([header.replace("uchar class_id", "list uchar int class_id"), data]))).rejects.toThrow("fixed-width scalar");
    await expect(loadCropAsset(new Blob([header.replace("class_id", "x"), data]))).rejects.toThrow("Duplicate");
    await expect(loadCropAsset(new Blob([header.replace("f_dc_0", "red"), data]))).rejects.toThrow("f_dc_0");
    await expect(loadCropAsset(new Blob([header.replace("vertex 1", "vertex 4000001"), data]))).rejects.toThrow("4,000,000");
    await expect(loadCropAsset(fixture([[0, Infinity, 2]]).file)).rejects.toThrow("Vertex 1 has a nonfinite Y center");
    await expect(loadCropAsset(fixture([[0, 1e100, 2]]).file)).rejects.toThrow("outside the editor's floating-point range");
    expect(() => parsePlyLayout(encoder.encode(header), MAX_FILE_BYTES + 1)).toThrow("256 MiB");
  });

  it("rejects Spark-incompatible header variants before producing a crop", async () => {
    const { header, data } = fixture([[0, 1, 2]]);
    for (const [source, message] of [
      [header.replaceAll("\n", "\r\n"), "LF line endings"],
      [header.replace("property float x", "property\uFEFFfloat x"), "invisible byte-order mark"],
      [header.replace("end_header\n", "end_header \n"), "single unpadded end_header"],
      [header.replace("comment original", "comment misleading end_header\ncomment original"), "single unpadded end_header"],
      [header.replace("float x", "float32 x"), 'Unsupported PLY scalar type "float32"'],
      [header.replace("uchar class_id", "uint8 class_id"), 'Unsupported PLY scalar type "uint8"'],
      [header.replace("f_rest_44", "extra"), "0, 9, 24 or 45"],
      [header.replace("f_rest_44", "f_rest_46"), "must be contiguous"],
      [header.replace("float f_rest_44", "int f_rest_44"), "use float or double"],
      [header.replace("end_header", "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header"), "reads PLY with red, green and blue properties as a point cloud"],
    ]) {
      await expect(loadCropAsset(new Blob([source, data]))).rejects.toThrow(message);
    }
  });

  it("keeps full extents in the sampled preview and counts the full asset", async () => {
    const points = Array.from({ length: 40_000 }, (): Point => [0, 0, 0]);
    points[13_371] = [17, -18, 19];
    points[29_061] = [-20, 21, -22];
    const asset = await loadCropAsset(fixture(points).file);
    expect(asset.bounds).toEqual({ min: [-20, -18, -22], max: [17, 21, 19] });
    expect(asset.sample.length / 3).toBeLessThanOrEqual(24_000);
    expect([...asset.sample.slice(0, 6)]).toEqual([-20, 21, -22, 17, -18, 19]);
    expect(await countInside(asset, box)).toBe(39_998);
  });

  it("cancels scans and exports without mutating the source crop", async () => {
    const { file } = fixture(Array.from({ length: 40_000 }, (_, index): Point => [index % 2, 0, 0]));
    const load = new AbortController();
    await expect(loadCropAsset(file, {
      signal: load.signal,
      progress: () => load.abort(),
    })).rejects.toHaveProperty("name", "AbortError");
    const asset = await loadCropAsset(file);
    const signal = new AbortController();
    const region: CropBounds = { min: [0, 0, 0], max: [0, 0, 0] };
    await expect(exportCrop(asset, region, "inside", {
      signal: signal.signal,
      progress: () => signal.abort(),
    })).rejects.toHaveProperty("name", "AbortError");
    expect(await countInside(asset, region)).toBe(20_000);
    const output = await exportCrop(asset, region, "inside");
    expect((await loadCropAsset(output)).layout.vertexCount).toBe(20_000);
  });

  it("loads the original degree-1 example and partitions one cluster", async () => {
    const asset = await loadCropAsset(createCropExample());
    expect(asset.layout.vertexCount).toBe(6_144);
    expect(await countInside(asset, { min: asset.bounds.min, max: [-0.8, asset.bounds.max[1], asset.bounds.max[2]] })).toBe(2_048);
  });
});
