import { expect, it } from "vitest";
import { baseChannels, defaultAnimation, morphChannelLabel, evaluateSceneAnimation, writeChannel } from "../src/animation.ts";
import { prepareTransformAnimationEdit } from "../src/animation-edit.ts";
import { createMeshPrimitive, findMeshShape } from "../src/mesh-modeling.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { emptyScene } from "../src/scene-document.ts";
import { createConstraint, evaluateConstraints } from "../src/constraints.ts";
import { applyTransformPoseDraft, PoseDrafts } from "../src/pose-drafts.ts";

function fixture() {
  const store = createSceneStore(emptyScene());
  const source = createMeshPrimitive(store, "cube"), target = createMeshPrimitive(store, "cube");
  const doc = store.getState().document, shape = findMeshShape(doc, target)!;
  const morphTargets = [{ name: "Smile", weight: .2, deltas: Object.fromEntries(shape.vertices.map(v => [v.id, [0, 0, .1] as [number, number, number]])) }];
  const next = { ...doc, nodes: { ...doc.nodes, [shape.id]: { ...shape, morphTargets } }, animation: {
    ...defaultAnimation(), tracks: [{ id: "smile", targetId: target, channel: "morph.0" as const, keys: [
      { id: "begin", time: 0, value: .2, interpolation: "linear" as const, tangentMode: "auto" as const },
      { id: "end", time: 10, value: .8, interpolation: "linear" as const, tangentMode: "auto" as const },
    ] }],
  } };
  return { doc: next, source, target };
}

it("retains animated blend shapes through object transform edits and constraint evaluation", () => {
  const { doc, source, target } = fixture();
  const pose = evaluateSceneAnimation(doc, 5).get(target)!;
  const editedPose = writeChannel(pose, "position.x", 3);
  expect(editedPose.morphWeights).toEqual([.5]);
  expect(editedPose.morphWeights).not.toBe(pose.morphWeights);
  const edited = prepareTransformAnimationEdit(doc, target, editedPose, 5, false);
  const store = createSceneStore(edited);
  createConstraint(store, "point", source, target, false);
  const evaluated = evaluateSceneAnimation(store.getState().document, 5);
  evaluateConstraints(store.getState().document, evaluated);
  expect(evaluated.get(target)!.morphWeights).toEqual([.5]);
});

it("copies blend shape weights when preserving unkeyed pose drafts", () => {
  const { doc, target } = fixture(), drafts = new PoseDrafts();
  const pose = evaluateSceneAnimation(doc, 5).get(target)!;
  const retained = drafts.preserveAcrossEdit(doc, new Map([[target, pose]]), [], () => ({ ...doc }));
  expect(retained.get(target)!.morphWeights).toEqual([.5]);
  retained.get(target)!.morphWeights![0] = .9;
  expect(pose.morphWeights).toEqual([.5]);
});

it("indexes blend shape defaults once per immutable scene revision", () => {
  const { doc, source, target } = fixture();
  let traversals = 0;
  const revision = { ...doc, nodes: new Proxy(doc.nodes, { ownKeys(nodes) { traversals++; return Reflect.ownKeys(nodes); } }) };
  for (let i = 0; i < 100; i++) { baseChannels(revision, source); baseChannels(revision, target); }
  expect(traversals).toBe(1);
  const shape = findMeshShape(doc, target)!;
  const updated = { ...doc, nodes: { ...doc.nodes, [shape.id]: { ...shape, morphTargets: [{ ...shape.morphTargets![0], weight: .7 }] } } };
  expect(baseChannels(updated, target).morphWeights).toEqual([.7]);
  expect(baseChannels(doc, target).morphWeights).toEqual([.2]);
});

it("shows new static blend shape edits while retaining an unkeyed transform draft", () => {
  const { doc, target } = fixture();
  const staticDoc = { ...doc, animation: undefined }, shape = findMeshShape(staticDoc, target)!;
  const drafts = new PoseDrafts(), draft = writeChannel(evaluateSceneAnimation(staticDoc, 0).get(target)!, "position.x", 4);
  const next = { ...staticDoc, nodes: { ...staticDoc.nodes, [shape.id]: { ...shape, morphTargets: [{ ...shape.morphTargets![0], weight: .9 }] } } };
  const retained = drafts.preserveAcrossEdit(staticDoc, new Map([[target, draft]]), [], () => next);
  const evaluated = evaluateSceneAnimation(next, 0).get(target)!;
  const displayed = applyTransformPoseDraft(evaluated, retained.get(target)!);
  expect(displayed.position[0]).toBe(4);
  expect(displayed.morphWeights).toEqual([.9]);
  expect(displayed.morphWeights).not.toBe(evaluated.morphWeights);
  expect(draft.morphWeights).toEqual([.2]);
  expect(applyTransformPoseDraft({ ...evaluated, morphWeights: undefined }, draft).morphWeights).toBeUndefined();
});


it("names facial curves by mesh or converted splat target and retains the channel index", () => {
  const { doc, target } = fixture();
  expect(morphChannelLabel(doc, target, "morph.0")).toBe("Smile (morph.0)");
  const shape = findMeshShape(doc, target)!;
  const converted = { ...doc, nodes: { ...doc.nodes, [shape.id]: {
    type: "splatShape" as const, id: shape.id, name: "Face", parentId: target, assetId: "face", offset: [0,0,0] as [number,number,number],
    morphTargets: [{ name: "Smile left", weight: 0 }, { name: "Smile left", weight: 0 }],
  } } };
  expect(morphChannelLabel(converted, target, "morph.1")).toBe("Smile left (morph.1)");
});
