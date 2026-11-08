import { constraintWorldMatrices } from "../src/constraints.ts";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { evaluateSceneAnimation } from "../src/animation.ts";
import { evaluateDrivenKeys } from "../src/driven-keys.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { addSplat, emptyScene } from "../src/scene-document.ts";
import { createMeshPrimitive } from "../src/mesh-modeling.ts";
import { addCustomAttribute, attributesFor } from "../src/custom-attributes.ts";

describe("portable custom attributes", () => {
  it("saves/reopens a shapeless group with child mesh and splat preserving world transforms", async () => {
    const store=createSceneStore(emptyScene()),mesh=createMeshPrimitive(store,"cube");
    const splat=addSplat(store.getState().document,{id:"group-splat-asset",kind:"procedural",generator:"knot-v1"},"ChildSplat",[0,0,0]);
    const doc=structuredClone(splat.document),group="group";
    doc.nodes[group]={id:group,type:"transform",name:"Group",parentId:null,rotationOrder:"XYZ",position:[3,0,0],rotation:[0,0,0],scale:[1,1,1]};
    for(const child of [mesh,splat.id]) {const node=doc.nodes[child];if(node.type==="transform"){node.parentId=group;node.position=[2,0,0];}}
    doc.rootIds=[group];store.setState({document:doc,editLabel:"Group fixture"});addCustomAttribute(store,group,{name:"curl",default:0,keyable:true,locked:false});
    const editor={camera:{position:[8,3,8] as [number,number,number],target:[4,0,0] as [number,number,number],fov:42,near:.01,far:1000},time:0};
    const reopened=(await decodeProject(await encodeProject(store.getState().document,new Map(),editor))).scene;
    for(const id of [mesh,splat.id]) expect(constraintWorldMatrices(reopened).get(id)!.elements[12]).toBe(5);
    expect(reopened.nodes[mesh].parentId).toBe(group);expect(attributesFor(reopened,group)).toHaveLength(1);validateScene(reopened);
  });
  it("reopens the original NURBS curl rig offline and evaluates random/backwards frames", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("../examples/custom-attributes-sdk.msb", import.meta.url)));
    const project = await decodeProject(bytes), doc = project.scene;
    const controller = Object.values(doc.nodes).find(node => node.name === "CurlControl")!;
    expect(attributesFor(doc,controller.id)[0]).toMatchObject({name:"curl",default:0,value:0,min:0,max:10,keyable:true,locked:false});
    const snapshot = JSON.stringify(doc), reopened = await decodeProject(await encodeProject(doc, new Map(), project.editor));
    expect(reopened.scene).toEqual(doc);
    for (const frame of [48,0,12,24,3.25,36,0]) {
      const poses = evaluateSceneAnimation(reopened.scene, frame); evaluateDrivenKeys(reopened.scene, poses);
      expect(poses.get("middle")!.rotation[2]).toBeCloseTo((frame<=24?frame:48-frame)/24*90);
    }
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
  it("rejects invalid custom records, missing time/SDK references before any store replacement", async () => {
    const project = await decodeProject(new Uint8Array(readFileSync(new URL("../examples/custom-attributes-sdk.msb", import.meta.url))));
    const store = createSceneStore(project.scene), before = store.getState().document;
    for(const mutate of [(doc:typeof before)=>{doc.customAttributes={missing:[Object.values(doc.customAttributes!)[0][0]]};}, (doc:typeof before)=>{Object.values(doc.customAttributes!)[0][0].default=Infinity;}, (doc:typeof before)=>{Object.values(doc.customAttributes!)[0].length=0;}]) {
      const invalid=structuredClone(before); mutate(invalid);
      expect(()=>validateScene(invalid)).toThrow(); await expect(encodeProject(invalid,new Map(),project.editor)).rejects.toThrow(); expect(store.getState().document).toBe(before);
    }
  });
});
