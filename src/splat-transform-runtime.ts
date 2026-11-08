import { dyno, type SplatMesh } from "@sparkjsdev/spark";
import { Box3, DataTexture, FloatType, Matrix4, Ray, RGBAFormat, Sphere, Vector3, type Raycaster } from "three";
import { componentTransformLookup, gaussianBounds, gaussianFactor, type SplatComponentTransforms } from "./splat-component-transforms.ts";

/** One sparse RGBA32F row per edited original: four affine columns; c0.w
 * and c1.w store the low/high 16-bit source index words exactly. Tiling
 * keeps the texture within WebGL2 minimum dimension limits. */
export function createSplatTransformRuntime(mesh: SplatMesh) {
  let value: SplatComponentTransforms | undefined, bound = false;
  let lookup = componentTransformLookup();
  let texture = new DataTexture(new Float32Array(4096), 1024, 1, RGBAFormat, FloatType);
  const sampler = dyno.dynoSampler2D(texture), count = dyno.dynoInt(0);
  const modifier = new dyno.Dyno({
    inTypes: { covsplat: dyno.CovSplat, matrices: "sampler2D", count: "int" },
    outTypes: { covsplat: dyno.CovSplat }, inputs: { matrices: sampler, count },
    statements: ({ inputs, outputs }) => {
      const s = outputs.covsplat, input = inputs.covsplat, t = inputs.matrices, n = inputs.count;
      return [
        `${s} = ${input};`,
        `if (isCovSplatActive(${s}.flags)) {`,
        ` int lo = 0; int hi = ${n};`,
        ` for (int step = 0; step < 18; ++step) {`,
        `  if (lo >= hi) break;`,
        `  int mid = (lo + hi) / 2;`,
        // Split ID into two exact 16-bit words in otherwise unused affine slots.
        `  vec4 key0 = texelFetch(${t}, ivec2((mid % 256) * 4, mid / 256), 0);`,
        `  vec4 key1 = texelFetch(${t}, ivec2((mid % 256) * 4 + 1, mid / 256), 0);`,
        `  int key = int(key0.w) + (int(key1.w) << 16);`,
        `  if (key < ${s}.index) lo = mid + 1; else hi = mid;`,
        ` }`,
        ` if (lo < ${n}) {`,
        `  vec4 c0 = texelFetch(${t}, ivec2((lo % 256) * 4, lo / 256), 0);`,
        `  vec4 c1 = texelFetch(${t}, ivec2((lo % 256) * 4 + 1, lo / 256), 0);`,
        `  int key = int(c0.w) + (int(c1.w) << 16);`,
        `  if (key == ${s}.index) {`,
        `   vec3 c2 = texelFetch(${t}, ivec2((lo % 256) * 4 + 2, lo / 256), 0).xyz;`,
        `   vec3 c3 = texelFetch(${t}, ivec2((lo % 256) * 4 + 3, lo / 256), 0).xyz;`,
        `   mat3 a = mat3(c0.xyz, c1.xyz, c2);`,
        `   vec3 diagonal = ${s}.xxyyzz; vec3 off = ${s}.xyxzyz;`,
        `   mat3 covariance = mat3(diagonal.x, off.x, off.y, off.x, diagonal.y, off.z, off.y, off.z, diagonal.z);`,
        `   covariance = a * covariance * transpose(a);`,
        `   ${s}.center = a * ${s}.center + c3;`,
        `   ${s}.xxyyzz = vec3(covariance[0][0], covariance[1][1], covariance[2][2]);`,
        `   ${s}.xyxzyz = vec3(covariance[0][1], covariance[0][2], covariance[1][2]);`,
        `  }`,
        ` }`,
        `}`,
      ];
    },
  });
  mesh.covObjectModifiers = [...(mesh.covObjectModifiers ?? []), modifier];
  mesh.updateGenerator();
  return {
    modifier,
    get value() { return value; },
    affine(index: number) { return lookup(index); },
    update(next: SplatComponentTransforms | undefined) {
      if (value === next) return;
      value = next; lookup = componentTransformLookup(next);
      const data = new Float32Array(Math.max(1, Math.ceil((next?.records.length ?? 0) / 256)) * 4096);
      next?.records.forEach((record, row) => {
        data.set(record.matrix, row * 16);
        data[row * 16 + 3] = record.index & 65535;
        data[row * 16 + 7] = record.index >>> 16;
      });
      texture.dispose();
      texture = new DataTexture(data, 1024, data.length / 4096, RGBAFormat, FloatType);
      texture.needsUpdate = true; sampler.value = texture; count.value = next?.records.length ?? 0;
      mesh.updateVersion();
    },
    setBound(next: boolean) {
      if (next === bound) return;
      bound = next;
      mesh.covObjectModifiers = mesh.covObjectModifiers?.filter(candidate => candidate !== modifier);
      if (!bound) mesh.covObjectModifiers = [...(mesh.covObjectModifiers ?? []), modifier];
      mesh.updateGenerator();
    },
    positions(indices: readonly number[]) {
      const result = new Float32Array(indices.length * 3);
      const source = mesh.extSplats ?? mesh.packedSplats;
      indices.forEach((index, offset) => {
        const splat = source!.getSplat(index);
        const center = splat.center.clone(), affine = lookup(index);
        if (affine) center.applyMatrix4(affine);
        result.set(splat.opacity * mesh.opacity < mesh.minRaycastOpacity ? [NaN, NaN, NaN] : center.toArray(), offset * 3);
      });
      return result;
    },
    bounds(active: (index: number) => boolean) {
      const result = new Box3();
      (mesh.extSplats ?? mesh.packedSplats)?.forEachSplat((index, center, scales, rotation, opacity) => {
        if (active(index) && opacity * mesh.opacity >= mesh.minRaycastOpacity)
          result.union(gaussianBounds(gaussianFactor(center, scales, rotation, lookup(index)), 2));
      });
      return result;
    },
    pick(active: (index: number) => boolean, raycaster: Raycaster) {
      mesh.updateWorldMatrix(true, false);
      const ray = raycaster.ray.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
      const sphere = new Sphere(new Vector3(), 1), hit = new Vector3();
      let nearest = Infinity;
      (mesh.extSplats ?? mesh.packedSplats)?.forEachSplat((index, center, scales, rotation, opacity) => {
        if (!active(index) || opacity * mesh.opacity < mesh.minRaycastOpacity || Math.min(...scales.toArray()) <= 0) return;
        const factor = gaussianFactor(center, scales.clone().multiplyScalar(2), rotation, lookup(index));
        if (Math.abs(factor.determinant()) < 1e-24) return;
        const local = new Ray().copy(ray).applyMatrix4(factor.clone().invert());
        if (!local.intersectSphere(sphere, hit)) return;
        hit.applyMatrix4(factor).applyMatrix4(mesh.matrixWorld);
        const distance = hit.distanceTo(raycaster.ray.origin);
        if (distance >= raycaster.near && distance <= raycaster.far) nearest = Math.min(nearest, distance);
      });
      return nearest;
    },
    dispose() {
      mesh.covObjectModifiers = mesh.covObjectModifiers?.filter(candidate => candidate !== modifier);
      texture.dispose(); mesh.updateGenerator();
    },
  };
}
export type SplatTransformRuntime = ReturnType<typeof createSplatTransformRuntime>;
