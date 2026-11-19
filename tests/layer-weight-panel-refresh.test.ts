import { afterEach, expect, it, vi } from "vitest";
import { createAnimationLayersPanel } from "../src/animation-layers-panel.ts";
import { defaultAnimation, type AnimationLayer, type CurveKey } from "../src/animation.ts";
import { deleteLayerWeightKey, replaceLayerWeightTrack, setActiveAnimationLayer, updateAnimationLayer } from "../src/animation-layers.ts";
import { emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

// Native select behavior is covered in Chromium. These surfaces expose the panel's
// refresh inputs, writes and listeners without adding a DOM dependency.
class PanelOption {
  constructor(readonly text: string, readonly value: string) {}
}

class PanelElement extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly children: (PanelElement | PanelOption | string)[] = [];
  readonly replaceChildren = vi.fn((...children: (PanelElement | PanelOption)[]) => {
    this.children.splice(0, this.children.length, ...children.flatMap(child =>
      child instanceof PanelElement && child.tag === "fragment" ? child.children : [child]));
  });
  readonly writeValue = vi.fn();
  textContent = "";
  min = "";
  max = "";
  open = false;
  hidden = false;
  disabled = false;
  onchange?: () => void;
  onclick?: () => void;
  private currentValue = "";

  constructor(readonly tag: string) { super(); }
  get value() { return this.currentValue; }
  set value(value: string) { this.currentValue = value; this.writeValue(value); }
  get valueAsNumber() { return this.value ? Number(this.value) : NaN; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  reportValidity() { return this.valueAsNumber >= Number(this.min) && this.valueAsNumber <= Number(this.max); }
  toggleAttribute() {}
  append(...children: (PanelElement | PanelOption | string)[]) { this.children.push(...children); }
  add() {}
  blur() {}
  press(key: string, modifiers: { ctrlKey?: boolean; altKey?: boolean } = {}) {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key, ...modifiers });
    this.dispatchEvent(event);
    return event.defaultPrevented;
  }
}

const key = (id: string, time: number, value: number): CurveKey => ({ id, time, value, interpolation: "linear", tangentMode: "auto" });

function fixture(keys: CurveKey[]) {
  const elements: PanelElement[] = [];
  const dom = {
    activeElement: null as PanelElement | null,
    createElement(tag: string) { const element = new PanelElement(tag); elements.push(element); return element; },
    createDocumentFragment() { return new PanelElement("fragment"); },
  };
  vi.stubGlobal("document", dom);
  vi.stubGlobal("Option", PanelOption);
  const layer = (id: string, layerKeys: CurveKey[]): AnimationLayer => ({ id, name: id, mode: "additive", weight: 1, mute: false, solo: false, locked: false, weightTrack: { id: `${id}-weight`, keys: layerKeys } });
  const scene = emptyScene();
  scene.animation = { ...defaultAnimation(), activeLayerId: "first", layers: [layer("first", keys), layer("second", [key("other", 2, .8)])] };
  const store = createSceneStore(scene);
  let frame = 1.5;
  let available = true;
  const panel = createAnimationLayersPanel(store, { available: () => available, onActiveChange() {}, getFrame: () => frame });
  const control = (label: string) => elements.find(element => element.attributes.get("aria-label") === label)!;
  const list = control("Layer weight keys");
  const details = elements.find(element => element.tag === "details")!;
  return {
    ...panel, store, dom, list, details, control,
    seek(value: number) { frame = value; panel.refresh(); },
    setAvailable(value: boolean) { available = value; panel.refresh(); },
    select(id: string) { list.value = id; list.onchange!(); },
    button(text: string) { return elements.find(element => element.tag === "button" && element.textContent === text)!; },
    options() { return list.children as PanelOption[]; },
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reuses the selected index and native selection during steady refresh", () => {
  const keys = Array.from({ length: 99_999 }, (_, i) => key(`key-${i}`, i + .25, (i % 8) / 8));
  const findIndex = vi.spyOn(keys, "findIndex"), some = vi.spyOn(keys, "some");
  const panel = fixture(keys);
  panel.select("key-99998");
  expect(panel.control("Selected weight key frame").value).toBe("99998.25");
  expect(Number(panel.control("Selected weight key in tangent slope").value)).toBe(.125);
  expect(panel.list.replaceChildren).not.toHaveBeenCalled();
  panel.details.open = true;
  panel.refresh();
  expect(panel.options()).toHaveLength(31);
  expect(panel.options().at(-1)?.value).toBe("key-99998");
  panel.list.writeValue.mockClear();
  panel.seek(99_997.625);
  panel.seek(99_998.125);
  panel.details.open = false;
  panel.refresh();
  expect(panel.list.replaceChildren).toHaveBeenCalledTimes(1);
  expect(panel.list.writeValue).not.toHaveBeenCalled();
  expect(findIndex).not.toHaveBeenCalled();
  expect(some).not.toHaveBeenCalled();
  panel.dispose();
});

it("resolves the same selected ID against each immutable revision and resets on owner changes", () => {
  const first = key("a", -2, .25), selected = key("b", .5, .75), last = key("c", 2, .5);
  const panel = fixture([first, selected, last]);
  panel.details.open = true;
  panel.refresh();
  panel.select("b");
  const frame = panel.control("Selected weight key frame");
  const slope = panel.control("Selected weight key in tangent slope");
  expect(Number(slope.value)).toBe(0);
  panel.seek(-1.6);
  expect(panel.button("Delete weight key").disabled).toBe(false);
  panel.seek(.5);
  expect(panel.button("Delete weight key").disabled).toBe(true);

  panel.dom.activeElement = frame;
  frame.value = "4";
  replaceLayerWeightTrack(panel.store, "first", { id: "first-weight", keys: [first, last, { ...selected, time: 3 }] });
  expect(panel.list.value).toBe("b");
  expect(frame.value).toBe("4");
  expect(Number(slope.value)).toBe(.25);
  panel.dom.activeElement = null;
  panel.refresh();
  expect(frame.value).toBe("3");
  panel.store.temporal.getState().undo();
  expect(frame.value).toBe("0.5");
  expect(Number(slope.value)).toBe(0);

  deleteLayerWeightKey(panel.store, "first", .5);
  expect(panel.list.value).toBe("a");
  panel.store.temporal.getState().undo();
  expect(panel.list.value).toBe("a");
  updateAnimationLayer(panel.store, "first", { locked: true });
  expect(frame.disabled).toBe(true);
  setActiveAnimationLayer(panel.store, "second");
  expect(frame.disabled).toBe(false);
  expect(panel.list.value).toBe("other");
  expect(frame.value).toBe("2");
  panel.dispose();
});

it("partitions sorted keys into bounded ranges and crosses boundaries by pointer and keyboard", () => {
  const keys = Array.from({ length: 333 }, (_, i) => key(`key-${i}`, (i - 200) / 8, .5));
  const panel = fixture(keys);
  const previous = panel.button("Previous range"), next = panel.button("Next range");
  panel.details.open = true;
  panel.refresh();
  expect(previous.attributes.get("aria-disabled")).toBe("true");
  expect(panel.options()).toHaveLength(128);
  expect(panel.options()[0].text).toContain("Frame -25");
  const seen = panel.options().map(option => option.value);
  next.onclick!();
  expect(panel.list.value).toBe("key-128");
  expect(panel.options()[0].text).toContain("Frame -9");
  seen.push(...panel.options().map(option => option.value));
  next.onclick!();
  expect(panel.list.value).toBe("key-256");
  expect(next.attributes.get("aria-disabled")).toBe("true");
  seen.push(...panel.options().map(option => option.value));
  expect(seen).toEqual(keys.map(key => key.id));
  previous.onclick!();
  expect(panel.list.value).toBe("key-255");
  panel.setAvailable(false);
  expect(previous.attributes.get("aria-disabled")).toBe("true");
  expect(next.attributes.get("aria-disabled")).toBe("true");
  previous.onclick!();
  next.onclick!();
  expect(panel.list.press("Home")).toBe(false);
  expect(panel.list.value).toBe("key-255");
  panel.setAvailable(true);
  expect(previous.attributes.get("aria-disabled")).toBe("false");
  expect(next.attributes.get("aria-disabled")).toBe("false");
  expect(panel.list.press("ArrowDown")).toBe(true);
  expect(panel.list.value).toBe("key-256");
  expect(panel.list.press("ArrowUp")).toBe(true);
  expect(panel.list.value).toBe("key-255");
  expect(panel.list.press(".", { ctrlKey: true, altKey: true })).toBe(true);
  expect(panel.list.value).toBe("key-256");
  expect(panel.list.press("End")).toBe(true);
  expect(panel.list.value).toBe("key-332");
  expect(panel.list.press("Home")).toBe(true);
  expect(panel.list.value).toBe("key-0");
  panel.dispose();
});

it("finds exact or following frames without editing, clears invalid drafts on Escape, and follows the selected ID across range changes", () => {
  const keys = Array.from({ length: 260 }, (_, i) => key(`key-${i}`, i / 16 - 10, .5));
  const panel = fixture(keys);
  const findFrame = panel.control("Find key by frame");
  const frame = panel.control("Selected weight key frame");
  const navigation = panel.control("Weight key navigation");
  panel.details.open = true;
  panel.refresh();

  for (const value of ["", "invalid", "1000001"]) {
    findFrame.value = value;
    findFrame.press("Enter");
    expect(panel.list.value).toBe("key-0");
  }
  findFrame.press("Escape");
  expect(findFrame.value).toBe("");
  findFrame.value = "-2.0625";
  panel.button("Find key").onclick!();
  expect(panel.list.value).toBe("key-127");
  findFrame.value = "-2.01";
  findFrame.press("Enter");
  expect(panel.list.value).toBe("key-128");
  expect(frame.value).toBe("-2");
  findFrame.value = "1000000";
  findFrame.press("Enter");
  expect(panel.list.value).toBe("key-259");
  findFrame.value = "-1000000";
  findFrame.press("Enter");
  expect(panel.list.value).toBe("key-0");
  expect(panel.store.temporal.getState().pastStates).toHaveLength(0);

  panel.select("key-127");
  const moved = { ...keys[127], time: 42.5 };
  replaceLayerWeightTrack(panel.store, "first", { id: "first-weight", keys: [...keys.slice(0, 127), ...keys.slice(128), moved] });
  expect(panel.options().at(-1)?.value).toBe("key-127");
  expect(panel.list.value).toBe("key-127");
  expect(frame.value).toBe("42.5");
  panel.store.temporal.getState().undo();
  expect(panel.options().at(-1)?.value).toBe("key-127");
  expect(panel.list.value).toBe("key-127");
  expect(frame.value).toBe("-2.0625");
  panel.store.temporal.getState().redo();
  expect(frame.value).toBe("42.5");
  updateAnimationLayer(panel.store, "first", { locked: true });
  expect(frame.disabled).toBe(true);
  expect(navigation.hidden).toBe(false);
  expect(panel.list.disabled).toBe(false);
  setActiveAnimationLayer(panel.store, "second");
  expect(navigation.hidden).toBe(true);
  expect(panel.options()).toHaveLength(1);
  expect(panel.list.value).toBe("other");
  expect(findFrame.value).toBe("");
  panel.dispose();
});
