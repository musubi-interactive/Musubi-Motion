import type { Camera, Object3D } from "three";
import type { SplatShapeNode } from "./scene-document.ts";
import type { SplatSelectionIdentity } from "./splat-component-selection.ts";
import { createSkinBrushIndex } from "./skin-weight-brush.ts";
import { createSplatMaskStroke, type MaskPoint } from "./splat-mask-brush.ts";
import { maskValue } from "./splat-masks.ts";
import { isSplatComponentActive } from "./splat-component-edits.ts";
import {
  ATTRIBUTE_PAINT_LIMITS, validateSplatPaintSettings, withSplatPaintStroke,
  type SplatAttributePaint, type SplatPaintSettings,
} from "./splat-attribute-paint.ts";

export type SplatPaintContext = {
  shape: SplatShapeNode;
  identity: SplatSelectionIdentity;
  mesh: Object3D;
  selected: Uint32Array;
  getPositions(indices: number[], front: boolean): Float32Array;
};
type Options = {
  available(): boolean;
  context(): SplatPaintContext | undefined;
  camera(): Camera;
  revision(): number;
  preview(context: SplatPaintContext, value: SplatAttributePaint | undefined): void;
  restore(): void;
  commit(context: SplatPaintContext, value: SplatAttributePaint | undefined): void;
  busyChanged(): void;
  report(message: string): void;
  resize(radius: number): void;
};
type Stroke = {
  id: number;
  context: SplatPaintContext;
  cancelled(): boolean;
  update(): SplatAttributePaint | undefined;
  ready: Promise<void>;
  brush?: ReturnType<typeof createSplatMaskStroke>;
  pending: [MaskPoint, MaskPoint][];
  last: MaskPoint;
  queued: boolean;
  ended: boolean;
};

export function createSplatAttributePaintTool(canvas: HTMLCanvasElement, host: HTMLElement, options: Options) {
  const cursor = document.createElement("div");
  cursor.className = "splat-attribute-paint-cursor";
  cursor.hidden = true;
  host.append(cursor);
  let settings: SplatPaintSettings | undefined, stroke: Stroke | undefined, resizeHeld = false;
  let resize: { id: number; x: number; radius: number; value: number } | undefined;
  const position = (e: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top }; };
  function showCursor(e: PointerEvent) {
    const r = host.getBoundingClientRect(), diameter = 2 * (resize?.value ?? settings?.radius ?? 1);
    Object.assign(cursor.style, { left: e.clientX - r.left + "px", top: e.clientY - r.top + "px", width: diameter + "px", height: diameter + "px" });
    cursor.hidden = !settings || !options.available() || e.altKey;
  }
  function release(id: number) { if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); }
  function cancel(message?: string) {
    const id = stroke?.id ?? resize?.id;
    if (id === undefined) return;
    stroke = resize = undefined;
    release(id);
    options.restore();
    options.busyChanged();
    if (message) options.report(message);
  }
  function valid(active: Stroke) {
    if (active !== stroke) return false;
    if (active.cancelled()) { cancel("Paint stroke canceled because the scene, selection or view changed."); return false; }
    return true;
  }
  function failure(active: Stroke, error: unknown) {
    if (active === stroke) cancel(error instanceof Error ? error.message : String(error));
  }
  function queue(active: Stroke) {
    if (active.queued || active.ended) return;
    active.queued = true;
    requestAnimationFrame(() => {
      active.queued = false;
      if (!valid(active) || !active.brush || active.ended) return;
      try {
        options.preview(active.context, active.update());
        options.report(active.brush.affectedCount.toLocaleString() + " original IDs previewed. Release to commit or press Escape.");
      } catch (error) { failure(active, error); }
    });
  }
  function segment(active: Stroke, next: MaskPoint) {
    if (!valid(active)) return;
    const from = active.last;
    active.last = next;
    try {
      if (active.brush) { active.brush.addSegment(from, next); queue(active); }
      else {
        if (active.pending.length >= 8192) throw Error("Paint stroke exceeded the queued pointer path budget.");
        active.pending.push([from, next]);
      }
    } catch (error) { failure(active, error); }
  }
  function begin(event: PointerEvent) {
    if (!settings || event.altKey || event.button !== 0 || event.pointerType === "touch") return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (!settings || !options.available()) return;
    cancel();
    const captured = { ...settings }, context = options.context();
    if (!context || context.identity.count > ATTRIBUTE_PAINT_LIMITS.source) {
      options.report("Select one loaded splat object with up to 1,000,000 original splats."); return;
    }
    const mask = context.shape.scalarMasks?.find(mask => mask.id === captured.maskId);
    if (captured.maskId && !mask) { options.report("Choose a scalar mask on this shape."); return; }
    if (captured.selectedOnly && !context.selected.length) { options.report("Select original splats first."); return; }
    for (let parent: Object3D | null = context.mesh; parent; parent = parent.parent)
      if (!parent.visible) { options.report("The paint object is hidden."); return; }
    if (resizeHeld) {
      resize = { id: event.pointerId, x: event.clientX, radius: captured.radius, value: captured.radius };
      canvas.setPointerCapture(event.pointerId); options.busyChanged(); return;
    }
    const camera = options.camera();
    camera.updateWorldMatrix(true, false); context.mesh.updateWorldMatrix(true, false);
    const cameraWorld = camera.matrixWorld.clone(), projection = camera.projectionMatrix.clone(), world = context.mesh.matrixWorld.clone();
    const revision = options.revision(), rect = canvas.getBoundingClientRect();
    const selected = captured.selectedOnly ? new Set(context.selected) : undefined;
    const start = position(event);
    const active: Stroke = {
      id: event.pointerId, context, last: start, pending: [[start, start]], ended: false, queued: false, ready: Promise.resolve(),
      cancelled() {
        const current = options.context(), nextRect = canvas.getBoundingClientRect();
        camera.updateWorldMatrix(true, false); context.mesh.updateWorldMatrix(true, false);
        return !settings || !options.available() || current?.shape !== context.shape ||
          captured.selectedOnly && current.selected !== context.selected || options.revision() !== revision ||
          options.camera() !== camera || !world.equals(context.mesh.matrixWorld) || !cameraWorld.equals(camera.matrixWorld) ||
          !projection.equals(camera.projectionMatrix) || rect.left !== nextRect.left || rect.top !== nextRect.top ||
          rect.width !== nextRect.width || rect.height !== nextRect.height;
      },
      update: () => withSplatPaintStroke(context.shape, context.identity.count, captured, active.brush!.values(), selected, mask),
    };
    stroke = active; canvas.setPointerCapture(event.pointerId);
    options.busyChanged(); options.report("Indexing posed original splat centers. Press Escape to cancel.");
    let yielded = performance.now();
    active.ready = createSkinBrushIndex({
      componentCount: context.identity.count, projectedLimit: ATTRIBUTE_PAINT_LIMITS.source, frontCenters: captured.depth === "front",
      readPositions(start, count) { return context.getPositions(Array.from({ length: count }, (_, i) => start + i), captured.depth === "front"); },
      matrixWorld: world, camera, width: rect.width, height: rect.height, cancelled: () => stroke !== active || active.cancelled(),
      yieldTask: async () => { if (performance.now() - yielded > 6) { await new Promise(resolve => setTimeout(resolve, 0)); yielded = performance.now(); } },
    }).then(index => {
      if (!valid(active)) return;
      // The scalar brush gives the greatest capsule coverage against a zero base.
      // The authored paint transaction maps that coverage onto each channel.
      active.brush = createSplatMaskStroke(index, { ...captured, shapeId: context.shape.id, maskId: captured.maskId ?? "", mode: "replace", value: 1 },
        () => 0, id => !isSplatComponentActive(context.shape.componentEdits, id) || !!selected && !selected.has(id) ||
          !!mask && maskValue(mask, id) === 0);
      for (const [from, to] of active.pending) active.brush.addSegment(from, to);
      active.pending.length = 0; queue(active);
    }).catch(error => failure(active, error));
  }
  async function end(event: PointerEvent) {
    const active = stroke;
    if (resize?.id !== event.pointerId && active?.id !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (resize) {
      const value = resize.value; resize = undefined; release(event.pointerId);
      options.busyChanged(); options.resize(value); return;
    }
    if (!active || active.ended) return;
    segment(active, position(event)); active.ended = true;
    await active.ready;
    if (!valid(active) || !active.brush) return;
    try {
      const value = active.update();
      stroke = undefined; release(active.id);
      options.restore();
      options.commit(active.context, value);
      options.report(value === active.context.shape.attributePaint ? "Stroke made no changes." : "Painted attributes in one undoable stroke.");
    } catch (error) {
      if (stroke === active) failure(active, error);
      else options.report(error instanceof Error ? error.message : String(error));
    } finally { options.busyChanged(); }
  }
  canvas.addEventListener("pointerdown", begin, true);
  canvas.addEventListener("pointermove", event => {
    if (!settings) return;
    showCursor(event);
    if (resize) {
      event.preventDefault(); event.stopImmediatePropagation();
      resize.value = Math.max(1, Math.min(512, Math.round(resize.radius + event.clientX - resize.x))); showCursor(event);
    } else if (stroke && !stroke.ended) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.altKey) cancel("Paint stroke canceled."); else segment(stroke, position(event));
    }
  }, true);
  canvas.addEventListener("pointerup", event => { void end(event); }, true);
  canvas.addEventListener("pointercancel", () => cancel("Paint stroke canceled. Original values restored."), true);
  canvas.addEventListener("lostpointercapture", () => { if (resize || stroke && !stroke.ended) cancel("Paint pointer capture lost. Original values restored."); }, true);
  canvas.addEventListener("pointerleave", () => { cursor.hidden = true; });
  canvas.addEventListener("wheel", () => cancel("Paint stroke canceled by camera motion."), true);
  window.addEventListener("blur", () => { resizeHeld = false; cursor.hidden = true; cancel("Paint stroke canceled."); });
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && (stroke || resize)) {
      event.preventDefault(); event.stopImmediatePropagation(); cancel("Paint stroke canceled. Original values restored.");
    } else if (event.key.toLowerCase() === "b" && settings && !event.ctrlKey && !event.metaKey && !event.altKey &&
      !(event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable=true]"))) {
      event.preventDefault(); event.stopImmediatePropagation(); resizeHeld = true;
    }
  }, true);
  window.addEventListener("keyup", event => { if (event.key.toLowerCase() === "b") resizeHeld = false; }, true);
  return {
    get active() { return !!settings; },
    get busy() { return !!stroke || !!resize; },
    setBrush(next?: SplatPaintSettings) {
      if (next) validateSplatPaintSettings(next);
      cancel(); settings = next ? { ...next } : undefined; resizeHeld = false; cursor.hidden = true;
      canvas.style.cursor = settings ? "crosshair" : "";
    },
    cancel,
    refresh() { if (stroke) valid(stroke); },
  };
}
