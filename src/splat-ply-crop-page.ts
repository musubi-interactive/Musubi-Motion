import "./splat-ply-crop.css";
import { containsCenter, type CropBounds, type CropSide } from "./splat-ply-crop";
import type { CropJob, CropReply, CropRequest } from "./splat-ply-crop-worker";
import { checkRegionName, MAX_REGIONS, type CaptureRegion } from "./splat-ply-region-spec";
import type { PartitionSummary } from "./splat-ply-regions";
import { createCropExample } from "../tools/splat-crop/create-example";

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => get<HTMLButtonElement>(id);
const field = (id: string) => get<HTMLInputElement>(id);
const inputs = {
  min: [field("min-x"), field("min-y"), field("min-z")],
  max: [field("max-x"), field("max-y"), field("max-z")],
};
const source = field("source-file");
const recipeFile = field("recipe-file");
const nameField = field("region-name");
const enabledField = field("region-enabled");
const progress = get<HTMLProgressElement>("progress");
const theme = matchMedia("(prefers-color-scheme: light)");
const views = [
  { canvas: get<HTMLCanvasElement>("front"), axes: [0, 1] },
  { canvas: get<HTMLCanvasElement>("top"), axes: [0, 2] },
  { canvas: get<HTMLCanvasElement>("side"), axes: [1, 2] },
] as const;
type View = typeof views[number];
type Loaded = Extract<CropReply, { kind: "loaded" }>;
type RegionState = { regions: CaptureRegion[]; selected: number };
const worker = new Worker(new URL("./splat-ply-crop-worker.ts", import.meta.url), { type: "module" });
const number = new Intl.NumberFormat();
const boundMenu = get("bound-menu");
const lockedBounds = new Set<HTMLInputElement>();
let lockedField: HTMLInputElement | undefined;
let mode: "crop" | "regions" = "crop";
let job: CropJob | undefined;
let jobId = 0;
let countStatus: string | undefined;
let asset: Loaded | undefined;
let name = "";
let cropBounds: CropBounds | undefined;
let inside: number | undefined;
let cropUndo: CropBounds[] = [];
let cropRedo: CropBounds[] = [];
let regionState: RegionState = { regions: [], selected: -1 };
let regionUndo: RegionState[] = [];
let regionRedo: RegionState[] = [];
let summary: PartitionSummary | undefined;
let bounds: CropBounds | undefined;
let draft: CropBounds | undefined;
let editedField: HTMLInputElement | undefined;
let invalidField: HTMLInputElement | undefined;
let frame = 0;
let cancelGesture: (() => void) | undefined;
let downloadUrl: string | undefined;
let downloadTimer = 0;

const isCount = () => job?.kind === "count" || job?.kind === "count-partition";
const editingBlocked = () => !!job && !isCount();
const copy = (box: CropBounds): CropBounds => ({ min: [...box.min], max: [...box.max] });
const same = (a: CropBounds, b: CropBounds) => a.min.every((value, axis) => value === b.min[axis] && a.max[axis] === b.max[axis]);
const setStatus = (message: string) => { get("status").textContent = message; };
const shownCount = (count?: number) => count === undefined ? "—" : number.format(count);

function refreshControls(): void {
  const blocked = editingBlocked();
  const canEdit = !!bounds && !blocked;
  const { regions, selected } = regionState;
  const regionMode = mode === "regions";
  for (const input of [...inputs.min, ...inputs.max]) input.disabled = !canEdit;
  for (const { canvas } of views) canvas.toggleAttribute("data-ready", canEdit);
  for (const [id, chosen] of [["mode-crop", !regionMode], ["mode-regions", regionMode]] as const) {
    button(id).disabled = blocked;
    button(id).setAttribute("aria-pressed", String(chosen));
  }
  get("regions-panel").hidden = !regionMode;
  get("crop-exports").hidden = regionMode;
  get("partition-exports").hidden = !regionMode;
  get("selected-region").hidden = selected < 0;
  get("bounds-title").textContent = regionMode ? "Region bounds" : "Crop bounds";
  get("inside-legend").textContent = regionMode ? "Within selected bounds" : "Inside";
  get("outside-legend").textContent = regionMode ? "Other centers" : "Outside";
  get("bounds-controls").hidden = regionMode && selected < 0;
  get("drag-guide").hidden = regionMode && selected < 0;
  button("fit-bounds").disabled = !canEdit;
  button("undo").disabled = blocked || (regionMode ? regionUndo : cropUndo).length === 0;
  button("redo").disabled = blocked || (regionMode ? regionRedo : cropRedo).length === 0;

  const editing = draft !== undefined || invalidField !== undefined;
  const count = editing ? undefined : inside;
  const outside = asset && count !== undefined ? asset.count - count : undefined;
  get("inside-count").textContent = shownCount(count);
  get("outside-count").textContent = shownCount(outside);
  button("export-inside").disabled = blocked || count === undefined || count === 0;
  button("export-outside").disabled = blocked || outside === undefined || outside === 0;

  const next = editing ? undefined : summary;
  get("overlap-count").textContent = shownCount(next?.overlap);
  get("remainder-count").textContent = shownCount(next?.remainder);
  const rows = get("region-list").querySelectorAll<HTMLButtonElement>("button");
  for (const [index, row] of Array.from(rows).entries()) {
    row.disabled = blocked;
    const countNode = row.querySelector("output")!;
    const count = next?.regions[index];
    const enabled = regions[index].enabled;
    countNode.textContent = enabled ? shownCount(count) : "Off";
    row.setAttribute("aria-description", !enabled ? "Disabled" : count === undefined ? "Count unavailable" : shownCount(count) + " assigned centers");
  }
  get("no-regions").hidden = regions.length > 0;
  button("add-region").disabled = !asset || blocked || regions.length >= MAX_REGIONS;
  nameField.disabled = enabledField.disabled = !canEdit;
  button("region-earlier").disabled = !canEdit || selected <= 0;
  button("region-later").disabled = !canEdit || selected >= regions.length - 1;
  button("remove-region").disabled = !canEdit;
  button("open-recipe").disabled = !asset || blocked;
  button("save-recipe").disabled = !asset || blocked || editing;
  button("export-partition").disabled = blocked || !next;
  button("recount").hidden = !asset || summary !== undefined || !!job;

  const showProgress = blocked || job?.kind === "count-partition";
  progress.hidden = !showProgress;
  button("cancel-job").hidden = !showProgress;
}

function syncBounds(): void {
  bounds = mode === "crop" ? cropBounds : regionState.regions[regionState.selected]?.bounds;
  draft = undefined;
  if (bounds) writeFields(bounds);
  scheduleDraw();
}

function renderRegions(): void {
  const { regions, selected } = regionState;
  const list = get("region-list");
  while (list.childElementCount > regions.length) list.lastElementChild?.remove();
  for (const [index, region] of regions.entries()) {
    let row = list.children[index]?.querySelector("button");
    if (!row) {
      const item = document.createElement("li");
      row = document.createElement("button");
      row.type = "button";
      row.append(document.createElement("span"), document.createElement("output"));
      row.onclick = () => {
        discardDraft();
        regionState = { ...regionState, selected: index };
        syncBounds();
        renderRegions();
        refreshControls();
      };
      item.append(row);
      list.append(item);
    }
    row.setAttribute("aria-pressed", String(index === selected));
    row.setAttribute("aria-label", region.name);
    row.querySelector("span")!.textContent = region.name;
  }
  nameField.value = regions[selected]?.name ?? "";
  enabledField.checked = regions[selected]?.enabled ?? false;
}

function request(next: CropJob): void {
  job = next;
  progress.value = 0;
  worker.postMessage(next satisfies CropRequest);
  refreshControls();
}

function recount(status?: string): void {
  if (!asset) return;
  countStatus = status;
  if (mode === "regions") {
    summary = undefined;
    setStatus(status ?? "Counting partition ownership…");
    request({ kind: "count-partition", id: ++jobId, regions: regionState.regions });
  } else if (cropBounds) {
    inside = undefined;
    setStatus(status ?? "Counting splats…");
    request({ kind: "count", id: ++jobId, bounds: cropBounds });
  }
}

function open(file: File): void {
  discardDraft();
  setStatus("Reading " + file.name + "…");
  request({ kind: "load", id: ++jobId, file });
}

function pushHistory<T>(stack: T[], value: T): void {
  stack.push(value);
  if (stack.length > 64) stack.shift();
}

function setRegions(state: RegionState, status?: string): void {
  regionState = state;
  syncBounds();
  renderRegions();
  recount(status);
}

function commitRegions(regions: CaptureRegion[], selected: number, status?: string): void {
  pushHistory(regionUndo, regionState);
  regionRedo = [];
  setRegions({ regions, selected }, status);
}

function patchRegion(change: Partial<CaptureRegion>): void {
  const { selected, regions } = regionState;
  if (selected < 0 || editingBlocked()) return;
  commitRegions(regions.map((region, index) => index === selected ? { ...region, ...change } : region), selected);
}

function commitBounds(next: CropBounds): void {
  if (!bounds) return;
  if (same(bounds, next)) {
    discardDraft();
    return;
  }
  if (mode === "regions") {
    patchRegion({ bounds: next });
  } else {
    pushHistory(cropUndo, bounds);
    cropRedo = [];
    cropBounds = next;
    syncBounds();
    recount();
  }
}

function restore(backward: boolean): void {
  if (!asset || editingBlocked()) return;
  discardDraft();
  if (mode === "regions") {
    const next = (backward ? regionUndo : regionRedo).pop();
    if (!next) return;
    pushHistory(backward ? regionRedo : regionUndo, regionState);
    setRegions(next);
  } else if (cropBounds) {
    const next = (backward ? cropUndo : cropRedo).pop();
    if (!next) return;
    pushHistory(backward ? cropRedo : cropUndo, cropBounds);
    cropBounds = next;
    syncBounds();
    recount();
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

function closeBoundMenu(): void {
  if (boundMenu.matches(":popover-open")) boundMenu.hidePopover();
}


function writeFields(box: CropBounds): void {
  for (const side of ["min", "max"] as const) {
    for (const [axis, input] of inputs[side].entries()) writeField(input, box[side][axis]);
  }
}

function writeField(input: HTMLInputElement, value: number): void {
  const exact = String(value);
  input.title = exact + (lockedBounds.has(input) ? " · Middle-drag locked" : " · Middle-drag to adjust");
  input.value = exact;
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
  if (!asset) return;

  const { sample, bounds: extent } = asset;
  const pad = plotInset(width, height);
  const x = (value: number) => pad + fraction(value, extent.min[horizontal], extent.max[horizontal]) * (width - 2 * pad);
  const y = (value: number) => height - pad - fraction(value, extent.min[vertical], extent.max[vertical]) * (height - 2 * pad);
  for (const kept of [false, true]) {
    ctx.fillStyle = color(kept ? "--dot-in" : "--dot-out");
    for (let i = 0; i < sample.length; i += 3) {
      if ((selection !== undefined && containsCenter(sample, i, selection)) === kept) {
        ctx.fillRect(x(sample[i + horizontal]) - 0.8, y(sample[i + vertical]) - 0.8, 1.6, 1.6);
      }
    }
  }
  const outline = (box: CropBounds) => {
    const left = x(box.min[horizontal]);
    const top = y(box.max[vertical]);
    ctx.strokeRect(left, top, x(box.max[horizontal]) - left, y(box.min[vertical]) - top);
  };
  if (mode === "regions") {
    ctx.strokeStyle = color("--dot-out");
    ctx.globalAlpha = 0.55;
    for (const [index, region] of regionState.regions.entries()) {
      if (index !== regionState.selected && region.enabled) outline(region.bounds);
    }
  }
  if (!selection) return;
  ctx.strokeStyle = color("--focus");
  ctx.globalAlpha = 0.8;
  ctx.setLineDash([5, 4]);
  outline(selection);
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
        if (cancelGesture || editedField === input) discardDraft();
        else cancelWork();
      }
    });
    input.addEventListener("pointerdown", event => {
      if (event.button !== 1 || !asset || !bounds || editingBlocked() || cancelGesture || lockedBounds.has(input)) return;
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
    input.addEventListener("contextmenu", event => {
      event.preventDefault();
      closeBoundMenu();
      get("bound-menu-action").textContent = lockedBounds.has(input) ? "Unlock middle-drag" : "Lock middle-drag";
      lockedField = input;
      boundMenu.style.left = Math.min(event.clientX, window.innerWidth - 156) + "px";
      boundMenu.style.top = Math.min(event.clientY, window.innerHeight - 44) + "px";
      boundMenu.showPopover();
      button("bound-menu-action").focus({ preventScroll: true });
    });
    input.addEventListener("auxclick", event => {
      if (event.button === 1) event.preventDefault();
    });
  }
}

function addRegion(): void {
  if (!asset || editingBlocked() || regionState.regions.length >= MAX_REGIONS) return;
  const { regions } = regionState;
  const names = new Set(regions.map(region => region.name.toLowerCase()));
  let suffix = 1;
  while (names.has("region " + suffix)) suffix++;
  commitRegions([...regions, { name: "Region " + suffix, enabled: true, bounds: copy(cropBounds ?? asset.bounds) }], regions.length);
}

function moveRegion(offset: number): void {
  const { regions, selected } = regionState;
  const target = selected + offset;
  if (selected < 0 || target < 0 || target >= regions.length || editingBlocked()) return;
  const moved = [...regions];
  [moved[target], moved[selected]] = [moved[selected], moved[target]];
  commitRegions(moved, target);
}

function selectMode(next: typeof mode): void {
  if (next === mode || editingBlocked()) return;
  discardDraft();
  mode = next;
  syncBounds();
  if (isCount()) {
    worker.postMessage({ kind: "cancel" } satisfies CropRequest);
    job = undefined;
  }
  if (next === "regions" ? !summary : inside === undefined) recount();
  else setStatus(next === "regions" ? "Partition ready." : "Crop ready.");
  refreshControls();
}

function exportSide(side: CropSide): void {
  if (!cropBounds || editingBlocked() || draft || invalidField || inside === undefined) return;
  setStatus("Preparing " + side + " region…");
  request({ kind: "export", id: ++jobId, bounds: cropBounds, side });
}

function cancelWork(): void {
  if (!job || job.kind === "count") return;
  worker.postMessage({ kind: "cancel" } satisfies CropRequest);
  const previous = job;
  job = undefined;
  const message = "Operation canceled.";
  if (previous.kind === "load" && asset && (mode === "regions" ? !summary : inside === undefined)) recount(message);
  else setStatus(message);
  refreshControls();
}

function releaseDownload(): void {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined;
}

function download(file: Blob, suffix: string): void {
  clearTimeout(downloadTimer);
  releaseDownload();
  downloadUrl = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = (name.replace(/\.ply$/i, "") || "capture") + suffix;
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
    cropBounds = data.bounds;
    inside = data.count;
    cropUndo = [];
    cropRedo = [];
    regionState = { regions: [], selected: -1 };
    regionUndo = [];
    regionRedo = [];
    summary = { regions: [], overlap: 0, remainder: data.count };
    syncBounds();
    renderRegions();
    get("asset-name").textContent = name;
    get("asset-meta").textContent = number.format(data.count) + " splats";
    const points = data.sample.length / 3;
    get("sample-label").textContent = points < data.count ? number.format(points) + " sampled centers" : "";
    setStatus(mode === "regions" ? "Add a region or open a recipe for this capture." : "Drag in a projection or edit the bounds.");
  } else if (data.kind === "counted") {
    inside = data.inside;
    setStatus(countStatus ?? (inside === 0 ? "No centers fall inside these bounds." : "Crop ready."));
  } else if (data.kind === "counted-partition") {
    summary = data.summary;
    setStatus(countStatus ?? "Partition ready.");
  } else if (data.kind === "exported") {
    download(data.file, "-" + data.side + ".ply");
    setStatus("Download started for the " + data.side + " region.");
  } else if (data.kind === "exported-partition") {
    download(data.file, "-regions.zip");
    setStatus("Partition download started.");
  } else if (data.kind === "saved-recipe") {
    download(new Blob([JSON.stringify(data.recipe, null, 2)], { type: "application/json" }), "-regions.json");
    setStatus("Recipe download started.");
  } else if (data.kind === "opened-recipe") {
    const { regions } = data.recipe;
    commitRegions(regions, regions.length ? 0 : -1, "Regions recipe opened.");
  } else if (data.kind === "failed") {
    if (previousJob.kind === "load" && asset && (mode === "regions" ? !summary : inside === undefined)) recount(data.message);
    else setStatus(data.message);
  }
  refreshControls();
};

worker.onerror = () => {
  job = undefined;
  asset = undefined;
  cropBounds = bounds = undefined;
  inside = undefined;
  summary = undefined;
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
button("mode-crop").onclick = () => selectMode("crop");
button("mode-regions").onclick = () => selectMode("regions");
button("fit-bounds").onclick = () => { if (asset) commitBounds(asset.bounds); };
button("undo").onclick = () => restore(true);
button("redo").onclick = () => restore(false);
button("export-inside").onclick = () => exportSide("inside");
button("export-outside").onclick = () => exportSide("outside");
button("add-region").onclick = addRegion;
enabledField.onchange = () => patchRegion({ enabled: enabledField.checked });
button("region-earlier").onclick = () => moveRegion(-1);
button("region-later").onclick = () => moveRegion(1);
button("remove-region").onclick = () => {
  const { regions, selected } = regionState;
  commitRegions(regions.filter((_, index) => index !== selected), Math.min(selected, regions.length - 2));
};
nameField.onblur = () => {
  const { regions, selected } = regionState;
  const region = regions[selected];
  if (!region || nameField.value === region.name) return;
  const candidate = nameField.value;
  try {
    checkRegionName(candidate, regions.filter((_, index) => index !== selected).map(entry => entry.name));
    patchRegion({ name: candidate });
  } catch (error) {
    nameField.value = region.name;
    setStatus(error instanceof Error ? error.message : String(error));
  }
};
nameField.onkeydown = event => {
  if (event.key === "Enter") nameField.blur();
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  const original = regionState.regions[regionState.selected]?.name ?? "";
  if (nameField.value === original) cancelWork();
  else nameField.value = original;
};
button("open-recipe").onclick = () => recipeFile.click();
recipeFile.onchange = () => {
  const file = recipeFile.files?.[0];
  recipeFile.value = "";
  if (!file || !asset || editingBlocked()) return;
  discardDraft();
  setStatus("Checking recipe against this capture…");
  request({ kind: "open-recipe", id: ++jobId, file });
};
button("save-recipe").onclick = () => {
  if (!asset || editingBlocked() || draft || invalidField) return;
  setStatus("Preparing regions recipe…");
  request({ kind: "save-recipe", id: ++jobId, regions: regionState.regions });
};
button("export-partition").onclick = () => {
  if (!summary || editingBlocked() || draft || invalidField) return;
  setStatus("Preparing partition package…");
  request({ kind: "export-partition", id: ++jobId, regions: regionState.regions });
};
button("recount").onclick = () => recount();
button("cancel-job").onclick = cancelWork;
button("bound-menu-action").onclick = () => {
  const input = lockedField;
  if (!input) return;
  if (lockedBounds.has(input)) lockedBounds.delete(input);
  else lockedBounds.add(input);
  if (bounds) writeFields(bounds);
  closeBoundMenu();
  input.focus();
};
window.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (boundMenu.matches(":popover-open")) closeBoundMenu();
    else if (cancelGesture) cancelGesture();
    else cancelWork();
  }
  if (event.target instanceof HTMLInputElement || !event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if ((key === "z" || key === "y") && asset && !editingBlocked()) {
    event.preventDefault();
    restore(key === "z" && !event.shiftKey);
  }
});
window.addEventListener("pagehide", releaseDownload);
theme.addEventListener("change", scheduleDraw);
const resize = new ResizeObserver(scheduleDraw);
for (const { canvas } of views) resize.observe(canvas);
refreshControls();
scheduleDraw();
