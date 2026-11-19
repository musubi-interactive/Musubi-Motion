import { expect,it } from "vitest";
import type { CleanupContext } from "../src/skin-weight-smoothing.ts";
import { previewWeightCleanup } from "../src/skin-weight-mirror.ts";
it("reflects nearest bind-space originals across the requested plane, swaps joint pairs and reports unmatched targets",async()=>{
  const points=[-1,-2,0,1.02,1.02,3], original=points.map((_,i)=>[{jointId:"held",weight:.25},{jointId:i===3?"right":"left",weight:.75}]);
  const context:CleanupContext={count:points.length,restPosition:i=>[0,points[i],0],getWeights:i=>original[i],locked:new Set(["held"])};
  const op = {kind:"mirror" as const,axis:1 as const,direction:1 as const,radius:.05,pairs:new Map([["right","left"],["left","right"]])};
  const result=await previewWeightCleanup(context,op,()=>false);
  expect(result.matched).toBe(1);expect(result.unmatched).toBe(1);expect(result.changes.size).toBe(0);
  // A distance tie picks the lower original index. Changing its row transfers only into the opposite side.
  original[3]=[{jointId:"right",weight:.45},{jointId:"left",weight:.5},{jointId:"held",weight:.05}];
  const changed=await previewWeightCleanup(context,op,()=>false);
  expect([...changed.changes.keys()]).toEqual(["0"]);const row=changed.changes.get("0")!;
  expect(row.find(r=>r.jointId==="held")!.weight).toBe(.25);
  expect(row.find(r=>r.jointId==="left")!.weight).toBeCloseTo(.45/.95*.75);
  expect(original[0]).toEqual([{jointId:"held",weight:.25},{jointId:"left",weight:.75}]);
});
