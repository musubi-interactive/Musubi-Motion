import { writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { Matrix4 } from "three";

const server = await createServer({server:{middlewareMode:true,hmr:false,ws:false}, appType:"custom", optimizeDeps:{noDiscovery:true,include:[]}});
try {
  const {addSplat,emptyScene} = await server.ssrLoadModule("/src/scene-document.ts");
  const {encodeProject} = await server.ssrLoadModule("/src/project-archive.ts");
  const {defaultAnimation} = await server.ssrLoadModule("/src/animation.ts");
  let doc = emptyScene();
  const files = new Map();
  function add(id, name, points, color) {
    const bytes = new Uint8Array(32*points.length), data = new DataView(bytes.buffer);
    points.forEach(([x,y,z,r],i) => {
      [x,y,z,r,r,r*.5].forEach((value,k) => data.setFloat32(i*32+k*4,value,true));
      bytes.set([...color,255,255,128,128,128],i*32+24);
    });
    const asset = {id:id+"-asset",kind:"file",fileName:id+".splat",byteLength:bytes.length};
    doc = addSplat(doc,asset,name,[0,0,0],id,id+"-shape").document;
    files.set(asset.id,new File([bytes],asset.fileName));
  }
  // The rear ID is on the same camera ray as the first wrist center.
  add("character","Wrist and torso", [[-1.4,0,0,.21],[-1.575,0,-1,.2],[-.65,0,0,.18],[.65,0,0,.18],[1.4,0,0,.2],[0,.8,0,.2],[-1.40,.12,0,.17]], [210,130,68]);
  add("cover","Splat occluder",[[.65*7/8,0,1,.26]],[55,155,230]);
  doc.joints = ["left","right","spine"].map(id=>({id,name:id,parentId:null,position:[0,0,0]}));
  doc.nodes["character-shape"].binding = {meshSpace:true,jointIds:["left","right","spine"],restMatrices:doc.joints.map(()=>new Matrix4().toArray()),
    weights:{count:7,overrides:Object.fromEntries([.9,.2,.4,.1,.7,.6,.05].map((w,i)=>[i,[{jointId:"left",weight:.8*w},{jointId:"right",weight:.8*(1-w)},{jointId:"spine",weight:.2}]]))}};
  doc.nodes["character-shape"].scalarMasks = [{version:1,id:"wrist",name:"Wrist mask",assetId:"character-asset",sourceCount:7,locked:false,componentLocks:[],data:{kind:"dense",values:[0,0,0,0,0,0,0]}}];
  doc.nodes.coverMesh = {type:"transform",id:"coverMesh",name:"Opaque mesh occluder",parentId:null,rotationOrder:"XYZ",position:[-.65*7/8,0,1],rotation:[0,0,0],scale:[1,1,1]};
  doc.rootIds.push("coverMesh");
  doc.nodes.coverMeshShape = {type:"meshShape",id:"coverMeshShape",name:"Opaque face",parentId:"coverMesh",
    vertices:[[-.22,-.25,0],[.22,-.25,0],[.22,.25,0],[-.22,.25,0]].map((position,i)=>({id:"p"+i,position})),
    faces:[{id:"face",vertices:["p0","p1","p2","p3"]}], color:"#669977",shading:"flat",wireframe:false};
  doc.animation = {...defaultAnimation(),end:24,tracks:[{id:"left-shift",targetId:"left",channel:"position.y",keys:[0,24].map((time,i)=>({id:"key"+i,time,value:i*.5,interpolation:"linear",tangentMode:"auto"}))}]};
  const camera = {position:[0,0,8],target:[0,0,0],fov:42,near:.01,far:1000};
  await writeFile("examples/skin-cleanup-study.msb", await encodeProject(doc,files,{camera,time:0}));
} finally {await server.close();}
