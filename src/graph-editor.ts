import { attributeTypeLabel } from "./custom-attribute-types.ts";
import { customAttribute } from "./custom-attributes.ts";
import { channelLabel, isCustomChannel } from "./custom-attributes.ts";
import type { SceneStore } from "./scene-store.ts";
import {
  defaultAnimation, evaluateCurve, tangentSlope, upsertTrack, deleteKeys, moveKeys,
  patchKeys, replaceTracks, copyKeys, pasteKeys,
  validateCurveKeys, scaleKeys, withTangent, insertKey, setKeys, channelsForTarget,
  evaluateSceneAnimation, readChannel, editingTracks,
} from "./animation.ts";
import type { AnimationTrack, CurveKey, AnimationPose } from "./animation.ts";
import type { SceneDocument } from "./scene-document.ts";
import { evaluateDrivenKeys } from "./driven-keys.ts";
import { drivenCurveTracks, replaceDrivenTracks, patchDrivenCurveKeys, moveDrivenCurveKeys, deleteDrivenCurveKeys,
  insertDrivenCurveKey, scaleDrivenCurveKeys, copyDrivenCurveKeys, pasteDrivenCurveKeys } from "./driven-curve-edit.ts";
import "./graph-editor.css";

type EditorOptions = {
  getFrame: () => number;
  setFrame: (frame: number) => void;
  getSelection: () => string[];
  available: () => boolean;
  onSelectTarget?: (id: string) => void;
  getDrivenPoses?: () => ReadonlyMap<string, AnimationPose>;
};
type CurveDomain<Clipboard> = {
  kind: "time" | "driven";
  tracks: (doc: SceneDocument) => AnimationTrack[];
  copy: (ids: Iterable<string>) => Clipboard;
  paste: (clipboard: Clipboard, coordinate: number) => string[];
  remove: (ids: Iterable<string>) => void;
  insert: (trackId: string, coordinate: number) => string;
  upsert: (track: AnimationTrack) => void;
  patch: (ids: Iterable<string>, patch: Partial<Omit<CurveKey, "id">>) => void;
  replace: (tracks: AnimationTrack[], label?: string) => void;
  move: (ids: Iterable<string>, coordinateDelta: number, valueDelta: number) => void;
  scale: (ids: Iterable<string>, factor: number) => void;
};
type View = { minTime: number; maxTime: number; minValue: number; maxValue: number };
type Point = { x: number; y: number };
type Drag = {
  kind: "key" | "tangent" | "pan" | "box" | "scrub";
  start: Point; current: Point; view: View; tracks: AnimationTrack[];
  keyId?: string; side?: "in" | "out"; additive: boolean; sheet: boolean;
  pointerId: number;
};
const SVG_NS = "http://www.w3.org/2000/svg";
const colors = ["#e58a81", "#92c997", "#83aee3", "#d7a0df", "#d9c67e", "#89c8c9"];
function svgElement<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}
function textSvg(x: number, y: number, text: string, className = "animation-axis-label") {
  const node = svgElement("text", { x, y, class: className }); node.textContent = text; return node;
}
function niceStep(span: number, count: number) {
  const raw = Math.max(1e-9, span / count), power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].find(value => value * power >= raw)! * power;
}
function labelValue(value: number) {
  return Math.abs(value) > 1e6 || (value !== 0 && Math.abs(value) < .001) ? value.toExponential(1) : String(Number(value.toFixed(3)));
}
function button(parent: HTMLElement, label: string, action: () => void, title = label) {
  const element = document.createElement("button"); element.type = "button"; element.textContent = label;
  element.title = title; element.onclick = action; parent.append(element); return element;
}
function field(parent: HTMLElement, label: string, value: string, change: (value: number) => void) {
  const wrapper = document.createElement("label"); wrapper.textContent = label;
  const input = document.createElement("input"); input.type = "number"; input.step = "any"; input.value = value;
  input.setAttribute("aria-label", label); input.onchange = () => { if (Number.isFinite(input.valueAsNumber)) change(input.valueAsNumber); };
  wrapper.append(input); parent.append(wrapper); return input;
}

export function mountAnimationEditors(store: SceneStore, options: EditorOptions) {
  let source: "time" | "driven" = "time";
  const graph = document.createElement("section"); graph.className = "animation-graph-wrapper"; graph.setAttribute("aria-label", "Animation Graph Editor");
  const sourceBar = document.createElement("div"); sourceBar.className = "animation-toolbar";
  const sourceLabel = document.createElement("label"); sourceLabel.textContent = "Graph source";
  const sourcePicker = document.createElement("select"); sourcePicker.setAttribute("aria-label", "Graph source");
  sourcePicker.add(new Option("Time animation", "time")); sourcePicker.add(new Option("Driven keys", "driven")); sourceLabel.append(sourcePicker); sourceBar.append(sourceLabel); graph.append(sourceBar);
  const time = mountCurveEditors(store, options, {
    kind: "time", tracks: editingTracks,
    copy: ids => copyKeys(store.getState().document, ids), paste: (clipboard, at) => pasteKeys(store, clipboard, at),
    remove: ids => deleteKeys(store, ids), insert: (id, at) => insertKey(store, id, at), upsert: track => upsertTrack(store, track),
    patch: (ids, patch) => patchKeys(store, ids, patch), replace: (tracks, label) => replaceTracks(store, tracks, label),
    move: (ids, dt, dv) => moveKeys(store, ids, dt, dv), scale: (ids, factor) => scaleKeys(store, ids, factor),
  }, () => source === "time");
  const driven = mountCurveEditors(store, options, {
    kind: "driven", tracks: drivenCurveTracks,
    copy: ids => copyDrivenCurveKeys(store.getState().document, ids), paste: (clipboard, at) => pasteDrivenCurveKeys(store, clipboard, at),
    remove: ids => deleteDrivenCurveKeys(store, ids), insert: (id, at) => insertDrivenCurveKey(store, id, at), upsert: track => replaceDrivenTracks(store, [track]),
    patch: (ids, patch) => patchDrivenCurveKeys(store, ids, patch), replace: (tracks, label) => replaceDrivenTracks(store, tracks, label),
    move: (ids, dt, dv) => moveDrivenCurveKeys(store, ids, dt, dv), scale: (ids, factor) => scaleDrivenCurveKeys(store, ids, factor),
  }, () => source === "driven");
  graph.append(time.graph, driven.graph); driven.graph.hidden = true;
  function switchSource(next: "time" | "driven") {
    time.cancelDrag(); driven.cancelDrag(); source = next; sourcePicker.value = next;
    time.graph.hidden = next !== "time"; driven.graph.hidden = next !== "driven";
    time.refresh(); driven.refresh();
  }
  sourcePicker.onchange = () => switchSource(sourcePicker.value as "time" | "driven");
  const layerLabel = document.createElement("span"); layerLabel.setAttribute("aria-label", "Graph animation layer"); sourceBar.append(layerLabel);
  function refresh() {
    const animation = store.getState().document.animation;
    layerLabel.textContent = source === "time" ? `Layer: ${animation?.layers?.find(layer => layer.id === animation.activeLayerId)?.name ?? "Base animation"}` : "";
    time.refresh(); driven.refresh();
  }
  store.subscribe(refresh);
  return { graph, dopeSheet: time.dopeSheet, refresh,
    focusTrack(id: string) { switchSource("time"); time.focusTrack(id); },
    focusDrivenRelationship(id: string) {
      const relation = store.getState().document.drivenKeys?.find(item => item.id === id); if (!relation) return;
      switchSource("driven"); options.onSelectTarget?.(relation.driven.targetId); driven.focusTrack(id);
    },
  };
}

/** One renderer for both curve domains; their commands, cursor, selection,
 * clipboard, and view remain independent. Only the time instance has a sheet. */
function mountCurveEditors<Clipboard>(store: SceneStore, options: EditorOptions, domain: CurveDomain<Clipboard>, graphVisible: () => boolean) {
  const isDriven = domain.kind === "driven", snap = (value: number) => isDriven ? value : Math.round(value);
  const axisName = isDriven ? "Driver value" : "Frame";
  const graph = document.createElement("section"); graph.className = "animation-editor";
  graph.setAttribute("aria-label", isDriven ? "Driven Key Graph Editor" : "Time Graph Editor");
  const dopeSheet = document.createElement("section"); dopeSheet.className = "animation-editor";
  dopeSheet.setAttribute("aria-label", "Animation Dope Sheet");
  const toolbar = document.createElement("div"); toolbar.className = "animation-toolbar"; graph.append(toolbar);
  const keyFields = document.createElement("div"); keyFields.className = "animation-key-fields"; graph.append(keyFields);
  const blendHelp = document.createElement("div"); blendHelp.className = "animation-channel-help"; blendHelp.hidden = true;
  blendHelp.textContent = "IK blend: 0 = FK, 1 = IK. Keys must be 0–1; tangent overshoot is shown here but clamped during playback."; graph.append(blendHelp);
  const body = document.createElement("div"); body.className = "animation-graph-body"; graph.append(body);
  const channelList = document.createElement("div"); channelList.className = "animation-channel-list";
  channelList.setAttribute("aria-label", isDriven ? "Driven relationships" : "Animation channels"); body.append(channelList);
  const surface = document.createElement("div"); surface.className = "animation-graph-surface"; body.append(surface);
  const svg = svgElement("svg", { tabindex: 0, role: "application", "aria-label": `${isDriven ? "Driven response" : "Animation"} curves. Drag keys or tangent handles; drag empty space to box select; wheel to zoom; Alt-drag to pan.` }); surface.append(svg);
  const status = document.createElement("div"); status.className = "animation-status"; status.setAttribute("role", "status"); graph.append(status);
  const dopeToolbar = document.createElement("div"); dopeToolbar.className = "animation-toolbar"; dopeSheet.append(dopeToolbar);
  const dopeBlendHelp = blendHelp.cloneNode(true) as HTMLDivElement; dopeSheet.append(dopeBlendHelp);
  const dopeScroll = document.createElement("div"); dopeScroll.className = "animation-dope-scroll"; dopeSheet.append(dopeScroll);
  const dopeSvg = svgElement("svg", { tabindex: 0, role: "application", "aria-label": "Dope Sheet keys. Shift-click or box select keys across channels; drag to retime." }); dopeScroll.append(dopeSvg);
  const dopeStatus = document.createElement("div"); dopeStatus.className = "animation-status"; dopeStatus.textContent = "Drag keys to retime · Shift-click to add · drag blank rows to box select"; dopeSheet.append(dopeStatus);

  let selected = new Set<string>(), activeTrack = "", selectedObjectsOnly = false, isolatedTrack = "";
  let clipboard: Clipboard | undefined, previewTracks: AnimationTrack[] | undefined, drag: Drag | undefined;
  let manualCursor: number | undefined, sceneDriver: number | undefined, driverError = "";
  let driverInput: HTMLInputElement | undefined, driverReadout: HTMLOutputElement | undefined;
  let cachedTracksDoc: SceneDocument | undefined, cachedTracks: AnimationTrack[] = [];
  let fallbackDoc: SceneDocument | undefined, fallbackFrame = NaN, fallbackPoses: ReadonlyMap<string, AnimationPose> | undefined;
  let view: View = { minTime: 0, maxTime: 288, minValue: -1, maxValue: 1 };
  let graphWidth = 600, graphHeight = 200, dopeWidth = 800;
  let lastDocument = store.getState().document, lastSelection = "", lastEditorState = "";
  let renderedDocument: typeof lastDocument | undefined;
  const sourceTracks = () => {
    const doc = store.getState().document;
    if (cachedTracksDoc !== doc) { cachedTracksDoc = doc; cachedTracks = domain.tracks(doc); }
    return cachedTracks;
  };
  const animation = () => ({ ...(store.getState().document.animation ?? defaultAnimation()), ...(isDriven ? { start: 0, end: 1 } : {}), tracks: sourceTracks() });
  const tracks = () => previewTracks ?? animation().tracks;
  const visibleTracks = () => {
    const objectIds = new Set(options.getSelection());
    const relationships = new Map((store.getState().document.drivenKeys ?? []).map(relation => [relation.id, relation]));
    return tracks().filter(track => (!isolatedTrack || track.id === isolatedTrack) && (!selectedObjectsOnly || objectIds.has(track.targetId)
      || (isDriven && objectIds.has(relationships.get(track.id)?.driver.targetId ?? ""))));
  };
  const objectName = (id: string) => {
    const doc = store.getState().document; return doc.nodes[id]?.name ?? doc.joints?.find(j => j.id === id)?.name ?? doc.ikHandles?.find(handle => handle.id === id)?.name ?? id;
  };
  const channelName = (track: AnimationTrack) => track.channel === "ik.blend" ? "IK blend" : channelLabel(store.getState().document, track.targetId, track.channel) + (isCustomChannel(track.channel) ? ` (${attributeTypeLabel(customAttribute(store.getState().document, track.targetId, track.channel))})` : "");
  function trackLabel(track: AnimationTrack) {
    const relation = isDriven ? store.getState().document.drivenKeys?.find(item => item.id === track.id) : undefined;
    return relation ? `${objectName(relation.driver.targetId)}.${channelLabel(store.getState().document, relation.driver.targetId, relation.driver.channel)} → ${objectName(relation.driven.targetId)}.${channelLabel(store.getState().document, relation.driven.targetId, relation.driven.channel)}`
      : `${objectName(track.targetId)} · ${channelName(track)}`;
  }
  function activate(id: string) { if (isDriven && activeTrack !== id) manualCursor = undefined; activeTrack = id; }
  function selectTrack(track: AnimationTrack) { activate(track.id); options.onSelectTarget?.(track.targetId); refresh(); }
  function updateDriver() {
    if (!isDriven) return;
    sceneDriver = undefined; driverError = "";
    const doc = store.getState().document, relation = doc.drivenKeys?.find(item => item.id === activeTrack);
    if (relation) try {
      let poses = options.getDrivenPoses?.();
      if (!poses) {
        const frame = options.getFrame();
        if (fallbackDoc !== doc || fallbackFrame !== frame) {
          const evaluated = evaluateSceneAnimation(doc, frame); evaluateDrivenKeys(doc, evaluated);
          fallbackDoc = doc; fallbackFrame = frame; fallbackPoses = evaluated;
        }
        poses = fallbackPoses;
      }
      const pose = poses?.get(relation.driver.targetId); if (!pose) throw Error("Driver pose unavailable");
      const value = readChannel(pose, relation.driver.channel); if (!Number.isFinite(value)) throw Error("Driver value is not finite");
      sceneDriver = value;
    } catch (error) { driverError = error instanceof Error ? error.message : String(error); }
    if (driverInput && document.activeElement !== driverInput) driverInput.value = String(manualCursor ?? sceneDriver ?? 0);
    if (driverReadout) driverReadout.textContent = sceneDriver === undefined ? driverError || "Select a driven relationship" : `Scene driver: ${labelValue(sceneDriver)}${manualCursor === undefined ? " · following" : ""}`;
  }
  const cursor = () => isDriven ? manualCursor ?? sceneDriver ?? 0 : options.getFrame();
  function setCursor(value: number) {
    if (isDriven) {
      if (!Number.isFinite(value) || Math.abs(value) > 1e6) { announce("Driver cursor must be finite and within ±1,000,000.", true); return; }
      manualCursor = value;
    } else options.setFrame(snap(value));
  }
  const steppedVisibility = (track: AnimationTrack) => !isDriven && track.channel === "visibility";
  const layerTrack = (track: AnimationTrack) => !isDriven && track.layerId !== undefined;
  const keyEntries = () => tracks().flatMap(track => track.keys.filter(key => selected.has(key.id)).map(key => ({ track, key })));
  const colorFor = (track: AnimationTrack) => colors[Math.max(0, animation().tracks.findIndex(t => t.id === track.id)) % colors.length];
  const plot = (sheet = false) => ({ left: sheet ? 190 : 54, right: (sheet ? dopeWidth : graphWidth) - 16, top: 24, bottom: graphHeight - 30 });
  const x = (time: number, sheet = false) => { const p = plot(sheet); return p.left + (time - view.minTime) / (view.maxTime - view.minTime) * (p.right - p.left); };
  const y = (value: number) => { const p = plot(); return p.bottom - (value - view.minValue) / (view.maxValue - view.minValue) * (p.bottom - p.top); };
  const atTime = (pixel: number, sheet = false) => { const p = plot(sheet); return view.minTime + (pixel - p.left) / (p.right - p.left) * (view.maxTime - view.minTime); };
  const atValue = (pixel: number) => { const p = plot(); return view.minValue + (p.bottom - pixel) / (p.bottom - p.top) * (view.maxValue - view.minValue); };
  const point = (event: PointerEvent | WheelEvent, sheet: boolean): Point => {
    const rect = (sheet ? dopeSvg : svg).getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  function announce(message: string, error = false) {
    status.textContent = message; status.classList.toggle("error", error);
    dopeStatus.textContent = message; dopeStatus.classList.toggle("error", error);
  }
  function edit(action: () => void) {
    if (!options.available()) { announce("Finish the current operation before editing animation.", true); return; }
    try { action(); announce(`${selected.size} key${selected.size === 1 ? "" : "s"} selected · drag keys / handles · wheel zoom · Alt-drag pan`); }
    catch (error) { announce(error instanceof Error ? error.message : String(error), true); }
    refresh();
  }
  function fit(selectionOnly = false) {
    const keys = visibleTracks().flatMap(t => t.keys).filter(key => !selectionOnly || selected.has(key.id));
    const a = animation();
    let minTime = keys.length ? Math.min(...keys.map(k => k.time)) : a.start;
    let maxTime = keys.length ? Math.max(...keys.map(k => k.time)) : a.end;
    let minValue = keys.length ? Math.min(...keys.map(k => k.value)) : -1;
    let maxValue = keys.length ? Math.max(...keys.map(k => k.value)) : 1;
    // Include curve overshoot so Frame All does not clip spline extrema.
    if (!selectionOnly) for (const track of visibleTracks()) for (let i = 0; i < 80; i++) {
      const value = evaluateCurve(track.keys, minTime + (maxTime - minTime) * i / 79);
      if (value !== undefined) { minValue = Math.min(minValue, value); maxValue = Math.max(maxValue, value); }
    }
    const dt = Math.max(isDriven ? 1e-6 : 5, maxTime - minTime), dv = Math.max(.2, maxValue - minValue);
    view = { minTime: minTime - dt * .08, maxTime: maxTime + dt * .08, minValue: minValue - dv * .15, maxValue: maxValue + dv * .15 };
    refresh();
  }
  function copy() { clipboard = domain.copy(selected); announce(`Copied ${selected.size} keys. Paste starts at the ${isDriven ? "driver cursor" : "current frame"}.`); }
  function paste() { if (clipboard) edit(() => { if (isDriven && manualCursor === undefined && sceneDriver === undefined) throw Error("Select a relationship with an available driver, or set the Driver cursor."); selected = new Set(domain.paste(clipboard!, snap(cursor()))); }); }
  function remove() { edit(() => { domain.remove(selected); selected.clear(); }); }
  function insert(time = snap(cursor()), value?: number) {
    const track = animation().tracks.find(t => t.id === activeTrack);
    if (isDriven && (!track || (manualCursor === undefined && sceneDriver === undefined && value === undefined))) {
      announce(track ? "Set the Driver cursor before inserting a key." : "Create a relationship in Set Driven Key, then select it here.", true); return;
    }
    if (!track) {
      const doc = store.getState().document, ids = new Set(options.getSelection());
      const handles = (doc.ikHandles ?? []).filter(handle => ids.has(handle.id));
      if (value === undefined && handles.length === 1) {
        edit(() => {
          const id = handles[0].id;
          if (!channelsForTarget(doc, id).includes("ik.blend")) throw Error("Select an IK handle to key its blend.");
          setKeys(store, [id], time, undefined, ["ik.blend"]);
          const created = animation().tracks.find(item => item.targetId === id && item.channel === "ik.blend")!;
          activeTrack = created.id; selected = new Set(created.keys.filter(key => key.time === time).map(key => key.id));
        });
      } else announce("Set a key in the Timeline or IK Handles first, then select its channel. A selected IK handle can start its blend curve with Insert key.", true);
      return;
    }
    if(value===undefined){
      edit(()=>{selected=new Set([domain.insert(track.id,time)]);});
      return;
    }
    const existing = track.keys.find(key => key.time === time);
    const key: CurveKey = { id: existing?.id ?? crypto.randomUUID(), time, value, interpolation: existing?.interpolation ?? "bezier", tangentMode: existing?.tangentMode ?? "auto" };
    edit(() => { domain.upsert({ ...track, keys: [...track.keys.filter(k => k.time !== time), key].sort((a,b) => a.time-b.time) }); selected = new Set([key.id]); });
  }
  button(toolbar, "Insert key", () => insert(), `Insert a key at the ${isDriven ? "driver cursor" : "current frame"} while preserving the curve shape. Double-click the graph to author a different coordinate/value.`);
  button(toolbar, "Delete", remove, "Delete selected keys");
  button(toolbar, "Copy", copy); button(toolbar, "Paste", paste);
  button(toolbar, "Frame all", () => fit()); button(toolbar, "Frame selected", () => fit(true));
  const selectionLabel = document.createElement("label"), selectionCheckbox = document.createElement("input");
  selectionCheckbox.type = "checkbox"; selectionLabel.append(selectionCheckbox, "Selected targets"); selectionCheckbox.title = isDriven ? "Show relationships whose driver or driven object is selected" : "Show selected objects, joints, and IK handles"; toolbar.append(selectionLabel);
  selectionCheckbox.onchange = () => { isolatedTrack = ""; selectedObjectsOnly = selectionCheckbox.checked; refresh(); };
  if (isDriven) {
    button(toolbar, "Show all relationships", () => { isolatedTrack = ""; selectedObjectsOnly = false; selectionCheckbox.checked = false; refresh(); });
    let driverScale = 1;
    const driverScaleInput = field(toolbar, "Driver scale", "1", value => { driverScale = value; });
    driverScaleInput.min = ".001";
    button(toolbar, "Scale driver values", () => edit(() => domain.scale(selected, driverScale)), "Scale selected coordinates around the earliest selected driver value; preserve fractional values");
    const driverBar = document.createElement("div"); driverBar.className = "animation-toolbar animation-driver-controls"; graph.insertBefore(driverBar, keyFields);
    driverInput = field(driverBar, "Driver cursor", "0", value => { setCursor(value); refresh(); });
    button(driverBar, "Use scene driver", () => { manualCursor = undefined; refresh(); });
    driverReadout = document.createElement("output"); driverReadout.setAttribute("aria-label", "Current scene driver value"); driverBar.append(driverReadout);
    const guide = document.createElement("div"); guide.className = "animation-channel-help";
    guide.textContent = "Driver cursor only chooses where to insert or paste keys; it does not change scene time or the driver. Fractional driver values are preserved."; graph.insertBefore(guide, body);
  }
  const interpolation = document.createElement("select"); interpolation.setAttribute("aria-label", "Key interpolation");
  for (const [value, label] of [["bezier", "Bezier"], ["linear", "Linear"], ["step", "Stepped"]]) interpolation.add(new Option(label, value));
  interpolation.onchange = () => edit(() => domain.patch(selected, { interpolation: interpolation.value as CurveKey["interpolation"] })); keyFields.append(interpolation);
  const tangents = document.createElement("select"); tangents.setAttribute("aria-label", "Tangent preset");
  for (const value of ["auto", "clamped", "spline", "flat", "fixed"]) tangents.add(new Option(`${value[0].toUpperCase()}${value.slice(1)} tangents`, value));
  tangents.onchange = () => edit(() => {
    if(tangents.value!=="fixed")domain.patch(selected, { tangentMode: tangents.value as CurveKey["tangentMode"], interpolation: "bezier" });
    else domain.replace(animation().tracks.map(track=>({...track,keys:track.keys.map((key,index)=>selected.has(key.id)?{...key,tangentMode:"fixed" as const,interpolation:"bezier" as const,inSlope:tangentSlope(track.keys,index,"in"),outSlope:tangentSlope(track.keys,index,"out")}:key)})),"Fix tangent slopes");
  }); keyFields.append(tangents);
  const keyTime = field(keyFields, axisName, "0", value => edit(() => domain.patch(selected, { time: snap(value) })));
  const keyValue = field(keyFields, "Value", "0", value => edit(() => domain.patch(selected, { value })));
  function setSlope(side:"in"|"out",value:number){
    edit(()=>domain.replace(animation().tracks.map(track=>({...track,keys:track.keys.map((key,index)=>selected.has(key.id)?withTangent(track.keys,index,side,value):key)})),"Edit tangent slope"));
  }
  const inSlope = field(keyFields, "In slope", "0", value => setSlope("in",value));
  const outSlope = field(keyFields, "Out slope", "0", value => setSlope("out",value));
  const brokenLabel = document.createElement("label"), broken = document.createElement("input"); broken.type = "checkbox"; brokenLabel.append(broken, "Break tangents"); keyFields.append(brokenLabel);
  broken.onchange = () => edit(() => {
    const entries = keyEntries();
    domain.replace(animation().tracks.map(track => ({ ...track, keys: track.keys.map((key,index) => selected.has(key.id) ? { ...key, broken: broken.checked, ...(!broken.checked ? { tangentMode: "fixed" as const, inSlope: tangentSlope(track.keys,index,"out"), outSlope: tangentSlope(track.keys,index,"out") } : {}) } : key) })), "Link or break tangents");
    if (!entries.length) announce("Select keys to edit tangents.");
  });
  const inWeight = field(keyFields, "In weight", "0.333", value => edit(() => domain.patch(selected, { inWeight: value, interpolation:"bezier" })));
  const outWeight = field(keyFields, "Out weight", "0.333", value => edit(() => domain.patch(selected, { outWeight: value, interpolation:"bezier" })));
  for (const weight of [inWeight, outWeight]) { weight.min = "0"; weight.max = "1"; weight.step = ".01"; weight.title = "Handle length as a fraction of the adjacent key interval; 1/3 is unweighted"; }
  button(keyFields, "Unweight", () => edit(() => domain.patch(selected, { inWeight: 1/3, outWeight: 1/3 })), "Reset tangent handle lengths to one third of their key intervals");

  button(dopeToolbar, "Delete keys", remove); button(dopeToolbar, "Copy keys", copy); button(dopeToolbar, "Paste keys", paste);
  button(dopeToolbar, "Frame all", () => fit()); button(dopeToolbar, "Frame selected", () => fit(true));
  let shiftAmount = 1, scaleAmount = 1;
  field(dopeToolbar, "Shift frames", "1", value => { shiftAmount = Math.round(value); });
  button(dopeToolbar, "Shift", () => edit(() => domain.move(selected, shiftAmount, 0)));
  const scaleField = field(dopeToolbar, "Time scale", "1", value => { scaleAmount = value; }); scaleField.min = ".001"; scaleField.step = ".1";
  button(dopeToolbar, "Scale time", () => edit(() => {
    domain.scale(selected, scaleAmount);
  }), "Scale selected key times around the earliest selected frame; snap to whole frames");

  function renderChannels() {
    const list = visibleTracks();
    if (!list.some(track => track.id === activeTrack)) activate(list[0]?.id ?? "");
    const focusedTrack=channelList.contains(document.activeElement)?(document.activeElement as HTMLElement).dataset.trackId:undefined;
    channelList.replaceChildren();
    if (!list.length) { const note = document.createElement("div"); note.className = "animation-empty"; note.textContent = isDriven ? "Create relationships in Set Driven Key, then edit their response curves here." : "Set keys in the Timeline or IK Handles to create curves. Object, joint, and IK blend channels appear here. Select an IK handle and Insert key to start its blend curve."; channelList.append(note); }
    for (const track of list) {
      const entry = button(channelList, "", () => selectTrack(track), `${objectName(track.targetId)} · ${channelName(track)} (${track.channel})`);
      entry.dataset.trackId=track.id; entry.dataset.targetId = track.targetId;
      entry.setAttribute("aria-pressed", String(activeTrack === track.id));
      const name = document.createElement("span"); name.className = "channel-object"; name.textContent = isDriven ? trackLabel(track) : objectName(track.targetId);
      const dot = document.createElement("span"); dot.className = "channel-color"; dot.style.background = colorFor(track);
      entry.append(name, dot, channelName(track));
    }
    if(focusedTrack)Array.from(channelList.querySelectorAll<HTMLButtonElement>("button")).find(entry=>entry.dataset.trackId===focusedTrack)?.focus();
  }
  function updateFields() {
    const entries = keyEntries(), entry = entries[0], key = entry?.key;
    const active = animation().tracks.find(track => track.id === activeTrack);
    const rawLayer = !!active && layerTrack(active);
    const layerHelp = "Raw layer values: additive position/rotation are offsets; additive scale is a factor; override values are blend targets. Visibility and IK blend clamp to 0-1, and scale to at least 0.001, after the stack is mixed.";
    const baseHelp = "IK blend: 0 = FK, 1 = IK. Keys must be 0-1; tangent overshoot is shown here but clamped during playback.";
    blendHelp.textContent = rawLayer ? layerHelp : baseHelp;
    blendHelp.hidden = !rawLayer && active?.channel !== "ik.blend" && !entries.some(item => item.track.channel === "ik.blend");
    const dopeLayer = visibleTracks().some(layerTrack);
    dopeBlendHelp.textContent = dopeLayer ? layerHelp : baseHelp;
    dopeBlendHelp.hidden = !dopeLayer && !visibleTracks().some(track => track.channel === "ik.blend");
    if (entry?.track.channel === "ik.blend" && !layerTrack(entry.track)) { keyValue.min = "0"; keyValue.max = "1"; keyValue.step = ".01"; keyValue.title = "IK blend key: 0 = FK, 1 = IK. Playback clamps tangent overshoot."; }
    else { keyValue.removeAttribute("min"); keyValue.removeAttribute("max"); keyValue.step = "any"; keyValue.title = entry && layerTrack(entry.track) ? "Raw layer key value before weight and stack mixing" : "Selected key value"; }
    const hasVisibility=entries.some(item=>steppedVisibility(item.track));
    interpolation.disabled = tangents.disabled = !key||hasVisibility;
    for (const input of [keyTime, keyValue, inSlope, outSlope, inWeight, outWeight, broken]) input.disabled = entries.length !== 1;
    if(hasVisibility)for(const input of [inSlope,outSlope,inWeight,outWeight,broken])input.disabled=true;
    if (!entry) return;
    const index = entry.track.keys.findIndex(k => k.id === key.id);
    if (document.activeElement !== interpolation) interpolation.value = hasVisibility ? "step" : key.interpolation;
    if (document.activeElement !== tangents) tangents.value = key.tangentMode;
    for (const [input,value] of [[keyTime,key.time],[keyValue,key.value],[inSlope,tangentSlope(entry.track.keys,index,"in")],[outSlope,tangentSlope(entry.track.keys,index,"out")],[inWeight,key.inWeight ?? 1/3],[outWeight,key.outWeight ?? 1/3]] as const)
      if (document.activeElement !== input) input.value = String(value);
    broken.checked = key.broken ?? false;
  }
  function timeGrid(target: SVGSVGElement, sheet = false, height = graphHeight) {
    const p = plot(sheet), step = niceStep(view.maxTime-view.minTime, Math.max(2,(p.right-p.left)/80));
    for (let time = Math.ceil(view.minTime/step)*step, n=0; time <= view.maxTime && n++<100; time+=step) {
      target.append(svgElement("line", { x1:x(time,sheet), y1:24, x2:x(time,sheet), y2:height- (sheet ? 0 : 30), class:"animation-grid" }));
      target.append(textSvg(x(time,sheet)+3, 15, labelValue(time)));
    }
    target.append(textSvg(sheet ? 8 : 5, 15, axisName));
  }
  function keyMark(target: SVGElement, key: CurveKey, px: number, py: number, color: string) {
    const keyNode = svgElement("rect", { x:px-4, y:py-4, width:8, height:8, rx:1, fill:color, transform:`rotate(45 ${px} ${py})`, class:`animation-key${selected.has(key.id) ? " selected" : ""}`, "data-key":key.id });
    const title = svgElement("title"); title.textContent = `${axisName} ${key.time}: ${labelValue(key.value)}`; keyNode.append(title); target.append(keyNode);
  }
  function tangentPoint(track: AnimationTrack, index: number, side: "in" | "out") {
    const key = track.keys[index], other = track.keys[index + (side === "in" ? -1 : 1)];
    const duration = other ? Math.abs(key.time-other.time) : (view.maxTime-view.minTime)/8;
    const weight = (side === "in" ? key.inWeight : key.outWeight) ?? 1/3;
    const dt = duration*weight*(side === "in" ? -1 : 1), slope = tangentSlope(track.keys,index,side);
    return { time:key.time+dt, value:key.value+dt*slope, duration };
  }
  function draw() {
    graphWidth = Math.max(180, surface.clientWidth || 600); graphHeight = Math.max(130, surface.clientHeight || 220);
    svg.setAttribute("viewBox", `0 0 ${graphWidth} ${graphHeight}`); svg.replaceChildren();
    const p = plot(); timeGrid(svg);
    const valueStep = niceStep(view.maxValue-view.minValue, Math.max(2,(p.bottom-p.top)/40));
    for (let value=Math.ceil(view.minValue/valueStep)*valueStep,n=0; value <= view.maxValue && n++<100; value+=valueStep) {
      svg.append(svgElement("line",{ x1:p.left,y1:y(value),x2:p.right,y2:y(value),class:"animation-grid" }));
      svg.append(textSvg(3,y(value)+3,labelValue(value)));
    }
    svg.append(textSvg(p.left,graphHeight-8,isDriven ? "Value / degrees · fractional driver coordinates" : "Value / degrees · frame snapping"));
    const defs = svgElement("defs"), clip = svgElement("clipPath",{id:`animation-graph-clip-${domain.kind}`});
    clip.append(svgElement("rect",{x:p.left,y:p.top,width:p.right-p.left,height:p.bottom-p.top})); defs.append(clip); svg.append(defs);
    const content = svgElement("g",{"clip-path":`url(#animation-graph-clip-${domain.kind})`}); svg.append(content);
    const list = visibleTracks();
    for (const track of [...list.filter(t=>t.id!==activeTrack),...list.filter(t=>t.id===activeTrack)]) {
      if (!track.keys.length) continue;
      const color = colorFor(track), opacity = track.id===activeTrack ? 1 : .48;
      const curveKeys=steppedVisibility(track)?track.keys.map(key=>({...key,interpolation:"step" as const})):track.keys;
      let d = "";
      const append = (time:number,value:number) => { d += `${d ? "L" : "M"}${x(time).toFixed(2)},${y(value).toFixed(2)} `; };
      append(view.minTime,evaluateCurve(curveKeys,view.minTime)!);
      for(let i=0;i<track.keys.length-1;i++) {
        const key=track.keys[i],next=track.keys[i+1];
        if(next.time<view.minTime || key.time>view.maxTime)continue;
        const from=Math.max(key.time,view.minTime),to=Math.min(next.time,view.maxTime);
        if(key.interpolation==="step"||steppedVisibility(track)) { append(from,key.value);append(to,key.value);if(next.time<=view.maxTime)append(next.time,next.value); }
        else {
          const count=key.interpolation==="linear" ? 1 : Math.min(80,Math.max(8,Math.ceil((x(to)-x(from))/6)));
          for(let sample=0;sample<=count;sample++){const time=from+(to-from)*sample/count;append(time,evaluateCurve(track.keys,time)!);}
        }
      }
      append(view.maxTime,evaluateCurve(curveKeys,view.maxTime)!);
      content.append(svgElement("path",{d,fill:"none",stroke:color,"stroke-width":track.id===activeTrack ? 1.8 : 1.2,opacity}));
      for (let index=0;index<track.keys.length;index++) {
        const key=track.keys[index]; if(key.time<view.minTime || key.time>view.maxTime)continue;
        if(selected.has(key.id) && key.interpolation==="bezier" && !steppedVisibility(track)) for(const side of ["in","out"] as const) {
          const handle=tangentPoint(track,index,side);
          content.append(svgElement("line",{x1:x(key.time),y1:y(key.value),x2:x(handle.time),y2:y(handle.value),class:"animation-tangent-line"}));
          const circle=svgElement("circle",{cx:x(handle.time),cy:y(handle.value),r:4,class:"animation-tangent-handle","data-tangent":key.id,"data-side":side});
          const title=svgElement("title");title.textContent=`${side} tangent; drag to edit slope and weight`;circle.append(title);content.append(circle);
        }
        keyMark(content,key,x(key.time),y(key.value),color);
      }
    }
    content.append(svgElement("line",{x1:x(cursor()),x2:x(cursor()),y1:p.top,y2:p.bottom,class:"animation-playhead"}));
    if(drag?.kind==="box"&&!drag.sheet) drawBox(svg,drag);
    if (!isDriven) drawDope();
  }
  function drawBox(target: SVGSVGElement, box: Drag) {
    target.append(svgElement("rect",{x:Math.min(box.start.x,box.current.x),y:Math.min(box.start.y,box.current.y),width:Math.abs(box.current.x-box.start.x),height:Math.abs(box.current.y-box.start.y),class:"animation-box"}));
  }
  function drawDope() {
    dopeWidth=Math.max(350,dopeScroll.clientWidth || 800);const list=visibleTracks(),height=Math.max(100,32+list.length*26);
    dopeSvg.setAttribute("viewBox",`0 0 ${dopeWidth} ${height}`);dopeSvg.style.height=`${height}px`;dopeSvg.replaceChildren();
    list.forEach((track,row)=>dopeSvg.append(svgElement("rect",{x:0,y:24+row*26,width:dopeWidth,height:26,class:"dope-row"})));
    timeGrid(dopeSvg,true,height);
    list.forEach((track,row)=>{
      const cy=37+row*26;
      const label = `${objectName(track.targetId)} · ${channelName(track)}`;
      const name=textSvg(8,cy+3,label,"dope-name");
      const title=svgElement("title");title.textContent=`${label} (${track.channel})`;name.append(title);
      // Clip long labels to preserve the time grid.
      const labelSvg=svgElement("svg",{x:0,y:24+row*26,width:184,height:26,tabindex:0,role:"button","aria-label":`Select ${label}`,"data-track-label":track.id,"data-target-id":track.targetId});name.setAttribute("y","16");labelSvg.append(name);dopeSvg.append(labelSvg);
      labelSvg.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); selectTrack(track); } });
      for(const key of track.keys)if(x(key.time,true)>=190&&x(key.time,true)<=dopeWidth-16)keyMark(dopeSvg,key,x(key.time,true),cy,colorFor(track));
    });
    if(!list.length)dopeSvg.append(textSvg(12,55,"No tracks. Set object/joint keys in the Timeline or blend keys in IK Handles."));
    const px=x(options.getFrame(),true);dopeSvg.append(svgElement("line",{x1:px,x2:px,y1:24,y2:height,class:"animation-playhead",visibility:px>=190&&px<=dopeWidth-16?"visible":"hidden"}));
    if(drag?.kind==="box"&&drag.sheet)drawBox(dopeSvg,drag);
  }

  function bindPointer(target: SVGSVGElement, sheet: boolean) {
    target.addEventListener("contextmenu",event=>event.preventDefault());
    target.addEventListener("pointerdown",event=>{
      if(event.button!==0&&event.button!==1)return;
      event.preventDefault();event.stopPropagation();target.focus();
      const start=point(event,sheet),node=event.target as Element,keyId=node.getAttribute("data-key") ?? node.getAttribute("data-tangent") ?? undefined;
      const isPan=event.altKey||event.button===1;
      const labelTrack = node.closest("[data-track-label]")?.getAttribute("data-track-label");
      if (sheet && labelTrack && !isPan) { const track = tracks().find(item => item.id === labelTrack); if (track) selectTrack(track); return; }
      if(keyId&&!isPan){
        const track=tracks().find(t=>t.keys.some(k=>k.id===keyId));if(track)activate(track.id);
        if(event.shiftKey&&selected.has(keyId)&&!node.hasAttribute("data-tangent")){selected.delete(keyId);refresh();return;}
        if(!selected.has(keyId)){if(!event.shiftKey)selected.clear();selected.add(keyId);}
      }
      const kind=isPan?"pan":node.hasAttribute("data-tangent")?"tangent":keyId?"key":start.y<24?"scrub":"box";
      if((kind==="key"||kind==="tangent")&&!options.available()){announce("Finish the current operation before editing animation.",true);refresh();return;}
      drag={kind,start,current:start,view:{...view},tracks:animation().tracks,keyId,side:(node.getAttribute("data-side")??"out") as "in"|"out",additive:event.shiftKey,sheet,pointerId:event.pointerId};
      target.setPointerCapture(event.pointerId);
      if(kind==="scrub")setCursor(atTime(start.x,sheet));
      refresh();
    });
    target.addEventListener("pointermove",event=>{
      if(!drag||drag.sheet!==sheet)return;
      drag.current=point(event,sheet);
      const dx=drag.current.x-drag.start.x,dy=drag.current.y-drag.start.y;
      if(drag.kind==="pan"){
        const p=plot(sheet),dt=dx/(p.right-p.left)*(drag.view.maxTime-drag.view.minTime),dv=dy/(p.bottom-p.top)*(drag.view.maxValue-drag.view.minValue);
        view={minTime:drag.view.minTime-dt,maxTime:drag.view.maxTime-dt,minValue:drag.view.minValue+(sheet?0:dv),maxValue:drag.view.maxValue+(sheet?0:dv)};
      } else if(drag.kind==="key"){
        const dt=snap(atTime(drag.current.x,sheet)-atTime(drag.start.x,sheet)),dv=sheet?0:atValue(drag.current.y)-atValue(drag.start.y);
        const next=drag.tracks.map(track=>({...track,keys:track.keys.map(key=>selected.has(key.id)?{...key,time:key.time+dt,value:key.value+dv}:key).sort((a,b)=>a.time-b.time)}));
        try {
          for (const track of next) {
            validateCurveKeys(track.keys);
            // Layer keys are raw contributions; only the mixed result is clamped.
            if (layerTrack(track)) continue;
            if ((track.channel === "ik.blend" || track.channel === "visibility") && track.keys.some(key => key.value < 0 || key.value > 1))
              throw Error("Blend and visibility keys must be between 0 and 1.");
            if (track.channel.startsWith("scale.") && track.keys.some(key => key.value < .001))
              throw Error("Scale keys must be at least 0.001.");
          }
          previewTracks=next;
        }
        catch { previewTracks=undefined;announce("This move would overlap key times or exceed the supported range.",true); }
      } else if(drag.kind==="tangent"){
        const track=drag.tracks.find(t=>t.keys.some(k=>k.id===drag!.keyId));
        if(track){
          const index=track.keys.findIndex(k=>k.id===drag!.keyId),key=track.keys[index],side=drag.side!,sign=side==="in"?-1:1,handle=tangentPoint(track,index,side);
          const dt=Math.min(handle.duration,Math.max(handle.duration*.001,(atTime(drag.current.x)-key.time)*sign))*sign;
          const slope=(atValue(drag.current.y)-key.value)/dt;
          try {
            const edited=withTangent(track.keys,index,side,slope,Math.abs(dt)/handle.duration);
            previewTracks=drag.tracks.map(t=>t.id===track.id?{...t,keys:t.keys.map(k=>k.id===key.id?edited:k)}:t);
          } catch { previewTracks=undefined;announce("Tangent exceeds the supported range.",true); }
        }
      } else if(drag.kind==="scrub")setCursor(atTime(drag.current.x,sheet));
      updateDriver();draw();updateFields();
    });
    const finish=(event:PointerEvent,cancel=false)=>{
      if(!drag||drag.sheet!==sheet)return;
      const completed=drag,preview=previewTracks;drag=undefined;previewTracks=undefined;
      if(target.hasPointerCapture(event.pointerId))target.releasePointerCapture(event.pointerId);
      if(!cancel&&completed.kind==="box"){
        if(!completed.additive)selected.clear();
        const lowX=Math.min(completed.start.x,completed.current.x),highX=Math.max(completed.start.x,completed.current.x),lowY=Math.min(completed.start.y,completed.current.y),highY=Math.max(completed.start.y,completed.current.y);
        const p=plot(sheet);
        visibleTracks().forEach((track,row)=>track.keys.forEach(key=>{const px=x(key.time,sheet),py=sheet?37+row*26:y(key.value);if(px>=p.left&&px<=p.right&&px>=lowX&&px<=highX&&py>=lowY&&py<=highY)selected.add(key.id);}));
        announce(`${selected.size} keys selected.`);
      } else if(!cancel&&preview&&(completed.kind==="key"||completed.kind==="tangent"))edit(()=>{
        if(completed.kind==="key")domain.move(selected,snap(atTime(completed.current.x,sheet)-atTime(completed.start.x,sheet)),sheet?0:atValue(completed.current.y)-atValue(completed.start.y));
        else domain.replace(preview,"Edit tangent handle");
      });
      refresh();
    };
    target.addEventListener("pointerup",event=>finish(event));target.addEventListener("pointercancel",event=>finish(event,true));
    target.addEventListener("dblclick",event=>{
      if(sheet||(event.target as Element).hasAttribute("data-key"))return;
      const rect=target.getBoundingClientRect();insert(snap(atTime(event.clientX-rect.left)),atValue(event.clientY-rect.top));
    });
    target.addEventListener("wheel",event=>{
      event.preventDefault();const cursor=point(event,sheet),anchorTime=atTime(cursor.x,sheet),anchorValue=atValue(cursor.y),factor=Math.exp(Math.max(-.5,Math.min(.5,event.deltaY*.0015)));
      if(event.shiftKey){const delta=(view.maxTime-view.minTime)*event.deltaY*.001;view.minTime+=delta;view.maxTime+=delta;}
      else if((view.maxTime-view.minTime)*factor>=(isDriven ? 1e-8 : .2)&&(view.maxTime-view.minTime)*factor<=1e7){
        view={minTime:anchorTime+(view.minTime-anchorTime)*factor,maxTime:anchorTime+(view.maxTime-anchorTime)*factor,minValue:sheet?view.minValue:anchorValue+(view.minValue-anchorValue)*factor,maxValue:sheet?view.maxValue:anchorValue+(view.maxValue-anchorValue)*factor};
      }draw();
    },{passive:false});
  }
  bindPointer(svg,false);if (!isDriven) bindPointer(dopeSvg,true);
  for(const editor of [graph,dopeSheet])editor.addEventListener("keydown",event=>{
    if (editor === graph && !graphVisible()) return;
    const target=event.target as HTMLElement;
    if(target.matches("input,select,textarea")){if(event.key==="Enter"){event.preventDefault();target.blur();}return;}
    const mod=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
    if(mod&&key==="c"){event.preventDefault();copy();}
    else if(mod&&key==="v"){event.preventDefault();paste();}
    else if(mod&&key==="a"){event.preventDefault();selected=new Set(visibleTracks().flatMap(t=>t.keys.map(k=>k.id)));refresh();}
    else if(mod&&(key==="z"||key==="y")){event.preventDefault();edit(()=>{const history=store.temporal.getState();if(key==="y"||event.shiftKey)history.redo();else history.undo();});}
    else if(key==="delete"||key==="backspace"){event.preventDefault();remove();}
    else if(key==="s"&&!mod&&!event.altKey){event.preventDefault();insert();}
    else if(key==="f"){event.preventDefault();fit(selected.size>0);}
    else if(key==="escape"){event.preventDefault();cancelDrag();selected.clear();refresh();}
    else if(key==="arrowleft"||key==="arrowright"){event.preventDefault();edit(()=>domain.move(selected,(key==="arrowleft"?-1:1)*(event.shiftKey?10:1)*(isDriven ? .1 : 1),0));}
  });
  function refresh() {
    const doc=store.getState().document,selection=options.getSelection().join("|");
    updateDriver();
    if(lastDocument!==doc||lastSelection!==selection){
      const existing=new Set(animation().tracks.flatMap(t=>t.keys.map(k=>k.id)));selected=new Set([...selected].filter(id=>existing.has(id)));
      lastDocument=doc;lastSelection=selection;
    }
    const editorState=`${manualCursor}/${selection}/${selectedObjectsOnly}/${activeTrack}/${[...selected].join(",")}/${JSON.stringify(view)}/${drag?.kind ?? ""}`;
    if(renderedDocument!==doc||lastEditorState!==editorState){
      renderChannels();updateDriver();updateFields();draw();renderedDocument=doc;
      lastEditorState=`${manualCursor}/${selection}/${selectedObjectsOnly}/${activeTrack}/${[...selected].join(",")}/${JSON.stringify(view)}/${drag?.kind ?? ""}`;
    } else {
      // Playback moves only the cursors; static curves and channel DOM are retained.
      const graphCursor=svg.querySelector(".animation-playhead"),dopeCursor=dopeSvg.querySelector(".animation-playhead");
      const gx=x(cursor()),dx=x(options.getFrame(),true);
      graphCursor?.setAttribute("x1",String(gx));graphCursor?.setAttribute("x2",String(gx));
      dopeCursor?.setAttribute("x1",String(dx));dopeCursor?.setAttribute("x2",String(dx));
      dopeCursor?.setAttribute("visibility",dx>=190&&dx<=dopeWidth-16?"visible":"hidden");
    }
  }
  function cancelDrag() {
    if (drag) { const target = drag.sheet ? dopeSvg : svg; if (target.hasPointerCapture(drag.pointerId)) target.releasePointerCapture(drag.pointerId); }
    drag=undefined;previewTracks=undefined;
  }
  store.subscribe(()=>{ cancelDrag();refresh(); });
  new ResizeObserver(()=>draw()).observe(surface);if (!isDriven) new ResizeObserver(()=>drawDope()).observe(dopeScroll);
  announce("Set keys in the Timeline · select a channel · drag keys and tangent handles");
  fit();
  return { graph, dopeSheet, refresh, cancelDrag, focusTrack(trackId: string) {
    const track = animation().tracks.find(item => item.id === trackId); if (!track) return;
    selectedObjectsOnly = options.getSelection().includes(track.targetId);
    selectionCheckbox.checked = selectedObjectsOnly; activate(track.id); if (isDriven) isolatedTrack = track.id;
    selected = new Set(track.keys.map(key => key.id)); fit(true);
  } };
}
