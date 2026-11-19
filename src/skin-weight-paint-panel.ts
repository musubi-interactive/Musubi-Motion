import type { SkinInfluence, SplatShapeNode } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export type SkinWeightBrushSettings = {
  shapeId: string;
  jointId: string;
  radius: number;
  strength: number;
  value: number;
  mode: "replace" | "add" | "subtract" | "smooth";
  distance?: number;
  depth?: "through" | "front" | "scene-visible";
};
type Options = {
  available: () => boolean;
  getSelection: () => string[];
  getComponents: (shapeId: string) => { count: number; getWeights: (index: number) => SkinInfluence[] } | undefined;
  onBrushMode: (settings: SkinWeightBrushSettings | undefined) => void;
};

/** Brush configuration only. The viewport owns strokes, previews, and atomic weight commands. */
export function createSkinWeightPaintPanel(store: SceneStore, options: Options) {
  const element = document.createElement("section");
  element.className = "skin-weight-paint-panel";
  element.setAttribute("aria-label", "Paint Skin Weights");
  const style = document.createElement("style");
  style.textContent = `.skin-weight-paint-panel{height:100%;overflow:auto;padding:12px;font-size:12px;background:var(--panel);color:var(--text)}
    .skin-weight-paint-panel p{line-height:1.5;color:var(--muted)}.skin-weight-paint-panel label{display:grid;gap:5px;margin:10px 0}
    .skin-weight-paint-panel input,.skin-weight-paint-panel select{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0;box-sizing:border-box}
    .skin-weight-paint-panel select,.skin-weight-paint-panel input:not([type=checkbox]){width:100%}.skin-weight-paint-panel :disabled{opacity:.45}
    .skin-weight-paint-panel :focus-visible{outline:1px solid var(--strong)}.skin-weight-paint-panel fieldset{border:1px solid var(--line);padding:10px;min-width:0;margin:12px 0}.skin-weight-paint-panel legend{padding:0 5px}
    .skin-weight-paint-panel .paint-check{display:flex;align-items:center;gap:7px}.skin-weight-paint-panel .paint-status{min-height:20px;overflow-wrap:anywhere}.skin-weight-paint-panel .paint-status[data-error=true]{color:#ce756a}`;
  function label(text: string, control: HTMLElement) {
    const node = document.createElement("label"); node.append(document.createTextNode(text), control); return node;
  }
  function select(name: string) {
    const node = document.createElement("select"); node.setAttribute("aria-label", name); return node;
  }
  function number(name: string, min: number, max: number, step: number) {
    const node = document.createElement("input"); node.type = "number"; node.min = String(min); node.max = String(max); node.step = String(step);
    node.setAttribute("aria-label", name); return node;
  }
  const intro = document.createElement("p"); intro.textContent = "Paint normalized joint weights on original splat component centers. Generated elastic fill is excluded.";
  const objects = select("Paint bound splat object");
  const empty = document.createElement("p"); empty.textContent = "Bind a splat object to joints, then choose it here or select it in the Outliner.";
  const brush = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = "Brush settings"; brush.append(legend);
  const summary = document.createElement("p");
  const influence = select("Paint joint influence");
  const mode = select("Paint weight mode");
  for (const [title, value] of [["Replace", "replace"], ["Add", "add"], ["Subtract", "subtract"], ["Smooth", "smooth"]]) mode.add(new Option(title, value));
  const depth = select("Skin brush occlusion");
  for (const [title,id] of [["Scene visible","scene-visible"],["Front centers","front"],["Through","through"]]) depth.add(new Option(title,id));
  const distance = number("Smoothing distance in object units", .000001, 1000000, .01);
  distance.value = "0.1";
  const distanceLabel = label("Neighborhood distance · object units", distance);
  const value = number("Paint weight value", 0, 1, 0.01);
  const strength = number("Paint brush strength", 0, 1, 0.01);
  const radius = number("Paint brush radius in CSS pixels", 1, 256, 1);
  const modeHelp = document.createElement("p");
  const painting = document.createElement("input"); painting.type = "checkbox";
  const paintLabel = label("Paint weights in viewport", painting); paintLabel.className = "paint-check";
  brush.append(summary, label("Joint influence", influence), label("Mode", mode), label("Occlusion", depth), distanceLabel, label("Value · 0 to 1", value), modeHelp,
    label("Strength · 0 to 1", strength), label("Radius · CSS pixels", radius), paintLabel);
  const guide = document.createElement("p"); guide.textContent = "Drag to paint component centers using the selected occlusion policy, with smooth falloff toward the brush edge. Each component receives its maximum brush strength per stroke; repeated passes in one stroke do not accumulate. Hold Alt to orbit. Escape cancels the stroke or exits painting.";
  const limits = document.createElement("p"); limits.textContent = "Release to apply deformation with one undo step. During a stroke, colored points preview influence weights: blue = 0, orange = 1. Deformation updates only on release. A stroke can affect at most 20,000 original components, with at most four active influences per component. Invalid edits are rejected as a whole.";
  const status = document.createElement("p"); status.className = "paint-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  element.append(style, intro, label("Bound splat object", objects), empty, brush, status, guide, limits);

  let shapeId = "", selectionSignature = "", objectSignature = "", influenceSignature = "", activeSignature = "";
  let brushValue = 1, brushStrength = 0.5, brushRadius = 32;

  function stopPainting() {
    painting.checked = false;
    if (activeSignature) { activeSignature = ""; options.onBrushMode(undefined); }
  }
  function resetScene() {
    stopPainting(); shapeId = ""; selectionSignature = JSON.stringify(options.getSelection());
    brushValue = 1; brushStrength = 0.5; brushRadius = 32; mode.value = "replace";
    influenceSignature = ""; status.textContent = ""; status.dataset.error = "false"; refresh();
  }
  function run(action: () => void) {
    if (!options.available()) { refresh(); return; }
    try { action(); status.textContent = ""; status.dataset.error = "false"; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); status.dataset.error = "true"; }
    refresh();
  }
  function numberCommit(input: HTMLInputElement, update: (value: number) => void) {
    let cancelled = false;
    input.addEventListener("blur", () => {
      if (!cancelled) run(() => {
        const number = input.valueAsNumber;
        if (!input.value.trim() || !Number.isFinite(number) || number < Number(input.min) || number > Number(input.max))
          throw Error(`${input.getAttribute("aria-label")} must be a finite number from ${input.min} to ${input.max}.`);
        update(number);
      });
      cancelled = false; refresh();
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); input.blur(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelled = true; input.blur(); }
    });
  }
  numberCommit(value, number => { brushValue = number; });
  numberCommit(strength, number => { brushStrength = number; });
  numberCommit(radius, number => { brushRadius = number; });
  objects.onchange = () => run(() => { stopPainting(); shapeId = objects.value; });
  depth.onchange = distance.onchange = influence.onchange = mode.onchange = () => run(() => {});
  painting.onchange = () => { if (!painting.checked) stopPainting(); refresh(); };

  function refresh() {
    const doc = store.getState().document, selection = options.getSelection(), available = options.available();
    const shapes = Object.values(doc.nodes).filter((node): node is SplatShapeNode => node.type === "splatShape" && !!node.binding);
    const selectionKey = JSON.stringify(selection);
    if (selectionKey !== selectionSignature) {
      selectionSignature = selectionKey; stopPainting();
      shapeId = selection.length === 1 ? shapes.find(shape => shape.id === selection[0] || shape.parentId === selection[0])?.id ?? "" : "";
      status.textContent = "";
    }
    const nextObjects = JSON.stringify(shapes.map(shape => [shape.id, doc.nodes[shape.parentId]?.name ?? shape.name]));
    if (nextObjects !== objectSignature) {
      objectSignature = nextObjects;
      objects.replaceChildren(new Option("Choose a bound splat object", ""), ...shapes.map(shape => new Option(doc.nodes[shape.parentId]?.name ?? shape.name, shape.id)));
    }
    const shape = shapes.find(shape => shape.id === shapeId);
    if (!shape) { shapeId = ""; stopPainting(); }
    objects.value = shapeId; objects.disabled = !available || !shapes.length; empty.hidden = !!shape; brush.hidden = !shape;
    // Busy may mean an active stroke. Only the owner can end that brush lifecycle.
    for (const control of [influence, mode, value, strength, radius, painting]) control.disabled = !available || !shape;
    if (document.activeElement !== value) value.value = String(brushValue);
    if (document.activeElement !== strength) strength.value = String(brushStrength);
    if (document.activeElement !== radius) radius.value = String(brushRadius);
    distanceLabel.hidden = mode.value !== "smooth";
    modeHelp.textContent = mode.value === "smooth" ? "Blend toward up to eight neighboring bind-space originals. Locked influences retain their weights." : mode.value === "replace" ? "Replace moves the selected influence toward Value, scaled by Strength and falloff."
      : `${mode.value === "add" ? "Add increases" : "Subtract decreases"} the selected influence by Value × Strength × falloff. Other influences keep their proportions.`;
    if (!shape) return;
    const jointIds = shape.binding!.jointIds.filter(id => doc.joints?.some(joint => joint.id === id));
    const nextInfluences = JSON.stringify([shape.id, jointIds.map(id => [id, doc.joints?.find(joint => joint.id === id)?.name ?? id])]);
    if (nextInfluences !== influenceSignature) {
      influenceSignature = nextInfluences; const before = influence.value;
      influence.replaceChildren(...jointIds.map(id => new Option(doc.joints?.find(joint => joint.id === id)?.name ?? id, id)));
      if (jointIds.includes(before)) influence.value = before;
      else if (activeSignature) stopPainting();
    }
    const context = options.getComponents(shape.id), count = context?.count ?? 0;
    const ready = !!context && Number.isSafeInteger(count) && count > 0 && !!influence.value;
    summary.textContent = ready ? `${count.toLocaleString()} original components · generated elastic fill excluded`
      : "Waiting for the binding's original component data. Empty assets have no paintable components.";
    for (const control of [influence, mode, value, strength, radius, painting]) control.disabled = !available || !ready;
    if (!influence.value || (available && !ready)) { stopPainting(); return; }
    if (!painting.checked || !available || !ready) return;
    const settings: SkinWeightBrushSettings = { shapeId: shape.id, jointId: influence.value, radius: brushRadius, strength: brushStrength, value: brushValue, distance: distance.valueAsNumber, depth: depth.value as SkinWeightBrushSettings["depth"], mode: mode.value as SkinWeightBrushSettings["mode"] };
    const signature = JSON.stringify(settings);
    if (signature !== activeSignature) { activeSignature = signature; options.onBrushMode(settings); }
  }

  store.subscribe(() => refresh());
  refresh();
  return { element, refresh, stopPainting, resetScene };
}
