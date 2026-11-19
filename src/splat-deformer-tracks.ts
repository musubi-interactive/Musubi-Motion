import type { AnimationTrack } from "./animation.ts";
import { deformerCurves, storedDeformerKey } from "./splat-deformer-curves.ts";
import type { SceneDocument } from "./scene-document.ts";
import { splatDeformerControls, validateSceneSplatDeformers, type SplatDeformer } from "./splat-deformers.ts";

type Row = { track: AnimationTrack; label: string };
const cache = new WeakMap<SceneDocument, Map<string, Row>>();
export function deformerTrackId(shape: string, entry: string, channel: string): `deformer.${string}` {
  return `deformer.${JSON.stringify([shape, entry, channel])}`;
}
export function deformerTrackRows(doc: SceneDocument) {
  const cached = cache.get(doc);
  if (cached) return cached;
  const result = new Map<string, Row>();
  for (const shape of Object.values(doc.nodes)) {
    if (shape.type !== "splatShape") continue;
    for (const entry of shape.deformers ?? []) {
      if (!entry.keys?.length) continue;
      const controls = new Map(splatDeformerControls(entry).map(c => [c.id, c.label]));
      for (const [channel, keys] of deformerCurves(entry.keys)) {
        const id = deformerTrackId(shape.id, entry.id, channel);
        const track: AnimationTrack = { id, targetId: shape.parentId, channel: id, keys };
        result.set(id, { track, label: `${entry.name} · ${controls.get(channel) ?? channel}` });
      }
    }
  }
  cache.set(doc, result);
  return result;
}

/** Recombine edited object-local channels with their stack. Ordinary tracks are
 * validated separately. Missing previously keyed channels represent deletions. */
export function applyDeformerTracks(doc: SceneDocument, tracks: AnimationTrack[]): SceneDocument {
  const byShape = new Map<string, Map<string, Map<string, AnimationTrack>>>();
  for (const track of tracks) {
    if (track.id !== track.channel || track.layerId !== undefined) throw Error("Deformer curves belong to base animation.");
    const [shapeId, entryId, channel] = JSON.parse(track.id.slice(9)) as string[];
    const shape = doc.nodes[shapeId];
    if (shape?.type !== "splatShape" || shape.parentId !== track.targetId || !shape.deformers?.some(e => e.id === entryId))
      throw Error("The deformer for this curve is missing.");
    const entries = byShape.get(shapeId) ?? new Map<string, Map<string, AnimationTrack>>();
    const channels = entries.get(entryId) ?? new Map<string, AnimationTrack>();
    if (channels.has(channel)) throw Error("Duplicate deformer curve.");
    channels.set(channel, track);
    entries.set(entryId, channels);
    byShape.set(shapeId, entries);
  }
  const nodes = { ...doc.nodes };
  let changed = false;
  for (const shape of Object.values(nodes)) {
    if (shape.type !== "splatShape" || !shape.deformers) continue;
    const stack = shape.deformers.map((entry): SplatDeformer => {
      const channels = byShape.get(shape.id)?.get(entry.id);
      const before = entry.keys?.length ? deformerCurves(entry.keys) : new Map();
      if (before.size === (channels?.size ?? 0) && [...before].every(([c, keys]) => {
        const next = channels?.get(c)?.keys;
        return keys === next || JSON.stringify(keys) === JSON.stringify(next);
      })) return entry;
      const keys = Array.from(channels ?? []).flatMap(([c, track]) => track.keys.map(key => storedDeformerKey(c, key)));
      return { ...entry, keys: keys.length ? keys : undefined };
    });
    if (stack.some((entry, i) => entry !== shape.deformers![i])) {
      changed = true;
      nodes[shape.id] = { ...shape, deformers: stack };
    }
  }
  if (!changed) return doc;
  const next = { ...doc, nodes };
  validateSceneSplatDeformers(next);
  return next;
}
