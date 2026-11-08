import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { clampedUniformKnots, createController, findControllerShape, rebuildControllerCurve, sampleControllerCurve, updateControllerShape, validateCurveShape } from "../src/controller-curves.ts";
import { addSplat, deleteSceneItems, emptyScene, type CurveControlPoint, type CurveShapeNode, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { evaluateSceneAnimation, setKeys } from "../src/animation.ts";
import { evaluateDrivenKeys, setDrivenKey } from "../src/driven-keys.ts";
import { createConstraint, evaluateConstraints } from "../src/constraints.ts";

const editor = { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: 0.01, far: 1000 }, time: 0 };
function fixture() {
  const store = createSceneStore(), id = createController(store, "circle", { plane: "XY" });
  return { store, id, shape: findControllerShape(store.getState().document, id)! };
}

describe("rational curve controllers", () => {
  it("samples exact rational circles in all three planes and sizes", () => {
    for (const plane of ["XY", "XZ", "YZ"] as const) {
      const store = createSceneStore(), id = createController(store, "circle", { plane, size: 2.5 });
      const shape = findControllerShape(store.getState().document, id)!;
      expect(shape.degree).toBe(2); expect(shape.points).toHaveLength(9);
      expect(shape.points[1][3]).toBe(Math.SQRT1_2);
      const samples = sampleControllerCurve(shape, 96);
      for (const point of samples) {
        expect(Math.hypot(...point)).toBeCloseTo(2.5, 12);
        expect(point[plane === "XY" ? 2 : plane === "XZ" ? 1 : 0]).toBe(0);
      }
      expect(samples[0]).toEqual(samples.at(-1));
    }
  });
  it("retains every square and arrow corner even with a low sample count", () => {
    for (const preset of ["square", "arrow"] as const) {
      const store = createSceneStore(), id = createController(store, preset, { plane: "XY" });
      const shape = findControllerShape(store.getState().document, id)!, samples = sampleControllerCurve(shape, 2);
      for (const point of shape.points) expect(samples.some(sample => sample.every((value, axis) => Math.abs(value - point[axis]) < 1e-12))).toBe(true);
      expect(samples.at(-1)).toEqual(samples[0]);
      updateControllerShape(store, shape.id, { closed: false });
      expect(sampleControllerCurve(findControllerShape(store.getState().document, id)!, 2).at(-1)).toEqual(shape.points.at(-1)!.slice(0, 3));
    }
  });
  it("uses the active knot domain for unclamped curves", () => {
    const { shape } = fixture();
    const custom: CurveShapeNode = { ...shape, degree: 2, closed: false,
      points: [[0, 0, 0, 1], [2, 0, 0, 1], [2, 2, 0, 1], [0, 2, 0, 1]], knots: [0, 1, 2, 3, 4, 5, 6] };
    const samples = sampleControllerCurve(custom, 2);
    expect(samples[0]).toEqual([1, 0, 0]); expect(samples.at(-1)).toEqual([1, 2, 0]);
    expect(samples.every(point => point.every(Number.isFinite))).toBe(true);
  });
  it("rejects disconnected interior knots while allowing clamped ends and rational-circle joins", () => {
    const { store, shape } = fixture(), before = store.getState().document;
    const points: CurveControlPoint[] = [[0, 0, 0, 1], [1, 0, 0, 1], [2, 0, 0, 1], [4, 1, 0, 1], [5, 1, 0, 1], [6, 1, 0, 1]];
    expect(() => updateControllerShape(store, shape.id, { degree: 2, points, knots: [0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1] })).toThrow(/disconnects.*Rebuild/);
    expect(store.getState().document).toBe(before);
    expect(() => validateCurveShape(shape)).not.toThrow();
    expect(() => validateCurveShape({ ...shape, degree: 1, points: points.slice(0, 4), knots: [0, 0, 0.5, 0.5, 1, 1] })).toThrow(/disconnects/);
  });
  it("creates unique ordinary transforms with placement and no asset records in one undo step", () => {
    const store = createSceneStore(), before = store.getState().document;
    const id = createController(store, "circle", { name: "Hand", position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 3, 4], color: "#aBc123" });
    expect(store.getState().document.nodes[id]).toMatchObject({ name: "Hand", parentId: null, position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 3, 4] });
    expect(findControllerShape(store.getState().document, id)!.color).toBe("#aBc123");
    expect(store.getState().document.assets).toEqual({}); expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before); store.temporal.getState().redo();
    const second = createController(store, "square", { name: "Hand" }); expect(store.getState().document.nodes[second].name).toBe("Hand1");
    expect(validateScene(store.getState().document)).toBe(store.getState().document);
  });
  it("edits CVs and rational weights immutably and supports undo/redo", () => {
    const { store, id, shape } = fixture(), before = store.getState().document;
    const originalSamples = sampleControllerCurve(shape), points = shape.points.map(point => [...point] as CurveControlPoint);
    points[1] = [2, 1, 0, 0.25];
    updateControllerShape(store, shape.id, { points, color: "#00ff00" });
    const after = store.getState().document;
    expect(sampleControllerCurve(findControllerShape(after, id)!)[8]).not.toEqual(originalSamples[8]);
    points[1][0] = 200; expect(findControllerShape(after, id)!.points[1][0]).toBe(2);
    expect(shape.points[1]).toEqual([1, 1, 0, Math.SQRT1_2]);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
    const history = store.temporal.getState().pastStates.length; updateControllerShape(store, shape.id, { color: "#00ff00" });
    expect(store.temporal.getState().pastStates).toHaveLength(history);
  });
  it("explicitly rebuilds clamped uniform knots after adding/removing CVs or changing degree", () => {
    const { store, id, shape } = fixture();
    const points: CurveControlPoint[] = [[0, 0, 0, 1], [1, 2, 0, 2], [2, 1, 0, 1], [3, 0, 0, 1], [4, 1, 0, 1]];
    const history = store.temporal.getState().pastStates.length;
    rebuildControllerCurve(store, shape.id, 3, points);
    const rebuilt = findControllerShape(store.getState().document, id)!;
    expect(rebuilt.knots).toEqual([0, 0, 0, 0, 0.5, 1, 1, 1, 1]); expect(rebuilt.points).toEqual(points);
    expect(store.temporal.getState().pastStates).toHaveLength(history + 1);
    rebuildControllerCurve(store, shape.id, 1, points.slice(0, 2));
    expect(findControllerShape(store.getState().document, id)!.knots).toEqual([0, 0, 1, 1]);
    expect(() => rebuildControllerCurve(store, shape.id, 3)).toThrow(/control points/);
  });
  it("rejects malformed weights, knots, colors, dimensions and updates atomically", () => {
    const { store, shape } = fixture(), before = store.getState().document;
    const cases: Array<(value: any) => void> = [
      value => value.degree = 4, value => value.degree = 1.5, value => value.points = [], value => value.points = Array(129).fill([0, 0, 0, 1]),
      value => value.points[0] = [1, 2, 3], value => value.points[0][0] = Infinity, value => value.points[0][0] = 1000001,
      value => value.points[0][3] = 0, value => value.points[0][3] = -1, value => value.points[0][3] = 1e7,
      value => value.knots.pop(), value => value.knots[0] = NaN, value => value.knots[4] = 0.1,
      value => value.knots.fill(0), value => value.knots[3] = 1e-12, value => value.closed = 1, value => value.color = "red",
    ];
    for (const mutate of cases) { const bad = structuredClone(shape); mutate(bad); expect(() => validateCurveShape(bad)).toThrow(); }
    expect(() => updateControllerShape(store, shape.id, { degree: 3 })).toThrow(/knot/);
    expect(store.getState().document).toBe(before);
    for (const count of [1, 129, 2.5]) expect(() => clampedUniformKnots(count, 2)).toThrow();
    expect(() => createController(store, "circle", { size: 0 })).toThrow();
    expect(() => sampleControllerCurve(shape, 1)).toThrow();
  });
  it("shares time animation, driven-key inputs and constraint sources with other transforms", () => {
    const { store, id } = fixture(), second = createController(store, "square"), third = createController(store, "arrow");
    const poses = evaluateSceneAnimation(store.getState().document, 10); poses.get(id)!.position[0] = 7;
    setKeys(store, [id], 10, poses, ["position.x"]);
    setDrivenKey(store, { targetId: id, channel: "position.x" }, { targetId: second, channel: "rotation.z" }, 0, 0);
    setDrivenKey(store, { targetId: id, channel: "position.x" }, { targetId: second, channel: "rotation.z" }, 7, 90);
    createConstraint(store, "point", id, third, false);
    const doc = store.getState().document, evaluated = evaluateSceneAnimation(doc, 10); evaluateDrivenKeys(doc, evaluated); evaluateConstraints(doc, evaluated);
    expect(evaluated.get(second)!.rotation[2]).toBe(90); expect(evaluated.get(third)!.position).toEqual([7, 0, 0]);
    expect(() => validateScene(doc)).not.toThrow();
    const deleted = deleteSceneItems(doc, [id]);
    expect(deleted.animation!.tracks).toEqual([]); expect(deleted.drivenKeys).toEqual([]); expect(deleted.constraints).toEqual([]);
    expect(findControllerShape(deleted, id)).toBeUndefined(); expect(() => validateScene(deleted)).not.toThrow();
  });
});

describe("controller archive integration", () => {
  it("round-trips curve-only and mixed splat/controller scenes without extra assets", async () => {
    const { store, shape } = fixture(); updateControllerShape(store, shape.id, { closed: false });
    for (const doc of [store.getState().document, addSplat(store.getState().document, { id: "asset", kind: "procedural", generator: "knot-v1" }, "Splat", [0, 0, 0]).document]) {
      const bytes = await encodeProject(doc, new Map(), editor), opened = await decodeProject(bytes);
      expect(opened.scene).toEqual(doc); expect(opened.files.size).toBe(0); expect(Object.keys(unzipSync(bytes))).toEqual(["scene.json"]);
      const controllerId = shape.parentId, deleted = deleteSceneItems(doc, [controllerId]);
      expect(Object.keys(deleted.assets)).toEqual(Object.keys(doc.assets)); expect(() => validateScene(deleted)).not.toThrow();
    }
  });
  it("allows shapeless groups, limits transforms to one renderable shape and validates shape parents", () => {
    const { store, id, shape } = fixture(), doc = store.getState().document;
    expect(() => validateScene({ ...doc, nodes: { ...doc.nodes, extra: { ...shape, id: "extra", name: "Extra" } } })).toThrow(/at most one/);
    const empty = structuredClone(doc); delete empty.nodes[shape.id]; expect(() => validateScene(empty)).not.toThrow();
    const orphan = structuredClone(doc); (orphan.nodes[shape.id] as any).parentId = null; expect(() => validateScene(orphan)).toThrow(/no transform/);
    const collision = { ...doc, joints: [{ id: shape.id, name: "Joint", parentId: null, position: [0, 0, 0] }] }; expect(() => validateScene(collision)).toThrow(/collide/);
    expect(doc.nodes[id].type).toBe("transform");
  });
  it("rejects malformed curve data inside packed archives before opening", async () => {
    const { store, shape } = fixture(), bytes = await encodeProject(store.getState().document, new Map(), editor);
    for (const mutate of [(value: any) => value.points[0][3] = 0, (value: any) => value.knots = [0, 1], (value: any) => value.degree = 9]) {
      const entries = unzipSync(bytes), manifest = JSON.parse(strFromU8(entries["scene.json"])); mutate(manifest.scene.nodes[shape.id]); entries["scene.json"] = strToU8(JSON.stringify(manifest));
      await expect(decodeProject(zipSync(entries))).rejects.toThrow();
    }
  });
});
