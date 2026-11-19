import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Matrix3, Vector3, Quaternion } from "three";
import { decodeProject } from "../src/project-archive.ts";
import { addSplatExtraction } from "../src/splat-extraction.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { editingTracks, setKeys, moveKeys, deleteKeys, patchKeys, pasteKeys, copyKeys, scaleKeys, insertKey, evaluateCurve } from "../src/animation.ts";
import { rebindLattice } from "../src/splat-lattice-rebind.ts";
import { resizeSplatLattice, prepareSplatLattice, latticeSplatDeformer, type SplatLattice } from "../src/splat-lattice.ts";
import { sampleSplatDeformer, type SplatDeformer } from "../src/splat-deformers.ts";
import { selectedPointPose, transformSelectedPoints, latticePointGroup } from "../src/splat-point-selection.ts";

describe("PR43 curves in the native time editors", () => {
  it("keeps keys on duplicated splats independent of their source", async () => {
    const { scene } = await decodeProject(new Uint8Array(await readFile("examples/animated-splat-deformers.msb")));
    const source = scene.nodes["tower-shape"];
    if (source.type !== "splatShape") throw Error("source");
    const original = editingTracks(scene).find(t => t.id.includes('"lattice"'))!;
    const added = addSplatExtraction(scene, { shapeId: source.id, assetId: source.assetId, count: source.deformers![0].sourceCount }, Uint32Array.of(0, 1), 256);
    const store = createSceneStore(added.document);
    const copied = editingTracks(added.document).find(t => t.targetId === added.id && t.id.includes('"point.19.x"'))!;
    expect(copied.keys.map(k => k.id)).not.toEqual(original.keys.map(k => k.id));
    patchKeys(store, [copied.keys[0].id], { interpolation: "step" });
    const edited = editingTracks(store.getState().document);
    expect(edited.find(t => t.id === copied.id)!.keys[0].interpolation).toBe("step");
    expect(edited.find(t => t.id === original.id)!.keys[0].interpolation).toBe("linear");
  });
  it("shares selection, interpolation, shape-preserving inserts, mixed retiming, clipboard and atomic undo with object curves", async () => {
    const { scene } = await decodeProject(new Uint8Array(await readFile("examples/animated-splat-deformers.msb")));
    const store = createSceneStore(scene);
    const doc = () => store.getState().document;
    const track = () => editingTracks(doc()).find(t => t.id.includes('"lattice"'))!;
    expect(track().keys.map(k => k.interpolation)).toEqual(["linear", "linear", "linear"]);
    setKeys(store, ["tower"], 0, undefined, ["position.x"]);
    const regular = editingTracks(doc()).find(t => t.channel === "position.x")!;
    const before = doc();
    const selected = [regular.keys[0].id, track().keys[0].id];
    moveKeys(store, selected, 2);
    expect(track().keys[0].time).toBe(2);
    expect(editingTracks(doc()).find(t => t.channel === "position.x")!.keys[0].time).toBe(2);
    store.temporal.getState().undo(); expect(doc()).toBe(before);
    const clip = copyKeys(doc(), selected);
    const pasted = pasteKeys(store, clip, 9);
    expect(track().keys.map(k => k.time)).toContain(9);
    expect(doc().animation!.tracks.every(t => !t.id.startsWith("deformer."))).toBe(true);
    deleteKeys(store, pasted);
    patchKeys(store, track().keys.map(k => k.id), { tangentMode: "flat", interpolation: "bezier", outWeight: .66 });
    const original = track().keys, scalar = evaluateCurve(original, 7.3)!;
    insertKey(store, track().id, 8);
    expect(evaluateCurve(track().keys, 7.3)).toBeCloseTo(scalar, 10);
    const ids = track().keys.map(k => k.id); scaleKeys(store, ids, 2);
    expect(evaluateCurve(track().keys, 14.6)).toBeCloseTo(scalar, 10);
    const shape = doc().nodes["tower-shape"];
    if (shape.type !== "splatShape") throw Error("shape");
    const sampled = sampleSplatDeformer(shape.deformers!.find(d => d.id === "lattice")!, 14.6);
    expect(latticeSplatDeformer.controls(sampled.params as SplatLattice, 19)[0].value).toBeCloseTo(scalar, 10);
    expect(() => patchKeys(store, ids, { value: Infinity })).toThrow();
  });
});
describe("point groups and lattice degree changes", () => {
  const small = resizeSplatLattice([0, 0, 0], [2, 2, 2], [2, 3, 2]);
  const large = resizeSplatLattice(small.center, small.size, [4, 5, 3]);
  const entry: SplatDeformer = { id: "l", name: "Lattice", kind: "lattice", envelope: .8, sourceCount: 10, params: small,
    keys: [{ frame: 1, channel: "point.0.x", value: -1, interpolation: "bezier", tangentMode: "fixed", outSlope: .3, outWeight: .72 },
      { frame: 21, channel: "point.0.x", value: .8, tangentMode: "flat", inWeight: .2 },
      { frame: 4, channel: "point.2.x", value: -.7 }, { frame: 14, channel: "point.2.x", value: -1.2 },
      { frame: 7, channel: "envelope", value: .6 }] };
  const sample = (deformer: SplatDeformer, time: number) => {
    const pose = sampleSplatDeformer(deformer, time);
    const p = new Vector3(), j = new Matrix3();
    prepareSplatLattice(pose.params as SplatLattice)(new Vector3(-.37, .28, -.14), p, j, pose.envelope);
    return [...p.toArray(), ...j.elements];
  };
  it("elevates animated coefficients and lowers representable grids without changing offsets, velocities or covariance", () => {
    const elevated = rebindLattice(entry, large);
    const reduced = rebindLattice(elevated, small);
    for (const t of [-1, 1, 2.67, 4, 8.43, 13.99, 14, 14.5, 21, 31]) {
      const expected = sample(entry, t);
      for (const bound of [elevated, reduced]) sample(bound, t).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 8));
    }
  });
  it("refuses nonrepresentable reduction and changed bounds unless reset is explicitly requested", () => {
    const params = { ...large, offsets: large.offsets.map(p => [...p] as typeof p) };
    params.offsets[5][0] = 2;
    const source = { ...entry, params };
    expect(() => rebindLattice(source, small)).toThrow(/lower resolution/);
    expect(() => rebindLattice(entry, { ...large, size: [3, 3, 3] })).toThrow(/bind bounds/);
    expect(rebindLattice(source, small, true).keys).toEqual(entry.keys!.filter(k => k.channel === "envelope"));
    expect(source.params.offsets[5][0]).toBe(2);
  });
  it("pivots lattice rows and planes as a single selection around their local centroid", () => {
    const group = latticePointGroup(small.divisions, 0, 1, false);
    expect(group).toEqual([0, 2, 4]);
    expect(latticePointGroup(small.divisions, 0, 1, true)).toEqual([0, 1, 6, 7]);
    const adapter = latticeSplatDeformer.handle, pose = selectedPointPose(adapter, small, group);
    pose.position.add(new Vector3(.5, .2, .1)); pose.scale.y = 1.5;
    pose.rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), .5);
    const next = transformSelectedPoints(adapter, small, group, pose);
    expect(selectedPointPose(adapter, next, group).position.distanceTo(pose.position)).toBeLessThan(1e-10);
    expect(next.offsets[1]).toBe(small.offsets[1]);
  });
});
