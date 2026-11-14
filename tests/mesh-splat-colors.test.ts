import { expect, it, vi, afterEach } from "vitest";
import { Vector2 } from "three";
import { createMeshSplatColors, sampleSplatTexture } from "../src/mesh-splat-colors";
import type { MeshShapeNode } from "../src/scene-document";
import type { MeshMaterialData, MeshTextureData } from "../src/mesh-materials";
const raster = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) };
const texture: MeshTextureData = { dataURI: "data:image/png;base64,AA==", wrapS: 1001, wrapT: 1001, repeat: [1, 1], offset: [0, 0], center: [0, 0], rotation: 0, flipY: false, channel: 0 };
const shape = { color: "#808080" } as MeshShapeNode;
const material: MeshMaterialData = { name: "Legs", color: "#ffffff", emissive: "#000000", emissiveIntensity: 1, roughness: .8, metalness: 0, opacity: 1, transparent: true, alphaTest: 0, side: 2, depthWrite: true, normalScale: [1, 1] };
const texturedShape = { ...shape, faces: [{id:"f",vertices:["a","b","c"]}], vertices: ["a","b","c"].map(id=>({id,position:[0,0,0] as [number,number,number]})), uvs:{a:[.25,.25],b:[.75,.25],c:[.25,.75]} } as MeshShapeNode;
const ids: [string,string,string] = ["a","b","c"], bary: [number,number,number] = [1,0,0];

afterEach(() => vi.unstubAllGlobals());
type TestRaster = { width: number; height: number; data: number[] };
function browserRasters(rasters: Record<string, TestRaster>) {
  vi.stubGlobal("Image", class {
    naturalWidth=0; naturalHeight=0; onload?: () => void; onerror?: () => void; uri="";
    get pixels() { return rasters[this.uri].data; }
    set src(value:string) { this.uri=value; const raster=rasters[value]; if (!raster) { this.onerror?.(); return; } this.naturalWidth=raster.width; this.naturalHeight=raster.height; this.onload?.(); }
  });
  vi.stubGlobal("document", { createElement: () => {
    let pixels: number[] = [];
    return { width: 0, height: 0, getContext: () => ({
      isContextLost: () => false, getParameter: () => 8192,
      createTexture: () => ({}), createFramebuffer: () => ({}), bindTexture() {}, pixelStorei() {},
      texImage2D(_target: unknown, _level: unknown, _internal: unknown, _format: unknown, _type: unknown, image: { pixels: number[] }) { pixels = image.pixels; },
      bindFramebuffer() {}, framebufferTexture2D() {}, checkFramebufferStatus: () => 1, FRAMEBUFFER_COMPLETE: 1,
      readPixels(_x: number, _y: number, _w: number, _h: number, _format: unknown, _type: unknown, result: Uint8Array) { result.set(pixels); },
      getError: () => 0, NO_ERROR: 0, deleteTexture() {}, deleteFramebuffer() {},
    }) };
  } });
}
function browserRaster(data:number[], width=1, height=1) { browserRasters({[texture.dataURI]:{width,height,data}}); }

it("samples image rows using Three flipY and wraps transformed coordinates", () => {
  expect(sampleSplatTexture(raster, texture, new Vector2(.25, .25)).toArray()).toEqual([1, 0, 0]);
  expect(sampleSplatTexture(raster, { ...texture, flipY: true }, new Vector2(.25, .25)).toArray()).toEqual([0, 0, 1]);
  expect(sampleSplatTexture(raster, { ...texture, wrapS: 1000, offset: [1, 0] }, new Vector2(.25, .25)).toArray()).toEqual([1, 0, 0]);
});
it("interpolates diffuse color in linear space", () => {
  const color = sampleSplatTexture(raster, texture, new Vector2(.5, .25));
  expect(color.r).toBeCloseTo(.5); expect(color.g).toBeCloseTo(.5); expect(color.b).toBe(0);
});
it("filters across repeat seams while clamp and mirror retain edge texels", () => {
  const repeat = sampleSplatTexture(raster, { ...texture, wrapS: 1000 }, new Vector2(0, .25));
  expect(repeat.r).toBeCloseTo(.5); expect(repeat.g).toBeCloseTo(.5);
  expect(sampleSplatTexture(raster, texture, new Vector2(0, .25)).toArray()).toEqual([1, 0, 0]);
  expect(sampleSplatTexture(raster, { ...texture, wrapS: 1002 }, new Vector2(0, .25)).toArray()).toEqual([1, 0, 0]);
});
it("samples nearest across repeat/mirror texel boundaries and flips the addressed image row", () => {
  const nearest = { ...texture, filter: "nearest" as const };
  for (const x of [-.5, 1.5])
    expect(sampleSplatTexture(raster, { ...nearest, wrapS: 1002 }, new Vector2(x, .25)).toArray()).toEqual([1, 0, 0]);
  expect(sampleSplatTexture(raster, { ...nearest, wrapS: 1000 }, new Vector2(1, .25)).toArray()).toEqual([1, 0, 0]);
  expect(sampleSplatTexture(raster, { ...nearest, flipY: true }, new Vector2(.25, .5)).toArray()).toEqual([1, 0, 0]);
});
it("uses raw RGB on color bindings when requested", () => {
  const grey = { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) };
  expect(sampleSplatTexture(grey, texture, new Vector2(.5, .5)).r).toBeCloseTo(.21586, 4);
  expect(sampleSplatTexture(grey, { ...texture, colorSpace: "raw" }, new Vector2(.5, .5)).r).toBeCloseTo(128 / 255, 6);
});
it("uses linear material colors and opaque shape fallback", async () => {
  const sampler = await createMeshSplatColors(shape);
  expect(sampler.sample(ids,bary,0).r).toBeCloseTo(.21586, 4);
  expect(sampler.sampleSurface(ids,bary,0).opacity).toBe(1);
});
it("retains partially transparent scalar opacity without changing the source material", async () => {
  const sourceMaterial = {...material,opacity:.5};
  const sampler = await createMeshSplatColors({...shape,materials:[sourceMaterial]});
  expect(sampler.sampleSurface(ids,bary,0).opacity).toBe(.5);
  expect(sourceMaterial.opacity).toBe(.5);
});
it("ignores unused materials and does not decode their missing images", async () => {
  const sampler = await createMeshSplatColors({...texturedShape,materials:[material,{...material,map:texture,alphaMap:texture,opacity:.2}]});
  expect(sampler.sampleSurface(ids,bary,0).opacity).toBe(1);
});
it("samples alphaMap green at the actual UV instead of rejecting dark atlas pixels elsewhere", async () => {
  browserRaster([255,255,255,255, 255,0,255,255],2,1);
  const sampler = await createMeshSplatColors({...texturedShape,materials:[{...material,alphaMap:texture}]});
  expect(sampler.sampleSurface(ids,[1,0,0],0).opacity).toBe(1);
  expect(sampler.sampleSurface(ids,[0,1,0],0).opacity).toBe(0);
  expect(sampler.sampleSurface(ids,[.5,.5,0],0).opacity).toBeCloseTo(.5);
});
it("uses raw green values for opacity and supports opacity maps without diffuse maps", async () => {
  browserRaster([255,128,255,0]);
  const sampler = await createMeshSplatColors({...texturedShape,materials:[{...material,alphaMap:texture}]});
  expect(sampler.sampleSurface(ids,bary,0).opacity).toBeCloseTo(128/255);
  expect(sampler.sample(ids,bary,0).toArray()).toEqual([1,1,1]);
});
it("keeps bilinear samples of fully opaque texels inside the valid opacity range", async () => {
  browserRaster(new Array<number>(16).fill(255), 2, 2);
  const shape = { ...texturedShape, uvs: { ...texturedShape.uvs, a: [.2574626865671642, .47139303482587064] },
    materials: [{ ...material, map: texture, alphaMap: texture }] } as MeshShapeNode;
  const sampler = await createMeshSplatColors(shape);
  expect(sampler.sampleSurface(ids, bary, 0).opacity).toBe(1);
});
it("samples authored opacity data independently of the source image's own alpha", async () => {
  browserRaster([240,128,60,0]);
  const sampler = await createMeshSplatColors({
    ...texturedShape,
    materials: [{ ...material, transparent: false, alphaMap: { ...texture, useImageAlpha: true, colorSpace: "raw" } }],
  });
  expect(sampler.sampleSurface(ids,bary,0).opacity).toBeCloseTo(128 / 255);
});
it("multiplies diffuse alpha, green opacity map, and scalar opacity", async () => {
  const alphaURI="data:image/png;base64,AQ==";
  browserRasters({[texture.dataURI]:{width:1,height:1,data:[255,0,0,128]},[alphaURI]:{width:1,height:1,data:[0,64,0,255]}});
  const sampler = await createMeshSplatColors({...texturedShape,materials:[{...material,opacity:.5,map:texture,alphaMap:{...texture,dataURI:alphaURI}}]});
  const result = sampler.sampleSurface(ids,bary,0);
  expect(result.opacity).toBeCloseTo(.5 * 128/255 * 64/255);
  expect(result.color.toArray()).toEqual([1,0,0]);
});
it("applies cutoff to combined opacity and makes surviving nonblended samples fully opaque", async () => {
  browserRaster([255,128,255,255]);
  const rejected = await createMeshSplatColors({...texturedShape,materials:[{...material,opacity:.5,alphaTest:.3,alphaMap:texture}]});
  expect(rejected.sampleSurface(ids,bary,0).opacity).toBe(0);
  const survived = await createMeshSplatColors({...texturedShape,materials:[{...material,transparent:false,opacity:.5,alphaTest:.2,alphaMap:texture}]});
  expect(survived.sampleSurface(ids,bary,0).opacity).toBe(1);
});
it("uses independent UV channels, transforms and flipY for diffuse and alpha maps", async () => {
  const alphaURI="data:image/png;base64,AQ==";
  browserRasters({[texture.dataURI]:{width:2,height:1,data:[255,0,0,255, 0,0,255,255]},[alphaURI]:{width:2,height:2,data:[0,255,0,255, 0,128,0,255, 0,64,0,255, 0,0,0,255]}});
  const source = {...texturedShape,uvSets:{"1":{a:[.25,.25],b:[.25,.25],c:[.25,.25]}},materials:[{...material,map:texture,alphaMap:{...texture,dataURI:alphaURI,channel:1,offset:[.5,0],flipY:true}}]} as MeshShapeNode;
  const sampler = await createMeshSplatColors(source);
  // Diffuse uses UV0 at a: top-left red. Alpha uses shifted+flipped UV1: bottom-right black.
  const result = sampler.sampleSurface(ids,bary,0);
  expect(result.color.toArray()).toEqual([1,0,0]); expect(result.opacity).toBe(0);
});
it("ignores image alpha and does not decode ignored opacity maps on opaque noncutout materials", async () => {
  const noMap = await createMeshSplatColors({...shape,materials:[{...material,transparent:false,opacity:.1,alphaMap:texture}]});
  expect(noMap.sampleSurface(ids,bary,0).opacity).toBe(1);
  browserRaster([255,255,255,0]);
  const withMap = await createMeshSplatColors({...texturedShape,materials:[{...material,transparent:false,map:texture}]});
  expect(withMap.sampleSurface(ids,bary,0).opacity).toBe(1);
});
