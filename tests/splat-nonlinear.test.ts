import { describe, expect, it } from "vitest";
import { Box3, Euler, Matrix3, Matrix4, Quaternion, Vector3 } from "three";
import { SPLAT_BEND } from "../src/splat-bend.ts";
import { SPLAT_SQUASH } from "../src/splat-squash.ts";
import { SPLAT_TWIST } from "../src/splat-twist.ts";
import { NONLINEAR_SPLAT_DEFORMERS } from "../src/splat-nonlinear.ts";

const fixture = new Box3(new Vector3(-0.5, -1, -0.5), new Vector3(0.5, 1, 0.5));
const EPS = 1e-6;
type MapPoint = (input: Vector3, output: Vector3, jacobian: Matrix3, influence: number) => void;

function sample(map: MapPoint, point: Vector3, influence = 1) {
  const result = new Vector3();
  const jacobian = new Matrix3();
  map(point, result, jacobian, influence);
  return { result, jacobian };
}

function expectClose(actual: readonly number[], expected: readonly number[], digits = 7) {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], digits));
}

function numericalDifferential(map: MapPoint, point: Vector3, influence: number) {
  return [0, 1, 2].flatMap(index => {
    const offset = new Vector3().setComponent(index, EPS);
    const plus = sample(map, point.clone().add(offset), influence).result;
    const minus = sample(map, point.clone().sub(offset), influence).result;
    return plus.sub(minus).multiplyScalar(0.5 / EPS).toArray();
  });
}

const bend = { ...SPLAT_BEND.create(fixture), curvature: 90 };
const twist = { ...SPLAT_TWIST.create(fixture), startAngle: -30, endAngle: 90 };
const squash = { ...SPLAT_SQUASH.create(fixture), factor: -1, expand: 2 };

describe("framed nonlinear splat deformation", () => {
  it("bends the local Y axis toward positive X, with a tangent extension beyond the limits", () => {
    const r = 2 / Math.PI;
    const map = SPLAT_BEND.prepare(bend);
    expectClose(sample(map, new Vector3(0, 1, 0.125)).result.toArray(), [r, r, 0.125]);
    expectClose(sample(map, new Vector3(0, 2, 0.125)).result.toArray(), [r + 1, r, 0.125]);
    expectClose(sample(map, new Vector3(0, -2, 0.125)).result.toArray(), [r + 1, -r, 0.125]);
    const negative = SPLAT_BEND.prepare({ ...bend, curvature: -90 });
    expectClose(sample(negative, new Vector3(0, 1, 0.125)).result.toArray(), [-r, r, 0.125]);
  });

  it("has the classical bend Jacobian away from the axis, including covariance transport", () => {
    const map = SPLAT_BEND.prepare(bend);
    const { jacobian } = sample(map, new Vector3(0.25, 0, 0.125));
    const shortened = 1 - Math.PI / 8;
    expectClose(jacobian.elements, new Matrix3().set(1, 0, 0, 0, shortened, 0, 0, 0, 1).elements);
    const gl = new Matrix3().setFromMatrix4(new Matrix4().makeRotationZ(Math.PI / 4)
      .scale(new Vector3(2, 1, 0.5)));
    const sourceCovariance = gl.clone().multiply(gl.clone().transpose());
    const posedCovariance = jacobian.clone().multiply(sourceCovariance).multiply(jacobian.clone().transpose());
    expectClose(posedCovariance.elements, [2.5, 1.5 * shortened, 0, 1.5 * shortened, 2.5 * shortened ** 2, 0, 0, 0, 0.25]);
  });

  it("maintains positive bend volume through the nominal fold and converges continuously to identity", () => {
    const map = SPLAT_BEND.prepare(bend);
    for (const y of [-1.2, -1, -0.6, 0, 0.6, 1, 1.2]) {
      for (const x of [-1, 0.5 / (Math.PI / 2), 2 / Math.PI, 2.5]) {
        const { result, jacobian } = sample(map, new Vector3(x, y, 0.125));
        expect(result.toArray().every(Number.isFinite)).toBe(true);
        expect(jacobian.determinant()).toBeGreaterThan(0);
      }
    }
    const p = new Vector3(0.125, 0.25, 0.5);
    for (const curvature of [-1e-10, Number.MIN_VALUE * 100, 1e-10]) {
      const { result, jacobian } = sample(SPLAT_BEND.prepare({ ...bend, curvature }), p);
      expectClose(result.toArray(), p.toArray(), 11);
      expectClose(jacobian.elements, new Matrix3().elements, 11);
    }
  });

  it("twists around local Y, clamps the angle into the tails, and avoids a half-mask collapse", () => {
    const map = SPLAT_TWIST.prepare(twist);
    expectClose(sample(map, new Vector3(1, -2, 0)).result.toArray(), [Math.sqrt(3) / 2, -2, 0.5]);
    expectClose(sample(map, new Vector3(1, 0, 0)).result.toArray(), [Math.sqrt(3) / 2, 0, -0.5]);
    expectClose(sample(map, new Vector3(1, 2, 0)).result.toArray(), [0, 2, -1]);
    const half = sample(SPLAT_TWIST.prepare({ ...twist, startAngle: 180, endAngle: 180 }), new Vector3(1, 0, 0), 0.5);
    expectClose(half.result.toArray(), [0, 0, -1]);
    expect(half.jacobian.determinant()).toBeCloseTo(1);
  });

  it("squashes through an asymmetric editable bulge and preserves volume when enabled", () => {
    const map = SPLAT_SQUASH.prepare(squash);
    expectClose(sample(map, new Vector3(1, 0, 0)).result.toArray(), [2, 0, 0]);
    expectClose(sample(map, new Vector3(1, 2, 0)).result.toArray(), [1, 1.75, 0]);
    expectClose(sample(map, new Vector3(1, -2, 0)).result.toArray(), [1, -1.75, 0]);
    const noBulge = SPLAT_SQUASH.prepare({ ...squash, expand: 0 });
    expectClose(sample(noBulge, new Vector3(1, 0, 0)).result.toArray(), [1, 0, 0]);
    const offCenter = SPLAT_SQUASH.prepare({ ...squash, maxExpandPosition: .25 });
    expect(sample(offCenter, new Vector3(1, -.5, 0)).result.x).toBeCloseTo(2);
    expect(sample(offCenter, new Vector3(1, 0, 0)).result.x).toBeLessThan(2);
    for (const factor of [-3, 3]) {
      const volume = SPLAT_SQUASH.prepare({ ...squash, maxExpandPosition: .25, factor, preserveVolume: true });
      for (const y of [-2, -1, -0.75, -0.5, 0, 0.75, 1, 2]) {
        expect(sample(volume, new Vector3(0.7, y, -0.3), 0.75).jacobian.determinant()).toBeCloseTo(1, 12);
      }
    }
    const wide = SPLAT_SQUASH.prepare({ ...squash, expand: 4, preserveVolume: true });
    const narrow = SPLAT_SQUASH.prepare({ ...squash, expand: 0, preserveVolume: true });
    expect(sample(wide, new Vector3(1, 0.5, 0)).result.x).toBeGreaterThan(sample(narrow, new Vector3(1, 0.5, 0)).result.x);
  });

  it("matches the actual derivative at fractional influence, in tails, and across a rotated nonuniform frame", () => {
    const position = new Vector3(0.25, -1, 1.5);
    const rotation = new Euler(.25, .5, -.75);
    const scale = new Vector3(.5, 1.3, 2);
    const affine = new Matrix4().compose(position, new Quaternion().setFromEuler(rotation), scale);
    const frame = { position: position.toArray(), rotation: [rotation.x, rotation.y, rotation.z] as [number, number, number], scale: scale.toArray() };
    const maps = [
      SPLAT_BEND.prepare({ ...bend, ...frame }), SPLAT_TWIST.prepare({ ...twist, ...frame }),
      SPLAT_SQUASH.prepare({ ...squash, ...frame, maxExpandPosition: .75 }),
      SPLAT_SQUASH.prepare({ ...squash, ...frame, maxExpandPosition: .75, preserveVolume: true }),
    ];
    for (const map of maps) {
      for (const [x, y] of [[0.1, -1.5], [0.15, 0.3], [0.8, 0.4], [1.5, 0.6], [0.2, 1.1]]) {
        const point = new Vector3(x, y, -0.3).applyMatrix4(affine);
        const original = point.clone();
        const { jacobian } = sample(map, point, .73);
        expectClose(jacobian.elements, numericalDifferential(map, point, .73), 6);
        expect(jacobian.determinant()).toBeGreaterThan(0);
        expect(point).toEqual(original);
      }
    }
  });

  it("short circuits identity and collapsed limits exactly even with a rotated handle", () => {
    const p = new Vector3(1.23, 4.56, -7.89);
    const rotation = [0.1, -0.5, 0.7] as [number, number, number];
    const inactive = { rotation, lowBound: 0, highBound: 1e-8 };
    const maps = [SPLAT_BEND.prepare({ ...bend, ...inactive }), SPLAT_TWIST.prepare({ ...twist, ...inactive }), SPLAT_SQUASH.prepare({ ...squash, ...inactive }),
      SPLAT_BEND.prepare({ ...bend, curvature: 0, rotation }), SPLAT_TWIST.prepare({ ...twist, startAngle: 0, endAngle: 0, rotation }),
      SPLAT_SQUASH.prepare({ ...squash, factor: 0, rotation })];
    for (const map of maps) expect(sample(map, p)).toEqual({ result: p, jacobian: new Matrix3() });
    for (const map of [SPLAT_BEND.prepare(bend), SPLAT_TWIST.prepare(twist), SPLAT_SQUASH.prepare(squash)]) {
      expect(sample(map, p, 0)).toEqual({ result: p, jacobian: new Matrix3() });
    }
  });

  it("uses stable numeric channels, projected bound handles, and strict finite parameter validation", () => {
    const params = { ...bend, position: [4, 1, 0] as [number, number, number], rotation: [0, 0, Math.PI / 2] as [number, number, number] };
    const handle = SPLAT_BEND.handle;
    expect(handle.count()).toBe(3);
    expect(handle.modes(0)).toEqual(["translate", "rotate", "scale"]);
    expect(handle.modes(2)).toEqual(["translate"]);
    expectClose(handle.get(params, 2).position.toArray(), [3, 1, 0]);
    const moved = handle.get(params, 2);
    moved.position.set(2, -1, 1);
    expect(handle.set(params, 2, moved).highBound).toBeCloseTo(2);
    expect(params.highBound).toBe(1);
    const rotate = SPLAT_BEND.controls(params).find(control => control.id === "rotation.z")!;
    expect(rotate.value).toBeCloseTo(90);
    expect(rotate.set(params, 45).rotation[2]).toBeCloseTo(Math.PI / 4);
    const option = SPLAT_SQUASH.controls(squash).find(control => control.id === "preserveVolume")!;
    expect(option.set(squash, 1).preserveVolume).toBe(true);
    expect(option.set(squash, 0).preserveVolume).toBe(false);
    expect(() => SPLAT_BEND.validate({ ...bend, lowBound: 1 })).toThrow(/Low Bound/);
    expect(() => SPLAT_BEND.validate({ ...bend, curvature: Infinity })).toThrow(/Curvature/);
    expect(() => SPLAT_TWIST.validate({ ...twist, scale: [1, 0, 1] })).toThrow(/Handle scale/);
    expect(() => SPLAT_TWIST.validate({ ...twist, startAngle: NaN })).toThrow(/Start Angle/);
    expect(() => SPLAT_SQUASH.validate({ ...squash, maxExpandPosition: 0 })).toThrow(/Max Expand/);
    expect(() => SPLAT_SQUASH.validate({ ...squash, factor: -4 })).toThrow(/Factor/);
    expect(() => SPLAT_SQUASH.validate({ ...squash, preserveVolume: 1 })).toThrow(/Preserve Volume/);
    for (const deformer of NONLINEAR_SPLAT_DEFORMERS) expect(() => deformer.validate(deformer.create(fixture))).not.toThrow();
  });
});
