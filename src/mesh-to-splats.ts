import { buildSplatMorphSurface } from "./splat-morph.ts";
import { Color, Matrix4, Quaternion, Vector3 } from "three";
import { triangulateMesh, validateMeshShape } from "./mesh-modeling";
import { validateMeshSkin } from "./mesh-skin";
import { validateSkinWeights } from "./skin-weights";
import type { MeshShapeNode, SkinBinding, SkinInfluence } from "./scene-document";
import type { CubeSplatSettings } from "./cube-to-splats";
export type SurfaceSample = { vertices: [string,string,string]; bary: [number,number,number]; materialIndex: number };
export function interpolateSplatWeights(shape: MeshShapeNode, sample: SurfaceSample): SkinInfluence[] {
  const skin = shape.skin!; const merged = new Map<number, number>();
  sample.vertices.forEach((id, i) => skin.weights[id].forEach(({joint,weight}) => merged.set(joint, (merged.get(joint) ?? 0) + sample.bary[i] * weight)));
  const strongest = [...merged].filter(([,w]) => w > 0).sort((a,b) => b[1]-a[1]).slice(0,4), total = strongest.reduce((sum,[,w])=>sum+w,0);
  return strongest.map(([joint,weight])=>({jointId:skin.jointIds[joint],weight:weight/total}));
}
function radical(n: number, base: number) { let result = 0, f = 1/base; while(n) { result += (n % base)*f; n = Math.floor(n/base); f /= base; } return result; }
/** Sample undeformed geometry, retaining stable order for the persisted bone weights. */
export function meshToSplatData(shape: MeshShapeNode, settings: CubeSplatSettings, count: number, colorAt?: (sample: SurfaceSample) => Color | { color: Color; opacity: number }) {
  validateMeshShape(shape); validateMeshSkin(shape);
  const runs: { end: number; ids: readonly string[] }[] = [];
  if (!Number.isInteger(count) || count < 256 || count > 100000) throw Error("Choose between 256 and 100,000 splats per part.");
  if (![settings.overlap,settings.thickness,settings.opacity].every(Number.isFinite) || settings.overlap < .3 || settings.overlap > 1.2 || settings.thickness < .01 || settings.thickness > .5 || settings.opacity < .1 || settings.opacity > 1) throw Error("Invalid splat settings.");
  if (shape.skin && shape.skin.jointIds.length > 256) throw Error("Splat skinning supports at most 256 joints per part.");
  const geometry = triangulateMesh(shape), faces = new Map(shape.faces.map(f=>[f.id,f]));
  let area = 0;
  const triangles = geometry.triangleFaceIds.map((faceId,i) => {
    const indices = geometry.indices.slice(i*3,i*3+3), vertices = indices.map(j=>shape.vertices[j]);
    const [a,b,c] = vertices.map(v=>new Vector3(...v.position)), u = b.clone().sub(a), v = c.clone().sub(a), cross = u.clone().cross(v);
    area += cross.length()*.5;
    return {vertices:vertices.map(v=>v.id) as SurfaceSample["vertices"],a,b,c,normal:cross.normalize(),tangent:u.normalize(),end:area,materialIndex:faces.get(faceId)!.materialIndex ?? 0};
  });
  if (!area || !Number.isFinite(area)) throw Error("Mesh contains no usable surface.");
  const bytes = new Uint8Array(count*32), view = new DataView(bytes.buffer), spacing = Math.sqrt(area/count), light = new Vector3(-.4,.8,1).normalize();
  const overrides: Record<string,SkinInfluence[]> = {};
  let triangleIndex = 0, retained = 0;
  for(let i=0;i<count;i++) {
    const target = (i+.5)/count*area;
    while(triangleIndex < triangles.length-1 && triangles[triangleIndex].end < target) triangleIndex++;
    const t = triangles[triangleIndex], r = Math.sqrt(radical(i+1,2)), s = radical(i+1,3), bary: SurfaceSample["bary"] = [1-r,r*(1-s),r*s];
    const sample = {vertices:t.vertices,bary,materialIndex:t.materialIndex};
    const appearance = colorAt?.(sample) ?? new Color(shape.color);
    const surface = appearance instanceof Color ? { color: appearance, opacity: 1 } : appearance;
    if (!Number.isFinite(surface.opacity) || surface.opacity < 0 || surface.opacity > 1) throw Error("Sampled opacity must be between zero and one.");
    const opacityByte = Math.round(surface.opacity * settings.opacity * 255);
    if (opacityByte === 0) continue;
    const p = t.a.clone().multiplyScalar(bary[0]).addScaledVector(t.b,bary[1]).addScaledVector(t.c,bary[2]);
    const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(t.tangent,t.normal.clone().cross(t.tangent),t.normal));
    const color = surface.color.clone().multiplyScalar(settings.shading ? .35+.65*Math.max(0,t.normal.dot(light)) : 1).convertLinearToSRGB();
    const offset = retained*32;
    [p.x,p.y,p.z,spacing*settings.overlap,spacing*settings.overlap,spacing*settings.thickness].forEach((value,j)=>view.setFloat32(offset+j*4,value,true));
    [color.r,color.g,color.b,opacityByte/255].forEach((value,j)=>{bytes[offset+24+j]=Math.round(Math.max(0,Math.min(1,value))*255);});
    [q.w,q.x,q.y,q.z].forEach((value,j)=>{bytes[offset+28+j]=Math.max(0,Math.min(255,Math.round(value*128+128)));});
    if(shape.skin) overrides[String(retained)] = interpolateSplatWeights(shape,sample);
    retained++;
    if (shape.morphTargets?.length) {
      if (runs.at(-1)?.ids === t.vertices) runs[runs.length - 1].end = retained;
      else runs.push({ end: retained, ids: t.vertices });
    }
  }
  if (!retained) throw Error("No visible surface samples remain after opacity and alpha cutoff. Check the material or increase the sample budget.");
  const binding: SkinBinding | undefined = shape.skin ? {meshSpace:true,jointIds:[...shape.skin.jointIds],restMatrices:shape.skin.inverseBindMatrices.map(m=>new Matrix4().fromArray(m).invert().toArray()),weights:{count:retained,overrides}} : undefined;
  if(binding) validateSkinWeights(binding);
  return {bytes:bytes.slice(0,retained*32),binding, ...(runs.length ? {
    morphSurface: buildSplatMorphSurface(shape, runs),
    morphTargets: shape.morphTargets!.map(({name, weight}) => ({ name, weight })),
  } : {})};
}
