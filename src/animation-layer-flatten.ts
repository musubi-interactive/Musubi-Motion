import { bezierTurningFrames, createRawAnimationChannelSampler, validateAnimation, type AnimationChannel, type AnimationData, type AnimationLayer, type AnimationTrack, type CurveKey } from "./animation.ts";
import { isDiscreteAttribute } from "./custom-attribute-types.ts";
import { customAttribute } from "./custom-attributes.ts";
import { validateParticleEmitters } from "./particle-emitter.ts";
import type { SceneDocument } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

const MAX_RANGE_SAMPLES = 10_000;
const MAX_BAKED_KEYS = 25_000;
const MAX_CURVE_EVALUATIONS = 300_000;
const ABS_TOLERANCE = 0.001;
const REL_TOLERANCE = 0.000001;
const frameBits = new BigUint64Array(1);
const frameValue = new Float64Array(frameBits.buffer);

type BakeOptions = { layerIds: readonly string[]; start: number; end: number; sampleBy: number };
type ChannelRef = { targetId: string; channel: AnimationChannel };

function channelId(ref: ChannelRef) {
  return `${ref.targetId}:${ref.channel}`;
}

function sampleFrames({ start, end, sampleBy }: BakeOptions): number[] {
  if (![start, end].every(time => Number.isFinite(time) && Math.abs(time) <= 1e6) || end <= start)
    throw Error("Enter a finite frame range with End after Start.");
  if (!Number.isFinite(sampleBy) || sampleBy < .001)
    throw Error("Sample By must be at least 0.001 frames.");
  const intervals = Math.ceil((end - start) / sampleBy);
  if (intervals + 1 > MAX_RANGE_SAMPLES) throw Error("The range exceeds 10,000 samples. Shorten it or increase Sample By.");
  const frames = [start];
  for (let index = 1; index < intervals; index++) {
    const time = start + index * sampleBy;
    if (time < end) frames.push(time);
  }
  frames.push(end);
  return frames;
}

function assertSupported(doc: SceneDocument, tracks: ReadonlyMap<string, AnimationTrack>) {
  if ([...tracks.values()].some(track => track.channel === "ik.blend"))
    throw Error("Merge Layers cannot bake IK blend curves.");
  if (doc.drivenKeys?.some(relation => tracks.has(channelId(relation.driver)) || tracks.has(channelId(relation.driven))))
    throw Error("A selected curve participates in Set Driven Key. Merge those channels only after removing the driven-key relationship.");

  const transforms = new Set([...tracks.values()].filter(track => /^(position|rotation|scale)\./.test(track.channel)).map(track => track.targetId));
  if (!transforms.size) return;
  const jointParents = new Map(doc.joints?.map(joint => [joint.id, joint.parentId]));
  function affected(id: string | null | undefined): boolean {
    for (let current = id; current; current = doc.nodes[current]?.parentId ?? jointParents.get(current)) {
      if (transforms.has(current)) return true;
    }
    return false;
  }
  if (doc.ikHandles?.some(handle => handle.enabled && [handle.endId, handle.targetControl?.objectId, handle.poleControl?.objectId].some(affected)))
    throw Error("A selected transform feeds an enabled IK handle. Merge Layers bakes local curves only.");
  if (doc.constraints?.some(constraint => constraint.enabled && [constraint.sourceId, constraint.targetId].some(affected)))
    throw Error("A selected transform feeds an enabled constraint. Merge Layers bakes local curves only.");
}

function segmentDocument(doc: SceneDocument, tracks: AnimationTrack[], layers: AnimationLayer[]): SceneDocument {
  // The caller filters layers using the original stack's global solo state.
  // Removing solo flags here avoids applying that filter a second time.
  return { ...doc, animation: { ...doc.animation!, tracks, layers: layers.map(layer => layer.solo ? { ...layer, solo: false } : layer) } };
}

function curveEvents(keys: readonly CurveKey[], start: number, end: number, held: boolean): [number, boolean][] {
  const events: [number, boolean][] = [];
  keys.forEach((key, index) => {
    if (key.time <= start || key.time > end) return;
    events.push([key.time, index > 0 && (held || keys[index - 1].interpolation === "step")]);
  });
  if (!held) for (const frame of bezierTurningFrames(keys, start, end)) events.push([frame, false]);
  return events;
}

function newKey(time: number, value: number, interpolation: CurveKey["interpolation"]): CurveKey {
  return { id: crypto.randomUUID(), time, value, interpolation, tangentMode: "auto" };
}

function adjacentFrame(frame: number, forward: boolean) {
  if (frame === 0) return forward ? Number.MIN_VALUE : -Number.MIN_VALUE;
  frameValue[0] = frame;
  frameBits[0] += (frame > 0) === forward ? 1n : -1n;
  return frameValue[0];
}

/**
 * Replace selected curves with a weight-one override at the first selected
 * layer. Its samples contain the original stack through the selected segment.
 * Unselected layers above it retain their normal contribution.
 */
export function prepareAnimationLayerFlatten(doc: SceneDocument, options: BakeOptions) {
  const animation = doc.animation;
  const layers = animation?.layers ?? [];
  const selectedIds = new Set(options.layerIds);
  const selected = layers.filter(layer => selectedIds.has(layer.id));
  if (!animation || selected.length < 2 || selected.length !== selectedIds.size)
    throw Error("Select at least two existing animation layers to merge.");
  if (selected.some(layer => layer.locked)) throw Error("Unlock the selected animation layers before merging.");
  const frames = sampleFrames(options);
  const { start, end } = options;
  const indices = new Map(layers.map((layer, index) => [layer.id, index]));
  const first = indices.get(selected[0].id)!;
  const last = indices.get(selected[selected.length - 1].id)!;
  const hasSolo = layers.some(layer => layer.solo && !layer.mute);
  const enabled = layers.filter(layer => !layer.mute && (!hasSolo || layer.solo) && (layer.weight > 0 || layer.weightTrack?.keys.length));
  const enabledIds = new Set(enabled.map(layer => layer.id));
  const selectedTracks = animation.tracks.filter(track => track.layerId && selectedIds.has(track.layerId));
  const channels = new Map<string, AnimationTrack>();
  for (const track of selectedTracks) {
    if (track.keys.length && enabledIds.has(track.layerId!)) channels.set(channelId(track), track);
  }
  if (!channels.size) throw Error("The selected layers have no contributing curves. Check mute, solo, and weight.");
  assertSupported(doc, channels);
  if (channels.size * frames.length > MAX_BAKED_KEYS) throw Error("This merge exceeds the 25,000 baked-key limit. Shorten the range or merge fewer layers.");

  const retained = animation.tracks.filter(track => !track.layerId || !selectedIds.has(track.layerId));
  const prefixTracks: AnimationTrack[] = [];
  const suffixTracks: AnimationTrack[] = [];
  const related = new Map<string, AnimationTrack[]>();
  for (const track of animation.tracks) {
    const id = channelId(track);
    if (!channels.has(id)) continue;
    const index = track.layerId ? indices.get(track.layerId)! : -1;
    if (index > first && index < last && !selectedIds.has(track.layerId!) && track.keys.length)
      throw Error(`An unselected layer between the sources also keys ${track.channel}. Select it or reorder the layers before merging.`);
    if (track.layerId && !enabledIds.has(track.layerId)) continue;
    (index <= last ? prefixTracks : suffixTracks).push(track);
    if (!related.has(id)) related.set(id, []);
    related.get(id)!.push(track);
  }
  const prefix = segmentDocument(doc, prefixTracks, enabled.filter(layer => indices.get(layer.id)! <= last));
  const suffix = segmentDocument(doc, suffixTracks, enabled.filter(layer => indices.get(layer.id)! > last));
  const animatedWeights = new Map(enabled.flatMap(layer => layer.weightTrack?.keys.length
    ? [[layer.id, curveEvents(layer.weightTrack.keys, start, end, false)] as const] : []));
  const continuousWeights = new Set(enabled.filter(layer => {
    const keys = layer.weightTrack?.keys;
    return keys?.some((key, index) => key.interpolation !== "step" && key.time < end
      && index + 1 < keys.length && keys[index + 1].time > start);
  }).map(layer => layer.id));
  const names = new Set(layers.map(layer => layer.name));
  let name = "Baked Layers";
  for (let number = 2; names.has(name); number++) name = `Baked Layers ${number}`;
  const result: AnimationLayer = { id: crypto.randomUUID(), name, mode: "override", weight: 1, mute: false,
    solo: selected.some(layer => layer.solo && !layer.mute), locked: false };

  let keyCount = 0;
  let evaluations = 0;
  let maxError = 0;
  let maxAllowedFraction = 0;
  const baked: AnimationTrack[] = [];
  for (const [id, ref] of channels) {
    const { targetId, channel } = ref;
    const prefixAt = createRawAnimationChannelSampler(prefix, targetId, channel);
    const suffixAt = createRawAnimationChannelSampler(suffix, targetId, channel);
    const visibility = channel === "visibility";
    const discrete = isDiscreteAttribute(customAttribute(doc, targetId, channel));
    const held = visibility || discrete;
    const contributing = related.get(id)!;
    const events = new Map(frames.map(time => [time, false]));
    let wholeStackCost = 0;
    let suffixCost = 0;
    function addEvents(newEvents: readonly [number, boolean][]) {
      for (const [time, cut] of newEvents) {
        events.set(time, events.get(time) === true || cut);
        if (events.size + keyCount > MAX_BAKED_KEYS) throw Error("This merge exceeds the 25,000 baked-key limit. Shorten the range or merge fewer layers.");
      }
    }
    for (const track of contributing) {
      const inSuffix = track.layerId !== undefined && indices.get(track.layerId)! > last;
      if (held && !inSuffix && track.layerId && continuousWeights.has(track.layerId))
        throw Error("A Visibility, Boolean, or Enum curve in the merge stack uses a continuous layer weight. Change its weight keys to Step before merging.");
      const weightEvents = track.layerId ? animatedWeights.get(track.layerId) : undefined;
      const trackCost = weightEvents ? 2 : 1;
      wholeStackCost += trackCost;
      if (inSuffix) suffixCost += trackCost;
      addEvents(curveEvents(track.keys, start, end, held));
      if (weightEvents) addEvents(weightEvents);
    }
    function spend(cost: number) {
      evaluations += cost;
      if (evaluations > MAX_CURVE_EVALUATIONS)
        throw Error("The merge exceeds 300,000 source curve evaluations. Shorten the range, increase Sample By, or merge fewer layers.");
    }
    const times = [...events.keys()].sort((a, b) => a - b);
    const intervals: { time: number; cut: boolean }[] = [{ time: start, cut: false }];
    for (const time of times.slice(1)) {
      const isCut = events.get(time)!;
      if (!held && isCut) {
        // Give a known discontinuity a Step segment immediately before its
        // authored time, with the preceding segment free to remain linear.
        const before = adjacentFrame(time, false);
        if (before > intervals[intervals.length - 1].time) intervals.push({ time: before, cut: false });
      }
      intervals.push({ time, cut: !held && isCut });
    }
    const keys: CurveKey[] = [];
    const cache = new Map<number, { value: number; full: number }>();
    function sample(time: number) {
      const previous = cache.get(time);
      if (previous) return previous;
      spend(wholeStackCost);
      const value = prefixAt(time);
      const full = suffixAt(time, value);
      if (![value, full].every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1e12))
        throw Error(`The ${channel} merge exceeds the supported channel value range.`);
      const sampled = { value, full };
      cache.set(time, sampled);
      return sampled;
    }
    function append(time: number, value: number, step: boolean) {
      if (++keyCount > MAX_BAKED_KEYS) throw Error("This merge exceeds the 25,000 baked-key limit. Shorten the range or merge fewer layers.");
      keys.push(newKey(time, value, step ? "step" : "linear"));
    }
    function refine(from: number, to: number, step: boolean, depth = 0) {
      const left = sample(from);
      const right = sample(to);
      let localMaxError = 0;
      let localMaxFraction = 0;
      const probes = [.25, .5, .75].map(fraction => from + (to - from) * fraction);
      if (held) probes.push(adjacentFrame(from, true), adjacentFrame(to, false));
      for (const time of probes) {
        if (time <= from || time >= to) continue;
        const { value, full } = sample(time);
        const estimate = step ? left.value : left.value + (right.value - left.value) * ((time - from) / (to - from));
        spend(suffixCost);
        const estimatedFull = suffixAt(time, estimate);
        const prefixError = Math.abs(value - estimate);
        const fullError = Math.abs(full - estimatedFull);
        const allowed = (expected: number) => ABS_TOLERANCE + REL_TOLERANCE * Math.abs(expected);
        const errorFraction = Math.max(prefixError / allowed(value), fullError / allowed(full));
        const changesDiscreteOutput = (discrete && value !== estimate) || (visibility && (full >= .5) !== (estimatedFull >= .5));
        if (!Number.isFinite(errorFraction) || errorFraction > 1 || changesDiscreteOutput) {
          const midpoint = from + (to - from) * .5;
          if (depth >= 56 || midpoint <= from || midpoint >= to)
            throw Error(`The ${channel} merge could not preserve a transition within tolerance.`);
          refine(from, midpoint, step, depth + 1);
          refine(midpoint, to, step, depth + 1);
          return;
        }
        localMaxError = Math.max(localMaxError, fullError);
        localMaxFraction = Math.max(localMaxFraction, errorFraction);
      }
      maxError = Math.max(maxError, localMaxError);
      maxAllowedFraction = Math.max(maxAllowedFraction, localMaxFraction);
      append(from, left.value, step);
    }
    for (let index = 1; index < intervals.length; index++) {
      const before = intervals[index - 1], next = intervals[index];
      refine(before.time, next.time, held || next.cut);
    }
    append(end, sample(end).value, held);
    baked.push({ id: crypto.randomUUID(), targetId, channel, keys, layerId: result.id });
  }
  const nextAnimation: AnimationData = {
    ...animation,
    layers: layers.flatMap((layer, index) => index === first ? [result] : selectedIds.has(layer.id) ? [] : [layer]),
    tracks: [...retained, ...baked],
    activeLayerId: result.id,
  };
  const next = { ...doc, animation: nextAnimation };
  validateAnimation(nextAnimation, doc);
  validateParticleEmitters(next);
  return {
    summary: { name, layerCount: selected.length, curveCount: baked.length, keyCount, maxError, maxAllowedFraction, evaluations },
    commit(store: SceneStore) {
      if (store.getState().document !== doc) throw Error("Animation changed since preview. Preview the merge again.");
      store.setState({ document: next, editLabel: "Merge animation layers" });
    },
  };
}
