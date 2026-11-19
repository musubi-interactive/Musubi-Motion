import { Box3, BufferGeometry, Matrix3, Matrix4, Vector3 } from "three";
import type { SplatDeformerDefinition } from "./splat-deformers.ts";
import { controlPointAdapter, controlPointChannels, validControlPoints, validPoint, type ControlPoint } from "./splat-control-points.ts";

export type CageTriangle = [number, number, number];
export type SplatCage = { rest: ControlPoint[]; triangles: CageTriangle[]; offsets: ControlPoint[] };
export const MAX_CAGE_VERTICES = 64;
export const MAX_CAGE_TRIANGLES = MAX_CAGE_VERTICES * 2 - 4;

type CageCell = { triangle: CageTriangle; inverse: Matrix3 };
const topologyError = "Use a single closed, consistently wound triangle mesh. Edit the source mesh and rebind to change cage topology.";
const geometryError = "The cage must enclose its vertex centroid, with every face visible from that point. Use a convex or simple star-shaped mesh without thin or degenerate faces.";

function prepareFan(rest: ControlPoint[], triangles: CageTriangle[]) {
  const origin = new Vector3(...rest[0]);
  const relative = rest.map(point => new Vector3(...point).sub(origin));
  const centroid = relative.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(rest.length);
  relative.forEach(point => point.sub(centroid));
  const radius = Math.max(...relative.map(point => point.length()));
  if (!(radius > 1e-9)) throw new Error(geometryError);
  const inverseRadius = 1 / radius;
  relative.forEach(point => point.multiplyScalar(inverseRadius));
  const cells: CageCell[] = [];
  let orientation = 0, solidAngle = 0;
  for (const triangle of triangles) {
    const [a, b, c] = triangle.map(index => relative[index]);
    const matrix = new Matrix3().set(a.x, b.x, c.x, a.y, b.y, c.y, a.z, b.z, c.z);
    const determinant = matrix.determinant();
    orientation ||= Math.sign(determinant);
    if (determinant * orientation < 1e-9) throw new Error(geometryError);
    // An oriented, closed fan covers the unit sphere once. With all faces facing outwards
    // this also rejects overlapping tetrahedra and cages wrapping the centroid twice.
    const denominator = a.length() * b.length() * c.length() + a.dot(b) * c.length() + b.dot(c) * a.length() + c.dot(a) * b.length();
    solidAngle += 2 * Math.atan2(determinant, denominator);
    cells.push({ triangle, inverse: matrix.invert() });
  }
  if (Math.abs(Math.abs(solidAngle) - 4 * Math.PI) > 1e-7) throw new Error(geometryError);
  return { center: centroid.add(origin), inverseRadius, cells };
}

export function validateSplatCage(value: unknown): asserts value is SplatCage {
  if (!value || typeof value !== "object") throw new Error(topologyError);
  const { rest, triangles, offsets } = value as Partial<SplatCage>;
  if (!Array.isArray(rest) || rest.length < 4 || rest.length > MAX_CAGE_VERTICES || !Array.from(rest).every(validPoint)) {
    throw new Error(`Cage requires 4 to ${MAX_CAGE_VERTICES} finite, distinct vertices.`);
  }
  if (new Set(rest.map(point => point.join(","))).size !== rest.length || !validControlPoints(offsets, rest.length)) throw new Error(topologyError);
  if (!Array.isArray(triangles) || triangles.length !== rest.length * 2 - 4) throw new Error(topologyError);
  const edges = new Map<string, { start: number; end: number; closed: boolean }>();
  const links = rest.map(() => new Map<number, number[]>());
  for (const triangle of triangles) {
    if (!Array.isArray(triangle) || triangle.length !== 3 || !Array.from(triangle).every(index => Number.isInteger(index) && index >= 0 && index < rest.length)
      || new Set(triangle).size !== 3) throw new Error(topologyError);
    for (let corner = 0; corner < 3; corner++) {
      const a = triangle[corner], b = triangle[(corner + 1) % 3], c = triangle[(corner + 2) % 3];
      const key = `${Math.min(a, b)}/${Math.max(a, b)}`, edge = edges.get(key);
      if (!edge) edges.set(key, { start: a, end: b, closed: false });
      else {
        if (edge.closed || edge.start !== b || edge.end !== a) throw new Error(topologyError);
        edge.closed = true;
      }
      const ring = links[a];
      const from = ring.get(b) ?? [], to = ring.get(c) ?? [];
      from.push(c); to.push(b);
      ring.set(b, from); ring.set(c, to);
    }
  }
  if (Array.from(edges.values()).some(edge => !edge.closed)) throw new Error(topologyError);
  // Vertices of a closed 2-manifold have one cyclic link. This rejects touching shells.
  for (const ring of links) {
    const first = ring.keys().next().value;
    if (first === undefined || Array.from(ring.values()).some(link => link.length !== 2)) throw new Error(topologyError);
    const visited = new Set<number>();
    let previous = -1, current: number = first;
    while (!visited.has(current)) {
      visited.add(current);
      const neighbors = ring.get(current)!;
      const next = neighbors[0] === previous ? neighbors[1] : neighbors[0];
      previous = current; current = next;
    }
    if (current !== first || visited.size !== ring.size) throw new Error(topologyError);
  }
  const connected = new Set<number>([0]), queue = [0];
  for (const vertex of queue) {
    for (const neighbor of links[vertex].keys()) {
      if (!connected.has(neighbor)) { connected.add(neighbor); queue.push(neighbor); }
    }
  }
  if (connected.size !== rest.length) throw new Error(topologyError);
  prepareFan(rest, triangles);
}

/** Snapshot the polygon mesh in splat-local space. Weld exact coincident corners, so
 * faceted meshes with separate normals or UVs still form one cage vertex per position. */
export function createSplatCageFromGeometry(geometry: BufferGeometry, objectToSplat = new Matrix4()): SplatCage {
  const position = geometry.getAttribute("position"), index = geometry.getIndex();
  const count = index?.count ?? position?.count ?? 0;
  if (!position || position.itemSize < 3 || count < 12 || count % 3) throw new Error(topologyError);
  if (count > MAX_CAGE_TRIANGLES * 3) throw new Error(`Use a coarse mesh with at most ${MAX_CAGE_TRIANGLES} triangles for the polygon cage.`);
  const rest: ControlPoint[] = [], triangles: CageTriangle[] = [];
  const points = new Map<string, number>();
  const local = new Vector3();
  for (let start = 0; start < count; start += 3) {
    const triangle: CageTriangle = [0, 0, 0];
    for (let corner = 0; corner < 3; corner++) {
      const sourceIndex = index?.getX(start + corner) ?? start + corner;
      if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= position.count) throw new Error(topologyError);
      const point = local.fromBufferAttribute(position, sourceIndex).applyMatrix4(objectToSplat).toArray();
      if (!validPoint(point)) throw new Error("Cage mesh positions must be finite in the splat's local space.");
      const key = point.join(",");
      if (!points.has(key)) { points.set(key, rest.length); rest.push(point); }
      triangle[corner] = points.get(key)!;
    }
    triangles.push(triangle);
  }
  const cage = { rest, triangles, offsets: rest.map((): ControlPoint => [0, 0, 0]) };
  validateSplatCage(cage);
  return cage;
}

export function createBoxSplatCage(bounds: Box3): SplatCage {
  const center = bounds.getCenter(new Vector3()), size = bounds.getSize(new Vector3()).multiplyScalar(0.51);
  const floor = Math.max(0.001, Math.max(size.x, size.y, size.z) * 0.01);
  size.max(new Vector3(floor, floor, floor));
  const corners: ControlPoint[] = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const rest = corners.map(point => new Vector3(...point).multiply(size).add(center).toArray());
  const triangles: CageTriangle[] = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [3, 6, 2], [3, 7, 6], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
  return { rest, triangles, offsets: rest.map((): ControlPoint => [0, 0, 0]) };
}

export function cageRestPoint(cage: SplatCage, index: number): ControlPoint { return cage.rest[index]; }

export function cageEdges({ triangles }: SplatCage): [number, number][] {
  const edges = new Map<string, [number, number]>();
  for (const [a, b, c] of triangles) {
    for (const [first, second] of [[a, b], [b, c], [c, a]]) {
      const low = Math.min(first, second), high = Math.max(first, second);
      edges.set(`${low}/${high}`, [low, high]);
    }
  }
  return Array.from(edges.values());
}

/** Tetrahedral barycentric coordinates in a fan from the rest centroid. Cells share their
 * three face weights, and the centroid uses equal vertex weights, so the field is continuous
 * across cell seams and exactly reproduces affine motion. The cell Jacobian is analytic. */
export function prepareSplatCage(cage: SplatCage) {
  const { rest, triangles, offsets } = cage;
  if (!offsets.some(offset => offset.some(value => value !== 0))) {
    return (input: Vector3, output: Vector3, jacobian: Matrix3, _influence: number) => { output.copy(input); jacobian.identity(); };
  }
  const { center, inverseRadius, cells } = prepareFan(rest, triangles);
  const centroidOffset = offsets.reduce((sum, offset) => sum.add(new Vector3(...offset)), new Vector3()).divideScalar(rest.length);
  const deltas = offsets.map(offset => new Vector3(...offset).sub(centroidOffset));
  const affineCells = cells.map(({ triangle, inverse }) => {
    const [a, b, c] = triangle.map(index => deltas[index]);
    const normalizedGradient = new Matrix3().set(a.x, b.x, c.x, a.y, b.y, c.y, a.z, b.z, c.z).multiply(inverse);
    return { inverse: inverse.elements, normalizedGradient, gradient: normalizedGradient.clone().multiplyScalar(inverseRadius).elements };
  });
  const relative = new Vector3(), displacement = new Vector3();
  return (input: Vector3, output: Vector3, jacobian: Matrix3, influence: number) => {
    output.copy(input);
    jacobian.identity();
    if (!influence) return;
    relative.copy(input).sub(center).multiplyScalar(inverseRadius);
    if (relative.lengthSq() > 1 + 1e-9) return;
    const { x, y, z } = relative;
    const epsilon = 1e-9;
    for (const { inverse: b, normalizedGradient, gradient: g } of affineCells) {
      const u = b[0] * x + b[3] * y + b[6] * z;
      if (u < -epsilon) continue;
      const v = b[1] * x + b[4] * y + b[7] * z;
      if (v < -epsilon) continue;
      const w = b[2] * x + b[5] * y + b[8] * z;
      if (w < -epsilon || u + v + w > 1 + epsilon) continue;
      displacement.copy(relative).applyMatrix3(normalizedGradient).add(centroidOffset);
      output.addScaledVector(displacement, influence);
      jacobian.set(1 + influence * g[0], influence * g[3], influence * g[6], influence * g[1], 1 + influence * g[4], influence * g[7],
        influence * g[2], influence * g[5], 1 + influence * g[8]);
      return;
    }
  };
}

export const polygonCageSplatDeformer = {
  kind: "cage",
  name: "Polygon Cage",
  create: createBoxSplatCage,
  validate: validateSplatCage,
  prepare: prepareSplatCage,
  controls: (params: SplatCage, point?: number) => controlPointChannels(params, cageRestPoint, "Cage vertex", point),
  handle: controlPointAdapter(cageRestPoint, "Cage vertex"),
} satisfies SplatDeformerDefinition<SplatCage>;
