import { describe, expect, it } from "vitest";
import { Matrix4, OrthographicCamera, Quaternion, Vector3 } from "three";
import { addSplat, emptyScene } from "../src/scene-document.ts";
import { captureSplatComponentTransform, componentTransformLookup, gaussianFactor, withSplatComponentTransforms } from "../src/splat-component-transforms.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { parseSoftFalloffPresets } from "../src/soft-falloff-editor.ts";
import { defaultSplatSoftSettings, prepareSoftFalloffCurve, selectSplatRadial, selectSplatSphere, splatFalloff, splatSoftCoreFraction, validateSoftFalloffCurve, validateSplatSoftSettings, validateWeightedSplatSelection, type SoftFalloffCurve } from "../src/splat-soft-selection.ts";

const plateau = [{ distance: 0, weight: 1 }, { distance: .25, weight: 1 }, { distance: .5, weight: .6 }, { distance: .75, weight: 0 }, { distance: 1, weight: 0 }];
const settings = (customCurve = plateau) => ({ ...defaultSplatSoftSettings(), enabled: true, curve: "custom" as const, customCurve, worldRadius: 2, screenRadius: 200 });

describe("custom soft falloff", () => {
  it("honors exact endpoints, control points and plateaus with nonincreasing smooth interpolation", () => {
    for (const points of [plateau, [{ distance: 0, weight: 1 }, { distance: Number.MIN_VALUE, weight: .9 }, { distance: .99, weight: .1 }, { distance: 1, weight: 0 }]]) {
      const { sample } = prepareSoftFalloffCurve(points);
      points.forEach(({ distance, weight }) => expect(sample(distance)).toBe(weight));
      let previous = 1;
      for (let i = 1; i <= 2000; i++) {
        const weight = sample(i / 2000);
        expect(weight).toBeGreaterThanOrEqual(0);
        expect(weight).toBeLessThanOrEqual(previous + 1e-14);
        previous = weight;
      }
    }
    const { sample } = prepareSoftFalloffCurve(plateau), h = .000001;
    expect(sample(.1)).toBe(1); expect(sample(.99)).toBe(0);
    expect((sample(.5) - sample(.5 - h)) / h).toBeCloseTo((sample(.5 + h) - sample(.5)) / h, 4);
    expect(splatSoftCoreFraction(settings())).toBe(.25);
    expect(splatFalloff(.6, 2, { ...settings(), core: .95 })).toBeLessThan(1);
  });

  it("rejects invalid distance order, rising weights, endpoints, capacity and persisted presets", () => {
    const bad = [undefined, [], [plateau[0], plateau[1], { distance: .25, weight: .8 }, plateau[4]],
      [{ distance: 0, weight: .99 }, plateau[4]], [plateau[0], { distance: 1, weight: .1 }],
      [plateau[0], { distance: .5, weight: NaN }, plateau[4]], [plateau[0], { distance: Infinity, weight: .9 }, plateau[4]],
      [plateau[0], { distance: .3, weight: .4 }, { distance: .6, weight: .8 }, plateau[4]],
      Array.from({ length: 33 }, (_, i) => ({ distance: i / 32, weight: 1 - i / 32 }))];
    bad.forEach(points => expect(() => validateSoftFalloffCurve(points)).toThrow());
    expect(() => validateSplatSoftSettings({ ...settings(), customCurve: undefined })).toThrow();
    const eight = Array.from({ length: 8 }, (_, i) => ({ name: `Falloff ${i + 1}`, points: plateau }));
    expect(parseSoftFalloffPresets(JSON.stringify(eight))).toEqual(eight);
    expect(() => parseSoftFalloffPresets(JSON.stringify([...eight, { name: "Overflow", points: plateau }]))).toThrow(/eight/);
    expect(() => parseSoftFalloffPresets(JSON.stringify([{ name: "Name", points: plateau }, { name: "name", points: plateau }]))).toThrow(/unique/);
    expect(() => parseSoftFalloffPresets(JSON.stringify([{ name: "Bad", points: plateau.slice(1) }]))).toThrow(/endpoint/);
  });

  it("uses evaluated sphere and projected radial centers, skipping hidden originals and zero weights", async () => {
    const camera = new OrthographicCamera(-2, 2, 2, -2, .1, 100);
    camera.position.set(10, 0, 10); camera.lookAt(10, 0, 0); camera.updateMatrixWorld(true);
    const positions = Float32Array.of(0, 0, 0, .25, 0, 0, .5, 0, 0, .75, 0, 0, NaN, NaN, NaN, 0, 0, 2);
    const options = { componentCount: 6, matrixWorld: new Matrix4().makeScale(2, 1, 1).setPosition(10, 0, 0), readPositions: () => positions, camera, width: 400, height: 400, depth: "through" as const };
    const sphere = await selectSplatSphere(options, { ...settings(), center: [10, 0, 0] });
    const radial = await selectSplatRadial(options, { x: 200, y: 200 }, settings());
    expect(Array.from(sphere.indices)).toEqual([0, 1, 2]);
    expect(Array.from(radial.indices)).toEqual([0, 1, 2, 5]);
    expect(Array.from(sphere.weights)).toEqual([1, 1, Math.fround(.6)]);
    expect(Array.from(radial.weights)).toEqual([1, 1, Math.fround(.6), 1]);
    const tiny: SoftFalloffCurve = [plateau[0], { distance: .5, weight: 1e-300 }, plateau[4]];
    const result = await selectSplatSphere(options, { ...settings(), customCurve: tiny, center: [10, 0, 0] });
    expect(Array.from(result.indices)).toEqual([0, 1]);
    expect(() => validateWeightedSplatSelection(result, 6)).not.toThrow();
  });

  it("feeds the existing weighted pivot and Gaussian covariance and saves only resulting transforms", async () => {
    const positions = [0, .5, 1, 1.5].map(x => new Vector3(x, 0, 0));
    const identity = { shapeId: "shape", assetId: "asset", count: 4 };
    const doc = addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "Curve study", [0, 0, 0], "object", "shape").document;
    const hits = await selectSplatSphere({ componentCount: 4, matrixWorld: new Matrix4(), readPositions: () => Float32Array.from(positions.flatMap(point => point.toArray())) }, settings());
    const snapshot = captureSplatComponentTransform({ document: doc, identity, selected: hits.indices, weights: hits.weights, world: new Matrix4(), getRestCenter: index => positions[index], weightFrame: { mode: "scale", basis: new Quaternion() } });
    expect(snapshot.pivot.x).toBeCloseTo((0 + .5 + 1) / 3);
    const frame = new Matrix4().makeTranslation(snapshot.pivot.x, 0, 0);
    const changes = snapshot.changes(frame.clone().multiply(new Matrix4().makeScale(2, 1, 1)).multiply(frame.clone().invert()));
    const lookup = componentTransformLookup(changes);
    expect(lookup(3)).toBeUndefined();
    expect(lookup(0)!.elements[0]).toBe(2);
    const gaussian = gaussianFactor(positions[2], new Vector3(.2, .04, .01), new Quaternion(), lookup(2));
    expect(gaussian.elements[0] ** 2).toBeCloseTo((.2 * 1.6) ** 2);
    const changed = withSplatComponentTransforms(doc, identity, changes);
    const editor = { camera: { position: [0, 0, 8] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 42, near: .01, far: 100 }, time: 0 };
    const reopened = await decodeProject(await encodeProject(changed, new Map(), editor));
    expect(reopened.scene).toEqual(changed);
    expect(JSON.stringify(reopened.scene)).not.toMatch(/customCurve|falloff|selection/i);
  });
});
