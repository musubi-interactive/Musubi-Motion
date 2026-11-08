import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Original SH1 ellipsoid fixture; no external scene, image or model data.
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, configLoader: "runner", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { addSplat, emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const { Matrix4, Quaternion, Euler } = await server.ssrLoadModule("three");
  const names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", ...Array.from({length:9},(_,i)=>`f_rest_${i}`), "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const rows = Array.from({length:9},(_,i)=>{
    const x=(i%3-1)*.65,y=(Math.floor(i/3)-1)*.45;
    const color=i%3===0?[.9,.15,.1]:i%3===1?[.1,.85,.2]:[.1,.3,.95];
    const q=new Quaternion().setFromEuler(new Euler(.3,.4,.55+i*.1));
    return [x,y,0,0,0,1,...color.map(c=>(c-.5)/.28209479177387814),.1,-.06,.04,.04,.03,-.03,-.02,.05,.08,4,...[.12,.035,.016].map(Math.log),q.w,q.x,q.y,q.z];
  });
  const header = new TextEncoder().encode(["ply", "format binary_little_endian 1.0", "comment Original Musubi component transform study with SH1", "element vertex 9", ...names.map(name=>`property float ${name}`), "end_header", ""].join("\n"));
  const bytes = new Uint8Array(header.length + rows.length * names.length * 4);
  bytes.set(header); const view = new DataView(bytes.buffer);
  rows.forEach((row,index)=>row.forEach((value,column)=>view.setFloat32(header.length+(index*names.length+column)*4,value,true)));

  const fileName = "original-sh1-ellipsoids.ply", asset = {id:"ellipsoids",kind:"file",fileName,byteLength:bytes.length};
  let scene=addSplat(emptyScene(),asset,"Edited Ellipsoids",[0,0,0],"edited","edited-shape").document;
  scene=addSplat(scene,asset,"Original Instance",[0,0,0],"original","original-shape").document;
  scene.nodes.edited.position[1]=-.8;scene.nodes.original.position[1]=.8;
  const matrix=new Matrix4().makeRotationZ(.4).multiply(new Matrix4().makeScale(1.8,.65,1.2)).multiply(new Matrix4().makeShear(.15,0,.1,0,0,0));
  scene.nodes["edited-shape"].componentTransforms={version:1,sourceCount:9,records:[0,3,6].map(index=>({index,matrix:matrix.toArray()}))};
  const editor={camera:{position:[0,0,8],target:[0,0,0],fov:42,view:"front",height:4,near:.01,far:1000},time:0};
  await writeFile(new URL("../examples/splat-transform-study.msb",import.meta.url),await encodeProject(scene,new Map([[asset.id,new File([bytes],fileName)]]),editor));
  console.log("Saved original nine-ellipsoid SH1 study: two instances, one source, three affine component records.");
} finally { await server.close(); }
