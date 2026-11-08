import { mirrorJointSubtree } from "../src/joint-mirror.ts";
import { editCustomAttributeValue, keyCustomAttribute } from "../src/custom-attribute-keying.ts";
import { describe, it, expect } from "vitest";
import { createSceneStore } from "../src/scene-store.ts";
import { emptyScene, deleteSceneItems } from "../src/scene-document.ts";
import { createController } from "../src/controller-curves.ts";
import { addCustomAttribute, attributesFor, customChannel, updateCustomAttribute, validateCustomAttributes, copyCustomAttributes } from "../src/custom-attributes.ts";
import { makeEnumEntries } from "../src/custom-attribute-types.ts";
import { evaluateSceneAnimation, readChannel, setKeys, upsertTrack, defaultAnimation } from "../src/animation.ts";
import { setDrivenKey, evaluateDrivenKeys, upsertDrivenRelationship } from "../src/driven-keys.ts";
import { validateScene } from "../src/project-archive.ts";

function rig() {
  const doc=emptyScene();doc.joints=[{id:"joint",name:"Finger",parentId:null,position:[0,0,0]}];
  const store=createSceneStore(doc),control=createController(store,"circle"),choices=makeEnumEntries(["Relaxed","Grasp","Point"]);
  const mode=addCustomAttribute(store,control,{name:"mode",type:"enum",default:0,keyable:true,locked:false,...choices});
  const enabled=addCustomAttribute(store,control,{name:"enabled",type:"boolean",default:0,keyable:true,locked:false});
  return {store,control,mode,enabled,choices,modeChannel:`custom.${mode}` as const,boolChannel:`custom.${enabled}` as const};
}
const key=(id:string,time:number,value:number)=>({id,time,value,interpolation:"step" as const,tangentMode:"auto" as const});
describe("Boolean and Enum custom channels",()=>{
  it("keying one attribute preserves only valid unconsumed numeric/discrete drafts in the same scene",()=>{
    const {store,control,mode,enabled,modeChannel,boolChannel}=rig();
    const numeric=addCustomAttribute(store,control,{name:"curl",default:0,keyable:true,locked:false});
    const doc=store.getState().document,base=evaluateSceneAnimation(doc,0).get(control)!;
    const draft={...base,customValues:{[mode]:1,[enabled]:1,[numeric]:4}};
    const modeDef=attributesFor(doc,control).find(item=>item.id===mode)!,boolDef=attributesFor(doc,control).find(item=>item.id===enabled)!;
    const first=editCustomAttributeValue(store,control,modeDef,1,new Map([[control,{[numeric]:4}]]));
    const snapshots=editCustomAttributeValue(store,control,boolDef,1,first);
    snapshots.get(control)!.missing=2;snapshots.set("deleted-owner",{orphan:3});
    expect(snapshots.get(control)).toMatchObject({[mode]:1,[enabled]:1,[numeric]:4});
    const modeAttribute=attributesFor(doc,control).find(item=>item.id===mode)!;
    const retained=keyCustomAttribute(store,control,modeAttribute,0,draft,snapshots);
    expect(retained).toEqual(new Map([[control,{[enabled]:1,[numeric]:4}]]));
    const boolAttribute=attributesFor(store.getState().document,control).find(item=>item.id===enabled)!;
    keyCustomAttribute(store,control,boolAttribute,0,{...base,customValues:{...base.customValues,...retained.get(control)}},retained);
    const result=evaluateSceneAnimation(store.getState().document,0).get(control)!;expect(readChannel(result,modeChannel)).toBe(1);expect(readChannel(result,boolChannel)).toBe(1);expect(store.getState().document.customAttributes![control].find(item=>item.id===numeric)!.value).toBe(0);
    store.temporal.getState().undo();expect(store.getState().document.animation!.tracks).toHaveLength(1);store.temporal.getState().redo();expect(store.getState().document.animation!.tracks).toHaveLength(2);
  });
  it("gives a changed visible value one undo revision even when its authored fallback already matches",()=>{
    const {store,control,enabled,boolChannel}=rig();updateCustomAttribute(store,control,enabled,{value:1});
    upsertTrack(store,{id:"off-time",targetId:control,channel:boolChannel,keys:[key("held-off",0,0)]});
    const before=store.getState().document,attribute=attributesFor(before,control).find(item=>item.id===enabled)!,history=store.temporal.getState().pastStates.length;
    const displayed=readChannel(evaluateSceneAnimation(before,0).get(control)!,boolChannel);expect(displayed).toBe(0);
    const retained=editCustomAttributeValue(store,control,attribute,1,new Map(),displayed),after=store.getState().document;
    expect(retained.get(control)![enabled]).toBe(1);expect(after).not.toBe(before);expect(after.animation).toBe(before.animation);expect(after.customAttributes).toBe(before.customAttributes);expect(store.temporal.getState().pastStates).toHaveLength(history+1);
    store.temporal.getState().undo();expect(store.getState().document).toBe(before);store.temporal.getState().redo();expect(store.getState().document).toBe(after);expect(after.animation!.tracks[0].keys[0].value).toBe(0);
  });
  it("time/SDK evaluation is discrete, deterministic backwards/random and never mutates authored fallback",()=>{
    const {store,control,modeChannel,boolChannel}=rig();
    upsertTrack(store,{id:"enum-time",targetId:control,channel:modeChannel,keys:[key("e0",0,0),key("e1",10,1),key("e2",20,2)]});
    upsertTrack(store,{id:"bool-time",targetId:control,channel:boolChannel,keys:[key("b0",0,0),key("b1",12,1)]});
    for(const [input,output] of [[0,0],[1,90],[2,30]])setDrivenKey(store,{targetId:control,channel:modeChannel},{targetId:"joint",channel:"rotation.z"},input,output);
    const doc=store.getState().document,before=JSON.stringify(doc);
    for(const frame of [24,0,9.9,10,12,19,20,3,10,0]){const poses=evaluateSceneAnimation(doc,frame);evaluateDrivenKeys(doc,poses);const mode=frame<10?0:frame<20?1:2;expect(readChannel(poses.get(control)!,modeChannel)).toBe(mode);expect(readChannel(poses.get(control)!,boolChannel)).toBe(frame<12?0:1);expect(poses.get("joint")!.rotation[2]).toBe([0,90,30][mode]);}
    expect(JSON.stringify(doc)).toBe(before);expect(attributesFor(doc,control).map(item=>item.value)).toEqual([0,0]);
  });
  it("rename/reorder keeps permanent codes and time/SDK meaning, rejects referenced entry removal atomically",()=>{
    const {store,control,mode,modeChannel,choices}=rig();
    upsertTrack(store,{id:"enum",targetId:control,channel:modeChannel,keys:[key("k",0,1)]});
    setDrivenKey(store,{targetId:control,channel:modeChannel},{targetId:"joint",channel:"rotation.x"},1,45);
    updateCustomAttribute(store,control,mode,{entries:[{...choices.entries[2],name:"Aim"},choices.entries[0],{...choices.entries[1],name:"Grip"}]});
    const doc=store.getState().document;const poses=evaluateSceneAnimation(doc,0);evaluateDrivenKeys(doc,poses);expect(poses.get("joint")!.rotation[0]).toBe(45);expect(attributesFor(doc,control)[0].entries![2].id).toBe(choices.entries[1].id);
    expect(()=>updateCustomAttribute(store,control,mode,{entries:choices.entries.filter(entry=>entry.value!==1)})).toThrow(/references/);expect(store.getState().document).toBe(doc);
    expect(()=>updateCustomAttribute(store,control,mode,{entries:choices.entries.map(entry=>({...entry,value:entry.value+1})),nextValue:4})).toThrow(/permanent/);expect(store.getState().document).toBe(doc);
  });
  it("categorical layers switch at .5 and exact inverse keying rejects masked or low influence states",()=>{
    const {store,control,modeChannel}=rig(),doc=store.getState().document;
    const layer={id:"layer",name:"State",mode:"additive" as const,weight:.49,mute:false,solo:false,locked:false};
    const layered={...doc,animation:{...defaultAnimation(),layers:[layer],activeLayerId:layer.id,tracks:[{id:"state",targetId:control,channel:modeChannel,layerId:layer.id,keys:[key("state-key",0,2)]}]}};
    expect(readChannel(evaluateSceneAnimation(layered,0).get(control)!,modeChannel)).toBe(0);
    const active={...layered,animation:{...layered.animation,layers:[{...layer,weight:.5}]}};expect(readChannel(evaluateSceneAnimation(active,0).get(control)!,modeChannel)).toBe(2);
    store.setState({document:layered,editLabel:"Layer fixture"});expect(()=>setKeys(store,[control],0,undefined,[modeChannel])).toThrow(/no influence/);expect(store.getState().document).toBe(layered);
    store.setState({document:active,editLabel:"Active layer"});setKeys(store,[control],8,undefined,[modeChannel]);expect(store.getState().document.animation!.tracks[0].keys[1]).toMatchObject({value:2,interpolation:"step"});
  });
  it("forces authored Set Key and SDK Step and rejects imported non-Step or impossible choices",()=>{
    const {store,control,enabled,boolChannel}=rig();updateCustomAttribute(store,control,enabled,{value:1});setKeys(store,[control],0,undefined,[boolChannel]);expect(store.getState().document.animation!.tracks[0].keys[0].interpolation).toBe("step");
    const before=store.getState().document;expect(()=>upsertTrack(store,{id:before.animation!.tracks[0].id,targetId:control,channel:boolChannel,keys:[{...key("badk",2,1),interpolation:"linear"}]})).toThrow(/Step/);expect(store.getState().document).toBe(before);
    expect(()=>updateCustomAttribute(store,control,enabled,{value:.5})).toThrow(/choice/);expect(()=>updateCustomAttribute(store,control,enabled,{type:"float"})).toThrow(/references/);
    setDrivenKey(store,{targetId:control,channel:boolChannel},{targetId:"joint",channel:"rotation.z"},0,0);setDrivenKey(store,{targetId:control,channel:boolChannel},{targetId:"joint",channel:"rotation.z"},1,90);
    const relation=store.getState().document.drivenKeys![0];expect(relation.keys.every(key=>key.interpolation==="step")).toBe(true);expect(()=>upsertDrivenRelationship(store,{...relation,keys:relation.keys.map(key=>({...key,interpolation:"linear"}))})).toThrow(/Step/);
  });
  it("supports typed SDK outputs and actual mirror/object lifecycle without aliasing enum IDs",()=>{
    const {store,control,enabled,boolChannel,choices}=rig();
    setDrivenKey(store,{targetId:control,channel:"position.x"},{targetId:control,channel:boolChannel},0,0);setDrivenKey(store,{targetId:control,channel:"position.x"},{targetId:control,channel:boolChannel},1,1);
    const before=store.getState().document;for(const value of [.2,.9,1]){const node=before.nodes[control];if(node.type!=="transform")throw Error("fixture");const doc={...before,nodes:{...before.nodes,[control]:{...node,position:[value,0,0] as [number,number,number]}}};const poses=evaluateSceneAnimation(doc,0);evaluateDrivenKeys(doc,poses);expect(readChannel(poses.get(control)!,boolChannel)).toBe(value<1?0:1);}
    addCustomAttribute(store,"joint",{name:"mirrorMode",type:"enum",default:0,keyable:true,locked:false,...choices});const ids=mirrorJointSubtree(store,"joint",{axis:"X",search:"Finger",replace:"MirrorFinger"});const mirrored=store.getState().document.customAttributes![ids.get("joint")!][0];expect(mirrored.entries![0].id).not.toBe(choices.entries[0].id);expect(mirrored.entries!.map(item=>item.value)).toEqual([0,1,2]);const after=store.getState().document;store.temporal.getState().undo();expect(store.getState().document.customAttributes?.[ids.get("joint")!]).toBeUndefined();store.temporal.getState().redo();expect(store.getState().document).toBe(after);validateScene(after);
  });
  it("validates limits/locks/duplicate choices and mirror copies fresh IDs while preserving code meaning",()=>{
    const {store,control,mode,choices}=rig(),doc=store.getState().document;
    for(const patch of [{type:null as never},{entries:[choices.entries[0],choices.entries[0]]},{entries:[{...choices.entries[0],name:" "}]},{entries:[]},{nextValue:0},{min:0}])expect(()=>updateCustomAttribute(store,control,mode,patch)).toThrow();
    expect(store.getState().document).toBe(doc);updateCustomAttribute(store,control,mode,{locked:true});expect(()=>updateCustomAttribute(store,control,mode,{entries:[...choices.entries].reverse()})).toThrow(/Unlock/);
    const copied=copyCustomAttributes(doc,new Map([[control,"copy"]]))!.copy[0];expect(copied.id).not.toBe(mode);expect(copied.entries!.map(entry=>entry.value)).toEqual([0,1,2]);expect(copied.entries![0].id).not.toBe(choices.entries[0].id);
    const removed=deleteSceneItems(doc,[control]);expect(removed.customAttributes?.[control]).toBeUndefined();validateScene(removed);
  });
});
