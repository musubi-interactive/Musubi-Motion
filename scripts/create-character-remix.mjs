import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Color, Matrix4, Vector3 } from "three";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, configLoader: "runner", appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const load = name => server.ssrLoadModule("/src/" + name + ".ts");
  const { meshToSplatData } = await load("mesh-to-splats");
  const { addSplat, emptyScene } = await load("scene-document");
  const { defaultAnimation } = await load("animation");
  const { createProceduralGraph } = await load("procedural-graph");
  const { newSplatAppearanceLayer } = await load("splat-appearance");
  const { resizeSplatLattice } = await load("splat-lattice");
  const { decodeProject, encodeProject } = await load("project-archive");
  const colors = ["#007f83","#f7ac43","#fff2c6","#24364c","#f87852"];
  const source = { id:"mascot-mesh",type:"meshShape",name:"Courier surface",parentId:"original",color:colors[0],shading:"smooth",wireframe:false,
    vertices:[], faces:[], morphTargets:["Smile","Blink"].map(name => ({name,weight:0,deltas:{}})),
    materials:colors.map((color,i) => ({ name:["Jacket","Helmet","Face","Ink","Boots"][i],color,emissive:"#000000",emissiveIntensity:0,
      roughness:.8,metalness:0,opacity:1,transparent:false,alphaTest:0,side:2,depthWrite:true,normalScale:[1,1] })) };
  const joints = [], rest = [];
  function bone(id, parent, at) {
    const world = new Vector3(...at), base = parent ? rest[joints.findIndex(j => j.id === parent)] : new Vector3();
    joints.push({ id, name:id, parentId:parent, position:world.clone().sub(base).toArray() });
    rest.push(world);
    return joints.length-1;
  }
  const body = bone("Spine",null,[0,0,0]), head = bone("Head","Spine",[0,.4,0]);
  const arms = [-1,1].map((s,i) => {
    const side = i ? "L" : "R";
    return [bone(side+"_Arm","Spine",[s*.29,.14,.17]),bone(side+"_ForeArm",side+"_Arm",[s*.61,.14,.24])];
  });
  const skin = {jointIds:joints.map(j => j.id),inverseBindMatrices:rest.map(p => new Matrix4().makeTranslation(-p.x,-p.y,-p.z).toArray()),weights:{}};
  source.skin=skin;
  function vertex(p, joint, smile=[0,0,0], blink=[0,0,0]) {
    const id="v"+source.vertices.length;
    source.vertices.push({id,position:p}); skin.weights[id]=[{joint,weight:1}];
    source.morphTargets[0].deltas[id]=smile; source.morphTargets[1].deltas[id]=blink;
    return id;
  }
  function face(vertices,materialIndex) { source.faces.push({id:"f"+source.faces.length,vertices,materialIndex}); }
  function ellipsoid(center, size, joint, material, blink=false) {
    const lat=6, lon=12;
    const point=(x,y,z) => vertex([center[0]+x*size[0],center[1]+y*size[1],center[2]+z*size[2]],joint,
      [0,0,0],[0,blink ? -y*size[1]*.94 : 0,0]);
    const top = point(0,1,0), bottom = point(0,-1,0);
    let last;
    for (let r=1;r<lat;r++) {
      const theta=Math.PI*r/lat;
      const row=Array.from({length:lon},(_,i) => { const phi=i*2*Math.PI/lon; return point(Math.sin(theta)*Math.cos(phi),Math.cos(theta),Math.sin(theta)*Math.sin(phi)); });
      for(let i=0;i<lon;i++) {
        const j=(i+1)%lon;
        if(last) { face([last[i],last[j],row[j]],material); face([last[i],row[j],row[i]],material); }
        else face([top,row[j],row[i]],material);
        if(r===lat-1) face([bottom,row[i],row[j]],material);
      }
      last=row;
    }
  }
  ellipsoid([0,-.09,0],[.34,.45,.22],body,0);
  for(const [i,s] of [-1,1].entries()) {
    ellipsoid([s*.15,-.56,.04],[.13,.15,.15],body,4);
    ellipsoid([s*.45,.14,.2],[.21,.098,.095],arms[i][0],0);
    ellipsoid([s*.75,.14,.26],[.19,.079,.077],arms[i][1],1);
    ellipsoid([s*.92,.14,.27],[.095,.091,.085],arms[i][1],2);
  }
  ellipsoid([0,.59,0],[.445,.39,.25],head,1);
  ellipsoid([0,.58,.145],[.38,.285,.17],head,2);
  for(const s of [-1,1]) ellipsoid([s*.144,.645,.304],[.041,.062,.02],head,3,true);
  let previous;
  for(let i=0;i<=10;i++) {
    const t=i/5-1, rise=.087*t*t-.012;
    const row=[-.016,.016].map(offset => vertex([t*.147,.495+offset,.321-.028*t*t],head,[t*.034,rise,0]));
    if(previous) face([previous[0],row[0],row[1],previous[1]],3);
    previous=row;
  }

  const made=meshToSplatData(source,{overlap:.83,thickness:.22,opacity:.98,shading:true},7600,sample=>{

    return new Color(colors[sample.materialIndex]);
  });
  const asset={kind:"file",id:"courier-source",fileName:"courier.splat",byteLength:made.bytes.length};
  const {document:scene}=addSplat(emptyScene(),asset,"Courier",[0,0,0],"courier","courier-splats");
  scene.nodes.original={...scene.nodes.courier,id:"original",name:"Source character",hidden:true};
  scene.nodes[source.id]=source; scene.rootIds.push("original"); scene.joints=joints;
  const shape=scene.nodes["courier-splats"];
  Object.assign(shape,{binding:made.binding,morphTargets:made.morphTargets,morphSurface:made.morphSurface});
  const bytes=new DataView(made.bytes.buffer,made.bytes.byteOffset,made.bytes.byteLength), count=made.bytes.length/32;
  const chest=[];
  for(let i=0;i<count;i++) {
    const x=bytes.getFloat32(i*32,true), y=bytes.getFloat32(i*32+4,true), z=bytes.getFloat32(i*32+8,true);
    if(Math.abs(x)<.19 && y<.14 && y>-.25 && z>.13) chest.push(i);
  }
  shape.scalarMasks=[{id:"chest",name:"Jacket front",version:1,assetId:asset.id,sourceCount:count,locked:false,
    data:{kind:"sparse",defaultValue:0,indices:chest,values:chest.map(()=>1)},componentLocks:[]}];
  scene.proceduralGraph=createProceduralGraph();
  shape.appearance={version:1,sourceCount:count,layers:[{...newSplatAppearanceLayer(),id:"jacket-fabric",maskId:"chest",blend:.18}]};
  const lattice=resizeSplatLattice([0,.58,.1],[.92,.78,.6],[2,3,2]);
  shape.deformers=[{id:"visor",kind:"lattice",name:"Visor correction",sourceCount:count,envelope:1,params:lattice,
    keys:[0,24,48].map(frame=>({frame,channel:"point.11.y",value:.97+(frame===24?.05:0)}))}];
  function track(targetId,channel,samples) {
    const id=targetId+"-"+channel.replaceAll(".","-");
    return {id,targetId,channel,keys:samples.map(([time,value])=>({id:id+"-"+time,time,value,interpolation:"bezier",tangentMode:"clamped"}))};
  }
  const peak=(value)=>[[0,0],[24,value],[48,0]];
  scene.animation={...defaultAnimation(),end:48,tracks:[
    track("L_Arm","rotation.z",peak(136)),track("L_ForeArm","rotation.z",peak(44)),track("Head","rotation.y",peak(23)),
    ...["courier","original"].flatMap(id=>[track(id,"morph.0",peak(1)),track(id,"morph.1",[[0,0],[18,0],[24,1],[30,0],[48,0]])])]};
  const editor={camera:{view:"front",height:2.25,position:[0,.12,5],target:[0,.12,0],fov:40,near:.01,far:100},time:0};
  const archive=await encodeProject(scene,new Map([[asset.id,new File([made.bytes],asset.fileName)]]),editor);
  await decodeProject(archive);
  await writeFile(new URL("../examples/character-remix.msb",import.meta.url),archive);
} finally { await server.close(); }
