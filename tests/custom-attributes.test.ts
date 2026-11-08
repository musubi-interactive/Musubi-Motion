import { describe, expect, it } from "vitest";
import { emptyScene, addSplat, deleteSceneItems, type SceneDocument } from "../src/scene-document.ts";
import { renameObject, createSceneStore } from "../src/scene-store.ts";
import { createController } from "../src/controller-curves.ts";
import { addCustomAttribute, attributeOwner, attributesFor, customChannel, removeCustomAttribute, updateCustomAttribute, validateCustomAttributes } from "../src/custom-attributes.ts";
import { channelsForTarget, evaluateSceneAnimation, readChannel, setKeys, upsertTrack } from "../src/animation.ts";
import { drivenChannels, evaluateDrivenKeys, setDrivenKey } from "../src/driven-keys.ts";
import { mirrorJointSubtree } from "../src/joint-mirror.ts";
import { createMeshPrimitive } from "../src/mesh-modeling.ts";
import { createParticleEmitter } from "../src/particle-emitter.ts";
import { createIKHandle, deleteIKHandle } from "../src/ik.ts";
import { validateScene } from "../src/project-archive.ts";

const settings = { name: "curl", default: 0, min: 0, max: 10, keyable: true, locked: false };
function rig() {
  const doc = emptyScene(); doc.joints = [{ id: "root", name: "L_root", parentId: null, position: [0,0,0] }, { id: "tip", name: "L_tip", parentId: "root", position: [1,0,0] }];
  const store = createSceneStore(doc), control = createController(store, "circle");
  const id = addCustomAttribute(store, control, settings), attribute = attributesFor(store.getState().document, control)[0], channel = customChannel(attribute);
  return { store, control, id, channel };
}
describe("generic custom attributes", () => {
  it("uses custom SDK drivers on real mesh, splat, group, joint, particle and NURBS owners", () => {
    const {store,control}=rig();
    const mesh=createMeshPrimitive(store,"cube"), particle=createParticleEmitter(store,"omni");
    const splat=addSplat(store.getState().document,{id:"sdk-splat-asset",kind:"procedural",generator:"knot-v1"},"SDK Splat",[0,0,0]);
    const group="group"; const doc=splat.document;
    doc.nodes[group]={id:group,type:"transform",name:"Group",parentId:null,rotationOrder:"XYZ",position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]};doc.rootIds.push(group);
    store.setState({document:doc,editLabel:"Fixture objects"});
    for(const owner of [mesh,particle,splat.id,group,"root",control]) {
      if(owner!==control)addCustomAttribute(store,owner,settings);
      const channel=customChannel(attributesFor(store.getState().document,owner)[0]);
      setDrivenKey(store,{targetId:owner,channel},{targetId:"tip",channel:"rotation.x"},0,0);
      setDrivenKey(store,{targetId:owner,channel},{targetId:"tip",channel:"rotation.x"},10,90);
      updateCustomAttribute(store,owner,channel.slice(7),{value:5});
      const current=store.getState().document,poses=evaluateSceneAnimation(current,0);evaluateDrivenKeys(current,poses);expect(poses.get("tip")!.rotation[0]).toBe(45);
      store.setState({document:{...current,drivenKeys:[]},editLabel:"Next driver"});
    }
    validateScene(store.getState().document);
  });

  it("maps every current shape kind to its transform, with joint and IK direct ownership", () => {
    const { store, control } = rig();
    const doc = store.getState().document;
    for (const type of ["splatShape", "meshShape", "curveShape", "particleShape"] as const) {
      const shape = { id: type, type, parentId: control } as SceneDocument["nodes"][string];
      expect(attributeOwner({ ...doc, nodes: { ...doc.nodes, [type]: shape } }, type)).toBe(control);
    }
    addCustomAttribute(store, "root", settings);
    const handle = createIKHandle(store, "root", "tip", undefined, { solver: "ccd" });
    addCustomAttribute(store, handle, settings);
    expect(attributeOwner(store.getState().document, handle)).toBe(handle);
    expect(drivenChannels(store.getState().document, handle)).toHaveLength(1);
    expect(channelsForTarget(store.getState().document, handle)).toHaveLength(2);
    validateScene(store.getState().document);
    deleteIKHandle(store, handle); expect(store.getState().document.customAttributes?.[handle]).toBeUndefined();
  });
  it("supports splat/group owners independently, and atomic invalid additions and edits", () => {
    const doc = addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "splat", [0,0,0]).document;
    const store = createSceneStore(doc), shape = Object.values(doc.nodes).find(node => node.type === "splatShape")!;
    const id = addCustomAttribute(store, shape.id, settings), before = store.getState().document;
    for (const patch of [{ name: "curl" }, { name: "bad.name" }, { default: NaN }, { min: 11 }, { max: Infinity }, { default: 12 }]) {
      expect(() => addCustomAttribute(store, shape.id, { ...settings, ...patch })).toThrow(); expect(store.getState().document).toBe(before);
    }
    updateCustomAttribute(store, shape.id, id, { locked: true }); const locked = store.getState().document;
    expect(() => updateCustomAttribute(store, shape.id, id, { value: 4 })).toThrow(/unlock/i);
    expect(() => removeCustomAttribute(store, shape.id, id)).toThrow(/unlock/i); expect(store.getState().document).toBe(locked);
    updateCustomAttribute(store, shape.id, id, { locked: false }); updateCustomAttribute(store, shape.id, id, { value: 4 });
    store.temporal.getState().undo(); expect(attributesFor(store.getState().document, shape.id)[0].value).toBe(0);
    store.temporal.getState().redo(); expect(attributesFor(store.getState().document, shape.id)[0].value).toBe(4);
  });
  it("time/layer custom curl drives multiple joint rotations deterministically and preserves fallback", () => {
    const { store, control, channel } = rig();
    setDrivenKey(store, { targetId: control, channel }, { targetId: "root", channel: "rotation.z" }, 0, 0);
    setDrivenKey(store, { targetId: control, channel }, { targetId: "root", channel: "rotation.z" }, 10, 90);
    setDrivenKey(store, { targetId: control, channel }, { targetId: "tip", channel: "rotation.z" }, 0, 0);
    setDrivenKey(store, { targetId: control, channel }, { targetId: "tip", channel: "rotation.z" }, 10, 45);
    upsertTrack(store, { id: "curl-time", targetId: control, channel, keys: [{ id:"a", time:0,value:0,interpolation:"linear",tangentMode:"auto" }, { id:"b",time:24,value:10,interpolation:"linear",tangentMode:"auto" }] });
    const doc = store.getState().document, snapshot = JSON.stringify(doc);
    for (const time of [24,0,12,3.5,18,12,0]) {
      const poses = evaluateSceneAnimation(doc, time); evaluateDrivenKeys(doc, poses);
      expect(poses.get("root")!.rotation[2]).toBeCloseTo(time / 24 * 90);
      expect(poses.get("tip")!.rotation[2]).toBeCloseTo(time / 24 * 45);
    }
    expect(JSON.stringify(doc)).toBe(snapshot); expect(attributesFor(doc, control)[0].value).toBe(0);
    const layered = { ...doc, animation: { ...doc.animation!, layers:[{id:"override",name:"Override",mode:"override" as const,weight:.5,mute:false,solo:false,locked:false}], tracks:[...doc.animation!.tracks,{id:"layercurve",targetId:control,channel,layerId:"override",keys:[{id:"layerkey",time:0,value:10,interpolation:"linear" as const,tangentMode:"auto" as const}]}] } };
    expect(readChannel(evaluateSceneAnimation(layered,0).get(control)!, channel)).toBe(5);
  });
  it("respects non-keyable and saved locks across time/SDK authoring", () => {
    const {store,control,id,channel}=rig();updateCustomAttribute(store,control,id,{keyable:false});
    const before=store.getState().document;expect(()=>setKeys(store,[control],0,undefined,[channel])).toThrow(/not supported/);expect(store.getState().document).toBe(before);
    setDrivenKey(store,{targetId:control,channel},{targetId:"root",channel:"rotation.z"},0,0);
    updateCustomAttribute(store,control,id,{locked:true});const locked=store.getState().document;
    expect(()=>setDrivenKey(store,{targetId:control,channel},{targetId:"root",channel:"rotation.z"},10,90)).toThrow(/unlock/i);expect(store.getState().document).toBe(locked);
  });
  it("renames preserve IDs; referenced deletion is explicit, atomic and undoable", () => {
    const { store, control, id, channel } = rig();
    setKeys(store, [control], 0, undefined, [channel]); setDrivenKey(store, { targetId: control, channel }, { targetId: "root", channel: "rotation.z" }, 0, 0);
    updateCustomAttribute(store, control, id, { name:"grip" }); renameObject(store, control, "RenamedControl"); expect(store.getState().document.animation!.tracks[0].targetId).toBe(control); const before = store.getState().document;
    expect(() => removeCustomAttribute(store, control, id)).toThrow(/references/i); expect(store.getState().document).toBe(before);
    expect(() => updateCustomAttribute(store, control, id, { max: 11 })).toThrow(/references/i);
    removeCustomAttribute(store, control, id, true); expect(store.getState().document.animation!.tracks).toHaveLength(0); expect(store.getState().document.drivenKeys).toHaveLength(0);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    const deleted = deleteSceneItems(before, [control]); expect(deleted.customAttributes?.[control]).toBeUndefined(); expect(deleted.animation!.tracks).toHaveLength(0); expect(deleted.drivenKeys).toHaveLength(0); validateScene(deleted);
  });
  it("mirror duplication gives copied definitions new IDs and deliberately keeps curves on source", () => {
    const { store } = rig(); addCustomAttribute(store,"root",settings);
    const channel=customChannel(attributesFor(store.getState().document,"root")[0]);setKeys(store,["root"],0,undefined,[channel]);setDrivenKey(store,{targetId:"root",channel},{targetId:"tip",channel:"rotation.x"},0,0);
    const ids = mirrorJointSubtree(store,"root",{axis:"X",search:"L_",replace:"R_"});
    const doc=store.getState().document, source=attributesFor(doc,"root")[0], copy=attributesFor(doc,ids.get("root")!)[0];
    expect(copy).toEqual({...source,id:copy.id}); expect(copy.id).not.toBe(source.id); expect(doc.animation!.tracks.some(track=>track.targetId===ids.get("root"))).toBe(false);expect(doc.drivenKeys!.every(relation=>relation.driver.targetId==="root")).toBe(true);validateScene(doc);
  });
  it("rejects malformed owner/ID/name/value records and resource overflow", () => {
    const {store,control}=rig(), doc=store.getState().document;
    for (const map of [{missing:doc.customAttributes![control]}, {[control]:[{...doc.customAttributes![control][0],id:"__proto__"}]}, {[control]:Array.from({length:65},(_,i)=>({...doc.customAttributes![control][0],id:`id${i}`,name:`attr${i}`}))}]) expect(()=>validateCustomAttributes({...doc,customAttributes:map})).toThrow();
  });
});
