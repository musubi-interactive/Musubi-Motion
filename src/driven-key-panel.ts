import { attributeChoices, isDiscreteAttribute, formatAttributeValue } from "./custom-attribute-types.ts";
import { customAttribute } from "./custom-attributes.ts";
import { channelLabel } from "./custom-attributes.ts";
import { evaluateChannels, evaluateCurve, readChannel, type AnimationChannel, type CurveKey } from "./animation.ts";
import { deleteDrivenKeys, evaluateDrivenKeys, removeDrivenRelationship, setDrivenKey, upsertDrivenRelationship,
  drivenChannels, type DrivenKeyRelationship, type DrivenProperty, type EvaluatedPose } from "./driven-keys.ts";
import type { SceneStore } from "./scene-store.ts";

type Options = {
  getFrame: () => number;
  available: () => boolean;
  getSelection: () => string[];
  /** Post-SDK poses before IK/constraints, including unkeyed FK inputs. Read-only here. */
  getPoses?: () => Map<string, EvaluatedPose>;
  onEditCurve?: (relationshipId: string) => void;
};

/** Dedicated attribute-to-attribute authoring. Draft values never modify the scene until Key. */
export function createDrivenKeyPanel(store: SceneStore, options: Options) {
  const element = document.createElement("section");
  element.className = "driven-key-panel";
  element.setAttribute("aria-label", "Set Driven Key");
  const style = document.createElement("style");
  style.textContent = `.driven-key-panel [hidden]{display:none!important}.driven-key-panel{height:100%;overflow:auto;padding:12px;font-size:12px;background:var(--panel);color:var(--text)}
    .driven-key-panel h3{font-size:12px;margin:0 0 8px}.driven-key-panel p{color:var(--muted);line-height:1.5}
    .driven-key-panel .sdk-pair{display:grid;grid-template-columns:repeat(2,minmax(130px,1fr));gap:10px}
    .driven-key-panel fieldset{border:1px solid var(--line);padding:10px;min-width:0}
    .driven-key-panel label{display:grid;gap:5px;margin:8px 0}.driven-key-panel select,.driven-key-panel input{width:100%;min-width:0}
    .driven-key-panel input,.driven-key-panel select,.driven-key-panel button{font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:3px;padding:6px}
    .driven-key-panel button{cursor:pointer}.driven-key-panel button:hover{background:var(--hover)}.driven-key-panel button:disabled{opacity:.45;cursor:default}
    .driven-key-panel .sdk-actions{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.driven-key-panel .sdk-status{min-height:20px;white-space:normal}
    .driven-key-panel .sdk-keys{width:100%;border-collapse:collapse}.driven-key-panel th{text-align:left;color:var(--muted);font-weight:400}
    .driven-key-panel td,.driven-key-panel th{padding:4px}.driven-key-panel .sdk-keys input{min-width:62px}
    .driven-key-panel .sdk-table-wrap{overflow-x:auto}.driven-key-panel svg{width:100%;height:150px;background:var(--bg);border:1px solid var(--line)}
    .driven-key-panel .sdk-curve-path{stroke:var(--text);fill:none;stroke-width:1.5}.driven-key-panel svg text{fill:var(--muted);font:10px sans-serif}
    .driven-key-panel .sdk-current{color:var(--muted);display:block;margin-top:6px;font-variant-numeric:tabular-nums}
    @media(max-width:600px){.driven-key-panel .sdk-pair{grid-template-columns:1fr}}`;
  element.append(style);
  const intro = document.createElement("p");
  intro.textContent = "Map a driver attribute to one or more driven attributes. Set two or more value pairs to define a response. The horizontal curve axis is the driver value. IK blend uses time keys in IK Handles, not Set Driven Key.";
  element.append(intro);
  const pair = document.createElement("div"); pair.className = "sdk-pair"; element.append(pair);
  const status = document.createElement("p"); status.className = "sdk-status"; status.setAttribute("role", "status");
  const report = (action: () => void) => {
    if (!options.available()) { status.textContent = "Finish the current operation before editing driven keys."; return; }
    try { action(); status.textContent = "Driven-key relationship updated."; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  };
  function button(text: string, action: () => void) {
    const control = document.createElement("button"); control.type = "button"; control.textContent = text;
    control.onclick = action; return control;
  }
  function label(text: string, control: HTMLElement) {
    const node = document.createElement("label"); node.append(document.createTextNode(text), control); return node;
  }
  function numberInput(name: string) {
    const input = document.createElement("input"); input.type = "number"; input.step = "any"; input.setAttribute("aria-label", name); return input;
  }
  function makeSide(title: "Driver" | "Driven") {
    const fieldset = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = title;
    const target = document.createElement("select"); target.setAttribute("aria-label", `${title} object`);
    const channel = document.createElement("select"); channel.setAttribute("aria-label", `${title} attribute`);
    const value = numberInput(`${title} value`);
    const choice = document.createElement("select"); choice.setAttribute("aria-label", `${title} choice`);
    const current = document.createElement("output"); current.className = "sdk-current";
    const side = { target, channel, value, current, choice };
    choice.onchange = () => { value.value = choice.value; };
    fieldset.append(legend, label("Object", target), button(`Load selected as ${title.toLowerCase()}`, () => {
      const id = options.getSelection().find(id => Array.from(target.options).some(option => option.value === id));
      if (!id) { status.textContent = "Select a scene object or joint first."; return; }
      target.value = id; updateChannels(side); sample(side);
    }), label("Attribute", channel), label(`${title} value`, value), choice, current);
    target.onchange = () => { updateChannels(side); sample(side); };
    channel.onchange = () => sample(side);
    pair.append(fieldset); return side;
  }
  const driver = makeSide("Driver"), driven = makeSide("Driven");
  type Side = typeof driver;
  function property(side: Side): DrivenProperty { return { targetId: side.target.value, channel: side.channel.value as AnimationChannel }; }
  function evaluated() {
    if (options.getPoses) return options.getPoses();
    const doc = store.getState().document;
    const ids = [...Object.values(doc.nodes).filter(node => node.type === "transform").map(node => node.id), ...(doc.joints ?? []).map(joint => joint.id), ...(doc.ikHandles ?? []).filter(handle => doc.customAttributes?.[handle.id]?.length).map(handle => handle.id)];
    const poses = new Map<string, EvaluatedPose>(ids.map(id => [id, evaluateChannels(doc, id, options.getFrame())]));
    evaluateDrivenKeys(doc, poses); return poses;
  }
  function sample(side: Side) {
    updateChoice(side);
    const poses = evaluated(), pose = poses.get(side.target.value);
    side.value.value = pose ? String(readChannel(pose, side.channel.value as AnimationChannel)) : "";
    side.choice.value = side.value.value;
    updateCurrent(poses);
  }
  function updateChoice(side: Side) {
    const attribute = customAttribute(store.getState().document, side.target.value, side.channel.value);
    const discrete = isDiscreteAttribute(attribute);
    side.value.closest("label")!.hidden = discrete; side.choice.hidden = !discrete;
    if (discrete) {
      side.choice.replaceChildren(...attributeChoices(attribute!).map(entry => new Option(entry.name,String(entry.value))));
      if(Array.from(side.choice.options).some(option=>option.value===side.value.value))side.choice.value=side.value.value;
    }
  }
  function updateChannels(side: Side) {
    const previous = side.channel.value;
    side.channel.replaceChildren(...drivenChannels(store.getState().document, side.target.value).map(channel => new Option(channelLabel(store.getState().document, side.target.value, channel), channel)));
    if (Array.from(side.channel.options).some(option => option.value === previous)) side.channel.value = previous;
    updateChoice(side);
  }
  const actions = document.createElement("div"); actions.className = "sdk-actions";
  actions.append(button("Load current values", () => { sample(driver); sample(driven); }), button("Set driven key", () => report(() => {
    if (!driver.value.value.trim() || !driven.value.value.trim()) throw Error("Enter both driver and driven values.");
    setDrivenKey(store, property(driver), property(driven), driver.value.valueAsNumber, driven.value.valueAsNumber);
    const relation = store.getState().document.drivenKeys?.find(item => item.driven.targetId === driven.target.value && item.driven.channel === driven.channel.value);
    relationshipSelect.value = relation?.id ?? ""; renderCurve();
  })));
  element.append(actions, status);
  const relationshipSelect = document.createElement("select"); relationshipSelect.setAttribute("aria-label", "Driven-key relationship");
  element.append(label("Relationships", relationshipSelect));
  const curve = document.createElement("div"); element.append(curve);
  relationshipSelect.onchange = () => renderCurve();
  let lastTargets = "", lastRelationships: DrivenKeyRelationship[] | undefined;
  function selectedRelationship() { return store.getState().document.drivenKeys?.find(item => item.id === relationshipSelect.value); }
  function targetName(id: string) {
    const doc = store.getState().document;
    return doc.nodes[id]?.name ?? doc.joints?.find(joint => joint.id === id)?.name ?? id;
  }
  function updateCurrent(poses: Map<string, EvaluatedPose>) {
    for (const side of [driver, driven]) {
      const pose = poses.get(side.target.value);
      const attribute = customAttribute(store.getState().document, side.target.value, side.channel.value);
      const value = pose ? readChannel(pose, side.channel.value as AnimationChannel) : 0;
      side.current.textContent = pose ? `At frame ${options.getFrame()}: ${attribute && isDiscreteAttribute(attribute) ? formatAttributeValue(attribute,value) : Number(value.toFixed(5))}` : "No object loaded";
    }
  }
  function drawCurve(relation: DrivenKeyRelationship) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 440 150"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${relation.driver.channel} to ${relation.driven.channel} driven-key response curve`);
    let minX = relation.keys[0].time, maxX = relation.keys.at(-1)!.time;
    if (minX === maxX) { minX -= 1; maxX += 1; }
    const samples = Array.from({ length: 129 }, (_, i) => {
      const x = minX + i / 128 * (maxX - minX); return [x, evaluateCurve(relation.keys, x)!];
    });
    let minY = Math.min(...samples.map(sample => sample[1])), maxY = Math.max(...samples.map(sample => sample[1]));
    if (minY === maxY) { minY -= 1; maxY += 1; }
    const point = (x: number, y: number) => [48 + (x - minX) / (maxX - minX) * 372, 117 - (y - minY) / (maxY - minY) * 99];
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("class", "sdk-curve-path"); path.setAttribute("d", samples.map(([x, y], i) => `${i ? "L" : "M"}${point(x, y).join(",")}`).join(" ")); svg.append(path);
    for (const key of relation.keys) {
      const circle = document.createElementNS(svg.namespaceURI, "circle"), [x, y] = point(key.time, key.value);
      circle.setAttribute("cx", String(x)); circle.setAttribute("cy", String(y)); circle.setAttribute("r", "3"); circle.setAttribute("fill", "var(--text)"); svg.append(circle);
    }
    for (const [x, y, text] of [[48, 139, `${Number(minX.toFixed(3))}`], [360, 139, `${Number(maxX.toFixed(3))}`], [4, 20, `${Number(maxY.toFixed(3))}`], [4, 117, `${Number(minY.toFixed(3))}`], [155, 139, "Driver value →"]] as const) {
      const node = document.createElementNS(svg.namespaceURI, "text"); node.setAttribute("x", String(x)); node.setAttribute("y", String(y)); node.textContent = text; svg.append(node);
    }
    return svg;
  }
  function renderCurve() {
    curve.replaceChildren();
    const relation = selectedRelationship();
    if (!relation) { const note = document.createElement("p"); note.textContent = "No driven-key relationship. Choose the objects and attributes above, enter a value pair, and click Set driven key."; curve.append(note); return; }
    curve.append(drawCurve(relation));
    const controls = document.createElement("div"); controls.className = "sdk-actions";
    controls.append(button("Load relationship", () => {
      driver.target.value = relation.driver.targetId; updateChannels(driver); driver.channel.value = relation.driver.channel;
      driven.target.value = relation.driven.targetId; updateChannels(driven); driven.channel.value = relation.driven.channel;
      sample(driver); sample(driven);
    }), button("Edit curve in Graph Editor", () => options.onEditCurve?.(relation.id)), button("Remove relationship", () => report(() => removeDrivenRelationship(store, relation.id))));
    curve.append(controls);
    const wrap = document.createElement("div"); wrap.className = "sdk-table-wrap";
    const table = document.createElement("table"); table.className = "sdk-keys";
    const head = table.createTHead().insertRow();
    for (const text of ["Driver", "Driven", "Interpolation", "Tangents", ""]) { const th = document.createElement("th"); th.textContent = text; head.append(th); }
    const discreteRelation = isDiscreteAttribute(customAttribute(store.getState().document, relation.driver.targetId, relation.driver.channel)) || isDiscreteAttribute(customAttribute(store.getState().document, relation.driven.targetId, relation.driven.channel));
    const body = table.createTBody();
    for (const key of relation.keys) {
      const row = body.insertRow();
      const patch = (changes: Partial<CurveKey>) => report(() => {
        const latest = store.getState().document.drivenKeys?.find(item => item.id === relation.id);
        if (!latest) return;
        upsertDrivenRelationship(store, { ...latest, keys: latest.keys.map(item => item.id === key.id ? { ...item, ...changes } : item) });
      });
      for (const field of ["time", "value"] as const) {
        const property = field === "time" ? relation.driver : relation.driven, attribute = customAttribute(store.getState().document, property.targetId, property.channel);
        if (isDiscreteAttribute(attribute)) {
          const choice = document.createElement("select");choice.setAttribute("aria-label",`${field === "time" ? "Driver" : "Driven"} choice for key ${key.time}`);
          choice.replaceChildren(...attributeChoices(attribute!).map(entry=>new Option(entry.name,String(entry.value))));choice.value=String(key[field]);choice.onchange=()=>patch({[field]:Number(choice.value)});row.insertCell().append(choice);continue;
        }
        const input = numberInput(`${field === "time" ? "Driver" : "Driven"} value for key ${key.time}`); input.value = String(key[field]);
        input.onchange = () => { if (!input.value.trim()) { input.value = String(key[field]); return; } patch({ [field]: input.valueAsNumber }); };
        row.insertCell().append(input);
      }
      const interpolation = document.createElement("select"); interpolation.setAttribute("aria-label", `Interpolation for driver ${key.time}`);
      for (const value of (discreteRelation ? ["step"] : ["linear", "step", "bezier"]) as CurveKey["interpolation"][]) interpolation.add(new Option(value, value));
      interpolation.value = key.interpolation; interpolation.onchange = () => patch({ interpolation: interpolation.value as CurveKey["interpolation"] }); row.insertCell().append(interpolation);
      const tangent = document.createElement("select"); tangent.setAttribute("aria-label", `Tangents for driver ${key.time}`);
      for (const value of ["auto", "clamped", "flat", "spline"] as const) tangent.add(new Option(value, value));
      if (key.tangentMode === "fixed") tangent.add(new Option("fixed", "fixed"));
      tangent.disabled = discreteRelation; tangent.value = key.tangentMode; tangent.onchange = () => patch({ tangentMode: tangent.value as CurveKey["tangentMode"], interpolation: "bezier" }); row.insertCell().append(tangent);
      row.insertCell().append(button("Delete", () => report(() => deleteDrivenKeys(store, relation.id, [key.id]))));
    }
    wrap.append(table); curve.append(wrap);
    const note = document.createElement("p"); note.textContent = "Values outside the keyed driver range hold the nearest endpoint. One driver per driven attribute; cycles and simultaneous time keys are rejected. Visibility uses a 0–1 value."; curve.append(note);
  }
  function refresh() {
    const doc = store.getState().document;
    const targets = [...Object.values(doc.nodes).filter(node => node.type === "transform"), ...(doc.joints ?? []), ...(doc.ikHandles ?? []).filter(handle => doc.customAttributes?.[handle.id]?.length)];
    const signature = JSON.stringify([targets.map(target => [target.id, target.name]), doc.customAttributes]);
    if (signature !== lastTargets) {
      lastTargets = signature;
      for (const side of [driver, driven]) {
        const previous = side.target.value;
        side.target.replaceChildren(...targets.map(target => new Option(target.name, target.id)));
        if (targets.some(target => target.id === previous)) side.target.value = previous;
        updateChannels(side);
        if (previous !== side.target.value) sample(side);
      }
    }
    if (lastRelationships !== doc.drivenKeys || signature !== relationshipSelect.dataset.targets) {
      lastRelationships = doc.drivenKeys; relationshipSelect.dataset.targets = signature;
      const previous = relationshipSelect.value;
      relationshipSelect.replaceChildren(...(doc.drivenKeys ?? []).map(relation => new Option(`${targetName(relation.driver.targetId)}.${channelLabel(doc, relation.driver.targetId, relation.driver.channel)} → ${targetName(relation.driven.targetId)}.${channelLabel(doc, relation.driven.targetId, relation.driven.channel)}`, relation.id)));
      if (doc.drivenKeys?.some(relation => relation.id === previous)) relationshipSelect.value = previous;
      renderCurve();
    }
    updateCurrent(evaluated());
  }
  // Scene shortcuts must not interpret text editing or Delete in this dedicated editor.
  store.subscribe(refresh); refresh();
  return { element, refresh, loadDriver(id:string) {
    refresh();
    if(!Array.from(driver.target.options).some(option=>option.value===id))return;
    driver.target.value=id;updateChannels(driver);sample(driver);driver.channel.focus();
  } };
}
