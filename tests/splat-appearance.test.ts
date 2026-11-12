import { describe, expect, it } from "vitest";
import { SplatMesh } from "@sparkjsdev/spark";
import { Color, Matrix4, Quaternion, Raycaster, Vector3 } from "three";
import {
  createSplatAppearanceEvaluator, commitSplatAppearance, newSplatAppearanceLayer, replaceSplatAppearance,
  validateSceneSplatAppearance, validateSplatAppearance,
} from "../src/splat-appearance.ts";
import { createSplatAppearanceRuntime } from "../src/splat-appearance-runtime.ts";
import { createSplatTransformRuntime } from "../src/splat-transform-runtime.ts";
import { createBinding } from "../src/splat-binding.ts";
import { createSplatEditMask } from "../src/splat-component-runtime.ts";
import { animatedNoiseGraph, commitGraphCommand, connectGraphPorts, createGraphNode, createProceduralGraph, type ProceduralGraph } from "../src/procedural-graph.ts";
import { compileGraph, type GraphProgram } from "../src/procedural-graph-runtime.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { createSplatMask, editSplatCollection } from "../src/splat-masks.ts";
import { addSplat, emptyScene, type SplatShapeNode } from "../src/scene-document.ts";
import { decodeProject, encodeProject, validateScene, type EditorSnapshot } from "../src/project-archive.ts";

function scene() {
  const { document } = addSplat(emptyScene(), { id: "source", kind: "procedural", generator: "knot-v1" }, "Appearance", [0, 0, 0], "object", "shape");
  return { ...document, proceduralGraph: createProceduralGraph() };
}
const identity = { shapeId: "shape", assetId: "source", count: 2 };
const pixels = new Map();
const origin = new Vector3();
const graphFrom = (sample: GraphProgram["sample"]): GraphProgram => ({ sample, animated: false, fragment: "", uniforms: new Float32Array(), images: [] });
const constant = graphFrom(() => [.3, .6, .9, .25]);
const shape = (document: ReturnType<typeof scene>) => document.nodes.shape as SplatShapeNode;

async function meshFixture(secondX = 1) {
  const mesh = new SplatMesh({ extSplats: true, covSplats: true, constructSplats(source) {
    source.pushSplat(origin, new Vector3(.1, .1, .1), new Quaternion(), 1, new Color(.5, .5, .5));
    source.pushSplat(new Vector3(secondX, 0, 0), new Vector3(.1, .1, .1), new Quaternion(), 1, new Color(.5, .5, .5));
  } });
  await mesh.initialized;
  return mesh;
}
function state(graph: GraphProgram, layer = newSplatAppearanceLayer()) {
  return {
    stack: { version: 1 as const, sourceCount: 2, layers: [layer] }, masks: [], graph, images: pixels, frame: 0, fps: 24,
    affine: () => undefined,
  };
}

describe("splat appearance stack", () => {
  it("authors a single immutable history record, protects references and rejects invalid changes atomically", () => {
    const store = createSceneStore(scene());
    const maskId = createSplatMask(store, identity, "Painted region", [0]);
    const before = store.getState().document;
    const layer = { ...newSplatAppearanceLayer(), maskId };
    commitSplatAppearance(store, identity, [layer], "Assign appearance");
    const current = store.getState().document;
    expect(current).not.toBe(before);
    expect(store.temporal.getState().pastStates.at(-1)?.document).toBe(before);
    expect(() => editSplatCollection(store, identity, "mask", maskId, "delete")).toThrow(/assigned/);
    expect(() => commitGraphCommand(store, "Delete graph", () => undefined)).toThrow(/Output/);
    expect(() => commitSplatAppearance(store, identity, [{ ...layer, scaleU: 0 }], "Invalid")).toThrow(/projection/);
    expect(store.getState().document).toBe(current);
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(before);
    store.temporal.getState().redo();
    expect(store.getState().document).toBe(current);
  });

  it("rejects malformed schemas, dangling masks and decoded source mismatches", () => {
    const doc = scene(), layer = newSplatAppearanceLayer();
    const result = replaceSplatAppearance(doc, identity, [layer]);
    const splat = result.nodes.shape as SplatShapeNode;
    expect(validateSplatAppearance(splat, 2)).toBe(2);
    expect(() => validateSplatAppearance(splat, 3)).toThrow(/decoded/);
    expect(() => replaceSplatAppearance(doc, identity, [layer, layer])).toThrow(/layer/);
    expect(() => replaceSplatAppearance(doc, identity, [{ ...layer, maskId: "missing" }])).toThrow(/mask/);
    expect(() => replaceSplatAppearance(doc, { ...identity, count: 250_001 }, [layer])).toThrow(/250,000/);
    expect(() => validateSceneSplatAppearance({ ...result, proceduralGraph: undefined })).toThrow(/Output/);
  });

  it("round-trips the versioned stack and rejects invalid archive data before publication", async () => {
    const authored = replaceSplatAppearance(scene(), identity, [{ ...newSplatAppearanceLayer(), opacity: true }]);
    const editor: EditorSnapshot = { camera: { position: [0, 0, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0 };
    const decoded = await decodeProject(await encodeProject(authored, new Map(), editor));
    expect(decoded.scene).toEqual(authored);
    const corrupted = structuredClone(authored);
    const target = corrupted.nodes.shape as SplatShapeNode;
    target.appearance!.layers[0].blend = 2;
    expect(() => validateScene(corrupted)).toThrow(/appearance/);
  });

  it("combines painted masks and ordered source-relative channels with explicit planar coordinates", () => {
    const store = createSceneStore(scene());
    const maskId = createSplatMask(store, identity, "Paint", [0]);
    const mask = shape(store.getState().document as ReturnType<typeof scene>).scalarMasks!;
    const program = graphFrom(({ uv, position }) => [uv[0], uv[1], position![2], uv[0]]);
    const first = { ...newSplatAppearanceLayer(), plane: "XZ" as const, scaleU: 2, scaleV: 3, offsetU: -.2, offsetV: 0, blend: .5, maskId, opacity: true, scale: true, scaleMin: .5, scaleMax: 2 };
    const second = { ...newSplatAppearanceLayer(), space: "world" as const, plane: "YZ" as const, offsetU: 0, offsetV: 0, blend: .5, opacity: true };
    const output = new Float32Array(16), local = new Vector3(.2, .3, .1), world = new Vector3(.6, .8, .2);
    const evaluate = createSplatAppearanceEvaluator([first, second], mask, program, pixels, 0, 24);
    evaluate(0, local, world, output); evaluate(1, local, world, output);
    const expected = [.45, .175, .375, .25, .7, .9, 0, 0, .4, .1, .3, .5, .9, 1, 0, 0];
    expected.forEach((value, i) => expect(output[i]).toBeCloseTo(value, 6));
    createSplatAppearanceEvaluator([second, first], mask, program, pixels, 0, 24)(0, local, world, output);
    expect(output[0]).toBeCloseTo(.3, 6);
    expect(output[4]).toBeCloseTo(.55, 6);
  });

  it("re-evaluates arbitrary time without accumulating effects into originals", async () => {
    const mesh = await meshFixture(), runtime = createSplatAppearanceRuntime(mesh, 2);
    const graph = compileGraph(animatedNoiseGraph());
    const sample = graph.sample;
    let calls = 0;
    const animated = { ...graph, sample: ((...args) => { calls++; const [r, g, b] = sample(...args); return [r, g, b, (r + g + b) / 3]; }) as GraphProgram["sample"] };
    const next = state(animated, { ...newSplatAppearanceLayer(), opacity: true, scale: true });
    runtime.update(next);
    const initial = runtime.opacity(0, 1);
    expect(runtime.update({ ...next })).toBe(false);
    expect(calls).toBe(2);
    runtime.update({ ...next, frame: 37.25 });
    expect(runtime.opacity(0, 1)).not.toBe(initial);
    runtime.update(next);
    expect(runtime.opacity(0, 1)).toBe(initial);
    expect(mesh.extSplats!.getSplat(0).opacity).toBe(1);
    expect(runtime.opacity(2, .75)).toBe(.75);
    expect(runtime.scale(2)).toBe(1);
    runtime.dispose(); mesh.dispose();
  });

  it("publishes no partial opacity or scale when sampling fails partway", async () => {
    const mesh = await meshFixture(), runtime = createSplatAppearanceRuntime(mesh, 2);
    const next = state(constant, { ...newSplatAppearanceLayer(), opacity: true, scale: true });
    runtime.update(next);
    const initial = runtime.scale(0);
    let sampled = 0;
    const invalid = graphFrom(() => {
      if (++sampled > 1) throw Error("Missing image pixels");
      return [1, 1, 1, 0];
    });
    expect(() => runtime.update({ ...next, graph: invalid })).toThrow(/pixels/);
    expect(runtime.opacity(0, 1)).toBe(.25);
    expect(runtime.scale(0)).toBe(initial);
    runtime.dispose(); mesh.dispose();
  });

  it("rejects Float32 projection overflow without publishing invalid CPU or GPU coefficients", async () => {
    const mesh = await meshFixture(3e38), runtime = createSplatAppearanceRuntime(mesh, 2);
    const layer = { ...newSplatAppearanceLayer(), opacity: true, scale: true, scaleU: 10_000 };
    const baseline = state(constant, layer);
    runtime.update(baseline);
    const before = [runtime.opacity(0, 1), runtime.opacity(1, 1), runtime.scale(1)];
    const graph: ProceduralGraph = { nodes: [createGraphNode("noise", "noise", 0, 0), createGraphNode("output", "output", 180, 0)], edges: [] };
    const overflow = compileGraph(connectGraphPorts(graph, { node: "noise", port: "value" }, { node: "output", port: "alpha" }));
    expect(() => runtime.update({ ...baseline, graph: overflow })).toThrow(/nonfinite appearance/);
    expect([runtime.opacity(0, 1), runtime.opacity(1, 1), runtime.scale(1)]).toEqual(before);
    runtime.dispose(); mesh.dispose();
  });

  it("updates world projection after skin and keeps CPU opacity, scale and component edits coherent", async () => {
    const mesh = await meshFixture(), transforms = createSplatTransformRuntime(mesh);
    const binding = createBinding(mesh, { jointIds: ["joint"], restMatrices: [new Matrix4().toArray()] }, undefined, [], transforms);
    transforms.setBound(true);
    const appearance = createSplatAppearanceRuntime(mesh, 2);
    const edit = createSplatEditMask(mesh, { version: 1, sourceCount: 2, hidden: [], deleted: [1, 2] });
    binding.setComponentActive(edit.isActive);
    const ray = new Raycaster(new Vector3(.22, 0, 3), new Vector3(0, 0, -1));
    const program = graphFrom(({ uv }) => [1, 0, 0, uv[0] > .6 ? 0 : 1]);
    const base = state(program, { ...newSplatAppearanceLayer(), space: "world", opacity: true, scale: true, scaleMax: 2 });
    function applyPose(pose: Matrix4) {
      binding.update(() => pose);
      const changed = appearance.update({ ...base, skinRevision: binding.appearancePose, skinCenter: binding.applySkinCenter });
      binding.setAppearance(appearance, changed);
    }
    applyPose(new Matrix4());
    expect(binding.selection().pick(ray)).toBeLessThan(Infinity);
    expect(Number.isNaN(binding.getComponentPositions([1])[0])).toBe(true);
    applyPose(new Matrix4().makeTranslation(.3, 0, 0));
    expect(binding.selection().pick(ray)).toBe(Infinity);
    expect(Number.isNaN(binding.getComponentPositions([0])[0])).toBe(true);
    expect(binding.getComponentPositions([0], true)[0]).toBeCloseTo(.3);
    appearance.dispose(); edit.dispose(); binding.dispose(); transforms.dispose(); mesh.dispose();
  });
});
