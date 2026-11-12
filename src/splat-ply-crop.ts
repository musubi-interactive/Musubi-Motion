export type Point = [number, number, number];
export type CropBounds = { min: Point; max: Point };
export type CropSide = "inside" | "outside";

type Scalar = { bytes: number; float?: "float32" | "float64" };
const int8 = { bytes: 1 };
const int16 = { bytes: 2 };
const int32 = { bytes: 4 };
const float32 = { bytes: 4, float: "float32" } as const;
const float64 = { bytes: 8, float: "float64" } as const;
const scalars = new Map<string, Scalar>([
  ["char", int8], ["uchar", int8], ["short", int16], ["ushort", int16],
  ["int", int32], ["uint", int32], ["float", float32], ["double", float64],
]);
const requiredGaussian = [
  "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
  "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
];

export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_RECORDS = 4_000_000;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PROPERTIES = 256;
const IO_WINDOW_BYTES = 2 * 1024 * 1024;
const SAMPLE_RECORDS = 24_000;
const axisNames = ["x", "y", "z"];

type Property = { offset: number; type: Scalar };
type PlyLayout = {
  vertexCount: number;
  stride: number;
  dataOffset: number;
  beforeCount: string;
  afterCount: string;
  positions: [Property, Property, Property];
};
export type CropAsset = {
  file: Blob;
  layout: PlyLayout;
  centers: Float64Array;
  bounds: CropBounds;
  sample: Float64Array;
};

export function parsePlyLayout(prefix: Uint8Array, fileBytes: number): PlyLayout {
  if (fileBytes > MAX_FILE_BYTES) throw new Error("The PLY file exceeds 256 MiB.");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const lines: string[] = [];
  let offset = 0;
  for (let i = 0; i < Math.min(prefix.length, MAX_HEADER_BYTES); i++) {
    if (prefix[i] !== 10) continue;
    let line: string;
    try {
      line = decoder.decode(prefix.subarray(offset, i + 1));
    } catch {
      throw new Error("The PLY header contains invalid text.");
    }
    if (line.includes("\uFEFF")) {
      throw new Error("The PLY header contains an invisible byte-order mark (U+FEFF). Export a PLY header without it.");
    }
    if (line.includes("\r")) throw new Error("Use LF line endings in the PLY header for editor import.");
    lines.push(line);
    offset = i + 1;
    if (line === "end_header\n") break;
    // Spark finds the first literal terminator even if it occurs within a comment or declaration.
    if (line.trim() === "end_header" || line.endsWith("end_header\n")) {
      throw new Error("Use a single unpadded end_header line at the end of the PLY header.");
    }
  }
  if (lines[0] !== "ply\n" || lines.at(-1) !== "end_header\n") {
    throw new Error("Expected a PLY header ending with end_header within 64 KiB.");
  }

  let sawFormat = false;
  let vertexCount: number | undefined;
  let countLine = -1;
  let countMatch: RegExpExecArray | null = null;
  let stride = 0;
  const properties = new Map<string, Property>();
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    const [keyword, ...args] = line.split(/\s+/);
    if (keyword === "comment" || keyword === "obj_info") continue;
    if (keyword === "format") {
      if (sawFormat || vertexCount !== undefined || args.join(" ") !== "binary_little_endian 1.0") {
        throw new Error("Use uncompressed binary little-endian PLY 1.0.");
      }
      sawFormat = true;
      continue;
    }
    if (keyword === "element") {
      if (!sawFormat || vertexCount !== undefined || args[0] !== "vertex") {
        throw new Error("The PLY must contain a single vertex element. Faces and compressed chunks are unsupported.");
      }
      countMatch = /^([ \t]*element[ \t]+vertex[ \t]+)([0-9]+)([ \t]*\n)$/.exec(lines[i]);
      if (!countMatch) throw new Error("The vertex count in the PLY header is invalid.");
      vertexCount = Number(countMatch[2]);
      if (!Number.isSafeInteger(vertexCount) || vertexCount < 1 || vertexCount > MAX_RECORDS) {
        throw new Error("The PLY must contain between 1 and 4,000,000 splats.");
      }
      countLine = i;
      continue;
    }
    if (keyword !== "property" || vertexCount === undefined) {
      throw new Error("The PLY header has an unexpected declaration.");
    }
    const [nameOfType, name] = args;
    const type = scalars.get(nameOfType);
    if (nameOfType === "list" || args.length !== 2 || !/^[!-~]+$/.test(name)) {
      throw new Error("Use fixed-width scalar vertex properties. List properties are unsupported.");
    }
    if (!type) {
      throw new Error(`Unsupported PLY scalar type "${nameOfType}". Use char, uchar, short, ushort, int, uint, float or double for editor import.`);
    }
    if (properties.has(name)) throw new Error(`Duplicate PLY property: ${name}.`);
    if (properties.size >= MAX_PROPERTIES) throw new Error("The PLY has more than 256 vertex properties.");
    properties.set(name, { offset: stride, type });
    stride += type.bytes;
  }
  if (vertexCount === undefined || !countMatch) throw new Error("The PLY header is missing the vertex element.");
  for (const name of [...axisNames, ...requiredGaussian]) {
    if (!properties.get(name)?.type.float) {
      throw new Error(`Expected a floating-point ${name} property in the Gaussian PLY.`);
    }
  }
  if (["red", "green", "blue"].every(name => properties.has(name))) {
    throw new Error("The editor reads PLY with red, green and blue properties as a point cloud. Export a Gaussian PLY without the RGB triplet.");
  }
  const shCount = [...properties.keys()].filter(name => name.startsWith("f_rest_")).length;
  if (![0, 9, 24, 45].includes(shCount)) {
    throw new Error("Use 0, 9, 24 or 45 contiguous f_rest_ spherical harmonic properties.");
  }
  for (let index = 0; index < shCount; index++) {
    if (!properties.get(`f_rest_${index}`)?.type.float) {
      throw new Error("Spherical harmonic properties must be contiguous and use float or double.");
    }
  }
  if (offset + vertexCount * stride !== fileBytes) {
    throw new Error("The PLY data length does not match the declared vertex count and properties.");
  }
  const positions: PlyLayout["positions"] = [
    properties.get("x")!, properties.get("y")!, properties.get("z")!,
  ];
  return {
    vertexCount, stride, positions, dataOffset: offset,
    beforeCount: lines.slice(0, countLine).join("") + countMatch[1],
    afterCount: countMatch[3] + lines.slice(countLine + 1).join(""),
  };
}

type WorkOptions = { signal?: AbortSignal; progress?: (ratio: number) => void };

function yieldToWorker(signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0)).then(() => signal?.throwIfAborted());
}

function assertBounds(bounds: CropBounds): void {
  if (bounds.min.length !== 3 || bounds.max.length !== 3) throw new Error("Expected three crop axes.");
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(bounds.min[axis]) || !Number.isFinite(bounds.max[axis]) || bounds.min[axis] > bounds.max[axis]) {
      throw new Error(`Enter finite ${axisNames[axis].toUpperCase()} bounds with Min at or below Max.`);
    }
  }
}

export function containsCenter(centers: ArrayLike<number>, index: number, bounds: CropBounds): boolean {
  const { min, max } = bounds;
  return centers[index] >= min[0] && centers[index] <= max[0]
    && centers[index + 1] >= min[1] && centers[index + 1] <= max[1]
    && centers[index + 2] >= min[2] && centers[index + 2] <= max[2];
}

function readPosition(view: DataView, start: number, property: Property): number {
  const offset = start + property.offset;
  return property.type.float === "float32" ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
}

function representativeSample(centers: Float64Array, extrema: readonly number[]): Float64Array {
  const count = centers.length / 3;
  if (count <= SAMPLE_RECORDS) return centers.slice();
  const budget = SAMPLE_RECORDS - extrema.length;
  const indices = new Set(extrema);
  for (let i = 0; i < budget; i++) indices.add(Math.floor(i * (count - 1) / (budget - 1)));
  const result = new Float64Array(indices.size * 3);
  let target = 0;
  for (const index of indices) {
    const start = index * 3;
    result[target++] = centers[start];
    result[target++] = centers[start + 1];
    result[target++] = centers[start + 2];
  }
  return result;
}

export async function loadCropAsset(file: Blob, { signal, progress }: WorkOptions = {}): Promise<CropAsset> {
  signal?.throwIfAborted();
  if (file.size > MAX_FILE_BYTES) throw new Error("The PLY file exceeds 256 MiB.");
  const header = new Uint8Array(await file.slice(0, MAX_HEADER_BYTES).arrayBuffer());
  const layout = parsePlyLayout(header, file.size);
  signal?.throwIfAborted();
  const { vertexCount, stride, positions, dataOffset } = layout;
  const centers = new Float64Array(vertexCount * 3);
  const bounds: CropBounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  const extrema = [0, 0, 0, 0, 0, 0];
  const windowRecords = Math.floor(IO_WINDOW_BYTES / stride);
  for (let start = 0; start < vertexCount; start += windowRecords) {
    const end = Math.min(vertexCount, start + windowRecords);
    const data = new DataView(await file.slice(dataOffset + start * stride, dataOffset + end * stride).arrayBuffer());
    signal?.throwIfAborted();
    for (let index = start; index < end; index++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = readPosition(data, (index - start) * stride, positions[axis]);
        if (!Number.isFinite(value)) throw new Error(`Vertex ${index + 1} has a nonfinite ${axisNames[axis].toUpperCase()} center.`);
        if (!Number.isFinite(Math.fround(value))) {
          throw new Error(`Vertex ${index + 1} has a ${axisNames[axis].toUpperCase()} center outside the editor's floating-point range.`);
        }
        centers[index * 3 + axis] = value;
        if (value < bounds.min[axis]) {
          bounds.min[axis] = value;
          extrema[axis] = index;
        }
        if (value > bounds.max[axis]) {
          bounds.max[axis] = value;
          extrema[axis + 3] = index;
        }
      }
    }
    progress?.(end / vertexCount);
    await yieldToWorker(signal);
  }
  return { file, layout, centers, bounds, sample: representativeSample(centers, extrema) };
}

export async function countInside(asset: CropAsset, bounds: CropBounds, { signal }: WorkOptions = {}): Promise<number> {
  assertBounds(bounds);
  signal?.throwIfAborted();
  const { centers } = asset;
  const window = 262_144 * 3;
  let inside = 0;
  for (let start = 0; start < centers.length; start += window) {
    const end = Math.min(centers.length, start + window);
    for (let index = start; index < end; index += 3) {
      if (containsCenter(centers, index, bounds)) inside++;
    }
    if (end < centers.length) await yieldToWorker(signal);
  }
  return inside;
}

export async function exportCrop(asset: CropAsset, bounds: CropBounds, side: CropSide, options: WorkOptions = {}): Promise<Blob> {
  const { signal, progress } = options;
  const { file, centers, layout } = asset;
  const { vertexCount, stride, dataOffset, beforeCount, afterCount } = layout;
  const inside = await countInside(asset, bounds, options);
  const count = side === "inside" ? inside : vertexCount - inside;
  if (count === 0) throw new Error(`The ${side} region contains no splats.`);
  const header = beforeCount + count + afterCount;
  if (count === vertexCount) return new Blob([header, file.slice(dataOffset)], { type: "application/octet-stream" });

  const parts: BlobPart[] = [header];
  const windowRecords = Math.floor(IO_WINDOW_BYTES / stride);
  const keepInside = side === "inside";
  for (let start = 0; start < vertexCount; start += windowRecords) {
    const end = Math.min(vertexCount, start + windowRecords);
    let kept = 0;
    for (let index = start; index < end; index++) {
      if (containsCenter(centers, index * 3, bounds) === keepInside) kept++;
    }
    if (kept === end - start) {
      parts.push(file.slice(dataOffset + start * stride, dataOffset + end * stride));
    } else if (kept > 0) {
      const data = new Uint8Array(await file.slice(dataOffset + start * stride, dataOffset + end * stride).arrayBuffer());
      signal?.throwIfAborted();
      const filtered = new Uint8Array(kept * stride);
      let target = 0;
      for (let index = start; index < end; index++) {
        if (containsCenter(centers, index * 3, bounds) !== keepInside) continue;
        const record = (index - start) * stride;
        filtered.set(data.subarray(record, record + stride), target);
        target += stride;
      }
      parts.push(new Blob([filtered]));
    }
    progress?.(end / vertexCount);
    await yieldToWorker(signal);
  }
  return new Blob(parts, { type: "application/octet-stream" });
}
