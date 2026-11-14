import type { SplatSelectionDepth, SplatSelectionOperation } from "./splat-component-selection.ts";

import { SPLAT_EDIT_LABELS, type SplatEditAction } from "./splat-component-edits.ts";
import { SPLAT_EXTRACTION_LABEL } from "./splat-extraction.ts";

import { propertyInteraction } from "./property-interaction.ts";

import { MAX_SPLAT_BRUSH_RADIUS, type SplatBrushSettings, type SplatSelectionTool } from "./splat-selection-gestures.ts";



export function createSplatComponentPanel(actions: { enter: () => void; exit: () => void; select: (action: "all" | "none" | "invert") => void; depth: (value: SplatSelectionDepth) => void; cancel: () => void;

  tool: (tool: SplatSelectionTool) => void; brush: (change: Partial<SplatBrushSettings>) => void; edit: (action: SplatEditAction) => void; duplicate: () => void;

  transform: (mode: "translate" | "rotate" | "scale", axis: number, value: number) => void;

  previewTransform: (mode: "translate" | "rotate" | "scale", axis: number) => { update(value: number): void; end(): void } | undefined }) {

  const element = document.createElement("section"); element.className = "panel-content splat-component-panel";



  element.setAttribute("aria-label", "Splat Components");

  element.innerHTML = `<strong>Splat Components</strong><div role="status" aria-live="polite" data-status></div><div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" data-enter>Component mode · F8</button><button type="button" data-exit>Object mode</button></div><label>Selection depth <select aria-label="Splat selection depth"><option value="through">Through</option><option value="front-centers">Front centers (approximate)</option></select></label><div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" data-select="all">All</button><button type="button" data-select="none">None</button><button type="button" data-select="invert">Invert</button><button type="button" data-cancel>Cancel scan</button></div><p>Click or drag a box. Shift toggles · Ctrl subtracts · Ctrl+Shift adds. Esc cancels a gesture or scan; F8 returns to Object mode.</p><details><summary>Selection behavior and limits</summary><p>Centers above the opacity threshold are selectable. Front centers keeps the nearest center in each 4 px cell of this object; it does not test Gaussian alpha, other objects or elastic fill. Highlights show selected centers through surfaces. Maximum 1,000,000 selected IDs. At most 20,000 evenly sampled center markers; the selected count and operations always include every selected ID. Excess selections leave the previous selection unchanged.</p></details>`;

  const style = document.createElement("style");

  const edits = document.createElement("fieldset"); edits.className = "splat-edit-actions";

  edits.innerHTML = `<legend>Component Edits</legend><div data-edit-status role="status" aria-live="polite"></div><div class="splat-edit-buttons">

    <button type="button" data-edit="hide" title="Hide selected splats (H)">${SPLAT_EDIT_LABELS.hide}</button>

    <button type="button" data-edit="show" title="Show all hidden splats in this object (Shift+H)">${SPLAT_EDIT_LABELS.show}</button>

    <button type="button" data-edit="delete" title="Delete selected splats (Delete)">${SPLAT_EDIT_LABELS.delete}</button>

    <button type="button" data-edit="restore" title="Restore all deleted splats in this object">${SPLAT_EDIT_LABELS.restore}</button>
    <button type="button" data-duplicate title="Create an independent object from the selected original splats">${SPLAT_EXTRACTION_LABEL}</button>

  </div>`;

  element.insertBefore(edits, element.querySelector("details"));

  style.textContent = `.splat-component-panel{height:100%;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;font-size:12px;color:var(--text);background:var(--panel)}

  .splat-component-panel p{color:var(--muted);line-height:1.5;margin:0}.splat-component-panel button,.splat-component-panel select{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0}

  .splat-component-panel label{display:grid;gap:5px}.splat-component-panel select{width:100%}.splat-component-panel button{cursor:pointer}.splat-component-panel button:hover:not(:disabled){background:var(--hover)}

  .splat-component-panel :disabled{opacity:.45;cursor:default}.splat-component-panel :focus-visible{outline:1px solid var(--strong)}.splat-component-panel summary{cursor:pointer;color:var(--muted)}.splat-component-panel details p{margin-top:8px}

  .splat-edit-actions{border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0;margin:0}.splat-edit-actions legend{color:var(--muted)}

  .splat-edit-buttons{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}

  .splat-brush-settings{min-width:0;margin:0;padding:8px;border:1px solid var(--line);border-radius:3px}

  .splat-brush-settings:not([hidden]){display:grid;gap:8px}.splat-brush-settings label{grid-template-columns:minmax(0,1fr) 5em;align-items:center}

  .splat-brush-settings label:first-of-type{grid-template-columns:minmax(0,1fr) minmax(6em,1fr)}

  .splat-brush-settings input[type=number]{width:100%;min-width:0;text-align:right;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px}`;

  element.prepend(style);

  element.querySelector("[data-enter]")!.addEventListener("click", actions.enter);

  element.querySelector("[data-exit]")!.addEventListener("click", actions.exit);

  element.querySelector("[data-cancel]")!.addEventListener("click", actions.cancel);

  for (const button of Array.from(element.querySelectorAll<HTMLButtonElement>("[data-select]"))) button.addEventListener("click", () => actions.select(button.dataset.select as "all" | "none" | "invert"));

  const editButtons = Array.from(edits.querySelectorAll<HTMLButtonElement>("[data-edit]"));

  for (const button of editButtons) button.addEventListener("click", () => actions.edit(button.dataset.edit as SplatEditAction));
  const duplicate = edits.querySelector<HTMLButtonElement>("[data-duplicate]")!;
  duplicate.addEventListener("click", actions.duplicate);

  const depth = element.querySelector<HTMLSelectElement>('[aria-label="Splat selection depth"]')!;

  depth.addEventListener("change", () => actions.depth(depth.value as SplatSelectionDepth));

  const gestureSettings = document.createElement("div");

  gestureSettings.style.display = "grid";

  gestureSettings.style.gap = "8px";

  gestureSettings.innerHTML = `<label>Selection tool <select aria-label="Splat selection tool"><option value="box">Click / Box (Q)</option><option value="lasso">Lasso</option><option value="paint">Paint Selection</option><option value="sphere">Sphere (3D world)</option><option value="radial">Radial (2D screen)</option></select></label>

    <fieldset class="splat-brush-settings" hidden><legend>Brush settings</legend>

      <label>Operation <select aria-label="Splat brush operation"><option value="add">Add</option><option value="replace">Replace</option><option value="subtract">Subtract</option><option value="toggle">Toggle</option></select></label>

      <label>Radius (px) <input aria-label="Splat brush radius in pixels" type="number" min="1" max="${MAX_SPLAT_BRUSH_RADIUS}" step="1"></label>

      <label>Spacing (px) <input aria-label="Splat brush spacing in pixels" type="number" min="1" step="1"></label>

      <p>Hold B and drag horizontally in the viewport to resize the brush.</p>

    </fieldset>`;

  depth.closest("label")!.before(gestureSettings);

  const tool = gestureSettings.querySelector<HTMLSelectElement>('[aria-label="Splat selection tool"]')!;

  const operation = gestureSettings.querySelector<HTMLSelectElement>('[aria-label="Splat brush operation"]')!;

  const settings = gestureSettings.querySelector("fieldset")!;

  const radius = settings.querySelector<HTMLInputElement>('[aria-label="Splat brush radius in pixels"]')!;

  const spacing = settings.querySelector<HTMLInputElement>('[aria-label="Splat brush spacing in pixels"]')!;

  const guide = element.querySelector(":scope > p")!;

  const guides: Record<SplatSelectionTool, string> = {

    sphere: "Click a visible center to place a world sphere; drag sets its world radius. Numeric center and radius are below.",
    radial: "Click or drag a 2D circle in CSS pixels. Selection follows the current projected centers, through depth.",
    box: "Click a center or drag a box.",

    lasso: "Draw a closed freehand region. The outline connects the last point to the first.",

    paint: "Paint over splat centers. The current brush operation applies once per stroke.",

  };

  const modifierGuide = "Shift toggles · Ctrl/Command subtracts · Ctrl/Command+Shift adds. Esc cancels · F8 exits.";

  tool.addEventListener("change", () => actions.tool(tool.value as SplatSelectionTool));

  operation.addEventListener("change", () => actions.brush({ operation: operation.value as SplatSelectionOperation }));

  let lastBrush: SplatBrushSettings;

  for (const [key, input] of [["radius", radius], ["spacing", spacing]] as const) {

    input.addEventListener("pointerdown", event => { if (event.button === 1 && !input.disabled && !input.readOnly) input.focus(); });

    propertyInteraction(input, () => `splat-selection-${key}`);

    input.addEventListener("change", () => {

      if (input.value && input.checkValidity() && !input.readOnly) actions.brush({ [key]: input.valueAsNumber });

      input.value = String(lastBrush[key]);

    });

    input.addEventListener("keydown", event => {

      if (event.key !== "Enter" && event.key !== "Escape") return;

      event.preventDefault(); event.stopPropagation();

      if (event.key === "Escape") input.value = String(lastBrush[key]);

      input.blur();

    });

  }

  const transforms = document.createElement("fieldset");

  transforms.className = "splat-edit-actions splat-transform-fields";

  transforms.innerHTML = `<legend>Transform Selected Splats</legend><p>W Move | E Rotate | R Scale | Q Select. Shared center pivot; World/Object axes in the viewport toolbar. Values are relative to the current selection.</p>`;

  const transformInputs: HTMLInputElement[] = [];

  let activeName = "";

  for (const [mode, title] of [["translate", "Move"], ["rotate", "Rotate"], ["scale", "Scale"]] as const) {

    const row = document.createElement("div");

    row.style.cssText = "display:grid;grid-template-columns:4em repeat(3,minmax(0,1fr));gap:4px;align-items:center;margin-top:6px";

    const heading = document.createElement("span"); heading.textContent = title; row.append(heading);

    for (let axis = 0; axis < 3; axis++) {

      const label = document.createElement("label"), input = document.createElement("input"), caption = document.createElement("span");

      caption.textContent = "XYZ"[axis]; input.type = "number"; input.step = mode === "rotate" ? "1" : ".1";

      const neutral = mode === "scale" ? 1 : 0;

      input.value = String(neutral); input.setAttribute("aria-label", `Splat ${title} ${"XYZ"[axis]}`);

      input.style.cssText = "width:100%;min-width:0;text-align:right;font:inherit;padding:5px 3px;border:1px solid var(--line);border-radius:3px;color:var(--text);background:var(--bg)";

      label.style.gap = "2px"; label.append(caption, input); row.append(label); transformInputs.push(input);

      let preview: ReturnType<typeof actions.previewTransform>, cancelling = false;

      const end = () => { preview?.end(); preview = undefined; };

      propertyInteraction(input, () => `splat-transform:${activeName}:${mode}:${axis}`, caption, () => actions.previewTransform(mode, axis));

      input.addEventListener("input", () => {

        if (input.readOnly || !input.value || !input.checkValidity()) return;

        preview ??= actions.previewTransform(mode, axis); preview?.update(input.valueAsNumber);

      });

      input.addEventListener("change", () => {

        end();

        if (!cancelling && !input.readOnly && input.value && input.checkValidity() && input.valueAsNumber !== neutral) actions.transform(mode, axis, input.valueAsNumber);

        input.value = String(neutral);

      });

      input.addEventListener("keydown", event => {

        if (event.key !== "Escape" && event.key !== "Enter") return;

        event.preventDefault(); event.stopPropagation();

        if (event.key === "Escape") { cancelling = true; end(); input.value = String(neutral); input.blur(); cancelling = false; }

        else { input.dispatchEvent(new Event("change")); input.blur(); }

      });

      input.addEventListener("blur", end);

    }

    transforms.append(row);

  }

  const limits = document.createElement("p");

  limits.textContent = "Live preview | Esc cancels | one undo per release. Hard or soft weights share one pivot; sphere/radial weights affect every transform. Up to 100,000 selected splats per gesture and 250,000 transformed splats per scene. Component undo history is bounded to 64 MiB; oldest steps expire for large edits; immediate undo is retained or the edit rejects.";

  limits.style.marginTop = "8px"; transforms.append(limits); edits.before(transforms);

  let lastStatus = "", lastEditStatus = "";

  return { element, radiusLocked: () => radius.readOnly, update(name: string | undefined, count: number, total: number, activity: string | undefined, available: boolean,

    activeTool: SplatSelectionTool, brush: SplatBrushSettings, removed: { hidden: number; deleted: number },
    canDuplicate: boolean, duplicating: boolean) {

    const busy = activity !== undefined;

    activeName = name ?? "";

    for (const input of transformInputs) input.disabled = !name || !count || count > 100000 || busy || !available;

    const status = name ? `${name} · ${count.toLocaleString()} / ${total.toLocaleString()} original splats selected${count > 20_000 ? " · 20,000 sampled highlights" : ""}${activity ? ` · ${activity}` : ""}` : "Object mode. Select one splat object, then enter Component mode.";

    if (status !== lastStatus) { element.querySelector("[data-status]")!.textContent = status; lastStatus = status; }

    const editStatus = name ? `${total.toLocaleString()} active · ${removed.hidden.toLocaleString()} hidden · ${removed.deleted.toLocaleString()} deleted` : "Enter component mode to edit splats.";

    if (editStatus !== lastEditStatus) { edits.querySelector("[data-edit-status]")!.textContent = editStatus; lastEditStatus = editStatus; }

    for (const button of editButtons) button.disabled = !name || busy || !available ||

      !(button.dataset.edit === "show" ? removed.hidden : button.dataset.edit === "restore" ? removed.deleted : count);
    duplicate.disabled = !canDuplicate;

    element.querySelector<HTMLButtonElement>("[data-enter]")!.disabled = !!name || !available;

    element.querySelector<HTMLButtonElement>("[data-exit]")!.disabled = !name;

    const cancel = element.querySelector<HTMLButtonElement>("[data-cancel]")!;

    cancel.disabled = !busy;

    const cancelLabel = duplicating ? "Cancel duplication" : busy && activity !== "Scanning…" ? "Cancel gesture" : "Cancel scan";

    if (cancel.textContent !== cancelLabel) cancel.textContent = cancelLabel;

    for (const button of Array.from(element.querySelectorAll<HTMLButtonElement>("[data-select]"))) button.disabled = !name || busy || !available;

    lastBrush = brush;

    tool.disabled = !name || !available;

    tool.value = activeTool;
    depth.disabled = !name || !available || activeTool === "sphere";
    depth.title = activeTool === "sphere" ? "3D sphere uses the complete world volume, independent of screen depth filtering." : "Screen selection depth policy";

    settings.hidden = activeTool !== "paint";

    for (const input of [operation, radius, spacing]) input.disabled = !name || !available || busy;

    operation.value = brush.operation;

    spacing.max = String(brush.radius);

    if (document.activeElement !== radius) radius.value = String(brush.radius);

    if (document.activeElement !== spacing) spacing.value = String(brush.spacing);

    const help = `${guides[activeTool]} ${modifierGuide}`;

    if (guide.textContent !== help) guide.textContent = help;

  } };

}

