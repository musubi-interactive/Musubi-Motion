import type { SceneStore } from "./scene-store.ts";
import type { SplatSelectionIdentity } from "./splat-component-selection.ts";
import type { SplatShapeNode } from "./scene-document.ts";
import { createSplatSet, createSplatMask, editSplatSet, editSplatCollection, updateSplatMask, transformMask, maskSelection, rangeIndices, setSplatMaskComponentLocks, rangesCount, type SplatMaskCombine } from "./splat-masks.ts";
import type { SplatMaskBrush } from "./splat-mask-brush.ts";
import { propertyInteraction } from "./property-interaction.ts";
type Context = { identity: SplatSelectionIdentity; shape: SplatShapeNode; selected: Uint32Array };
type Options = { available(): boolean; getContext(): Context | undefined; chooseComponents(): void; selectIndices(indices: Uint32Array): void; onPaint(settings?: SplatMaskBrush): void; busy(): boolean };
export function createSplatMaskPanel(store: SceneStore, options: Options) {
  const element = document.createElement("section"); element.className = "splat-mask-panel"; element.setAttribute("aria-label", "Splat Sets and Masks");
  const style = document.createElement("style"); style.textContent = `.splat-mask-panel{height:100%;overflow:auto;padding:10px;background:var(--panel);color:var(--text);font-size:12px}.splat-mask-panel fieldset{border:1px solid var(--line);margin:0 0 12px;padding:8px;min-width:0}.splat-mask-panel legend{padding:0 4px}.splat-mask-panel label{display:grid;gap:4px;margin:7px 0}.splat-mask-panel input,.splat-mask-panel select,.splat-mask-panel button{font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:3px;padding:5px;min-width:0}.splat-mask-panel input:not([type=checkbox]),.splat-mask-panel select{width:100%;box-sizing:border-box}.splat-mask-panel input[type=number]{text-align:right}.splat-mask-panel input[data-locked]{opacity:.5}.splat-mask-panel button{cursor:pointer}.splat-mask-panel :disabled{opacity:.45;cursor:default}.splat-mask-panel :focus-visible{outline:1px solid var(--strong)}.splat-mask-panel p{color:var(--muted);line-height:1.5}.splat-mask-actions{display:flex;gap:5px;flex-wrap:wrap}.splat-mask-panel .mask-check{display:flex;gap:6px;align-items:center}.splat-mask-panel [role=status]{overflow-wrap:anywhere;min-height:18px}.splat-mask-panel [data-error=true]{color:#ce756a}`; element.append(style);
  const p = (text: string) => { const node = document.createElement("p"); node.textContent = text; return node; };
  const label = (title: string, control: HTMLElement) => { const row = document.createElement("label"); row.append(title, control); return row; };
  const fieldset = (title: string) => { const field = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = title; field.append(legend); return field; };
  const select = (title: string, choices: [string, string][] = []) => { const input = document.createElement("select"); input.setAttribute("aria-label", title); for (const [value, name] of choices) input.add(new Option(name, value)); return input; };
  const text = (title: string) => { const input = document.createElement("input"); input.setAttribute("aria-label", title); input.maxLength = 80; return input; };
  const check = (title: string, checked = false) => { const input = document.createElement("input"); input.type = "checkbox"; input.checked = checked; input.setAttribute("aria-label", title); const row = label(title, input); row.className = "mask-check"; return { input, row }; };
  const status = p(""); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const summary = p("Select one loaded splat object. Use existing box, lasso or Paint Selection before saving membership.");
  let setId = "", maskId = "", shapeId = "", painting = false, listSignature = "";
  let settings: Omit<SplatMaskBrush, "shapeId" | "maskId"> = { mode: "replace", falloff: "smooth", radius: 40, strength: 1, value: 1, selectedOnly: false };
  function context() { const ctx = options.getContext(); if (!ctx) throw Error("Select one loaded splat object."); return ctx; }
  function currentMask() { const ctx = context(), mask = ctx.shape.scalarMasks?.find(mask => mask.id === maskId); if (!mask) throw Error("Choose a scalar mask."); return { ...ctx, mask }; }
  function report(message: string, error = false) { status.textContent = message; status.dataset.error = String(error); }
  function run(action: () => void) { if (!options.available() || options.busy()) { report("Finish the current operation before editing saved sets/masks.", true); return; } try { action(); report("Saved set/mask updated. Undo restores the previous authored state."); } catch (error) { report(error instanceof Error ? error.message : String(error), true); } refresh(); }
  const button = (title: string, action: () => void) => { const b = document.createElement("button"); b.type = "button"; b.textContent = title; b.onclick = () => run(action); return b; };
  const choose = button("Choose components…", options.chooseComponents); element.append(summary, choose);
  const sets = fieldset("Quick Select Sets"), setList = select("Saved splat selection set"), setName = text("Selection set name"); setName.value = "selectionSet";
  const setActions = document.createElement("div"); setActions.className = "splat-mask-actions";
  setActions.append(button("Create set from selection", () => { const ctx = context(); setId = createSplatSet(store, ctx.identity, setName.value, ctx.selected); }),
    button("Select set members", () => { const ctx = context(), set = ctx.shape.selectionSets?.find(set => set.id === setId); if (!set) throw Error("Choose a saved selection set."); options.selectIndices(rangeIndices(set.members)); }),
    button("Replace set membership", () => { const ctx = context(); editSplatSet(store, ctx.identity, setId, "replace", ctx.selected); }),
    button("Add selection to set", () => { const ctx = context(); editSplatSet(store, ctx.identity, setId, "add", ctx.selected); }),
    button("Remove selection from set", () => { const ctx = context(); editSplatSet(store, ctx.identity, setId, "subtract", ctx.selected); }),
    button("Rename set", () => editSplatCollection(store, context().identity, "set", setId, "rename", setName.value)),
    button("Delete set", () => editSplatCollection(store, context().identity, "set", setId, "delete")));
  sets.append(label("Saved sets", setList), label("Name", setName), setActions);
  setList.onchange = () => { setId = setList.value; const set = context().shape.selectionSets?.find(set => set.id === setId); if (set) setName.value = set.name; refresh(); };
  const masks = fieldset("Reusable Scalar Masks"), maskList = select("Scalar mask"), maskName = text("Scalar mask name"); maskName.value = "mask";
  const maskActions = document.createElement("div"); maskActions.className = "splat-mask-actions";
  maskActions.append(button("Create mask from selection", () => { const ctx = context(); maskId = createSplatMask(store, ctx.identity, maskName.value, ctx.selected); }),
    button("Create empty mask", () => { const ctx = context(); maskId = createSplatMask(store, ctx.identity, maskName.value, []); }),
    button("Rename mask", () => editSplatCollection(store, context().identity, "mask", maskId, "rename", maskName.value)),
    button("Delete mask", () => editSplatCollection(store, context().identity, "mask", maskId, "delete")));
  const layerLock = check("Lock mask layer"), show = check("Show mask overlay", true), info = p("");
  masks.append(label("Mask", maskList), label("Name", maskName), maskActions, layerLock.row, show.row, info);
  maskList.onchange = () => { stopPainting(); maskId = maskList.value; const mask = options.getContext()?.shape.scalarMasks?.find(mask => mask.id === maskId); if (mask) maskName.value = mask.name; refresh(); };
  layerLock.input.onchange = () => run(() => { stopPainting(); editSplatCollection(store, context().identity, "mask", maskId, "lock", layerLock.input.checked); });
  show.input.onchange = () => refresh();
  const brush = fieldset("Paint Attributes"), operation = select("Mask paint operation", [["replace", "Replace"], ["add", "Add"], ["erase", "Erase"], ["smooth", "Smooth"]]), falloff = select("Mask brush falloff", [["constant", "Constant"], ["linear", "Linear"], ["smooth", "Smooth"]]);
  const numbers: { input: HTMLInputElement; key: "radius" | "strength" | "value"; refresh(): void }[] = [];
  function updateSettings(change: Partial<typeof settings>) { settings = { ...settings, ...change }; if (painting) options.onPaint({ ...settings, shapeId: context().identity.shapeId, maskId }); refresh(); }
  function number(title: string, key: "radius" | "strength" | "value", min: number, max: number, step: number) {
    const input = document.createElement("input"); input.type = "number"; input.min = String(min); input.max = String(max); input.step = String(step); input.setAttribute("aria-label", title);
    const row = label(title, input); let cancel = false;
    input.onchange = () => { if (cancel) return; const value = input.valueAsNumber; if (!Number.isFinite(value) || value < min || value > max) { report(`${title} must be within ${min}–${max}.`, true); input.value = String(settings[key]); return; } updateSettings({ [key]: value }); };
    input.onblur = () => { cancel = false; input.value = String(settings[key]); };
    input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); input.blur(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel = true; input.value = String(settings[key]); input.blur(); } };
    row.addEventListener("pointerdown", e => { if (e.button === 1) input.focus(); }, true);
    const lock = propertyInteraction(input, () => `splat-mask-brush:${key}`, row, () => { const original = settings[key]; return { update(value) { updateSettings({ [key]: value }); }, end() { updateSettings({ [key]: original }); } }; });
    numbers.push({ input, key, refresh: lock }); brush.append(row); return input;
  }
  brush.append(label("Operation", operation), label("Falloff", falloff)); number("Mask brush radius (px)", "radius", 1, 512, 1); number("Mask brush strength", "strength", 0, 1, .01); number("Mask brush value", "value", 0, 1, .01);
  const selectedOnly = check("Paint selected components only"); brush.append(selectedOnly.row);
  const paint = button("Start painting mask", () => { const ctx = currentMask(); if (ctx.mask.locked) throw Error("Unlock this mask layer first."); const next = !painting; options.onPaint(next ? { ...settings, shapeId: ctx.identity.shapeId, maskId } : undefined); painting = next; refresh(); });
  const flood = button("Flood all original IDs", () => { const ctx = currentMask(); updateSplatMask(store, ctx.identity, maskId, "Flood splat scalar mask", mask => transformMask(mask, "flood", settings.mode === "erase" ? 0 : settings.value)); });
  brush.append(paint, flood, p("Paint posed eligible centers through surfaces with a continuous brush. B + drag resizes. Escape, pointer cancel or view/scene changes restore the original mask; release commits one stroke. Up to 100,000 edited IDs per stroke; 20,000 overlay markers are a display sample. Smooth averages immutable mask values in the surrounding 3×3 screen cells (32 px each), not mesh topology."));
  operation.onchange = () => updateSettings({ mode: operation.value as SplatMaskBrush["mode"] }); falloff.onchange = () => updateSettings({ falloff: falloff.value as SplatMaskBrush["falloff"] }); selectedOnly.input.onchange = () => updateSettings({ selectedOnly: selectedOnly.input.checked });
  const utilities = fieldset("Mask Operations"), threshold = document.createElement("input"); threshold.type = "number"; threshold.min = "0"; threshold.max = "1"; threshold.step = ".01"; threshold.value = ".5"; threshold.setAttribute("aria-label", "Mask selection threshold");
  const source = select("Combine source mask"), combine = select("Mask combine operation", [["multiply", "Multiply"], ["add", "Add / clamp"], ["subtract", "Subtract / clamp"], ["min", "Minimum"], ["max", "Maximum"]]);
  utilities.append(button("Invert mask", () => { const ctx = currentMask(); updateSplatMask(store, ctx.identity, maskId, "Invert splat scalar mask", mask => transformMask(mask, "invert")); }),
    label("Combine with", source), label("Combine operation", combine), button("Combine into current mask", () => { const ctx = currentMask(), other = ctx.shape.scalarMasks?.find(mask => mask.id === source.value); updateSplatMask(store, ctx.identity, maskId, "Combine splat scalar masks", mask => transformMask(mask, combine.value as SplatMaskCombine, 1, other)); }),
    button("Lock selected mask components", () => { const ctx = currentMask(); setSplatMaskComponentLocks(store, ctx.identity, maskId, ctx.selected, true); }),
    button("Unlock all mask components", () => { const ctx = currentMask(); setSplatMaskComponentLocks(store, ctx.identity, maskId, rangeIndices(ctx.mask.componentLocks), false); }),
    label("Select values ≥ threshold", threshold), button("Select mask region", () => options.selectIndices(maskSelection(currentMask().mask, threshold.valueAsNumber))),
    p("Flood, invert and combine act on all original IDs, including hidden/deleted IDs, while preserving locked components. Hiding/deleting splats alone never changes saved mask values or set membership. Restoring the same source IDs restores their correspondence."));
  element.append(sets, masks, brush, utilities, status, p("Overlay: dark = 0, white = 1. At most 20,000 posed center markers; original splat colors, skin weights and source files are unchanged. Mask values are reusable local scalars, separate from transient Soft Selection weights."));
  function stopPainting() { if (painting) { painting = false; paint.textContent = "Start painting mask"; options.onPaint(undefined); } }
  function refresh() {
    const ctx = options.getContext(), available = !!ctx && options.available() && !options.busy();
    if (shapeId !== ctx?.identity.shapeId) { stopPainting(); shapeId = ctx?.identity.shapeId ?? ""; setId = maskId = ""; listSignature = ""; }
    const savedSets = ctx?.shape.selectionSets ?? [], savedMasks = ctx?.shape.scalarMasks ?? [], signature = JSON.stringify([savedSets.map(s => [s.id, s.name, rangesCount(s.members)]), savedMasks.map(m => [m.id, m.name])]);
    if (signature !== listSignature) { listSignature = signature; setList.replaceChildren(new Option("Choose a saved set", ""), ...savedSets.map(s => new Option(`${s.name} · ${rangesCount(s.members).toLocaleString()}`, s.id))); maskList.replaceChildren(new Option("Choose a mask", ""), ...savedMasks.map(m => new Option(m.name, m.id))); source.replaceChildren(new Option("Choose another mask", ""), ...savedMasks.map(m => new Option(m.name, m.id))); }
    if (!savedSets.some(s => s.id === setId)) setId = savedSets[0]?.id ?? "";
    if (!savedMasks.some(m => m.id === maskId)) { stopPainting(); maskId = savedMasks[0]?.id ?? ""; }
    setList.value = setId; maskList.value = maskId; const mask = savedMasks.find(m => m.id === maskId);
    summary.textContent = ctx ? `${ctx.shape.name} · ${ctx.selected.length.toLocaleString()} selected original IDs · ${ctx.identity.count.toLocaleString()} source records` : "Select one loaded splat object to save sets or paint scalar masks.";
    for (const input of Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button"))) input.disabled = !available;
    for (const input of Array.from(brush.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button"))) input.disabled ||= !mask || mask.locked;
    layerLock.input.disabled = !available || !mask; layerLock.input.checked = mask?.locked ?? false;
    paint.textContent = painting ? "Stop painting mask" : "Start painting mask";
    operation.value = settings.mode; falloff.value = settings.falloff; selectedOnly.input.checked = settings.selectedOnly;
    for (const item of numbers) { if (document.activeElement !== item.input) item.input.value = String(settings[item.key]); item.refresh(); }
    info.textContent = mask ? `${mask.data.kind} · ${mask.data.values.length.toLocaleString()} stored values · ${rangesCount(mask.componentLocks).toLocaleString()} locked components${mask.locked ? " · layer locked" : ""}` : "Create a mask from selection (1 selected / 0 elsewhere), or start an empty zero mask.";
  }
  store.subscribe(refresh); refresh();
  return { element, refresh, stopPainting, report, resize(radius: number) { updateSettings({ radius }); }, getDisplay() { return shapeId && maskId ? { shapeId, maskId, show: show.input.checked && element.getClientRects().length > 0 } : undefined; } };
}
