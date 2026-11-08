import * as THREE from "three";
import type { SplatMesh, SplatSkinning } from "@sparkjsdev/spark";
import { elasticEdges, type Elasticity } from "./elasticity";
import { transformGaussianTRS } from "./splat-component-transforms";
import { surfaceNeighbors } from "./elastic-neighbors";
import { allocateFill, radicalInverse, type FillRequest } from "./elastic-allocation";
import type { Joint } from "./skeleton";

type Influence = { bone:number; weight:number };
function readWeights(data:Uint16Array,index:number):Influence[] {
  return Array.from({length:4},(_,k)=>({bone:data[index*4+k]>>8,weight:(data[index*4+k]&255)/255})).filter(w=>w.weight>0);
}
function blendMatrix(weights:Influence[],transforms:THREE.Matrix4[]) {
  const matrix=new THREE.Matrix4();matrix.elements.fill(0);
  for(const {bone,weight} of weights) {
    const m=transforms[bone];
    if(m) for(let k=0;k<16;k++) matrix.elements[k]+=m.elements[k]*weight;
  }
  // Match Spark's weighted basis and translation without a perspective divide.
  matrix.elements[15]=1;
  return matrix;
}
function quantizeWeights(weights:Map<number,number>):Influence[] {
  const top=[...weights].sort((a,b)=>b[1]-a[1]).slice(0,4);
  const sum=top.reduce((s,w)=>s+w[1],0);
  if(sum<=0)return [];
  const units=top.map(([bone,w])=>({bone,units:Math.floor(w/sum*255),fraction:w/sum*255%1}));
  let left=255-units.reduce((s,w)=>s+w.units,0);
  for(const w of [...units].sort((a,b)=>b.fraction-a.fraction)) if(left-->0) w.units++;
  return units.filter(w=>w.units>0).map(w=>({bone:w.bone,weight:w.units/255}));
}

export function createElasticRuntime(mesh:SplatMesh,skin:SplatSkinning,rests:THREE.Matrix4[],bound:string[],joints:Joint[],settings:Elasticity,affine?:(index:number)=>THREE.Matrix4|undefined) {
  if(!mesh.extSplats)throw Error("Elasticity requires extended splats.");
  const source=mesh.extSplats,count=source.numSplats;
  const originalArrays=source.extArrays.map(a=>a.slice()) as [Uint32Array,Uint32Array];
  const originalExtra=source.extra;
  const originals=Array.from({length:count},(_,i)=>{
    const s=source.getSplat(i);
    return {center:s.center.clone(),scales:s.scales.clone(),quaternion:s.quaternion.clone(),opacity:s.opacity,color:s.color.clone()};
  });
  const weights=originals.map((_,i)=>readWeights(skin.skinData,i));
  const inverseRests=rests.map(m=>m.clone().invert());
  const allowed=new Set(elasticEdges(bound,joints,settings.joints).map(e=>e.join("/")));
  const connections=elasticEdges(bound,joints,null).map(([a,b])=>({
    line:new THREE.Line3(new THREE.Vector3().setFromMatrixPosition(rests[bound.indexOf(a)]),new THREE.Vector3().setFromMatrixPosition(rests[bound.indexOf(b)])),
    allowed:allowed.has([a,b].join("/")),
  }));
  const enabled=originals.map(s=>{
    let nearest=Infinity,eligible=false;
    for(const c of connections) {
      if(c.line.distanceSq()<1e-12)continue;
      const distance=c.line.closestPointToPoint(s.center,true,new THREE.Vector3()).distanceToSquared(s.center);
      if(distance<nearest){nearest=distance;eligible=c.allowed;}
    }
    return eligible;
  });
  const graph=surfaceNeighbors(originals);
  const edges=graph.edges.filter(([a,b])=>enabled[a]&&enabled[b]);
  const triangles=graph.triangles.filter(t=>t.every(i=>enabled[i]));
  const oldLod=mesh.enableLod;mesh.enableLod=false;
  source.ensureSplats(count+settings.budget);
  // Keep original SH; generated entries use interpolated RGB with zero SH.
  source.extra={...originalExtra};
  for(const [dataKey,textureKey] of [["sh1","sh1Texture"],["sh2","sh2Texture"],["sh3a","sh3TextureA"],["sh3b","sh3TextureB"]] as const) {
    const data=originalExtra[dataKey];
    if(data){
      const extended=new Uint32Array(source.maxSplats*4);
      extended.set(data.subarray(0,count*4));source.extra[dataKey]=extended;
      delete source.extra[textureKey];
    }
  }
  let last="";
  let active: ((index:number)=>boolean) | undefined;
  function upload(n:number) {
    source.numSplats=n;
    source.initialize({extArrays:source.extArrays,numSplats:n,extra:source.extra,lodSplats:source.lodSplats});
    source.textures.forEach(t=>t.needsUpdate=true);
    mesh.updateGenerator();skin.skinTexture.needsUpdate=true;mesh.needsUpdate=true;
  }
  return {
    invalidate() { last=""; },
    setComponentActive(next:typeof active) {
      if (active === next) return;
      active=next;last="";
    },
    update(current:THREE.Matrix4[]) {
      // Bending can open gaps without changing the length of a joint connection.
      const transforms=current.map((m,i)=>m.clone().multiply(inverseRests[i]));
      const signature=transforms.map(m=>m.elements.map(v=>v.toFixed(6)).join(",")).join(";");
      if(signature===last)return;last=signature;
      const matrices=weights.map(w=>blendMatrix(w,transforms));
      const editedCenters=originals.map((s,i)=>{const center=s.center.clone(),matrix=affine?.(i);return matrix?center.applyMatrix4(matrix):center;});
      const deformed=editedCenters.map((center,i)=>center.clone().applyMatrix4(matrices[i]));
      const stretches=originals.map(()=>new THREE.Vector3(1,1,1));
      const density=settings.density??1;
      const requests:FillRequest[]=[];
      for(const [a,b] of edges) {
        if (active && (!active(a) || !active(b))) continue;
        const delta=originals[b].center.clone().sub(originals[a].center);
        const editedRestLength=editedCenters[a].distanceTo(editedCenters[b]);
        if(editedRestLength<1e-12)continue;
        const ratio=deformed[a].distanceTo(deformed[b])/editedRestLength;
        for(const i of [a,b]) {
          const local=delta.clone().normalize().applyQuaternion(originals[i].quaternion.clone().invert());
          const strain=Math.max(0,Math.min(32,ratio)-1);
          stretches[i].max(new THREE.Vector3(1+strain*local.x*local.x,1+strain*local.y*local.y,1+strain*local.z*local.z));
        }
        if(ratio>settings.spacing)requests.push({ids:[a,b],desired:Math.min(512,Math.ceil((ratio/settings.spacing-1)*density)),allocated:0,strain:ratio});
      }
      // Edge subdivision alone leaves holes under expansion in two directions.
      for(const ids of triangles) {
        const [a,b,c]=ids;
        if (active && (!active(a) || !active(b) || !active(c))) continue;
        const restArea=editedCenters[b].clone().sub(editedCenters[a]).cross(editedCenters[c].clone().sub(editedCenters[a])).length();
        if(restArea<1e-12)continue;
        const area=deformed[b].clone().sub(deformed[a]).cross(deformed[c].clone().sub(deformed[a])).length();
        const ratio=area/restArea;
        if(ratio>settings.spacing*settings.spacing)requests.push({ids,desired:Math.min(2048,Math.ceil((ratio/(settings.spacing*settings.spacing)-1)*density*density)),allocated:0,strain:Math.sqrt(ratio)});
      }
      allocateFill(requests,settings.budget,settings.distribution??0);
      const scaled=(i:number,amount:number)=>originals[i].scales.clone().multiply(stretches[i].clone().subScalar(1).multiplyScalar(amount).addScalar(1));
      originals.forEach((s,i)=>source.setSplat(i,s.center,scaled(i,settings.stretch),s.quaternion,s.opacity,s.color));
      let generated=0;
      for(const r of requests)for(let k=0;k<r.allocated;k++) {
        let bary:number[];
        if(r.ids.length===2){const t=radicalInverse(k+1,2);bary=[1-t,t];}
        else if(k===0)bary=[1/3,1/3,1/3];
        else {
          const u=Math.sqrt(radicalInverse(k+1,2)),v=radicalInverse(k+1,3);
          bary=[1-u,u*(1-v),u*v];
        }
        const blend=new Map<number,number>();
        r.ids.forEach((i,j)=>weights[i].forEach(w=>blend.set(w.bone,(blend.get(w.bone)??0)+w.weight*bary[j])));
        const influences=quantizeWeights(blend);
        if(!influences.length)continue;
        const matrix=blendMatrix(influences,transforms);
        if(Math.abs(matrix.determinant())<1e-8)continue;
        const center=new THREE.Vector3(),scales=new THREE.Vector3(),color=new THREE.Color(0,0,0);
        let opacity=0;
        r.ids.forEach((i,j)=>{
          center.addScaledVector(deformed[i],bary[j]);
          const evaluated=transformGaussianTRS(originals[i].quaternion,scaled(i,settings.expansion),affine?.(i));
          scales.addScaledVector(evaluated.scales,bary[j]);
          color.r+=originals[i].color.r*bary[j];color.g+=originals[i].color.g*bary[j];color.b+=originals[i].color.b*bary[j];
          opacity+=originals[i].opacity*bary[j];
        });
        // Store the inverse-skinned target to land exactly inside the actual gap
        // after Spark applies the new splat's blended (quantized) joint weights.
        center.applyMatrix4(matrix.invert());
        const editedRotation=(i:number)=>transformGaussianTRS(originals[i].quaternion,scaled(i,settings.expansion),affine?.(i)).quaternion;
        const quaternion=editedRotation(r.ids[0]);
        let accumulated=bary[0];
        for(let j=1;j<r.ids.length;j++){accumulated+=bary[j];quaternion.slerp(editedRotation(r.ids[j]),bary[j]/accumulated);}
        if(![...center.toArray(),...scales.toArray()].every(Number.isFinite))continue;
        const index=count+generated++;
        source.setSplat(index,center,scales,quaternion,opacity,color);
        skin.skinData.fill(0,index*4,index*4+4);
        influences.forEach((w,j)=>skin.skinData[index*4+j]=(w.bone<<8)|Math.round(w.weight*255));
      }
      upload(count+generated);
    },
    dispose() {
      for(const key of ["sh1Texture","sh2Texture","sh3TextureA","sh3TextureB"] as const) {
        if(source.extra[key]!==originalExtra[key])source.extra[key]?.value.dispose();
      }
      source.extra=originalExtra;source.extArrays=originalArrays;upload(count);mesh.enableLod=oldLod;
    },
  };
}
