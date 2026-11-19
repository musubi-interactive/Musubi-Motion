import { dyno, type SplatMesh } from "@sparkjsdev/spark";
import { Box3, DataTexture, FloatType, Matrix4, Ray, RGBAFormat, Sphere, Vector3, type Raycaster } from "three";
import type { SplatAppearanceRead } from "./splat-appearance-runtime.ts";
import { type SplatComponentTransforms } from "./splat-component-transforms.ts";
import { prepareSplatDeformerEvaluation, type SplatDeformer } from "./splat-deformers.ts";
import type { SplatScalarMask } from "./splat-masks.ts";

import { prepareSplatMorphPose, type SplatMorphPose } from "./splat-morph.ts";

const NO_DEFORMERS: readonly SplatDeformer[] = [];
const NO_MASKS: readonly SplatScalarMask[] = [];

/** One sparse RGBA32F row per edited original: four affine columns; c0.w
 * and c1.w store the low/high 16-bit source index words exactly. Tiling
 * keeps the texture within WebGL2 minimum dimension limits. */
export function createSplatTransformRuntime(mesh: SplatMesh) {
  type Pose = { component?: SplatComponentTransforms; deformers: readonly SplatDeformer[];
    masks: readonly SplatScalarMask[]; frame: number; morph?: SplatMorphPose };
  type Packed = { data: Float32Array<ArrayBuffer>; count: number; direct: boolean; value?: SplatComponentTransforms };
  type Prepared = { pose: Pose; packed: Packed };
  let current: Prepared | undefined, previous: Prepared | undefined, prepared: Prepared | undefined;
  let bound = false, dynamicSource = false, disposed = false;
  let metadata: Float32Array | undefined, metadataReady: Uint8Array | undefined;
  // Exact rest factors for repeatedly queried bounds, allocated only for character-sized sources.
  let boundFactors: Float64Array | undefined;
  const empty: Packed = { data: new Float32Array(4096), count: 0, direct: true };
  let texture = new DataTexture(empty.data, 1024, 1, RGBAFormat, FloatType);
  const sampler = dyno.dynoSampler2D(texture), count = dyno.dynoInt(0), direct = dyno.dynoBool(true);
  const modifier = new dyno.Dyno({
    inTypes: { covsplat: dyno.CovSplat, matrices: "sampler2D", count: "int", direct: "bool" },
    outTypes: { covsplat: dyno.CovSplat }, inputs: { matrices: sampler, count, direct },
    statements: ({ inputs, outputs }) => {
      const s = outputs.covsplat, input = inputs.covsplat, t = inputs.matrices, n = inputs.count;
      return [
        `${s} = ${input};`,
        `if (isCovSplatActive(${s}.flags)) {`,
        ` int lo = ${inputs.direct} ? ${s}.index : 0; int hi = ${inputs.direct} ? lo : ${n};`,
        ` for (int step = 0; step < 18; ++step) {`,
        `  if (lo >= hi) break;`,
        `  int mid = (lo + hi) / 2;`,
        // Split ID into two exact 16-bit words in otherwise unused affine slots.
        `  vec4 key0 = texelFetch(${t}, ivec2((mid % 256) * 4, mid / 256), 0);`,
        `  vec4 key1 = texelFetch(${t}, ivec2((mid % 256) * 4 + 1, mid / 256), 0);`,
        `  int key = int(key0.w) + (int(key1.w) << 16);`,
        `  if (key < ${s}.index) lo = mid + 1; else hi = mid;`,
        ` }`,
        ` if (lo >= 0 && lo < ${n}) {`,
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
  function pose(component: SplatComponentTransforms | undefined, deformers = NO_DEFORMERS, masks = NO_MASKS, frame = 0, morph?: SplatMorphPose): Pose {
    return { component, deformers, masks: deformers.some(d => d.maskId) ? masks : NO_MASKS,
      frame: deformers.some(d => d.keys?.length) ? frame : 0, morph };
  }
  function matches(a: Pose, b: Pose) {
    return a.component === b.component && a.deformers === b.deformers && a.masks === b.masks && a.frame === b.frame &&
      (a.morph === b.morph || a.morph?.surface === b.morph?.surface && a.morph?.weights.length === b.morph?.weights.length &&
        a.morph?.weights.every((weight, i) => weight === b.morph!.weights[i]));
  }
  function cached(next: Pose) {
    if (disposed) throw Error("Splat transform runtime has been disposed.");
    return [prepared, current, previous].find(entry => entry && matches(entry.pose, next));
  }
  function idAt(data: Float32Array, row: number) { return data[row * 16 + 3] + data[row * 16 + 7] * 65536; }
  function readMatrix(data: Float32Array, row: number, target: Matrix4) {
    target.fromArray(data, row * 16);
    target.elements[3] = target.elements[7] = 0;
    return target;
  }
  function lookup(index: number, target?: Matrix4) {
    const packed = current?.packed;
    if (!packed || !packed.count || index < 0) return;
    let row = index;
    if (!packed.direct) {
      let low = 0, high = packed.count;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (idAt(packed.data, mid) < index) low = mid + 1; else high = mid;
      }
      row = low;
    }
    if (row < packed.count && (packed.direct || idAt(packed.data, row) === index)) return readMatrix(packed.data, row, target ?? new Matrix4());
  }
  function compile(next: Pose) {
    const { deformers, component, masks, frame, morph } = next;
    const source = mesh.extSplats ?? mesh.packedSplats;
    const sourceCount = morph?.surface.sourceCount ?? deformers[0]?.sourceCount ?? component?.sourceCount ?? 0;
    const morphAt = morph && prepareSplatMorphPose(morph);
    const evaluated = (deformers.length || morphAt) ? prepareSplatDeformerEvaluation(deformers, masks, component, frame, (index, center) => {
      if (dynamicSource) {
        const s = source!.getSplat(index);
        center.copy(s.center);
        return Math.max(s.scales.x, s.scales.y, s.scales.z);
      }
      metadata ??= new Float32Array(sourceCount * 4);
      metadataReady ??= new Uint8Array(sourceCount);
      const offset = index * 4;
      if (!metadataReady[index]) {
        const s = source!.getSplat(index);
        s.center.toArray(metadata, offset);
        metadata[offset + 3] = Math.max(s.scales.x, s.scales.y, s.scales.z);
        metadataReady[index] = 1;
      }
      center.fromArray(metadata, offset);
      return metadata[offset + 3];
    }, sourceCount, morphAt) : undefined;
    const length = evaluated?.length ?? component?.records.length ?? 0;
    const data = length ? new Float32Array(Math.ceil(length / 256) * 4096) : empty.data;
    let offset = 0, rows = 0, contiguous = true;
    return {
      step(limit: number) {
        for (const end = Math.min(length, offset + limit); offset < end; offset++) {
          const index = evaluated ? evaluated.index(offset) : component!.records[offset].index;
          const elements = evaluated ? evaluated.matrix(index)?.elements : component!.records[offset].matrix;
          if (!elements) continue;
          const start = rows * 16;
          data.set(elements, start);
          data[start + 3] = index & 65535;
          data[start + 7] = index >>> 16;
          contiguous &&= rows === index;
          rows++;
        }
        return offset === length;
      },
      finish(): Prepared {
        if (!rows) return { pose: next, packed: empty };
        // Application consumers only need a pose identity. Materialize archive-style
        // records only when an explicit caller requests them.
        let records: SplatComponentTransforms["records"] | undefined;
        const value: SplatComponentTransforms = !evaluated?.changed && component ? component : {
          version: 1, sourceCount, get records() {
            const matrix = new Matrix4();
            return records ??= Array.from({ length: rows }, (_, row) => ({
              index: idAt(data, row), matrix: readMatrix(data, row, matrix).toArray(),
            }));
          },
        };
        return { pose: next, packed: { data, count: rows, direct: contiguous, value } };
      },
    };
  }
  function preparePose(next: Pose) {
    const hit = cached(next);
    if (hit) return hit;
    const job = compile(next);
    job.step(Infinity);
    return prepared = job.finish();
  }
  return {
    modifier,
    prepare(component: SplatComponentTransforms | undefined, deformers = NO_DEFORMERS, masks = NO_MASKS, frame = 0, morph?: SplatMorphPose) {
      return preparePose(pose(component, deformers, masks, frame, morph)).packed.value;
    },
    async prepareInteractive(component: SplatComponentTransforms | undefined, deformers: readonly SplatDeformer[] | undefined,
      masks: readonly SplatScalarMask[] | undefined, frame: number, morph: SplatMorphPose | undefined, signal: AbortSignal) {
      signal.throwIfAborted();
      const next = pose(component, deformers, masks, frame, morph);
      if (cached(next)) return;
      const job = compile(next);
      do {
        signal.throwIfAborted();
        if (disposed) throw Error("Splat transform runtime has been disposed.");
        const deadline = performance.now() + 4;
        do {
          if (job.step(128)) { prepared = job.finish(); return; }
        } while (performance.now() < deadline);
        // scheduler.yield gives input and rendering a turn even during continuous scrubs.
        const scheduler = (globalThis as { scheduler?: { yield(): Promise<void> } }).scheduler;
        if (scheduler?.yield) await scheduler.yield();
        else await new Promise(resolve => setTimeout(resolve, 0));
      } while (true);
    },
    get value() { return current?.packed.value; },
    affine: lookup,
    update(component: SplatComponentTransforms | undefined, deformers = NO_DEFORMERS, masks = NO_MASKS, frame = 0, morph?: SplatMorphPose) {
      const next = preparePose(pose(component, deformers, masks, frame, morph));
      if (next === current) return false;
      const before = current?.packed.value;
      previous = current;
      current = next;
      prepared = undefined;
      const packed = next.packed;
      if (before === packed.value) return false;
      if (texture.image.height !== packed.data.length / 4096) {
        texture.dispose();
        texture = new DataTexture(packed.data, 1024, packed.data.length / 4096, RGBAFormat, FloatType);
        sampler.value = texture;
      } else texture.image.data = packed.data;
      texture.needsUpdate = true; count.value = packed.count; direct.value = packed.direct;
      mesh.updateVersion();
      return true;
    },
    setBound(next: boolean, elastic = false) {
      if (dynamicSource !== elastic) {
        dynamicSource = elastic;
        metadata = metadataReady = boundFactors = undefined;
        previous = prepared = undefined;
      }
      if (next === bound) return;
      bound = next;
      mesh.covObjectModifiers = mesh.covObjectModifiers?.filter(candidate => candidate !== modifier);
      if (!bound) mesh.covObjectModifiers = [...(mesh.covObjectModifiers ?? []), modifier];
      mesh.updateGenerator();
    },
    positions(indices: readonly number[], appearance?: SplatAppearanceRead, includeTransparent = false) {
      const result = new Float32Array(indices.length * 3);
      const source = mesh.extSplats ?? mesh.packedSplats;
      const center = new Vector3(), matrix = new Matrix4();
      indices.forEach((index, offset) => {
        const splat = source!.getSplat(index);
        center.copy(splat.center);
        const affine = lookup(index, matrix);
        if (affine) center.applyMatrix4(affine);
        if (!includeTransparent && (appearance?.opacity(index, splat.opacity) ?? splat.opacity) * mesh.opacity < mesh.minRaycastOpacity)
          result.fill(NaN, offset * 3, offset * 3 + 3);
        else center.toArray(result, offset * 3);
      });
      return result;
    },
    bounds(active: (index: number) => boolean) {
      const source = mesh.extSplats ?? mesh.packedSplats;
      const result = new Box3(), matrix = new Matrix4(), affine = new Matrix4();
      function expand(index: number, opacity: number) {
        if (!active(index) || opacity * mesh.opacity < mesh.minRaycastOpacity) return;
        if (lookup(index, affine)) matrix.premultiply(affine);
        const e = matrix.elements;
        const rx = 2 * Math.sqrt(e[0]*e[0] + e[4]*e[4] + e[8]*e[8]);
        const ry = 2 * Math.sqrt(e[1]*e[1] + e[5]*e[5] + e[9]*e[9]);
        const rz = 2 * Math.sqrt(e[2]*e[2] + e[6]*e[6] + e[10]*e[10]);
        result.min.set(Math.min(result.min.x, e[12]-rx), Math.min(result.min.y, e[13]-ry), Math.min(result.min.z, e[14]-rz));
        result.max.set(Math.max(result.max.x, e[12]+rx), Math.max(result.max.y, e[13]+ry), Math.max(result.max.z, e[14]+rz));
      }
      if (boundFactors) {
        for (let index = 0; index < boundFactors.length / 16; index++) {
          matrix.fromArray(boundFactors, index * 16);
          const opacity = matrix.elements[3];
          matrix.elements[3] = 0;
          expand(index, opacity);
        }
      } else if (source) {
        if (!dynamicSource && source.numSplats <= 100000) boundFactors = new Float64Array(source.numSplats * 16);
        source.forEachSplat((index, center, scales, rotation, opacity) => {
          matrix.compose(center, rotation, scales);
          if (boundFactors) {
            matrix.toArray(boundFactors, index * 16);
            boundFactors[index * 16 + 3] = opacity;
          }
          expand(index, opacity);
        });
      }
      return result;
    },
    pick(active: (index: number) => boolean, raycaster: Raycaster, appearance?: SplatAppearanceRead) {
      mesh.updateWorldMatrix(true, false);
      const ray = raycaster.ray.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
      const sphere = new Sphere(new Vector3(), 1), hit = new Vector3();
      const affine = new Matrix4(), factor = new Matrix4(), inverse = new Matrix4(), local = new Ray(), size = new Vector3();
      let nearest = Infinity;
      (mesh.extSplats ?? mesh.packedSplats)?.forEachSplat((index, center, scales, rotation, opacity) => {
        if (!active(index) || (appearance?.opacity(index, opacity) ?? opacity) * mesh.opacity < mesh.minRaycastOpacity || Math.min(scales.x, scales.y, scales.z) <= 0) return;
        factor.compose(center, rotation, size.copy(scales).multiplyScalar(2 * (appearance?.scale(index) ?? 1)));
        if (lookup(index, affine)) factor.premultiply(affine);
        if (Math.abs(factor.determinant()) < 1e-24) return;
        local.copy(ray).applyMatrix4(inverse.copy(factor).invert());
        if (!local.intersectSphere(sphere, hit)) return;
        hit.applyMatrix4(factor).applyMatrix4(mesh.matrixWorld);
        const distance = hit.distanceTo(raycaster.ray.origin);
        if (distance >= raycaster.near && distance <= raycaster.far) nearest = Math.min(nearest, distance);
      });
      return nearest;
    },
    dispose() {
      if (disposed) return;
      mesh.covObjectModifiers = mesh.covObjectModifiers?.filter(candidate => candidate !== modifier);
      disposed = true;
      current = previous = prepared = undefined;
      metadata = metadataReady = boundFactors = undefined;
      texture.dispose(); mesh.updateGenerator();
    },
  };
}
export type SplatTransformRuntime = ReturnType<typeof createSplatTransformRuntime>;
