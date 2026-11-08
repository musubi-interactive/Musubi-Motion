import { setKeys, type AnimationPose } from "./animation.ts";
import { attributeOwner, attributesFor, customChannel, updateCustomAttribute, type CustomAttribute } from "./custom-attributes.ts";
import type { SceneStore } from "./scene-store.ts";

/** A diamond consumes one draft channel. Other values still belong to the
 * same immutable scene and editing time, including drafts on other owners. */
export function keyCustomAttribute(store: SceneStore, owner: string, attribute: CustomAttribute, frame: number,
  pose: AnimationPose, drafts: ReadonlyMap<string, Readonly<Record<string, number>>>): Map<string, Record<string, number>> {
  const before = store.getState().document;
  if (attributeOwner(before, owner) !== owner || !attributesFor(before, owner).some(item => item.id === attribute.id)) throw Error("Custom attribute owner changed before keying.");
  const retained = new Map<string, Record<string, number>>();
  for (const [id, values] of drafts) {
    if (!before.customAttributes?.[id]) continue;
    const allowed = new Set(before.customAttributes[id].map(item => item.id));
    const remaining = Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key) && !(id === owner && key === attribute.id)));
    if (Object.keys(remaining).length) retained.set(id, remaining);
  }
  setKeys(store, [owner], frame, new Map([[owner, pose]]), [customChannel(attribute)]);
  return retained;
}

/** Preserve pending values before the synchronous store transition clears the
 * viewer's old document-scoped previews. Validation failures publish nothing. */
export function editCustomAttributeValue(store: SceneStore, owner: string, attribute: CustomAttribute, value: number,
  drafts: ReadonlyMap<string, Readonly<Record<string, number>>>, displayedValue?: number): Map<string, Record<string, number>> {
  const before=store.getState().document, retained=new Map<string,Record<string,number>>();
  for(const [id,values] of drafts) {
    const definitions=before.customAttributes?.[id];if(!definitions)continue;
    const allowed=new Set(definitions.map(item=>item.id));
    const remaining=Object.fromEntries(Object.entries(values).filter(([key])=>allowed.has(key)));
    if(Object.keys(remaining).length)retained.set(id,remaining);
  }
  updateCustomAttribute(store,owner,attribute.id,{value});
  // An animated channel may display a different value while its authored
  // fallback already equals the accepted edit. Preserve the keys/fallback,
  // but give that visible gesture its own revision for draft undo/redo.
  if (store.getState().document === before && displayedValue !== undefined && displayedValue !== value)
    store.setState({ document: { ...before }, editLabel: "Edit Attribute" });
  retained.set(owner,{...retained.get(owner),[attribute.id]:value});
  return retained;
}
