import { isCustomChannel } from "./custom-attributes.ts";
import {
  POSE_ANIMATION_CHANNELS, insertCurveKey, scaleCurveKeys, validateCurveKeys,
  type AnimationTrack, type CurveKey,
} from "./animation.ts";
import { validateDrivenKeys, type DrivenKeyRelationship, type DrivenProperty } from "./driven-keys.ts";
import type { SceneDocument } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export type DrivenCurveClipboard = { relationships: DrivenKeyRelationship[]; origin: number };
const finite = (value: unknown, bound = 1e12): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= bound;
const propertyKey = (value: DrivenProperty) => JSON.stringify([value.targetId, value.channel]);
const sameProperty = (a: DrivenProperty, b: DrivenProperty) => a.targetId === b.targetId && a.channel === b.channel;

function save(store: SceneStore, relationships: DrivenKeyRelationship[], editLabel: string): void {
  const doc = store.getState().document;
  validateDrivenKeys(relationships, doc);
  if (JSON.stringify(relationships) === JSON.stringify(doc.drivenKeys ?? [])) return;
  store.setState({ document: { ...doc, drivenKeys: relationships }, editLabel });
}

/** Display adapter only: the horizontal key coordinate remains a driver value. */
export function drivenCurveTracks(doc: SceneDocument): AnimationTrack[] {
  return (doc.drivenKeys ?? []).map(relation => ({
    id: relation.id, targetId: relation.driven.targetId, channel: relation.driven.channel, keys: relation.keys,
  }));
}

export function replaceDrivenTracks(store: SceneStore, replacements: readonly AnimationTrack[], label = "Edit driven-key curves"): void {
  const relationships = store.getState().document.drivenKeys ?? [], byId = new Map(relationships.map(relation => [relation.id, relation]));
  const changed = new Map<string, CurveKey[]>();
  for (const track of replacements) {
    if (changed.has(track.id)) throw Error("Duplicate driven-key curve ID.");
    const relation = byId.get(track.id);
    if (!relation) throw Error("The selected driven-key relationship no longer exists.");
    if (track.targetId !== relation.driven.targetId || track.channel !== relation.driven.channel)
      throw Error("Editing a driven curve cannot change its driver or driven channel.");
    changed.set(track.id, structuredClone(track.keys));
  }
  save(store, relationships.map(relation => changed.has(relation.id) ? { ...relation, keys: changed.get(relation.id)! } : relation), label);
}

export function patchDrivenCurveKeys(store: SceneStore, keyIds: Iterable<string>, patch: Partial<Omit<CurveKey, "id">>): void {
  const selected = new Set(keyIds);
  save(store, (store.getState().document.drivenKeys ?? []).map(relation => ({ ...relation,
    keys: relation.keys.map(key => selected.has(key.id) ? { ...key, ...patch, id: key.id } : key).sort((a, b) => a.time - b.time),
  })), "Edit driven keys");
}

export function moveDrivenCurveKeys(store: SceneStore, keyIds: Iterable<string>, driverDelta: number, valueDelta = 0): void {
  if (!finite(driverDelta, 2e6) || !finite(valueDelta)) throw Error("Invalid driven-key movement.");
  const selected = new Set(keyIds);
  save(store, (store.getState().document.drivenKeys ?? []).map(relation => ({ ...relation,
    keys: relation.keys.map(key => selected.has(key.id) ? { ...key, time: key.time + driverDelta, value: key.value + valueDelta } : key)
      .sort((a, b) => a.time - b.time),
  })), "Move driven keys");
}

export function deleteDrivenCurveKeys(store: SceneStore, keyIds: Iterable<string>): void {
  const selected = new Set(keyIds);
  save(store, (store.getState().document.drivenKeys ?? []).map(relation => ({ ...relation,
    keys: relation.keys.filter(key => !selected.has(key.id)),
  })).filter(relation => relation.keys.length), "Delete driven keys");
}

export function insertDrivenCurveKey(store: SceneStore, relationId: string, driverValue: number): string {
  const relationships = store.getState().document.drivenKeys ?? [], relation = relationships.find(item => item.id === relationId);
  if (!relation) throw Error("Select an existing driven-key curve.");
  // SDK visibility is continuous, unlike time-keyed visibility.
  const { keys, id } = insertCurveKey(relation.keys, driverValue);
  if (!relation.keys.some(key => key.id === id))
    save(store, relationships.map(item => item.id === relationId ? { ...item, keys } : item), "Insert driven key");
  return id;
}

export function scaleDrivenCurveKeys(store: SceneStore, keyIds: Iterable<string>, factor: number, pivot?: number): void {
  if (!finite(factor) || factor <= 0 || (pivot !== undefined && !finite(pivot, 1e6)))
    throw Error("Driven-key scale must be positive and finite, with a valid driver-value pivot.");
  const relationships = store.getState().document.drivenKeys ?? [], selected = new Set(keyIds);
  let origin = pivot ?? Infinity;
  if (pivot === undefined) for (const relation of relationships) for (const key of relation.keys)
    if (selected.has(key.id)) origin = Math.min(origin, key.time);
  if (!Number.isFinite(origin)) return;
  save(store, relationships.map(relation => ({ ...relation, keys: scaleCurveKeys(relation.keys, selected, factor, origin, false) })), "Scale driven keys");
}

export function copyDrivenCurveKeys(doc: SceneDocument, keyIds: Iterable<string>): DrivenCurveClipboard {
  const selected = new Set(keyIds), relationships = (doc.drivenKeys ?? []).map(relation => ({ ...relation,
    keys: relation.keys.filter(key => selected.has(key.id)),
  })).filter(relation => relation.keys.length);
  return { relationships: structuredClone(relationships), origin: relationships.length
    ? relationships.reduce((origin, relation) => Math.min(origin, relation.keys[0].time), Infinity) : 0 };
}

function validateClipboard(clipboard: DrivenCurveClipboard): void {
  if (!clipboard || !finite(clipboard.origin, 1e6) || !Array.isArray(clipboard.relationships) || clipboard.relationships.length > 10000)
    throw Error("Invalid driven-key clipboard.");
  const ids = new Set<string>(), outputs = new Set<string>(), keys = new Set<string>();
  for (const relation of clipboard.relationships) {
    if (!relation || typeof relation.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(relation.id) || ids.has(relation.id))
      throw Error("Invalid or duplicate clipboard relationship ID.");
    ids.add(relation.id);
    for (const property of [relation.driver, relation.driven]) if (!property || typeof property.targetId !== "string" || !(POSE_ANIMATION_CHANNELS as readonly string[]).includes(property.channel) && !isCustomChannel(property.channel))
      throw Error("Invalid clipboard driver or driven channel.");
    const output = propertyKey(relation.driven);
    if (outputs.has(output)) throw Error("A clipboard driven channel can have only one driver.");
    outputs.add(output);
    validateCurveKeys(relation.keys);
    if (!relation.keys.length) throw Error("A copied driven relationship needs at least one key.");
    for (const key of relation.keys) {
      if (keys.has(key.id)) throw Error("Duplicate clipboard driven key ID.");
      keys.add(key.id);
      if (keys.size > 100000) throw Error("Too many copied driven keys.");
    }
  }
}

/** With no explicit destination, resolve by driver/output properties rather
 * than old relationship IDs. An explicit destination imports one curve's keys. */
export function pasteDrivenCurveKeys(store: SceneStore, clipboard: DrivenCurveClipboard, driverValue: number, targetRelationId?: string): string[] {
  if (!finite(driverValue, 1e6)) throw Error("Invalid paste driver value.");
  validateClipboard(clipboard);
  const relationships = [...(store.getState().document.drivenKeys ?? [])], ids: string[] = [];
  if (targetRelationId !== undefined) {
    if (clipboard.relationships.length !== 1) throw Error("Pasting into a selected driven curve requires exactly one copied relationship.");
    if (!relationships.some(relation => relation.id === targetRelationId)) throw Error("The destination driven-key relationship no longer exists.");
  }
  for (const source of clipboard.relationships) {
    const index = relationships.findIndex(relation => targetRelationId !== undefined
      ? relation.id === targetRelationId : sameProperty(relation.driven, source.driven));
    const destination = index < 0 ? {
      id: crypto.randomUUID(), driver: { ...source.driver }, driven: { ...source.driven }, keys: [],
    } : relationships[index];
    if (targetRelationId === undefined && !sameProperty(destination.driver, source.driver))
      throw Error("This driven channel already has a different driver. Remove that relationship first.");
    const pasted = source.keys.map(key => ({ ...key, id: crypto.randomUUID(), time: driverValue + (key.time - clipboard.origin) }));
    ids.push(...pasted.map(key => key.id));
    const coordinates = new Set(pasted.map(key => key.time));
    const next = { ...destination, keys: [...destination.keys.filter(key => !coordinates.has(key.time)), ...pasted].sort((a, b) => a.time - b.time) };
    if (index < 0) relationships.push(next); else relationships[index] = next;
  }
  save(store, relationships, "Paste driven keys");
  return ids;
}
