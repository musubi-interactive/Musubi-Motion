import { Box3, Matrix3, Vector3 } from "three";
import type { SplatDeformerDefinition } from "./splat-deformers.ts";
import { controlPointAdapter, controlPointChannels, validControlPoints, validPoint, type ControlPoint } from "./splat-control-points.ts";

export type SplatLattice = {
  center: ControlPoint;
  size: ControlPoint;
  divisions: ControlPoint;
  offsets: ControlPoint[];
};

export const MAX_LATTICE_DIVISIONS = 6;
const DEFAULT_DIVISIONS: ControlPoint = [2, 5, 2];

export function createSplatLattice(bounds: Box3): SplatLattice {
  const center = bounds.getCenter(new Vector3()).toArray();
  const size = bounds.getSize(new Vector3());
  const floor = Math.max(0.001, Math.max(size.x, size.y, size.z) * 0.01);
  const padded: ControlPoint = [Math.max(floor, size.x * 1.02), Math.max(floor, size.y * 1.02), Math.max(floor, size.z * 1.02)];
  return resizeSplatLattice(center, padded, DEFAULT_DIVISIONS);
}

export function resizeSplatLattice(center: ControlPoint, size: ControlPoint, divisions: ControlPoint): SplatLattice {
  validateLatticeRest(center, size, divisions);
  return {
    center: [...center], size: [...size], divisions: [...divisions],
    offsets: Array.from({ length: divisions[0] * divisions[1] * divisions[2] }, (): ControlPoint => [0, 0, 0]),
  };
}

function validateLatticeRest(center: unknown, size: unknown, divisions: unknown): asserts divisions is ControlPoint {
  if (!validPoint(center) || !validPoint(size) || size.some((axis, i) => axis < 1e-6 || axis * 0.5 <= Math.abs(center[i]) * 1e-12)) {
    throw new Error("Enter a finite lattice center and dimensions of at least 0.000001 in each axis.");
  }
  if (!validPoint(divisions) || divisions.some(n => !Number.isInteger(n) || n < 2 || n > MAX_LATTICE_DIVISIONS)) {
    throw new Error(`Lattice divisions must be whole numbers from 2 to ${MAX_LATTICE_DIVISIONS}.`);
  }
}

export function validateSplatLattice(input: unknown): asserts input is SplatLattice {
  if (!input || typeof input !== "object") throw new Error("Invalid lattice settings.");
  const { center, size, divisions, offsets } = input as Partial<SplatLattice>;
  validateLatticeRest(center, size, divisions);
  if (!validControlPoints(offsets, divisions[0] * divisions[1] * divisions[2])) {
    throw new Error("Lattice point count must match its bound divisions. Rebind to change the resolution.");
  }
}

export function latticeRestPoint(lattice: SplatLattice, index: number): ControlPoint {
  const [nx, ny, nz] = lattice.divisions;
  return [
    lattice.center[0] + lattice.size[0] * (index % nx / (nx - 1) - 0.5),
    lattice.center[1] + lattice.size[1] * (Math.floor(index / nx) % ny / (ny - 1) - 0.5),
    lattice.center[2] + lattice.size[2] * (Math.floor(index / (nx * ny)) / (nz - 1) - 0.5),
  ];
}

export function latticeEdges({ divisions: [nx, ny, nz] }: SplatLattice): [number, number][] {
  const edges: [number, number][] = [];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const point = x + nx * (y + ny * z);
        if (x + 1 < nx) edges.push([point, point + 1]);
        if (y + 1 < ny) edges.push([point, point + nx]);
        if (z + 1 < nz) edges.push([point, point + nx * ny]);
      }
    }
  }
  return edges;
}

function bernstein(values: Float64Array, degree: number, t: number) {
  values[0] = 1;
  for (let order = 1; order <= degree; order++) {
    values[order] = t * values[order - 1];
    for (let i = order - 1; i >= 1; i--) values[i] = (1 - t) * values[i] + t * values[i - 1];
    values[0] *= 1 - t;
  }
}

/** Tensor-product Bernstein FFD, evaluated in splat-local bind coordinates. */
export function prepareSplatLattice(lattice: SplatLattice) {
  const [nx, ny, nz] = lattice.divisions;
  const [sx, sy, sz] = lattice.size;
  const [cx, cy, cz] = lattice.center;
  const movedRows: { y: number; z: number; points: { x: number; offset: ControlPoint }[] }[] = [];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const points = [];
      for (let x = 0; x < nx; x++) {
        const offset = lattice.offsets[x + nx * (y + ny * z)];
        if (offset.some(value => value !== 0)) points.push({ x, offset });
      }
      if (points.length) movedRows.push({ y, z, points });
    }
  }
  const wx = new Float64Array(nx), wy = new Float64Array(ny), wz = new Float64Array(nz);
  const dx = new Float64Array(nx), dy = new Float64Array(ny), dz = new Float64Array(nz);
  function basis(weights: Float64Array, derivatives: Float64Array, t: number, size: number) {
    const degree = weights.length - 1;
    // The lower-degree basis supplies the analytic derivative, including at 0 and 1.
    bernstein(derivatives, degree - 1, t);
    for (let i = degree; i > 0; i--) derivatives[i] = degree * (derivatives[i - 1] - (i < degree ? derivatives[i] : 0)) / size;
    derivatives[0] *= -degree / size;
    bernstein(weights, degree, t);
  }
  return (input: Vector3, output: Vector3, jacobian: Matrix3, influence: number) => {
    output.copy(input);
    jacobian.identity();
    if (!influence || !movedRows.length) return;
    const x = (input.x - cx) / sx + 0.5;
    const y = (input.y - cy) / sy + 0.5;
    const z = (input.z - cz) / sz + 0.5;
    const epsilon = 1e-10;
    if (x < -epsilon || x > 1 + epsilon || y < -epsilon || y > 1 + epsilon || z < -epsilon || z > 1 + epsilon) return;
    basis(wx, dx, Math.min(1, Math.max(0, x)), sx);
    basis(wy, dy, Math.min(1, Math.max(0, y)), sy);
    basis(wz, dz, Math.min(1, Math.max(0, z)), sz);
    let px = 0, py = 0, pz = 0;
    let xx = 0, xy = 0, xz = 0, yx = 0, yy = 0, yz = 0, zx = 0, zy = 0, zz = 0;
    for (const row of movedRows) {
      let rx = 0, ry = 0, rz = 0, rdx = 0, rdy = 0, rdz = 0;
      // Contract the X basis once for each nonzero row. Y/Z weights and
      // derivatives are shared by every control point in that row.
      for (const point of row.points) {
        const w = wx[point.x], dw = dx[point.x];
        const [ox, oy, oz] = point.offset;
        rx += w * ox; ry += w * oy; rz += w * oz;
        rdx += dw * ox; rdy += dw * oy; rdz += dw * oz;
      }
      const w = wy[row.y] * wz[row.z], dwy = dy[row.y] * wz[row.z], dwz = wy[row.y] * dz[row.z];
      px += w * rx; py += w * ry; pz += w * rz;
      xx += w * rdx; xy += dwy * rx; xz += dwz * rx;
      yx += w * rdy; yy += dwy * ry; yz += dwz * ry;
      zx += w * rdz; zy += dwy * rz; zz += dwz * rz;
    }
    output.x += influence * px; output.y += influence * py; output.z += influence * pz;
    jacobian.set(1 + influence * xx, influence * xy, influence * xz,
      influence * yx, 1 + influence * yy, influence * yz,
      influence * zx, influence * zy, 1 + influence * zz);
  };
}

const latticeHandle = controlPointAdapter(latticeRestPoint, "Lattice point");

export const latticeSplatDeformer = {
  kind: "lattice",
  name: "Lattice",
  create: createSplatLattice,
  validate: validateSplatLattice,
  prepare: prepareSplatLattice,
  controls: (params: SplatLattice, point?: number) => controlPointChannels(params, latticeRestPoint, "Lattice point", point),
  handle: latticeHandle,
} satisfies SplatDeformerDefinition<SplatLattice>;
