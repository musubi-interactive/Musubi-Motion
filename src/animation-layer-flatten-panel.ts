import { defaultAnimation, type AnimationLayer } from "./animation.ts";
import { prepareAnimationLayerFlatten } from "./animation-layer-flatten.ts";
import { propertyInteraction } from "./property-interaction.ts";
import type { SceneDocument } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

type Options = { available(): boolean; onBaked(): void; focusFallback(): void; onStatus?(message: string): void };

export function createAnimationLayerFlattenPanel(store: SceneStore, options: Options) {
  const element = document.createElement("section");
  const trigger = button("Merge Layers…");
  const panel = document.createElement("section");
  panel.id = `merge-animation-layers-${crypto.randomUUID()}`;
  panel.className = "merge-animation-layers";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Merge animation layers");
  trigger.setAttribute("aria-controls", panel.id);
  trigger.setAttribute("aria-expanded", "false");
  const sources = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "Layers to merge";
  const choices = document.createElement("div");
  choices.className = "merge-layer-choices";
  sources.append(legend, choices);
  const fields = document.createElement("div");
  fields.className = "weight-key-fields";
  const start = numberField("Start frame", "-1000000", "1000000", "0.25");
  const end = numberField("End frame", "-1000000", "1000000", "0.25");
  const step = numberField("Sample By (frames)", "0.001", "2000000", "0.1");
  const numericFields = [start, end, step];
  fields.append(...numericFields.map(field => field.label));
  const actions = document.createElement("div");
  actions.className = "weight-actions";
  const preview = button("Preview Merge");
  const bake = button("Bake Layers");
  const cancel = button("Cancel");
  actions.append(preview, bake, cancel);
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  const style = document.createElement("style");
  style.textContent = ".merge-animation-layers{border-block:1px solid var(--line);padding:8px 0;margin-bottom:8px}.merge-animation-layers fieldset{min-width:0;border:1px solid var(--line);border-radius:3px;margin:0;padding:0 8px}.merge-layer-choices{max-height:148px;overflow:auto}.merge-layer-choices label{overflow-wrap:anywhere}.merge-animation-layers p:empty{display:none}";
  panel.append(sources, fields, actions, message);
  element.append(style, trigger, panel);

  const selected = new Set<string>();
  let renderedLayers: AnimationLayer[] | undefined;
  let plan: { document: SceneDocument; prepared: ReturnType<typeof prepareAnimationLayerFlatten> } | undefined;

  function button(text: string) {
    const result = document.createElement("button");
    result.type = "button";
    result.textContent = text;
    return result;
  }

  function numberField(text: string, min: string, max: string, increment: string) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = min;
    input.max = max;
    input.step = increment;
    const label = document.createElement("label");
    label.append(text, input);
    const refreshLock = propertyInteraction(input, () => `merge-layers:${text}`);
    input.addEventListener("input", invalidate);
    input.addEventListener("change", invalidate);
    return { input, label, refreshLock };
  }

  function report(text: string, error = false) {
    message.textContent = text;
    message.dataset.error = String(error);
  }

  function invalidate() {
    plan = undefined;
    report("");
    bake.disabled = true;
  }

  function close() {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    selected.clear();
    renderedLayers = undefined;
    choices.replaceChildren();
    invalidate();
    if (trigger.disabled) options.focusFallback();
    else trigger.focus();
  }

  function refresh() {
    const current = store.getState().document;
    const layers = current.animation?.layers;
    const available = options.available();
    trigger.disabled = !available || (layers?.length ?? 0) < 2;
    if (panel.hidden) return;
    if (plan && plan.document !== current) {
      invalidate();
      report("Animation changed. Preview the merge again.");
    }
    if (renderedLayers !== layers) {
      renderedLayers = layers;
      const validIds = new Set(layers?.filter(layer => !layer.locked).map(layer => layer.id));
      for (const id of selected) if (!validIds.has(id)) selected.delete(id);
      choices.replaceChildren(...(layers ?? []).map((layer, index) => {
        const label = document.createElement("label");
        label.className = "layer-check";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.disabled = layer.locked;
        checkbox.checked = selected.has(layer.id);
        checkbox.onchange = () => {
          if (checkbox.checked) selected.add(layer.id);
          else selected.delete(layer.id);
          invalidate();
          refresh();
        };
        label.append(checkbox, `${index + 1}. ${layer.name}${layer.locked ? " (Locked)" : ""}`);
        return label;
      }));
    }
    sources.disabled = !available;
    for (const field of numericFields) field.input.disabled = !available;
    preview.disabled = !available || selected.size < 2;
    bake.disabled = !available || !plan;
  }

  trigger.onclick = () => {
    if (!panel.hidden) { close(); return; }
    const animation = store.getState().document.animation ?? defaultAnimation();
    start.input.value = String(animation.start);
    end.input.value = String(animation.end);
    step.input.value = "1";
    if (animation.activeLayerId) selected.add(animation.activeLayerId);
    for (const field of numericFields) field.refreshLock();
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    refresh();
    (choices.querySelector<HTMLInputElement>("input:not(:disabled)") ?? start.input).focus();
  };
  preview.onclick = () => {
    if (!options.available()) return;
    invalidate();
    try {
      const current = store.getState().document;
      const prepared = prepareAnimationLayerFlatten(current, {
        layerIds: [...selected], start: start.input.valueAsNumber, end: end.input.valueAsNumber, sampleBy: step.input.valueAsNumber,
      });
      plan = { document: current, prepared };
      const { layerCount, curveCount, keyCount, maxError, name } = prepared.summary;
      report(`Replace ${layerCount} selected layers with ${name}: ${curveCount} curves, ${keyCount} keys. Maximum checked channel error ${maxError.toPrecision(3)}. Outside the sampled range, baked curves hold their endpoint values.`);
    } catch (error) {
      report(error instanceof Error ? error.message : String(error), true);
    }
    refresh();
  };
  bake.onclick = () => {
    if (!options.available() || !plan) return;
    try {
      const { prepared } = plan;
      prepared.commit(store);
      close();
      options.onBaked();
      options.onStatus?.(`Baked ${prepared.summary.curveCount} animation curves.`);
    } catch (error) {
      invalidate();
      report(error instanceof Error ? error.message : String(error), true);
    }
    refresh();
  };
  cancel.onclick = close;
  element.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  return { element, refresh };
}
