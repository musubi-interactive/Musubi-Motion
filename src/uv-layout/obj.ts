export const MAX_OBJ_BYTES = 32 * 1024 * 1024;
const MAX_POINTS = 200_000;
const MAX_FACES = 100_000;
const MAX_CORNERS = 500_000;
const MAX_FACE_CORNERS = 1024;
const MAX_OBJECTS = 1000;
const MAX_LINE_LENGTH = 64 * 1024;
const MAX_COORDINATE = 1_000_000;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export type UVPoint = [number, number];
export type UVEdge = { start: number; end: number; uses: number };
export type UVObject = {
  name: string;
  faces: number;
  missing: number;
  degenerate: number;
  outside: number;
  islands: number;
  edges: UVEdge[];
};
export type UVLayout = { coordinates: UVPoint[]; objects: UVObject[] };

type Corner = { vertex: number; uv?: number; normal?: number };
type Face = { line: number; corners: Corner[] };
type ObjectFaces = { name: string; faces: Face[] };

function invalid(line: number, message: string): never {
  throw Error(`Line ${line}: ${message}`);
}

function coordinate(text: string, line: number): number {
  const value = Number(text);
  if (!DECIMAL.test(text) || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) {
    invalid(line, "Expected a finite coordinate within ±1,000,000.");
  }
  return value;
}

function index(text: string, length: number, line: number): number {
  const value = Number(text);
  if (!/^[+-]?\d+$/.test(text) || !Number.isSafeInteger(value) || !value || value > MAX_POINTS) {
    invalid(line, "Invalid OBJ face index.");
  }
  const resolved = value > 0 ? value - 1 : length + value;
  if (resolved < 0) invalid(line, "Relative face index precedes its coordinate list.");
  return resolved;
}

function faceCorner(text: string, vertices: number, uvs: number, normals: number, line: number): Corner {
  const [vertex, uv, normal, ...extra] = text.split("/");
  if (!vertex || extra.length || (normal === undefined && uv === "") || normal === "") {
    invalid(line, "Expected v, v/vt, v//vn or v/vt/vn in a face.");
  }
  return {
    vertex: index(vertex, vertices, line),
    uv: uv ? index(uv, uvs, line) : undefined,
    normal: normal ? index(normal, normals, line) : undefined,
  };
}

function* lines(source: string): Generator<{ line: number; content: string }> {
  let firstLine = 1;
  let physicalLine = 0;
  let pending = "";
  let continued = false;
  for (const match of source.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g)) {
    if (!match[0]) break;
    const raw = match[1];
    physicalLine++;
    if (!continued) firstLine = physicalLine;
    const content = raw.split("#", 1)[0].trim();
    if (pending.length + content.length > MAX_LINE_LENGTH) invalid(firstLine, "OBJ line is too long.");
    continued = content.endsWith("\\");
    if (continued) {
      pending += content.slice(0, -1) + " ";
    } else {
      if (pending || content) yield { line: firstLine, content: (pending + content).trim() };
      pending = "";
    }
  }
  if (continued) invalid(firstLine, "Unfinished OBJ line continuation.");
}

/** Read position/texture/normal indices independently. UV topology needs the
 * original polygon corners, which the renderer-oriented OBJLoader triangulates. */
export function parseObjUVLayout(source: string): UVLayout {
  if (source.length > MAX_OBJ_BYTES) throw Error("OBJ files may be at most 32 MiB.");
  let vertices = 0, normals = 0, faceCount = 0, cornerCount = 0;
  const coordinates: UVPoint[] = [];
  const objects: ObjectFaces[] = [];
  let active: ObjectFaces = { name: "Default object", faces: [] };
  for (const { line, content } of lines(source)) {
    const separator = content.search(/\s/);
    const keyword = separator < 0 ? content : content.slice(0, separator);
    const args = separator < 0 ? "" : content.slice(separator).trim();
    if (keyword === "o") {
      if (args.length > 256) invalid(line, "Object names may contain up to 256 characters.");
      active = { name: args || "Unnamed object", faces: [] };
      continue;
    }
    if (!["v", "vt", "vn", "f"].includes(keyword)) continue;
    const parts = args ? args.split(/\s+/) : [];
    if (keyword === "v") {
      if (parts.length < 3 || parts.length > 8 || ++vertices > MAX_POINTS) {
        invalid(line, "Expected a position with 3–8 values within the 200,000 position limit.");
      }
      for (const part of parts) coordinate(part, line);
    } else if (keyword === "vt") {
      if (parts.length < 1 || parts.length > 3 || coordinates.length >= MAX_POINTS) {
        invalid(line, "Expected a texture coordinate with 1–3 values within the 200,000 UV limit.");
      }
      const [u, v = 0] = parts.map(part => coordinate(part, line));
      coordinates.push([u, v]);
    } else if (keyword === "vn") {
      if (parts.length !== 3 || ++normals > MAX_POINTS) {
        invalid(line, "Expected a normal with 3 values within the 200,000 normal limit.");
      }
      for (const part of parts) coordinate(part, line);
    } else {
      cornerCount += parts.length;
      if (parts.length < 3 || parts.length > MAX_FACE_CORNERS) invalid(line, "Faces need 3–1,024 corners.");
      if (++faceCount > MAX_FACES || cornerCount > MAX_CORNERS) {
        invalid(line, "OBJ files support up to 100,000 faces and 500,000 face corners.");
      }
      if (!active.faces.length) {
        if (objects.length >= MAX_OBJECTS) invalid(line, "OBJ files support up to 1,000 polygon objects.");
        objects.push(active);
      }
      active.faces.push({ line, corners: parts.map(part => faceCorner(part, vertices, coordinates.length, normals, line)) });
    }
  }
  if (!faceCount) throw Error("This OBJ contains no polygon faces.");
  for (const object of objects) {
    for (const face of object.faces) {
      for (const corner of face.corners) {
        if (corner.vertex >= vertices || (corner.uv !== undefined && corner.uv >= coordinates.length)
          || (corner.normal !== undefined && corner.normal >= normals)) {
          invalid(face.line, "Face index references a missing position, UV or normal.");
        }
      }
    }
  }
  return { coordinates, objects: objects.map(object => analyze(object, coordinates)) };
}

function areaIsZero(indices: number[], coordinates: UVPoint[]): boolean {
  const [originX, originY] = coordinates[indices[0]];
  let twiceArea = 0, extent = 0;
  for (let i = 1; i < indices.length - 1; i++) {
    const [ax, ay] = coordinates[indices[i]], [bx, by] = coordinates[indices[i + 1]];
    const x = ax - originX, y = ay - originY, nextX = bx - originX, nextY = by - originY;
    twiceArea += x * nextY - y * nextX;
    extent = Math.max(extent, Math.abs(x), Math.abs(y), Math.abs(nextX), Math.abs(nextY));
  }
  return Math.abs(twiceArea) <= extent * extent * 1e-12;
}

function rootOf(parents: Uint32Array, index: number): number {
  while (parents[index] !== index) {
    parents[index] = parents[parents[index]];
    index = parents[index];
  }
  return index;
}

function analyze(object: ObjectFaces, coordinates: UVPoint[]): UVObject {
  const parents = Uint32Array.from(object.faces, (_face, index) => index);
  const edges = new Map<string, { edge: UVEdge; firstFace: number; lastFace: number }>();
  let islands = 0, missing = 0, degenerate = 0, outside = 0;
  object.faces.forEach(({ corners }, faceIndex) => {
    const indices = corners.map(corner => corner.uv);
    if (!indices.every(uv => uv !== undefined)) {
      missing++;
      return;
    }
    islands++;
    if (areaIsZero(indices, coordinates)) degenerate++;
    if (indices.some(index => coordinates[index].some(value => value < 0 || value > 1))) outside++;
    corners.forEach((corner, index) => {
      const nextIndex = (index + 1) % corners.length;
      const neighbor = corners[nextIndex];
      const a = `${corner.vertex}/${indices[index]}`, b = `${neighbor.vertex}/${indices[nextIndex]}`;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const previous = edges.get(key);
      if (!previous) {
        edges.set(key, { edge: { start: indices[index], end: indices[nextIndex], uses: 1 }, firstFace: faceIndex, lastFace: faceIndex });
        return;
      }
      if (previous.lastFace === faceIndex) return;
      previous.lastFace = faceIndex;
      previous.edge.uses++;
      const currentRoot = rootOf(parents, faceIndex), previousRoot = rootOf(parents, previous.firstFace);
      if (currentRoot !== previousRoot) {
        parents[currentRoot] = previousRoot;
        islands--;
      }
    });
  });
  return {
    name: object.name,
    faces: object.faces.length,
    missing,
    degenerate,
    outside,
    islands,
    edges: [...edges.values()].map(record => record.edge),
  };
}
