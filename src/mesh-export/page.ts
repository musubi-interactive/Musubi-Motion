import { defaultAnimation } from "../animation.ts";
import { decodeProjectBlob } from "../project-archive.ts";
import type { SceneDocument } from "../scene-document.ts";
import { exportMeshObj, listMeshExportRows, type MeshExportOptions } from "./obj.ts";
import "./page.css";

const source = document.querySelector<HTMLInputElement>("#source")!;
const sourceStatus = document.querySelector("#source-status")!;
const meshSection = document.querySelector<HTMLElement>("#mesh-section")!;
const meshes = document.querySelector("#meshes")!;
const selectAll = document.querySelector<HTMLButtonElement>("#select-all")!;
const clear = document.querySelector<HTMLButtonElement>("#clear")!;
const selectionStatus = document.querySelector("#selection-status")!;
const options = document.querySelector<HTMLFieldSetElement>("#options")!;
const space = document.querySelector<HTMLSelectElement>("#space")!;
const frame = document.querySelector<HTMLInputElement>("#frame")!;
const frameRange = document.querySelector("#frame-range")!;
const topology = document.querySelector<HTMLSelectElement>("#topology")!;
const download = document.querySelector<HTMLButtonElement>("#download")!;
const exportStatus = document.querySelector("#export-status")!;

let project: { scene: SceneDocument; fileName: string } | undefined;
let openRequest = 0;
const enabledRows = new Map<string, HTMLInputElement>();
const selected = new Set<string>();

function updateSelection() {
  download.disabled = selected.size === 0;
  selectAll.disabled = selected.size === enabledRows.size;
  clear.disabled = selected.size === 0;
  selectionStatus.textContent = selected.size + " of " + enabledRows.size + " exportable meshes selected.";
  exportStatus.textContent = "";
}

function setSelection(checked: boolean) {
  selected.clear();
  for (const [id, input] of enabledRows) {
    input.checked = checked;
    if (checked) selected.add(id);
  }
  updateSelection();
}

function updateSpace() {
  frame.disabled = space.value !== "world";
  frameRange.textContent = !project ? "" : frame.disabled
    ? "Uses the original geometry coordinates of each mesh."
    : "Frame range: " + frame.min + " to " + frame.max + ". Defaults to the saved playhead.";
  exportStatus.textContent = "";
}

document.querySelector<HTMLButtonElement>("#choose-source")!.addEventListener("click", () => source.click());

source.addEventListener("change", async () => {
  const file = source.files?.[0];
  if (!file) return;
  // Keep the chosen name in the status and allow reopening the same path.
  source.value = "";
  const request = ++openRequest;
  project = undefined;
  enabledRows.clear();
  selected.clear();
  meshes.replaceChildren();
  meshSection.hidden = true;
  options.disabled = true;
  frame.value = "";
  updateSpace();
  updateSelection();
  sourceStatus.textContent = "Opening " + file.name + "…";

  try {
    const { scene, editor } = await decodeProjectBlob(file);
    if (request !== openRequest) return;
    const rows = listMeshExportRows(scene);
    if (!rows.length) {
      sourceStatus.textContent = file.name + " contains no polygon meshes. Choose a project with polygon geometry.";
      return;
    }

    const items = document.createDocumentFragment();
    for (const row of rows) {
      const item = document.createElement("li");
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.disabled = Boolean(row.unavailable);
      if (!row.unavailable) {
        enabledRows.set(row.id, checkbox);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(row.id);
          else selected.delete(row.id);
          updateSelection();
        });
      }
      const name = document.createElement("span");
      name.textContent = row.label;
      const detail = document.createElement("span");
      detail.className = "mesh-detail";
      detail.id = "mesh-detail-" + row.id;
      detail.textContent = row.unavailable ?? (row.faceCount + (row.faceCount === 1 ? " face" : " faces"));
      checkbox.setAttribute("aria-describedby", detail.id);
      label.append(checkbox, name);
      item.append(label, detail);
      items.append(item);
    }
    meshes.append(items);
    meshSection.hidden = false;
    const { start, end, fps } = scene.animation ?? defaultAnimation();
    frame.min = String(start);
    frame.max = String(end);
    frame.value = String(Math.max(start, Math.min(end, editor.time * fps)));
    project = { scene, fileName: file.name };
    options.disabled = enabledRows.size === 0;
    sourceStatus.textContent = "Opened " + file.name + ".";
    setSelection(true);
    updateSpace();
  } catch (error) {
    if (request !== openRequest) return;
    const detail = error instanceof Error ? error.message : String(error);
    sourceStatus.textContent = "Could not open " + file.name + ". " + detail + " Choose a current Musubi Motion project (.msb).";
  }
});

selectAll.addEventListener("click", () => {
  setSelection(true);
  clear.focus();
});
clear.addEventListener("click", () => {
  setSelection(false);
  selectAll.focus();
});
space.addEventListener("change", updateSpace);
frame.addEventListener("input", () => { exportStatus.textContent = ""; });
topology.addEventListener("change", () => { exportStatus.textContent = ""; });

document.querySelector<HTMLFormElement>("#export-form")!.addEventListener("submit", event => {
  event.preventDefault();
  if (!project || !selected.size) return;
  try {
    const blob = exportMeshObj(project.scene, selected, {
      space: space.value as MeshExportOptions["space"],
      topology: topology.value as MeshExportOptions["topology"],
      frame: frame.valueAsNumber,
    });
    const fileName = (project.fileName.replace(/\.msb$/i, "") || "meshes") + ".obj";
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportStatus.textContent = "Prepared " + fileName + " with " + selected.size + (selected.size === 1 ? " mesh." : " meshes.");
  } catch (error) {
    exportStatus.textContent = "Could not export OBJ. " + (error instanceof Error ? error.message : String(error));
  }
});
