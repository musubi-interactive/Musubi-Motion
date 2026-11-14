import { readFile } from "node:fs/promises";
import { Bone, Group, QuaternionKeyframeTrack, VectorKeyframeTrack } from "three";
import { describe, expect, it } from "vitest";
import { defaultAnimation, evaluateChannels, type CurveKey } from "../src/animation.ts";
import { importFBX } from "../src/fbx-import.ts";
import {
  commitMixamoTake, inspectMixamoMapping, inspectMixamoSource, loadMixamoSource, mixamoBoneRole,
  mixamoPreviewPose, stageMixamoTake, stageMixamoTakeAsync,
} from "../src/mixamo-import.ts";
import { decodeProject, encodeProject, type EditorSnapshot } from "../src/project-archive.ts";
import { emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

async function fixture(name: string) {
  return new File([await readFile(new URL(`../examples/motion/${name}.fbx`, import.meta.url))], `${name}.fbx`);
}

async function loadFixture() {
  const [source, rig] = await Promise.all([
    fixture("motion-takes").then(loadMixamoSource),
    fixture("matching-rig").then(file => importFBX(file, emptyScene())),
  ]);
  return { source, doc: rig.document, root: rig.jointIds[0] };
}

const key = (id: string, time: number, value: number): CurveKey => ({ id, time, value, interpolation: "bezier", tangentMode: "auto" });
const editor: EditorSnapshot = { camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45, near: .01, far: 500 }, time: 0 };

describe("Mixamo motion import", () => {
  it("reads and selects multiple original takes, preserving namespaces and source root channels", async () => {
    const { source, doc, root } = await loadFixture();
    expect(source.takes.map(take => take.name)).toEqual(["Arm Sweep", "Root Travel"]);
    expect(source.bones[0].name).toBe("shot:mixamorig2:Hips");
    expect(source.bones[0].bone.name).toBe("shotmixamorig2Hips");
    expect(source.unitScale).toBe(100);
    expect(mixamoBoneRole("MixamoRig3_LeftForeArm")).toBe("leftforearm");
    expect(mixamoBoneRole("leftForeArm")).toBe("leftforearm");
    const mapping = inspectMixamoMapping(source, doc, root);
    expect(mapping.valid).toBe(true);
    expect(mapping.rows).toHaveLength(22);
    expect(mapping.rows.every(row => row.target?.name.startsWith("mixamorig"))).toBe(true);
    const before = JSON.stringify(doc);
    const arm = doc.joints!.find(joint => joint.name === "mixamorigLeftArm")!;
    const first = stageMixamoTake(source, 0, doc, root);
    const second = stageMixamoTake(source, 1, doc, root);
    expect(first.name).toBe("Arm Sweep");
    expect(second.name).toBe("Root Travel");
    expect([second.start, second.end]).toEqual([0, 24]);
    expect(evaluateChannels(first.document, arm.id, 12).rotation[2]).toBeCloseTo(42, 4);
    expect(evaluateChannels(second.document, arm.id, 12).rotation[2]).toBe(0);
    expect(evaluateChannels(second.document, root, 7.5).position[2]).toBeCloseTo(.1875, 6);
    expect(evaluateChannels(second.document, root, 24).position[0]).toBeCloseTo(.2, 6);
    expect(mixamoPreviewPose(second, 24)[0].position.z).toBeCloseTo(.6, 6);
    expect(source.bones[0].bone.position.toArray()).toEqual([0, .9, 0]);
    expect(JSON.stringify(doc)).toBe(before);
    expect(second.document.joints).toBe(doc.joints);
  });

  it("permits an explicit matching target assignment and accounts for static joint orientation", async () => {
    const { source, doc, root } = await loadFixture();
    const arm = doc.joints!.find(joint => joint.name === "mixamorigLeftArm")!;
    const edited = { ...doc, joints: doc.joints!.map(joint => joint === arm
      ? { ...joint, name: "Shoulder Output", orientation: [0, 0, 25] as [number, number, number], rotation: [0, 0, -25] as [number, number, number] } : joint) };
    const sourceArm = source.bones.find(bone => bone.role === "leftarm")!;
    expect(inspectMixamoMapping(source, edited, root).rows.find(row => row.source === sourceArm)?.message).toBe("Missing target joint");
    const assigned = new Map([[sourceArm.id, arm.id]]);
    const candidate = stageMixamoTake(source, 0, edited, root, assigned);
    expect(evaluateChannels(candidate.document, arm.id, 0).rotation[2]).toBeCloseTo(-25, 5);
    expect(evaluateChannels(candidate.document, arm.id, 12).rotation[2]).toBeCloseTo(17, 4);
  });

  it("reports duplicate and missing humanoid roles, incompatible rests and mismatched parent topology", async () => {
    const { source, doc, root } = await loadFixture();
    const wrong = structuredClone(doc);
    wrong.joints![0].position = [0, 90, 0];
    const wrist = wrong.joints!.find(joint => joint.name === "mixamorigLeftHand")!;
    wrist.parentId = root;
    const neck = wrong.joints!.find(joint => joint.name === "mixamorigNeck")!;
    neck.rotation = [10, 0, 0];
    const messages = inspectMixamoMapping(source, wrong, root).rows.map(row => row.message);
    expect(messages).toContain("Rest offset differs (check rig and units)");
    expect(messages).toContain("Rest orientation differs (check axes and rig)");
    expect(messages).toContain("Target parent differs from source");
    expect(() => stageMixamoTake(source, 0, wrong, root)).toThrow(/highlighted/);
    const duplicate = new Bone();
    duplicate.name = "anotherHips";
    duplicate.userData.originalName = "another:Hips";
    source.bones[0].bone.add(duplicate);
    const rightHand = source.bones.find(bone => bone.role === "righthand")!;
    rightHand.bone.removeFromParent();
    const changed = inspectMixamoSource(source.group, source.name);
    const invalid = inspectMixamoMapping(changed, doc, root);
    expect(invalid.rows.filter(row => row.message === "Duplicate source role")).toHaveLength(2);
    expect(invalid.rows).toContainEqual({ role: "RightHand", message: "Missing required source joint" });
  });

  it("rejects ambiguous mixer names, unsupported scale pulses and invalid rotations before sampling", async () => {
    const { source, doc, root } = await loadFixture();
    const hip = source.bones[0].bone, take = source.takes[1];
    const duplicate = new Group();
    duplicate.name = hip.name;
    source.group.add(duplicate);
    expect(() => stageMixamoTake(source, 1, doc, root)).toThrow(/duplicate FBX binding/);
    duplicate.removeFromParent();
    take.tracks.push(new VectorKeyframeTrack(`${hip.name}.scale`, [0, .005, .01], [1, 1, 1, 2, 2, 2, 1, 1, 1]));
    expect(() => stageMixamoTake(source, 1, doc, root)).toThrow(/animated joint scaling/);
    take.tracks.pop();
    take.tracks.push(new QuaternionKeyframeTrack(`${hip.name}.quaternion`, [0], [0, 0, 0, 0]));
    expect(() => stageMixamoTake(source, 1, doc, root)).toThrow(/Invalid FBX rotation/);
  });

  it("gates imported curves, keeps prior tangents, and round-trips one undoable edit", async () => {
    const { source, doc, root } = await loadFixture();
    doc.animation = {
      ...defaultAnimation(), end: 30.5,
      tracks: [{ id: "previous", targetId: root, channel: "position.x", keys: [key("early", 0, .2), key("later", 17, .4)] }],
    };
    const stage = stageMixamoTake(source, 1, doc, root);
    expect([stage.start, stage.end]).toEqual([31, 55]);
    expect(stage.document.animation!.tracks[0]).toBe(doc.animation.tracks[0]);
    for (const time of [0, 5.5, 17, 30.9, 56]) {
      expect(evaluateChannels(stage.document, root, time)).toEqual(evaluateChannels(doc, root, time));
    }
    const store = createSceneStore(doc);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    commitMixamoTake(store, stage);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    expect(() => commitMixamoTake(store, stage)).toThrow(/scene changed/);
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo();
    expect(store.getState().document).toBe(stage.document);
    const reopened = await decodeProject(await encodeProject(store.getState().document, new Map(), editor));
    expect(reopened.files.size).toBe(0);
    expect(reopened.scene.animation).toEqual(stage.document.animation);
    expect(evaluateChannels(reopened.scene, root, 42.5)).toEqual(evaluateChannels(stage.document, root, 42.5));
  });

  it("cancels a pending preview without mixing the parsed source or touching history", async () => {
    const { source, doc, root } = await loadFixture();
    const before = source.bones.map(bone => bone.bone.matrixWorld.toArray());
    const store = createSceneStore(doc);
    const controller = new AbortController();
    const pending = stageMixamoTakeAsync(source, 1, doc, root, new Map(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(source.bones.map(bone => bone.bone.matrixWorld.toArray())).toEqual(before);
    expect(store.getState().document).toBe(doc);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    const next = await stageMixamoTakeAsync(source, 0, doc, root, new Map(), new AbortController().signal);
    expect(next.name).toBe("Arm Sweep");
    expect(source.bones.map(bone => bone.bone.matrixWorld.toArray())).toEqual(before);
  });

  it("rejects an empty source, unsupported file extensions, and active Solo before editing", async () => {
    await expect(loadMixamoSource(new File([], "empty.fbx"))).rejects.toThrow(/32 MiB/);
    await expect(loadMixamoSource(new File(["test"], "motion.txt"))).rejects.toThrow(/FBX motion file/);
    const { source, doc, root } = await loadFixture();
    const solo = { id: "solo", name: "Solo", mode: "override" as const, weight: 1, mute: false, solo: true, locked: false };
    const blocked = { ...doc, animation: { ...defaultAnimation(), layers: [solo] } };
    expect(() => stageMixamoTake(source, 0, blocked, root)).toThrow(/Turn off Solo/);
  });
});
