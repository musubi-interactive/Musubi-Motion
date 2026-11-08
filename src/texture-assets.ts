import { sha256 } from "@noble/hashes/sha2.js";
import { MESH_TEXTURE_SLOTS } from "./mesh-materials.ts";
import type { MeshShapeNode, SceneDocument } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export const TEXTURE_LIMITS = { bytes: 16 * 1024 * 1024, pixels: 16_777_216, dimension: 8192, libraryBytes: 64 * 1024 * 1024, count: 512 } as const;
import { graphTextureReferences, relinkGraphTexture } from "./procedural-graph.ts";
import { particleMapReferences } from "./particle-map-emission.ts";
import { validateParticleEmitters } from "./particle-emitter.ts";

export type TextureRole = "color" | "data";
export type TextureAsset = {
  id: string; name: string; mime: string; byteLength: number; width: number; height: number;
  alpha: boolean; role: TextureRole; dataURI: string; thumbnail: string;
};
const embedded = /^data:(image\/(?:png|jpeg|webp|gif|bmp));base64,([A-Za-z0-9+/]+={0,2})$/;
const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2, "0")).join("");
export const textureContentId = (bytes: Uint8Array) => `tex_${hex(sha256(bytes))}`;
export function textureBytes(uri: string) {
  const match = embedded.exec(uri); if (!match) throw Error("Texture must contain an embedded raster image.");
  if (match[2].length > Math.ceil(TEXTURE_LIMITS.bytes / 3) * 4) throw Error("Texture exceeds 16 MiB.");
  const raw = atob(match[2]); return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function pngCRC(bytes: Uint8Array) {
  let value=0xffffffff;
  for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;}
  return (value^0xffffffff)>>>0;
}
function dimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > TEXTURE_LIMITS.dimension || height > TEXTURE_LIMITS.dimension || width * height > TEXTURE_LIMITS.pixels)
    throw Error("Texture exceeds 8192 pixels per side or 16 million pixels. Resize the image before importing.");
  return { width, height };
}
/** Read dimensions before any browser pixel allocation. Non-upright EXIF must be normalized explicitly. */
export function inspectTextureHeader(bytes: Uint8Array, mime: string): { width: number; height: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, count: number) => String.fromCharCode(...bytes.subarray(start, start + count));
  if (mime === "image/png") {
    if (bytes.length < 33 || hex(bytes.subarray(0, 8)) !== "89504e470d0a1a0a" || ascii(12, 4) !== "IHDR") throw Error("Invalid PNG header.");
    const size=dimensions(v.getUint32(16),v.getUint32(20));
    let end = false, image = false;
    for (let i = 8; i + 12 <= bytes.length;) {
      const length = v.getUint32(i), type = ascii(i + 4, 4);
      if (length > bytes.length - i - 12) throw Error("Truncated PNG image.");
      if (pngCRC(bytes.subarray(i+4,i+8+length))!==v.getUint32(i+8+length)) throw Error("PNG image integrity check failed. Export the complete image again.");
      if (type === "acTL") throw Error("Animated PNG is unsupported. Export a still image.");
      if (type === "IDAT") image = true;
      if (type === "IEND") { end = length === 0 && i + 12 === bytes.length; break; }
      i += length + 12;
    }
    if (!end || !image) throw Error("Truncated PNG image: missing complete image data.");
    return size;
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 4 || v.getUint16(0) !== 0xffd8 || v.getUint16(bytes.length - 2) !== 0xffd9) throw Error("Invalid or truncated JPEG image.");
    let result: {width: number; height: number} | undefined;
    for (let i = 2; i + 4 <= bytes.length;) {
      if (bytes[i++] !== 255) throw Error("Invalid JPEG marker.");
      while (bytes[i] === 255) i++;
      const marker = bytes[i++]; if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = v.getUint16(i); if (length < 2 || i + length > bytes.length) throw Error("Truncated JPEG segment.");
      if (marker === 0xe1 && ascii(i + 2, 6) === "Exif\0\0") {
        const t = i + 8, little = ascii(t, 2) === "II";
        if (t + 8 > i + length) throw Error("Invalid JPEG orientation metadata.");
        const directory = t + v.getUint32(t + 4, little);
        if (directory + 2 > i + length) throw Error("Invalid JPEG orientation metadata.");
        const count = v.getUint16(directory, little);
        for (let j = 0; j < count; j++) {
          const field = directory + 2 + j * 12;
          if (field + 12 > i + length) throw Error("Invalid JPEG orientation metadata.");
          if (v.getUint16(field, little) === 0x112 && v.getUint16(field + 8, little) !== 1)
            throw Error("JPEG uses EXIF rotation or mirroring. Export an upright image before importing.");
        }
      }
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 8) throw Error("Invalid JPEG dimensions."); result = dimensions(v.getUint16(i + 5), v.getUint16(i + 3));
      }
      i += length;
    }
    if (!result) throw Error("JPEG image has no dimensions."); return result;
  }
  if (mime === "image/webp") {
    if (bytes.length < 30 || ascii(0,4) !== "RIFF" || ascii(8,4) !== "WEBP" || v.getUint32(4,true) + 8 !== bytes.length) throw Error("Invalid or truncated WebP image.");
    const type = ascii(12,4), u24 = (i: number) => bytes[i] | bytes[i+1]<<8 | bytes[i+2]<<16;
    if (type === "VP8X") { if (bytes[20] & 2) throw Error("Animated WebP is unsupported. Export a still image."); return dimensions(u24(24)+1,u24(27)+1); }
    if (type === "VP8 " && hex(bytes.subarray(23,26)) === "9d012a") return dimensions(v.getUint16(26,true)&0x3fff,v.getUint16(28,true)&0x3fff);
    if (type === "VP8L" && bytes[20] === 0x2f) return dimensions(1+((bytes[21]|bytes[22]<<8)&0x3fff),1+((bytes[22]>>6|bytes[23]<<2|bytes[24]<<10)&0x3fff));
    throw Error("Unsupported WebP image header.");
  }
  // Existing FBX importer supports these formats too; inspect their allocation bounds before adoption.
  if (mime === "image/gif" && bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(0,6))) return dimensions(v.getUint16(6,true),v.getUint16(8,true));
  if (mime === "image/bmp" && bytes.length >= 26 && ascii(0,2) === "BM") return dimensions(v.getInt32(18,true),Math.abs(v.getInt32(22,true)));
  throw Error("Unsupported texture format. Use PNG, JPEG, or WebP.");
}
export type TextureDecoder = (dataURI: string, size: {width: number; height: number}) => Promise<{alpha: boolean; thumbnail: string}>;
export const decodeTexture: TextureDecoder = async (uri, size) => {
  if (typeof Image === "undefined") throw Error("Texture image decoding requires a browser.");
  const image = new Image(); image.src = uri;
  const canvas = document.createElement("canvas");
  try {
    try { await image.decode(); } catch { throw Error("Could not decode texture image. Export a complete PNG, JPEG, or WebP image."); }
    if (image.naturalWidth !== size.width || image.naturalHeight !== size.height) throw Error("Image orientation or dimensions differ from its header. Export an upright image.");
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext("2d", {willReadFrequently: true}); if (!context) throw Error("Could not read texture pixels.");
    context.drawImage(image,0,0); const pixels = context.getImageData(0,0,size.width,size.height).data;
    let alpha = false; for (let i=3;i<pixels.length;i+=4) if (pixels[i] !== 255) { alpha=true; break; }
    const scale = Math.min(1,128 / Math.max(size.width,size.height)); canvas.width = Math.max(1,Math.round(size.width*scale)); canvas.height = Math.max(1,Math.round(size.height*scale));
    context.drawImage(image,0,0,canvas.width,canvas.height);
    return {alpha, thumbnail: canvas.toDataURL("image/png")};
  } finally { image.removeAttribute("src"); canvas.width = canvas.height = 0; }
};
export async function prepareTexture(file: File, role: TextureRole = "color", decode: TextureDecoder = decodeTexture): Promise<TextureAsset> {
  if (!/\.(png|jpe?g|webp)$/i.test(file.name)) throw Error("Unsupported texture format. Use PNG, JPEG, or WebP.");
  if (!file.size || file.size > TEXTURE_LIMITS.bytes) throw Error("Texture must contain between 1 byte and 16 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = bytes[0]===137 ? "image/png" : bytes[0]===255 ? "image/jpeg" : "image/webp";
  const size = inspectTextureHeader(bytes,mime);
  let raw=""; for (let i=0;i<bytes.length;i+=16384) raw += String.fromCharCode(...bytes.subarray(i,i+16384));
  const dataURI=`data:${mime};base64,${btoa(raw)}`;
  const decoded = await decode(dataURI,size);
  return {id:textureContentId(bytes),name:file.name.slice(0,255),mime,byteLength:bytes.length,...size,...decoded,role,dataURI};
}
export function validateTextureAssets(value: unknown): asserts value is Record<string, TextureAsset> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid texture library.");
  const entries=Object.entries(value); let total=0;
  if (entries.length>TEXTURE_LIMITS.count) throw Error("Texture library exceeds 512 images.");
  for (const [id,a] of entries as [string,TextureAsset][]) {
    if (!a || a.id!==id || !/^tex_[a-f0-9]{64}$/.test(id) || typeof a.name!=="string" || !a.name.trim() || a.name.length>255
      || typeof a.dataURI!=="string" || typeof a.thumbnail!=="string" || a.thumbnail.length>256*1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(a.thumbnail)
      || !["color","data"].includes(a.role) || typeof a.alpha!=="boolean") throw Error("Invalid texture asset metadata.");
    const thumb=textureBytes(a.thumbnail), thumbnailSize=inspectTextureHeader(thumb,"image/png");
    if (thumbnailSize.width>128 || thumbnailSize.height>128) throw Error("Texture thumbnail exceeds 128 pixels.");
    const bytes=textureBytes(a.dataURI), mime=embedded.exec(a.dataURI)![1], size=inspectTextureHeader(bytes,mime);
    if (a.mime!==mime || bytes.length!==a.byteLength || textureContentId(bytes)!==id || a.width!==size.width || a.height!==size.height) throw Error("Texture content identity or dimensions do not match.");
    total+=bytes.length;
  }
  if (total>TEXTURE_LIMITS.libraryBytes) throw Error("Texture library exceeds 64 MiB. Remove unused images first.");
}
export function textureReferences(doc: SceneDocument, id: string) {
  const asset=doc.textureAssets?.[id]; const refs: {shapeId:string;material:number;slot:typeof MESH_TEXTURE_SLOTS[number]}[]=[];
  for (const shape of Object.values(doc.nodes)) if (shape.type==="meshShape") shape.materials?.forEach((material,index)=> {
    for (const slot of MESH_TEXTURE_SLOTS) if (material[slot]?.assetId===id || asset && material[slot]?.dataURI===asset.dataURI) refs.push({shapeId:shape.id,material:index,slot});
  });
  return refs;
}
export function addTexture(doc: SceneDocument, asset: TextureAsset): SceneDocument {
  if (doc.textureAssets?.[asset.id]) return doc;
  const assets={...doc.textureAssets,[asset.id]:asset}; validateTextureAssets(assets); return {...doc,textureAssets:assets};
}
export function relinkTexture(doc: SceneDocument, from: string, to: string): SceneDocument {
  if (!doc.textureAssets?.[from] || !doc.textureAssets[to]) throw Error("Select existing source and destination texture assets.");
  if (from===to) return doc;
  const nodes={...doc.nodes}, refs=textureReferences(doc,from), shapeIds=new Set(refs.map(r=>r.shapeId));
  for (const id of shapeIds) {
    const shape=nodes[id] as MeshShapeNode;
    nodes[id]={...shape,materials:shape.materials!.map(material=> {
      const next={...material};
      for (const slot of MESH_TEXTURE_SLOTS) if (material[slot]?.assetId===from || material[slot]?.dataURI===doc.textureAssets![from].dataURI) {
        const {dataURI:_uri,...sampler}=material[slot]!; next[slot]={...sampler,assetId:to};
      }
      return next;
    })};
  }
  const graph = relinkGraphTexture(doc.proceduralGraph, from, to, doc.textureAssets);
  const particles = particleMapReferences(doc, from);
  for (const shape of particles) if (shape.type === "particleShape" && shape.emissionMap) nodes[shape.id] = { ...shape, emissionMap: { ...shape.emissionMap, assetId: to } };
  return refs.length || particles.length || graph !== doc.proceduralGraph ? {...doc,nodes,proceduralGraph:graph} : doc;
}
export function removeTexture(doc: SceneDocument, id: string): SceneDocument {
  if (!doc.textureAssets?.[id]) return doc;
  if (textureReferences(doc,id).length || graphTextureReferences(doc.proceduralGraph,id).length || particleMapReferences(doc,id).length)
    throw Error("Texture is referenced by materials, particle emission, or the texture graph. Relink its references before deleting.");
  const assets={...doc.textureAssets}; delete assets[id]; return {...doc,textureAssets:assets};
}
export function replaceTexture(doc: SceneDocument, id: string, replacement: TextureAsset): SceneDocument {
  if (!doc.textureAssets?.[id]) throw Error("Texture to replace no longer exists.");
  if (id===replacement.id) return doc;
  // Release the old unreferenced entry before budget validation; replacement is one atomic document.
  const old=doc.textureAssets[id], assets={...doc.textureAssets}; delete assets[id]; assets[replacement.id]=assets[replacement.id]??{...replacement,role:old.role};
  const linked=relinkTexture({...doc,textureAssets:{...assets,[id]:old}},id,replacement.id);
  validateTextureAssets(assets); return {...linked,textureAssets:assets};
}
export function setTextureRole(doc: SceneDocument, id: string, role: TextureRole): SceneDocument {
  if (role!=="color" && role!=="data") throw Error("Texture role must be color or data.");
  const asset=doc.textureAssets?.[id]; if (!asset) throw Error("Texture no longer exists.");
  return asset.role===role ? doc : {...doc,textureAssets:{...doc.textureAssets,[id]:{...asset,role}}};
}
export function commitTextureCommand(store: SceneStore, label: string, action: (doc: SceneDocument)=>SceneDocument) {
  const before=store.getState().document, next=action(before);
  if (next !== before) validateParticleEmitters(next);
  if (next!==before) { store.setState({document:next,editLabel:label}); trimTextureHistory(store); }
  return next;
}
/** Adopt existing FBX embedded images into the same library without changing material sampling. */
export async function collectEmbeddedTextures(doc: SceneDocument, decode: TextureDecoder = decodeTexture, onWarning?: (message:string)=>void): Promise<SceneDocument> {
  let next=doc;
  const prepared=new Map<string,TextureAsset>();
  for (const shape of Object.values(doc.nodes)) if (shape.type==="meshShape" && shape.materials) {
    const materials=[];
    for (const material of shape.materials) {
      const m={...material};
      for (const slot of MESH_TEXTURE_SLOTS) {
        const source=material[slot]; if (!source?.dataURI) continue;
        let asset=prepared.get(source.dataURI);
        if (!asset) {
          try {
          const bytes=textureBytes(source.dataURI), mime=embedded.exec(source.dataURI)![1], size=inspectTextureHeader(bytes,mime);
          const id=textureContentId(bytes);
          asset=next.textureAssets?.[id]??{id,name:`${material.name||shape.name} ${slot}.${mime.split("/")[1]}`,mime,byteLength:bytes.length,...size,...await decode(source.dataURI,size),role:slot==="map"||slot==="emissiveMap"?"color":"data",dataURI:source.dataURI};
          next=addTexture(next,asset); prepared.set(source.dataURI,asset);
          } catch(error) { if(!onWarning)throw error; onWarning(`Preserved embedded ${slot}: ${error instanceof Error?error.message:String(error)}`); continue; }
        }
        const {dataURI:_uri,...sampler}=source; m[slot]={...sampler,assetId:asset.id};
      }
      materials.push(m);
    }
    next={...next,nodes:{...next.nodes,[shape.id]:{...shape,materials}}};
  }
  return next;
}

/** Keep at most 128 MiB of distinct original image bytes across current and undo documents. */
export function trimTextureHistory(store: SceneStore, budget=128*1024*1024) {
  const history=store.temporal.getState(), seen=new Set<string>(); let total=0;
  function include(doc: SceneDocument|undefined) {
    for (const asset of Object.values(doc?.textureAssets??{})) if (!seen.has(asset.id)) {seen.add(asset.id); total+=asset.byteLength;}
  }
  include(store.getState().document); let start=history.pastStates.length;
  for(let i=history.pastStates.length-1;i>=0;i--){include(history.pastStates[i].document);if(total>budget)break;start=i;}
  if(start)store.temporal.setState({pastStates:history.pastStates.slice(start)});
}
export async function validateTextureDecoding(doc: SceneDocument) {
  for (const asset of Object.values(doc.textureAssets??{})) {
    const decoded=await decodeTexture(asset.dataURI,asset);
    if(decoded.alpha!==asset.alpha)throw Error(`Texture alpha metadata does not match image: ${asset.name}`);
  }
}
