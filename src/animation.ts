import { isDiscreteAttribute, validDiscreteValue } from "./custom-attribute-types.ts";
import { attributesFor, customAttribute, customChannel, isCustomChannel, boundedAttributeValue, type CustomChannel } from "./custom-attributes.ts";
import { CubicBezierCurve, Vector2 } from "three";
import { validateParticleEmitters } from "./particle-emitter.ts";
import type { SceneDocument, TransformChannels } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export const POSE_ANIMATION_CHANNELS = [
  "position.x", "position.y", "position.z", "rotation.x", "rotation.y", "rotation.z",
  "scale.x", "scale.y", "scale.z", "visibility",
] as const;
export const ANIMATION_CHANNELS = [...POSE_ANIMATION_CHANNELS, "ik.blend"] as const;
export type PoseAnimationChannel = typeof POSE_ANIMATION_CHANNELS[number];
export type AnimationChannel = typeof ANIMATION_CHANNELS[number] | `morph.${number}` | CustomChannel;
export type CurveKey = {
  id: string;
  time: number;
  value: number;
  interpolation: "step" | "linear" | "bezier";
  tangentMode: "auto" | "clamped" | "flat" | "spline" | "fixed";
  inSlope?: number;
  outSlope?: number;
  /** Handle length as a fraction of its adjoining segment's duration. */
  inWeight?: number;
  outWeight?: number;
  broken?: boolean;
};
export type AnimationTrack = { id: string; targetId: string; channel: AnimationChannel; keys: CurveKey[]; layerId?: string };
export type LayerWeightTrack = { id: string; keys: CurveKey[] };
export type AnimationLayer = { weightTrack?: LayerWeightTrack; id: string; name: string; mode: "additive" | "override"; weight: number; mute: boolean; solo: boolean; locked: boolean };
export type AnimationData = { fps: number; start: number; end: number; loop: boolean; tracks: AnimationTrack[]; layers?: AnimationLayer[]; activeLayerId?: string };
export type AnimationPose = TransformChannels & { visibility: number; morphWeights?: number[]; customValues?: Record<string, number> };
export const isAnimationChannel = (channel: string): channel is AnimationChannel => (ANIMATION_CHANNELS as readonly string[]).includes(channel) || isCustomChannel(channel) || /^morph\.(0|[1-9][0-9]{0,2})$/.test(channel);
const morphDefaultsCache = new WeakMap<SceneDocument, ReadonlyMap<string, import("./scene-document.ts").MeshShapeNode>>();
function morphDefaults(doc: SceneDocument, id: string) {
  let shapes = morphDefaultsCache.get(doc);
  if (!shapes) {
    shapes = new Map(Object.values(doc.nodes).filter((n): n is import("./scene-document.ts").MeshShapeNode => n.type === "meshShape" && !!n.morphTargets?.length).map(n => [n.parentId, n]));
    morphDefaultsCache.set(doc, shapes);
  }
  return shapes.get(id);
}
export type KeyClipboard = { tracks: AnimationTrack[]; origin: number };

export function defaultAnimation(): AnimationData {
  return { fps: 24, start: 0, end: 288, loop: true, tracks: [] };
}

function finite(value: unknown, bound = 1e12): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= bound;
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validateCurveKeys(value: unknown): asserts value is CurveKey[] {
  if (!Array.isArray(value) || value.length > 100000) throw Error("Invalid animation keys.");
  const ids = new Set<string>();
  let previous = -Infinity;
  for (const key of value) {
    if (!record(key) || !validId(key.id) || ids.has(key.id) || !finite(key.time, 1e6) || key.time <= previous || !finite(key.value)
      || !["step", "linear", "bezier"].includes(key.interpolation as string)
      || !["auto", "clamped", "flat", "spline", "fixed"].includes(key.tangentMode as string)) throw Error("Invalid animation key or duplicate key time.");
    for (const name of ["inSlope", "outSlope"] as const) if (key[name] !== undefined && !finite(key[name])) throw Error("Invalid tangent slope.");
    for (const name of ["inWeight", "outWeight"] as const) if (key[name] !== undefined && (!finite(key[name]) || key[name] < 0 || key[name] > 1)) throw Error("Tangent weights must be between zero and one.");
    if (key.broken !== undefined && typeof key.broken !== "boolean") throw Error("Invalid tangent linking.");
    ids.add(key.id); previous = key.time;
  }
}

export function validateAnimation(value: unknown, doc: SceneDocument): asserts value is AnimationData {
  if (doc.joints?.some(joint => Object.hasOwn(doc.nodes, joint.id))) throw Error("Joint and object IDs must be distinct.");
  const joints = new Map((doc.joints ?? []).map(joint => [joint.id, joint]));
  const handles = new Map((doc.ikHandles ?? []).map(handle => [handle.id, handle]));
  if (handles.size !== (doc.ikHandles?.length ?? 0) || [...handles.keys()].some(id => Object.hasOwn(doc.nodes, id) || joints.has(id))) throw Error("IK handle, joint and object IDs must be distinct.");
  if (!record(value) || !finite(value.fps, 240) || value.fps < 1 || !finite(value.start, 1e6) || !finite(value.end, 1e6)
    || value.end <= value.start || typeof value.loop !== "boolean" || !Array.isArray(value.tracks) || value.tracks.length > 100000) throw Error("Invalid animation settings.");
  const layerIds = new Set<string>();
  if (value.layers !== undefined && (!Array.isArray(value.layers) || value.layers.length > 1000)) throw Error("Invalid animation layers.");
  for (const layer of value.layers as unknown[] ?? []) {
    if (!record(layer) || !validId(layer.id) || layerIds.has(layer.id) || typeof layer.name !== "string" || !layer.name.trim() || layer.name.length > 200
      || !["additive", "override"].includes(layer.mode as string) || !finite(layer.weight, 1) || layer.weight < 0
      || typeof layer.mute !== "boolean" || typeof layer.solo !== "boolean" || typeof layer.locked !== "boolean") throw Error("Invalid animation layer.");
    layerIds.add(layer.id);
  }
  if (value.activeLayerId !== undefined && (!validId(value.activeLayerId) || !layerIds.has(value.activeLayerId))) throw Error("Active animation layer is missing.");
  const trackIds = new Set<string>(), keyIds = new Set<string>(), channels = new Set<string>();
  let totalKeys = 0;
  for (const layer of value.layers as AnimationLayer[] ?? []) {
    const track = layer.weightTrack;
    if (track === undefined) continue;
    if (!record(track) || !validId(track.id) || trackIds.has(track.id)
      || Object.keys(track).some(name => !["id", "keys"].includes(name))) throw Error("Invalid layer weight track.");
    validateCurveKeys(track.keys);
    for (const key of track.keys) {
      if (key.value < 0 || key.value > 1) throw Error("Layer weight keys must be between zero and one.");
      if (keyIds.has(key.id)) throw Error("Duplicate animation key ID.");
      keyIds.add(key.id);
    }
    totalKeys += track.keys.length; trackIds.add(track.id);
  }
  if (trackIds.size + value.tracks.length > 100000) throw Error("Too many animation tracks.");
  if (totalKeys > 100000) throw Error("Too many animation keys.");
  const driven = new Set((doc.drivenKeys ?? []).map(relation => `${relation.driven.targetId}:${relation.driven.channel}`));
  for (const track of value.tracks) {
    if (!record(track) || !validId(track.id) || trackIds.has(track.id) || !validId(track.targetId)
      || !isAnimationChannel(track.channel as string)) throw Error("Invalid animation track.");
    if ((track.channel as string).startsWith("morph.") && !morphDefaults(doc, track.targetId)?.morphTargets?.[Number((track.channel as string).slice(6))]) throw Error("Morph animation target is missing.");
    if (isCustomChannel(track.channel as string) && !customAttribute(doc, track.targetId, track.channel as string)?.keyable) throw Error("Custom animation attribute is missing or not keyable.");
    const node = doc.nodes[track.targetId], joint = joints.get(track.targetId), handle = handles.get(track.targetId);
    if (node?.type !== "transform" && !joint && !handle) throw Error("Animation target is missing.");
    if (!isCustomChannel(track.channel as string) && (track.channel === "ik.blend") !== !!handle) throw Error("IK blend tracks require an IK handle; pose channels require an object or joint.");
    if (joint && (track.channel as string).startsWith("scale.")) throw Error("Joint scale animation is not supported.");
    if (track.layerId !== undefined && (!validId(track.layerId) || !layerIds.has(track.layerId))) throw Error("Animation track layer is missing.");
    const channelKey = `${track.targetId}:${track.channel}`, layeredChannel = JSON.stringify([track.layerId ?? null, track.targetId, track.channel]);
    if (channels.has(layeredChannel)) throw Error("Duplicate animated channel in a layer.");
    if (driven.has(channelKey)) throw Error("A channel cannot have both time keys and driven keys.");
    validateCurveKeys(track.keys);
    const typedAttribute = customAttribute(doc, track.targetId, track.channel as string);
    if (isDiscreteAttribute(typedAttribute) && track.keys.some(key => key.interpolation !== "step" || !validDiscreteValue(typedAttribute!, key.value))) throw Error("Boolean and Enum time curves require Step interpolation and valid choices.");
    totalKeys += track.keys.length;
    if (totalKeys > 100000) throw Error("Too many animation keys.");
    for (const key of track.keys) {
      if (track.layerId === undefined && track.channel === "ik.blend" && (key.value < 0 || key.value > 1)) throw Error("Base IK blend key values must be between zero and one.");
      if (keyIds.has(key.id)) throw Error("Duplicate animation key ID.");
      keyIds.add(key.id);
    }
    trackIds.add(track.id); channels.add(layeredChannel);
  }
}

function secant(a: CurveKey, b: CurveKey): number { return (b.value - a.value) / (b.time - a.time); }
const segmentCache = new WeakMap<readonly CurveKey[], Map<number, CubicBezierCurve>>();

/** Slopes are value units per frame (degrees per frame for Euler channels). */
export function tangentSlope(keys: readonly CurveKey[], index: number, side: "in" | "out"): number {
  const key = keys[index], previous = keys[index - 1], next = keys[index + 1];
  if (!key || key.tangentMode === "flat") return 0;
  if (key.tangentMode === "fixed") return (side === "in" ? key.inSlope : key.outSlope) ?? 0;
  if (!previous && !next) return 0;
  if (!previous) return secant(key, next);
  if (!next) return secant(previous, key);
  const before = secant(previous, key), after = secant(key, next);
  const slope = secant(previous, next);
  if (key.tangentMode === "spline") return slope;
  // Clamped tangents flatten plateaus. Auto also flattens extrema and limits
  // slopes to avoid crossing neighboring key values on monotonic segments.
  if (before === 0 || after === 0 || (key.tangentMode === "auto" && before * after <= 0)) return 0;
  if (key.tangentMode === "clamped") return slope;
  return Math.sign(slope) * Math.min(Math.abs(slope), 3 * Math.abs(before), 3 * Math.abs(after));
}

/** Freeze effective preset slopes before editing a handle, keeping the other
 * side intact for broken tangents and aligning slopes for linked tangents. */
export function withTangent(keys: readonly CurveKey[], index: number, side: "in" | "out", slope: number, weight?: number): CurveKey {
  const key = keys[index];
  if (!key || !finite(slope) || (weight !== undefined && (!finite(weight) || weight < 0 || weight > 1))) throw Error("Invalid tangent edit.");
  const next: CurveKey = { ...key, interpolation: "bezier", tangentMode: "fixed", inSlope: tangentSlope(keys, index, "in"), outSlope: tangentSlope(keys, index, "out") };
  if (side === "in" || !key.broken) next.inSlope = slope;
  if (side === "out" || !key.broken) next.outSlope = slope;
  if (weight !== undefined) {
    if (side === "in") next.inWeight = weight; else next.outWeight = weight;
  }
  return next;
}

function bezierSegment(keys: readonly CurveKey[], index: number): CubicBezierCurve {
  const a = keys[index], b = keys[index + 1], duration = b.time - a.time;
  const outWeight = a.outWeight ?? 1 / 3, inWeight = b.inWeight ?? 1 / 3;
  let segments = segmentCache.get(keys);
  if (!segments) { segments = new Map(); segmentCache.set(keys, segments); }
  let curve = segments.get(index);
  if (!curve) {
    curve = new CubicBezierCurve(new Vector2(0, a.value),
      new Vector2(outWeight, a.value + tangentSlope(keys, index, "out") * duration * outWeight),
      new Vector2(1 - inWeight, b.value - tangentSlope(keys, index + 1, "in") * duration * inWeight), new Vector2(1, b.value));
    segments.set(index, curve);
  }
  return curve;
}
function bezierParameter(curve: CubicBezierCurve, fraction: number): number {
  // Three evaluates the cubic; bisection finds its monotonic time parameter.
  // Normalize time first to retain precision in scenes far from frame zero.
  if (Math.abs(curve.v1.x - 1 / 3) < 1e-12 && Math.abs(curve.v2.x - 2 / 3) < 1e-12) return fraction;
  let start = 0, end = 1, parameter = fraction;
  const point = new Vector2();
  for (let i = 0; i < 52; i++) {
    parameter = (start + end) / 2;
    const x = curve.getPoint(parameter, point).x;
    if (x === fraction) break;
    if (x < fraction) start = parameter; else end = parameter;
  }
  return parameter;
}

export function evaluateCurve(keys: readonly CurveKey[], time: number): number | undefined {
  if (!Number.isFinite(time)) throw Error("Curve time must be finite.");
  if (!keys.length) return undefined;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  let low = 0, high = keys.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (keys[middle].time <= time) low = middle; else high = middle;
  }
  const a = keys[low], b = keys[high];
  if (time === a.time || a.interpolation === "step") return a.value;
  const fraction = (time - a.time) / (b.time - a.time);
  if (a.interpolation === "linear") return a.value + (b.value - a.value) * fraction;
  const curve = bezierSegment(keys, low);
  return curve.getPoint(bezierParameter(curve, fraction)).y;
}

export function readChannel(channels: TransformChannels & { visibility?: number; morphWeights?: number[]; customValues?: Record<string, number> }, channel: AnimationChannel): number {
  if (channel === "ik.blend") throw Error("IK blend is not a transform pose channel.");
  if (!isAnimationChannel(channel)) throw Error("Unsupported animation channel.");
  if (isCustomChannel(channel)) return channels.customValues?.[channel.slice(7)] ?? 0;
  if (channel.startsWith("morph.")) return channels.morphWeights?.[Number(channel.slice(6))] ?? 0;
  if (channel === "visibility") return channels.visibility ?? 1;
  const [property, axis] = channel.split(".") as [keyof TransformChannels, string];
  return channels[property]["xyz".indexOf(axis)];
}
export function writeChannel(channels: TransformChannels & { visibility?: number; morphWeights?: number[]; customValues?: Record<string, number> }, channel: AnimationChannel, value: number): AnimationPose {
  if (!finite(value)) throw Error("Animation values must be finite.");
  const next: AnimationPose = { ...(channels.customValues ? { customValues: { ...channels.customValues } } : {}), position: [...channels.position], rotation: [...channels.rotation], scale: [...channels.scale], visibility: channels.visibility ?? 1, ...(channels.morphWeights ? { morphWeights: [...channels.morphWeights] } : {}) };
  applyChannel(next, channel, value);
  return next;
}
function applyChannel(next: AnimationPose, channel: AnimationChannel, value: number) {
  if (channel === "ik.blend") throw Error("IK blend is not a transform pose channel.");
  if (!isAnimationChannel(channel)) throw Error("Unsupported animation channel.");
  if (isCustomChannel(channel)) { next.customValues ??= {}; next.customValues[channel.slice(7)] = value; }
  else if (channel.startsWith("morph.")) { next.morphWeights ??= []; next.morphWeights[Number(channel.slice(6))] = value; }
  else if (channel === "visibility") next.visibility = value;
  else {
    const [property, axis] = channel.split(".") as [keyof TransformChannels, string];
    next[property]["xyz".indexOf(axis)] = property === "scale" ? Math.max(0.001, value) : value;
  }
}
export function baseChannels(doc: SceneDocument, id: string): AnimationPose {
  const node = doc.nodes[id], joint = doc.joints?.find(j => j.id === id);
  const handle = doc.ikHandles?.find(handle => handle.id === id);
  if (node?.type !== "transform" && !joint && !handle) throw Error("Animation target is missing.");
  if (handle && !attributesFor(doc, id).length) throw Error("Animation target is missing.");
  if (handle) return { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1], visibility: 1, customValues: Object.fromEntries(attributesFor(doc, id).map(item => [item.id, item.value])) };
  return {
    ...(attributesFor(doc, id).length ? { customValues: Object.fromEntries(attributesFor(doc, id).map(item => [item.id, item.value])) } : {}),
    ...(morphDefaults(doc, id)?.morphTargets ? { morphWeights: morphDefaults(doc, id)!.morphTargets!.map(m => m.weight) } : {}),
    position: [...(node?.type === "transform" ? node.position : joint!.position)],
    rotation: [...(node?.type === "transform" ? node.rotation : joint!.rotation ?? [0, 0, 0])],
    scale: node?.type === "transform" ? [...node.scale] : [1, 1, 1], visibility: 1,
  };
}

// Compile immutable animation revisions once. A channel stores only its own
// enabled layer contributions, so per-frame evaluation is linear in tracks;
// unrelated layers and other objects are never searched in the inner loop.
type LayerContribution = { layer: AnimationLayer; track?: AnimationTrack };
type CompiledChannel = { base?: AnimationTrack; layers: LayerContribution[] };
type CompiledTarget = { channels: Map<AnimationChannel, CompiledChannel> };
type CompiledAnimation = { dynamic: AnimationLayer[]; targets: Map<string, CompiledTarget>; enabled: Map<string, AnimationLayer>; order: Map<string, number> };
const animationIndexes = new WeakMap<AnimationData, CompiledAnimation>();
const emptyAnimationIndex: CompiledAnimation = { dynamic: [], targets: new Map(), enabled: new Map(), order: new Map() };
function animationIndex(animation?: AnimationData): CompiledAnimation {
  if (!animation) return emptyAnimationIndex;
  const cached = animationIndexes.get(animation); if (cached) return cached;
  const enabled = new Map(activeLayers(animation).map(layer => [layer.id, layer]));
  const order = new Map((animation.layers ?? []).map((layer, index) => [layer.id, index]));
  const targets = new Map<string, CompiledTarget>();
  for (const track of animation.tracks) {
    let target = targets.get(track.targetId);
    if (!target) { target = { channels: new Map() }; targets.set(track.targetId, target); }
    let channel = target.channels.get(track.channel);
    if (!channel) { channel = { layers: [] }; target.channels.set(track.channel, channel); }
    if (track.layerId === undefined) channel.base = track;
    else { const layer = enabled.get(track.layerId); if (layer) channel.layers.push({ layer, track }); }
  }
  for (const target of targets.values()) for (const channel of target.channels.values())
    channel.layers.sort((a, b) => order.get(a.layer.id)! - order.get(b.layer.id)!);
  const compiled = { targets, enabled, order, dynamic: [...enabled.values()].filter(layer => !!layer.weightTrack?.keys.length) }; animationIndexes.set(animation, compiled); return compiled;
}
/** Base has no layerId. All editors use this view; ownership validation scans
 * the complete flat track list, including muted and locked layers. */
export function editingTracks(doc: SceneDocument): AnimationTrack[] {
  const animation = doc.animation;
  return (animation?.tracks ?? []).filter(track => track.layerId === animation?.activeLayerId);
}
export function assertAnimationLayerEditable(doc: SceneDocument): void {
  const id = doc.animation?.activeLayerId;
  if (id === undefined) return;
  const layer = doc.animation?.layers?.find(layer => layer.id === id);
  if (!layer) throw Error("Active animation layer is missing.");
  if (layer.locked) throw Error("The active animation layer is locked. Unlock it before editing keys.");
}
function assertActiveTracks(doc: SceneDocument, tracks: readonly AnimationTrack[]) {
  assertAnimationLayerEditable(doc);
  if (tracks.some(track => track.layerId !== doc.animation?.activeLayerId)) throw Error("Select the curve's active layer before editing its keys.");
}
function activeLayerFields(doc: SceneDocument): { layerId?: string } {
  return doc.animation?.activeLayerId === undefined ? {} : { layerId: doc.animation.activeLayerId };
}
const enabledLayerCache = new WeakMap<AnimationData, AnimationLayer[]>();
function activeLayers(animation?: AnimationData): AnimationLayer[] {
  if (!animation) return [];
  const cached = enabledLayerCache.get(animation); if (cached) return cached;
  const layers = animation?.layers ?? [], solo = layers.some(layer => layer.solo && !layer.mute);
  const result = layers.filter(layer => !layer.mute && (!solo || layer.solo) && (layer.weight > 0 || !!layer.weightTrack?.keys.length));
  enabledLayerCache.set(animation, result); return result;
}
/** Independent layer-owned curve; this never reads SDK channels or mutates a layer. */
export function evaluateLayerWeight(layer: AnimationLayer, frame: number): number {
  if (!Number.isFinite(frame)) throw Error("Animation frame must be finite.");
  return Math.max(0, Math.min(1, (layer.weightTrack ? evaluateCurve(layer.weightTrack.keys, frame) : undefined) ?? layer.weight));
}
type SampledWeights = ReadonlyMap<AnimationLayer, number> | undefined;
function sampleLayerWeights(index: CompiledAnimation, frame: number): SampledWeights {
  if (!index.dynamic.length) return undefined;
  const weights = new Map<AnimationLayer, number>();
  for (const layer of index.dynamic) weights.set(layer, evaluateLayerWeight(layer, frame));
  return weights;
}
function trackValue(track: AnimationTrack, frame: number): number | undefined {
  // Time visibility is held at key boundaries. Layer values stay scalar until
  // the complete stack is mixed; rendering uses the final .5 threshold.
  return track.channel === "visibility" && track.layerId === undefined ? evaluateVisibility(track.keys, frame)
    : track.channel === "visibility" ? evaluateHeld(track.keys, frame) : evaluateCurve(track.keys, frame);
}
function evaluateHeld(keys: CurveKey[], frame: number): number | undefined {
  if (!keys.length) return undefined;
  let low = 0, high = keys.length;
  while (low + 1 < high) { const middle = (low + high) >>> 1; if (keys[middle].time <= frame) low = middle; else high = middle; }
  return keys[low].value;
}
/** Affine stack in one prospective active-layer value. This powers both
 * evaluation and exact inverse keying without temporary document mutations. */
function channelStack(doc: SceneDocument, id: string, channel: AnimationChannel, frame: number, fallback: number, variable = false, weights?: SampledWeights): { offset: number; gain: number } {
  const index = animationIndex(doc.animation), compiled = index.targets.get(id)?.channels.get(channel), active = doc.animation?.activeLayerId;
  const discrete = isDiscreteAttribute(customAttribute(doc, id, channel));
  const sample = (track: AnimationTrack) => discrete ? evaluateHeld(track.keys, frame) : trackValue(track, frame);
  const base = compiled?.base, baseValue = base ? sample(base) : undefined;
  let contributions = compiled?.layers ?? [];
  // Keying a previously absent curve introduces one prospective contribution.
  // This does not mutate the cached plan or any authored scene data.
  const prospective = variable && active !== undefined ? index.enabled.get(active) : undefined;
  if (prospective && !contributions.some(entry => entry.layer.id === active))
    contributions = [...contributions, { layer: prospective }].sort((a, b) => index.order.get(a.layer.id)! - index.order.get(b.layer.id)!);
  let offset = variable && active === undefined ? 0 : baseValue ?? fallback, gain = variable && active === undefined ? 1 : 0;
  for (const { layer, track } of contributions) {
    const isVariable = variable && active === layer.id;
    const value = track ? sample(track) : undefined;
    if (value === undefined && !isVariable) continue;
    const w = weights?.get(layer) ?? layer.weight;
    if (discrete) {
      if (w >= .5) { offset = isVariable ? 0 : value!; gain = isVariable ? 1 : 0; }
      continue;
    }
    const override = layer.mode === "override" || channel === "visibility";
    if (isVariable) {
      if (override) { offset *= 1 - w; gain = w; }
      else if (channel.startsWith("scale.")) { gain = offset * w; offset *= 1 - w; }
      else gain = w;
    } else if (override) { offset = offset * (1 - w) + value! * w; gain *= 1 - w; }
    else if (channel.startsWith("scale.")) { const factor = 1 + w * (value! - 1); offset *= factor; gain *= factor; }
    else offset += value! * w;
  }
  return { offset, gain };
}
function effectiveValue(channel: AnimationChannel, value: number): number {
  if (!finite(value)) throw Error("Animation layer evaluation exceeds the supported value range.");
  if (channel.startsWith("scale.")) return Math.max(0.001, value);
  if (channel === "visibility" || channel === "ik.blend") return Math.max(0, Math.min(1, value));
  return value;
}
function keyedLayerValue(doc: SceneDocument, id: string, channel: AnimationChannel, frame: number, requested: number, weights?: SampledWeights): number {
  assertAnimationLayerEditable(doc);
  if (!finite(requested)) throw Error("Animation values must be finite.");
  if (!doc.animation?.layers?.length) return requested;
  const fallback = channel === "ik.blend" ? doc.ikHandles!.find(handle => handle.id === id)!.blend : readChannel(baseChannels(doc, id), channel);
  const { offset, gain } = channelStack(doc, id, channel, frame, fallback, true, weights);
  if (!Number.isFinite(gain) || Math.abs(gain) < 1e-12) throw Error("The active layer has no influence on this channel: it is muted, has zero weight, is excluded by solo, or is masked by another layer.");
  const value = (requested - offset) / gain;
  if (!finite(value)) throw Error("The requested pose requires an unsupported layer value. Increase the layer weight.");
  if (channel === "visibility" && doc.animation.activeLayerId === undefined
    && Math.abs(effectiveValue(channel, offset + gain * (value >= 0.5 ? 1 : 0)) - requested) > 1e-9)
    throw Error("Base visibility is discrete and cannot produce this layered result. Key visibility on an override layer or adjust the other layers.");
  return value;
}
/** Blend is an ordinary curve with bounded effective output, independent of
 * the handle's enabled state. Empty tracks retain the literal fallback. */
export function evaluateIKBlend(doc: SceneDocument, id: string, frame: number): number {
  if (!Number.isFinite(frame)) throw Error("Animation frame must be finite.");
  return sampledIKBlend(doc, id, frame, sampleLayerWeights(animationIndex(doc.animation), frame));
}
function sampledIKBlend(doc: SceneDocument, id: string, frame: number, weights: SampledWeights): number {
  const handle = doc.ikHandles?.find(handle => handle.id === id);
  if (!handle) throw Error("IK animation target is missing.");
  return effectiveValue("ik.blend", channelStack(doc, id, "ik.blend", frame, handle.blend, false, weights).offset);
}
export function evaluateChannels(doc: SceneDocument, id: string, frame: number): AnimationPose {
  if (!Number.isFinite(frame)) throw Error("Animation frame must be finite.");
  return sampledChannels(doc, id, frame, sampleLayerWeights(animationIndex(doc.animation), frame));
}
function sampledChannels(doc: SceneDocument, id: string, frame: number, weights: SampledWeights): AnimationPose {
  const pose = baseChannels(doc, id);
  for (const channel of animationIndex(doc.animation).targets.get(id)?.channels.keys() ?? []) {
    if (channel === "ik.blend") continue;
    const value = channelStack(doc, id, channel, frame, readChannel(pose, channel), false, weights).offset;
    applyChannel(pose, channel, isCustomChannel(channel) ? boundedAttributeValue(customAttribute(doc, id, channel)!, value) : effectiveValue(channel, value));
  }
  return pose;
}

/** One fresh pose map per frame, linear in scene size and track count. */
export function evaluateSceneAnimation(doc: SceneDocument, frame: number): Map<string, AnimationPose> {
  if (!Number.isFinite(frame)) throw Error("Animation frame must be finite.");
  const poses = new Map<string, AnimationPose>(), weights = sampleLayerWeights(animationIndex(doc.animation), frame);
  for (const node of Object.values(doc.nodes)) if (node.type === "transform") {
    poses.set(node.id, baseChannels(doc, node.id));
  }
  for (const joint of doc.joints ?? []) {
    poses.set(joint.id, baseChannels(doc, joint.id));
  }
  for (const handle of doc.ikHandles ?? []) if (attributesFor(doc, handle.id).length) poses.set(handle.id, baseChannels(doc, handle.id));
  for (const [id, pose] of poses) {
    for (const channel of animationIndex(doc.animation).targets.get(id)?.channels.keys() ?? []) {
      if (channel === "ik.blend") continue;
      const value = channelStack(doc, id, channel, frame, readChannel(pose, channel), false, weights).offset;
      applyChannel(pose, channel, isCustomChannel(channel) ? boundedAttributeValue(customAttribute(doc, id, channel)!, value) : effectiveValue(channel, value));
    }
  }
  return poses;
}

function evaluateVisibility(keys: CurveKey[], frame: number): number | undefined {
  if (!keys.length) return undefined;
  let low = 0, high = keys.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (keys[middle].time <= frame) low = middle; else high = middle;
  }
  return keys[low].value >= 0.5 ? 1 : 0;
}

function saveAnimation(store: SceneStore, animation: AnimationData, editLabel: string) {
  const doc = store.getState().document;
  for (const track of animation.tracks) {
    const attribute = customAttribute(doc, track.targetId, track.channel);
    if (attribute?.locked && JSON.stringify(track) !== JSON.stringify(doc.animation?.tracks.find(item => item.id === track.id))) throw Error("Unlock the attribute before editing its curve.");
  }
  for (const track of doc.animation?.tracks ?? []) if (customAttribute(doc, track.targetId, track.channel)?.locked && !animation.tracks.some(item => item.id === track.id)) throw Error("Unlock the attribute before deleting its curve.");
  validateAnimation(animation, doc);
  validateParticleEmitters({ ...doc, animation });
  if (JSON.stringify(doc.animation ?? defaultAnimation()) === JSON.stringify(animation)) return;
  store.setState({ document: { ...doc, animation }, editLabel });
}
export function channelsForTarget(doc: SceneDocument, id: string): AnimationChannel[] {
  const node = doc.nodes[id], joint = doc.joints?.find(joint => joint.id === id), handle = doc.ikHandles?.find(handle => handle.id === id);
  if (handle && (node || joint)) throw Error("IK handle, joint and object IDs must be distinct.");
  const custom = attributesFor(doc, id).filter(item => item.keyable).map(customChannel);
  if (handle) return ["ik.blend", ...custom];
  if (node?.type === "transform") return [...POSE_ANIMATION_CHANNELS, ...custom, ...(morphDefaults(doc, id)?.morphTargets ?? []).map((_, i) => `morph.${i}` as AnimationChannel)];
  if (joint) return [...POSE_ANIMATION_CHANNELS.filter(channel => !channel.startsWith("scale.")), ...custom];
  throw Error("Animation target is missing.");
}
function targetChannels(doc: SceneDocument, id: string): AnimationChannel[] {
  return channelsForTarget(doc, id).filter(channel => !customAttribute(doc, id, channel)?.locked && channel !== "visibility"
    && !doc.drivenKeys?.some(relation => relation.driven.targetId === id && relation.driven.channel === channel));
}
function newKey(time: number, value: number): CurveKey {
  return { id: crypto.randomUUID(), time, value, interpolation: "bezier", tangentMode: "auto" };
}
function withKey(track: AnimationTrack, frame: number, value: number): AnimationTrack {
  const existing = track.keys.find(key => key.time === frame);
  return { ...track, keys: existing ? track.keys.map(key => key === existing ? { ...key, value } : key)
    : [...track.keys, newKey(frame, value)].sort((a, b) => a.time - b.time) };
}

/** Pure document update so a transform edit and Auto Key share one undo step. */
export function keyChannels(doc: SceneDocument, id: string, channels: (TransformChannels & { visibility?: number; morphWeights?: number[]; customValues?: Record<string, number> }) | number, frame: number, onlyExisting = true): SceneDocument {
  if (!finite(frame, 1e6)) throw Error("Invalid key frame.");
  const supported = channelsForTarget(doc, id), isHandle = supported[0] === "ik.blend";
  if (isHandle !== (typeof channels === "number")) throw Error("IK handles require a numeric blend; objects and joints require transform channels.");
  if (isHandle && (!finite(channels) || channels < 0 || channels > 1)) throw Error("IK blend key values must be between zero and one.");
  const animation = doc.animation ?? defaultAnimation();
  const weights = sampleLayerWeights(animationIndex(animation), frame);
  let tracks = [...animation.tracks];
  const evaluated = onlyExisting ? (isHandle ? sampledIKBlend(doc, id, frame, weights) : sampledChannels(doc, id, frame, weights)) : undefined;
  for (const channel of targetChannels(doc, id).filter(channel => !isCustomChannel(channel))) {
    const index = tracks.findIndex(track => track.targetId === id && track.channel === channel && track.layerId === animation.activeLayerId);
    if (index < 0 && onlyExisting) continue;
    const track = index < 0 ? { id: crypto.randomUUID(), targetId: id, channel, keys: [], ...activeLayerFields(doc) } : tracks[index];
    if (onlyExisting && !track.keys.length) continue;
    const value = typeof channels === "number" ? channels : readChannel(channels, channel);
    if (evaluated !== undefined && Math.abs((typeof evaluated === "number" ? evaluated : readChannel(evaluated, channel)) - value) < 1e-10) continue;
    const next = withKey(track, frame, keyedLayerValue(doc, id, channel, frame, value, weights));
    if (index < 0) tracks.push(next); else tracks[index] = next;
  }
  if (JSON.stringify(animation.tracks) === JSON.stringify(tracks)) return doc;
  const nextAnimation = { ...animation, tracks };
  validateAnimation(nextAnimation, doc);
  return { ...doc, animation: nextAnimation };
}

export function setKeys(store: SceneStore, targetIds: Iterable<string>, frame: number,
  poses?: ReadonlyMap<string, TransformChannels & { visibility?: number; morphWeights?: number[]; customValues?: Record<string, number> }>, channels?: AnimationChannel[]) {
  const doc = store.getState().document, animation = doc.animation ?? defaultAnimation();
  if (!finite(frame, 1e6)) throw Error("Invalid key frame.");
  const weights = sampleLayerWeights(animationIndex(animation), frame);
  let tracks = [...animation.tracks];
  for (const targetId of new Set(targetIds)) {
    const supported = channelsForTarget(doc, targetId), isHandle = supported[0] === "ik.blend";
    const pose = isHandle && !attributesFor(doc, targetId).length ? undefined : poses?.get(targetId) ?? sampledChannels(doc, targetId, frame, weights);
    for (const channel of channels ?? targetChannels(doc, targetId)) {
      if (channel.startsWith("scale.") && doc.joints?.some(joint => joint.id === targetId)) throw Error("Joint scale animation is not supported.");
      if (!supported.includes(channel)) throw Error("The selected animation channel is not supported by this target.");
      const index = tracks.findIndex(track => track.targetId === targetId && track.channel === channel && track.layerId === animation.activeLayerId);
      const track = index < 0 ? { id: crypto.randomUUID(), targetId, channel, keys: [], ...activeLayerFields(doc) } : tracks[index];
      const attribute = customAttribute(doc, targetId, channel);
      if (attribute?.locked) throw Error("Unlock the attribute before setting keys.");
      const requested = channel === "ik.blend" ? sampledIKBlend(doc, targetId, frame, weights) : readChannel(pose!, channel);
      let next = withKey(track, frame, keyedLayerValue(doc, targetId, channel, frame, requested, weights));
      if (isDiscreteAttribute(attribute)) next = { ...next, keys: next.keys.map(key => ({ ...key, interpolation: "step" })) };
      if (index < 0) tracks.push(next); else tracks[index] = next;
    }
  }
  saveAnimation(store, { ...animation, tracks }, "Set keyframe");
}

/** Key a scalar IK blend without constructing or modifying a transform pose. */
export function setIKBlendKey(store: SceneStore, id: string, frame: number, value: number): void {
  if (!finite(frame, 1e6)) throw Error("Invalid key frame.");
  if (!finite(value) || value < 0 || value > 1) throw Error("IK blend key values must be between zero and one.");
  const doc = store.getState().document;
  if (channelsForTarget(doc, id)[0] !== "ik.blend") throw Error("Choose an IK handle to key its blend.");
  const animation = doc.animation ?? defaultAnimation(), tracks = [...animation.tracks];
  const index = tracks.findIndex(track => track.targetId === id && track.channel === "ik.blend" && track.layerId === animation.activeLayerId);
  const track: AnimationTrack = index < 0 ? { id: crypto.randomUUID(), targetId: id, channel: "ik.blend", keys: [], ...activeLayerFields(doc) } : tracks[index];
  const next = withKey(track, frame, keyedLayerValue(doc, id, "ik.blend", frame, value, sampleLayerWeights(animationIndex(animation), frame)));
  if (index < 0) tracks.push(next); else tracks[index] = next;
  saveAnimation(store, { ...animation, tracks }, "Key IK blend");
}

export function replaceTracks(store: SceneStore, replacements: AnimationTrack[], label = "Edit animation curves") {
  const doc = store.getState().document, animation = doc.animation ?? defaultAnimation();
  assertAnimationLayerEditable(doc);
  const existing = new Map(animation.tracks.map(track => [track.id, track]));
  const normalized = replacements.map(track => {
    const original = existing.get(track.id);
    if (original) {
      assertActiveTracks(doc, [original]);
      if (track.layerId !== original.layerId || track.targetId !== original.targetId || track.channel !== original.channel)
        throw Error("Editing keys cannot change the track's layer, target or channel.");
      return track;
    }
    if (track.layerId !== undefined && track.layerId !== animation.activeLayerId) throw Error("New curves belong to the active layer.");
    return { ...track, ...activeLayerFields(doc) };
  });
  const byId = new Map(normalized.map(track => [track.id, structuredClone(track)]));
  if (byId.size !== replacements.length) throw Error("Duplicate animation track ID.");
  const tracks = animation.tracks.map(track => {
    const replacement = byId.get(track.id);
    byId.delete(track.id); return replacement ?? track;
  });
  tracks.push(...byId.values());
  saveAnimation(store, { ...animation, tracks }, label);
}
export function upsertTrack(store: SceneStore, track: AnimationTrack) { replaceTracks(store, [track]); }

/** Insert at the evaluated value without changing the curve. Existing keys are
 * returned unchanged. Adjacent presets become fixed tangents to retain shape. */
export function insertKey(store: SceneStore, trackId: string, time: number): string {
  if (!finite(time, 1e6)) throw Error("Invalid insert frame.");
  const animation = store.getState().document.animation ?? defaultAnimation();
  const track = animation.tracks.find(track => track.id === trackId);
  if (!track) throw Error("Select an existing animation curve.");
  assertActiveTracks(store.getState().document, [track]);
  const { keys, id } = insertCurveKey(track.keys, time, { discrete: track.channel === "visibility" });
  if (track.keys.some(key => key.id === id)) return id;
  saveAnimation(store, { ...animation, tracks: animation.tracks.map(candidate => candidate.id === trackId ? { ...track, keys } : candidate) }, "Insert keyframe");
  return id;
}

/** Split a curve without changing its evaluated shape. Discrete evaluation is
 * opt-in: driven visibility curves use the same continuous math as other SDKs. */
export function insertCurveKey(source: readonly CurveKey[], time: number, options: { discrete?: boolean } = {}): { keys: CurveKey[]; id: string } {
  if (!finite(time, 1e6)) throw Error("Invalid curve coordinate.");
  validateCurveKeys(source);
  if (options.discrete !== undefined && typeof options.discrete !== "boolean") throw Error("Invalid discrete curve option.");
  const existing = source.find(key => key.time === time);
  if (existing) return { keys: [...source], id: existing.id };
  if (!source.length) throw Error("Set the first key before inserting into a curve.");
  const keys = [...source], value = evaluateCurve(source, time)!;
  const inserted: CurveKey = { ...newKey(time, value), tangentMode: "fixed", inSlope: 0, outSlope: 0 };
  const freeze = (index: number): CurveKey => ({ ...keys[index], tangentMode: "fixed",
    inSlope: tangentSlope(source, index, "in"), outSlope: tangentSlope(source, index, "out") });
  if (time < keys[0].time) {
    keys[0] = freeze(0); inserted.interpolation = "step"; keys.unshift(inserted);
  } else if (time > keys[keys.length - 1].time) {
    const last = keys.length - 1;
    keys[last] = { ...freeze(last), interpolation: "step" }; inserted.interpolation = "step"; keys.push(inserted);
  } else {
    const index = keys.findIndex(key => key.time > time) - 1;
    const a = freeze(index), b = freeze(index + 1), duration = b.time - a.time;
    // Visibility is discrete in scene evaluation even for legacy curves whose
    // serialized interpolation says Bezier. Preserve its held state.
    if (options.discrete) { a.interpolation = "step"; inserted.value = a.value; }
    inserted.interpolation = a.interpolation;
    if (a.interpolation === "linear") inserted.inSlope = inserted.outSlope = (b.value - a.value) / duration;
    if (a.interpolation === "bezier") {
      const curve = bezierSegment(source, index), fraction = (time - a.time) / duration;
      const u = bezierParameter(curve, fraction);
      // De Casteljau splits the original control polygon using Three's vector
      // operations; the time parameter is the same one used by evaluation.
      const left1 = curve.v0.clone().lerp(curve.v1, u), center = curve.v1.clone().lerp(curve.v2, u), right2 = curve.v2.clone().lerp(curve.v3, u);
      const left2 = left1.clone().lerp(center, u), right1 = center.clone().lerp(right2, u);
      const split = left2.clone().lerp(right1, u);
      const failure = () => Error("This insertion needs a vertical or out-of-segment tangent. Adjust tangent weights before inserting here.");
      const weight = (value: number) => {
        if (!Number.isFinite(value) || value < -1e-10 || value > 1 + 1e-10) throw failure();
        return Math.max(0, Math.min(1, value));
      };
      const slope = (dx: number, dy: number) => {
        if (Math.abs(dx) < 1e-15) { if (Math.abs(dy) > 1e-12) throw failure(); return 0; }
        const result = dy / (dx * duration);
        if (!finite(result)) throw failure();
        return result;
      };
      inserted.value = split.y;
      a.outWeight = weight(left1.x / fraction);
      b.inWeight = weight((1 - right2.x) / (1 - fraction));
      inserted.inWeight = weight((fraction - left2.x) / fraction);
      inserted.outWeight = weight((right1.x - fraction) / (1 - fraction));
      inserted.inSlope = slope(fraction - left2.x, split.y - left2.y);
      inserted.outSlope = slope(right1.x - fraction, right1.y - split.y);
      // A zero-length handle has no effect; use the other side's slope so the
      // inserted key remains linked when a handle is subsequently extended.
      if (inserted.inWeight === 0) inserted.inSlope = inserted.outSlope;
      if (inserted.outWeight === 0) inserted.outSlope = inserted.inSlope;
      inserted.broken = false;
    }
    keys.splice(index, 2, a, inserted, b);
  }
  validateCurveKeys(keys);
  return { keys, id: inserted.id };
}

export function deleteKeys(store: SceneStore, keyIds: Iterable<string>) {
  const animation = store.getState().document.animation ?? defaultAnimation(), selected = new Set(keyIds);
  assertActiveTracks(store.getState().document, animation.tracks.filter(track => track.keys.some(key => selected.has(key.id))));
  saveAnimation(store, { ...animation, tracks: animation.tracks.map(track => track.layerId === animation.activeLayerId
    ? { ...track, keys: track.keys.filter(key => !selected.has(key.id)) } : track).filter(track => track.layerId !== animation.activeLayerId || track.keys.length) }, "Delete keyframes");
}
export function patchKeys(store: SceneStore, keyIds: Iterable<string>, patch: Partial<Omit<CurveKey, "id">>) {
  const animation = store.getState().document.animation ?? defaultAnimation(), selected = new Set(keyIds);
  assertActiveTracks(store.getState().document, animation.tracks.filter(track => track.keys.some(key => selected.has(key.id))));
  const tracks = animation.tracks.map(track => ({ ...track, keys: track.keys.map(key => selected.has(key.id) ? { ...key, ...patch, id: key.id } : key).sort((a, b) => a.time - b.time) }));
  saveAnimation(store, { ...animation, tracks }, "Edit keyframes");
}
export function moveKeys(store: SceneStore, keyIds: Iterable<string>, timeDelta: number, valueDelta = 0) {
  if (!finite(timeDelta, 2e6) || !finite(valueDelta)) throw Error("Invalid keyframe movement.");
  const animation = store.getState().document.animation ?? defaultAnimation(), selected = new Set(keyIds);
  assertActiveTracks(store.getState().document, animation.tracks.filter(track => track.keys.some(key => selected.has(key.id))));
  const tracks = animation.tracks.map(track => ({ ...track, keys: track.keys.map(key => selected.has(key.id)
    ? { ...key, time: key.time + timeDelta, value: key.value + valueDelta } : key).sort((a, b) => a.time - b.time) }));
  saveAnimation(store, { ...animation, tracks }, "Move keyframes");
}
/** Scale selected keys around a frame, snapping results to whole frames. */
export function scaleKeys(store: SceneStore, keyIds: Iterable<string>, factor: number, pivot?: number) {
  if (!finite(factor) || factor <= 0 || (pivot !== undefined && !finite(pivot, 1e6))) throw Error("Keyframe scale must be positive and finite.");
  const animation = store.getState().document.animation ?? defaultAnimation(), selected = new Set(keyIds);
  assertActiveTracks(store.getState().document, animation.tracks.filter(track => track.keys.some(key => selected.has(key.id))));
  let origin = pivot ?? Infinity;
  if (pivot === undefined) for (const track of animation.tracks) for (const key of track.keys) if (selected.has(key.id)) origin = Math.min(origin, key.time);
  if (!Number.isFinite(origin)) return;
  const tracks = animation.tracks.map(track => ({ ...track, keys: scaleCurveKeys(track.keys, selected, factor, origin, true) }));
  saveAnimation(store, { ...animation, tracks }, "Scale keyframes");
}

/** Scale curve coordinates; only adjoining selected endpoints share a duration
 * change. Fixed handles preserve value offsets across those scaled segments. */
export function scaleCurveKeys(keys: readonly CurveKey[], selected: ReadonlySet<string>, factor: number, pivot: number, snapToFrames: boolean): CurveKey[] {
  if (!finite(factor) || factor <= 0 || !finite(pivot, 1e6)) throw Error("Keyframe scale must be positive and finite.");
  if (typeof snapToFrames !== "boolean") throw Error("Invalid curve snapping option.");
  validateCurveKeys(keys);
  const scaledTime = (time: number) => {
    const result = pivot + (time - pivot) * factor;
    return snapToFrames ? Math.round(result) : result;
  };
  if (factor === 1 && !snapToFrames) return [...keys];
  const result = keys.map((key, index) => {
    if (!selected.has(key.id)) return key;
    const next = { ...key, time: scaledTime(key.time) };
    // Only segments with both endpoints selected undergo uniform scaling.
    // Preserve their handle value offsets using the actual snapped duration.
    const previous = keys[index - 1], following = keys[index + 1];
    if (key.tangentMode === "fixed" && previous && selected.has(previous.id) && key.inSlope !== undefined) {
      const duration = next.time - scaledTime(previous.time);
      if (duration) next.inSlope = key.inSlope * (key.time - previous.time) / duration;
    }
    if (key.tangentMode === "fixed" && following && selected.has(following.id) && key.outSlope !== undefined) {
      const duration = scaledTime(following.time) - next.time;
      if (duration) next.outSlope = key.outSlope * (following.time - key.time) / duration;
    }
    return Object.keys(next).every(name => next[name as keyof CurveKey] === key[name as keyof CurveKey]) ? key : next;
  }).sort((a, b) => a.time - b.time);
  validateCurveKeys(result);
  return result;
}
export function setAnimationSettings(store: SceneStore, settings: Partial<Pick<AnimationData, "fps" | "start" | "end" | "loop">>) {
  if (Object.keys(settings).some(key => !["fps", "start", "end", "loop"].includes(key))) throw Error("Unsupported animation setting.");
  saveAnimation(store, { ...(store.getState().document.animation ?? defaultAnimation()), ...settings }, "Animation settings");
}
export function copyKeys(doc: SceneDocument, keyIds: Iterable<string>): KeyClipboard {
  const selected = new Set(keyIds), tracks = editingTracks(doc).map(track => ({ ...track, keys: track.keys.filter(key => selected.has(key.id)) })).filter(track => track.keys.length);
  return { tracks: structuredClone(tracks), origin: tracks.length ? tracks.reduce((first, track) => Math.min(first, track.keys[0].time), Infinity) : 0 };
}
/** Paste replaces keys at matching times and preserves relative key timing. */
export function pasteKeys(store: SceneStore, clipboard: KeyClipboard, frame: number, targetId?: string): string[] {
  if (!finite(frame, 1e6) || !finite(clipboard.origin, 1e6)) throw Error("Invalid paste frame.");
  assertAnimationLayerEditable(store.getState().document);
  const animation = store.getState().document.animation ?? defaultAnimation(), tracks = [...animation.tracks], ids: string[] = [];
  for (const source of clipboard.tracks) {
    const destination = targetId ?? source.targetId;
    const index = tracks.findIndex(track => track.targetId === destination && track.channel === source.channel && track.layerId === animation.activeLayerId);
    const track = index < 0 ? { id: crypto.randomUUID(), targetId: destination, channel: source.channel, keys: [], ...activeLayerFields(store.getState().document) } : tracks[index];
    const pasted = source.keys.map(key => ({ ...key, id: crypto.randomUUID(), time: frame + key.time - clipboard.origin }));
    ids.push(...pasted.map(key => key.id));
    const times = new Set(pasted.map(key => key.time));
    const next = { ...track, keys: [...track.keys.filter(key => !times.has(key.time)), ...pasted].sort((a, b) => a.time - b.time) };
    if (index < 0) tracks.push(next); else tracks[index] = next;
  }
  saveAnimation(store, { ...animation, tracks }, "Paste keyframes");
  return ids;
}
