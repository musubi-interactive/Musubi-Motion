import type { SparkRenderer } from "@sparkjsdev/spark";
import * as THREE from "three";
import { strToU8, zipSync } from "fflate";

export const SPLAT_DEPTH_ALPHA = .5;
export const MAX_DEPTH_EDGE = 2048;
const DEPTH_LAYER = 31;

export type DepthCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
type DepthObject = { kind: string; mesh: THREE.Object3D };
type DepthCapture = {
  sceneName: string;
  frame: number;
  time: number;
  view: string;
  camera: DepthCamera;
};

export function depthSize(width: number, height: number, limit = MAX_DEPTH_EDGE) {
  const scale = Math.min(1, limit / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function packageDepthImage(pixels: Uint8Array, width: number, height: number, source: DepthCapture) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_DEPTH_EDGE || height > MAX_DEPTH_EDGE || pixels.byteLength !== width * height * 4) {
    throw Error("The depth image size is invalid.");
  }
  const { camera, frame, time, view, sceneName } = source;
  const header = strToU8(`Pf\n${width} ${height}\n-1.0\n`);
  const pfm = new Uint8Array(header.length + pixels.length);
  pfm.set(header);
  pfm.set(pixels, header.length);
  const metadata = {
    format: "musubi-camera-depth", version: 1,
    image: "depth.pfm", width, height, pixelOrder: "left-to-right, bottom-to-top", pixelCenters: "half-integer",
    encoding: "single-channel IEEE 754 float32 little-endian",
    quantity: "positive camera-axis distance (-view Z)", units: "unitless scene units",
    background: 0, near: camera.near, far: camera.far,
    scene: sceneName, frame, timeSeconds: time, view,
    projection: "isPerspectiveCamera" in camera ? "perspective" : "orthographic",
    matrixOrder: "column-major", cameraMatrixWorld: camera.matrixWorld.toArray(),
    projectionMatrix: camera.projectionMatrix.toArray(),
    projectionMatrixInverse: camera.projectionMatrixInverse.toArray(),
    splatConvention: "nearest projected Gaussian center with individual effective fragment alpha at or above threshold",
    splatAlphaThreshold: SPLAT_DEPTH_ALPHA,
    meshConvention: "depth-writing opaque and alpha-cutout polygons; opacity-blended materials excluded",
  };
  return zipSync({ "depth.pfm": pfm, "metadata.json": strToU8(JSON.stringify(metadata, null, 2) + "\n") }, { level: 0 });
}

const vertexShader = /* glsl */ `
out vec2 pixelUv;
void main() {
  pixelUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D depthTexture;
uniform bool perspective;
uniform bool packFloats;
uniform float nearClip;
uniform float farClip;
uniform float referenceDistance;
in vec2 pixelUv;
out vec4 result;

void main() {
  float z = texture(depthTexture, pixelUv).r;
  float depth = 0.0;
  if (z < 1.0) {
    depth = perspective ? nearClip / ((1.0 - z) + z * nearClip / farClip) : mix(nearClip, farClip, z);
  }
  if (packFloats) {
    uint bits = floatBitsToUint(depth);
    result = vec4(uvec4(bits, bits >> 8u, bits >> 16u, bits >> 24u) & 255u) / 255.0;
  } else {
    float shade = depth > 0.0 ? 0.12 + 0.88 / (1.0 + depth / referenceDistance) : 0.02;
    result = vec4(vec3(shade), 1.0);
  }
}`;

export async function readDepthBytes(gl: WebGL2RenderingContext, width: number, height: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const buffer = gl.createBuffer();
  if (!buffer) throw Error("Could not allocate a depth readback buffer.");
  let fence: WebGLSync | null = null;
  try {
    const bytes = new Uint8Array(width * height * 4);
    // Spark also uses PBOs. Keep the binding unchanged across every async wait.
    const issueBinding = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    try {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes.byteLength, gl.STREAM_READ);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    } finally {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, issueBinding);
    }
    if (!fence) throw Error("Could not start GPU depth readback.");
    gl.flush();
    const deadline = performance.now() + 8000;
    for (;;) {
      signal.throwIfAborted();
      if (gl.isContextLost()) throw Error("The graphics context was lost during depth export.");
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.WAIT_FAILED || performance.now() > deadline) throw Error("The GPU depth readback did not finish.");
      if (status !== gl.TIMEOUT_EXPIRED) break;
      await new Promise(resolve => setTimeout(resolve, 4));
    }
    const readBinding = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    try {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, bytes);
    } finally {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, readBinding);
    }
    return bytes;
  } finally {
    if (fence) gl.deleteSync(fence);
    gl.deleteBuffer(buffer);
  }
}

export function renderAuthoredDepth(
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, spark: SparkRenderer,
  camera: DepthCamera, objects: Iterable<DepthObject>, target: THREE.WebGLRenderTarget,
) {
  const originalCameraLayers = camera.layers.mask;
  const objectLayers = new Map<THREE.Object3D, number>();
  const excludedMaterials = new Set<THREE.Material>();
  const { depthWrite, colorWrite, forceSinglePass } = spark.material;
  const { autoClear, autoClearDepth } = renderer;
  const { minAlpha } = spark;
  const background = scene.background;
  const previousTarget = renderer.getRenderTarget();
  const previousFace = renderer.getActiveCubeFace();
  const previousLevel = renderer.getActiveMipmapLevel();
  function include(object: THREE.Object3D) {
    if (objectLayers.has(object) || (object.layers.mask & originalCameraLayers) === 0) return;
    objectLayers.set(object, object.layers.mask);
    object.layers.enable(DEPTH_LAYER);
  }
  try {
    include(spark);
    for (const child of scene.children) if (child instanceof THREE.Light) include(child);
    for (const { kind, mesh } of objects) {
      if (kind === "splat") include(mesh);
      if (kind !== "mesh" || !(mesh instanceof THREE.Mesh)) continue;
      include(mesh);
      const materials: THREE.Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) if (material.visible && (material.transparent || !material.depthWrite)) {
        excludedMaterials.add(material);
        material.visible = false;
      }
    }
    camera.layers.set(DEPTH_LAYER);
    spark.minAlpha = SPLAT_DEPTH_ALPHA;
    spark.material.depthWrite = true;
    spark.material.colorWrite = false;
    spark.material.forceSinglePass = true;
    scene.background = null;
    renderer.autoClear = renderer.autoClearDepth = true;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  } finally {
    renderer.autoClear = autoClear;
    renderer.autoClearDepth = autoClearDepth;
    scene.background = background;
    spark.minAlpha = minAlpha;
    Object.assign(spark.material, { depthWrite, colorWrite, forceSinglePass });
    for (const material of excludedMaterials) material.visible = true;
    for (const [object, mask] of objectLayers) object.layers.mask = mask;
    camera.layers.mask = originalCameraLayers;
    renderer.setRenderTarget(previousTarget, previousFace, previousLevel);
  }
}

/** Reuses Spark's evaluated live accumulation. Owns only framebuffer and display resources. */
export function createSplatDepthPass(renderer: THREE.WebGLRenderer, scene: THREE.Scene, spark: SparkRenderer) {
  const depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  const target = new THREE.WebGLRenderTarget(1, 1, { depthTexture });
  const quad = new THREE.PlaneGeometry(2, 2);
  const uniforms = {
    depthTexture: { value: depthTexture }, perspective: { value: true }, packFloats: { value: false },
    nearClip: { value: .01 }, farClip: { value: 1000 }, referenceDistance: { value: 1 },
  };
  const shader = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader, fragmentShader, uniforms,
    depthWrite: false, depthTest: false, blending: THREE.NoBlending, toneMapped: false,
  });
  const fullscreen = new THREE.Scene(), screenCamera = new THREE.Camera();
  const surface = new THREE.Mesh(quad, shader);
  surface.frustumCulled = false;
  fullscreen.add(surface);
  const canvasSize = new THREE.Vector2(), targetInView = new THREE.Vector3();

  function drawOutput(output: THREE.WebGLRenderTarget | null, camera: DepthCamera, packFloats: boolean, referenceDistance: number) {
    uniforms.perspective.value = "isPerspectiveCamera" in camera;
    uniforms.packFloats.value = packFloats;
    uniforms.nearClip.value = camera.near;
    uniforms.farClip.value = camera.far;
    uniforms.referenceDistance.value = referenceDistance;
    renderer.setRenderTarget(output);
    renderer.render(fullscreen, screenCamera);
  }

  return {
    render(camera: DepthCamera, objects: Iterable<DepthObject>) {
      renderer.getDrawingBufferSize(canvasSize);
      const size = depthSize(canvasSize.x, canvasSize.y, Math.min(MAX_DEPTH_EDGE, renderer.capabilities.maxTextureSize));
      target.setSize(size.width, size.height);
      renderAuthoredDepth(renderer, scene, spark, camera, objects, target);
    },
    present(camera: DepthCamera, orbitTarget: THREE.Vector3) {
      const reference = Math.max(camera.near, -targetInView.copy(orbitTarget).applyMatrix4(camera.matrixWorldInverse).z);
      const previous = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), level = renderer.getActiveMipmapLevel();
      try { drawOutput(null, camera, false, reference); }
      finally { renderer.setRenderTarget(previous, face, level); }
    },
    get ready() {
      return !spark.sorting && !spark.sortDirty && spark.display === spark.current;
    },
    async capture(source: DepthCapture, signal: AbortSignal) {
      const { width, height } = target;
      const camera = source.camera.clone();
      const packed = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
      const previous = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), level = renderer.getActiveMipmapLevel();
      try {
        let readback: Promise<Uint8Array>;
        try {
          drawOutput(packed, camera, true, 1);
          readback = readDepthBytes(renderer.getContext() as WebGL2RenderingContext, width, height, signal);
        } finally {
          renderer.setRenderTarget(previous, face, level);
        }
        const pixels = await readback;
        signal.throwIfAborted();
        return packageDepthImage(pixels, width, height, { ...source, camera });
      } finally {
        packed.dispose();
      }
    },
    dispose() {
      target.dispose();
      quad.dispose();
      shader.dispose();
    },
  };
}
