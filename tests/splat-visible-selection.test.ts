import { expect,it } from "vitest";
import { OrthographicCamera, Matrix4 } from "three";
import { sceneDepthTest } from "../src/splat-depth.ts";
import { pickSplatComponents,pickSplatRegion } from "../src/splat-component-selection.ts";
import { createSkinBrushIndex } from "../src/skin-weight-brush.ts";
it("uses the same captured camera-axis depth for box, click, lasso and paint, retaining original IDs",async()=>{
  const bytes=new Uint8Array(4*4*4), packed=new DataView(bytes.buffer);
  for(let i=0;i<16;i++)packed.setFloat32(i*4,2,true);
  // Top-left origin converts to backend bottom-left. A zero/background pixel never passes.
  packed.setFloat32(12*4,0,true);
  const visible=sceneDepthTest(bytes,4,4);
  expect(visible(.01,.01,1)).toBe(false);expect(visible(1,.5,1)).toBe(false);expect(visible(.5,.5,2.0005)).toBe(true);
  const camera = new OrthographicCamera(-1,1,1,-1,.1,10);const positions=new Float32Array([0,0,-3,0,0,-2,.5,0,-2,NaN,0,-1]);
  const opt={componentCount:4,width:100,height:100,matrixWorld:new Matrix4(),camera,readPositions:()=>positions,depth:"scene-visible" as const,readDepth:async()=>visible};
  expect([...await pickSplatComponents({...opt,start:{x:50,y:50},end:{x:50,y:50}})]).toEqual([1]);
  expect([...await pickSplatComponents({...opt,start:{x:0,y:0},end:{x:99,y:99}})]).toEqual([1,2]);
  expect([...await pickSplatRegion(opt,(x,y)=>Math.abs(x-50)+Math.abs(y-50)<15)]).toEqual([1]);
  const index=await createSkinBrushIndex(opt),ids:number[]=[];index.query(0,0,99,99,id=>ids.push(id));expect(ids).toEqual([1,2]);
  let canceled=false;
  await expect(pickSplatRegion({...opt,readDepth:async()=>{canceled=true;return visible},cancelled:()=>canceled},()=>true)).rejects.toThrow(/cancel/i);
});
