import { bezierTurningFrames, defaultAnimation, type AnimationTrack, type CurveKey } from "./animation.ts";
import type { SceneDocument, SplatShapeNode } from "./scene-document.ts";
import { deformerCurves } from "./splat-deformer-curves.ts";

export type SplatCurveProbes = { edited: Set<number>; neighboring: Set<number> };
function inspectCurve(before: readonly CurveKey[], after: readonly CurveKey[], probes: SplatCurveProbes) {
  if (before === after) return;
  const oldByTime = new Map(before.map(k => [k.time, k]));
  const newByTime = new Map(after.map(k => [k.time, k]));
  const touched = new Set<number>();
  for (const time of new Set([...oldByTime.keys(), ...newByTime.keys()])) {
    const a = oldByTime.get(time), b = newByTime.get(time);
    if (a !== b && JSON.stringify(a) !== JSON.stringify(b)) touched.add(time);
  }
  if (!touched.size) return;
  for (const time of touched) probes.edited.add(time);
  let first = Infinity, last = -Infinity;
  for (const curve of [before, after]) curve.forEach((key, i) => {
    if (!touched.has(key.time)) return;
    // A preset tangent may change at a neighboring key as well.
    for (const other of curve.slice(Math.max(0, i - 2), i + 3)) {
      probes.neighboring.add(other.time);
      first = Math.min(first, other.time); last = Math.max(last, other.time);
    }
  });
  for (const time of bezierTurningFrames(after, first, last)) probes.neighboring.add(time);
}

export function preflightSplatCurveEdit(before: SceneDocument, next: SceneDocument,
  validate: (doc: SceneDocument, shape: SplatShapeNode, probes: SplatCurveProbes) => void) {
  const morphTracks = (doc: SceneDocument) => new Map((doc.animation?.tracks ?? [])
    .filter(t => t.channel.startsWith("morph.")).map(t => [t.id, t]));
  const changedMorphs = new Map<string, Array<[AnimationTrack | undefined, AnimationTrack | undefined]>>();
  if (before.animation !== next.animation) {
    const original = morphTracks(before), candidate = morphTracks(next);
    for (const id of new Set([...original.keys(), ...candidate.keys()])) {
      const a = original.get(id), b = candidate.get(id);
      if (a?.keys === b?.keys) continue;
      const target = (b ?? a)!.targetId, pairs = changedMorphs.get(target) ?? [];
      pairs.push([a, b]); changedMorphs.set(target, pairs);
    }
  }
  const oldRange = before.animation ?? defaultAnimation(), nextRange = next.animation ?? defaultAnimation();
  const rangeChanged = oldRange.start !== nextRange.start || oldRange.end !== nextRange.end;
  if (before.nodes === next.nodes && !changedMorphs.size && !rangeChanged) return;
  for (const shape of Object.values(next.nodes)) {
    if (shape.type !== "splatShape") continue;
    const prior = before.nodes[shape.id];
    if (prior?.type !== "splatShape") continue;
    const probes: SplatCurveProbes = { edited: new Set(), neighboring: new Set() };
    if (rangeChanged && (shape.morphSurface || shape.deformers?.length)) probes.edited.add(nextRange.start);
    if (shape.morphSurface) for (const [a, b] of changedMorphs.get(shape.parentId) ?? [])
      inspectCurve(a?.keys ?? [], b?.keys ?? [], probes);
    if (shape.deformers !== prior.deformers) for (const entry of shape.deformers ?? []) {
      const original = prior.deformers?.find(e => e.id === entry.id);
      if (original === entry) continue;
      const a = deformerCurves(original?.keys ?? []), b = deformerCurves(entry.keys ?? []);
      for (const channel of new Set([...a.keys(), ...b.keys()])) inspectCurve(a.get(channel) ?? [], b.get(channel) ?? [], probes);
    }
    if (probes.edited.size) validate(next, shape, probes);
  }
}

/** Always validate the displayed pose separately. Bound additional synchronous
 * geometry work per shape. Prioritize authored edits over neighboring samples. */
export function splatCurveProbeFrames(shape: SplatShapeNode, probes: SplatCurveProbes, current: number) {
  const count = shape.morphSurface?.sourceCount ?? shape.deformers?.[0]?.sourceCount ?? 1;
  const work = count * Math.max(1, shape.deformers?.length ?? 0);
  const budget = Math.max(2, Math.min(32, Math.floor(250000 / work)));
  const result = new Set<number>();
  for (const group of [probes.edited, probes.neighboring]) {
    const frames = [...group].filter(t => t !== current && !result.has(t)).sort((a, b) => a - b);
    const room = budget - result.size;
    if (!room) break;
    if (frames.length <= room) for (const t of frames) result.add(t);
    else if (room === 1) result.add(frames.reduce((a,b) => Math.abs(a-current) < Math.abs(b-current) ? a : b));
    else for (let i = 0; i < room; i++) result.add(frames[Math.round(i * (frames.length - 1) / (room - 1))]);
  }
  return result;
}
