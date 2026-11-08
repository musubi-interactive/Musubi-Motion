import { describe, expect, it } from "vitest";
import { Matrix4, OrthographicCamera } from "three";
import { createSkinBrushIndex, type SkinBrushIndex } from "../src/skin-weight-brush.ts";
import { createSplatMaskStroke, type SplatMaskBrush } from "../src/splat-mask-brush.ts";
const settings: SplatMaskBrush = { shapeId: "shape", maskId: "mask", mode: "replace", radius: 10, strength: 1, value: 1, falloff: "smooth", selectedOnly: false };
function index(points: [number, number, number][]): SkinBrushIndex { return { componentCount: points.length, visibleCount: points.length, width: 100, height: 100, cellSize: 32, query(a, b, c, d, visit) { for (const [id, x, y] of points) if (x >= a && x <= c && y >= b && y <= d) visit(id, x, y); } }; }
describe("bounded scalar mask brush", () => {
  it("continuous coverage is independent of pointer sampling frequency, honors falloff/strength and locks", () => {
    const positions = index([[0, 20, 20], [1, 50, 25], [2, 80, 20]]), a = createSplatMaskStroke(positions, settings, () => 0, id => id === 2), b = createSplatMaskStroke(positions, settings, () => 0, id => id === 2);
    a.addSegment({ x: 10, y: 20 }, { x: 90, y: 20 }); for (let x = 10; x < 90; x += 5) b.addSegment({ x, y: 20 }, { x: x + 5, y: 20 }); expect(a.values()).toEqual(b.values()); expect([...a.values().indices]).toEqual([0, 1]); expect([...a.values().values]).toEqual([1, .5]);
    const erase = createSplatMaskStroke(positions, { ...settings, mode: "erase", strength: .5, value: .8, falloff: "constant" }, () => 1, () => false); erase.addSegment({ x: 20, y: 20 }, { x: 20, y: 20 }); expect(erase.values().values[0]).toBeCloseTo(.6);
  });
  it("smooth reads immutable neighborhood averages and never normalizes unrelated components", () => {
    const stroke = createSplatMaskStroke(index([[0, 20, 20], [1, 25, 20]]), { ...settings, mode: "smooth", falloff: "constant" }, id => id, () => false); stroke.addSegment({ x: 20, y: 20 }, { x: 25, y: 20 }); expect([...stroke.values().values]).toEqual([.5, .5]);
  });
  it("accepts100k true scalar edits; overflow invalidates the complete stroke with no partial values", () => {
    const positions: SkinBrushIndex = { componentCount: 100_001, visibleCount: 100_001, width: 100, height: 100, cellSize: 32, query(_a, _b, _c, _d, visit) { for (let id = 0; id < this.componentCount; id++) visit(id, 20, 20); } };
    const large = createSplatMaskStroke({ ...positions, componentCount: 100_000 }, settings, () => 0, () => false); large.addSegment({ x: 20, y: 20 }, { x: 20, y: 20 }); expect(large.values().indices.length).toBe(100_000);
    const overflow = createSplatMaskStroke(positions, settings, () => 0, () => false); expect(() => overflow.addSegment({ x: 20, y: 20 }, { x: 20, y: 20 })).toThrow(/100,000/); expect(() => overflow.values()).toThrow(/100,000/); expect(overflow.affectedCount).toBe(0);
  });
  it("projected index allocation rejects its explicit budget without changing existing skin defaults", async () => {
    const camera = new OrthographicCamera(-1, 1, 1, -1, .1, 10); camera.position.z = 2; camera.updateMatrixWorld(); camera.updateProjectionMatrix();
    const options = { componentCount: 3, matrixWorld: new Matrix4(), camera, width: 100, height: 100, readPositions: () => new Float32Array(9) };
    await expect(createSkinBrushIndex({ ...options, projectedLimit: 2 })).rejects.toThrow(/budget/); expect((await createSkinBrushIndex(options)).visibleCount).toBe(3);
  });
});
