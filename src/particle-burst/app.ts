import "./style.css";
import {
  BURST_FPS, MAX_RECIPE_BYTES, compileBurst, defaultRecipe, lastBurstFrame, numbers, parseRecipe,
  type BurstRecipe, type NumberField,
} from "./burst.ts";
import { encodeBurstPly } from "./ply.ts";
import { createBurstPreview } from "./preview.ts";

type ColorField = "birthColor" | "deathColor";
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

const fields = new Map<NumberField | ColorField, HTMLInputElement>();
const history: BurstRecipe[] = [];
const future: BurstRecipe[] = [];
const historyLimit = 64;
let recipe = { ...defaultRecipe };
let displayed = recipe;
let burst = compileBurst(recipe);
let frame = 24;
let playing = false;
let playRequest = 0;
let importRevision = 0;
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
  frame = Math.min(lastBurstFrame(displayed), Math.max(0, value));
  timeline.max = frameInput.max = String(lastBurstFrame(displayed));
  timeline.value = frameInput.value = String(frame);
  const snapshot = burst.sample(frame);
  preview?.show(snapshot);
  const particleText = snapshot.count === 1 ? " particle" : " particles";
  count.textContent = snapshot.count.toLocaleString() + particleText + " · " + (frame / BURST_FPS).toFixed(2) + " s";
  bake.disabled = snapshot.count === 0;
  bake.title = snapshot.count === 0 ? "Choose a frame with visible particles." : "";
}

function stop() {
  playing = false;
  cancelAnimationFrame(playRequest);
  play.textContent = "Play";
}

function renderRecipe(next: BurstRecipe, requestedFrame = frame) {
  displayed = next;
  burst = compileBurst(next);
  setFrame(requestedFrame);
}

function refreshFields() {
  for (const [field, input] of fields) input.value = String(recipe[field]);
  undo.disabled = history.length === 0;
  redo.disabled = future.length === 0;
}

function restore(requestedFrame = frame) {
  renderRecipe(recipe, requestedFrame);
  refreshFields();
}

function commit(next: BurstRecipe) {
  if ([...fields.keys()].some(key => next[key] !== recipe[key])) {
    history.push(recipe);
    if (history.length > historyLimit) history.shift();
    future.length = 0;
    recipe = next;
    importRevision++;
  }
  restore();
}

function traverse(from: BurstRecipe[], to: BurstRecipe[]) {
  const next = from.pop();
  if (!next) return;
  stop();
  to.push(recipe);
  recipe = next;
  importRevision++;
  restore();
  say("");
}

function candidate(field: NumberField | ColorField, input: HTMLInputElement) {
  return parseRecipe({ ...recipe, [field]: input.type === "color" ? input.value : input.valueAsNumber });
}

function addField(group: HTMLFieldSetElement, field: NumberField | ColorField) {
  const line = document.createElement("label");
  line.className = "field";
  const label = document.createElement("span");
  const input = document.createElement("input");
  const numeric = field in numbers ? numbers[field as NumberField] : undefined;
  input.name = field;
  input.type = numeric ? "number" : "color";
  label.textContent = numeric?.label ?? colorLabels[field as ColorField];
  line.append(label, input);
  group.append(line);
  fields.set(field, input);

  let initialFrame: number | undefined;
  let drag: { id: number; x: number; value: number } | undefined;

  function startEdit() {
    if (initialFrame === undefined) initialFrame = frame;
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
    try {
      const next = candidate(field, input);
      commit(next);
    } catch (error) {
      restore(initialFrame);
      say((error as Error).message);
    }
    initialFrame = undefined;
  }

  function cancelEdit() {
    const pointer = drag;
    drag = undefined;
    if (pointer && input.hasPointerCapture(pointer.id)) input.releasePointerCapture(pointer.id);
    restore(initialFrame);
    initialFrame = undefined;
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
      drag = { id: event.pointerId, x: event.clientX, value: recipe[field as NumberField] };
      input.setPointerCapture(event.pointerId);
    });
    input.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.id) return;
      const raw = drag.value + Math.trunc((event.clientX - drag.x) / 3) * numeric.step;
      const value = Math.min(numeric.max, Math.max(numeric.min, raw));
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

const groups: Array<[string, (NumberField | ColorField)[]]> = [
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
  if (frame >= lastBurstFrame(displayed)) setFrame(0);
  const start = performance.now();
  const initial = frame;
  playing = true;
  play.textContent = "Pause";
  const tick = (now: number) => {
    const requested = initial + Math.floor((now - start) * BURST_FPS / 1000);
    if (requested !== frame) setFrame(requested);
    if (frame >= lastBurstFrame(displayed)) stop();
    if (playing) playRequest = requestAnimationFrame(tick);
  };
  playRequest = requestAnimationFrame(tick);
});
frameView.addEventListener("click", () => preview?.frame(burst.sample(frame)));
timeline.addEventListener("input", () => {
  stop();
  setFrame(timeline.valueAsNumber);
});
frameInput.addEventListener("change", () => {
  stop();
  const next = frameInput.valueAsNumber;
  if (!Number.isInteger(next) || next < 0 || next > lastBurstFrame(displayed)) {
    frameInput.value = String(frame);
    say("Enter a whole frame from 0 to " + lastBurstFrame(displayed) + ".");
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
    if (file.size > MAX_RECIPE_BYTES) throw Error("Particle recipes are limited to 4 KB.");
    const content = await file.text();
    if (revision !== importRevision) return;
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw Error("The selected file does not contain valid JSON.");
    }
    const next = parseRecipe(json);
    stop();
    commit(next);
    preview?.frame(burst.sample(frame));
    say("Opened " + file.name + ".");
  } catch (error) {
    if (revision === importRevision) say((error as Error).message);
  }
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
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLElement && event.target.isContentEditable) return;
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
