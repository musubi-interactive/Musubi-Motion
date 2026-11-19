import { defaultAnimation, setAnimationSettings, deleteKeys, editingTracks } from "./animation.ts";
import type { SceneStore } from "./scene-store.ts";
import type WaSlider from "@awesome.me/webawesome/dist/components/slider/slider.js";
import "./timeline-panel.css";
import { icon } from "./ui.ts";

export function mountTimeline(store: SceneStore, options: {
  getFrame(): number; navigationFrame(): number; setFrame(frame: number): void; setKey(): void;
  getSelection(): string[]; available(): boolean; onModeChange(): void;
  deleteDeformerKeys?(): boolean;
}) {
  const host = document.getElementById("timeline-panel")!;
  host.classList.add("timeline-editor");
  const row = document.createElement("div"); row.className = "timeline-transport";
  row.append(...Array.from(host.children)); host.append(row);
  host.querySelector(".animation-label")!.remove();
  const tools = document.createElement("div"); tools.className = "timeline-options";
  tools.innerHTML = `<label>Mode <select aria-label="Playback mode"><option value="animation">Animation</option><option value="turntable">Turntable preview</option></select></label>
    <button type="button" data-action="key" title="Key the active selection (S)">Set key · S</button>
    <button type="button" data-action="delete">Delete keys at frame</button>
    <label><input type="checkbox" data-option="auto" /> Auto key</label>
    <label>Frame <input type="number" data-option="frame" aria-label="Current frame" step="1" /></label>
    <label>Start <input type="number" data-option="start" aria-label="Playback start frame" step="1" /></label>
    <label>End <input type="number" data-option="end" aria-label="Playback end frame" step="1" /></label>
    <label>FPS <input type="number" data-option="fps" aria-label="Frame rate" min="1" max="240" step="1" /></label>
    <label><input type="checkbox" data-option="loop" /> Loop</label>
    <span class="timeline-hint">Auto key updates existing channels. Set the first keys with S.</span>`;
  host.append(tools);
  const get = (name: string) => host.querySelector<HTMLInputElement>(`[data-option="${name}"]`)!;
  const slider = document.getElementById("timeline") as WaSlider;
  const transport = host.querySelector<HTMLElement>(".transport")!;
  row.append(transport);
  const frameLabel = get("frame").parentElement!;
  frameLabel.classList.add("timeline-current-frame");
  row.insertBefore(frameLabel, transport);
  tools.append(document.getElementById("time")!);
  const summary = document.createElement("span"); summary.className = "timeline-summary"; tools.append(summary);
  const navigation: HTMLButtonElement[] = [];
  for (const [action, label, symbol] of [
    ["previous-key", "Previous keyframe", "previousKey"], ["previous-frame", "Previous frame", "rewind"],
    ["next-frame", "Next frame", "rewind"], ["next-key", "Next keyframe", "previousKey"], ["end", "Go to end", "timelineStart"],
  ] as const) {
    const button = document.createElement("button"); button.type = "button"; button.title = label; button.setAttribute("aria-label", label);
    button.dataset.navigate = action; button.append(icon(symbol));
    if (action.startsWith("next") || action === "end") button.classList.add("forward-control");
    if (action.startsWith("previous")) transport.insertBefore(button, document.getElementById("play")); else transport.append(button);
    button.onclick = () => run(() => {
      const settings = store.getState().document.animation ?? defaultAnimation();
      const frame = Math.round(options.navigationFrame());
      if (action === "end") return options.setFrame(settings.end);
      const direction = action.startsWith("previous") ? -1 : 1;
      if (action.endsWith("frame")) return options.setFrame(frame + direction);
      const selection = new Set(options.getSelection());
      const frames = selectionKeyFrames(selection)
        .filter(f => f >= settings.start && f <= settings.end && (direction < 0 ? f < frame : f > frame));
      options.setFrame(frames.length ? (direction < 0 ? Math.max(...frames) : Math.min(...frames)) : (direction < 0 ? settings.start : settings.end));
    });
    navigation.push(button);
  }
  const mode = tools.querySelector("select")!;
  const markers = document.createElement("div"); markers.className = "timeline-keys";
  markers.setAttribute("aria-label", "Keys for selected objects"); host.querySelector(".timeline")!.append(markers);
  const status = document.createElement("span"); status.className = "timeline-error"; status.setAttribute("role", "status"); tools.append(status);
  function run(action: () => void) {
    if (!options.available()) return;
    try { action(); status.textContent = ""; } catch (error) { status.textContent = (error as Error).message; refresh(); }
  }
  function selectionKeyFrames(selection: Set<string>) {
    const doc = store.getState().document;
    return editingTracks(doc).filter(track => selection.has(track.targetId)).flatMap(track => track.keys.map(key => key.time));
  }
  mode.onchange = () => run(options.onModeChange);
  tools.querySelector<HTMLButtonElement>('[data-action="key"]')!.onclick = () => run(options.setKey);
  tools.querySelector<HTMLButtonElement>('[data-action="delete"]')!.onclick = () => run(() => {
    if (options.deleteDeformerKeys?.()) return;
    const selection = new Set(options.getSelection());
    const ids = editingTracks(store.getState().document).filter(t => selection.has(t.targetId))
      .flatMap(t => t.keys.filter(k => k.time === Math.round(options.getFrame())).map(k => k.id)) ?? [];
    deleteKeys(store, ids);
  });
  get("frame").onchange = () => run(() => options.setFrame(get("frame").valueAsNumber));
  for (const input of Array.from(host.querySelectorAll<HTMLInputElement>('input[type="number"]'))) input.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); input.blur(); }
  });
  for (const key of ["start", "end", "fps"] as const) get(key).onchange = () => run(() => setAnimationSettings(store, { [key]: get(key).valueAsNumber }));
  get("loop").onchange = () => run(() => setAnimationSettings(store, { loop: get("loop").checked }));
  let lastDocument: ReturnType<SceneStore["getState"]>["document"] | undefined;
  let lastMarkers = "";
  let rulerWidth = 0;
  const ticks = host.querySelector<HTMLElement>(".ticks")!;
  const rulerObserver = new ResizeObserver(() => { lastDocument = undefined; refresh(); });
  rulerObserver.observe(ticks);
  function refresh() {
    const settings = store.getState().document.animation ?? defaultAnimation();
    const turntable = mode.value === "turntable";
    slider.min = turntable ? 0 : settings.start;
    slider.max = turntable ? 12 : settings.end;
    slider.step = turntable ? 0.01 : 1;
    slider.label = turntable ? "Turntable time in seconds" : "Animation frame";
    for (const key of ["start", "end", "fps"] as const) if (document.activeElement !== get(key)) get(key).value = String(settings[key]);
    if (document.activeElement !== get("frame")) get("frame").value = String(Math.round(options.getFrame()));
    get("loop").checked = settings.loop;
    get("frame").disabled = !options.available() || turntable;
    navigation.forEach(button => { button.disabled = !options.available() || turntable; });
    summary.textContent = turntable ? "12-second orbit" : `${settings.end - settings.start + 1} frames · ${((settings.end - settings.start) / settings.fps).toFixed(2)} s · ${settings.fps} fps`;
    for (const input of Array.from(tools.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"))) input.disabled = !options.available() || turntable;
    mode.disabled = !options.available();
    const markerState = `${turntable}/${options.getSelection().join(",")}`;
    const doc = store.getState().document;
    if (lastDocument === doc && markerState === lastMarkers) return;
    lastDocument = doc; lastMarkers = markerState;
    rulerWidth = ticks.clientWidth;
    const start = turntable ? 0 : settings.start, end = turntable ? 12 : settings.end;
    const span = Math.max(1, end - start);
    const targetStep = span / Math.max(2, Math.floor(rulerWidth / 45));
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, targetStep)));
    const major = [1, 2, 5, 10].map(n => n * magnitude).find(n => n >= targetStep) ?? magnitude * 10;
    const minor = Math.max(1, major / 5);
    ticks.replaceChildren();
    for (let frame = Math.ceil(start / minor) * minor; frame <= end; frame += minor) {
      const tick = document.createElement("span");
      tick.style.left = `${100 * (frame - start) / span}%`;
      if (Math.abs(frame / major - Math.round(frame / major)) < 0.001) { tick.className = "major"; tick.textContent = `${frame}${turntable ? "s" : ""}`; }
      ticks.append(tick);
    }
    markers.replaceChildren();
    if (!turntable) {
      const selected = new Set(options.getSelection());
      const frames = new Set(selectionKeyFrames(selected));
      for (const frame of [...frames].sort((a, b) => a - b)) if (frame >= settings.start && frame <= settings.end) {
        const button = document.createElement("button"); button.type = "button";
        button.title = `Go to key at frame ${frame}`; button.setAttribute("aria-label", button.title);
        button.style.left = `${100 * (frame - settings.start) / Math.max(1, settings.end - settings.start)}%`;
        button.onclick = () => run(() => options.setFrame(frame)); markers.append(button);
      }
    }
  }
  return { refresh, get autoKey() { return get("auto").checked && mode.value === "animation"; }, get turntable() { return mode.value === "turntable"; } };
}
