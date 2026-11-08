import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { propertyInteraction } from "../src/property-interaction.ts";

beforeEach(() => vi.stubGlobal("document", new EventTarget()));
afterEach(() => vi.unstubAllGlobals());

class NumericInput extends EventTarget {
  type = "number";
  value = "1";
  step = 0.1;
  title = "";
  disabled = false;
  captured = false;
  setPointerCapture() { this.captured = true; }
  hasPointerCapture() { return this.captured; }
  releasePointerCapture() { this.captured = false; }
}
function pointer(input: NumericInput, type: string, x: number) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { button: 1, pointerId: 1, clientX: x });
  input.dispatchEvent(event);
}

it("previews during dragging and commits once on release, after restoring the preview", () => {
  const input = new NumericInput();
  let pose = 1;
  const commits: number[] = [];
  propertyInteraction(input, () => "object/position/0", undefined, () => ({
    update(value) { pose = value; },
    end() { pose = 1; input.value = "1"; },
  }));
  input.addEventListener("change", () => { expect(pose).toBe(1); commits.push(Number(input.value)); });
  pointer(input, "pointerdown", 0);
  pointer(input, "pointermove", 20);
  expect(pose).toBe(1.2);
  expect(commits).toEqual([]);
  pointer(input, "pointermove", 30);
  pointer(input, "pointerup", 30);
  expect(commits).toEqual([1.3]);
});

it("restores the pose without committing when capture is canceled", () => {
  const input = new NumericInput();
  let pose = 1, commits = 0;
  propertyInteraction(input, () => "object/position/0", undefined, () => ({
    update(value) { pose = value; },
    end() { pose = 1; },
  }));
  input.addEventListener("change", () => commits++);
  pointer(input, "pointerdown", 0);
  pointer(input, "pointermove", 20);
  pointer(input, "pointercancel", 20);
  expect(pose).toBe(1);
  expect(input.value).toBe("1");
  expect(commits).toBe(0);
});

it("cancels an unfocused middle scrub from document Escape, then removes its listener", () => {
  const input = new NumericInput(); let pose = 1, commits = 0;
  propertyInteraction(input, () => "unfocused/custom", undefined, () => ({ update(value) { pose = value; }, end() { pose = 1; } }));
  input.addEventListener("change", () => commits++);
  pointer(input,"pointerdown",0); pointer(input,"pointermove",30);
  const escape = () => { const event=new Event("keydown",{cancelable:true});Object.assign(event,{key:"Escape"});document.dispatchEvent(event);return event; };
  expect(pose).toBe(1.3); expect(escape().defaultPrevented).toBe(true); expect(pose).toBe(1); expect(input.value).toBe("1"); expect(commits).toBe(0);
  expect(escape().defaultPrevented).toBe(false);
  pointer(input,"pointerdown",0); pointer(input,"pointermove",10); pointer(input,"pointerup",10);
  expect(commits).toBe(1);expect(escape().defaultPrevented).toBe(false);
});
