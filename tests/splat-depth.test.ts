import type { SparkRenderer } from "@sparkjsdev/spark";
import { strFromU8, unzipSync } from "fflate";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { depthSize, packageDepthImage, readDepthBytes, renderAuthoredDepth } from "../src/splat-depth.ts";

describe("camera depth output", () => {
  it("bounds the larger axis and preserves a usable aspect and dimensions", () => {
    expect(depthSize(4096, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(depthSize(1, 9999)).toEqual({ width: 1, height: 2048 });
    expect(depthSize(640, 480, 500)).toEqual({ width: 500, height: 375 });
    expect(depthSize(320, 200)).toEqual({ width: 320, height: 200 });
  });

  it("stores bottom-first little-endian floats and an explicit camera contract", () => {
    const bytes = new Uint8Array(16), floats = new DataView(bytes.buffer);
    [0, 2.25, 8, 14.125].forEach((value, index) => floats.setFloat32(index * 4, value, true));
    const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 50);
    camera.position.set(1, 3, 5);
    camera.updateMatrixWorld();
    const source = { camera, sceneName: "Study.msb", frame: 18.5, time: 18.5 / 24, view: "front" };
    const files = unzipSync(packageDepthImage(bytes, 2, 2, source));
    const header = "Pf\n2 2\n-1.0\n";
    expect(strFromU8(files["depth.pfm"].subarray(0, header.length))).toBe(header);
    expect(files["depth.pfm"].subarray(header.length)).toEqual(bytes);
    expect(JSON.parse(strFromU8(files["metadata.json"]))).toMatchObject({
      image: "depth.pfm", width: 2, height: 2, background: 0, near: .1, far: 50,
      projection: "orthographic", units: "unitless scene units", splatAlphaThreshold: .5,
      cameraMatrixWorld: camera.matrixWorld.elements, projectionMatrixInverse: camera.projectionMatrixInverse.elements.map(value => value || 0),
      frame: 18.5, scene: "Study.msb", pixelOrder: "left-to-right, bottom-to-top",
    });
    expect(() => packageDepthImage(bytes, 2, 3, source)).toThrow(/size is invalid/);
    expect(() => packageDepthImage(bytes, 8192, 2, source)).toThrow(/size is invalid/);
  });
});

describe("depth render lifecycle", () => {
  it.each([false, true])("restores render state with failure=%s", failure => {
    const camera = new THREE.PerspectiveCamera();
    camera.layers.enable(3);
    const spark = Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, colorWrite: true, forceSinglePass: false,
    })), { minAlpha: .8 }) as unknown as SparkRenderer;
    const splat = new THREE.Object3D(), omitted = new THREE.Object3D();
    splat.layers.set(3);
    omitted.layers.set(2);
    const light = new THREE.HemisphereLight();
    const opaque = new THREE.MeshStandardMaterial(), blended = new THREE.MeshStandardMaterial({ transparent: true });
    const alreadyHidden = new THREE.MeshStandardMaterial({ transparent: true, visible: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), [opaque, blended, alreadyHidden]);
    const guides = new THREE.GridHelper();
    mesh.add(guides);
    const scene = new THREE.Scene();
    scene.add(spark, splat, omitted, light, mesh);
    const background = scene.background = new THREE.Color("#334455");
    const original = new THREE.WebGLRenderTarget(), depth = new THREE.WebGLRenderTarget();
    const targetCalls: Array<unknown[]> = [];
    const renderer = {
      autoClear: false, autoClearDepth: false,
      getRenderTarget: () => original, getActiveCubeFace: () => 2, getActiveMipmapLevel: () => 1,
      setRenderTarget: (...args: unknown[]) => targetCalls.push(args),
      render: () => {
        expect(camera.layers.test(spark.layers)).toBe(true);
        expect(camera.layers.test(splat.layers)).toBe(true);
        expect(camera.layers.test(mesh.layers)).toBe(true);
        expect(camera.layers.test(light.layers)).toBe(true);
        expect(camera.layers.test(omitted.layers)).toBe(false);
        expect(camera.layers.test(guides.layers)).toBe(false);
        expect(spark.minAlpha).toBe(.5);
        expect(spark.material.depthWrite).toBe(true);
        expect(spark.material.colorWrite).toBe(false);
        expect(opaque.visible).toBe(true);
        expect(blended.visible).toBe(false);
        expect(alreadyHidden.visible).toBe(false);
        expect(scene.background).toBeNull();
        expect(renderer.autoClearDepth).toBe(true);
        if (failure) throw Error("draw failed");
      },
    };
    const render = () => renderAuthoredDepth(renderer as unknown as THREE.WebGLRenderer, scene, spark, camera, [
      { kind: "splat", mesh: splat }, { kind: "splat", mesh: omitted }, { kind: "mesh", mesh },
    ], depth);
    if (failure) expect(render).toThrow("draw failed");
    else render();
    expect(targetCalls).toEqual([[depth], [original, 2, 1]]);
    expect(camera.layers.mask).toBe(9);
    expect(splat.layers.mask).toBe(8);
    expect(omitted.layers.mask).toBe(4);
    expect(mesh.layers.mask).toBe(1);
    expect(light.layers.mask).toBe(1);
    expect(spark.minAlpha).toBe(.8);
    expect(spark.material.depthWrite).toBe(false);
    expect(spark.material.colorWrite).toBe(true);
    expect(spark.material.forceSinglePass).toBe(false);
    expect(blended.visible).toBe(true);
    expect(alreadyHidden.visible).toBe(false);
    expect(scene.background).toBe(background);
    expect(renderer.autoClear).toBe(false);
    expect(renderer.autoClearDepth).toBe(false);
  });
});

describe("fenced depth readback", () => {
  function fixture() {
    const buffer = {}, fence = {}, originalBinding = {};
    let currentBinding: object | null = originalBinding;
    const gl = {
      PIXEL_PACK_BUFFER: 1, PIXEL_PACK_BUFFER_BINDING: 2, STREAM_READ: 3, RGBA: 4, UNSIGNED_BYTE: 5,
      SYNC_GPU_COMMANDS_COMPLETE: 6, ALREADY_SIGNALED: 7, WAIT_FAILED: 8, TIMEOUT_EXPIRED: 9,
      createBuffer: vi.fn(() => buffer), fenceSync: vi.fn(() => fence),
      getParameter: vi.fn(() => currentBinding),
      bindBuffer: vi.fn((_target: number, next: object | null) => { currentBinding = next; }),
      bufferData: vi.fn(), readPixels: vi.fn(), flush: vi.fn(),
      getBufferSubData: vi.fn((_target, _offset, data: Uint8Array) => data.set([1, 2, 3, 4])),
      clientWaitSync: vi.fn(() => 7), isContextLost: vi.fn(() => false),
      deleteSync: vi.fn(), deleteBuffer: vi.fn(),
    };
    const abort = new AbortController();
    return {
      gl, originalBinding, abort,
      read: () => readDepthBytes(gl as unknown as WebGL2RenderingContext, 1, 1, abort.signal),
      assertReleased(binding = originalBinding) {
        expect(gl.getParameter()).toBe(binding);
        expect(gl.deleteBuffer).toHaveBeenCalledExactlyOnceWith(buffer);
        expect(gl.deleteSync).toHaveBeenCalledExactlyOnceWith(fence);
      },
    };
  }
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("restores the PBO binding before waiting and preserves another pass's binding after collection", async () => {
    vi.useFakeTimers();
    const test = fixture();
    test.gl.clientWaitSync.mockReturnValueOnce(test.gl.TIMEOUT_EXPIRED);
    const bytes = test.read();
    expect(test.gl.getParameter()).toBe(test.originalBinding);
    const otherPassBinding = {};
    test.gl.bindBuffer(test.gl.PIXEL_PACK_BUFFER, otherPassBinding);
    await vi.advanceTimersByTimeAsync(4);
    expect(await bytes).toEqual(Uint8Array.from([1, 2, 3, 4]));
    test.assertReleased(otherPassBinding);
  });

  it("cleans a canceled fence without collecting bytes or disturbing another pass", async () => {
    vi.useFakeTimers();
    const test = fixture();
    test.gl.clientWaitSync.mockReturnValue(test.gl.TIMEOUT_EXPIRED);
    const rejection = expect(test.read()).rejects.toHaveProperty("name", "AbortError");
    const otherPassBinding = {};
    test.gl.bindBuffer(test.gl.PIXEL_PACK_BUFFER, otherPassBinding);
    test.abort.abort();
    await vi.advanceTimersByTimeAsync(4);
    await rejection;
    expect(test.gl.getBufferSubData).not.toHaveBeenCalled();
    test.assertReleased(otherPassBinding);
  });

  it.each(["wait failure", "context loss", "timeout"] as const)("cleans PBO and sync on %s", async failure => {
    const test = fixture();
    if (failure === "wait failure") test.gl.clientWaitSync.mockReturnValue(test.gl.WAIT_FAILED);
    if (failure === "context loss") test.gl.isContextLost.mockReturnValue(true);
    if (failure === "timeout") {
      vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(8001);
      test.gl.clientWaitSync.mockReturnValue(test.gl.TIMEOUT_EXPIRED);
    }
    await expect(test.read()).rejects.toThrow(failure === "context loss" ? /context was lost/ : /did not finish/);
    expect(test.gl.getBufferSubData).not.toHaveBeenCalled();
    test.assertReleased();
  });
});
