import { propertyInteraction } from "./property-interaction.ts";
import { createSoftFalloffEditor, type SoftFalloffPreview } from "./soft-falloff-editor.ts";
import { defaultSoftFalloffCurve, type SplatSoftSettings } from "./splat-soft-selection.ts";
export type SplatSoftField = "worldRadius" | "screenRadius" | "core" | "x" | "y" | "z";
export function createSplatSoftPanel(actions: {
  change(patch: Partial<SplatSoftSettings>): void;
  preview(field: SplatSoftField): { update(value: number): void; end(): void } | undefined;
  previewCurve(): SoftFalloffPreview | undefined;
  apply(): void;
}) {
  const element = document.createElement("fieldset"); element.className = "splat-edit-actions splat-soft-settings";
  element.innerHTML = `<legend>Sphere / Radial Falloff</legend><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" aria-label="Soft Selection">Soft Selection (B)</label><label>Falloff curve <select aria-label="Splat falloff curve"><option value="linear">Linear</option><option value="smooth">Smooth</option><option value="sharp">Sharp</option><option value="custom">Custom</option></select></label>`;
  const enabled = element.querySelector<HTMLInputElement>("input")!, curve = element.querySelector<HTMLSelectElement>("select")!;
  const initialCurve = defaultSoftFalloffCurve();
  const editor = createSoftFalloffEditor({ change: points => actions.change({ curve: "custom", customCurve: points }), preview: actions.previewCurve });
  element.append(editor.element);
  enabled.onchange = () => actions.change({ enabled: enabled.checked });
  curve.onchange = () => {
    if (curve.value === "custom") {
      editor.element.open = true;
      actions.change({ curve: "custom", customCurve: settings.customCurve ?? initialCurve });
    } else actions.change({ curve: curve.value as SplatSoftSettings["curve"] });
  };
  let settings: SplatSoftSettings;
  const inputs = new Map<SplatSoftField, HTMLInputElement>();
  const read = (field: SplatSoftField) => field === "x" || field === "y" || field === "z" ? settings.center["xyz".indexOf(field)] : settings[field];
  const patch = (field: SplatSoftField, value: number): Partial<SplatSoftSettings> => {
    if (field !== "x" && field !== "y" && field !== "z") return { [field]: value };
    const center = [...settings.center] as [number, number, number]; center["xyz".indexOf(field)] = value; return { center };
  };
  for (const [field, label, min, max, step] of [
    ["worldRadius", "Sphere radius (world)", .000001, 1000000, .1], ["screenRadius", "Radial radius (px)", 1, 16384, 1],
    ["core", "Hard core fraction", 0, .95, .05], ["x", "Sphere center X", -1000000, 1000000, .1],
    ["y", "Sphere center Y", -1000000, 1000000, .1], ["z", "Sphere center Z", -1000000, 1000000, .1],
  ] as const) {
    const row = document.createElement("label"), caption = document.createElement("span"), input = document.createElement("input");
    row.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 6em;align-items:center;gap:5px";
    caption.textContent = label; input.type = "number"; input.min = String(min); input.max = String(max); input.step = field === "worldRadius" ? "any" : String(step); input.setAttribute("aria-label", label);
    input.style.cssText = "width:100%;min-width:0;text-align:right;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:5px";
    let preview: ReturnType<typeof actions.preview>, cancelling = false;
    const end = () => { preview?.end(); preview = undefined; };
    propertyInteraction(input, () => `splat-soft:${field}`, caption, () => actions.preview(field));
    input.oninput = () => { if (!input.readOnly && input.value && input.checkValidity()) { preview ??= actions.preview(field); preview?.update(input.valueAsNumber); } };
    input.onchange = () => { const value = input.valueAsNumber; end(); if (!cancelling && !input.readOnly && value !== read(field)) actions.change(patch(field, value)); input.value = String(read(field)); };
    input.onkeydown = event => {
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") { cancelling = true; end(); input.value = String(read(field)); input.blur(); cancelling = false; }
      else { input.dispatchEvent(new Event("change")); input.blur(); }
    };
    input.onblur = end; row.append(caption, input); element.append(row); inputs.set(field, input);
  }
  const apply = document.createElement("button"); apply.type = "button"; apply.textContent = "Apply Sphere / Radial Region"; apply.onclick = actions.apply;
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const guide = document.createElement("p"); guide.textContent = "Sphere uses 3D world distance; Radial uses 2D CSS-pixel distance. Blue → amber shows weight 0 → 1. Add uses max; subtract removes weight. Soft weights and regions are transient; only transformed Gaussians are saved. Fractional reflections cross a singular scale and reject; use positive scale or hard selection. B toggles the current/next Sphere or Radial falloff; regular selections stay hard. In Paint Selection, B still resizes its brush.";
  element.append(apply, status, guide);
  return { element, update(value: SplatSoftSettings, available: boolean, busy: boolean, tool: string, count: number) {
    settings = value; enabled.checked = value.enabled; curve.value = value.curve;
    enabled.disabled = curve.disabled = !available;
    const custom = value.curve === "custom", regionTool = tool === "sphere" || tool === "radial";
    editor.element.hidden = !custom;
    editor.update(value.customCurve ?? initialCurve, available && custom && regionTool);
    inputs.get("core")!.closest("label")!.style.display = custom ? "none" : "grid";
    for (const [field, input] of inputs) { input.disabled = !available; if (document.activeElement !== input) input.value = String(read(field)); }
    apply.disabled = !available || busy || !regionTool;
    status.textContent = `${tool === "sphere" ? `3D sphere · r ${value.worldRadius} world units` : tool === "radial" ? `2D circle · r ${value.screenRadius} CSS px` : "Choose Sphere or Radial above"} · ${value.enabled ? value.curve + " falloff" : "hard selection"} · ${count.toLocaleString()} affected IDs${busy ? " · scanning…" : ""}`;
  } };
}
