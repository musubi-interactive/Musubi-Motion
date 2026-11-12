import { propertyInteraction } from "./property-interaction.ts";
import { defaultSoftFalloffCurve, MAX_SOFT_FALLOFF_POINTS, prepareSoftFalloffCurve, validateSoftFalloffCurve, type SoftFalloffCurve, type SoftFalloffPoint } from "./splat-soft-selection.ts";

export const SOFT_FALLOFF_PRESET_KEY = "musubi.soft-falloff.presets.v1";
const MAX_PRESETS = 8;
type Preset = { name: string; points: SoftFalloffCurve };

export function parseSoftFalloffPresets(raw: string): Preset[] {
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > MAX_PRESETS) throw Error("Use at most eight falloff presets.");
  const names = new Set<string>();
  return values.map(value => {
    const name = typeof value?.name === "string" ? value.name.trim() : "";
    if (!name || name.length > 40 || names.has(name.toLowerCase())) throw Error("Falloff presets need unique names of 1–40 characters.");
    validateSoftFalloffCurve(value.points);
    names.add(name.toLowerCase());
    return { name, points: value.points };
  });
}

export type SoftFalloffPreview = { update(points: SoftFalloffCurve): void; end(): void };

export function createSoftFalloffEditor(actions: { change(points: SoftFalloffCurve): void; preview(): SoftFalloffPreview | undefined }) {
  const element = document.createElement("details");
  element.className = "soft-falloff-editor";
  element.innerHTML = `<summary>Edit custom falloff</summary>
    <style>
      .soft-falloff-editor{margin-top:8px}.soft-falloff-editor .falloff-controls{display:grid;gap:6px;margin-top:6px}
      .soft-falloff-editor .falloff-plot{width:100%;height:110px;display:block;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:3px;touch-action:none;cursor:crosshair}
      .soft-falloff-editor .falloff-plot[aria-disabled=true]{opacity:.45;cursor:default}
      .soft-falloff-editor .falloff-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;align-items:end}
      .soft-falloff-editor input{width:100%;min-width:0;box-sizing:border-box;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:5px}
      .soft-falloff-editor input[type=number]{text-align:right}.soft-falloff-editor [data-locked]{opacity:.55}.soft-falloff-editor .falloff-message{min-height:1.3em;margin-top:0}
    </style>
    <div class="falloff-controls">
      <p>Weight over distance from the center. Click to add, drag to edit, or use the point fields. Esc cancels.</p>
      <svg class="falloff-plot" role="img" aria-label="Soft falloff curve graph" viewBox="0 0 240 112" preserveAspectRatio="none" tabindex="-1">
        <path d="M10 8V100H230 M10 54H230 M120 8V100" fill="none" stroke="var(--line)" vector-effect="non-scaling-stroke"/>
        <path data-curve fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
        <g data-points></g>
      </svg>
      <label>Point <select aria-label="Soft falloff point"></select></label>
      <div class="falloff-row">
        <label>Distance <input aria-label="Falloff point distance" type="number" min="0" max="1" step="0.01"></label>
        <label>Weight <input aria-label="Falloff point weight" type="number" min="0" max="1" step="0.01"></label>
      </div>
      <div class="falloff-row"><button type="button" data-add>Add Point</button><button type="button" data-remove>Remove Point</button></div>
      <label>Saved falloffs (8 max) <select aria-label="Saved soft falloff preset"></select></label>
      <label>Preset name <input aria-label="Soft falloff preset name" maxlength="40"></label>
      <div class="falloff-row"><button type="button" data-save>Save Preset</button><button type="button" data-delete>Delete Preset</button></div>
      <p class="falloff-message" role="status"></p>
    </div>`;
  const find = <T extends Element>(selector: string) => element.querySelector<T>(selector)!;
  const graph = find<SVGSVGElement>("svg"), path = find<SVGPathElement>("[data-curve]"), nodes = find<SVGGElement>("[data-points]");
  const select = find<HTMLSelectElement>('[aria-label="Soft falloff point"]');
  const distance = find<HTMLInputElement>('[aria-label="Falloff point distance"]');
  const weight = find<HTMLInputElement>('[aria-label="Falloff point weight"]');
  const add = find<HTMLButtonElement>("[data-add]"), remove = find<HTMLButtonElement>("[data-remove]");
  const presets = find<HTMLSelectElement>('[aria-label="Saved soft falloff preset"]');
  const name = find<HTMLInputElement>('[aria-label="Soft falloff preset name"]');
  const save = find<HTMLButtonElement>("[data-save]"), deletePreset = find<HTMLButtonElement>("[data-delete]");
  const message = find<HTMLParagraphElement>(".falloff-message");
  let saved: Preset[] = [];
  try { saved = parseSoftFalloffPresets(localStorage.getItem(SOFT_FALLOFF_PRESET_KEY) ?? "[]"); }
  catch { message.textContent = "Saved falloff presets could not be read."; }
  let current = defaultSoftFalloffCurve(), selected = 0, available = false;
  let edit: { before: number; draft: SoftFalloffCurve; preview: SoftFalloffPreview; changed: boolean; frame?: number; applied: boolean } | undefined;
  let pointer: number | undefined;
  let rendered: SoftFalloffCurve | undefined, renderedIndex = -1;
  const x = (value: number) => 10 + value * 220;
  const y = (value: number) => 100 - value * 92;
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

  function render(forceValues = false) {
    const points = edit?.draft ?? current;
    selected = Math.max(0, Math.min(points.length - 1, selected));
    const point = points[selected], endpoint = selected === 0 || selected === points.length - 1;
    if (rendered !== points || renderedIndex !== selected) {
      if (rendered !== points) {
        const { segments } = prepareSoftFalloffCurve(points);
        const commands = segments.map(({ width, first, second }, i) => {
          const left = points[i], right = points[i + 1];
          return `C${x(left.distance + width / 3)},${y(first)} ${x(right.distance - width / 3)},${y(second)} ${x(right.distance)},${y(right.weight)}`;
        });
        path.setAttribute("d", `M${x(0)},${y(1)} ${commands.join(" ")}`);
        select.replaceChildren(...points.map((item, i) => new Option(`${i + 1} · ${Number(item.distance.toFixed(4))} / ${Number(item.weight.toFixed(4))}${i === 0 || i === points.length - 1 ? " (fixed)" : ""}`, String(i))));
      }
      nodes.replaceChildren(...points.map((item, i) => {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.dataset.point = String(i);
        circle.setAttribute("cx", String(x(item.distance))); circle.setAttribute("cy", String(y(item.weight)));
        circle.setAttribute("r", i === selected ? "5" : "4");
        circle.setAttribute("fill", i === selected ? "currentColor" : "var(--bg)");
        circle.setAttribute("stroke", "currentColor");
        return circle;
      }));
      rendered = points; renderedIndex = selected;
    }
    select.value = String(selected);
    if (forceValues || document.activeElement !== distance) distance.value = String(point.distance);
    if (forceValues || document.activeElement !== weight) weight.value = String(point.weight);
    select.disabled = presets.disabled = name.disabled = !available;
    distance.disabled = weight.disabled = remove.disabled = !available || endpoint;
    add.disabled = !available || points.length >= MAX_SOFT_FALLOFF_POINTS;
    graph.setAttribute("aria-disabled", String(!available));
    const replace = saved.some(preset => preset.name.toLowerCase() === name.value.trim().toLowerCase());
    save.textContent = replace ? "Update Preset" : "Save Preset";
    save.disabled = !available || !name.value.trim() || !replace && saved.length >= MAX_PRESETS;
    deletePreset.disabled = !available || !presets.value;
  }

  function begin() {
    if (!available) return undefined;
    if (edit) return edit;
    const preview = actions.preview();
    if (preview) edit = { before: selected, draft: current, preview, changed: false, applied: false };
    return edit;
  }

  function stage(points: SoftFalloffCurve) {
    const active = edit;
    if (!active) return;
    active.draft = points; active.changed = true; render();
    active.frame ??= requestAnimationFrame(() => {
      active.frame = undefined;
      if (edit !== active) return;
      active.applied = true;
      active.preview.update(active.draft);
    });
  }

  function finish(commit: boolean) {
    const active = edit;
    if (!active) return;
    edit = undefined;
    if (active.frame !== undefined) cancelAnimationFrame(active.frame);
    const target = commit ? selected : active.before;
    if (active.applied) active.preview.end();
    if (commit && active.changed) actions.change(active.draft);
    selected = target; render(true);
  }

  function changedPoint(points: SoftFalloffCurve, point: SoftFalloffPoint) {
    const prior = points[selected];
    if (prior.distance === point.distance && prior.weight === point.weight) return points;
    const next = points.map((item, i) => i === selected ? point : item);
    validateSoftFalloffCurve(next);
    return next;
  }

  function setCoordinate(field: keyof SoftFalloffPoint, value: number, commit: boolean) {
    if (!available || selected === 0 || selected === current.length - 1) return;
    try {
      // The parent can publish a previous preview on a different animation frame.
      const base = edit?.draft ?? current;
      const next = changedPoint(base, { ...base[selected], [field]: value });
      if (next !== base && begin()) stage(next);
      message.textContent = "";
      if (commit) finish(true);
    } catch (error) {
      message.textContent = (error as Error).message;
      if (commit) finish(false);
    }
    if (commit) render(true);
  }

  for (const [field, input] of [["distance", distance], ["weight", weight]] as const) {
    input.addEventListener("pointerdown", event => { if (event.button === 1 && !input.disabled && !input.readOnly) input.focus(); });
    const lock = propertyInteraction(input, () => `soft-falloff-point-${field}`, undefined, () => ({
      update: value => setCoordinate(field, value, false), end: () => finish(false),
    }));
    input.addEventListener("focus", lock);
    input.oninput = () => { if (!input.readOnly && input.value) setCoordinate(field, input.valueAsNumber, false); };
    input.onchange = () => { if (!input.readOnly) setCoordinate(field, input.valueAsNumber, true); };
    input.onblur = () => finish(false);
    input.onkeydown = event => {
      if (event.key !== "Escape" && event.key !== "Enter") return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") { finish(false); render(true); message.textContent = ""; }
      else if (!input.readOnly) setCoordinate(field, input.valueAsNumber, true);
      input.blur();
    };
  }

  function graphPoint(event: PointerEvent) {
    const rect = graph.getBoundingClientRect();
    return { distance: clamp(((event.clientX - rect.left) / rect.width * 240 - 10) / 220, 0, 1), weight: clamp((100 - (event.clientY - rect.top) / rect.height * 112) / 92, 0, 1) };
  }

  function insert(points: SoftFalloffCurve, point: SoftFalloffPoint) {
    const index = points.findIndex(item => item.distance > point.distance);
    if (index <= 0 || point.distance <= points[index - 1].distance || points.length >= MAX_SOFT_FALLOFF_POINTS) return;
    const next = [...points];
    next.splice(index, 0, { distance: point.distance, weight: clamp(point.weight, points[index].weight, points[index - 1].weight) });
    selected = index;
    return next;
  }

  graph.onpointerdown = event => {
    if (!available || event.button !== 0 || pointer !== undefined) return;
    graph.focus();
    const point = (event.target as SVGElement).dataset.point;
    if (point !== undefined) {
      selected = Number(point); render(true);
      if (selected === 0 || selected === current.length - 1 || !begin()) return;
    } else {
      if (!begin()) return;
      const next = insert(current, graphPoint(event));
      if (!next) { finish(false); return; }
      stage(next);
    }
    event.preventDefault();
    pointer = event.pointerId; graph.setPointerCapture(pointer);
  };
  graph.onpointermove = event => {
    if (event.pointerId !== pointer || !edit) return;
    const points = edit.draft, left = points[selected - 1], right = points[selected + 1];
    const point = graphPoint(event), margin = Math.min(.001, (right.distance - left.distance) / 4);
    try {
      const next = changedPoint(points, { distance: clamp(point.distance, left.distance + margin, right.distance - margin), weight: clamp(point.weight, right.weight, left.weight) });
      if (next !== points) stage(next);
    } catch (error) { message.textContent = (error as Error).message; }
  };
  function finishPointer(commit: boolean) {
    const captured = pointer;
    pointer = undefined;
    if (captured !== undefined && graph.hasPointerCapture(captured)) graph.releasePointerCapture(captured);
    finish(commit);
  }
  graph.onpointerup = event => { if (event.pointerId === pointer) finishPointer(true); };
  graph.onpointercancel = graph.onlostpointercapture = event => { if (event.pointerId === pointer) finishPointer(false); };
  graph.onkeydown = event => {
    if (pointer === undefined) return;
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); finishPointer(false); }
  };
  select.onchange = () => { selected = Number(select.value); render(true); };
  add.onclick = () => {
    const i = Math.min(selected, current.length - 2), left = current[i], right = current[i + 1];
    const next = insert(current, { distance: (left.distance + right.distance) / 2, weight: (left.weight + right.weight) / 2 });
    if (next) actions.change(next);
  };
  remove.onclick = () => {
    const next = current.filter((_, i) => i !== selected);
    selected--; actions.change(next);
  };

  function showPresets(selection = "") {
    presets.replaceChildren(new Option("Choose a saved falloff", ""), ...saved.map(preset => new Option(preset.name, preset.name)));
    presets.value = selection; render();
  }
  function storePresets(selection = "") {
    message.textContent = "";
    try { localStorage.setItem(SOFT_FALLOFF_PRESET_KEY, JSON.stringify(saved)); }
    catch { message.textContent = "Browser storage is unavailable. Presets last for this session."; }
    showPresets(selection);
  }
  presets.onchange = () => {
    const preset = saved.find(item => item.name === presets.value);
    if (preset) { name.value = preset.name; selected = 0; actions.change(preset.points); }
    render();
  };
  name.oninput = () => render();
  save.onclick = () => {
    const label = name.value.trim();
    const index = saved.findIndex(preset => preset.name.toLowerCase() === label.toLowerCase());
    const next = { name: label, points: current };
    if (index < 0) saved.push(next);
    else saved[index] = next;
    storePresets(label);
  };
  deletePreset.onclick = () => { saved = saved.filter(item => item.name !== presets.value); name.value = ""; storePresets(); };
  showPresets();

  return { element, update(points: SoftFalloffCurve, enabled: boolean) {
    current = points; available = enabled;
    if (!enabled && edit) finishPointer(false);
    render();
  } };
}
