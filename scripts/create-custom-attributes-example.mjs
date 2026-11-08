// Original numerical NURBS curl study; generated locally, no external data.
import { createServer } from "vite";
import { readFile, writeFile } from "node:fs/promises";
const server = await createServer({ configLoader: "runner", server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { createController } = await server.ssrLoadModule("/src/controller-curves.ts");
  const { addCustomAttribute } = await server.ssrLoadModule("/src/custom-attributes.ts");
  const { evaluateSceneAnimation, upsertTrack } = await server.ssrLoadModule("/src/animation.ts");
  const { evaluateDrivenKeys, setDrivenKey } = await server.ssrLoadModule("/src/driven-keys.ts");
  const { encodeProject, decodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const doc = emptyScene();
  doc.joints = [{id:"root",name:"FingerRoot",parentId:null,position:[0,0,0]}, {id:"middle",name:"FingerMiddle",parentId:"root",position:[1,0,0]}, {id:"tip",name:"FingerTip",parentId:"middle",position:[1,0,0]}];
  const store = createSceneStore(doc), control = createController(store, "circle", {name:"CurlControl",plane:"XY",size:1});
  const attribute = addCustomAttribute(store,control,{name:"curl",default:0,value:0,min:0,max:10,keyable:true,locked:false});
  const channel = `custom.${attribute}`;
  for (const [joint,max] of [["root",65],["middle",90],["tip",45]]) for(const [input,output] of [[0,0],[10,max]]) setDrivenKey(store,{targetId:control,channel},{targetId:joint,channel:"rotation.z"},input,output);
  upsertTrack(store,{id:"curl-time",targetId:control,channel,keys:[{id:"curl-0",time:0,value:0,interpolation:"linear",tangentMode:"auto"},{id:"curl-24",time:24,value:10,interpolation:"linear",tangentMode:"auto"},{id:"curl-48",time:48,value:0,interpolation:"linear",tangentMode:"auto"}]});
  const scene = store.getState().document, before = JSON.stringify(scene), editor={camera:{position:[4,3,7],target:[1,1,0],fov:42,near:.01,far:1000},time:0};
  const path="examples/custom-attributes-sdk.msb", bytes=await encodeProject(scene,new Map(),editor); await writeFile(path,bytes);
  const reopened=(await decodeProject(new Uint8Array(await readFile(path)))).scene;
  if(JSON.stringify(reopened)!==before)throw Error("MSB reopen changed custom rig");
  for(const frame of [0,24,12,48,6,36,3.25,0]) { const poses=evaluateSceneAnimation(reopened,frame);evaluateDrivenKeys(reopened,poses); const curl=(frame<=24?frame:48-frame)/24; if(Math.abs(poses.get("middle").rotation[2]-curl*90)>1e-8)throw Error("Non-deterministic curl"); }
  if(JSON.stringify(scene)!==before)throw Error("Evaluation mutated authored fallback");
  console.log(JSON.stringify({path,bytes:bytes.length,control,attribute,relationships:3,channels:1,timeKeys:3,randomBackwardSamples:8,externalAssets:0},null,2));
} finally { await server.close(); }
