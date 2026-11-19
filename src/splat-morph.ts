import { Matrix4, Vector3 } from "three";
import type { MeshShapeNode, Vec3 } from "./scene-document.ts";

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

export function validateSplatMorphs(shape: MorphShape, count?: number) {
  const { morphTargets: targets, morphSurface: s } = shape;
  if (targets === undefined && s === undefined) return;
  const fail = () => { throw Error("Invalid splat blend-shape surface or original source count."); };
  if (!s || !Array.isArray(targets) || !targets.length || targets.length > 128 ||
      targets.some(t => !t || typeof t.name !== "string" || !t.name.trim() || !bounded(t.weight))) return fail();
  if (!Number.isInteger(s.sourceCount) || s.sourceCount < 1 || s.sourceCount > 100000 || (count !== undefined && count !== s.sourceCount) ||
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

export function prepareSplatMorphPose(pose: SplatMorphPose) {
  const { surface, weights } = pose;
  if (weights.length !== surface.deltas.length || !weights.every(bounded)) throw Error("Invalid splat blend-shape weights.");
  const moved = new Map<number, Vector3>();
  weights.forEach((weight, target) => {
    if (!weight) return;
    for (const [i,x,y,z] of surface.deltas[target]) {
      let v = moved.get(i);
      if (!v) { v = new Vector3(...surface.vertices[i]); moved.set(i,v); }
      v.x += weight*x; v.y += weight*y; v.z += weight*z;
    }
  });
  if (!moved.size) return;
  const frames = surface.faces.map(([,a,b,c]) => {
    if (!moved.has(a) && !moved.has(b) && !moved.has(c)) return;
    const [p,q,r] = [a,b,c].map(i => new Vector3(...surface.vertices[i]));
    const u = q.clone().sub(p), v = r.clone().sub(p), n = u.clone().cross(v).normalize();
    const inv = new Matrix4().makeBasis(u,v,n).setPosition(p).invert();
    const origin = moved.get(a) ?? p;
    const du = (moved.get(b) ?? q).clone().sub(origin), dv = (moved.get(c) ?? r).clone().sub(origin);
    // Exact eyelid closures can collapse a triangle. Bound its two in-plane dimensions
    // to a tiny fraction of the bind dimensions so picking and covariance stay invertible.
    const minU = u.length()*1e-5;
    if (du.length() < minU) du.copy(u).normalize().multiplyScalar(minU);
    const axis = du.clone().normalize(), along = dv.dot(axis);
    const altitude = dv.clone().addScaledVector(axis,-along);
    const minHeight = u.clone().normalize().cross(v).length()*1e-5;
    if (altitude.length() < minHeight) {
      if (altitude.lengthSq() === 0) {
        altitude.crossVectors(n,axis);
        if (altitude.lengthSq() < 1e-14) altitude.copy(u).normalize().cross(axis);
      }
      dv.copy(axis).multiplyScalar(along).addScaledVector(altitude.normalize(),minHeight);
    }
    return new Matrix4().makeBasis(du,dv,du.clone().cross(dv).normalize()).setPosition(origin).multiply(inv);
  });
  let last = 0;
  return (index: number) => {
    if (index < (surface.faces[last-1]?.[0] ?? 0) || index >= surface.faces[last][0]) {
      let lo = 0, hi = frames.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (surface.faces[mid][0] <= index) lo = mid + 1; else hi = mid;
      }
      last = lo;
    }
    return frames[last];
  };
}
