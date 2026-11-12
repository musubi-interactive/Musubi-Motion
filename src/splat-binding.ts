import * as THREE from "three";
import { SplatSkinning, SplatSkinningMode, type SplatMesh } from "@sparkjsdev/spark";
import type { SkinInfluence, SplatShapeNode, Vec3 } from "./scene-document";
import { createElasticRuntime } from "./elastic-runtime";
import type { Joint } from "./skeleton";
import type { SplatTransformRuntime } from "./splat-transform-runtime";
import type { SplatAppearanceRead } from "./splat-appearance-runtime.ts";
import { posedSelection } from "./splat-selection";
import { createSkinWeightLookup, validateSkinWeightCount } from "./skin-weights";
export function createBinding(mesh: SplatMesh, binding: NonNullable<SplatShapeNode["binding"]>, elasticity?: SplatShapeNode["elasticity"], joints: Joint[] = [], componentTransforms?: SplatTransformRuntime) {
 const source = mesh.extSplats ?? mesh.packedSplats;
 if (!source) throw Error("Skin binding requires loaded splat data.");
 const componentCount = source.numSplats;
 // Validate authored component indices/count before allocating skin textures.
 validateSkinWeightCount(binding, componentCount);
 const lookup = createSkinWeightLookup(binding);
 const boneIndices = new Map(binding.jointIds.map((id, index) => [id, index]));
 const skin = new SplatSkinning({mesh, numSplats: componentCount + (elasticity?.budget ?? 0), numBones:binding.jointIds.length, mode:SplatSkinningMode.LINEAR_BLEND});
 if (componentTransforms) {
  const applySkin = skin.modifyCov.bind(skin);
  skin.modifyCov = value => applySkin(componentTransforms.modifier.apply({ covsplat: value }).covsplat);
 }
 const rests = binding.restMatrices.map(m => new THREE.Matrix4().fromArray(m));
 const inverseRests = rests.map(m => m.clone().invert());
 rests.forEach((_,i)=>skin.setRestMatrix(i,new THREE.Matrix4()));
 source.forEachSplat((index, center)=>{
  const influences = lookup(index, center.toArray() as Vec3);
  const indices = [0,0,0,0], weights = [0,0,0,0];
  influences.forEach((influence,i)=>{indices[i]=boneIndices.get(influence.jointId)!;weights[i]=influence.weight;});
  skin.setSplatBones(index,new THREE.Vector4(...indices),new THREE.Vector4(...weights));
 });
 skin.skinTexture.needsUpdate=true; mesh.skinning=skin; mesh.updateGenerator();
 const elastic = elasticity ? createElasticRuntime(mesh,skin,rests,binding.jointIds,joints,elasticity,componentTransforms?.affine) : undefined;
 let transforms=rests.map(()=>new THREE.Matrix4());
 let selection:ReturnType<typeof posedSelection>|undefined, signature="";
 let active: ((index:number)=>boolean) | undefined;
 let disposed=false, appearance:SplatAppearanceRead|undefined;
 const scratch = new THREE.Matrix4();
 function skinMatrix(index:number, matrix:THREE.Matrix4) {
  matrix.elements.fill(0);
  for(let k=0;k<4;k++) {
   const packed=skin.skinData[index*4+k],weight=(packed&255)/255,bone=transforms[packed>>8];
   if(weight&&bone)for(let j=0;j<16;j++)matrix.elements[j]+=weight*bone.elements[j];
  }
  matrix.elements[15]=1;return matrix;
 }
 let componentVersion=componentTransforms?.value;
 function validateIndex(index:number) {
  if(disposed)throw Error("Skin binding has been disposed.");
  if(!Number.isInteger(index)||index<0||index>=componentCount)throw Error("Choose an original splat component index within this object's range.");
 }
 return { componentCount,
 getSkinMatrix(index:number):THREE.Matrix4 {
  validateIndex(index);
  return skinMatrix(index, new THREE.Matrix4());
 },
 get appearancePose() { return signature; },
 applySkinCenter(index:number, center:THREE.Vector3) { center.applyMatrix4(skinMatrix(index, scratch)); },
 setAppearance(next:typeof appearance, changed:boolean) {
  if (appearance !== next || changed) { appearance = next; selection = undefined; }
 },
 setComponentActive(next:typeof active) {
  if (active === next) return;
  active = next; selection = undefined; elastic?.setComponentActive(next);
 },
 getWeights(index:number):SkinInfluence[] {
  validateIndex(index);
  // Elasticity changes original scales, but preserves their rest centers.
  return lookup(index,source.getSplat(index).center.toArray() as Vec3).map(influence=>({...influence}));
 },
 getComponentPositions(indices:number[], ignoreAppearance=false, includeTransparent=false):Float32Array {
  indices.forEach(validateIndex);
  const positions=new Float32Array(indices.length*3),matrix=new THREE.Matrix4();
  indices.forEach((index,output)=>{
   if(active && !active(index)){positions.fill(NaN,output*3,output*3+3);return;}
   const splat=source.getSplat(index);
   const opacity = ignoreAppearance ? splat.opacity : appearance?.opacity(index,splat.opacity) ?? splat.opacity;
   if(!includeTransparent && opacity*(mesh.opacity??1)<mesh.minRaycastOpacity){positions.fill(NaN,output*3,output*3+3);return;}
   // Match Spark and posedSelection, including independently rounded 8-bit weights.
   skinMatrix(index, matrix);
   const affine=componentTransforms?.affine(index);
   if(affine)splat.center.applyMatrix4(affine);
   positions.set(splat.center.applyMatrix4(matrix).toArray(),output*3);
  });
  return positions;
 }, update(boneMatrix:(id:string)=>THREE.Matrix4|undefined) {
  if(componentVersion!==componentTransforms?.value) {
   componentVersion=componentTransforms?.value;selection=undefined;elastic?.invalidate();
  }
  mesh.updateWorldMatrix(true,false);
  const inverse = mesh.matrixWorld.clone().invert();
  const currentMatrices = binding.jointIds.map((id,i)=>{ const matrix=boneMatrix(id); return matrix ? (binding.meshSpace ? matrix.clone() : inverse.clone().multiply(matrix)) : rests[i].clone(); });
  elastic?.update(currentMatrices);
  transforms=currentMatrices.map((m,i)=>m.clone().multiply(inverseRests[i]));
  const next=transforms.map(m=>m.elements.join(",")).join(";")+":"+mesh.extSplats?.numSplats+":"+mesh.opacity;
  if(next!==signature){selection=undefined;signature=next;}
  transforms.forEach((matrix,i)=>skin.setBoneMatrix(i,matrix));
  skin.updateBones();
 }, conservativeBounds(bounds:THREE.Box3) {
  // A weighted point lies within the union of its positive-weight transformed
  // bounds. This avoids reading every splat just to draw a playback selection box.
  const result=new THREE.Box3();
  if (bounds.isEmpty()) return result;
  for(const matrix of transforms)result.union(bounds.clone().applyMatrix4(matrix));
  return result;
 }, selection() { return selection??=posedSelection(mesh,skin,transforms,active,componentTransforms?.affine,appearance); }, dispose() { if(disposed)return;disposed=true;elastic?.dispose(); mesh.skinning=null; mesh.updateGenerator(); skin.skinTexture.dispose();skin.boneTexture.dispose(); } };
}
