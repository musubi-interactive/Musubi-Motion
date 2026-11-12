import { propertyInteraction } from "./property-interaction.ts";
import {
  ATTRIBUTE_PAINT_LIMITS, defaultSplatPaintSettings, validateSplatPaintSettings,
  type SplatPaintSettings,
} from "./splat-attribute-paint.ts";
import type { SplatPaintContext } from "./splat-attribute-paint-tool.ts";
import "./splat-paint.css";

type Options = {
  available(): boolean;
  busy(): boolean;
  context(): SplatPaintContext | undefined;
  setBrush(settings?: SplatPaintSettings): void;
  chooseComponents(): void;
  clear(): void;
};

export function createSplatPaintPanel(options: Options) {
  const root = document.createElement("section");
  root.className = "splat-paint-panel";
  root.setAttribute("aria-label", "Paint Splat Attributes");
  const summary = document.createElement("p"), message = document.createElement("p");
  message.setAttribute("role", "status");
  const fields = document.createElement("fieldset");
  const legend = document.createElement("legend"); legend.textContent = "Paint Attributes"; fields.append(legend);
  const controls: (() => void)[] = [];
  let settings = { ...defaultSplatPaintSettings }, painting = false, shapeId = "";
  const report = (text: string) => { message.textContent = text; };
  const button = (text: string, action: () => void) => {
    const element = document.createElement("button"); element.type = "button"; element.textContent = text;
    element.addEventListener("click", action); return element;
  };
  function row(label: string, input: HTMLElement) {
    const element = document.createElement("label"), title = document.createElement("span"); title.textContent = label;
    input.setAttribute("aria-label", label); element.append(title, input); fields.append(element); return element;
  }
  function apply(change: Partial<SplatPaintSettings>) {
    const next = { ...settings, ...change };
    try { validateSplatPaintSettings(next); settings = next; if (painting) options.setBrush(next); report(""); }
    catch (error) { report((error as Error).message); }
    refresh();
  }
  function stopPainting() {
    if (!painting) return;
    painting = false; toggle.textContent = "Start Painting"; options.setBrush(undefined);
  }
  const toggle = button("Start Painting", () => {
    if (painting) { stopPainting(); refresh(); return; }
    const context = options.context();
    if (!context || !options.available()) return;
    if (settings.selectedOnly && !context.selected.length) { report("Select original splat components first."); return; }
    painting = true;
    options.setBrush(settings); report("Drag in the viewport to paint. Hold B and drag to resize."); refresh();
  });
  const choose = button("Select Components", () => { stopPainting(); options.chooseComponents(); refresh(); });
  const clear = button("Clear Paint Layer", () => {
    try { options.clear(); report("Cleared the layer in one undoable edit."); } catch (error) { report((error as Error).message); }
    refresh();
  });
  function select<K extends "operation" | "channels" | "depth" | "falloff" | "maskId">(
    label: string, key: K, items: () => readonly (readonly [string, string])[],
  ) {
    const input = document.createElement("select");
    input.onchange = () => apply({ [key]: input.value || null });
    row(label, input);
    controls.push(() => {
      const values = items(), signature = JSON.stringify(values);
      if (input.dataset.choices !== signature) {
        input.dataset.choices = signature; input.replaceChildren(...values.map(([value, label]) => new Option(label, value)));
      }
      input.value = settings[key] ?? "";
    });
  }
  function number(label: string, key: "radius" | "strength" | "opacity", min: number, max: number, step: number) {
    const input = document.createElement("input");
    input.type = "number"; input.min = String(min); input.max = String(max); input.step = String(step);
    const field = row(label, input);
    input.onchange = () => { apply({ [key]: input.valueAsNumber }); input.value = String(settings[key]); };
    input.onkeydown = event => {
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.value = String(settings[key]); }
    };
    const refreshLock = propertyInteraction(input, () => "splat-attribute-paint:" + key, field, () => ({
      update(value) { if (painting) options.setBrush({ ...settings, [key]: value }); },
      end() { if (painting) options.setBrush(settings); },
    }));
    controls.push(() => {
      if (document.activeElement !== input) input.value = String(settings[key]);
      input.disabled = key === "opacity" && (settings.channels === "color" || settings.operation === "erase");
      refreshLock();
    });
  }
  select("Operation", "operation", () => [["replace", "Replace"], ["erase", "Erase"]]);
  select("Channels", "channels", () => [["color", "Color (RGB)"], ["opacity", "Opacity (Alpha)"], ["both", "Color and Opacity (RGBA)"]]);
  const color = document.createElement("input"); color.type = "color"; color.onchange = () => apply({ color: color.value });
  row("Brush Color", color);
  controls.push(() => { color.value = settings.color; color.disabled = settings.channels === "opacity" || settings.operation === "erase"; });
  number("Target Opacity", "opacity", 0, 1, .01);
  number("Brush Radius (px)", "radius", 1, 512, 1);
  number("Brush Strength", "strength", 0, 1, .01);
  select("Falloff", "falloff", () => [["constant", "Constant"], ["linear", "Linear"], ["smooth", "Smooth"]]);
  select("Occlusion", "depth", () => [["front", "Front Centers"], ["through", "Through"]]);
  select("Scalar Mask", "maskId", () => [["", "Whole Object"], ...(options.context()?.shape.scalarMasks ?? []).map(mask => [mask.id, mask.name] as const)]);
  const selected = document.createElement("input"); selected.type = "checkbox"; selected.onchange = () => apply({ selectedOnly: selected.checked });
  row("Selected Splats Only", selected);
  controls.push(() => { selected.checked = settings.selectedOnly; });
  const actions = document.createElement("div"); actions.className = "splat-paint-actions"; actions.append(toggle, choose, clear);
  root.append(summary, fields, actions, message);
  function refresh() {
    const context = options.context(), busy = options.busy(), available = options.available();
    const nextId = context?.shape.id ?? "";
    if (shapeId !== nextId || !available) {
      stopPainting();
      if (shapeId !== nextId) { shapeId = nextId; settings = { ...settings, maskId: null }; report(""); }
    }
    if (settings.maskId && !context?.shape.scalarMasks?.some(mask => mask.id === settings.maskId)) {
      settings = { ...settings, maskId: null }; stopPainting();
    }
    const supported = !!context && context.identity.count <= ATTRIBUTE_PAINT_LIMITS.source;
    summary.textContent = !context ? "Select one loaded splat object."
      : !supported ? "Paint supports up to 1,000,000 original splats per object."
      : (context.shape.attributePaint?.records.length ?? 0).toLocaleString() + " painted originals · " + context.selected.length.toLocaleString() + " selected";
    fields.disabled = !available || !supported || busy;
    toggle.disabled = !available || !supported || busy;
    toggle.textContent = painting ? "Stop Painting" : "Start Painting";
    choose.disabled = !available || !supported || busy;
    clear.disabled = !available || !context?.shape.attributePaint || busy;
    for (const update of controls) update();
  }
  new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) { stopPainting(); refresh(); } }).observe(root);
  return { element: root, refresh, report, stopPainting, resize(radius: number) { apply({ radius }); } };
}
