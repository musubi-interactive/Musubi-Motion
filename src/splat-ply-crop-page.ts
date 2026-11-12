import "./splat-ply-crop.css";
import { containsCenter, type CropBounds, type CropSide } from "./splat-ply-crop";
import type { CropReply, CropRequest } from "./splat-ply-crop-worker";
import { createCropExample } from "../tools/splat-crop/create-example";

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => get<HTMLButtonElement>(id);
const field = (id: string) => get<HTMLInputElement>(id);
const inputs = {
  min: [field("min-x"), field("min-y"), field("min-z")],
  max: [field("max-x"), field("max-y"), field("max-z")],
};
const source = field("source-file");
const progress = get<HTMLProgressElement>("progress");
const theme = matchMedia("(prefers-color-scheme: light)");
const views = [
  { canvas: get<HTMLCanvasElement>("front"), axes: [0, 1] },
  { canvas: get<HTMLCanvasElement>("top"), axes: [0, 2] },
  { canvas: get<HTMLCanvasElement>("side"), axes: [1, 2] },
] as const;
type View = typeof views[number];
type Job = Extract<CropRequest, { kind: "load" | "count" | "export" }>;
type Loaded = Extract<CropReply, { kind: "loaded" }>;
const worker = new Worker(new URL("./splat-ply-crop-worker.ts", import.meta.url), { type: "module" });
const number = new Intl.NumberFormat();
let job: Job | undefined;
let jobId = 0;
let countStatus: string | undefined;
let asset: Loaded | undefined;
let name = "";
let bounds: CropBounds | undefined;
let inside: number | undefined;
let draft: CropBounds | undefined;
let editedField: HTMLInputElement | undefined;
let invalidField: HTMLInputElement | undefined;
let undo: CropBounds[] = [];
let redo: CropBounds[] = [];
let frame = 0;
let cancelGesture: (() => void) | undefined;
let downloadUrl: string | undefined;
let downloadTimer = 0;

const editingBlocked = () => job?.kind === "load" || job?.kind === "export";
const copy = (box: CropBounds): CropBounds => ({ min: [...box.min], max: [...box.max] });
const same = (a: CropBounds, b: CropBounds) => a.min.every((value, axis) => value === b.min[axis] && a.max[axis] === b.max[axis]);
const setStatus = (message: string) => { get("status").textContent = message; };

function refreshControls(): void {
  const blocked = editingBlocked();
  const canEdit = !!bounds && !blocked;
  for (const input of [...inputs.min, ...inputs.max]) input.disabled = !canEdit;
  for (const { canvas } of views) canvas.toggleAttribute("data-ready", canEdit);
  button("fit-bounds").disabled = !canEdit;
  button("undo").disabled = !canEdit || undo.length === 0;
  button("redo").disabled = !canEdit || redo.length === 0;
  const count = draft || invalidField ? undefined : inside;
  const outside = asset && count !== undefined ? asset.count - count : undefined;
  get("inside-count").textContent = count === undefined ? "—" : number.format(count);
  get("outside-count").textContent = outside === undefined ? "—" : number.format(outside);
  button("export-inside").disabled = blocked || count === undefined || count === 0;
  button("export-outside").disabled = blocked || outside === undefined || outside === 0;
  progress.hidden = !blocked;
  button("cancel-job").hidden = !blocked;
}

function writeFields(box: CropBounds): void {
  for (const side of ["min", "max"] as const) {
    for (const [axis, input] of inputs[side].entries()) writeField(input, box[side][axis]);
  }
}

function writeField(input: HTMLInputElement, value: number): void {
  const exact = String(value);
  input.title = `${exact} · Middle-drag to adjust`;
  input.value = exact;
}

function request(next: Job): void {
  job = next;
  progress.value = 0;
  worker.postMessage(next satisfies CropRequest);
  refreshControls();
}

function recount(status?: string): void {
  if (!bounds) return;
  inside = undefined;
  countStatus = status;
  setStatus(status ?? "Counting splats…");
  request({ kind: "count", id: ++jobId, bounds });
}

function open(file: File): void {
  discardDraft();
  setStatus(`Reading ${file.name}…`);
  request({ kind: "load", id: ++jobId, file });
}

function applyBounds(next: CropBounds): void {
  bounds = next;
  draft = undefined;
  writeFields(next);
  recount();
  scheduleDraw();
}

function commitBounds(next: CropBounds): void {
  if (!bounds) return;
  if (same(bounds, next)) {
    discardDraft();
    return;
  }
  undo.push(bounds);
  if (undo.length > 64) undo.shift();
  redo = [];
  applyBounds(next);
}

function restore(backward: boolean): void {
  if (!bounds || editingBlocked()) return;
  discardDraft();
  const next = (backward ? undo : redo).pop();
  if (next) {
    (backward ? redo : undo).push(bounds);
    applyBounds(next);
  }
}

function discardDraft(): void {
  if (cancelGesture) {
    cancelGesture();
    return;
  }
  invalidField?.removeAttribute("aria-invalid");
  invalidField = undefined;
  editedField = undefined;
  draft = undefined;
  if (bounds) writeFields(bounds);
  refreshControls();
  scheduleDraw();
}

function preview(next: CropBounds): void {
  draft = next;
  refreshControls();
  scheduleDraw();
}

function drawView(view: View): void {
  const { canvas, axes: [horizontal, vertical] } = view;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  const style = getComputedStyle(canvas);
  const color = (name: string) => style.getPropertyValue(name).trim();
  ctx.fillStyle = color("--plot");
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = color("--grid");
  ctx.beginPath();
  for (const mark of [0.25, 0.5, 0.75]) {
    ctx.moveTo(width * mark, 0);
    ctx.lineTo(width * mark, height);
    ctx.moveTo(0, height * mark);
    ctx.lineTo(width, height * mark);
  }
  ctx.stroke();
  const selection = draft ?? bounds;
  if (!asset || !selection) return;

  const { sample, bounds: extent } = asset;
  const pad = plotInset(width, height);
  const x = (value: number) => pad + fraction(value, extent.min[horizontal], extent.max[horizontal]) * (width - 2 * pad);
  const y = (value: number) => height - pad - fraction(value, extent.min[vertical], extent.max[vertical]) * (height - 2 * pad);
  for (const kept of [false, true]) {
    ctx.fillStyle = color(kept ? "--dot-in" : "--dot-out");
    for (let i = 0; i < sample.length; i += 3) {
      if (containsCenter(sample, i, selection) === kept) {
        ctx.fillRect(x(sample[i + horizontal]) - 0.8, y(sample[i + vertical]) - 0.8, 1.6, 1.6);
      }
    }
  }
  const left = x(selection.min[horizontal]);
  const top = y(selection.max[vertical]);
  const right = x(selection.max[horizontal]);
  const bottom = y(selection.min[vertical]);
  ctx.strokeStyle = color("--focus");
  ctx.globalAlpha = 0.8;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(left, top, right - left, bottom - top);
}

const plotInset = (width: number, height: number) => Math.min(18, width / 5, height / 5);

function fraction(value: number, min: number, max: number): number {
  if (min === max) return value < min ? -2 : value > max ? 3 : 0.5;
  const range = max - min;
  const offset = value - min;
  const ratio = Number.isFinite(range) && Number.isFinite(offset)
    ? offset / range
    : (value / 2 - min / 2) / (max / 2 - min / 2);
  return Math.max(-2, Math.min(3, ratio));
}

function scheduleDraw(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const view of views) drawView(view);
  });
}

function pointInView(event: PointerEvent, view: View): [number, number] {
  const rect = view.canvas.getBoundingClientRect();
  const pad = plotInset(rect.width, rect.height);
  const u = (event.clientX - rect.left - pad) / (rect.width - 2 * pad);
  const v = (rect.bottom - event.clientY - pad) / (rect.height - 2 * pad);
  return [u, v].map(value => Math.max(0, Math.min(1, value))) as [number, number];
}

function updateMarquee(box: CropBounds, extent: CropBounds, view: View, start: [number, number], end: [number, number]): CropBounds {
  const next = copy(box);
  for (const [index, axis] of view.axes.entries()) {
    const min = extent.min[axis];
    const max = extent.max[axis];
    const interpolate = (t: number) => t === 0 ? min : t === 1 ? max
      : Math.sign(min) === Math.sign(max) ? min + (max - min) * t
      : (1 - t) * min + t * max;
    next.min[axis] = interpolate(Math.min(start[index], end[index]));
    next.max[axis] = interpolate(Math.max(start[index], end[index]));
  }
  return next;
}

function captureDrag(surface: HTMLElement, start: PointerEvent, move: (event: PointerEvent) => void, commit: (event: PointerEvent) => void): void {
  const { pointerId } = start;
  surface.setPointerCapture(pointerId);
  const onMove = (event: PointerEvent) => { if (event.pointerId === pointerId) move(event); };
  const finish = (event?: PointerEvent) => {
    surface.removeEventListener("pointermove", onMove);
    surface.removeEventListener("pointerup", onRelease);
    surface.removeEventListener("pointercancel", onCancel);
    surface.removeEventListener("lostpointercapture", onCancel);
    cancelGesture = undefined;
    if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId);
    if (event) commit(event);
    else discardDraft();
  };
  const onRelease = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(event); };
  const onCancel = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(); };
  cancelGesture = () => finish();
  surface.addEventListener("pointermove", onMove);
  surface.addEventListener("pointerup", onRelease);
  surface.addEventListener("pointercancel", onCancel);
  surface.addEventListener("lostpointercapture", onCancel);
}

for (const view of views) {
  const { canvas } = view;
  canvas.addEventListener("pointerdown", event => {
    if (!asset || !bounds || editingBlocked() || event.button !== 0 || cancelGesture) return;
    event.preventDefault();
    discardDraft();
    const initialBounds = bounds;
    const extent = asset.bounds;
    const start = pointInView(event, view);
    const move = (next: PointerEvent) => {
      const target = pointInView(next, view);
      const rectangle = updateMarquee(initialBounds, extent, view, start, target);
      writeFields(rectangle);
      preview(rectangle);
    };
    captureDrag(canvas, event, move, end => {
      const distance = Math.hypot(end.clientX - event.clientX, end.clientY - event.clientY);
      if (distance >= 3) move(end);
      if (distance >= 3 && draft) commitBounds(draft);
      else discardDraft();
    });
  });
}

for (const side of ["min", "max"] as const) {
  for (const [axis, input] of inputs[side].entries()) {
    const getNext = () => {
      if (!bounds) return undefined;
      const value = input.valueAsNumber;
      if (!Number.isFinite(value)) return undefined;
      const next = copy(bounds);
      next[side][axis] = value;
      return next.min[axis] <= next.max[axis] ? next : undefined;
    };
    input.addEventListener("input", () => {
      editedField = input;
      const next = getNext();
      if (next) {
        input.removeAttribute("aria-invalid");
        invalidField = undefined;
        preview(next);
      } else {
        input.setAttribute("aria-invalid", "true");
        invalidField = input;
        draft = undefined;
        refreshControls();
        scheduleDraw();
      }
    });
    input.addEventListener("blur", () => {
      if (editedField !== input) return;
      editedField = undefined;
      input.removeAttribute("aria-invalid");
      invalidField = undefined;
      const next = getNext();
      if (next) commitBounds(next);
      else {
        discardDraft();
        setStatus("Enter finite bounds with Min at or below Max.");
      }
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        input.removeAttribute("aria-invalid");
        discardDraft();
      }
    });
    input.addEventListener("pointerdown", event => {
      if (event.button !== 1 || !asset || !bounds || editingBlocked() || cancelGesture) return;
      event.preventDefault();
      discardDraft();
      const initialBounds = bounds;
      const initialValue = initialBounds[side][axis];
      const peer = initialBounds[side === "min" ? "max" : "min"][axis];
      const min = asset.bounds.min[axis];
      const max = asset.bounds.max[axis];
      const span = max - min;
      const scale = span > 0 && Number.isFinite(span)
        ? span
        : Math.max(Math.abs(min), Math.abs(max), Math.abs(initialValue), 1);
      const move = (next: PointerEvent) => {
        const delta = (next.clientX - event.clientX) / 250;
        const value = initialValue + delta * scale;
        const finite = Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, value));
        const box = copy(initialBounds);
        box[side][axis] = side === "min" ? Math.min(finite, peer) : Math.max(finite, peer);
        writeFields(box);
        preview(box);
      };
      captureDrag(input, event, move, end => {
        move(end);
        if (draft) commitBounds(draft);
      });
    });
    input.addEventListener("auxclick", event => {
      if (event.button === 1) event.preventDefault();
    });
  }
}

function exportSide(side: CropSide): void {
  if (!bounds || editingBlocked() || draft || invalidField || inside === undefined) return;
  setStatus(`Preparing ${side} region…`);
  request({ kind: "export", id: ++jobId, bounds, side });
}

function cancelWork(): void {
  if (!editingBlocked()) return;
  worker.postMessage({ kind: "cancel" } satisfies CropRequest);
  job = undefined;
  const message = "Operation canceled.";
  if (asset && inside === undefined) recount(message);
  else setStatus(message);
  refreshControls();
}

function releaseDownload(): void {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined;
}

function download(file: Blob, side: CropSide): void {
  clearTimeout(downloadTimer);
  releaseDownload();
  downloadUrl = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = `${name.replace(/\.ply$/i, "") || "capture"}-${side}.ply`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  downloadTimer = window.setTimeout(releaseDownload, 15_000);
}

worker.onmessage = ({ data }: MessageEvent<CropReply>) => {
  if (!job || data.id !== job.id) return;
  if (data.kind === "progress") {
    progress.value = data.ratio;
    return;
  }
  const previousJob = job;
  job = undefined;
  if (data.kind === "loaded" && previousJob.kind === "load") {
    worker.postMessage({ kind: "accept", id: data.id } satisfies CropRequest);
    asset = data;
    name = previousJob.file.name;
    bounds = data.bounds;
    inside = data.count;
    undo = [];
    redo = [];
    writeFields(bounds);
    get("asset-name").textContent = name;
    get("asset-meta").textContent = `${number.format(data.count)} splats`;
    const points = data.sample.length / 3;
    get("sample-label").textContent = points < data.count ? `${number.format(points)} sampled centers` : "";
    setStatus("Drag in a projection or edit the bounds.");
    scheduleDraw();
  } else if (data.kind === "counted") {
    inside = data.inside;
    setStatus(countStatus ?? (data.inside === 0 ? "No centers fall inside these bounds." : "Crop ready."));
    countStatus = undefined;
  } else if (data.kind === "exported") {
    download(data.file, data.side);
    setStatus(`Download started for the ${data.side} region.`);
  } else if (data.kind === "failed") {
    if (previousJob.kind === "load" && asset && inside === undefined) recount(data.message);
    else setStatus(data.message);
  }
  refreshControls();
};

worker.onerror = () => {
  job = undefined;
  asset = undefined;
  bounds = undefined;
  inside = undefined;
  setStatus("The crop worker stopped. Reload this page to reopen a capture.");
  refreshControls();
  scheduleDraw();
};

button("open-file").onclick = () => source.click();
source.onchange = () => {
  const file = source.files?.[0];
  source.value = "";
  if (file) open(file);
};
button("open-example").onclick = () => open(createCropExample());
button("fit-bounds").onclick = () => { if (asset) commitBounds(asset.bounds); };
button("undo").onclick = () => restore(true);
button("redo").onclick = () => restore(false);
button("export-inside").onclick = () => exportSide("inside");
button("export-outside").onclick = () => exportSide("outside");
button("cancel-job").onclick = cancelWork;
window.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (cancelGesture) cancelGesture();
    else cancelWork();
  }
  if (event.target instanceof HTMLInputElement || !event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if ((key === "z" || key === "y") && bounds && !editingBlocked()) {
    event.preventDefault();
    restore(key === "z" && !event.shiftKey);
  }
});
window.addEventListener("pagehide", releaseDownload);
theme.addEventListener("change", scheduleDraw);
const resize = new ResizeObserver(scheduleDraw);
for (const { canvas } of views) resize.observe(canvas);
scheduleDraw();
