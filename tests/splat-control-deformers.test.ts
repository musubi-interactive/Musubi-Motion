import { describe, expect, it } from "vitest";
import { Box3, BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Matrix3, Matrix4, PerspectiveCamera, PlaneGeometry, Vector3 } from "three";
import { createBoxSplatCage, createSplatCageFromGeometry, polygonCageSplatDeformer, prepareSplatCage, validateSplatCage } from "../src/splat-cage.ts";
import type { ControlPoint } from "../src/splat-control-points.ts";
import { createSplatControlOverlay, splatCageControlLayout } from "../src/splat-control-overlay.ts";
import { createSplatLattice, latticeRestPoint, latticeSplatDeformer, prepareSplatLattice, resizeSplatLattice, validateSplatLattice } from "../src/splat-lattice.ts";

const unitBox = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
const transform = new Matrix4().makeShear(.07, -.2, .2, .1, .08, .15).scale(new Vector3(.75, 1.3, 1.15)).setPosition(.15, -.18, .09);
const fieldMatrix = new Matrix3().setFromMatrix4(transform);
type Sample = ReturnType<typeof prepareSplatLattice>;
function sample(kernel: Sample, position: Vector3, influence = 1) {
  const output = new Vector3(), jacobian = new Matrix3();
  kernel(position, output, jacobian, influence);
  return { output, jacobian };
}
function close(actual: number[], expected: number[], places = 8) {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], places));
}
function delta(point: ControlPoint) {
  const original = new Vector3(...point);
  return original.clone().applyMatrix4(transform).sub(original).toArray();
}
function checkAffine(kernel: Sample) {
  for (const position of [new Vector3(), new Vector3(-.9, .3, .65), new Vector3(1, 1, 1), new Vector3(-1, -.1, 1)]) {
    const covariance = new Matrix3().set(.03, -.01, .005, -.01, .02, -.002, .005, -.002, .01);
    for (const influence of [0, .37, 1]) {
      const { output, jacobian } = sample(kernel, position, influence);
      const blended = new Matrix3();
      blended.elements = blended.elements.map((identity, index) => identity * (1 - influence) + fieldMatrix.elements[index] * influence) as typeof blended.elements;
      close(output.toArray(), position.clone().lerp(position.clone().applyMatrix4(transform), influence).toArray());
      close(jacobian.elements, blended.elements);
      close(jacobian.clone().multiply(covariance).multiply(jacobian.clone().transpose()).elements,
        blended.clone().multiply(covariance).multiply(blended.clone().transpose()).elements);
    }
  }
  for (const outside of [new Vector3(1.1, 0, 0), new Vector3(-1.1, -.9, -.7)]) {
    const result = sample(kernel, outside);
    expect(result.output.equals(outside)).toBe(true);
    expect(result.jacobian.equals(new Matrix3())).toBe(true);
  }
}
function checkDerivative(kernel: Sample, position: Vector3) {
  const epsilon = 1e-5, actual = sample(kernel, position).jacobian.elements;
  for (let axis = 0; axis < 3; axis++) {
    const vector = new Vector3().setComponent(axis, epsilon);
    const pos = sample(kernel, position.clone().add(vector)).output, neg = sample(kernel, position.clone().sub(vector)).output;
    close(actual.slice(axis * 3, axis * 3 + 3), pos.sub(neg).divideScalar(epsilon * 2).toArray(), 6);
  }
}

describe("bound lattice points", () => {
  it("is exactly identity at bind and affine-precise in unequal divisions, including corners", () => {
    const lattice = resizeSplatLattice([0, 0, 0], [2, 2, 2], [3, 6, 4]);
    const point = new Vector3(.17, -.23, .41);
    const bind = sample(prepareSplatLattice(lattice), point);
    expect(bind.output.equals(point)).toBe(true);
    expect(bind.jacobian.equals(new Matrix3())).toBe(true);
    lattice.offsets = lattice.offsets.map((_, index) => delta(latticeRestPoint(lattice, index)));
    checkAffine(prepareSplatLattice(lattice));
  });

  it("transports covariance with the analytic local derivative of sparse point movement", () => {
    const lattice = createSplatLattice(unitBox);
    lattice.offsets[7] = [.25, -.4, .12];
    const kernel = prepareSplatLattice(lattice);
    checkDerivative(kernel, new Vector3(.2, -.2, -.4));
    expect(sample(kernel, new Vector3(.1, -.19, -.4)).output.toArray()).not.toEqual([.1, -.19, -.4]);
  });

  it("changes one point immutably, gives each axis a stable key and rebinds atomically", () => {
    const lattice = createSplatLattice(unitBox), controls = latticeSplatDeformer.controls(lattice, 6);
    expect(controls.map(channel => channel.id)).toEqual(["point.6.x", "point.6.y", "point.6.z"]);
    const edited = controls[1].set(lattice, controls[1].value + .375);
    expect(lattice.offsets[6]).toEqual([0, 0, 0]);
    expect(edited.offsets[6]).toEqual([0, .375, 0]);
    expect(edited.offsets[5]).toBe(lattice.offsets[5]);
    expect(() => validateSplatLattice({ ...edited, divisions: [6, 6, 6] })).toThrow(/rebind/i);
    expect(() => resizeSplatLattice([0, 0, 0], [1, 0, 1], [2, 4, 3])).toThrow(/dimensions/);
    expect(() => resizeSplatLattice([0, 0, 0], [1, 1, 1], [2, 4.6, 3])).toThrow(/whole/);
    expect(() => validateSplatLattice({ ...lattice, offsets: Array(20) })).toThrow();
    const rebound = resizeSplatLattice(edited.center, [2, 2.4, 2], [2, 4, 3]);
    expect(rebound.offsets).toEqual(Array.from({ length: 24 }, () => [0, 0, 0]));
    expect(edited.offsets[6]).toEqual([0, .375, 0]);
  });
});

describe("closed polygon cage binding", () => {
  it("welds separate triangle corners without editing source geometry and accepts reflected mesh space", () => {
    const geometry = new BoxGeometry(2, 2, 2).toNonIndexed(), original = Array.from(geometry.getAttribute("position").array);
    const world = new Matrix4().makeScale(-1, .75, 2).setPosition(2, 1, -1);
    const cage = createSplatCageFromGeometry(geometry, world);
    expect(cage.rest).toHaveLength(8);
    expect(cage.triangles).toHaveLength(12);
    expect(Array.from(geometry.getAttribute("position").array)).toEqual(original);
    const layout = splatCageControlLayout("cage", cage)!;
    expect(layout.edges).toHaveLength(18);
    const bind = sample(prepareSplatCage(cage), new Vector3(2.3, 1.1, -1.4));
    expect(bind.output.toArray()).toEqual([2.3, 1.1, -1.4]);
    expect(bind.jacobian.elements).toEqual(new Matrix3().elements);
    geometry.dispose();
  });

  it("keeps shared tetrahedron boundaries continuous, with affine precision and analytic derivatives", () => {
    const cage = createSplatCageFromGeometry(new BoxGeometry(2, 2, 2));
    cage.offsets = cage.rest.map(delta);
    checkAffine(prepareSplatCage(cage));
    cage.offsets = cage.rest.map((_, index) => index === 0 ? [.25, -.4, .12] : [0, 0, 0]);
    const kernel = prepareSplatCage(cage);
    checkDerivative(kernel, new Vector3(.2, .35, -.64));
    const seam = new Vector3(.5, .5, .5), a = seam.clone().setX(.500001), b = seam.clone().setX(.499999);
    expect(sample(kernel, a).output.distanceTo(sample(kernel, b).output)).toBeLessThan(.00001);
    const changedVertex = new Vector3(...cage.rest[0]);
    const edited = polygonCageSplatDeformer.handle.get(cage, 0).position;
    close(sample(kernel, changedVertex).output.toArray(), edited.toArray());
  });

  it("accepts an inward dent visible from the centroid and rejects open, degenerate or miswound topology", () => {
    const cage = createBoxSplatCage(unitBox);
    cage.rest[6] = [.45, .45, .45];
    expect(() => validateSplatCage(cage)).not.toThrow();
    expect(() => createSplatCageFromGeometry(new PlaneGeometry())).toThrow(/closed/);
    expect(() => validateSplatCage({ ...cage, triangles: cage.triangles.slice(1) })).toThrow(/rebind/);
    expect(() => validateSplatCage({ ...cage, triangles: cage.triangles.map((triangle, index) => index ? triangle : triangle.toReversed()) })).toThrow(/wound/);
    const zeroVolume = structuredClone(cage);
    zeroVolume.rest.forEach((point, index) => { point[2] = index * 1e-15; });
    expect(() => validateSplatCage(zeroVolume)).toThrow(/centroid/);
    const bad = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(new Float32Array(12 * 3), 3));
    expect(() => createSplatCageFromGeometry(bad)).toThrow();
    expect(() => createSplatCageFromGeometry(new BoxGeometry(2, 2, 2, 12, 12, 12))).toThrow(/coarse/);
  });
});

describe("control point viewport overlay", () => {
  it("selects the nearest projected point, resolves overlaps by depth and clears on exit", () => {
    const scene = new Group(), overlay = createSplatControlOverlay(scene);
    const camera = new PerspectiveCamera(55, 1, .1, 50);
    camera.position.set(0, 0, 6);
    camera.lookAt(0, 0, 0);
    const rect = { left: 20, top: 10, width: 400, height: 400 };
    const layout = { points: [new Vector3(2, 0, -1), new Vector3(2, 0, 1), new Vector3(2, 0, 8)] };
    overlay.update(layout, new Matrix4().makeTranslation(-2, 0, 0), 0);
    expect(overlay.pick(camera, rect, 220, 210)).toBe(1);
    expect(overlay.pick(camera, rect, 190, 210)).toBeUndefined();
    overlay.clear();
    expect(overlay.pick(camera, rect, 220, 210)).toBeUndefined();
    overlay.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
