import {
  commitMixamoTake, inspectMixamoMapping, loadMixamoSource, mixamoPreviewPose, stageMixamoTakeAsync,
  type MixamoSource, type MixamoStage,
} from "./mixamo-import.ts";
import type { SceneStore } from "./scene-store.ts";
import "./motion-import-panel.css";

export function createMotionImportPanel(store: SceneStore, options: {
  available(): boolean;
  selectedJoint(): string | undefined;
  onImport(stage: MixamoStage): void;
}) {
  const element = document.createElement("section");
  element.className = "motion-import-panel";
  element.setAttribute("aria-label", "Motion Import");
  element.innerHTML = `
    <div class="motion-content">
    <label>Animation FBX <input type="file" accept=".fbx"></label>
    <label>Target rig <select data-rig aria-label="Target rig"></select></label>
    <div data-source hidden>
      <label>Take <select data-take aria-label="Take"></select></label>
      <fieldset>
        <legend>Joint Mapping</legend>
        <label>Source joint <select data-joint aria-label="Source joint"></select></label>
        <label>Target joint <select data-target aria-label="Target joint"></select></label>
        <button type="button" data-reset>Apply Mixamo Preset</button>
        <div class="motion-mapping">
          <table>
            <thead><tr><th scope="col">Source</th><th scope="col">Target</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </fieldset>
    </div>
    <div data-preview hidden>
      <canvas width="288" height="166" role="img" aria-label="Staged clip skeleton preview"></canvas>
      <label>Preview frame <input type="range" min="0" step="1" value="0"></label>
      <output></output>
    </div>
    </div>
    <div class="motion-actions">
      <button type="button" data-import disabled>Import Clip</button>
      <button type="button" data-cancel disabled>Cancel</button>
    </div>
    <p role="status" aria-live="polite">Choose a Mixamo animation FBX downloaded Without Skin.</p>`;
  const query = <T extends HTMLElement>(selector: string) => element.querySelector<T>(selector)!;
  const file = query<HTMLInputElement>("input[type=file]"), rig = query<HTMLSelectElement>("[data-rig]");
  const take = query<HTMLSelectElement>("[data-take]"), sourcePanel = query("[data-source]");
  const sourceJoint = query<HTMLSelectElement>("[data-joint]"), targetJoint = query<HTMLSelectElement>("[data-target]");
  const reset = query<HTMLButtonElement>("[data-reset]"), table = query<HTMLTableSectionElement>("tbody");
  const importButton = query<HTMLButtonElement>("[data-import]"), cancel = query<HTMLButtonElement>("[data-cancel]");
  const previewPanel = query("[data-preview]"), previewFrame = query<HTMLInputElement>("input[type=range]");
  const previewCanvas = query<HTMLCanvasElement>("canvas"), frameLabel = query<HTMLOutputElement>("output");
  const status = query("[role=status]");
  const assignments = new Map<string, string>();
  let source: MixamoSource | undefined, stage: MixamoStage | undefined, revision = 0, reading = false;
  let pending: AbortController | undefined;
  let previousDocument: ReturnType<SceneStore["getState"]>["document"] | undefined;
  let bounds = { left: 0, right: 0, bottom: 0, top: 0 };

  function projected(next: MixamoStage, frame: number) {
    return mixamoPreviewPose(next, frame).map(point => ({
      ...point, x: point.position.x + point.position.z * .4, y: point.position.y + point.position.z * .18,
    }));
  }
  function drawPreview() {
    const context = previewCanvas.getContext("2d");
    if (!context || !stage) return;
    const frame = Number(previewFrame.value);
    const width = previewCanvas.width, height = previewCanvas.height;
    const points = projected(stage, frame), { left, right, bottom, top } = bounds;
    const scale = Math.min((width - 24) / Math.max(1e-6, right - left), (height - 24) / Math.max(1e-6, top - bottom));
    const byId = new Map(points.map(point => [point.id, {
      x: width / 2 + (point.x - (left + right) / 2) * scale,
      y: height / 2 - (point.y - (bottom + top) / 2) * scale,
    }]));
    context.clearRect(0, 0, width, height);
    context.strokeStyle = context.fillStyle = "#858585";
    context.lineWidth = 1.5;
    context.beginPath();
    for (const point of points) {
      const position = byId.get(point.id)!;
      const parent = point.parentId ? byId.get(point.parentId) : undefined;
      if (!parent) continue;
      context.moveTo(parent.x, parent.y);
      context.lineTo(position.x, position.y);
    }
    context.stroke();
    for (const { x, y } of byId.values()) {
      context.beginPath();
      context.arc(x, y, 2.25, 0, Math.PI * 2);
      context.fill();
    }
    frameLabel.textContent = `Frame ${stage.start + frame} of ${stage.start}–${stage.end}`;
  }

  function setStage(next?: MixamoStage) {
    stage = next;
    previewPanel.hidden = !next;
    importButton.disabled = !next || !options.available();
    if (!next) return;
    previewFrame.max = String(next.end - next.start);
    previewFrame.value = "0";
    previewFrame.disabled = next.end === next.start;
    const span = next.end - next.start, segments = Math.max(1, Math.min(12, span));
    const points = Array.from({ length: segments + 1 }, (_, index) => projected(next, index * span / segments)).flat();
    bounds = {
      left: Math.min(...points.map(point => point.x)), right: Math.max(...points.map(point => point.x)),
      bottom: Math.min(...points.map(point => point.y)), top: Math.max(...points.map(point => point.y)),
    };
    drawPreview();
  }

  function renderTargetChoice(mapping: ReturnType<typeof inspectMixamoMapping>) {
    const row = mapping.rows.find(item => item.source?.id === sourceJoint.value);
    targetJoint.replaceChildren(new Option("Mixamo preset", ""), ...mapping.targetJoints.map(joint => new Option(joint.name, joint.id)));
    targetJoint.value = assignments.get(sourceJoint.value) ?? "";
    targetJoint.disabled = !row?.source || !mapping.targetJoints.length;
  }

  async function review() {
    pending?.abort();
    pending = undefined;
    setStage();
    if (!source) return;
    const doc = store.getState().document;
    const mapping = inspectMixamoMapping(source, doc, rig.value, assignments);
    renderTargetChoice(mapping);
    table.replaceChildren(...mapping.rows.map(row => {
      const tr = document.createElement("tr"), label = document.createElement("th"), target = document.createElement("td");
      label.scope = "row";
      label.textContent = row.source?.name ?? row.role;
      target.textContent = row.target?.name ?? "—";
      if (row.message) {
        const error = document.createElement("small");
        error.textContent = row.message;
        target.append(error);
      }
      tr.append(label, target);
      return tr;
    }));
    if (!mapping.valid) {
      const count = mapping.rows.filter(row => row.message).length;
      status.textContent = mapping.errors[0] ?? `Review ${count} joint mapping ${count === 1 ? "issue" : "issues"}.`;
      return;
    }
    const request = new AbortController();
    pending = request;
    status.textContent = "Preparing take preview…";
    try {
      const next = await stageMixamoTakeAsync(source, Number(take.value), doc, rig.value, assignments, request.signal);
      if (request.signal.aborted || pending !== request) return;
      setStage(next);
      status.textContent = `${next.jointIds.length} joints · Frames ${next.start}–${next.end}`;
    } catch (error) {
      if (!request.signal.aborted && pending === request) status.textContent = (error as Error).message;
    } finally {
      if (pending === request) pending = undefined;
    }
  }

  function refresh() {
    const doc = store.getState().document, available = options.available();
    file.disabled = !available;
    rig.disabled = !available || !doc.joints?.length;
    importButton.disabled = !stage || !available;
    if (doc === previousDocument) return false;
    previousDocument = doc;
    const roots = (doc.joints ?? []).filter(joint => joint.parentId === null);
    const active = rig.value;
    const joints = new Map(doc.joints?.map(joint => [joint.id, joint]));
    let preferred = joints.get(options.selectedJoint() ?? "");
    while (preferred?.parentId) preferred = joints.get(preferred.parentId);
    rig.replaceChildren(new Option(roots.length ? "Choose a rig" : "Import a matching rig first", ""),
      ...roots.map(joint => new Option(joint.name, joint.id)));
    rig.value = roots.some(joint => joint.id === active) ? active : preferred?.id ?? (roots.length === 1 ? roots[0].id : "");
    if (rig.value !== active) assignments.clear();
    void review();
    return true;
  }

  function clear(message: string, keepFile = false) {
    ++revision;
    pending?.abort();
    pending = undefined;
    reading = false;
    source = undefined;
    if (!keepFile) file.value = "";
    assignments.clear();
    sourcePanel.hidden = true;
    take.replaceChildren();
    sourceJoint.replaceChildren();
    table.replaceChildren();
    setStage();
    cancel.disabled = true;
    status.textContent = message;
  }

  file.onchange = async () => {
    const chosen = file.files?.[0];
    if (!chosen || !options.available()) return;
    clear(`Reading ${chosen.name}…`, true);
    const current = revision;
    reading = true;
    cancel.disabled = false;
    try {
      const result = await loadMixamoSource(chosen);
      if (current !== revision) return;
      source = result;
      sourcePanel.hidden = false;
      take.replaceChildren(...result.takes.map((clip, index) => new Option(
        `${clip.name || `Take ${index + 1}`} · ${Number(clip.duration.toFixed(2))} s`, String(index),
      )));
      sourceJoint.replaceChildren(...result.bones.map(bone => new Option(bone.name || "(unnamed)", bone.id)));
      if (!refresh()) void review();
    } catch (error) {
      if (current === revision) clear((error as Error).message);
    } finally {
      if (current === revision) reading = false;
    }
  };
  rig.onchange = () => { assignments.clear(); void review(); };
  take.onchange = () => void review();
  sourceJoint.onchange = () => {
    if (source) renderTargetChoice(inspectMixamoMapping(source, store.getState().document, rig.value, assignments));
  };
  targetJoint.onchange = () => {
    if (targetJoint.value) assignments.set(sourceJoint.value, targetJoint.value);
    else assignments.delete(sourceJoint.value);
    void review();
  };
  reset.onclick = () => { assignments.clear(); void review(); };
  previewFrame.oninput = drawPreview;
  cancel.onclick = () => { clear("Motion import canceled."); file.focus(); };
  element.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !reading && !source) return;
    event.preventDefault();
    event.stopPropagation();
    cancel.click();
  });
  importButton.onclick = () => {
    if (!stage || !options.available()) return;
    const next = stage;
    try {
      clear(`Imported ${next.name} · Frames ${next.start}–${next.end}`);
      commitMixamoTake(store, next);
      options.onImport(next);
    } catch (error) { status.textContent = (error as Error).message; }
  };
  refresh();
  return { element, refresh };
}
