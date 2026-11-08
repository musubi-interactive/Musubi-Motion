import { describe, expect, it } from "vitest";
import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from "three";
import { addSplat, emptyScene } from "../src/scene-document.ts";
import { captureSplatComponentTransform, componentTransformLookup, gaussianFactor } from "../src/splat-component-transforms.ts";

const positions = [new Vector3(-1, 0, 0), new Vector3(0, 1, 0), new Vector3(1, 0, 0)];
const identity = { shapeId: "shape", assetId: "asset", count: 3 };
const scene = () => addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "Study", [0, 0, 0], "object", "shape").document;
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 7));
function covariance(matrix: Matrix4) { const m = new Matrix3().setFromMatrix4(matrix); return m.clone().multiply(m.clone().transpose()).elements; }
describe("weighted Gaussian deltas through existing component transform capture", () => {
  it("keeps zero exact, one identical to hard path, and half translation correct through skin/world", () => {
    const world = new Matrix4().compose(new Vector3(3, 4, 1), new Quaternion().setFromEuler(new Euler(.2, .3, .5)), new Vector3(2, .7, 1));
    const skin = (index: number) => new Matrix4().makeRotationZ(.2 * index).setPosition(index, 1, 0);
    const options = { document: scene(), identity, selected: [0, 1, 2], world, getRestCenter: (index: number) => positions[index], getSkinMatrix: skin };
    const snapshot = captureSplatComponentTransform({ ...options, weights: [0, .5, 1], weightFrame: { basis: new Quaternion(), mode: "translate" } });
    const delta = new Matrix4().makeTranslation(.6, -.4, .2), result = snapshot.changes(delta), lookup = componentTransformLookup(result);
    expect(lookup(0)).toBeUndefined();
    const hard = componentTransformLookup(captureSplatComponentTransform(options).changes(delta));
    expect(lookup(2)!.elements).toEqual(hard(2)!.elements);
    const original = positions[1].clone().applyMatrix4(skin(1)).applyMatrix4(world);
    const evaluated = positions[1].clone().applyMatrix4(lookup(1)!).applyMatrix4(skin(1)).applyMatrix4(world);
    close(evaluated.toArray(), original.add(new Vector3(.3, -.2, .1)).toArray());
  });
  it("slerps rotation around one shared pivot, including a half turn without matrix collapse", () => {
    const weights = [.25, .5, 1], snapshot = captureSplatComponentTransform({ document: scene(), identity, selected: [0, 1, 2], weights, world: new Matrix4(), getRestCenter: index => positions[index], weightFrame: { basis: new Quaternion(), mode: "rotate" } });
    const pivot = snapshot.pivot, basis = new Matrix4().makeTranslation(...pivot.toArray() as [number, number, number]);
    const result = componentTransformLookup(snapshot.changes(basis.clone().multiply(new Matrix4().makeRotationZ(Math.PI)).multiply(basis.clone().invert())));
    weights.forEach((weight, index) => {
      const expected = positions[index].clone().sub(pivot).applyAxisAngle(new Vector3(0, 0, 1), Math.PI * weight).add(pivot);
      close(positions[index].clone().applyMatrix4(result(index)!).toArray(), expected.toArray());
      expect(result(index)!.determinant()).toBeCloseTo(1, 7);
    });
  });
  it("uses rotated object scale axes and transforms full anisotropic covariance", () => {
    const basis = new Quaternion().setFromEuler(new Euler(.2, .4, .6)), weights = [.25, .5, 1];
    const snapshot = captureSplatComponentTransform({ document: scene(), identity, selected: [0, 1, 2], weights, world: new Matrix4(), getRestCenter: index => positions[index], weightFrame: { basis, mode: "scale" } });
    const frame = new Matrix4().compose(snapshot.pivot, basis, new Vector3(1, 1, 1));
    const result = componentTransformLookup(snapshot.changes(frame.clone().multiply(new Matrix4().makeScale(2, .5, 1.4)).multiply(frame.clone().invert())));
    const rotation = new Quaternion().setFromEuler(new Euler(.4, .1, .7)), scales = new Vector3(.2, .06, .01);
    for (let i = 0; i < 3; i++) {
      const expected = frame.clone().multiply(new Matrix4().makeScale(1 + weights[i], 1 - .5 * weights[i], 1 + .4 * weights[i])).multiply(frame.clone().invert());
      close(covariance(gaussianFactor(positions[i], scales, rotation, result(i))), covariance(gaussianFactor(positions[i], scales, rotation, expected)));
    }
  });
  it("preserves hard reflections but rejects fractional reflective or zero scales atomically", () => {
    const options = { document: scene(), identity, selected: [0, 1, 2], world: new Matrix4(), getRestCenter: (index: number) => positions[index], weightFrame: { basis: new Quaternion(), mode: "scale" as const } };
    const hard = captureSplatComponentTransform({ ...options, weights: [0, 1, 1] });
    expect(() => hard.changes(new Matrix4().makeScale(-1, 1, 1))).not.toThrow();
    const soft = captureSplatComponentTransform({ ...options, weights: [0, .5, 1] });
    expect(() => soft.changes(new Matrix4().makeScale(-1, 1, 1))).toThrow(/fractional.*reflection/);
    expect(() => soft.changes(new Matrix4().makeScale(0, 1, 1))).toThrow(/singular/);
    expect((options.document.nodes.shape as any).componentTransforms).toBeUndefined();
  });
  it("captures the displayed Float32 gizmo pivot at large offsets without a false shear rejection", () => {
    const pivot = new Vector3(1000000.125, 2000000.25, 0), basis = new Quaternion().setFromEuler(new Euler(0, 0, .4));
    const snapshot = captureSplatComponentTransform({ document: scene(), identity, selected: [0, 1, 2], weights: [.25, .5, 1],
      world: new Matrix4().makeTranslation(1000000.1, 2000000.2, 0), getRestCenter: index => positions[index], weightFrame: { basis, pivot, mode: "scale" } });
    const frame = new Matrix4().compose(pivot, basis, new Vector3(1, 1, 1));
    expect(snapshot.pivot).toEqual(pivot);
    expect(() => snapshot.changes(frame.clone().multiply(new Matrix4().makeScale(1.2, .8, 1)).multiply(frame.clone().invert()))).not.toThrow();
  });
});
