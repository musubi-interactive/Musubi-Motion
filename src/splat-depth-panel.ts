import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type { SparkRenderer } from "@sparkjsdev/spark";
import type { Scene, Vector3, WebGLRenderer, Object3D } from "three";
import type { SceneDocument } from "./scene-document.ts";
import { createSplatDepthPass, type DepthCamera } from "./splat-depth.ts";

type Frame = {
  document: SceneDocument;
  sceneName: string;
  frame: number;
  time: number;
  view: string;
  camera: DepthCamera;
  orbitTarget: Vector3;
  available: boolean;
};
type Request = {
  document: SceneDocument;
  frame: number;
  camera: DepthCamera;
  view: string;
  abort: AbortController;
  expires: number;
  reading: boolean;
};

export function createSplatDepthPanel(options: {
  menu: WaDropdown;
  renderer: WebGLRenderer;
  world: Scene;
  spark: SparkRenderer;
  getFrame(): Frame;
  objects(): Iterable<{ kind: string; mesh: Object3D }>;
  report(message: string): void;
}) {
  function item(id: string, label: string) {
    const result = document.createElement("wa-dropdown-item");
    result.id = id;
    result.textContent = label;
    options.menu.append(result);
    return result;
  }
  const previewItem = item("view-camera-depth", "Camera Depth");
  previewItem.type = "checkbox";
  const exportItem = item("export-camera-depth", "Export Camera Depth");
  const cancelItem = item("cancel-camera-depth-export", "Cancel Depth Export");
  cancelItem.hidden = true;
  let pass: ReturnType<typeof createSplatDepthPass> | undefined;
  let pending: Request | undefined;
  let disposed = false;
  let releaseDownload: (() => void) | undefined;

  function sync(available: boolean) {
    previewItem.disabled = disposed;
    exportItem.disabled = disposed || !available || !!pending;
    cancelItem.hidden = !pending;
    cancelItem.disabled = disposed || !pending || pending.abort.signal.aborted;
  }

  function cancel(message = "Depth export canceled.") {
    if (!pending || pending.abort.signal.aborted) return false;
    pending.abort.abort();
    if (!pending.reading) pending = undefined;
    sync(options.getFrame().available);
    options.report(message);
    return true;
  }

  options.menu.addEventListener("wa-select", event => {
    const { item } = event.detail;
    if (item === cancelItem) cancel();
    if (item !== exportItem || pending || disposed) return;
    const frame = options.getFrame();
    if (!frame.available) return;
    pending = {
      document: frame.document, frame: frame.frame, camera: frame.camera, view: frame.view,
      abort: new AbortController(), expires: performance.now() + 8000, reading: false,
    };
    sync(frame.available);
    options.report("Preparing camera depth export…");
  });

  function matches(request: Request, frame: Frame) {
    return frame.available && frame.document === request.document && frame.camera === request.camera
      && frame.view === request.view && frame.frame === request.frame;
  }

  function download(bytes: Uint8Array<ArrayBuffer>, name: string) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    try {
      link.click();
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    } finally {
      link.remove();
    }
    releaseDownload?.();
    function release() {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      releaseDownload = undefined;
    }
    // Keep one completed download available for browsers to start reading it.
    const timer = setTimeout(release, 60_000);
    releaseDownload = release;
  }

  async function capture(request: Request, frame: Frame, depth: ReturnType<typeof createSplatDepthPass>) {
    request.reading = true;
    try {
      const bytes = await depth.capture(frame, request.abort.signal);
      request.abort.signal.throwIfAborted();
      if (!matches(request, options.getFrame())) {
        cancel("Depth export canceled because the scene or frame changed.");
        return;
      }
      const stem = frame.sceneName.replace(/\.msb$/i, "");
      const name = `${stem}-depth-${Number(frame.frame.toFixed(3))}.zip`;
      download(bytes, name);
      options.report("Camera depth download started.");
    } catch (error) {
      if (!request.abort.signal.aborted) options.report(`Depth export failed. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (pending === request) pending = undefined;
      sync(options.getFrame().available);
    }
  }

  sync(options.getFrame().available);
  return {
    // False leaves the normal viewport renderer in control for this frame.
    render() {
      if (disposed) return false;
      const frame = options.getFrame();
      if (pending && !matches(pending, frame)) {
        cancel("Depth export canceled because the scene or frame changed.");
      } else if (pending && !pending.reading && performance.now() > pending.expires) {
        cancel("Depth export canceled because the splats were still updating. Try again after the viewport settles.");
      }
      sync(frame.available);
      const requested = pending && !pending.reading && !pending.abort.signal.aborted ? pending : undefined;
      if (!previewItem.checked && !requested) {
        if (!pending) { pass?.dispose(); pass = undefined; }
        return false;
      }
      try {
        const depth = pass ??= createSplatDepthPass(options.renderer, options.world, options.spark);
        depth.render(frame.camera, options.objects());
        if (previewItem.checked) depth.present(frame.camera, frame.orbitTarget);
        if (requested && depth.ready) void capture(requested, frame, depth);
        return previewItem.checked;
      } catch (error) {
        previewItem.checked = false;
        pass?.dispose();
        pass = undefined;
        const message = `Camera depth unavailable. ${error instanceof Error ? error.message : String(error)}`;
        if (!cancel(message)) options.report(message);
        return false;
      }
    },
    cancel,
    dispose() {
      disposed = true;
      previewItem.checked = false;
      cancel();
      pass?.dispose();
      pass = undefined;
      sync(false);
    },
  };
}
