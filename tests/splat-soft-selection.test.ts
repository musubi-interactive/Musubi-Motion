import { describe, expect, it } from "vitest";
import { Matrix4, OrthographicCamera } from "three";
import { combineSplatSelection } from "../src/splat-component-selection.ts";
import { combineWeightedSplatSelection, defaultSplatSoftSettings, hardSplatSelection, selectSplatRadial, selectSplatSphere, splatFalloff, validateSplatSoftSettings } from "../src/splat-soft-selection.ts";

const hard = (ids: number[]) => hardSplatSelection(Uint32Array.from(ids));
const settings = () => defaultSplatSoftSettings();
const weighted = (ids: number[], values: number[]) => ({ indices: Uint32Array.from(ids), weights: Float32Array.from(values) });
describe("sphere, radial and reusable soft membership", () => {
  it("defines zero/one falloff, hard boundary and editable core/curve", () => {
    const s = { ...settings(), enabled: true, curve: "linear" as const };
    expect(splatFalloff(0, 1, s)).toBe(1); expect(splatFalloff(1, 1, s)).toBe(0); expect(splatFalloff(2, 1, s)).toBe(0);
    expect(splatFalloff(.5, 1, s)).toBe(.5); expect(splatFalloff(.5, 1, { ...s, curve: "sharp" })).toBe(.25);
    expect(splatFalloff(.25, 1, { ...s, core: .5 })).toBe(1); expect(splatFalloff(1, 1, settings())).toBe(1);
  });
  it("keeps hard selection operations exactly compatible and soft combines explicit", () => {
    for (const operation of ["replace", "add", "subtract", "toggle"] as const) expect(combineWeightedSplatSelection(hard([0, 2, 4]), hard([1, 2]), operation, 5).indices)
      .toEqual(combineSplatSelection([0, 2, 4], [1, 2], operation, 5));
    expect(Array.from(combineWeightedSplatSelection(weighted([0, 1], [.5, .75]), weighted([1, 2], [.25, .5]), "subtract", 3).weights)).toEqual([.5, .5]);
    expect(Array.from(combineWeightedSplatSelection(weighted([0, 1], [.5, .75]), weighted([1, 2], [1, .5]), "add", 3).weights)).toEqual([.5, 1, .5]);
  });
  it("distinguishes 3D sphere distance from 2D circle through depth and excludes ineligible NaNs", async () => {
    const positions = new Float32Array([0, 0, 0, 0, 0, 3, 1, 0, 0, NaN, NaN, NaN]);
    const camera = new OrthographicCamera(-2, 2, 2, -2, .1, 100); camera.position.z = 10; camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
    const options = { componentCount: 4, readPositions: (start: number, count: number) => positions.slice(start * 3, (start + count) * 3), matrixWorld: new Matrix4(), camera, width: 400, height: 400, depth: "through" as const };
    const sphere = await selectSplatSphere(options, { ...settings(), worldRadius: .75 });
    const radial = await selectSplatRadial(options, { x: 200, y: 200 }, { ...settings(), screenRadius: 75 });
    expect(Array.from(sphere.indices)).toEqual([0]); expect(Array.from(radial.indices)).toEqual([0, 1]);
    const front = await selectSplatRadial({ ...options, depth: "front-centers" }, { x: 200, y: 200 }, { ...settings(), screenRadius: 75 });
    expect(Array.from(front.indices)).toEqual([1]);
  });
  it("measures sphere radius in posed/evaluated world units under transformed object basis", async () => {
    const result = await selectSplatSphere({ componentCount: 3, matrixWorld: new Matrix4().makeScale(2, .5, 1).setPosition(10, 0, 0),
      readPositions: () => new Float32Array([0, 0, 0, .5, 0, 0, 1, 0, 0]) }, { ...settings(), enabled: true, curve: "linear", center: [10, 0, 0], worldRadius: 2 });
    expect(Array.from(result.indices)).toEqual([0, 1]); expect(Array.from(result.weights)).toEqual([1, .5]);
  });
  it("cancels a chunked scan atomically and handles large radius without unstable values", async () => {
    let cancelled = false;
    await expect(selectSplatSphere({ componentCount: 8192, matrixWorld: new Matrix4(), readPositions: (_, count) => new Float32Array(count * 3), cancelled: () => cancelled, yieldTask: async () => { cancelled = true; } }, settings())).rejects.toMatchObject({ name: "AbortError" });
    const result = await selectSplatSphere({ componentCount: 10000, matrixWorld: new Matrix4(), readPositions: (_, count) => new Float32Array(count * 3) }, { ...settings(), enabled: true, worldRadius: 1000000 });
    expect(result.weights.length).toBe(10000); expect(result.weights.every(value => value === 1)).toBe(true);
  });
  it("rejects invalid settings and weights rather than publishing partial state", () => {
    for (const patch of [{ worldRadius: 0 }, { screenRadius: Infinity }, { core: 1 }, { center: [NaN, 0, 0] }]) expect(() => validateSplatSoftSettings({ ...settings(), ...patch } as any)).toThrow();
    expect(() => combineWeightedSplatSelection(weighted([0], [NaN]), hard([1]), "add", 2)).toThrow();
    expect(() => combineWeightedSplatSelection(weighted([1, 0], [.5, .5]), hard([]), "replace", 2)).toThrow();
  });
});
