// Original Boolean/Enum NURBS switch study; generated locally, no external data.
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
  const {makeEnumEntries}=await server.ssrLoadModule("/src/custom-attribute-types.ts");
  const mode=addCustomAttribute(store,control,{name:"poseMode",type:"enum",default:0,keyable:true,locked:false,...makeEnumEntries(["Relaxed","Grip","Point"])});
  const enabled=addCustomAttribute(store,control,{name:"enabled",type:"boolean",default:0,keyable:true,locked:false});
  const channel=`custom.${mode}`, booleanChannel=`custom.${enabled}`;
  for(const [input,output] of [[0,0],[1,90],[2,-30]])setDrivenKey(store,{targetId:control,channel},{targetId:"middle",channel:"rotation.z"},input,output);
  for(const [input,output] of [[0,0],[1,45]])setDrivenKey(store,{targetId:control,channel:booleanChannel},{targetId:"tip",channel:"rotation.z"},input,output);
  const key=(id,time,value)=>({id,time,value,interpolation:"step",tangentMode:"auto"});
  upsertTrack(store,{id:"mode-time",targetId:control,channel,keys:[key("mode0",0,0),key("mode12",12,1),key("mode24",24,2),key("mode36",36,0)]});
  upsertTrack(store,{id:"enabled-time",targetId:control,channel:booleanChannel,keys:[key("enabled0",0,0),key("enabled12",12,1),key("enabled36",36,0)]});
  const scene = store.getState().document, before = JSON.stringify(scene), editor={camera:{position:[4,3,7],target:[1,1,0],fov:42,near:.01,far:1000},time:0};
  const path="examples/custom-types-sdk.msb", bytes=await encodeProject(scene,new Map(),editor); await writeFile(path,bytes);
  const reopened=(await decodeProject(new Uint8Array(await readFile(path)))).scene;
  if(JSON.stringify(reopened)!==before)throw Error("MSB reopen changed custom rig");
  for(const frame of [0,24,12,48,6,36,3.25,0]) { const poses=evaluateSceneAnimation(reopened,frame);evaluateDrivenKeys(reopened,poses); const expected=frame<12?0:frame<24?90:frame<36?-30:0; if(poses.get("middle").rotation[2]!==expected)throw Error("Non-deterministic discrete SDK"); }
  if(JSON.stringify(scene)!==before)throw Error("Evaluation mutated authored fallback");
  console.log(JSON.stringify({path,bytes:bytes.length,control,mode,enabled,relationships:2,channels:2,timeKeys:7,randomBackwardSamples:8,externalAssets:0},null,2));
} finally { await server.close(); }
