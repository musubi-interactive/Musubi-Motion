import "./style.css";
import type { UVLayout } from "./obj.ts";
import type { ParseResult } from "./parse-worker.ts";
import { drawTile, firstMappedTile, tileLabel, tileSegments, type Segment, type Tile } from "./tile.ts";

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const source = element<HTMLInputElement>("source");
const checker = element<HTMLInputElement>("checker");
const edgeMode = element<HTMLSelectElement>("edges");
const resolution = element<HTMLSelectElement>("resolution");
const lineColor = element<HTMLSelectElement>("line-color");
const canvas = element<HTMLCanvasElement>("layout");
const download = element<HTMLButtonElement>("download");
const tileU = element<HTMLInputElement>("tile-u");
const tileV = element<HTMLInputElement>("tile-v");
const firstTile = element<HTMLButtonElement>("first-tile");
const sourceStatus = element("source-status");
const exportStatus = element("export-status");
const objectsPanel = element("objects");
const darkTheme = matchMedia("(prefers-color-scheme: dark)");
const selected = new Set<number>();
let worker: Worker | undefined;
let layout: UVLayout | undefined;
let sourceName = "";
let tile: Tile = { u: 0, v: 0 };
let segments: Segment[] = [];
let mappedTile: Tile | undefined;
let exporting = false;

function redraw() {
  drawTile(canvas, segments, darkTheme.matches ? "#f0f0f0" : "#171717",
    { checker: checker.checked, dark: darkTheme.matches });
}

function refreshPreview() {
  element("tile-label").textContent = tileLabel(tile);
  canvas.setAttribute("aria-label", `${tileLabel(tile)} UV preview`);
  const bordersOnly = edgeMode.value === "borders";
  segments = layout ? tileSegments(layout, selected, tile, bordersOnly) : [];
  mappedTile = layout && firstMappedTile(layout, selected, bordersOnly);
  firstTile.disabled = !mappedTile;
  if (layout) {
    const summary = selected.size === 0 ? "Select an object to see its UVs."
      : segments.length === 0 ? "No selected edges cross this tile."
      : `${segments.length.toLocaleString()} visible edge segments`;
    element("tile-summary").textContent = summary;
    let faces = 0, islands = 0, missing = 0, degenerate = 0, outside = 0;
    for (const index of selected) {
      const object = layout.objects[index];
      faces += object.faces;
      islands += object.islands;
      missing += object.missing;
      degenerate += object.degenerate;
      outside += object.outside;
    }
    element("diagnostics").textContent =
      `${faces.toLocaleString()} faces · ${islands.toLocaleString()} islands. `
      + `${missing.toLocaleString()} with missing UVs · ${degenerate.toLocaleString()} near-zero UV area · `
      + `${outside.toLocaleString()} outside tile 0, 0.`;
  }
  download.disabled = exporting || segments.length === 0;
  redraw();
}

function renderObjects(layout: UVLayout) {
  const list = document.createDocumentFragment();
  layout.objects.forEach((object, index) => {
    const row = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(index);
    const name = document.createElement("span");
    name.className = "object-name";
    name.textContent = object.name;
    const count = document.createElement("span");
    count.className = "object-count";
    count.textContent = `${object.faces.toLocaleString()} ${object.faces === 1 ? "face" : "faces"}`;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(index);
      else selected.delete(index);
      refreshPreview();
    });
    row.append(checkbox, name, count);
    list.append(row);
  });
  objectsPanel.replaceChildren(list);
}

function selectAll(checked: boolean) {
  selected.clear();
  objectsPanel.querySelectorAll("input").forEach((checkbox, index) => {
    checkbox.checked = checked;
    if (checked) selected.add(index);
  });
  refreshPreview();
}

function showSourceError(error: string) {
  sourceStatus.classList.add("error");
  sourceStatus.textContent = layout ? `${error} Still showing ${sourceName}.` : error;
}

function loadFile(file: File) {
  worker?.terminate();
  worker = undefined;
  sourceStatus.classList.remove("error");
  sourceStatus.textContent = `Reading ${file.name}…`;
  let request: Worker;
  try {
    request = new Worker(new URL("./parse-worker.ts", import.meta.url), { type: "module" });
    worker = request;
  } catch {
    showSourceError("Could not start the local OBJ reader.");
    return;
  }
  const fail = () => {
    if (worker !== request) return;
    worker = undefined;
    request.terminate();
    showSourceError("Could not read this OBJ file.");
  };
  request.addEventListener("error", fail);
  request.addEventListener("messageerror", fail);
  request.addEventListener("message", (event: MessageEvent<ParseResult>) => {
    if (worker !== request) return;
    worker = undefined;
    request.terminate();
    const result = event.data;
    if ("error" in result) {
      showSourceError(result.error);
      return;
    }
    layout = result.layout;
    sourceName = file.name;
    sourceStatus.textContent = sourceName;
    if (!exporting) exportStatus.textContent = "The PNG has a transparent background.";
    element("objects-section").hidden = false;
    selected.clear();
    for (const index of layout.objects.keys()) selected.add(index);
    renderObjects(layout);
    refreshPreview();
  });
  try { request.postMessage(file); }
  catch { fail(); }
}

function downloadSnapshot() {
  if (exporting || !segments.length) return;
  const size = Number(resolution.value);
  const suffix = tileLabel(tile).toLowerCase().replace(/[^\w-]+/g, "_");
  const name = sourceName.replace(/\.obj$/i, "").replace(/[^\w.-]+/g, "_").slice(0, 100) || "layout";
  const filename = `${name}_${suffix}_${size}.png`;
  exporting = true;
  download.disabled = true;
  exportStatus.textContent = "Creating PNG…";
  const output = document.createElement("canvas");
  output.width = output.height = size;
  function finish(blob: Blob | null) {
    if (blob) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      exportStatus.textContent = `Downloaded ${filename}.`;
    } else {
      exportStatus.textContent = "Could not create the UV snapshot.";
    }
    output.width = output.height = 0;
    exporting = false;
    download.disabled = segments.length === 0;
  }
  try {
    drawTile(output, segments, lineColor.value);
    output.toBlob(finish, "image/png");
  } catch {
    finish(null);
  }
}

element("choose-source").addEventListener("click", () => source.click());
source.addEventListener("change", () => {
  const file = source.files?.[0];
  source.value = "";
  if (file) loadFile(file);
});
element("all-objects").addEventListener("click", () => selectAll(true));
element("clear-objects").addEventListener("click", () => selectAll(false));
firstTile.addEventListener("click", () => {
  if (!mappedTile) return;
  tile = mappedTile;
  tileU.value = String(tile.u);
  tileV.value = String(tile.v);
  refreshPreview();
});
element<HTMLFormElement>("tile-form").addEventListener("submit", event => {
  event.preventDefault();
  tile = { u: tileU.valueAsNumber, v: tileV.valueAsNumber };
  refreshPreview();
});
edgeMode.addEventListener("change", refreshPreview);
checker.addEventListener("change", redraw);
darkTheme.addEventListener("change", redraw);
download.addEventListener("click", downloadSnapshot);
new ResizeObserver(redraw).observe(canvas);
redraw();
