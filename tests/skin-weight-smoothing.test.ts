import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { createSceneStore } from "../src/scene-store.ts";
import type { SplatShapeNode, Vec3 } from "../src/scene-document.ts";
import { allocateSkinRow, type CleanupContext } from "../src/skin-weight-smoothing.ts";
import { previewWeightCleanup } from "../src/skin-weight-mirror.ts";
import { commitWeightRows, setInfluenceLock, editSkinWeight } from "../src/skin-weights.ts";

it("smooths an exact region from immutable neighboring rows, preserves held weights and survives undo and archive reopen", async () => {
  const opened = await decodeProject(new Uint8Array(await readFile("examples/skin-cleanup-study.msb")));
  const store = createSceneStore(opened.scene);
  const shape = () => store.getState().document.nodes["character-shape"] as SplatShapeNode;
  const b = shape().binding!, points: Vec3[] = [[-1.4,0,0],[-1.575,0,-1],[-.65,0,0],[.65,0,0],[1.4,0,0],[0,.8,0],[-1.4,.12,0]];
  setInfluenceLock(store, shape().id, "spine",true);
  const context: CleanupContext = {count:7,locked:new Set(["spine"]),getWeights:i=>b.weights!.overrides[i],restPosition:i=>points[i]};
  const before = store.getState().document;
  const result = await previewWeightCleanup(context,{kind:"smooth",radius:.2,strength:.5,targets:[0,6]},()=>false);
  expect(store.getState().document).toBe(before);
  expect([...result.changes.keys()]).toEqual(["0","6"]);
  for (const row of result.changes.values()) {
    expect(row.find(v=>v.jointId==="spine")!.weight).toBe(.2);
    expect(row.find(v=>v.jointId==="left")!.weight).toBeCloseTo(.38,12);
  }
  commitWeightRows(store,shape().id,context,result.changes,"Smooth skin weights");
  const after=store.getState().document;
  expect(shape().binding!.weights!.overrides[2]).toBe(b.weights!.overrides[2]);
  store.temporal.getState().undo();expect(store.getState().document).toBe(before);
  store.temporal.getState().redo();expect(store.getState().document).toBe(after);
  const reopened = await decodeProject(await encodeProject(after,opened.files,opened.editor));
  expect((reopened.scene.nodes[shape().id] as SplatShapeNode).binding).toEqual(shape().binding);
  expect(()=>editSkinWeight(store,shape().id,[0],"spine",.3,context)).toThrow(/unlock/i);
  expect(()=>editSkinWeight(store,shape().id,[0],"left",.81,context)).toThrow(/locked/i);
});

it("rejects impossible allocation, nonpositive weights, oversized and canceled jobs",async()=>{
  const base = [{jointId:"held",weight:.5},{jointId:"open",weight:.5}];
  expect(()=>allocateSkinRow(base,new Map([["held",1]]),new Set(["held"]))).toThrow(/unlocked/);
  expect(()=>allocateSkinRow([],new Map(),new Set())).toThrow(/unbound/);
  const next=allocateSkinRow(base,new Map(["a","b","c","d","e"].map((id,i)=>[id,i+1])),new Set(["held"]));
  expect(next.map(r=>r.jointId)).toEqual(["held","e","d","c"]);
  const context:CleanupContext = {count:200001,getWeights:()=>base,restPosition:()=>[0,0,0],locked:new Set()};
  const op = {kind:"smooth" as const, radius:.1,strength:.5,targets:[0]};
  await expect(previewWeightCleanup(context,op,()=>false)).rejects.toThrow(/200,000/);
  await expect(previewWeightCleanup({...context,count:100},op,()=>true)).rejects.toThrow(/canceled/i);
});

it("retains the target when an all-held neighborhood supplies no free proportions", async()=>{
  const points:Vec3[]=[[0,0,0],[.1,0,0],[1,0,0],[1.1,0,0]];
  const rows=[[{jointId:"held",weight:.25},{jointId:"left",weight:.5},{jointId:"right",weight:.25}],
    [{jointId:"held",weight:1}], [{jointId:"left",weight:1}], [{jointId:"right",weight:1}]];
  const context:CleanupContext={count:4,locked:new Set(["held"]),getWeights:i=>rows[i],restPosition:i=>points[i]};
  const result=await previewWeightCleanup(context,{kind:"smooth",strength:1,radius:.2,targets:[0,2]},()=>false);
  expect(result.matched).toBe(2);expect([...result.changes.keys()]).toEqual(["2"]);expect(result.changes.get("2")).toEqual(rows[3]);
});
