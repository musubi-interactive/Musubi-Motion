import { afterEach, expect, it, vi } from "vitest";
import { createAnimationLayersPanel } from "../src/animation-layers-panel.ts";
import { defaultAnimation, type AnimationLayer, type CurveKey } from "../src/animation.ts";
import { deleteLayerWeightKey, replaceLayerWeightTrack, setActiveAnimationLayer, updateAnimationLayer } from "../src/animation-layers.ts";
import { emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

// Native select behavior is covered in Chromium. These surfaces expose the panel's
// refresh inputs, writes and listeners without adding a DOM dependency.
class PanelElement extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly replaceChildren = vi.fn();
  readonly writeValue = vi.fn();
  textContent = "";
  open = false;
  disabled = false;
  onchange?: () => void;
  onclick?: () => void;
  private currentValue = "";

  constructor(readonly tag: string) { super(); }
  get value() { return this.currentValue; }
  set value(value: string) { this.currentValue = value; this.writeValue(value); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  toggleAttribute() {}
  append() {}
  add() {}
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
  vi.stubGlobal("Option", class {});
  const layer = (id: string, layerKeys: CurveKey[]): AnimationLayer => ({ id, name: id, mode: "additive", weight: 1, mute: false, solo: false, locked: false, weightTrack: { id: `${id}-weight`, keys: layerKeys } });
  const scene = emptyScene();
  scene.animation = { ...defaultAnimation(), activeLayerId: "first", layers: [layer("first", keys), layer("second", [key("other", 2, .8)])] };
  const store = createSceneStore(scene);
  let frame = 1.5;
  const panel = createAnimationLayersPanel(store, { available: () => true, onActiveChange() {}, getFrame: () => frame });
  const control = (label: string) => elements.find(element => element.attributes.get("aria-label") === label)!;
  const list = control("Layer weight keys");
  const details = elements.find(element => element.tag === "details")!;
  return {
    ...panel, store, dom, list, details, control,
    seek(value: number) { frame = value; panel.refresh(); },
    select(id: string) { list.value = id; list.onchange!(); },
    deleteAtFrame: elements.find(element => element.tag === "button" && element.textContent === "Delete weight key")!,
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
  expect(panel.deleteAtFrame.disabled).toBe(false);
  panel.seek(.5);
  expect(panel.deleteAtFrame.disabled).toBe(true);

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
