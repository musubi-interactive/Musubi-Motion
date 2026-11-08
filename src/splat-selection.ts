import * as THREE from "three";
import type { SplatMesh, SplatSkinning } from "@sparkjsdev/spark";

// Spark's CPU raycast reads the undeformed asset. Build the same affine
// transforms used by GPU skinning for picking, marquee selection and bounds.
export function posedSelection(mesh:SplatMesh,skin:SplatSkinning,transforms:THREE.Matrix4[],active?:(index:number)=>boolean, affine?:(index:number)=>THREE.Matrix4|undefined) {
  const source=mesh.extSplats!;
  const centers=new Float32Array(source.numSplats*3);
  const bounds=new THREE.Box3();
  const ellipsoids: {inverse:THREE.Matrix4; center:THREE.Vector3; radius:number}[]=[];
  for(let i=0;i<source.numSplats;i++) {
    if (active && !active(i)) { centers.fill(NaN,i*3,i*3+3); continue; }
    const s=source.getSplat(i);
    if(s.opacity*(mesh.opacity??1)<mesh.minRaycastOpacity){centers.fill(NaN,i*3,i*3+3);continue;}
    const m=new THREE.Matrix4();m.elements.fill(0);
    for(let k=0;k<4;k++) {
      const packed=skin.skinData[i*4+k],w=(packed&255)/255,bone=transforms[packed>>8];
      if(w&&bone)for(let j=0;j<16;j++)m.elements[j]+=w*bone.elements[j];
    }
    m.elements[15]=1;
    const rest=affine?.(i);
    const center=s.center.clone();if(rest)center.applyMatrix4(rest);center.applyMatrix4(m);centers.set(center.toArray(),i*3);
    if(rest)m.multiply(rest);
    m.multiply(new THREE.Matrix4().compose(s.center,s.quaternion,s.scales.clone().multiplyScalar(2)));
    const e=m.elements;
    const extent=new THREE.Vector3(Math.hypot(e[0],e[4],e[8]),Math.hypot(e[1],e[5],e[9]),Math.hypot(e[2],e[6],e[10]));
    bounds.expandByPoint(center.clone().add(extent));bounds.expandByPoint(center.clone().sub(extent));
    if(Math.abs(m.determinant())>1e-20)ellipsoids.push({center,radius:extent.length(),inverse:m.invert()});
  }
  return {centers,bounds,pick(raycaster:THREE.Raycaster) {
    mesh.updateWorldMatrix(true,false);
    const localRay=raycaster.ray.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
    const sphere=new THREE.Sphere(new THREE.Vector3(),1),hit=new THREE.Vector3();
    let nearest=Infinity;
    for(const e of ellipsoids) {
      if(localRay.distanceSqToPoint(e.center)>e.radius*e.radius)continue;
      const ray=localRay.clone().applyMatrix4(e.inverse);
      if(!ray.intersectSphere(sphere,hit))continue;
      hit.applyMatrix4(e.inverse.clone().invert()).applyMatrix4(mesh.matrixWorld);
      const distance=hit.distanceTo(raycaster.ray.origin);
      if(distance>=raycaster.near&&distance<=raycaster.far)nearest=Math.min(nearest,distance);
    }
    return nearest;
  }};
}
