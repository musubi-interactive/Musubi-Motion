import { rebindLattice } from "./splat-lattice-rebind.ts";
import { latticePointGroup } from "./splat-point-selection.ts";
import type { SplatLattice } from "./splat-lattice.ts";
import { deformerTrackId } from "./splat-deformer-tracks.ts";
import { assertSplatDeformerUndoFits, trimSplatDeformerHistory } from "./splat-deformer-history.ts";
import type { Box3 } from "three";
import type { SceneDocument, SplatShapeNode } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import { propertyInteraction } from "./property-interaction.ts";
import {
  getSplatDeformerDefinition, keySplatDeformer, keySplatDeformerControls, sampleSplatDeformer, SPLAT_DEFORMER_DEFINITIONS,
  SPLAT_DEFORMER_LIMITS, splatDeformerControls, validateSceneSplatDeformers, withSplatDeformerControl,
  withSplatDeformerWeights, type SplatDeformer, type SplatDeformerControl,
} from "./splat-deformers.ts";
import "./splat-deformer-panel.css";

type Context = {
  shape: SplatShapeNode;
  count: number;
  componentMode: boolean;
  indices: Uint32Array;
  weights: Float32Array;
  restBounds(indices?: Uint32Array): Box3;
};
type PanelOptions = {
  context(): Context | undefined;
  available(): boolean;
  frame(): number;
  canKey(): boolean;
  autoKey(): boolean;
  preflight(shape: SplatShapeNode): void;
  onGraph?(trackId: string): void;
  onPreview(): void;
  onHandleChange(active: boolean): void;
  onContextChange?: () => void;
};

function commit(store: SceneStore, shapeId: string, edits: readonly SplatDeformer[], label: string, preflight: PanelOptions["preflight"]) {
  const before = store.getState().document, shape = before.nodes[shapeId];
  if (shape?.type !== "splatShape") return;
  const next = { ...shape, deformers: edits.length ? edits : undefined };
  const after = { ...before, nodes: { ...before.nodes, [shapeId]: next } };
  validateSceneSplatDeformers(after);
  assertSplatDeformerUndoFits(before, after);
  preflight(next);
  store.setState({ document: after, editLabel: label });
  trimSplatDeformerHistory(store);
}

export function createSplatDeformerPanel(store: SceneStore, options: PanelOptions) {
  const element = document.createElement("section");
  element.className = "panel-content splat-deformer-panel";
  element.setAttribute("aria-label", "Splat Deformers");
  element.innerHTML = `<div class="splat-deformer-create">
    <label>Deformer <select aria-label="Deformer type"></select></label>
    <button type="button" data-add>Add</button>
  </div>
  <p data-status role="status" aria-live="polite"></p>
  <div data-body></div>
  <div data-binding></div>`;
  const type = element.querySelector("select")!;
  for (const definition of SPLAT_DEFORMER_DEFINITIONS) type.add(new Option(definition.name, definition.kind));
  const add = element.querySelector<HTMLButtonElement>("[data-add]")!;
  const status = element.querySelector<HTMLElement>("[data-status]")!, body = element.querySelector<HTMLElement>("[data-body]")!;
  const bindingPanelHost = element.querySelector<HTMLElement>("[data-binding]")!;
  let shapeId = "", id = "", index = 0, editHandles = false;
  let indices = [0];
  let error = "";
  let preview: { document: SceneDocument; frame: number; shapeId: string; stack: readonly SplatDeformer[] } | undefined;
  let rendered: { shape: SplatShapeNode | undefined; frame: number; id: string; index: number; enabled: boolean; selected: number; handles: boolean } | undefined;

  function clearPreview(repaint = true) {
    if (!preview) return;
    preview = undefined;
    if (repaint) options.onPreview();
  }

  function run(action: () => void) {
    try { error = ""; action(); }
    catch (reason) { error = (reason as Error).message; rendered = undefined; clearPreview(); }
    refresh();
  }

  function change(shape: SplatShapeNode, entry: SplatDeformer, label: string) {
    clearPreview(false);
    try { commit(store, shape.id, (shape.deformers ?? []).map(value => value.id === entry.id ? entry : value), label, options.preflight); }
    catch (reason) { options.onPreview(); throw reason; }
  }

  function create(kind: string) {
    run(() => {
      const context = options.context(), definition = getSplatDeformerDefinition(kind);
      if (!definition || !context || !options.available()) return;
      const { shape, count, componentMode, indices: selected, weights } = context;
      if (count > SPLAT_DEFORMER_LIMITS.sourceCount) throw Error("Deformers support up to 100,000 original splats per shape.");
      if (componentMode && !selected.length) throw Error("Select splats, or return to Object mode to deform the whole shape.");
      const bounds = context.restBounds(componentMode ? selected : undefined);
      if (bounds.isEmpty()) throw Error("The deformer needs a visible original splat.");
      const stack = shape.deformers ?? [];
      let suffix = 1;
      while (stack.some(entry => entry.name === definition.name + " " + suffix)) suffix++;
      const entry: SplatDeformer = {
        id: crypto.randomUUID(), name: definition.name + " " + suffix, kind, envelope: 1, sourceCount: count,
        weights: componentMode ? Array.from(selected, (index, offset) => ({ index, weight: weights[offset] })).filter(row => row.weight > 0) : undefined,
        params: definition.create(bounds),
      };
      clearPreview(false);
      id = entry.id;
      index = 0; indices = [0];
      commit(store, shape.id, [...stack, entry], `Create ${definition.name}`, options.preflight);
    });
  }

  function authored(targetShape: string, targetId: string) {
    const shape = store.getState().document.nodes[targetShape];
    if (shape?.type !== "splatShape") return;
    const entry = shape.deformers?.find(value => value.id === targetId);
    if (entry) return { shape, entry };
  }

  function validPreview() {
    return preview && preview.document === store.getState().document && preview.frame === options.frame() ? preview : undefined;
  }

  function previewEntry(shape: SplatShapeNode, entry: SplatDeformer) {
    getSplatDeformerDefinition(entry.kind)?.validate(entry.params);
    const stack = (shape.deformers ?? []).map(value => value.id === entry.id ? { ...entry, keys: undefined } : value);
    options.preflight({ ...shape, deformers: stack });
    preview = { document: store.getState().document, frame: options.frame(), shapeId: shape.id,
      stack };
    options.onPreview();
  }

  function applyControls(entry: SplatDeformer, values: { id: string; value: number }[]) {
    let next = entry;
    const keyed = new Set(entry.keys?.map(key => key.channel));
    const edits: { id: string; value: number }[] = [];
    const fields = new Map(splatDeformerControls(entry).map(control => [control.id, control]));
    for (const control of values) {
      const field = fields.get(control.id);
      if (!field) continue;
      const keyable = !field.toggle;
      if (keyable && keyed.has(control.id) && !options.canKey()) throw Error("Select base animation to edit keyed deformer controls.");
      if (keyable && options.canKey() && (options.autoKey() || keyed.has(control.id))) {
        edits.push(control);
      } else next = withSplatDeformerControl(next, control.id, control.value, field);
    }
    return edits.length ? keySplatDeformerControls(next, Math.round(options.frame()), edits) : next;
  }

  function controlChanges(evaluated: SplatDeformer, control: SplatDeformerControl<unknown>, value: number) {
    if (indices.length === 1 || !control.id.startsWith("point.")) return [{ id: control.id, value }];
    const axis = control.id.slice(-1), delta = value - control.value;
    return activeControls(evaluated).filter(c => c.id.startsWith("point.") && c.id.endsWith("." + axis))
      .map(c => ({ id: c.id, value: c.value + delta }));
  }

  function setControl(shape: SplatShapeNode, entry: SplatDeformer, control: SplatDeformerControl<unknown>, value: number) {
    if (!options.available() || value === control.value) { clearPreview(); return; }
    const changes = controlChanges(sampleSplatDeformer(entry, options.frame()), control, value);
    change(shape, applyControls(entry, changes), `Edit ${control.label}`);
  }

  function activeControls(entry: SplatDeformer) {
    const controls = new Map(indices.flatMap(i => splatDeformerControls(entry, i)).map(field => [field.id, field]));
    return Array.from(controls.values());
  }

  function numeric(label: string, value: number, min: number | undefined, max: number | undefined, step: number) {
    const input = document.createElement("input");
    input.type = "number";
    input.setAttribute("aria-label", label);
    input.value = String(Number(value.toPrecision(9)));
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    // Continuous values use the number input's bounds; scrub size is independent.
    input.step = String(step);
    return input;
  }
  const inRange = (input: HTMLInputElement) => Number.isFinite(input.valueAsNumber) && !input.validity.rangeOverflow && !input.validity.rangeUnderflow;

  function renderControl(shape: SplatShapeNode, entry: SplatDeformer, evaluated: SplatDeformer, control: SplatDeformerControl<unknown>) {
    const row = document.createElement("div"), label = document.createElement("label"), title = document.createElement("span");
    row.className = "splat-deformer-control";
    title.textContent = control.label;
    label.append(title);
    if (control.toggle) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!control.value;
      box.onchange = () => run(() => setControl(shape, entry, control, Number(box.checked)));
      label.append(box);
      row.append(label);
      return row;
    }
    const input = numeric(control.label, control.value, control.min, control.max, control.step ?? 0.01);
    input.dataset.deformerChannel = control.id;
    const original = input.value;
    const update = (value: number) => {
      if (!options.available() || store.getState().document.nodes[shape.id] !== shape) return;
      try {
        let draft = evaluated;
        for (const change of controlChanges(evaluated, control, value)) draft = withSplatDeformerControl(draft, change.id, change.value);
        previewEntry(shape, draft);
      }
      catch { clearPreview(); }
    };
    const finish = () => {
      if (input.readOnly || !inRange(input) || store.getState().document.nodes[shape.id] !== shape) {
        clearPreview();
        input.value = original;
        return;
      }
      run(() => setControl(shape, entry, control, input.valueAsNumber));
    };
    propertyInteraction(input, () => `splat-deformer:${shape.id}:${entry.id}:${control.id}`, title, () => ({
      update,
      end: () => clearPreview(),
    }))();
    input.oninput = () => { if (!input.readOnly && inRange(input)) update(input.valueAsNumber); };
    input.onchange = finish;
    input.onblur = () => clearPreview();
    input.onkeydown = event => {
      if (event.key !== "Escape" && event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { clearPreview(); input.value = original; }
      else finish();
      input.blur();
    };
    label.append(input);
    const frame = Math.round(options.frame()), atFrame = entry.keys?.some(key => key.channel === control.id && key.frame === frame);
    const key = button(atFrame ? "◆" : "◇", () => run(() => {
      const next = atFrame ? { ...entry, keys: entry.keys?.filter(value => value.channel !== control.id || value.frame !== frame) }
        : keySplatDeformer(entry, control.id, frame, control.value);
      change(shape, next, atFrame ? `Remove ${control.label} key` : `Key ${control.label}`);
    }));
    key.setAttribute("aria-label", `${atFrame ? "Remove key for" : "Key"} ${control.label}`);
    key.title = key.getAttribute("aria-label")!;
    key.disabled = !options.canKey();
    if (key.disabled) key.title = "Select base animation in Animation mode to key deformer controls.";
    if (!key.disabled && entry.keys?.some(k => k.channel === control.id)) {
      key.title += " · Right-click to show curve";
      key.oncontextmenu = event => { event.preventDefault(); options.onGraph?.(deformerTrackId(shape.id, entry.id, control.id)); };
    }
    row.append(label, key);
    return row;
  }

  function button(label: string, action: () => void) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    control.onclick = action;
    return control;
  }

  function refresh() {
    const context = options.context(), shape = context?.shape, stack = shape?.deformers ?? [];
    const enabled = options.available();
    if (shape?.id !== shapeId || !stack.some(value => value.id === id)) {
      shapeId = shape?.id ?? "";
      id = stack[0]?.id ?? "";
      index = 0; indices = [0];
      editHandles = false;
    }
    if (!validPreview()) preview = undefined;
    add.disabled = !context || !enabled || stack.length >= SPLAT_DEFORMER_LIMITS.perShape;
    status.textContent = error || (!context ? "Select one splat object." :
      context.componentMode ? `${context.indices.length.toLocaleString()} selected originals` : `${context.count.toLocaleString()} original splats`);
    const frame = options.frame(), selected = context?.indices.length ?? 0;
    if (rendered && rendered.shape === shape && rendered.id === id && rendered.index === index &&
      rendered.enabled === enabled && rendered.selected === selected && rendered.handles === editHandles) {
      if (rendered.frame === frame) return;
      if (!enabled) {
        // During playback keep the inspector alive and update only displayed values.
        // A hidden inspector resamples when it next becomes visible or editable.
        if (!element.getClientRects().length) return;
        const entry = stack.find(e => e.id === id);
        if (entry) {
          const sampled = sampleSplatDeformer(entry, frame);
          const controls = new Map(splatDeformerControls(sampled, index).map(c => [c.id, c.value]));
          body.querySelectorAll<HTMLInputElement>("input[data-deformer-channel]").forEach(input => {
            const value = controls.get(input.dataset.deformerChannel!);
            if (value !== undefined) input.value = String(Number(value.toPrecision(9)));
          });
        }
        rendered.frame = frame;
        return;
      }
    }
    rendered = { shape, frame, id, index, enabled, selected, handles: editHandles };
    body.replaceChildren();
    const offset = stack.findIndex(entry => entry.id === id), entry = stack[offset];
    if (!shape || !entry) { options.onContextChange?.(); return; }
    const fields = document.createElement("fieldset");
    fields.disabled = !enabled;
    const choice = document.createElement("select");
    choice.setAttribute("aria-label", "Deformer stack");
    for (const value of stack) choice.add(new Option(value.name, value.id, false, value.id === id));
    choice.onchange = () => {
      clearPreview();
      id = choice.value;
      index = 0; indices = [0];
      refresh();
      options.onHandleChange(editHandles);
    };
    const toolbar = document.createElement("div");
    toolbar.className = "splat-deformer-tools";
    for (const delta of [-1, 1]) {
      const move = button(delta < 0 ? "Move earlier" : "Move later", () => run(() => {
        const next = [...stack];
        next.splice(offset, 1);
        next.splice(offset + delta, 0, entry);
        commit(store, shape.id, next, "Reorder splat deformers", options.preflight);
      }));
      move.disabled = !stack[offset + delta];
      toolbar.append(move);
    }
    toolbar.append(button("Remove", () => run(() => commit(store, shape.id, stack.filter(value => value !== entry), "Remove splat deformer", options.preflight))));
    fields.append(choice, toolbar);

    const evaluated = sampleSplatDeformer(entry, frame), definition = getSplatDeformerDefinition(entry.kind)!;
    const adapter = definition.handle;
    if (adapter) {
      const edit = document.createElement("label"), checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = editHandles;
      edit.append(checkbox, "Edit handles");
      checkbox.onchange = () => {
        clearPreview();
        editHandles = checkbox.checked;
        options.onHandleChange(editHandles);
        refresh();
      };
      fields.append(edit);
      const count = adapter.count(evaluated.params);
      if (count > 1) {
        index = Math.min(index, count - 1);
        indices = indices.filter(i => i < count);
        if (!indices.includes(index)) indices.push(index);
        const handles = document.createElement("select");
        handles.setAttribute("aria-label", "Deformer handle");
        for (let i = 0; i < count; i++) handles.add(new Option(adapter.name?.(i) ?? `Point ${i + 1}`, String(i), false, index === i));
        handles.onchange = () => selectHandle(Number(handles.value));
        fields.append(handles);
        if (entry.kind === "cage" || entry.kind === "lattice") {
          const group = document.createElement("div");
          group.className = "splat-deformer-tools";
          const mode = document.createElement("select");
          mode.setAttribute("aria-label", "Select control points");
          mode.add(new Option("Select points…", ""));
          mode.add(new Option("Active point only", "one"));
          mode.add(new Option("All points", "all"));
          if (entry.kind === "lattice") for (const axis of ["X", "Y", "Z"]) {
            mode.add(new Option(`Row along ${axis}`, "row" + axis));
            mode.add(new Option(`Plane normal to ${axis}`, "plane" + axis));
          }
          mode.onchange = () => {
            const name = mode.value;
            if (!name) return;
            const next = name === "one" ? [index] : name === "all" ? Array.from({ length: count }, (_, i) => i)
              : latticePointGroup((entry.params as SplatLattice).divisions, index, "XYZ".indexOf(name.slice(-1)), name.startsWith("plane"));
            selectPoints(index, next);
          };
          const list = document.createElement("input");
          list.type = "text"; list.setAttribute("aria-label", "Selected point numbers");
          list.value = indices.map(i => i + 1).join(", ");
          list.title = "Enter point numbers separated by commas. Shift-click viewport points to toggle.";
          list.onchange = () => run(() => {
            const values = list.value.split(",").map(s => Number(s.trim()) - 1);
            if (!values.length || values.some(i => !Number.isInteger(i) || i < 0 || i >= count)) throw Error(`Choose point numbers from 1 to ${count}.`);
            const unique = [...new Set(values)];
            selectPoints(unique[unique.length - 1], unique);
          });
          const countLabel = document.createElement("span");
          countLabel.textContent = `${indices.length} selected`;
          group.append(mode, list, countLabel); fields.append(group);
        }
      }
    }
    const mask = document.createElement("select"), maskLabel = document.createElement("label");
    mask.setAttribute("aria-label", "Deformer mask");
    mask.add(new Option("No mask", ""));
    for (const value of shape.scalarMasks ?? []) mask.add(new Option(value.name, value.id));
    mask.value = entry.maskId ?? "";
    mask.onchange = () => run(() => change(shape, { ...entry, maskId: mask.value || undefined }, "Set deformer mask"));
    maskLabel.append("Mask", mask);
    fields.append(maskLabel);
    const weightLabel = document.createElement("label"), weight = numeric("Selected splat weight", 1, 0, 1, 0.01);
    weightLabel.append("Selected splat weight", weight);
    const setWeight = button("Apply weight", () => run(() => {
      const current = options.context();
      if (current?.shape !== shape || !current.indices.length || !inRange(weight)) return;
      change(shape, withSplatDeformerWeights(entry, current.indices, weight.valueAsNumber), "Set deformer weights");
    }));
    weight.disabled = setWeight.disabled = !selected;
    fields.append(weightLabel, setWeight);
    for (const control of splatDeformerControls(evaluated, index)) fields.append(renderControl(shape, entry, evaluated, control));
    body.append(fields);
    options.onContextChange?.();
  }

  function selectPoints(active: number, selected: number[]) {
    clearPreview();
    index = active;
    indices = selected;
    rendered = undefined;
    refresh();
    options.onHandleChange(editHandles);
  }
  function selectHandle(handleIndex: number, toggle = false) {
    if (!toggle) { selectPoints(handleIndex, [handleIndex]); return; }
    if (indices.includes(handleIndex)) {
      if (indices.length === 1) return;
      const next = indices.filter(i => i !== handleIndex);
      selectPoints(next[next.length - 1], next);
    } else selectPoints(handleIndex, [...indices, handleIndex]);
  }

  function selectedHandle() {
    if (!editHandles || !element.getClientRects().length || options.context()?.shape.id !== shapeId) return;
    const target = authored(shapeId, id);
    if (target && getSplatDeformerDefinition(target.entry.kind)?.handle) return { shapeId, id, index, indices };
  }

  function paramsForHandle(targetShape: string, targetId: string) {
    const target = authored(targetShape, targetId);
    if (!target) return;
    const active = validPreview();
    if (active?.shapeId === targetShape) {
      const draft = active.stack.find(entry => entry.id === targetId);
      if (draft) return sampleSplatDeformer(draft, options.frame()).params;
    }
    return sampleSplatDeformer(target.entry, options.frame()).params;
  }

  add.onclick = () => create(type.value);
  refresh();
  return {
    element, refresh, create, selectHandle, selectedHandle, paramsForHandle, bindingPanelHost,
    selectedEntry() {
      const target = authored(shapeId, id);
      if (target && options.context()?.shape.id === shapeId) return { shapeId, entry: target.entry };
    },
    cancelPreview: clearPreview,
    stopEditing() {
      clearPreview();
      if (!editHandles) return;
      editHandles = false;
      refresh();
      options.onHandleChange(false);
    },
    deformersForShape(shape: SplatShapeNode) {
      const active = validPreview();
      return active?.shapeId === shape.id ? active.stack : shape.deformers;
    },
    previewParams(targetShape: string, targetId: string, params: unknown) {
      const target = authored(targetShape, targetId);
      if (target) previewEntry(target.shape, { ...sampleSplatDeformer(target.entry, options.frame()), params });
    },
    commitParams(targetShape: string, targetId: string, params: unknown, label: string) {
      run(() => {
        const target = authored(targetShape, targetId);
        if (!target) return;
        const evaluated = sampleSplatDeformer(target.entry, options.frame());
        const definition = getSplatDeformerDefinition(evaluated.kind)!;
        definition.validate(params);
        const before = new Map(definition.controls(evaluated.params).map(control => [control.id, control.value]));
        const changes = definition.controls(params).filter(control => Math.abs(control.value - (before.get(control.id) ?? Infinity)) > 1e-10);
        if (changes.length) change(target.shape, applyControls(target.entry, changes), label);
        else clearPreview();
      });
    },
    rebindLattice(targetShape: string, targetId: string, params: SplatLattice, reset: boolean) {
      const target = authored(targetShape, targetId);
      if (!target || target.entry.kind !== "lattice") throw Error("Select a lattice to rebind.");
      const next = rebindLattice(target.entry, params, reset);
      if (next !== target.entry) change(target.shape, next, reset ? "Reset splat lattice" : "Rebind splat lattice");
    },
    replaceParams(targetShape: string, targetId: string, params: unknown, label: string) {
      run(() => {
        const target = authored(targetShape, targetId);
        if (target) change(target.shape, { ...target.entry, params, keys: target.entry.keys?.filter(key => key.channel === "envelope") }, label);
      });
    },
    keyActive() {
      const target = authored(shapeId, id);
      if (!target || !selectedHandle()) return false;
      if (!options.available() || !options.canKey()) {
        error = "Select base animation in Animation mode to edit deformer keys."; refresh(); return true;
      }
      run(() => {
        const frame = Math.round(options.frame()), sampled = sampleSplatDeformer(target.entry, options.frame());
        const controls = activeControls(sampled).filter(control => !control.toggle);
        const keyed = keySplatDeformerControls(target.entry, frame, controls);
        change(target.shape, keyed, "Set deformer keys");
      });
      return true;
    },
    deleteKeysAtFrame() {
      const target = authored(shapeId, id);
      if (!target || !selectedHandle()) return false;
      if (!options.available() || !options.canKey()) {
        error = "Select base animation in Animation mode to edit deformer keys."; refresh(); return true;
      }
      const frame = Math.round(options.frame());
      const channels = new Set(activeControls(target.entry).map(control => control.id));
      const keys = target.entry.keys?.filter(key => key.frame !== frame || !channels.has(key.channel));
      if (keys?.length !== target.entry.keys?.length) run(() => change(target.shape, { ...target.entry, keys }, "Delete deformer keys"));
      return true;
    },
  };
}
