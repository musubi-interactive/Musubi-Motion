import "./style.css";
import {
  BURST_FPS, MAX_RECIPE_BYTES, defaultRecipe, numbers, type NumberField,
} from "./burst.ts";
import {
  MAX_COMPOUND_BIRTHS, MAX_COMPOUND_BYTES, MAX_STAGE_NAME, MAX_STAGES,
  compileCompound, exampleRecipe, parseCompoundRecipe, stageStart, totalBirths,
  type BurstStage, type CompoundRecipe,
} from "./compound.ts";
import { encodeBurstPly } from "./ply.ts";
import { createBurstPreview } from "./preview.ts";

type ColorField = "birthColor" | "deathColor";
type StageField = NumberField | ColorField | "startTime";
type HistoryEntry = { recipe: CompoundRecipe; selectedId: string; frame: number };
const colorLabels = { birthColor: "Start color", deathColor: "End color" };
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const settings = byId("settings");
const status = byId("status");
const count = byId("count");
const viewport = byId("viewport");
const fileInput = byId<HTMLInputElement>("recipe-file");
const frameInput = byId<HTMLInputElement>("frame");
const timeline = byId<HTMLInputElement>("timeline");
const play = byId<HTMLButtonElement>("play");
const frameView = byId<HTMLButtonElement>("frame-view");
const bake = byId<HTMLButtonElement>("export");
const undo = byId<HTMLButtonElement>("undo");
const redo = byId<HTMLButtonElement>("redo");
const stageSelect = byId<HTMLSelectElement>("stage-select");
const stageName = byId<HTMLInputElement>("stage-name");
const stageEnabled = byId<HTMLInputElement>("stage-enabled");
const stageSolo = byId<HTMLButtonElement>("stage-solo");
const stageAdd = byId<HTMLButtonElement>("stage-add");
const stageRemove = byId<HTMLButtonElement>("stage-remove");
const stageDuplicate = byId<HTMLButtonElement>("stage-duplicate");
const stageUp = byId<HTMLButtonElement>("stage-up");
const stageDown = byId<HTMLButtonElement>("stage-down");
const stageBudget = byId("stage-budget");

const fields = new Map<StageField, HTMLInputElement>();
const history: HistoryEntry[] = [];
const future: HistoryEntry[] = [];
const historyLimit = 64;
const exampleFrame = 10;
let recipe = exampleRecipe;
let selectedId = recipe.stages[0].id;
let burst = compileCompound(recipe);
let soloPreview = false;
let frame = exampleFrame;
let playing = false;
let playRequest = 0;
let importRevision = 0;
let cancelActiveEdit: (() => void) | undefined;
let preview: ReturnType<typeof createBurstPreview> | undefined;

try {
  preview = createBurstPreview(viewport);
} catch {
  const message = document.createElement("p");
  message.textContent = "WebGL preview is unavailable. You can still bake a PLY.";
  viewport.append(message);
  frameView.disabled = true;
}

function say(message: string) {
  status.textContent = message;
}

function setFrame(value: number) {
  frame = Math.min(burst.lastFrame, Math.max(0, value));
  timeline.max = frameInput.max = String(burst.lastFrame);
  timeline.value = frameInput.value = String(frame);
  const snapshot = burst.sample(frame, soloPreview ? selectedId : undefined);
  const previewCount = snapshot.count;
  preview?.show(snapshot);
  const bakeCount = soloPreview ? burst.sample(frame).count : previewCount;
  const particleText = bakeCount === 1 ? " particle" : " particles";
  const description = soloPreview
    ? previewCount.toLocaleString() + " in solo preview · " + bakeCount.toLocaleString() + " to bake"
    : bakeCount.toLocaleString() + particleText;
  count.textContent = description + " · " + (frame / BURST_FPS).toFixed(2) + " s";
  bake.disabled = bakeCount === 0;
  bake.title = bakeCount === 0 ? "Choose a frame with particles from enabled stages." : "";
}

function stop() {
  playing = false;
  cancelAnimationFrame(playRequest);
  play.textContent = "Play";
}

function renderRecipe(next: CompoundRecipe, requestedFrame = frame) {
  burst = compileCompound(next);
  setFrame(requestedFrame);
}

function selectedStage() {
  return recipe.stages.find(stage => stage.id === selectedId)!;
}

function fieldValue(stage: BurstStage, field: StageField) {
  return field === "startTime" ? stage.startTime : stage.burst[field];
}

function availableBirths() {
  return MAX_COMPOUND_BIRTHS - totalBirths(recipe.stages);
}

function refreshFields() {
  const stage = selectedStage();
  const stageIndex = recipe.stages.indexOf(stage);
  const remainingBirths = availableBirths();
  const atStageLimit = recipe.stages.length === MAX_STAGES;
  const stageOptions = recipe.stages.map(item => new Option(item.name, item.id));
  stageSelect.replaceChildren(...stageOptions);
  stageSelect.value = selectedId;
  stageName.value = stage.name;
  stageEnabled.checked = stage.enabled;
  stageSolo.setAttribute("aria-pressed", String(soloPreview));
  stageAdd.disabled = atStageLimit || remainingBirths === 0;
  stageDuplicate.disabled = atStageLimit || remainingBirths < stage.burst.count;
  stageRemove.disabled = recipe.stages.length <= 1;
  stageUp.disabled = stageIndex <= 0;
  stageDown.disabled = stageIndex === recipe.stages.length - 1;
  stageBudget.textContent = totalBirths(recipe.stages).toLocaleString() + " / " + MAX_COMPOUND_BIRTHS.toLocaleString() + " particles across all stages";
  for (const [field, input] of fields) input.value = String(fieldValue(stage, field));
  fields.get("count")!.max = String(remainingBirths + stage.burst.count);
  undo.disabled = history.length === 0;
  redo.disabled = future.length === 0;
}

function restore(requestedFrame = frame) {
  renderRecipe(recipe, requestedFrame);
  refreshFields();
}

function commit(next: CompoundRecipe, nextSelected = selectedId, requestedFrame = frame, previousFrame = frame) {
  stop();
  if (JSON.stringify(next) !== JSON.stringify(recipe)) {
    history.push({ recipe, selectedId, frame: previousFrame });
    if (history.length > historyLimit) history.shift();
    future.length = 0;
    recipe = next;
    importRevision++;
  }
  selectedId = next.stages.some(stage => stage.id === nextSelected) ? nextSelected : next.stages[0].id;
  restore(requestedFrame);
}

function traverse(from: HistoryEntry[], to: HistoryEntry[]) {
  const next = from.pop();
  if (!next) return;
  stop();
  cancelActiveEdit?.();
  to.push({ recipe, selectedId, frame });
  recipe = next.recipe;
  selectedId = next.selectedId;
  importRevision++;
  restore(next.frame);
  say("");
}

function changeStage(next: BurstStage) {
  return parseCompoundRecipe({
    version: 2,
    stages: recipe.stages.map(stage => stage.id === selectedId ? next : stage),
  });
}

function candidate(field: StageField, input: HTMLInputElement) {
  const stage = selectedStage();
  if (field === "startTime") return changeStage({ ...stage, startTime: input.valueAsNumber });
  const value = input.type === "color" ? input.value : input.valueAsNumber;
  return changeStage({ ...stage, burst: { ...stage.burst, [field]: value } });
}

function addField(group: HTMLElement, field: StageField) {
  const line = document.createElement("label");
  line.className = "field";
  const label = document.createElement("span");
  const input = document.createElement("input");
  const numeric = field === "startTime" ? stageStart : numbers[field as NumberField];
  input.name = field;
  input.type = numeric ? "number" : "color";
  label.textContent = numeric?.label ?? colorLabels[field as ColorField];
  line.append(label, input);
  group.append(line);
  fields.set(field, input);

  let initialFrame: number | undefined;
  let drag: { id: number; x: number; value: number } | undefined;

  function startEdit() {
    if (initialFrame === undefined) {
      cancelActiveEdit?.();
      initialFrame = frame;
      cancelActiveEdit = cancelEdit;
      importRevision++;
    }
    stop();
    say("");
  }

  function previewEdit() {
    startEdit();
    try {
      renderRecipe(candidate(field, input), initialFrame);
    } catch {
      // A partially typed number remains a draft until commit.
    }
  }

  function finishEdit() {
    const previousFrame = initialFrame ?? frame;
    initialFrame = undefined;
    if (cancelActiveEdit === cancelEdit) cancelActiveEdit = undefined;
    try {
      const next = candidate(field, input);
      commit(next, selectedId, previousFrame, previousFrame);
    } catch (error) {
      restore(previousFrame);
      say((error as Error).message);
    }
  }

  function cancelEdit() {
    const pointer = drag;
    drag = undefined;
    if (pointer && input.hasPointerCapture(pointer.id)) input.releasePointerCapture(pointer.id);
    restore(initialFrame);
    initialFrame = undefined;
    cancelActiveEdit = undefined;
    say("Edit canceled.");
  }

  input.addEventListener("input", previewEdit);
  input.addEventListener("change", finishEdit);
  input.addEventListener("keydown", event => {
    if (event.key === "Escape" && initialFrame !== undefined) {
      event.preventDefault();
      cancelEdit();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      finishEdit();
    }
  });

  if (numeric) {
    input.min = String(numeric.min);
    input.max = String(numeric.max);
    input.step = field === "count" || field === "seed" ? "1" : "any";
    input.title = "Middle-drag to scrub. Escape cancels the edit.";
    input.addEventListener("mousedown", event => {
      if (event.button === 1) event.preventDefault();
    });
    input.addEventListener("pointerdown", event => {
      if (event.button !== 1 || drag) return;
      event.preventDefault();
      input.focus();
      startEdit();
      drag = { id: event.pointerId, x: event.clientX, value: Number(fieldValue(selectedStage(), field)) };
      input.setPointerCapture(event.pointerId);
    });
    input.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.id) return;
      const raw = drag.value + Math.trunc((event.clientX - drag.x) / 3) * numeric.step;
      const value = Math.min(Number(input.max), Math.max(numeric.min, raw));
      input.value = String(Number(value.toFixed(5)));
      previewEdit();
    });
    input.addEventListener("pointerup", event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = undefined;
      finishEdit();
    });
    input.addEventListener("lostpointercapture", () => {
      if (drag) cancelEdit();
    });
  }
}

addField(byId("stage-time"), "startTime");
const groups: Array<[string, StageField[]]> = [
  ["Emission", ["count", "seed", "duration", "lifetime", "originX", "originY", "originZ"]],
  ["Dynamics", ["azimuth", "elevation", "spread", "speed", "speedVariation", "gravity"]],
  ["Shading", ["birthDiameter", "deathDiameter", "birthColor", "deathColor", "birthOpacity", "deathOpacity"]],
];
for (const [name, controls] of groups) {
  const group = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = name;
  group.append(legend);
  for (const field of controls) addField(group, field);
  settings.append(group);
}

function commitStages(stages: BurstStage[], nextSelected: string) {
  commit(parseCompoundRecipe({ version: 2, stages }), nextSelected);
  say("");
}

function insertStage(copy: boolean) {
  const stage = selectedStage();
  const id = crypto.getRandomValues(new Uint32Array(4)).join("-");
  const next = copy
    ? { ...stage, id, name: stage.name.slice(0, MAX_STAGE_NAME - 5) + " Copy" }
    : {
      id, name: "Stage " + (recipe.stages.length + 1), startTime: 0, enabled: true,
      burst: { ...defaultRecipe, count: Math.min(defaultRecipe.count, availableBirths()) },
    };
  const stages = [...recipe.stages];
  stages.splice(stages.indexOf(stage) + 1, 0, next);
  commitStages(stages, id);
}

function moveStage(offset: -1 | 1) {
  const stage = selectedStage();
  const stages = [...recipe.stages];
  const index = stages.indexOf(stage);
  stages.splice(index, 1);
  stages.splice(index + offset, 0, stage);
  commitStages(stages, selectedId);
}

stageName.maxLength = MAX_STAGE_NAME;
stageName.addEventListener("change", () => {
  try {
    commit(changeStage({ ...selectedStage(), name: stageName.value.trim() }));
    say("");
  } catch (error) {
    refreshFields();
    say((error as Error).message);
  }
});
stageName.addEventListener("keydown", event => {
  if (event.key === "Enter") stageName.blur();
  if (event.key === "Escape") {
    stageName.value = selectedStage().name;
    say("Edit canceled.");
  }
});
stageSelect.addEventListener("change", () => {
  const id = stageSelect.value;
  cancelActiveEdit?.();
  selectedId = id;
  refreshFields();
  setFrame(frame);
  say("");
});
stageEnabled.addEventListener("change", () => {
  commit(changeStage({ ...selectedStage(), enabled: stageEnabled.checked }));
  say("");
});
stageSolo.addEventListener("click", () => {
  soloPreview = !soloPreview;
  stageSolo.setAttribute("aria-pressed", String(soloPreview));
  setFrame(frame);
  say("");
});
stageAdd.addEventListener("click", () => insertStage(false));
stageDuplicate.addEventListener("click", () => insertStage(true));
stageUp.addEventListener("click", () => moveStage(-1));
stageDown.addEventListener("click", () => moveStage(1));
stageRemove.addEventListener("click", () => {
  const stage = selectedStage();
  const index = recipe.stages.indexOf(stage);
  const stages = recipe.stages.filter(item => item !== stage);
  commitStages(stages, stages[Math.min(index, stages.length - 1)].id);
});

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Give the browser time to start consuming the object URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

play.addEventListener("click", () => {
  if (playing) {
    stop();
    return;
  }
  if (frame >= burst.lastFrame) setFrame(0);
  const start = performance.now();
  const initial = frame;
  playing = true;
  play.textContent = "Pause";
  const tick = (now: number) => {
    const requested = initial + Math.floor((now - start) * BURST_FPS / 1000);
    if (requested !== frame) setFrame(requested);
    if (frame >= burst.lastFrame) stop();
    if (playing) playRequest = requestAnimationFrame(tick);
  };
  playRequest = requestAnimationFrame(tick);
});
frameView.addEventListener("click", () => preview?.frame(burst.sample(frame, soloPreview ? selectedId : undefined)));
timeline.addEventListener("input", () => {
  stop();
  setFrame(timeline.valueAsNumber);
});
frameInput.addEventListener("change", () => {
  stop();
  const next = frameInput.valueAsNumber;
  if (!Number.isFinite(next) || next < 0 || next > burst.lastFrame) {
    frameInput.value = String(frame);
    say("Enter a frame from 0 to " + burst.lastFrame + ".");
    return;
  }
  say("");
  setFrame(next);
});

byId("open").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  const revision = ++importRevision;
  try {
    if (file.size > MAX_COMPOUND_BYTES) throw Error("Particle recipes are limited to 16 KiB.");
    const content = await file.text();
    if (revision !== importRevision) return;
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw Error("The selected file does not contain valid JSON.");
    }
    if (typeof json === "object" && json !== null && "version" in json && json.version === 1 && file.size > MAX_RECIPE_BYTES) {
      throw Error("Version 1 particle recipes are limited to 4 KiB.");
    }
    const next = parseCompoundRecipe(json);
    soloPreview = false;
    commit(next, next.stages[0].id);
    preview?.frame(burst.sample(frame));
    say("Opened " + file.name + ".");
  } catch (error) {
    if (revision === importRevision) say((error as Error).message);
  }
});
byId("example").addEventListener("click", () => {
  importRevision++;
  soloPreview = false;
  commit(exampleRecipe, exampleRecipe.stages[0].id, exampleFrame);
  preview?.frame(burst.sample(frame));
  say("Loaded the flash, sparks and afterburst example.");
});
byId("save").addEventListener("click", () => {
  download(new Blob([JSON.stringify(recipe, null, 2) + "\n"], { type: "application/json" }), "particle-burst.json");
  say("Recipe saved.");
});
bake.addEventListener("click", () => {
  stop();
  const snapshot = burst.sample(frame);
  download(encodeBurstPly(snapshot), "particle-burst-f" + String(frame).padStart(3, "0") + ".ply");
  say("Baked " + snapshot.count.toLocaleString() + " particles at frame " + frame + ".");
});
undo.addEventListener("click", () => traverse(history, future));
redo.addEventListener("click", () => traverse(future, history));
document.addEventListener("keydown", event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
    || event.target instanceof HTMLElement && event.target.isContentEditable) return;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "z" || key === "y") {
    event.preventDefault();
    if (key === "y" || event.shiftKey) traverse(future, history);
    else traverse(history, future);
  }
});

const theme = byId("theme");
const themes = ["system", "dark", "light"] as const;
let themeIndex = 0;
theme.addEventListener("click", () => {
  themeIndex = (themeIndex + 1) % themes.length;
  const selected = themes[themeIndex];
  document.documentElement.dataset.theme = selected;
  theme.textContent = "Theme: " + selected[0].toUpperCase() + selected.slice(1);
});
window.addEventListener("pagehide", event => {
  stop();
  if (!event.persisted) preview?.dispose();
});

refreshFields();
setFrame(frame);
