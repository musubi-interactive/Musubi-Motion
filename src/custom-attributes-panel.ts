import { attributeType, attributeTypeLabel, attributeChoices, makeEnumEntries, type CustomAttributeType, type EnumEntry } from "./custom-attribute-types.ts";
import { icon } from "./ui.ts";
import { addCustomAttribute, attributeOwner, attributesFor, customChannel, removeCustomAttribute, updateCustomAttribute, type CustomAttribute } from "./custom-attributes.ts";
import { readChannel, setKeys, editingTracks, type AnimationPose } from "./animation.ts";
import { propertyInteraction } from "./property-interaction.ts";
import type { SceneStore } from "./scene-store.ts";

type Options = {
  getSelection(): string[]; getFrame(): number; getPose(id: string): AnimationPose; available(): boolean;
  beginPreview(id: string, attribute: CustomAttribute): { update(value: number): void; end(): void } | undefined;
  onGraph(trackId: string): void; keyAttribute(id: string, attribute: CustomAttribute): void; changeValue(id: string, attribute: CustomAttribute, value: number): void;
};
/** One common Extra Attributes section, including IK targets and ordinary transforms. */
export function mountCustomAttributes(host: HTMLElement, store: SceneStore, options: Options) {
  const section = document.createElement("section"); section.className = "custom-attributes"; section.setAttribute("aria-label", "Extra Attributes");
  const style = document.createElement("style");
  style.textContent = `.attribute-dialog [hidden],.custom-attributes [hidden]{display:none!important}.custom-attributes{border-top:1px solid var(--line);padding:10px;font-size:12px;color:var(--text)}.custom-attributes h3{font-size:12px;margin:0 0 8px}.custom-attributes p{color:var(--muted);line-height:1.4}.custom-attributes button,.attribute-dialog button,.attribute-dialog input,.attribute-dialog select{font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:3px;padding:4px}.custom-attributes button,.attribute-dialog button{cursor:pointer}.custom-attributes button:disabled,.custom-attributes input:disabled{opacity:.45;cursor:default}.custom-attribute-row{display:grid;grid-template-columns:minmax(45px,1fr) minmax(55px,80px) 24px 24px 28px;gap:4px;align-items:center;margin:6px 0}.custom-attribute-row input,.custom-attribute-row select{width:100%;min-width:0;text-align:right;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);padding:4px}.custom-attribute-row label{overflow:hidden;text-overflow:ellipsis}.attribute-dialog{width:min(340px,calc(100vw - 32px));max-height:90vh;overflow:auto;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:16px;font-size:12px}.attribute-dialog::backdrop{background:#0006}.attribute-dialog h3{font-size:13px;margin-top:0}.attribute-dialog label{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0}.attribute-dialog input[type=number]{width:115px;text-align:right}.attribute-dialog input[type=text]{width:170px}.attribute-dialog footer{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}.attribute-dialog p{line-height:1.4}.attribute-error{min-height:18px;white-space:normal}.custom-attribute-row button[data-key-state=keyed]{color:var(--accent,#c99a32)}`;
  section.append(style);
  const heading = document.createElement("h3"); heading.textContent = "Extra Attributes";
  const add = button("Add Attribute…", () => open());
  const rows = document.createElement("div"), status = document.createElement("p"); status.className = "attribute-error"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  section.append(heading, rows, add, status); host.append(section);
  let signature = "", activePreview: ReturnType<Options["beginPreview"]>, dialog: HTMLDialogElement | undefined;
  const controls: { id: string; input: HTMLInputElement | HTMLSelectElement; attribute: CustomAttribute; key: HTMLButtonElement; lock: HTMLButtonElement; edit: HTMLButtonElement }[] = [];
  function button(text: string, action: () => void, label?: string) {
    const node = document.createElement("button"); node.type = "button"; node.textContent = text; if (label) node.setAttribute("aria-label", label); node.onclick = action; return node;
  }
  function owner(): string | undefined {
    const ids = [...new Set(options.getSelection())];
    if (ids.length !== 1) return;
    try { return attributeOwner(store.getState().document, ids[0]); } catch { return; }
  }
  function run(action: () => void) {
    if (!options.available()) { status.textContent = "Finish the current operation before editing attributes."; return; }
    try { action(); status.textContent = ""; } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    refresh();
  }
  function stopPreview() { const previous = activePreview; activePreview = undefined; previous?.end(); }
  function open(attribute?: CustomAttribute) {
    const id = owner(); if (!id || !options.available()) { status.textContent = "Select one scene object, joint or IK handle first."; return; }
    stopPreview(); dialog?.close(); dialog?.remove();
    const document = store.getState().document;
    const box = window.document.createElement("dialog"); dialog = box; box.className = "attribute-dialog"; box.setAttribute("aria-label", attribute ? "Edit Attribute" : "Add Attribute");
    const title = window.document.createElement("h3"); title.textContent = attribute ? "Edit Attribute" : "Add Attribute"; box.append(title);
    const ownerLabel = window.document.createElement("p"); ownerLabel.textContent = `Object: ${document.nodes[id]?.name ?? document.joints?.find(item => item.id === id)?.name ?? document.ikHandles?.find(item => item.id === id)?.name ?? id}`; box.append(ownerLabel);
    function field(label: string, type: string, value: string) {
      const row = window.document.createElement("label"), input = window.document.createElement("input"); input.type = type; input.value = value; input.setAttribute("aria-label", label);
      if (type === "number") input.step = "any"; else input.maxLength = 80;
      row.append(label, input); box.append(row); return input;
    }
    const name = field("Attribute name", "text", attribute?.name ?? "curl"), fallback = field("Default value", "number", String(attribute?.default ?? 0));
    const min = field("Minimum (optional)", "number", attribute?.min === undefined ? "" : String(attribute.min)), max = field("Maximum (optional)", "number", attribute?.max === undefined ? "" : String(attribute.max));
    const typeRow = window.document.createElement("label"), type = window.document.createElement("select"); type.setAttribute("aria-label", "Attribute type");
    for (const value of ["float", "boolean", "enum"] as const) type.add(new Option({float:"Float",boolean:"Boolean",enum:"Enum"}[value],value));
    type.value = attributeType(attribute); typeRow.append("Attribute type",type); title.after(typeRow);
    const initial = attribute?.type === "enum" ? { entries: structuredClone(attribute.entries!), nextValue: attribute.nextValue! } : makeEnumEntries(["A","B"]);
    let entries: EnumEntry[] = initial.entries, nextValue = initial.nextValue;
    const choices = window.document.createElement("select"); choices.setAttribute("aria-label","Default choice");
    const choiceRow = window.document.createElement("label");choiceRow.append("Default choice",choices);box.append(choiceRow);
    const entryBox = window.document.createElement("fieldset"), legend = window.document.createElement("legend");legend.textContent="Enum entries";entryBox.append(legend);
    const entryRows = window.document.createElement("div");entryBox.append(entryRows);
    const entryNote=window.document.createElement("p");entryNote.textContent="Renaming/reordering preserves keyed meanings. Set current/default to another choice before removing an entry; connected entries must be disconnected first.";entryBox.append(entryNote);
    entryBox.append(button("Add enum entry",()=>{entries.push({id:crypto.randomUUID(),name:`Choice${nextValue+1}`,value:nextValue++});renderEntries();}));box.append(entryBox);
    function refreshChoices() {
      const previous=choices.value;
      choices.replaceChildren(...(type.value==="boolean"?[{name:"Off",value:0},{name:"On",value:1}]:entries).map(entry=>new Option(entry.name,String(entry.value))));
      if(Array.from(choices.options).some(option=>option.value===previous))choices.value=previous;
    }
    function renderEntries() {
      entryRows.replaceChildren();
      entries.forEach((entry,index)=>{
        const row=window.document.createElement("div");row.style.cssText="display:flex;gap:4px;margin:5px 0";
        const label=window.document.createElement("input");label.type="text";label.value=entry.name;label.maxLength=80;label.setAttribute("aria-label",`Enum entry ${index+1} name`);label.style.width="100%";
        label.oninput=()=>{entry.name=label.value;refreshChoices();};
        const move=(offset:number)=>{const target=index+offset;if(target<0||target>=entries.length)return;[entries[index],entries[target]]=[entries[target],entries[index]];renderEntries();};
        const up=button("↑",()=>move(-1),`Move enum entry ${index+1} up`),down=button("↓",()=>move(1),`Move enum entry ${index+1} down`);
        up.disabled=index===0;down.disabled=index===entries.length-1;
        const remove=button("×",()=>{entries=entries.filter(item=>item.id!==entry.id);renderEntries();},`Remove enum entry ${index+1}`);
        row.append(label,up,down,remove);entryRows.append(row);
      });refreshChoices();
    }
    function refreshType() {fallback.closest("label")!.hidden=type.value!=="float";min.closest("label")!.hidden=max.closest("label")!.hidden=type.value!=="float";choiceRow.hidden=type.value==="float";entryBox.hidden=type.value!=="enum";refreshChoices();}
    type.onchange=refreshType;renderEntries();refreshType();if(attribute)choices.value=String(attribute.default);
    const keyable = field("Keyable", "checkbox", ""), locked = field("Locked", "checkbox", ""); keyable.checked = attribute?.keyable ?? true; locked.checked = attribute?.locked ?? false;
    const error = window.document.createElement("p"); error.className = "attribute-error"; error.setAttribute("role", "alert"); box.append(error);
    const footer = window.document.createElement("footer");
    const save = button(attribute ? "Save" : "Add", () => {
      try {
        if (owner() !== id || !options.available() || store.getState().document !== document) throw Error("Selection or scene changed. Close this dialog and try again.");
        if (type.value === "float" && !fallback.value.trim()) throw Error("Enter a default value.");
        const settings = { name: name.value, type: type.value === "float" ? undefined : type.value as CustomAttributeType, default: type.value === "float" ? fallback.valueAsNumber : Number(choices.value), min: type.value === "float" && min.value.trim() ? min.valueAsNumber : undefined, max: type.value === "float" && max.value.trim() ? max.valueAsNumber : undefined, keyable: keyable.checked, locked: locked.checked, entries: type.value === "enum" ? entries : undefined, nextValue: type.value === "enum" ? nextValue : undefined };
        if (attribute) {
          // Preserve limits/keyability when unchanged so referenced attributes can be renamed.
          const patch = Object.fromEntries(Object.entries(settings).filter(([key, value]) => value !== attribute[key as keyof CustomAttribute]));
          if (type.value !== attributeType(attribute)) patch.value = settings.default;
          updateCustomAttribute(store, id, attribute.id, patch);
        } else addCustomAttribute(store, id, settings);
        box.close();
      } catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); }
    });
    footer.append(button("Cancel", () => box.close()), save); box.append(footer);
    if (attribute) {
      const destructive = window.document.createElement("p"); destructive.textContent = "Deleting references also removes every time curve and SDK relationship connected to this attribute, in one undo step.";
      box.append(destructive, button("Delete Attribute", () => { try { removeCustomAttribute(store, id, attribute.id); box.close(); } catch (failure) { error.textContent = String((failure as Error).message); } }), button("Delete Attribute and References", () => { try { removeCustomAttribute(store, id, attribute.id, true); box.close(); } catch (failure) { error.textContent = String((failure as Error).message); } }));
    }
    box.onclose = () => { box.remove(); if (dialog === box) dialog = undefined; refresh(); };
    box.onkeydown = event => { event.stopPropagation(); if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") { event.preventDefault(); save.click(); } };
    window.document.body.append(box); box.showModal(); name.focus(); name.select();
  }
  function refresh() {
    const id = owner(), doc = store.getState().document, attributes = id ? attributesFor(doc, id) : [];
    add.disabled = !id || !options.available();
    const nextSignature = JSON.stringify([id, attributes.map(item => ({ ...item, value: undefined }))]);
    if (signature !== nextSignature) {
      signature = nextSignature; stopPreview(); rows.replaceChildren(); controls.length = 0;
      if (!id) { const empty = document.createElement("p"); empty.textContent = "Select one object, joint or IK handle."; rows.append(empty); }
      for (const attribute of attributes) {
        const row = document.createElement("div"); row.className = "custom-attribute-row";
        const label = document.createElement("label"), input = document.createElement(attribute.type === "enum" ? "select" : "input"); label.textContent = attribute.name; label.htmlFor = `attribute-${attribute.id}`; input.id = label.htmlFor; if (input instanceof HTMLInputElement) { input.type = attribute.type === "boolean" ? "checkbox" : "number"; input.step = ".1"; } else input.replaceChildren(...attributeChoices(attribute).map(entry => new Option(entry.name,String(entry.value)))); input.setAttribute("aria-label", `Attribute ${attribute.name}`);
        if (input instanceof HTMLInputElement) { if (attribute.min !== undefined) input.min = String(attribute.min); if (attribute.max !== undefined) input.max = String(attribute.max); }
        const readValue=()=>input instanceof HTMLInputElement && input.type === "checkbox" ? Number(input.checked) : Number(input.value);
        const showValue=(value:number)=>{if(input instanceof HTMLInputElement && input.type === "checkbox")input.checked=!!value;else input.value=String(value);};
        const begin = () => { stopPreview(); const preview = options.beginPreview(id!, attribute);
          const session = preview ? { update: preview.update, end() { if (activePreview === session) activePreview = undefined; preview.end(); } } : undefined;
          activePreview = session; return session; };
        propertyInteraction(input, () => `${id}:${attribute.id}`, label, begin, {
          get: () => attributesFor(store.getState().document, id!).find(item => item.id === attribute.id)?.locked ?? true,
          toggle: () => run(() => { const current = attributesFor(store.getState().document, id!).find(item => item.id === attribute.id)!; updateCustomAttribute(store, id!, attribute.id, { locked: !current.locked }); }),
        });
        input.onfocus = () => { if (!input.disabled) begin(); };
        input.oninput = () => { if (Number.isFinite(readValue())) activePreview?.update(readValue()); };
        input.onchange = () => { const value = readValue(); stopPreview(); run(() => { if (!input.value.trim()) throw Error("Enter an attribute value."); options.changeValue(id!, attribute, value); }); };
        input.onblur = () => { stopPreview(); refresh(); };
        input.onkeydown = event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); stopPreview(); showValue(readChannel(options.getPose(id!), customChannel(attribute))); input.blur(); refresh(); } else if (event.key === "Enter" && input instanceof HTMLInputElement && input.type === "number") { event.preventDefault(); input.blur(); } };
        const key = button("◇", () => run(() => options.keyAttribute(id!, attribute)), `Key ${attribute.name}`);
        key.oncontextmenu = event => { event.preventDefault(); const track = editingTracks(store.getState().document).find(track => track.targetId === id && track.channel === customChannel(attribute)); if (track) options.onGraph(track.id); };
        const lock = button(attribute.locked ? "U" : "L", () => run(() => updateCustomAttribute(store, id!, attribute.id, { locked: !attribute.locked })), `${attribute.locked ? "Unlock" : "Lock"} ${attribute.name}`);
        lock.replaceChildren(icon(attribute.locked ? "unlock" : "lock"));
        lock.title = `${attribute.locked ? "Unlock" : "Lock"} attribute (saved in scene)`;
        const edit = button("…", () => open(attribute), `Edit ${attribute.name}`);
        row.append(label, input, key, lock, edit); rows.append(row); controls.push({ id: id!, input, attribute, key, lock, edit });
      }
    }
    for (const control of controls) {
      const current = attributes.find(item => item.id === control.attribute.id)!;
      const channel = customChannel(current), driven = doc.drivenKeys?.some(relation => relation.driven.targetId === control.id && relation.driven.channel === channel);
      control.input.disabled = !options.available() || !!driven || (attributeType(current) !== "float" && current.locked);
      if (control.input instanceof HTMLInputElement) control.input.readOnly = current.locked; control.input.toggleAttribute("data-locked", current.locked);
      if (document.activeElement !== control.input && !activePreview) { try { const value = readChannel(options.getPose(control.id), channel);if(control.input instanceof HTMLInputElement && control.input.type === "checkbox")control.input.checked=!!value;else control.input.value=String(value); } catch { if(control.input instanceof HTMLInputElement && control.input.type === "checkbox")control.input.checked=!!current.value;else control.input.value=String(current.value); } }
      control.key.disabled = !options.available() || current.locked || !current.keyable || !!driven;
      const track = editingTracks(doc).find(track => track.targetId === control.id && track.channel === channel), keyed = track?.keys.some(key => key.time === Math.round(options.getFrame()));
      control.key.textContent = track?.keys.length ? "◆" : "◇"; control.key.dataset.keyState = keyed ? "keyed" : "unkeyed";
      control.key.title = `${current.name}: ${driven ? "driven by SDK" : keyed ? "key at current frame" : track?.keys.length ? "animated" : "no time curve"}. Click to key; right-click to show curve in Graph Editor.`;
      control.edit.disabled = !options.available(); control.lock.disabled = !options.available();
    }
  }
  store.subscribe(refresh);
  return { refresh, openAdd: () => open(), cancel: stopPreview };
}
