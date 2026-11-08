import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { evaluateSceneAnimation } from "../src/animation.ts";
import { evaluateDrivenKeys } from "../src/driven-keys.ts";
import { attributesFor } from "../src/custom-attributes.ts";

describe("portable discrete attributes",()=>{
  it("reopens original typed NURBS fixture with exact definitions/codes/keys/SDK and random backward states",async()=>{
    const project=await decodeProject(new Uint8Array(readFileSync(new URL("../examples/custom-types-sdk.msb",import.meta.url)))),doc=project.scene;
    const control=Object.values(doc.nodes).find(node=>node.type==="transform")!;
    expect(attributesFor(doc,control.id).map(item=>item.type)).toEqual(["enum","boolean"]);
    const before=JSON.stringify(doc),reopened=await decodeProject(await encodeProject(doc,new Map(),project.editor));expect(reopened.scene).toEqual(doc);
    for(const frame of [36,0,11.99,12,24,18,35.9,0]){const poses=evaluateSceneAnimation(reopened.scene,frame);evaluateDrivenKeys(reopened.scene,poses);expect(poses.get("middle")!.rotation[2]).toBe(frame<12?0:frame<24?90:frame<36?-30:0);}
    expect(JSON.stringify(doc)).toBe(before);
  });
  it("rejects invalid type/discrete keys/entry definitions before archive publication",async()=>{
    const project=await decodeProject(new Uint8Array(readFileSync(new URL("../examples/custom-types-sdk.msb",import.meta.url)))),doc=project.scene;
    for(const mutate of [(value:typeof doc)=>{Object.values(value.customAttributes!)[0][0].type="string" as never;},(value:typeof doc)=>{Object.values(value.customAttributes!)[0][0].entries![1].value=0;},(value:typeof doc)=>{value.animation!.tracks[0].keys[0].value=.5;},(value:typeof doc)=>{value.drivenKeys![0].keys[0].interpolation="linear";}]){const invalid=structuredClone(doc);mutate(invalid);expect(()=>validateScene(invalid)).toThrow();await expect(encodeProject(invalid,new Map(),project.editor)).rejects.toThrow();}
  });
  it("preserves existing numeric NURBS fixture without a format upgrade",async()=>{
    const project=await decodeProject(new Uint8Array(readFileSync(new URL("../examples/custom-attributes-sdk.msb",import.meta.url))));
    expect(Object.values(project.scene.customAttributes!)[0][0].type).toBeUndefined();const reopened=await decodeProject(await encodeProject(project.scene,new Map(),project.editor));expect(reopened.scene).toEqual(project.scene);
    const poses=evaluateSceneAnimation(reopened.scene,12);evaluateDrivenKeys(reopened.scene,poses);expect(poses.get("middle")!.rotation[2]).toBe(45);
  });
});
