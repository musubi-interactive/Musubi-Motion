import type { Camera, Object3D } from "three";
import type { SkinInfluence } from "./scene-document.ts";
import { createSkinBrushIndex, createSkinBrushStroke, type SkinBrushStroke, type SkinBrushValue } from "./skin-weight-brush.ts";
import type { SkinWeightBrushSettings } from "./skin-weight-paint-panel.ts";
import { createSkinWeightPreview } from "./skin-weight-preview.ts";

import { indexSkinNeighborhood, smoothSkinRow, sameSkinRow, type CleanupContext } from "./skin-weight-smoothing.ts";
type Context = {
  cleanup?: CleanupContext;
  identity: object;
  mesh: Object3D;
  count: number;
  getWeights: (index: number) => SkinInfluence[];
  getPositions: (indices: number[]) => Float32Array;
};
type Options = {
  readDepth?: import("./component-picking.ts").SceneDepthReader;
  available: () => boolean;
  showPreview: () => boolean;
  getContext: (shapeId: string) => Context | undefined;
  getCamera: () => Camera;
  getRevision: () => number;
  commit: (settings: SkinWeightBrushSettings, values: SkinBrushValue[], context: Context) => void;
  onBusyChange: () => void;
  onMessage: (message: string) => void;
};
type Point = { x: number; y: number };
type Session = {
  pointerId: number; settings: SkinWeightBrushSettings; context: Context;
  last: Point; segments: [Point, Point][]; ended: boolean; cancelled: () => boolean;
  stroke?: SkinBrushStroke; ready: Promise<void>; previewQueued: boolean;
};

/** Browser interaction adapter. A stroke previews outside the document and commits once. */
export function createSkinWeightPaintTool(canvas: HTMLCanvasElement, host: HTMLElement, options: Options) {
  const overlay = createSkinWeightPreview();
  const cursor = document.createElement("div");
  cursor.className = "skin-brush-cursor";
  cursor.hidden = true;
  Object.assign(cursor.style, { position: "absolute", pointerEvents: "none", border: "1px solid #f5b260",
    borderRadius: "50%", transform: "translate(-50%,-50%)", zIndex: "10", boxShadow: "0 0 0 1px #0006" });
  host.append(cursor);
  let settings: SkinWeightBrushSettings | undefined, session: Session | undefined;
  const disposers: (() => void)[] = [];
  function listen(target: EventTarget, type: string, listener: EventListener, capture = false) {
    target.addEventListener(type, listener, capture);
    disposers.push(() => target.removeEventListener(type, listener, capture));
  }
  function preview(context: Context, indices: number[], weights: number[]) {
    overlay.update(context.mesh, context.getPositions(indices), weights);
    overlay.setVisible(options.showPreview());
  }
  function idlePreview() {
    if (!settings || !options.available()) { overlay.clear(); return; }
    const context = options.getContext(settings.shapeId);
    if (!context || !context.count) { overlay.clear(); return; }
    const count = Math.min(5000, context.count);
    const indices = Array.from({ length: count }, (_, index) => count === 1 ? 0 : Math.round(index * (context.count - 1) / (count - 1)));
    const jointId = settings.jointId;
    preview(context, indices, indices.map(index => context.getWeights(index).find(row => row.jointId === jointId)?.weight ?? 0));
  }
  function cancel(message = "Paint stroke canceled.") {
    if (!session) return;
    session = undefined; overlay.clear(); options.onBusyChange(); options.onMessage(message);
    idlePreview();
  }
  function valid(active: Session) {
    if (session !== active) return false;
    if (active.cancelled()) { cancel("Paint stroke canceled because the scene or view changed."); return false; }
    return true;
  }
  function fail(active: Session, error: unknown) {
    if (session !== active) return;
    const message = error instanceof Error ? error.message : String(error);
    cancel((error as Error)?.name === "AbortError" ? "Paint stroke canceled because the scene or view changed." : message);
  }
  function queuePreview(active: Session) {
    if (active.previewQueued) return;
    active.previewQueued = true;
    requestAnimationFrame(() => {
      active.previewQueued = false;
      if (!valid(active) || !active.stroke) return;
      try {
        const values = active.stroke.values(), count = Math.min(5000, values.length);
        if (!count) return;
        const sample = Array.from({ length: count }, (_, index) => values[count === 1 ? 0 : Math.round(index * (values.length - 1) / (count - 1))]);
        preview(active.context, sample.map(row => row.index), sample.map(row => row.weight));
        options.onMessage(`${values.length.toLocaleString()} components previewed. Release to apply; Esc cancels.`);
      } catch (error) { fail(active, error); }
    });
  }
  function segment(active: Session, point: Point) {
    if (active.ended || !valid(active)) return;
    const pair: [Point, Point] = [active.last, point]; active.last = point;
    if (!active.stroke) {
      if (active.segments.length >= 8192) { cancel("Stroke path exceeds 8,192 segments. Use a shorter stroke."); return; }
      active.segments.push(pair);
    }
    else {
      try { active.stroke.addSegment(...pair); queuePreview(active); }
      catch (error) { fail(active, error); }
    }
  }
  function point(event: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function moveCursor(event: PointerEvent) {
    cursor.hidden = !settings || event.altKey || !options.available();
    if (cursor.hidden || !settings) return;
    const rect = host.getBoundingClientRect();
    Object.assign(cursor.style, { left: `${event.clientX - rect.left}px`, top: `${event.clientY - rect.top}px`,
      width: `${settings.radius * 2}px`, height: `${settings.radius * 2}px` });
  }
  function begin(event: PointerEvent) {
    if (!settings || event.altKey || event.button !== 0 || event.pointerType === "touch") return;
    event.preventDefault(); event.stopImmediatePropagation();
    // Canvas pointer handling suppresses native focus changes. Commit panel drafts before freezing settings.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (!settings || !options.available()) return;
    cancel();
    const brush = { ...settings }, context = options.getContext(brush.shapeId);
    if (!context) { options.onMessage("Choose a loaded bound object to paint."); return; }
    for (let node: Object3D | null = context.mesh; node; node = node.parent) {
      if (!node.visible) { options.onMessage("The paint object is hidden."); return; }
    }
    context.mesh.updateWorldMatrix(true, false);
    const camera = options.getCamera(); camera.updateWorldMatrix(true, false);
    const cameraWorld = camera.matrixWorld.clone(), projection = camera.projectionMatrix.clone(), world = context.mesh.matrixWorld.clone();
    const rect = canvas.getBoundingClientRect(), revision = options.getRevision();
    const active: Session = { pointerId: event.pointerId, settings: brush, context, last: point(event), segments: [], ended: false,
      ready: Promise.resolve(), previewQueued: false, cancelled: () => {
        const current = canvas.getBoundingClientRect();
        return session !== active || !options.available() || revision !== options.getRevision()
          || options.getContext(brush.shapeId)?.identity !== context.identity || options.getCamera() !== camera
          || !camera.matrixWorld.equals(cameraWorld) || !camera.projectionMatrix.equals(projection) || !context.mesh.matrixWorld.equals(world)
          || current.width !== rect.width || current.height !== rect.height || current.left !== rect.left || current.top !== rect.top;
      } };
    session = active; canvas.setPointerCapture(event.pointerId); options.onBusyChange();
    active.segments.push([active.last, active.last]);
    options.onMessage("Preparing paint stroke… Esc cancels.");
    let lastYield = performance.now();
    active.ready = (async () => {
      const cleanup = context.cleanup;
      if (brush.mode === "smooth" && !cleanup) throw Error("Bind-space original centers are unavailable.");
      const neighbors = brush.mode === "smooth" ? await indexSkinNeighborhood(cleanup!, brush.distance ?? .1, active.cancelled) : undefined;
      const index = await createSkinBrushIndex({ projectedLimit: 500_000, readDepth: brush.depth === "scene-visible" ? options.readDepth : undefined, frontCenters: brush.depth === "front", componentCount: context.count,
      readPositions: (offset, count) => context.getPositions(Array.from({ length: count }, (_, index) => offset + index)),
      matrixWorld: world, camera, width: rect.width, height: rect.height, cancelled: active.cancelled,
      yieldTask: async () => { if (performance.now() - lastYield < 8) return; await new Promise<void>(resolve => setTimeout(resolve, 0)); lastYield = performance.now(); },
    });
      if (!valid(active)) return;
      active.stroke = createSkinBrushStroke(index, { ...brush, smooth: neighbors && cleanup ? (id, amount) => {
        const row = smoothSkinRow(cleanup, neighbors, id, amount);
        return sameSkinRow(row, cleanup.getWeights(id)) ? undefined : {index:id, weight: row.find(v => v.jointId === brush.jointId)?.weight ?? 0, row};
      } : undefined,
        getWeight: component => context.getWeights(component).find(row => row.jointId === brush.jointId)?.weight ?? 0 });
      for (const pair of active.segments) active.stroke.addSegment(...pair);
      active.segments.length = 0; queuePreview(active);
    })().catch(error => fail(active, error));
  }
  async function end(event: PointerEvent) {
    const active = session;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    segment(active, point(event)); active.ended = true;
    await active.ready;
    if (!valid(active) || !active.stroke) return;
    try {
      const values = active.stroke.values();
      // Clear the preview transaction before the synchronous document command notifies listeners.
      session = undefined; overlay.clear(); options.onBusyChange();
      options.commit(active.settings, values, active.context);
      options.onMessage(values.length ? `Painted ${values.length.toLocaleString()} components. Undo restores the entire stroke.` : "Paint stroke made no changes.");
    } catch (error) { options.onMessage(error instanceof Error ? error.message : String(error)); }
    idlePreview();
  }
  listen(canvas, "pointerdown", begin as EventListener, true);
  listen(canvas, "pointermove", ((event: PointerEvent) => {
    moveCursor(event);
    if (!session || session.ended) return;
    if (event.altKey) { cancel(); return; }
    event.preventDefault(); event.stopImmediatePropagation();
    if (session.pointerId === event.pointerId) segment(session, point(event));
  }) as EventListener, true);
  listen(canvas, "pointerup", (event => { void end(event as PointerEvent); }) as EventListener, true);
  listen(canvas, "pointercancel", (() => cancel()) as EventListener, true);
  listen(canvas, "lostpointercapture", (() => { if (session && !session.ended) cancel(); }) as EventListener, true);
  listen(canvas, "pointerleave", (() => { cursor.hidden = true; }) as EventListener);
  listen(canvas, "wheel", (() => cancel()) as EventListener, true);
  listen(window, "blur", (() => { cursor.hidden = true; cancel(); }) as EventListener);
  listen(window, "keydown", ((event: KeyboardEvent) => {
    if (!session || event.key !== "Escape") return;
    event.preventDefault(); event.stopImmediatePropagation(); cancel();
  }) as EventListener, true);
  return {
    get busy() { return !!session; },
    setBrush(next: SkinWeightBrushSettings | undefined) {
      cancel(); settings = next ? { ...next } : undefined;
      canvas.style.cursor = settings ? "crosshair" : ""; cursor.hidden = true;
      if (!settings) overlay.clear(); else idlePreview();
    },
    cancel,
    refresh() { if (session) valid(session); else idlePreview(); },
    dispose() { session = undefined; settings = undefined; disposers.forEach(dispose => dispose()); overlay.dispose(); cursor.remove(); canvas.style.cursor = ""; },
  };
}
