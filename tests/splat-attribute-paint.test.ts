import { describe, expect, it, vi } from "vitest";
import { Matrix4, Object3D, OrthographicCamera } from "three";
import type { SplatMesh } from "@sparkjsdev/spark";
import { addSplat, emptyScene, type SplatShapeNode } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { createSkinBrushIndex } from "../src/skin-weight-brush.ts";
import { createSplatAttributePaintRuntime } from "../src/splat-attribute-paint-runtime.ts";
import {
  commitSplatAttributePaint, defaultSplatPaintSettings, validateSplatAttributePaint, withSplatPaintStroke,
} from "../src/splat-attribute-paint.ts";
import { decodeProject, encodeProject, validateScene, type EditorSnapshot } from "../src/project-archive.ts";
import type { SplatScalarMask } from "../src/splat-masks.ts";

const identity = { shapeId: "shape", assetId: "source", count: 4 };
const scene = addSplat(emptyScene(), { id: "source", kind: "procedural", generator: "knot-v1" }, "Paint", [0, 0, 0], "object", "shape").document;
const original = scene.nodes.shape as SplatShapeNode;
const stroke = (ids: number[], values = ids.map(() => 1)) => ({ indices: Uint32Array.from(ids), values: Float32Array.from(values) });
const settings = { ...defaultSplatPaintSettings, color: "#ff0000", opacity: .25, channels: "both" as const };

describe("splat attribute paint", () => {
  it("combines authored masks and selection while never writing hidden or deleted IDs", () => {
    const shape = { ...original, componentEdits: { version: 1 as const, sourceCount: 4, hidden: [2, 3], deleted: [3, 4] } };
    const mask: SplatScalarMask = {
      version: 1, id: "mask", name: "Region", assetId: "source", sourceCount: 4, locked: false,
      data: { kind: "dense", values: [.5, 1, 1, 1] }, componentLocks: [],
    };
    const result = withSplatPaintStroke(shape, 4, { ...settings, maskId: mask.id, selectedOnly: true }, stroke([0, 1, 2, 3]), new Set([0, 2, 3]), mask);
    expect(result?.records).toEqual([[0, .5, 0, 0, .5, .125, .5]]);
    expect(shape).not.toHaveProperty("attributePaint");
    expect(() => withSplatPaintStroke(shape, 4, { ...settings, maskId: "other" }, stroke([0]), undefined, mask)).toThrow(/mask/i);
    expect(() => withSplatPaintStroke(shape, 4, { ...settings, selectedOnly: true }, stroke([0]), new Set())).toThrow(/Select/);
  });

  it("preserves independent channel history and erases back to the original representation", () => {
    const first = withSplatPaintStroke(original, 4, settings, stroke([0], [.5]));
    const next = { ...original, attributePaint: first };
    const green = withSplatPaintStroke(next, 4, { ...settings, channels: "color", color: "#00ff00" }, stroke([0], [.5]));
    expect(green?.records).toEqual([[0, .25, .5, 0, .75, .125, .5]]);
    const eraseColor = withSplatPaintStroke({ ...original, attributePaint: green }, 4, { ...settings, channels: "color", operation: "erase" }, stroke([0]));
    expect(eraseColor?.records).toEqual([[0, 0, 0, 0, 0, .125, .5]]);
    expect(withSplatPaintStroke({ ...original, attributePaint: eraseColor }, 4, { ...settings, operation: "erase" }, stroke([0]))).toBeUndefined();
    expect(withSplatPaintStroke(original, 4, { ...settings, operation: "erase" }, stroke([0]))).toBeUndefined();
  });

  it("rejects invalid strokes atomically and authors exactly one undo/redo step", () => {
    const store = createSceneStore(scene), next = withSplatPaintStroke(original, 4, settings, stroke([1, 3]));
    expect(() => withSplatPaintStroke(original, 4, settings, stroke([1, 4]))).toThrow(/coverage/);
    expect(() => withSplatPaintStroke(original, 4, settings, stroke([2, 1]))).toThrow(/unordered/);
    expect(() => withSplatPaintStroke(original, 4, settings, stroke([0], [NaN]))).toThrow(/coverage/);
    expect(() => withSplatPaintStroke(original, 1_000_001, settings, stroke([0]))).toThrow(/1,000,000/);
    expect(() => withSplatPaintStroke(original, 4, settings, { indices: new Uint32Array(100_001), values: new Float32Array(100_001) })).toThrow(/100,000/);
    expect(store.getState().document).toBe(scene);
    expect(commitSplatAttributePaint(store, identity, original, next)).toBe(true);
    const edited = store.getState().document;
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    expect(() => commitSplatAttributePaint(store, identity, original, undefined)).toThrow(/changed/);
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(scene);
    store.temporal.getState().redo();
    expect(store.getState().document).toBe(edited);
  });

  it("round-trips authored paint and validates archive rows and decoded source counts", async () => {
    const store = createSceneStore(scene), next = withSplatPaintStroke(original, 4, settings, stroke([0]));
    commitSplatAttributePaint(store, identity, original, next);
    const authored = store.getState().document;
    const editor: EditorSnapshot = { camera: { position: [0, 0, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0 };
    expect((await decodeProject(await encodeProject(authored, new Map(), editor))).scene).toEqual(authored);
    expect(() => validateSplatAttributePaint(authored.nodes.shape as SplatShapeNode, 5)).toThrow(/decoded original source count/);
    const corrupted = { ...authored, nodes: { ...authored.nodes, shape: { ...original, attributePaint: { ...next, records: [[0, 1, 0, 0, .5, 0, 0]] } } } };
    expect(() => validateScene(corrupted)).toThrow(/premultiplied/);
  });

  it("front-center indexing chooses the nearest depth, then the lowest original ID", async () => {
    const camera = new OrthographicCamera(-1, 1, 1, -1, .01, 100);
    camera.position.z = 8;
    const options = {
      componentCount: 4, width: 200, height: 200, matrixWorld: new Matrix4(), camera,
      readPositions: () => Float32Array.of(0, 0, -.25, 0, 0, .25, 0, 0, .25, .5, 0, 0),
    };
    const front = await createSkinBrushIndex({ ...options, frontCenters: true });
    const through = await createSkinBrushIndex(options), picked: number[] = [];
    front.query(0, 0, 200, 200, id => picked.push(id));
    expect(picked).toEqual([1, 3]);
    expect(through.visibleCount).toBe(4);
  });

  it("composes paint opacity with graph appearance and leaves unmatched/generated IDs alone", () => {
    const mesh = Object.assign(new Object3D(), { updateGenerator: vi.fn(), updateVersion: vi.fn() }) as unknown as SplatMesh;
    const graph = { opacity: (_: number, source: number) => source * .5, scale: () => 1.75 };
    const runtime = createSplatAttributePaintRuntime(mesh, () => graph);
    const paint = withSplatPaintStroke(original, 4, settings, stroke([1], [.5]));
    expect(runtime.update(paint)).toBe(true);
    expect(runtime.update(paint)).toBe(false);
    expect(runtime.opacity(1, .8)).toBeCloseTo(.325);
    expect(runtime.opacity(0, .8)).toBeCloseTo(.4);
    expect(runtime.opacity(100, .8)).toBeCloseTo(.4);
    expect(runtime.scale(1)).toBe(1.75);
    expect(mesh.covObjectModifiers).toHaveLength(1);
    runtime.dispose();
    expect(mesh.covObjectModifiers).toHaveLength(0);
  });
});
