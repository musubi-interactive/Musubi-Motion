import { describe, expect, it } from "vitest";
import { Box3, Color, Euler, Matrix3, Matrix4, Quaternion, Raycaster, Vector3 } from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import { addSplat, emptyScene, type SceneDocument } from "../src/scene-document.ts";
import { captureSplatComponentTransform, checkedAffine, componentTransformLookup, gaussianBounds, gaussianFactor, transformGaussianTRS, trimSplatTransformHistory, validateSplatComponentTransforms, withSplatComponentTransforms } from "../src/splat-component-transforms.ts";
import { createSplatTransformRuntime } from "../src/splat-transform-runtime.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { createBinding } from "../src/splat-binding.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";

const identity = { shapeId: "shape", assetId: "asset", count: 3 };
const centers = [new Vector3(-1, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0)];
function fixture() { return addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "Study", [0, 0, 0], "object", "shape").document; }
function capture(document = fixture(), selected = [0, 1], world = new Matrix4(), skin?: (index: number) => Matrix4) {
  return captureSplatComponentTransform({ document, identity, selected, world, getRestCenter: index => centers[index], getSkinMatrix: skin });
}
function covariance(factor: Matrix4) {
  const a = new Matrix3().setFromMatrix4(factor);
  return a.clone().multiply(a.clone().transpose());
}
function closeArray(a: readonly number[], b: readonly number[], digits = 7) { a.forEach((value, index) => expect(value).toBeCloseTo(b[index], digits)); }
async function meshFixture() {
  const mesh = new SplatMesh({ extSplats: true, covSplats: true, constructSplats(source) {
    centers.forEach(center => source.pushSplat(center, new Vector3(.2, .06, .03), new Quaternion().setFromEuler(new Euler(.1, .2, .7)), 1, new Color(1, .2, .1)));
  } });
  await mesh.initialized;
  const source = mesh.extSplats!;
  source.initialize({ extArrays: source.extArrays, numSplats: source.numSplats, extra: source.extra });
  return mesh;
}

describe("stable original Gaussian component transforms", () => {
  it("moves only selected members and retains source IDs, selection weights and shared centroid", () => {
    const doc = fixture(), snapshot = capture(doc), value = snapshot.changes(new Matrix4().makeTranslation(2, 3, 4));
    expect(snapshot.pivot.toArray()).toEqual([0, 0, 0]); expect(snapshot.weights).toEqual([1, 1]);
    const lookup = componentTransformLookup(value);
    expect(centers[0].clone().applyMatrix4(lookup(0)!).toArray()).toEqual([1, 3, 4]);
    expect(lookup(2)).toBeUndefined(); expect((doc.nodes.shape as any).componentTransforms).toBeUndefined();
  });
  it("uses an immutable gesture baseline and identity is an exact no-op", () => {
    const doc = fixture(), snapshot = capture(doc);
    expect(snapshot.changes(new Matrix4())).toBeUndefined();
    const delta = new Matrix4().makeRotationZ(.4);
    expect(snapshot.changes(delta)).toEqual(snapshot.changes(delta));
    expect(withSplatComponentTransforms(doc, identity, undefined)).toBe(doc);
  });
  it("maps posed world deltas back through the exact blended skin affine and object basis", () => {
    const world = new Matrix4().compose(new Vector3(3, 2, 1), new Quaternion().setFromEuler(new Euler(.2, .5, .1)), new Vector3(2, .8, 1.3));
    const skin = (index: number) => new Matrix4().compose(new Vector3(index, 2, 0), new Quaternion().setFromEuler(new Euler(.3, -.2, index * .4)), new Vector3(.7, 1.4, 1));
    const snapshot = capture(fixture(), [0, 1], world, skin);
    const delta = new Matrix4().makeTranslation(.3, -.4, .5).multiply(new Matrix4().makeRotationY(.4)).multiply(new Matrix4().makeScale(1.4, .6, 1.2));
    const result = componentTransformLookup(snapshot.changes(delta));
    for (const index of [0, 1]) {
      const actual = centers[index].clone().applyMatrix4(result(index)!).applyMatrix4(skin(index)).applyMatrix4(world);
      const expected = centers[index].clone().applyMatrix4(skin(index)).applyMatrix4(world).applyMatrix4(delta);
      closeArray(actual.toArray(), expected.toArray());
      const orientation = new Quaternion().setFromEuler(new Euler(.2, .4, .7)), scales = new Vector3(.2, .05, .01);
      const before = gaussianFactor(centers[index], scales, orientation).premultiply(skin(index)).premultiply(world).premultiply(delta);
      const after = gaussianFactor(centers[index], scales, orientation, result(index)).premultiply(skin(index)).premultiply(world);
      closeArray(covariance(after).elements, covariance(before).elements);
    }
  });
  it("retains off-axis anisotropic covariance under nonuniform scale and shear", () => {
    const affine = new Matrix4().makeRotationY(.6).multiply(new Matrix4().makeScale(3, .4, 1.2)).multiply(new Matrix4().makeShear(.2, .1, 0, .3, .1, 0));
    const rotation = new Quaternion().setFromEuler(new Euler(.3, .4, .7)), scales = new Vector3(.3, .07, .01);
    const transformed = transformGaussianTRS(rotation, scales, affine);
    closeArray(covariance(gaussianFactor(new Vector3(), transformed.scales, transformed.quaternion)).elements,
      covariance(gaussianFactor(new Vector3(), scales, rotation, affine)).elements);
    const bounds = gaussianBounds(gaussianFactor(new Vector3(1, 2, 3), scales, rotation, affine), 2);
    expect(bounds.isEmpty()).toBe(false); expect(bounds.min.toArray().every(Number.isFinite)).toBe(true);
  });
  it("rejects near-singular skin and all invalid deltas atomically", () => {
    expect(() => capture(fixture(), [0, 1], new Matrix4(), index => new Matrix4().makeScale(index ? 1e-10 : 1, 1, 1))).toThrow(/nearly singular/);
    const snapshot = capture();
    for (const delta of [new Matrix4().makeScale(1, 0, 1), new Matrix4().makeScale(1e-10, 1, 1), new Matrix4().makeTranslation(NaN, 0, 0)]) expect(() => snapshot.changes(delta)).toThrow();
    expect(() => checkedAffine(new Matrix4().makePerspective(-1, 1, 1, -1, 1, 100))).toThrow(/affine/);
  });
  it("rejects hidden/deleted members and the explicit gesture budget without truncation", () => {
    const doc = fixture(); (doc.nodes.shape as any).componentEdits = { version: 1, sourceCount: 3, hidden: [0, 1], deleted: [2, 3] };
    expect(() => capture(doc, [0, 1])).toThrow(/visible/);
    expect(() => capture(doc, Array(100001).fill(1))).toThrow(/100,000/);
  });
  it("strictly validates archived indices, matrices, version and source count", () => {
    const value = capture().changes(new Matrix4().makeTranslation(1, 0, 0))!;
    expect(() => validateSplatComponentTransforms(value, 3)).not.toThrow();
    for (const bad of [{ ...value, version: 9 }, { ...value, sourceCount: 4 }, { ...value, records: [...value.records, value.records[0]] }, { ...value, records: [{ index: 3, matrix: new Matrix4().toArray() }] }]) expect(() => validateSplatComponentTransforms(bad, 3)).toThrow();
  });
  it("bounds large-edit history while retaining immediate undo and redo", () => {
    const store = createSceneStore(fixture());
    for (let step = 0; step < 5; step++) {
      const document = structuredClone(store.getState().document);
      (document.nodes.shape as any).componentTransforms = { version: 1, sourceCount: 100000, records: Array.from({ length: 100000 }, (_, index) => ({ index, matrix: new Matrix4().makeTranslation(step, 0, 0).toArray() })) };
      store.setState({ document, editLabel: "Large component gesture" }); trimSplatTransformHistory(store);
    }
    expect(store.temporal.getState().pastStates.length).toBe(2);
    const latest = store.getState().document;
    store.temporal.getState().undo(); expect(store.getState().document).not.toBe(latest);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(latest);
  });
  it("retains the immediate prior state for a permitted 150k to 250k scene edit", () => {
    const before = fixture(), records = Array.from({ length: 150000 }, (_, index) => ({ index, matrix: new Matrix4().toArray() }));
    (before.nodes.shape as any).componentTransforms = { version: 1, sourceCount: 250000, records };
    const store = createSceneStore(before);
    const next = { version: 1 as const, sourceCount: 250000, records: [...records, ...Array.from({ length: 100000 }, (_, index) => ({ index: index + 150000, matrix: new Matrix4().makeTranslation(1, 0, 0).toArray() }))] };
    const after = withSplatComponentTransforms(before, { ...identity, count: 250000 }, next);
    store.setState({ document: after, editLabel: "Move 100k new splats" }); trimSplatTransformHistory(store);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
    // Replacing 100k rows at this full scene size would require 350k unique
    // historical rows. Reject before publishing, retaining current + undo.
    const tooLarge = { ...next, records: next.records.map((row, index) => index < 100000 ? { index, matrix: new Matrix4().makeTranslation(2, 0, 0).toArray() } : row) };
    expect(() => withSplatComponentTransforms(after, { ...identity, count: 250000 }, tooLarge)).toThrow(/immediate undo/);
    expect(store.getState().document).toBe(after); expect(store.temporal.getState().pastStates).toHaveLength(1);
  });
  it("rejects invalid Gaussian scales and nonfinite transformed centers before publishing records", () => {
    expect(() => captureSplatComponentTransform({ document: fixture(), identity, selected: [0], world: new Matrix4(), getRestCenter: () => new Vector3(), getGaussian: () => ({ scales: new Vector3(1, 0, 1), quaternion: new Quaternion() }) })).toThrow(/degenerate/);
    const snapshot = captureSplatComponentTransform({ document: fixture(), identity, selected: [0], world: new Matrix4(), getRestCenter: () => new Vector3(1e12, 0, 0) });
    expect(() => snapshot.changes(new Matrix4().makeScale(100, 1, 1))).toThrow(/centers/);
  });
  it("authors one store change and supports exact undo/redo/current archive reopen", async () => {
    const before = fixture(), store = createSceneStore(before), session = capture(before);
    const value = session.changes(new Matrix4().makeTranslation(2, 0, 0));
    session.changes(new Matrix4().makeTranslation(1, 0, 0)); expect(store.temporal.getState().pastStates).toHaveLength(0);
    const after = withSplatComponentTransforms(before, identity, value);
    store.setState({ document: after, editLabel: "Move splats" }); expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
    const archive = await encodeProject(after, new Map(), { camera: { position: [0, 0, 8], target: [0, 0, 0], fov: 42, view: "front", height: 4, near: .01, far: 1000 }, time: 0 });
    const decoded = await decodeProject(archive); expect(decoded.scene).toEqual(after);
  });
  it("keeps runtime source bytes/SH/color/opacity untouched; CPU centers, ray and bounds agree", async () => {
    const mesh = await meshFixture(), original = mesh.extSplats!.extArrays.map(data => data.slice());
    const before = mesh.extSplats!.getSplat(0), runtime = createSplatTransformRuntime(mesh);
    runtime.update(capture().changes(new Matrix4().makeTranslation(0, 2, 0)));
    expect(Array.from(runtime.positions([0, 1, 2]))).toEqual([-1, 2, 0, 1, 2, 0, 0, 1, 0]);
    expect(runtime.bounds(() => true).containsPoint(new Vector3(-1, 2, 0))).toBe(true);
    expect(runtime.pick(index => index === 0, new Raycaster(new Vector3(-1, 2, 10), new Vector3(0, 0, -1)))).toBeLessThan(Infinity);
    expect(runtime.pick(index => index === 0, new Raycaster(new Vector3(-1, 0, 10), new Vector3(0, 0, -1)))).toBe(Infinity);
    expect(mesh.extSplats!.extArrays).toEqual(original); expect(mesh.extSplats!.getSplat(0)).toEqual(before);
    runtime.update(undefined); expect(Array.from(runtime.positions([0, 1]))).toEqual([-1, 0, 0, 1, 0, 0]); runtime.dispose(); mesh.dispose();
  });
  it("posed picking and component positions use the same pre-skin rest edit", async () => {
    const mesh = await meshFixture(), runtime = createSplatTransformRuntime(mesh);
    runtime.update(capture().changes(new Matrix4().makeTranslation(0, 1, 0))); runtime.setBound(true);
    const binding = createBinding(mesh, { jointIds: ["joint"], restMatrices: [new Matrix4().toArray()] }, undefined, [], runtime);
    binding.update(() => new Matrix4().makeRotationZ(Math.PI / 2));
    const positions = binding.getComponentPositions([0, 1, 2]);
    closeArray(Array.from(positions), [-1, -1, 0, -1, 1, 0, -1, 0, 0], 4);
    closeArray(Array.from(binding.selection().centers), Array.from(positions), 5);
    expect(binding.selection().pick(new Raycaster(new Vector3(-1, -1, 10), new Vector3(0, 0, -1)))).toBeLessThan(Infinity);
    binding.dispose(); runtime.dispose(); mesh.dispose();
  });
});
