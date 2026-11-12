import { describe, expect, it } from "vitest";
import { prepareAnimationLayerFlatten } from "../src/animation-layer-flatten.ts";
import { editingTracks, evaluateChannels, readChannel, replaceTracks, validateAnimation, type AnimationChannel, type AnimationLayer, type AnimationTrack, type CurveKey } from "../src/animation.ts";
import { encodeProject, decodeProject } from "../src/project-archive.ts";
import { addSplat, emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function key(time: number, value: number, settings: Partial<CurveKey> = {}): CurveKey {
  return { id: crypto.randomUUID(), time, value, interpolation: "linear", tangentMode: "auto", ...settings };
}

function track(channel: AnimationChannel, keys: CurveKey[], layerId?: string, targetId = "object"): AnimationTrack {
  return { id: crypto.randomUUID(), targetId, channel, keys, ...(layerId ? { layerId } : {}) };
}

function layer(id: string, settings: Partial<AnimationLayer> = {}): AnimationLayer {
  return { id, name: id, mode: "additive", weight: 1, mute: false, solo: false, locked: false, ...settings };
}

const merge = { layerIds: ["override", "additive", "zero", "visibility"], start: 0, end: 12, sampleBy: 2 };

function fixture() {
  const doc = addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "Object", [2, 0, 0], "object", "shape").document;
  doc.animation = {
    start: 0, end: 12, fps: 24, loop: true, activeLayerId: "override",
    layers: [
      layer("lower"),
      layer("additive", {
        weight: 0, weightTrack: { id: "weight", keys: [
          key(0, 0, { interpolation: "bezier", tangentMode: "fixed", outSlope: .04, outWeight: .5 }),
          key(12, .8, { tangentMode: "fixed", inSlope: 0, inWeight: .35 }),
        ] },
      }),
      layer("interleaved"),
      layer("override", { mode: "override", weight: .25 }),
      layer("zero", { weight: 0 }),
      layer("visibility", { weightTrack: { id: "visibility-weight", keys: [key(0, .45, { interpolation: "step" }), key(3.125, .7)] } }),
      layer("upper"),
    ],
    tracks: [
      track("position.x", [key(0, 2), key(12, 3)]),
      track("visibility", [key(0, 1)]),
      track("position.x", [key(0, 1), key(12, 5)], "lower"),
      track("position.y", [key(0, 20), key(12, 40)], "interleaved"),
      track("position.x", [key(0, 3), key(12, 6)], "additive"),
      track("rotation.z", [key(0, 250), key(12, 850)], "additive"),
      track("scale.x", [key(0, 1.5), key(12, 4)], "additive"),
      track("visibility", [key(0, 0), key(7.375, 1)], "visibility"),
      track("position.x", [key(0, 8, { interpolation: "step" }), key(4.375, 15), key(12, 24)], "override"),
      track("rotation.z", [key(0, -180), key(12, -720)], "override"),
      track("scale.x", [key(0, .2), key(12, .4)], "override"),
      track("position.z", [key(0, 800)], "zero"),
      track("position.x", [key(0, -2), key(12, 3)], "upper"),
      track("scale.x", [key(0, 1), key(12, 2)], "upper"),
      track("visibility", [key(0, 1), key(10, 0)], "upper"),
    ],
  };
  doc.animation.layers![6] = { ...doc.animation.layers![6], weight: .12 };
  validateAnimation(doc.animation, doc);
  return doc;
}

describe("Merge Layers", () => {
  it("preserves mixed weighted motion at integer and fractional check times and makes a single editable revision", async () => {
    const original = fixture();
    const store = createSceneStore(original);
    const preview = prepareAnimationLayerFlatten(original, merge);
    expect(store.getState().document).toBe(original);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    expect(preview.summary).toMatchObject({ layerCount: 4, curveCount: 4 });
    expect(preview.summary.maxAllowedFraction).toBeLessThanOrEqual(1);

    preview.commit(store);
    const baked = store.getState().document;
    const active = baked.animation!.activeLayerId;
    expect(baked.animation!.layers!.map(item => item.id)).toEqual(["lower", active, "interleaved", "upper"]);
    expect(baked.animation!.layers![0]).toBe(original.animation!.layers![0]);
    expect(baked.animation!.layers![2]).toBe(original.animation!.layers![2]);
    expect(baked.animation!.layers![3]).toBe(original.animation!.layers![6]);
    for (const retained of original.animation!.tracks.filter(item => !merge.layerIds.includes(item.layerId ?? "")))
      expect(baked.animation!.tracks.find(item => item.id === retained.id)).toBe(retained);

    const checkedTimes = [...Array.from({ length: 193 }, (_, index) => index / 16), 4.375 - 1e-8, 4.375 + 1e-8, 7.375 - 1e-8, 7.375 + 1e-8];
    const channels = ["position.x", "position.y", "position.z", "rotation.z", "scale.x", "visibility"] as const;
    for (const frame of checkedTimes) {
      const expected = evaluateChannels(original, "object", frame);
      const actual = evaluateChannels(baked, "object", frame);
      for (const channel of channels) {
        const baseline = readChannel(expected, channel);
        const delta = Math.abs(readChannel(actual, channel) - baseline);
        expect(delta, `${channel} at ${frame}`).toBeLessThanOrEqual(.0011 + Math.abs(baseline) * .000001);
      }
      expect(actual.visibility >= .5).toBe(expected.visibility >= .5);
    }
    const visibility = editingTracks(baked).find(item => item.channel === "visibility")!;
    expect(visibility.keys.every(item => item.interpolation === "step")).toBe(true);

    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(original);
    store.temporal.getState().redo();
    expect(store.getState().document).toBe(baked);

    const translation = editingTracks(baked).find(item => item.channel === "position.x")!;
    replaceTracks(store, [{ ...translation, keys: translation.keys.map((item, index) => index ? item : { ...item, value: item.value + 2 }) }]);
    const edited = store.getState().document;
    expect(evaluateChannels(edited, "object", 0).position[0]).toBeCloseTo(evaluateChannels(baked, "object", 0).position[0] + 2);
    const bytes = await encodeProject(edited, new Map(), { camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: .01, far: 100 }, time: .25 });
    const reopened = await decodeProject(bytes);
    expect(reopened.scene).toEqual(edited);
    expect(evaluateChannels(reopened.scene, "object", 4.375)).toEqual(evaluateChannels(edited, "object", 4.375));
  });

  it("preserves global solo state and handles a selected zero-weight solo layer", () => {
    const original = fixture();
    original.animation!.layers![1].solo = true;
    original.animation!.layers![4].solo = true;
    const store = createSceneStore(original);
    prepareAnimationLayerFlatten(original, merge).commit(store);
    const baked = store.getState().document;
    expect(baked.animation!.layers![1].solo).toBe(true);
    for (const frame of [0, .25, 1.75, 9.5, 12]) {
      const expected = evaluateChannels(original, "object", frame);
      const actual = evaluateChannels(baked, "object", frame);
      expect(actual.position[1]).toBe(0);
      expect(actual.position[2]).toBe(0);
      expect(actual.position[0]).toBeCloseTo(expected.position[0], 3);
      expect(actual.visibility >= .5).toBe(expected.visibility >= .5);
    }
  });

  it("rejects stale commits, invalid ranges, oversized work and overlapping unselected layers atomically", () => {
    const original = fixture();
    const store = createSceneStore(original);
    const prepared = prepareAnimationLayerFlatten(original, merge);
    const newer = { ...original };
    store.setState({ document: newer });
    expect(() => prepared.commit(store)).toThrow(/changed since preview/);
    const count = store.temporal.getState().pastStates.length;
    expect(() => prepareAnimationLayerFlatten(newer, { ...merge, start: 12 })).toThrow(/End after Start/);
    expect(() => prepareAnimationLayerFlatten(newer, { ...merge, sampleBy: .001 })).toThrow(/10,000/);
    expect(() => prepareAnimationLayerFlatten(newer, { ...merge, end: 7000, sampleBy: 1 })).toThrow(/25,000/);
    const overlap = fixture();
    overlap.animation!.tracks.push(track("position.x", [key(0, 2)], "interleaved"));
    expect(() => prepareAnimationLayerFlatten(overlap, merge)).toThrow(/unselected layer/);
    overlap.animation!.layers![1].locked = true;
    expect(() => prepareAnimationLayerFlatten(overlap, merge)).toThrow(/Unlock/);
    expect(store.getState().document).toBe(newer);
    expect(store.temporal.getState().pastStates).toHaveLength(count);
  });

  it("rejects affected Set Driven Key, enabled IK and constraint interactions", () => {
    const doc = fixture();
    doc.drivenKeys = [{
      id: "sdk", driver: { targetId: "object", channel: "position.x" }, driven: { targetId: "object", channel: "rotation.x" }, keys: [key(0, 0)],
    }];
    expect(() => prepareAnimationLayerFlatten(doc, merge)).toThrow(/Set Driven Key/);
    doc.drivenKeys = [];
    doc.joints = [{ id: "root", name: "Root", parentId: null, position: [0, 0, 0] }, { id: "end", name: "End", parentId: "root", position: [1, 0, 0] }];
    doc.ikHandles = [{ id: "ik", name: "IK", rootId: "root", endId: "end", target: [1, 0, 0], enabled: true, iterations: 5, blend: 1, targetControl: { objectId: "object", offset: [0, 0, 0] } }];
    expect(() => prepareAnimationLayerFlatten(doc, merge)).toThrow(/enabled IK/);
    doc.ikHandles = [];
    doc.constraints = [{ id: "constraint", name: "Constraint", type: "point", sourceId: "object", targetId: "root", enabled: true, maintainOffset: false, offset: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }];
    expect(() => prepareAnimationLayerFlatten(doc, merge)).toThrow(/enabled constraint/);
  });

  it("rejects unsampled late crossings in captured discrete curves and preserves continuous retained visibility", () => {
    const original = fixture();
    original.customAttributes = { object: [{ id: "choice", name: "Choice", type: "boolean", keyable: true, default: 0, value: 0 }] };
    original.animation!.tracks.push(track("custom.choice", [key(0, 1, { interpolation: "step" })], "additive"));
    expect(() => prepareAnimationLayerFlatten(original, merge)).toThrow(/Boolean.*continuous layer weight/);
    original.animation!.tracks.pop();

    const lateWeight = { id: "late-weight", keys: [key(0, .4999), key(1, .500001)] };
    const range = { layerIds: ["additive", "override"], start: 0, end: 1, sampleBy: 1 };
    original.animation!.layers = [layer("additive", { weightTrack: lateWeight }), layer("override")];
    original.animation!.tracks = [track("visibility", [key(0, 0)], "additive")];
    const store = createSceneStore(original);
    expect(() => prepareAnimationLayerFlatten(original, range)).toThrow(/Visibility.*continuous layer weight/);
    expect(store.getState().document).toBe(original);
    expect(store.temporal.getState().pastStates).toHaveLength(0);

    original.animation!.layers = [layer("additive"), layer("override"), layer("upper", { weightTrack: lateWeight })];
    original.animation!.tracks = [track("visibility", [key(0, 1)], "additive"), track("visibility", [key(0, 0)], "upper")];
    validateAnimation(original.animation!, original);
    prepareAnimationLayerFlatten(original, range).commit(store);
    const baked = store.getState().document;
    for (const frame of [0, .25, .75, .99, .9901, .9999, 1])
      expect(evaluateChannels(baked, "object", frame).visibility).toBe(evaluateChannels(original, "object", frame).visibility);
  });

  it("samples compressed weighted Bezier extrema between regular probes", () => {
    const original = fixture();
    original.animation!.layers = [layer("additive"), layer("override")];
    original.animation!.tracks = [track("position.x", [
      key(0, 0, { interpolation: "bezier", tangentMode: "fixed", outWeight: .000001, outSlope: .011 / 3 / .000001 }),
      key(1, 0, { tangentMode: "fixed", inWeight: 1, inSlope: 0 }),
    ], "additive")];
    const store = createSceneStore(original);
    prepareAnimationLayerFlatten(original, { layerIds: ["additive", "override"], start: 0, end: 1, sampleBy: 1 }).commit(store);
    const baked = store.getState().document;
    expect(editingTracks(baked)[0].keys.length).toBeGreaterThan(2);
    const expected = evaluateChannels(original, "object", .037).position[0];
    const actual = evaluateChannels(baked, "object", .037).position[0];
    expect(Math.abs(actual - expected)).toBeLessThan(.001);
  });
});
