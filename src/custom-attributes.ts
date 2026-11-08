import { attributeType, isDiscreteAttribute, validDiscreteValue, validateAttributeType, type CustomAttributeType, type EnumEntry } from "./custom-attribute-types.ts";
import type { SceneDocument } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export type CustomAttribute = { type?: CustomAttributeType; entries?: EnumEntry[]; nextValue?: number; id: string; name: string; default: number; value: number; min?: number; max?: number; keyable: boolean; locked: boolean };
export type CustomChannel = `custom.${string}`;
export const MAX_CUSTOM_ATTRIBUTES = 10000, MAX_CUSTOM_ATTRIBUTES_PER_OBJECT = 64;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
export const isCustomChannel = (channel: string): channel is CustomChannel => channel.startsWith("custom.") && validId(channel.slice(7));

/** Object channels belong to the transform, irrespective of the selected shape. */
export function attributeOwner(doc: SceneDocument, id: string): string {
  const node = doc.nodes[id];
  if (node) return node.type === "transform" ? id : node.parentId;
  if (doc.joints?.some(item => item.id === id) || doc.ikHandles?.some(item => item.id === id)) return id;
  throw Error("Select an existing scene object, joint or IK handle.");
}
export function attributesFor(doc: SceneDocument, id: string): readonly CustomAttribute[] {
  return doc.customAttributes?.[attributeOwner(doc, id)] ?? [];
}
export function customAttribute(doc: SceneDocument, id: string, channel: string): CustomAttribute | undefined {
  return isCustomChannel(channel) ? attributesFor(doc, id).find(item => item.id === channel.slice(7)) : undefined;
}
export function customChannel(attribute: CustomAttribute): CustomChannel { return `custom.${attribute.id}`; }
export function channelLabel(doc: SceneDocument, id: string, channel: string): string {
  return customAttribute(doc, id, channel)?.name ?? channel;
}
export function boundedAttributeValue(attribute: CustomAttribute, value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw Error("Attribute values must be finite numbers within ±1e12.");
  if (isDiscreteAttribute(attribute)) {
    if (!validDiscreteValue(attribute, value)) throw Error(`${attribute.name} must be an existing ${attributeType(attribute)} choice.`);
    return value;
  }
  return Math.min(attribute.max ?? 1e12, Math.max(attribute.min ?? -1e12, value));
}
function checkValue(attribute: CustomAttribute, value: number) {
  if (boundedAttributeValue(attribute, value) !== value) throw Error(`${attribute.name} must be within its minimum and maximum.`);
}
export function validateCustomAttributes(doc: SceneDocument): void {
  const map = doc.customAttributes;
  if (map === undefined) return;
  if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length > MAX_CUSTOM_ATTRIBUTES) throw Error("Invalid custom attributes.");
  let count = 0;
  const ids = new Set<string>();
  for (const [owner, attributes] of Object.entries(map)) {
    if (!validId(owner) || attributeOwner(doc, owner) !== owner || !Array.isArray(attributes) || attributes.length > MAX_CUSTOM_ATTRIBUTES_PER_OBJECT) throw Error("Invalid custom attribute owner or too many attributes (maximum 64 per object).");
    const names = new Set<string>();
    for (const item of attributes) {
      if (++count > MAX_CUSTOM_ATTRIBUTES) throw Error("Too many custom attributes (maximum 10000).");
      if (!item || typeof item !== "object" || !validId(item.id) || ids.has(item.id)
        || typeof item.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(item.name) || names.has(item.name.toLowerCase())
        || ["position", "rotation", "scale", "visibility", "blend", "constructor", "prototype", "__proto__"].includes(item.name.toLowerCase())
        || typeof item.keyable !== "boolean" || typeof item.locked !== "boolean"
        || Object.keys(item).some(key => !["id", "name", "default", "value", "min", "max", "keyable", "locked", "type", "entries", "nextValue"].includes(key))) throw Error("Invalid or duplicate custom attribute name/ID. Use letters, digits and underscores; begin with a letter or underscore.");
      validateAttributeType(item, validId);
      for (const key of ["min", "max"] as const) if (item[key] !== undefined && (typeof item[key] !== "number" || !Number.isFinite(item[key]) || Math.abs(item[key]!) > 1e12)) throw Error("Attribute limits must be finite numbers within ±1e12.");
      if (item.min !== undefined && item.max !== undefined && item.min > item.max) throw Error("Attribute minimum must not exceed maximum.");
      checkValue(item, item.default); checkValue(item, item.value);
      ids.add(item.id); names.add(item.name.toLowerCase());
    }
  }
}
export function addCustomAttribute(store: SceneStore, target: string, settings: Omit<CustomAttribute, "id" | "value"> & { value?: number }): string {
  const doc = store.getState().document, owner = attributeOwner(doc, target), id = crypto.randomUUID();
  const item: CustomAttribute = { ...settings, value: settings.value ?? settings.default, id };
  const next = { ...doc, customAttributes: { ...doc.customAttributes, [owner]: [...attributesFor(doc, owner), item] } };
  validateCustomAttributes(next);
  store.setState({ document: next, editLabel: "Add Attribute" }); return id;
}
export function updateCustomAttribute(store: SceneStore, target: string, id: string, patch: Partial<Omit<CustomAttribute, "id">>): void {
  const doc = store.getState().document, owner = attributeOwner(doc, target), items = attributesFor(doc, owner), before = items.find(item => item.id === id);
  if (!before) throw Error("Custom attribute no longer exists.");
  // Unlock is always possible, but cannot smuggle a value/settings edit into it.
  if (before.locked && Object.keys(patch).some(key => key !== "locked")) throw Error("Unlock the attribute before editing it.");
  const next = { ...before, ...patch, id }, channel = customChannel(before);
  const referenced = (doc.animation?.tracks ?? []).some(track => track.targetId === owner && track.channel === channel)
    || (doc.drivenKeys ?? []).some(relation => [relation.driver, relation.driven].some(property => property.targetId === owner && property.channel === channel));
  if (referenced && attributeType(next) !== attributeType(before)) throw Error("Remove time/SDK references before changing attribute type.");
  if (before.type === "enum" && next.type === "enum") {
    if (next.nextValue! < before.nextValue!) throw Error("Enum entry codes cannot be reused or renumbered.");
    for (const entry of next.entries ?? []) {
      const old = before.entries!.find(item => item.id === entry.id);
      if (old ? old.value !== entry.value : entry.value < before.nextValue!) throw Error("Enum entry IDs keep their permanent codes; new entries need new codes.");
    }
    for (const removed of before.entries!.filter(entry => !next.entries?.some(item => item.id === entry.id))) {
      const timeReference = doc.animation?.tracks.some(track => track.targetId === owner && track.channel === channel && track.keys.some(key => key.value === removed.value));
      const sdkReference = doc.drivenKeys?.some(relation => (relation.driver.targetId === owner && relation.driver.channel === channel && relation.keys.some(key => key.time === removed.value)) || (relation.driven.targetId === owner && relation.driven.channel === channel && relation.keys.some(key => key.value === removed.value)));
      if (timeReference || sdkReference) throw Error(`Enum entry ${removed.name} has time/SDK references. Remove those references before deleting the entry.`);
    }
  }
  if (referenced && (Object.hasOwn(patch, "min") || Object.hasOwn(patch, "max") || patch.keyable === false)) throw Error("Remove time/SDK references before changing limits or disabling keyable.");
  if (patch.value !== undefined && doc.drivenKeys?.some(relation => relation.driven.targetId === owner && relation.driven.channel === channel)) throw Error("This attribute is driven. Edit its driver or remove its relationship.");
  const document = { ...doc, customAttributes: { ...doc.customAttributes, [owner]: items.map(item => item.id === id ? next : item) } };
  validateCustomAttributes(document);
  if (JSON.stringify(next) !== JSON.stringify(before)) store.setState({ document, editLabel: "Edit Attribute" });
}
export function removeCustomAttribute(store: SceneStore, target: string, id: string, removeReferences = false): void {
  const doc = store.getState().document, owner = attributeOwner(doc, target), item = attributesFor(doc, owner).find(item => item.id === id);
  if (!item) throw Error("Custom attribute no longer exists.");
  if (item.locked) throw Error("Unlock the attribute before deleting it.");
  const channel = customChannel(item), refers = (property: { targetId: string; channel: string }) => property.targetId === owner && property.channel === channel;
  const tracks = doc.animation?.tracks.filter(track => !refers(track)), relations = doc.drivenKeys?.filter(relation => !refers(relation.driver) && !refers(relation.driven));
  if (!removeReferences && (tracks?.length !== doc.animation?.tracks.length || relations?.length !== doc.drivenKeys?.length)) throw Error("Attribute has time/SDK references. Use Delete Attribute and References to remove them together.");
  const document = { ...doc, customAttributes: { ...doc.customAttributes, [owner]: attributesFor(doc, owner).filter(attribute => attribute.id !== id) },
    ...(doc.animation ? { animation: { ...doc.animation, tracks: tracks! } } : {}), ...(doc.drivenKeys ? { drivenKeys: relations! } : {}) };
  store.setState({ document, editLabel: "Delete Attribute" });
}

/** Existing Mirror Joint Subtree copies authored definitions, not source time/SDK curves. */
export function copyCustomAttributes(doc: SceneDocument, owners: ReadonlyMap<string, string>): SceneDocument["customAttributes"] {
  const result = { ...doc.customAttributes };
  for (const [source, target] of owners) if (doc.customAttributes?.[source]) result[target] = doc.customAttributes[source].map(item => ({ ...item, ...(item.entries ? { entries: item.entries.map(entry => ({ ...entry, id: crypto.randomUUID() })) } : {}), id: crypto.randomUUID() }));
  return result;
}
