import { ShapeUtils, Vector2 } from "three";
import type { Position, UVLayout, UVPoint } from "./obj.ts";
import { MAX_TILE, type Tile } from "./tile.ts";

export const ANALYSIS_LIMITS = {
  tiles: 8,
  corners: 64,
  pairs: 500,
  candidateVisits: 2_000_000,
  triangleTests: 1_000_000,
  outliersPerObject: 50,
  outlierFraction: 0.25,
  overlapArea: 1e-10,
  polygonRelativeTolerance: 1e-12,
  planarityRelativeTolerance: 1e-7,
} as const;

const GRID = 32;
const MAX_CELLS_PER_FACE = 16;

export type FaceRef = { object: number; face: number; line: number; island: number };
type FaceIssue = "tooManyCorners" | "zeroSourceArea" | "zeroUVArea" | "nonplanar" | "selfIntersecting";
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Triangle = [UVPoint, UVPoint, UVPoint];
type AnalyzedFace = { ref: FaceRef; bounds: Bounds; triangles: Triangle[] };
export type AreaSummary = { faces: number; uvArea: number; sourceArea: number };
export type IslandSummary = AreaSummary & { island: number; mappedFaces: number };
export type ObjectSummary = AreaSummary & {
  object: number;
  missingUVs: number;
  issues: Record<FaceIssue, number>;
  islands: IslandSummary[];
  outliers: Array<{ ref: FaceRef; densityRatio: number }>;
  outlierCount: number;
};
export type OverlapPair = { a: FaceRef; b: FaceRef; tile: Tile; area: number };
export type AnalysisResult = {
  objects: ObjectSummary[];
  pairs: OverlapPair[];
  stats: { candidateVisits: number; triangleTests: number };
  truncated: null | "pair limit" | "candidate budget" | "triangle budget";
};

function areas(): AreaSummary {
  return { faces: 0, uvArea: 0, sourceArea: 0 };
}

function accumulate(summary: AreaSummary, uvArea: number, sourceArea: number) {
  summary.faces++;
  summary.uvArea += uvArea;
  summary.sourceArea += sourceArea;
}

export function texelDensity(summary: AreaSummary, mapSize: number, unitScale: number): number | null {
  if (!summary.faces) return null;
  return mapSize * Math.sqrt(summary.uvArea) / Math.sqrt(summary.sourceArea) / unitScale;
}

function cross(a: UVPoint, b: UVPoint, c: UVPoint) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function twiceArea(points: UVPoint[]) {
  let sum = 0;
  for (let i = 1; i + 1 < points.length; i++) sum += cross(points[0], points[i], points[i + 1]);
  return sum;
}

function boundingBox(points: UVPoint[]): Bounds {
  const [x, y] = points[0];
  const box = { minX: x, maxX: x, minY: y, maxY: y };
  for (const [u, v] of points) {
    box.minX = Math.min(box.minX, u);
    box.maxX = Math.max(box.maxX, u);
    box.minY = Math.min(box.minY, v);
    box.maxY = Math.max(box.maxY, v);
  }
  return box;
}

function inspectPolygon(points: UVPoint[]): { area: number; bounds: Bounds; tolerance: number } | "zero" | "selfIntersecting" {
  const bounds = boundingBox(points);
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const lengthTolerance = span * ANALYSIS_LIMITS.polygonRelativeTolerance;
  const tolerance = lengthTolerance * span;
  const count = points.length;
  function sign(value: number) {
    return Math.abs(value) <= tolerance ? 0 : Math.sign(value);
  }

  for (let i = 0; i < count; i++) {
    const a = points[i], b = points[(i + 1) % count], c = points[(i + 2) % count];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= lengthTolerance) return "zero";
    if (count > 3 && sign(cross(a, b, c)) === 0
      && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) {
      return "selfIntersecting";
    }
  }
  for (let i = 0; i < count - 2; i++) {
    const a = points[i], b = points[i + 1];
    for (let j = i + 2; j < count; j++) {
      if (i === 0 && j === count - 1) continue; // The closing edge is adjacent to the first edge.
      const c = points[j], d = points[(j + 1) % count];
      if (Math.max(a[0], b[0]) + lengthTolerance < Math.min(c[0], d[0])
        || Math.max(c[0], d[0]) + lengthTolerance < Math.min(a[0], b[0])
        || Math.max(a[1], b[1]) + lengthTolerance < Math.min(c[1], d[1])
        || Math.max(c[1], d[1]) + lengthTolerance < Math.min(a[1], b[1])) continue;
      if (sign(cross(a, b, c)) * sign(cross(a, b, d)) <= 0
        && sign(cross(c, d, a)) * sign(cross(c, d, b)) <= 0) return "selfIntersecting";
    }
  }
  const area = Math.abs(twiceArea(points)) / 2;
  if (!Number.isFinite(area) || area <= tolerance) return "zero";
  return { area, bounds, tolerance };
}

function sourceArea(points: Position[]): number | FaceIssue {
  const [x, y, z] = points[0];
  const relative = points.map(([a, b, c]): Position => [a - x, b - y, c - z]);
  let axis = relative[0], extent = 0;
  for (const point of relative) {
    const length = Math.hypot(...point);
    if (length > extent) {
      extent = length;
      axis = point;
    }
  }
  const [a, b, c] = axis;
  let normal: Position = [0, 0, 0], length = 0;
  for (const [u, v, w] of relative) {
    const candidate: Position = [b * w - c * v, c * u - a * w, a * v - b * u];
    const magnitude = Math.hypot(...candidate);
    if (magnitude > length) {
      normal = candidate;
      length = magnitude;
    }
  }
  if (length <= extent * extent * ANALYSIS_LIMITS.polygonRelativeTolerance) return "zeroSourceArea";
  const [nx, ny, nz] = normal.map(component => component / length);
  for (const [u, v, w] of relative) {
    if (Math.abs(u * nx + v * ny + w * nz) > extent * ANALYSIS_LIMITS.planarityRelativeTolerance) return "nonplanar";
  }
  const components = normal.map(Math.abs);
  const dominant = Math.max(...components);
  const drop = components.indexOf(dominant);
  const projection = relative.map((p): UVPoint => [p[(drop + 1) % 3], p[(drop + 2) % 3]]);
  const polygon = inspectPolygon(projection);
  if (polygon === "zero") return "zeroSourceArea";
  if (polygon === "selfIntersecting") return polygon;
  return polygon.area * (length / dominant);
}

function triangulate(points: UVPoint[]): Triangle[] {
  if (points.length === 3) {
    const [a, b, c] = points;
    return [cross(a, b, c) > 0 ? [a, b, c] : [a, c, b]];
  }
  const [u, v] = points[0];
  const vertices = points.map(([x, y]) => new Vector2(x - u, y - v));
  return ShapeUtils.triangulateShape(vertices, []).flatMap(([i, j, k]) => {
    const a = points[i], b = points[j], c = points[k];
    const turn = cross(a, b, c);
    if (turn === 0) return [];
    return [turn > 0 ? [a, b, c] : [a, c, b]];
  });
}

function classifyUV(points: UVPoint[]) {
  const inspected = inspectPolygon(points);
  if (inspected === "zero") return "zeroUVArea" as const;
  if (inspected === "selfIntersecting") return inspected;
  const triangles = triangulate(points);
  const area = triangles.reduce((sum, [a, b, c]) => sum + cross(a, b, c) / 2, 0);
  if (!triangles.length || Math.abs(area - inspected.area) > inspected.tolerance) return "selfIntersecting" as const;
  return { ...inspected, triangles };
}

function clip(points: UVPoint[], distance: (point: UVPoint) => number): UVPoint[] {
  const result: UVPoint[] = [];
  let previous = points.at(-1);
  if (!previous) return result;
  let before = distance(previous);
  for (const current of points) {
    const after = distance(current);
    if ((before >= 0) !== (after >= 0)) {
      const t = before / (before - after);
      result.push([previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t]);
    }
    if (after >= 0) result.push(current);
    previous = current;
    before = after;
  }
  return result;
}

function tileBounds(face: Bounds, { u, v }: Tile): Bounds | undefined {
  const minX = Math.max(0, face.minX - u), maxX = Math.min(1, face.maxX - u);
  const minY = Math.max(0, face.minY - v), maxY = Math.min(1, face.maxY - v);
  if (maxX > minX && maxY > minY) return { minX, minY, maxX, maxY };
}

function intersect(a: Triangle, b: Triangle, { u, v }: Tile): number {
  let points = a.map(([x, y]): UVPoint => [x - u, y - v]);
  points = clip(points, ([x]) => x);
  points = clip(points, ([x]) => 1 - x);
  points = clip(points, ([, y]) => y);
  points = clip(points, ([, y]) => 1 - y);
  const other = b.map(([x, y]): UVPoint => [x - u, y - v]);
  for (let i = 0; i < 3 && points.length >= 3; i++) {
    points = clip(points, point => cross(other[i], other[(i + 1) % 3], point));
  }
  return points.length >= 3 ? Math.abs(twiceArea(points)) / 2 : 0;
}

function findOverlaps(faces: AnalyzedFace[], tiles: Tile[], result: AnalysisResult) {
  for (const tile of tiles) {
    const grid: number[][] = Array.from({ length: GRID * GRID }, () => []);
    const wide: number[] = [];
    const indexed: number[] = [];
    const bounds: Array<Bounds | undefined> = [];
    const visited = new Int32Array(faces.length);
    const cell = (value: number) => Math.min(GRID - 1, Math.floor(GRID * value));
    for (const [i, face] of faces.entries()) {
      const box = tileBounds(face.bounds, tile);
      if (!box) continue;
      bounds[i] = box;
      const left = cell(box.minX), right = cell(box.maxX), bottom = cell(box.minY), top = cell(box.maxY);
      const isWide = (right - left + 1) * (top - bottom + 1) > MAX_CELLS_PER_FACE;
      const cells: number[][] = [];
      if (!isWide) {
        for (let y = bottom; y <= top; y++) {
          for (let x = left; x <= right; x++) cells.push(grid[y * GRID + x]);
        }
      }
      for (const candidates of isWide ? [indexed] : [wide, ...cells]) {
        for (const j of candidates) {
          if (result.stats.candidateVisits === ANALYSIS_LIMITS.candidateVisits) return "candidate budget";
          result.stats.candidateVisits++;
          if (visited[j] === i + 1) continue;
          visited[j] = i + 1;
          const previous = bounds[j]!;
          if (box.minX >= previous.maxX || box.minY >= previous.maxY || box.maxX <= previous.minX || box.maxY <= previous.minY) continue;
          let area = 0;
          for (const a of faces[j].triangles) {
            for (const b of face.triangles) {
              if (result.stats.triangleTests === ANALYSIS_LIMITS.triangleTests) return "triangle budget";
              result.stats.triangleTests++;
              area += intersect(a, b, tile);
            }
          }
          if (area <= ANALYSIS_LIMITS.overlapArea) continue;
          if (result.pairs.length === ANALYSIS_LIMITS.pairs) return "pair limit";
          result.pairs.push({ a: faces[j].ref, b: face.ref, tile, area });
        }
      }
      indexed.push(i);
      if (isWide) wide.push(i);
      else for (const bucket of cells) bucket.push(i);
    }
  }
  return null;
}

export function analyzeUVLayout(layout: UVLayout, selectedObjects: readonly number[], tiles: readonly Tile[]): AnalysisResult {
  if (!tiles.length || tiles.length > ANALYSIS_LIMITS.tiles
    || tiles.some(({ u, v }) => ![u, v].every(value => Number.isInteger(value) && Math.abs(value) <= MAX_TILE))) {
    throw Error("Choose 1–8 integer U, V tiles within ±1,000,000.");
  }
  const uniqueTiles = [...new Map(tiles.map(tile => [`${tile.u},${tile.v}`, tile])).values()];
  const selected = new Set(selectedObjects);
  const result: AnalysisResult = { objects: [], pairs: [], stats: { candidateVisits: 0, triangleTests: 0 }, truncated: null };
  const faces: AnalyzedFace[] = [];

  layout.objects.forEach((object, index) => {
    if (!selected.has(index)) return;
    const summary: ObjectSummary = {
      ...areas(), object: index, missingUVs: object.missing,
      issues: { tooManyCorners: 0, zeroSourceArea: 0, zeroUVArea: 0, nonplanar: 0, selfIntersecting: 0 },
      islands: Array.from({ length: object.islands }, (_, i) => ({ ...areas(), island: i + 1, mappedFaces: 0 })),
      outliers: [], outlierCount: 0,
    };
    const densities: { ref: FaceRef; density: number }[] = [];
    object.mappedFaces.forEach(({ line, vertices, uvs, island }, face) => {
      const islandSummary = summary.islands[island - 1];
      islandSummary.mappedFaces++;
      if (uvs.length > ANALYSIS_LIMITS.corners) {
        summary.issues.tooManyCorners++;
        return;
      }
      const worldArea = sourceArea(vertices.map(vertex => layout.positions[vertex]));
      if (typeof worldArea === "string") {
        summary.issues[worldArea]++;
        return;
      }
      const uv = classifyUV(uvs.map(uv => layout.coordinates[uv]));
      if (typeof uv === "string") {
        summary.issues[uv]++;
        return;
      }
      const ref = { object: index, face, line, island };
      accumulate(summary, uv.area, worldArea);
      accumulate(islandSummary, uv.area, worldArea);
      densities.push({ ref, density: Math.sqrt(uv.area) / Math.sqrt(worldArea) });
      if (uniqueTiles.some(tile => tileBounds(uv.bounds, tile))) {
        faces.push({ ref, bounds: uv.bounds, triangles: uv.triangles });
      }
    });
    const baseline = texelDensity(summary, 1, 1);
    if (baseline !== null) {
      const outliers = densities.map(({ ref, density }) => ({ ref, densityRatio: density / baseline }))
        .filter(({ densityRatio }) => Math.abs(densityRatio - 1) > ANALYSIS_LIMITS.outlierFraction);
      summary.outlierCount = outliers.length;
      summary.outliers = outliers.sort((a, b) => Math.abs(b.densityRatio - 1) - Math.abs(a.densityRatio - 1))
        .slice(0, ANALYSIS_LIMITS.outliersPerObject);
    }
    result.objects.push(summary);
  });

  result.truncated = findOverlaps(faces, uniqueTiles, result);
  return result;
}
