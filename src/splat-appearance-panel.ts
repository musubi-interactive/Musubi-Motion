import { propertyInteraction } from "./property-interaction.ts";
import {
  APPEARANCE_LIMITS, APPEARANCE_PLANES, commitSplatAppearance, newSplatAppearanceLayer, replaceSplatAppearance,
  type SplatAppearanceLayer,
} from "./splat-appearance.ts";
import type { SplatSelectionIdentity } from "./splat-component-selection.ts";
import type { SceneDocument, SplatShapeNode } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import "./splat-appearance.css";

type Context = { shape: SplatShapeNode; identity: SplatSelectionIdentity };
type Options = {
  context: () => Context | undefined;
  available: () => boolean;
  onPreview: () => void;
  openGraph: () => void;
};
type Numeric = "blend" | "scaleU" | "scaleV" | "offsetU" | "offsetV" | "scaleMin" | "scaleMax";

export function createSplatAppearancePanel(store: SceneStore, options: Options) {
  const root = document.createElement("section");
  root.className = "splat-appearance";
  root.setAttribute("aria-label", "Splat Appearance");
  const subject = document.createElement("p"), status = document.createElement("p"), runtimeStatus = document.createElement("p");
  status.setAttribute("role", "status");
  runtimeStatus.setAttribute("aria-live", "polite");
  let selected = "";
  let draft: { base: SceneDocument; shapeId: string; doc: SceneDocument } | undefined;
  const layers = () => options.context()?.shape.appearance?.layers ?? [];
  const layer = () => layers().find(item => item.id === selected);
  const report = (message = "") => { status.textContent = message; };
  function cancel() {
    if (!draft) return;
    draft = undefined;
    options.onPreview();
  }
  function command(label: string, edit: (items: readonly SplatAppearanceLayer[]) => readonly SplatAppearanceLayer[]) {
    const context = options.context();
    if (!context || !options.available()) return;
    draft = undefined;
    try {
      commitSplatAppearance(store, context.identity, edit(layers()), label);
      report();
    } catch (error) { report((error as Error).message); }
    options.onPreview();
    refresh();
  }
  function change<K extends keyof SplatAppearanceLayer>(label: string, field: K, value: SplatAppearanceLayer[K]) {
    command(label, items => items.map(item => item.id === selected ? { ...item, [field]: value } : item));
  }
  function button(text: string, action: () => void) {
    const result = document.createElement("button");
    result.type = "button"; result.textContent = text; result.addEventListener("click", action);
    return result;
  }
  function field(label: string, input: HTMLElement) {
    const row = document.createElement("label");
    const title = document.createElement("span"); title.textContent = label;
    input.setAttribute("aria-label", label);
    row.append(title, input);
    return row;
  }
  function choices(select: HTMLSelectElement, values: readonly (readonly [string, string])[]) {
    const signature = JSON.stringify(values);
    if (select.dataset.choices === signature) return;
    select.dataset.choices = signature;
    select.replaceChildren(...values.map(([value, label]) => new Option(label, value)));
  }
  const graph = button("Open Texture Graph", options.openGraph);
  const layerSelect = document.createElement("select");
  layerSelect.addEventListener("change", () => { cancel(); selected = layerSelect.value; report(); refresh(); });
  const add = button("Add Layer", () => {
    const item = newSplatAppearanceLayer();
    const previous = selected; selected = item.id;
    command("Add splat appearance layer", items => [...items, item]);
    if (!layer()) { selected = previous; refresh(); }
  });
  const remove = button("Remove Layer", () => command("Remove splat appearance layer", items => items.filter(item => item.id !== selected)));
  function move(delta: number) {
    command("Reorder splat appearance layer", items => {
      const next = items.slice(), index = next.findIndex(item => item.id === selected), destination = index + delta;
      if (index < 0 || destination < 0 || destination >= next.length) return items;
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }
  const earlier = button("Move Earlier", () => move(-1)), later = button("Move Later", () => move(1));
  const actions = document.createElement("div"); actions.className = "splat-appearance-actions";
  actions.append(add, remove, earlier, later);
  const editor = document.createElement("fieldset");
  const legend = document.createElement("legend"); legend.textContent = "Texture Graph Output"; editor.append(legend);
  const controls: ((item: SplatAppearanceLayer) => void)[] = [];
  function select<K extends "space" | "plane" | "maskId">(
    label: string, key: K, entries: () => readonly (readonly [string, string])[],
  ) {
    const input = document.createElement("select");
    input.addEventListener("change", () => change("Set appearance " + label.toLowerCase(), key,
      (input.value || null) as SplatAppearanceLayer[K]));
    editor.append(field(label, input));
    controls.push(item => { choices(input, entries()); input.value = item[key] ?? ""; });
  }
  function check(label: string, key: "enabled" | "color" | "opacity" | "scale") {
    const input = document.createElement("input"); input.type = "checkbox";
    input.addEventListener("change", () => change("Set appearance " + label.toLowerCase(), key, input.checked));
    editor.append(field(label, input));
    controls.push(item => { input.checked = item[key]; });
  }
  function number(label: string, key: Numeric, min: number, max: number, step = .01) {
    const input = document.createElement("input");
    input.type = "number"; input.min = String(min); input.max = String(max); input.step = String(step);
    const row = field(label, input); editor.append(row);
    function preview(value: number) {
      const context = options.context(), item = layer(), base = store.getState().document;
      if (!context || !item || !options.available() || input.readOnly) return;
      try {
        const doc = replaceSplatAppearance(base, context.identity, layers().map(candidate =>
          candidate.id === item.id ? { ...candidate, [key]: value } : candidate));
        draft = doc === base ? undefined : { base, shapeId: context.shape.id, doc };
        report();
      } catch (error) { draft = undefined; report((error as Error).message); }
      options.onPreview();
    }
    let focusKey: string | undefined;
    const keyForInput = () => "splat-appearance:" + options.context()?.shape.id + ":" + selected + ":" + key;
    input.addEventListener("focus", () => { focusKey = keyForInput(); });
    input.addEventListener("input", () => preview(input.valueAsNumber));
    input.addEventListener("change", () => {
      if (!focusKey || focusKey === keyForInput()) change("Set appearance " + label.toLowerCase(), key, input.valueAsNumber);
      input.value = String(layer()?.[key] ?? "");
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Escape" && draft) {
        event.preventDefault(); event.stopPropagation();
        cancel(); input.value = String(layer()?.[key] ?? "");
      }
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
    });
    input.addEventListener("blur", () => { focusKey = undefined; cancel(); });
    const refreshLock = propertyInteraction(input, keyForInput,
      row, () => ({ update: preview, end: cancel }));
    controls.push(item => {
      if (document.activeElement !== input && !draft) input.value = String(item[key]);
      refreshLock();
    });
  }
  check("Enabled", "enabled");
  select("Projection Space", "space", () => [["object", "Object"], ["world", "World"]]);
  select("Planar Axes", "plane", () => APPEARANCE_PLANES.map(value => [value, value]));
  const extent = APPEARANCE_LIMITS.coordinate;
  number("U Scale", "scaleU", -extent, extent); number("V Scale", "scaleV", -extent, extent);
  number("U Offset", "offsetU", -extent, extent); number("V Offset", "offsetV", -extent, extent);
  select("Scalar Mask", "maskId", () => [["", "Whole Object"], ...(options.context()?.shape.scalarMasks ?? []).map(mask => [mask.id, mask.name] as const)]);
  number("Blend", "blend", 0, 1);
  check("Color", "color"); check("Opacity", "opacity"); check("Scale", "scale");
  number("Scale at Alpha 0", "scaleMin", .01, APPEARANCE_LIMITS.scale);
  number("Scale at Alpha 1", "scaleMax", .01, APPEARANCE_LIMITS.scale);
  root.append(subject, graph, field("Appearance Layer", layerSelect), actions, editor, status, runtimeStatus);
  let previousShape: string | undefined, previousLayer = "";
  function refresh() {
    const context = options.context(), available = options.available(), scene = store.getState().document;
    if (draft && (!available || draft.base !== scene || draft.shapeId !== context?.shape.id)) cancel();
    const changedShape = previousShape !== context?.shape.id;
    if (changedShape) { previousShape = context?.shape.id; report(); }
    const items = layers();
    if (!items.some(item => item.id === selected)) selected = items[0]?.id ?? "";
    const selectedIndex = items.findIndex(item => item.id === selected), item = items[selectedIndex];
    if (changedShape || previousLayer !== selected) {
      // A stale focused edit must never commit into a different shape or layer.
      if (editor.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      previousLayer = selected;
    }
    const owner = context ? scene.nodes[context.shape.parentId]?.name ?? context.shape.name : "";
    subject.textContent = !context ? "Select one loaded splat object." : !scene.proceduralGraph
      ? "Create a Texture Graph to add a layer." : owner + " · Earlier layers evaluate first.";
    choices(layerSelect, items.map((entry, index) => [entry.id, "Layer " + (index + 1) + (entry.enabled ? "" : " (disabled)")]));
    layerSelect.value = selected; layerSelect.disabled = !available || !items.length;
    add.disabled = !available || !context || !scene.proceduralGraph || items.length >= APPEARANCE_LIMITS.layers;
    remove.disabled = !available || !item; earlier.disabled = !available || selectedIndex < 1;
    later.disabled = !available || selectedIndex < 0 || selectedIndex >= items.length - 1;
    editor.hidden = !item; editor.disabled = !available;
    if (item) for (const control of controls) control(item);
  }
  new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) cancel(); }).observe(root);
  return {
    element: root, refresh,
    evaluationDocument() { return draft?.base === store.getState().document ? draft.doc : store.getState().document; },
    runtimeStatus(message: string) { if (runtimeStatus.textContent !== message) runtimeStatus.textContent = message; },
  };
}
