import type { Camera, Object3D } from "three";
import { createSkinBrushIndex } from "./skin-weight-brush.ts";
import { createSplatMaskStroke, validateSplatMaskBrush, type MaskPoint, type SplatMaskBrush } from "./splat-mask-brush.ts";
import { maskLocked, maskValue, SPLAT_MASK_LIMITS, type SplatScalarMask, type SplatMaskValues } from "./splat-masks.ts";
import { createSplatMaskPreview, SPLAT_MASK_PREVIEW_LIMIT } from "./splat-mask-preview.ts";
export type SplatMaskPaintContext = { identity: object; mesh: Object3D; count: number; mask: SplatScalarMask; getPositions(indices: number[]): Float32Array; selected: Uint32Array };
type Options = {
  available(): boolean; getContext(shapeId: string, maskId: string): SplatMaskPaintContext | undefined; getCamera(): Camera; getRevision(): number;
  getDisplay(): { shapeId: string; maskId: string; show: boolean } | undefined;
  commit(settings: SplatMaskBrush, values: SplatMaskValues): void; onBusyChange(): void; onMessage(message: string): void; onResize(radius: number): void;
};
type Session = { pointerId: number; settings: SplatMaskBrush; context: SplatMaskPaintContext; last: MaskPoint; segments: [MaskPoint, MaskPoint][]; ended: boolean; cancelled(): boolean; ready: Promise<void>; stroke?: ReturnType<typeof createSplatMaskStroke>; queued: boolean };
/** Captured view/document/identity; no authored changes before successful release. */
export function createSplatMaskPaintTool(canvas: HTMLCanvasElement, host: HTMLElement, options: Options) {
  const overlay = createSplatMaskPreview(), cursor = document.createElement("div"); cursor.className = "splat-mask-cursor"; cursor.hidden = true;
  Object.assign(cursor.style, { position: "absolute", pointerEvents: "none", border: "1px solid white", borderRadius: "50%", boxShadow: "0 0 0 1px #171717", transform: "translate(-50%,-50%)", zIndex: "11" }); host.append(cursor);
  let brush: SplatMaskBrush | undefined, session: Session | undefined, resizeHeld = false, resize: { pointerId: number; x: number; radius: number; preview: number } | undefined;
  let displayed: { identity: object; mask: SplatScalarMask; revision: number } | undefined;
  const point = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const release = (id: number) => { if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); };
  function cursorAt(e: PointerEvent, radius = resize?.preview ?? brush?.radius ?? 1) { const r = host.getBoundingClientRect(); Object.assign(cursor.style, { left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px`, width: `${radius * 2}px`, height: `${radius * 2}px` }); cursor.hidden = !brush || e.altKey || !options.available(); }
  function draw(context: SplatMaskPaintContext, indices: number[], values: ArrayLike<number>) { overlay.update(context.mesh, context.getPositions(indices), values); }
  function idlePreview() {
    const display = options.getDisplay();
    if (!display?.show || !options.available()) { overlay.clear(); displayed = undefined; return; }
    const context = options.getContext(display.shapeId, display.maskId); if (!context) { overlay.clear(); displayed = undefined; return; }
    const revision = options.getRevision(); if (displayed?.identity === context.identity && displayed.mask === context.mask && displayed.revision === revision) return;
    const count = Math.min(SPLAT_MASK_PREVIEW_LIMIT, context.count), ids = new Set<number>(), data = context.mask.data;
    if (data.kind === "sparse") { const n = Math.min(data.indices.length, Math.floor(count * .9)); for (let i = 0; i < n; i++) ids.add(data.indices[Math.floor(i * data.indices.length / n)]); }
    for (let i = 0; ids.size < count && i < count; i++) ids.add(Math.min(context.count - 1, Math.floor(i * context.count / count)));
    const indices = [...ids]; draw(context, indices, indices.map(id => maskValue(context.mask, id))); displayed = { identity: context.identity, mask: context.mask, revision };
  }
  function cancel(message?: string) {
    const prior = session; session = undefined; const size = resize; resize = undefined;
    if (prior) release(prior.pointerId); if (size) release(size.pointerId);
    if (prior || size) { overlay.clear(); displayed = undefined; options.onBusyChange(); if (message) options.onMessage(message); }
    idlePreview();
  }
  function valid(active: Session) { if (session !== active) return false; if (active.cancelled()) { cancel("Mask stroke canceled because the scene, selection or view changed."); return false; } return true; }
  function fail(active: Session, error: unknown) { if (session === active) cancel((error as Error)?.name === "AbortError" ? "Mask stroke canceled; nothing changed." : error instanceof Error ? error.message : String(error)); }
  function queuePreview(active: Session) {
    if (active.queued) return; active.queued = true;
    requestAnimationFrame(() => {
      active.queued = false; if (!valid(active) || !active.stroke) return;
      try { const changes = active.stroke.values(), count = Math.min(SPLAT_MASK_PREVIEW_LIMIT, changes.indices.length), ids: number[] = [], values = new Float32Array(count);
        for (let i = 0; i < count; i++) { const source = Math.floor(i * changes.indices.length / count); ids.push(changes.indices[source]); values[i] = changes.values[source]; }
        draw(active.context, ids, values); displayed = undefined; options.onMessage(`${changes.indices.length.toLocaleString()} original IDs previewed${changes.indices.length > count ? ` · ${count.toLocaleString()} sampled markers` : ""}. Release commits one stroke; Escape cancels.`);
      } catch (error) { fail(active, error); }
    });
  }
  function segment(active: Session, next: MaskPoint) {
    if (active.ended || !valid(active)) return; const pair: [MaskPoint, MaskPoint] = [active.last, next]; active.last = next;
    try { if (active.stroke) { active.stroke.addSegment(...pair); queuePreview(active); } else { if (active.segments.length >= 8192) throw Error("Mask stroke path is too long while indexing. Use a shorter stroke; nothing changed."); active.segments.push(pair); } } catch (error) { fail(active, error); }
  }
  function begin(e: PointerEvent) {
    if (!brush || e.altKey || e.button !== 0 || e.pointerType === "touch") return;
    e.preventDefault(); e.stopImmediatePropagation(); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); if (!brush || !options.available()) return;
    cancel();
    if (resizeHeld) { resize = { pointerId: e.pointerId, x: e.clientX, radius: brush.radius, preview: brush.radius }; canvas.setPointerCapture(e.pointerId); options.onBusyChange(); return; }
    const settings = { ...brush }, context = options.getContext(settings.shapeId, settings.maskId);
    if (!context || context.mask.locked) { options.onMessage("Choose an unlocked scalar mask on the selected loaded splat object."); return; }
    for (let p: Object3D | null = context.mesh; p; p = p.parent) if (!p.visible) { options.onMessage("The mask object is hidden."); return; }
    context.mesh.updateWorldMatrix(true, false); const camera = options.getCamera(); camera.updateWorldMatrix(true, false);
    const world = context.mesh.matrixWorld.clone(), cameraWorld = camera.matrixWorld.clone(), projection = camera.projectionMatrix.clone(), revision = options.getRevision(), rect = canvas.getBoundingClientRect();
    const active: Session = { pointerId: e.pointerId, settings, context, last: point(e), segments: [], ended: false, queued: false, ready: Promise.resolve(), cancelled() {
      const now = canvas.getBoundingClientRect(); camera.updateWorldMatrix(true, false); context.mesh.updateWorldMatrix(true, false);
      const current = options.getContext(settings.shapeId, settings.maskId);
      return session !== active || !options.available() || current?.identity !== context.identity || current.mask !== context.mask || current.selected !== context.selected
        || options.getRevision() !== revision || options.getCamera() !== camera || !world.equals(context.mesh.matrixWorld) || !cameraWorld.equals(camera.matrixWorld) || !projection.equals(camera.projectionMatrix)
        || rect.left !== now.left || rect.top !== now.top || rect.width !== now.width || rect.height !== now.height;
    } };
    session = active; canvas.setPointerCapture(e.pointerId); active.segments.push([active.last, active.last]); options.onBusyChange(); options.onMessage("Indexing posed original splat centers… Escape cancels.");
    const selected = settings.selectedOnly ? new Set(context.selected) : undefined;
    let yielded = performance.now();
    active.ready = createSkinBrushIndex({ componentCount: context.count, projectedLimit: SPLAT_MASK_LIMITS.projected,
      readPositions(start, count) { const ids = Array.from({ length: count }, (_, i) => start + i), positions = context.getPositions(ids); if (selected) ids.forEach((id, i) => { if (!selected.has(id)) positions.fill(NaN, i * 3, i * 3 + 3); }); return positions; },
      matrixWorld: world, camera, width: rect.width, height: rect.height, cancelled: active.cancelled,
      yieldTask: async () => { if (performance.now() - yielded > 6) { await new Promise<void>(resolve => setTimeout(resolve, 0)); yielded = performance.now(); } },
    }).then(index => { if (!valid(active)) return; active.stroke = createSplatMaskStroke(index, settings, id => maskValue(context.mask, id), id => maskLocked(context.mask, id)); for (const pair of active.segments) active.stroke.addSegment(...pair); active.segments.length = 0; queuePreview(active); }).catch(error => fail(active, error));
  }
  async function end(e: PointerEvent) {
    if (resize?.pointerId === e.pointerId) { e.preventDefault(); e.stopImmediatePropagation(); const radius = resize.preview; resize = undefined; release(e.pointerId); options.onBusyChange(); options.onResize(radius); return; }
    const active = session; if (!active || active.pointerId !== e.pointerId) return; e.preventDefault(); e.stopImmediatePropagation(); segment(active, point(e)); active.ended = true; await active.ready;
    if (!valid(active) || !active.stroke) return;
    try { const values = active.stroke.values(); session = undefined; release(active.pointerId); overlay.clear(); displayed = undefined; options.onBusyChange(); options.commit(active.settings, values); options.onMessage(values.indices.length ? `Painted ${values.indices.length.toLocaleString()} original IDs · one undoable stroke.` : "Mask stroke made no changes."); } catch (error) { options.onMessage(error instanceof Error ? error.message : String(error)); }
    idlePreview();
  }
  const disposers: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, fn: EventListener, capture = false) => { target.addEventListener(type, fn, capture); disposers.push(() => target.removeEventListener(type, fn, capture)); };
  listen(canvas, "pointerdown", begin as EventListener, true);
  listen(canvas, "pointermove", ((e: PointerEvent) => { cursorAt(e); if (resize) { e.preventDefault(); e.stopImmediatePropagation(); resize.preview = Math.max(1, Math.min(512, Math.round(resize.radius + e.clientX - resize.x))); cursorAt(e); return; } if (!session || session.ended) return; e.preventDefault(); e.stopImmediatePropagation(); if (e.altKey) cancel("Mask stroke canceled."); else segment(session, point(e)); }) as EventListener, true);
  listen(canvas, "pointerup", (e => { void end(e as PointerEvent); }) as EventListener, true);
  listen(canvas, "pointercancel", (() => cancel("Mask stroke canceled; original values restored.")) as EventListener, true);
  listen(canvas, "lostpointercapture", (() => { if (session && !session.ended || resize) cancel("Mask stroke canceled; original values restored."); }) as EventListener, true);
  listen(canvas, "pointerleave", (() => { cursor.hidden = true; }) as EventListener);
  listen(canvas, "wheel", (() => cancel("Mask stroke canceled by camera motion.")) as EventListener, true);
  listen(window, "blur", (() => { resizeHeld = false; cursor.hidden = true; cancel("Mask stroke canceled."); }) as EventListener);
  listen(window, "keydown", ((e: KeyboardEvent) => { if (e.key === "Escape" && (session || resize)) { e.preventDefault(); e.stopImmediatePropagation(); cancel("Mask stroke canceled; original values restored."); }
    else if (e.key.toLowerCase() === "b" && brush && !(e.target instanceof HTMLElement && e.target.closest("input,textarea,select,[contenteditable=true]")) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); resizeHeld = true; } }) as EventListener, true);
  listen(window, "keyup", ((e: KeyboardEvent) => { if (e.key.toLowerCase() === "b") resizeHeld = false; }) as EventListener, true);
  return {
    get active() { return !!brush; }, get busy() { return !!session || !!resize; },
    setBrush(next?: SplatMaskBrush) { if (next) validateSplatMaskBrush(next); cancel(); brush = next ? { ...next } : undefined; resizeHeld = false; cursor.hidden = true; canvas.style.cursor = brush ? "crosshair" : ""; displayed = undefined; idlePreview(); },
    cancel, refresh() { if (session) valid(session); else if (!resize) idlePreview(); },
    dispose() { session = undefined; brush = undefined; disposers.forEach(fn => fn()); overlay.dispose(); cursor.remove(); },
  };
}
