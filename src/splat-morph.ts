import { Matrix4, Vector3 } from "three";
import type { MeshShapeNode, SplatShapeNode, Vec3 } from "./scene-document.ts";

type MorphTarget = { name: string; weight: number };
type VertexDelta = [vertex: number, dx: number, dy: number, dz: number];
type FaceRun = [end: number, a: number, b: number, c: number];
export type SplatMorphSurface = {
  sourceCount: number;
  vertices: Vec3[];
  faces: FaceRun[];
  deltas: VertexDelta[][];
};
export type SplatMorphPose = { surface: SplatMorphSurface; weights: readonly number[] };
type MorphShape = { morphTargets?: MorphTarget[]; morphSurface?: SplatMorphSurface };
export const SPLAT_MORPH_WEIGHT_LIMIT = 1_000_000;
const deltaLimit = 1_000_000;
const bounded = (v: number) => Number.isFinite(v) && Math.abs(v) <= 1e6;
export function splatMorphPose(shape: MorphShape, weights?: readonly number[]): SplatMorphPose | undefined {
  if (shape.morphSurface && shape.morphTargets) {
    return { surface: shape.morphSurface, weights: weights ?? shape.morphTargets.map(m => m.weight) };
  }
}

// Samples are emitted in triangle order. One affine per retained triangle moves every
// Gaussian on its surface and transports both in-plane axes and the normal thickness.
export function buildSplatMorphSurface(shape: MeshShapeNode, runs: { end: number; ids: readonly string[] }[]): SplatMorphSurface {
  const sourceIndices = new Map(shape.vertices.map(v => [v.id, v.position]));
  const indices = new Map<string, number>(), vertices: Vec3[] = [];
  function vertex(id: string) {
    let index = indices.get(id);
    if (index === undefined) {
      index = vertices.length;
      vertices.push([...sourceIndices.get(id)!]);
      indices.set(id, index);
    }
    return index;
  }
  const faces = runs.map(({ end, ids }): FaceRun => [end, vertex(ids[0]), vertex(ids[1]), vertex(ids[2])]);
  let changes = 0;
  const deltas = shape.morphTargets!.map(target => {
    const rows: VertexDelta[] = [];
    for (const [id,index] of indices) {
      const d = target.deltas[id];
      if (d.some(value => value !== 0)) {
        if (++changes > deltaLimit) throw Error("Converted blend shapes exceed one million affected vertex entries.");
        rows.push([index, ...d]);
      }
    }
    return rows;
  });
  return { sourceCount: faces.at(-1)![0], vertices, faces, deltas };
}

export function validateSplatMorphs(shape: MorphShape & Partial<Pick<SplatShapeNode, "componentEdits" | "componentTransforms" | "binding" | "deformers" | "selectionSets" | "scalarMasks" | "appearance" | "attributePaint">>, count?: number) {
  const { morphTargets: targets, morphSurface: s } = shape;
  if (targets === undefined && s === undefined) return;
  const fail = () => { throw Error("Invalid splat blend-shape surface or original source count."); };
  if (!s || !Array.isArray(targets) || !targets.length || targets.length > 128 ||
      targets.some(t => !t || typeof t.name !== "string" || !t.name.trim() || !Number.isFinite(t.weight) || Math.abs(t.weight) > SPLAT_MORPH_WEIGHT_LIMIT)) return fail();
  const authoredCounts = [count, shape.componentEdits?.sourceCount, shape.componentTransforms?.sourceCount, shape.binding?.weights?.count,
    shape.deformers?.[0]?.sourceCount, shape.selectionSets?.[0]?.sourceCount, shape.scalarMasks?.[0]?.sourceCount,
    shape.appearance?.sourceCount, shape.attributePaint?.sourceCount];
  if (!Number.isInteger(s.sourceCount) || s.sourceCount < 1 || s.sourceCount > 100000 || authoredCounts.some(value => value !== undefined && value !== s.sourceCount) ||
      !Array.isArray(s.vertices) || s.vertices.length < 3 || s.vertices.length > 3 * s.sourceCount ||
      !Array.isArray(s.faces) || !s.faces.length || s.faces.length > s.sourceCount ||
      !Array.isArray(s.deltas) || s.deltas.length !== targets.length) return fail();
  for (const v of s.vertices) if (!Array.isArray(v) || v.length !== 3 || !v.every(bounded)) return fail();
  let end = 0, changes = 0;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (const face of s.faces) {
    if (!Array.isArray(face) || face.length !== 4 || face[0] <= end || !Number.isInteger(face[0]) || face[0] > s.sourceCount ||
        face.slice(1).some(i => !Number.isInteger(i) || i < 0 || i >= s.vertices.length)) return fail();
    a.fromArray(s.vertices[face[1]]);
    if (b.fromArray(s.vertices[face[2]]).sub(a).cross(c.fromArray(s.vertices[face[3]]).sub(a)).lengthSq() === 0) return fail();
    end = face[0];
  }
  if (end !== s.sourceCount) return fail();
  for (const rows of s.deltas) {
    if (!Array.isArray(rows) || (changes += rows.length) > deltaLimit) return fail();
    let previous = -1;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 4 || !Number.isInteger(row[0]) || row[0] <= previous || row[0] >= s.vertices.length ||
          !bounded(row[1]) || !bounded(row[2]) || !bounded(row[3])) return fail();
      previous = row[0];
    }
  }
}

export function subsetSplatMorphSurface(surface: SplatMorphSurface, ids: Uint32Array): SplatMorphSurface {
  const faces: FaceRun[] = [];
  let offset = 0;
  for (const [end, a, b, c] of surface.faces) {
    const start = offset;
    while (offset < ids.length && ids[offset] < end) offset++;
    if (offset > start) faces.push([offset, a, b, c]);
  }
  // Compact the referenced vertices so small selections remain small after a save.
  const vertices: Vec3[] = [], indices = new Map<number, number>();
  // Sorted original IDs also preserve the required ordering of sparse deltas.
  const members = new Set<number>();
  for (const [, a,b,c] of faces) { members.add(a); members.add(b); members.add(c); }
  for (const original of [...members].sort((a,b) => a-b)) {
    indices.set(original, vertices.length);
    vertices.push(surface.vertices[original]);
  }
  return { sourceCount: ids.length, vertices, faces: faces.map(([end,a,b,c]) => [end,indices.get(a)!,indices.get(b)!,indices.get(c)!]),
    deltas: surface.deltas.map(rows => rows.flatMap(([i,x,y,z]): VertexDelta[] => {
      const mapped = indices.get(i);
      return mapped === undefined ? [] : [[mapped,x,y,z]];
    })) };
}

type RestFace = { origin: Vector3; u: Vector3; v: Vector3; normal: Vector3; inverse: Matrix4 };
type SurfaceCache = { faces: Map<number, RestFace>; vertices: Map<number, [target: number, delta: VertexDelta][]> };
const bindCaches = new WeakMap<SplatMorphSurface, SurfaceCache>();

function vertexInfluences(surface: SplatMorphSurface, cache: SurfaceCache, index: number) {
  let influences = cache.vertices.get(index);
  if (influences) return influences;
  influences = [];
  for (const [target, deltas] of surface.deltas.entries()) {
    let lo = 0, hi = deltas.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (deltas[mid][0] < index) lo = mid + 1; else hi = mid;
    }
    if (deltas[lo]?.[0] === index) influences.push([target, deltas[lo]]);
  }
  cache.vertices.set(index, influences);
  return influences;
}

function triangleRest(surface: SplatMorphSurface, cache: SurfaceCache, index: number) {
  let rest = cache.faces.get(index);
  if (rest) return rest;
  const [, a, b, c] = surface.faces[index];
  const origin = new Vector3(...surface.vertices[a]);
  const u = new Vector3(...surface.vertices[b]).sub(origin), v = new Vector3(...surface.vertices[c]).sub(origin);
  const normal = u.clone().cross(v).normalize();
  rest = { origin, u, v, normal, inverse: new Matrix4().makeBasis(u,v,normal).setPosition(origin).invert() };
  cache.faces.set(index, rest);
  return rest;
}

export function prepareSplatMorphPose(pose: SplatMorphPose) {
  const { surface, weights } = pose;
  if (weights.length !== surface.deltas.length || !weights.every(w => Number.isFinite(w) && Math.abs(w) <= SPLAT_MORPH_WEIGHT_LIMIT)) throw Error("Invalid splat blend-shape weights.");
  if (!weights.some((w,i) => w !== 0 && surface.deltas[i].length)) return;
  const cache = bindCaches.get(surface) ?? { faces: new Map(), vertices: new Map() } as SurfaceCache;
  bindCaches.set(surface, cache);
  const points = new Map<number, Vector3 | null>(), frames = new Map<number, Matrix4 | undefined>();
  function displaced(i: number) {
    if (points.has(i)) return points.get(i);
    let point: Vector3 | null = null;
    for (const [target, [,x,y,z]] of vertexInfluences(surface, cache, i)) {
      const weight = weights[target];
      if (!weight) continue;
      point ??= new Vector3(...surface.vertices[i]);
      point.x += weight*x; point.y += weight*y; point.z += weight*z;
    }
    points.set(i, point);
    return point;
  }
  function faceFrame(index: number) {
    const [,a,b,c] = surface.faces[index];
    const pa = displaced(a), pb = displaced(b), pc = displaced(c);
    if (!pa && !pb && !pc) return;
    const { origin, u, v, normal, inverse } = triangleRest(surface, cache, index);
    const p = pa ?? origin;
    const du = (pb?.clone() ?? new Vector3(...surface.vertices[b])).sub(p);
    const dv = (pc?.clone() ?? new Vector3(...surface.vertices[c])).sub(p);
    // Exact eyelid closures can collapse a triangle. Bound its two in-plane dimensions
    // to a tiny fraction of the bind dimensions so picking and covariance stay invertible.
    const minU = u.length()*1e-5;
    if (du.length() < minU) du.copy(u).normalize().multiplyScalar(minU);
    const axis = du.clone().normalize(), along = dv.dot(axis);
    const altitude = dv.clone().addScaledVector(axis,-along);
    const minHeight = u.clone().normalize().cross(v).length()*1e-5;
    if (altitude.length() < minHeight) {
      if (altitude.lengthSq() === 0) {
        altitude.crossVectors(normal,axis);
        if (altitude.lengthSq() < 1e-14) altitude.copy(u).normalize().cross(axis);
      }
      dv.copy(axis).multiplyScalar(along).addScaledVector(altitude.normalize(),minHeight);
    }
    return new Matrix4().makeBasis(du,dv,du.clone().cross(dv).normalize()).setPosition(p).multiply(inverse);
  }

  // Lazy evaluation shares each triangle's affine across its contiguous source IDs
  // and lets the interactive compiler cancel even during a large facial morph.
  let last = 0;
  return (index: number) => {
    if (index < (surface.faces[last-1]?.[0] ?? 0) || index >= surface.faces[last][0]) {
      let lo = 0, hi = surface.faces.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (surface.faces[mid][0] <= index) lo = mid + 1; else hi = mid;
      }
      last = lo;
    }
    if (!frames.has(last)) frames.set(last,faceFrame(last));
    return frames.get(last);
  };
}
