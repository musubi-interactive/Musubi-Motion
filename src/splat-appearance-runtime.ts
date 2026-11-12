import { dyno, type SplatMesh } from "@sparkjsdev/spark";
import { DataTexture, FloatType, Matrix4, RGBAFormat, Vector3 } from "three";
import { GRAPH_LIMITS } from "./procedural-graph.ts";
import type { GraphProgram, PixelSource } from "./procedural-graph-runtime.ts";
import type { SplatAppearanceStack } from "./splat-appearance.ts";
import { APPEARANCE_LIMITS, createSplatAppearanceEvaluator, SPLAT_APPEARANCE_STRIDE } from "./splat-appearance.ts";
import type { SplatScalarMask } from "./splat-masks.ts";
import type { SplatComponentTransforms } from "./splat-component-transforms.ts";
import type { TextureAsset } from "./texture-assets.ts";

export type SplatAppearanceRead = {
  opacity(index: number, source: number): number;
  scale(index: number): number;
};
type Evaluation = {
  stack: SplatAppearanceStack;
  masks: readonly SplatScalarMask[];
  graph: GraphProgram;
  images: ReadonlyMap<string, PixelSource>;
  frame: number;
  fps: number;
  transforms?: SplatComponentTransforms;
  affine: (index: number) => Matrix4 | undefined;
  skinRevision?: string;
  skinCenter?: (index: number, position: Vector3) => void;
};

/** Read straight RGBA through the same bitmap upload semantics as the graph preview.
 * A 2D canvas roundtrip can lose RGB underneath transparent image pixels. */
export async function decodeSplatAppearanceImages(assets: readonly TextureAsset[], current: () => boolean = () => true) {
  const pixels = new Map<string, PixelSource>();
  if (!assets.length) return pixels;
  if (assets.reduce((sum, asset) => sum + asset.width * asset.height, 0) > GRAPH_LIMITS.pixels)
    throw Error("Splat appearance image pixel budget exceeded.");
  const canvas = document.createElement("canvas"), gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) throw Error("Splat appearance image sampling requires WebGL2.");
  const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
  try {
    if (!texture || !framebuffer) throw Error("Could not allocate appearance image staging.");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    for (const asset of assets) {
      if (!current()) throw new DOMException("Appearance image decoding was superseded.", "AbortError");
      const bitmap = await createImageBitmap(await (await fetch(asset.dataURI)).blob(), {
        colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "none",
      });
      try {
        if (!current()) throw new DOMException("Appearance image decoding was superseded.", "AbortError");
        const { width, height } = asset;
        if (bitmap.width !== width || bitmap.height !== height ||
          Math.max(width, height) > gl.getParameter(gl.MAX_TEXTURE_SIZE))
          throw Error("Unsupported appearance image dimensions for " + asset.name + ".");
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw Error("Could not stage appearance image " + asset.name + ".");
        const rgba = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        if (gl.getError() !== gl.NO_ERROR) throw Error("Could not read appearance image " + asset.name + ".");
        pixels.set(asset.id, { width, height, rgba });
      } finally { bitmap.close(); }
    }
    return pixels;
  } finally {
    gl.deleteTexture(texture); gl.deleteFramebuffer(framebuffer);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export function createSplatAppearanceRuntime(mesh: SplatMesh, sourceCount: number) {
  const source = mesh.extSplats ?? mesh.packedSplats;
  if (!source || source.numSplats < sourceCount || sourceCount > APPEARANCE_LIMITS.sourceCount)
    throw Error("Appearance requires a loaded original splat source with a supported count.");
  // Two adjacent RGBA32F texels per original, with no row crossings.
  const width = Math.min(1024, sourceCount * 2), height = Math.ceil(sourceCount * 2 / width);
  let texels = new Float32Array(width * height * 4), staging = new Float32Array(texels.length);
  const texture = new DataTexture(texels, width, height, RGBAFormat, FloatType);
  const map = dyno.dynoSampler2D(texture), count = dyno.dynoInt(sourceCount);
  const modifier = new dyno.Dyno({
    inTypes: { gsplat: dyno.Gsplat, map: "sampler2D", count: "int" },
    outTypes: { gsplat: dyno.Gsplat }, inputs: { map, count },
    statements: ({ inputs, outputs }) => {
      const splat = outputs.gsplat, texture = inputs.map;
      return [
        `${splat} = ${inputs.gsplat};`,
        `if (isGsplatActive(${splat}.flags) && ${splat}.index >= 0 && ${splat}.index < ${inputs.count}) {`,
        `  int offset = ${splat}.index * 2;`,
        `  int width = textureSize(${texture}, 0).x;`,
        "  ivec2 pixel = ivec2(offset % width, offset / width);",
        `  vec4 color = texelFetch(${texture}, pixel, 0);`,
        `  vec2 factors = texelFetch(${texture}, pixel + ivec2(1, 0), 0).xy;`,
        // Spark's fetched and returned RGB use its sRGB convention. Decode for
        // the layer mix and preserve the exact fetched value at zero coverage.
        "  if (color.a < 1.0) {",
        `    vec3 rgb = max(${splat}.rgba.rgb, 0.0);`,
        "    vec3 linear = mix(pow((rgb + 0.055) / 1.055, vec3(2.4)), rgb / 12.92, lessThanEqual(rgb, vec3(0.04045)));",
        "    linear = linear * color.a + color.rgb;",
        `    ${splat}.rgba.rgb = mix(1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055, linear * 12.92, lessThanEqual(linear, vec3(0.0031308)));`,
        "  }",
        `  ${splat}.rgba.a *= factors.x;`,
        `  ${splat}.scales *= factors.y;`,
        "}",
      ];
    },
  });
  let previous: Evaluation | undefined;
  const lastWorld = new Matrix4();
  let disposed = false, boundsMargin = 0;
  const runtime = {
    get boundsMargin() { return boundsMargin; },
    opacity(index: number, opacity: number) {
      return opacity * (previous && index < sourceCount ? texels[index * SPLAT_APPEARANCE_STRIDE + 4] : 1);
    },
    scale(index: number) {
      return previous && index < sourceCount ? texels[index * SPLAT_APPEARANCE_STRIDE + 5] : 1;
    },
    update(next: Evaluation) {
      if (disposed) return false;
      const worldSpace = next.stack.layers.some(layer => layer.enabled && layer.blend > 0 && layer.space === "world");
      if (worldSpace) mesh.updateWorldMatrix(true, false);
      if (previous && previous.stack === next.stack && previous.masks === next.masks &&
        previous.graph === next.graph && previous.images === next.images && previous.transforms === next.transforms &&
        (!next.graph.animated || previous.frame === next.frame && previous.fps === next.fps) &&
        (!worldSpace || previous.skinRevision === next.skinRevision && lastWorld.equals(mesh.matrixWorld))) return false;
      const evaluate = createSplatAppearanceEvaluator(next.stack.layers, next.masks, next.graph, next.images, next.frame, next.fps);
      const local = new Vector3(), world = new Vector3();
      let margin = 0;
      // Elastic fill is appended by Spark. Texture layers address originals only.
      source.forEachSplat((index, center, scales) => {
        if (index >= sourceCount) return;
        local.copy(center);
        const affine = next.affine(index);
        if (affine) local.applyMatrix4(affine);
        if (worldSpace) {
          world.copy(local);
          next.skinCenter?.(index, world);
          world.applyMatrix4(mesh.matrixWorld);
        }
        evaluate(index, local, world, staging);
        const increase = staging[index * SPLAT_APPEARANCE_STRIDE + 5] - 1;
        if (increase > 0) {
          // Frobenius upper bound for authored affine shear, in edited local space.
          const stretch = affine ? Math.sqrt(3) * affine.getMaxScaleOnAxis() : 1;
          margin = Math.max(margin, 2 * increase * scales.length() * stretch);
        }
      });
      if (!previous) {
        mesh.objectModifiers = [...(mesh.objectModifiers ?? []), modifier];
        mesh.updateGenerator();
      }
      if (worldSpace) lastWorld.copy(mesh.matrixWorld);
      [texels, staging] = [staging, texels];
      texture.image.data = texels;
      previous = next; boundsMargin = margin;
      texture.needsUpdate = true; mesh.updateVersion();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.objectModifiers = mesh.objectModifiers?.filter(candidate => candidate !== modifier);
      mesh.updateGenerator(); texture.dispose();
    },
  };
  return runtime;
}
export type SplatAppearanceRuntime = ReturnType<typeof createSplatAppearanceRuntime>;
