import { Matrix4, PropertyBinding, Vector3, type Bone, type Object3D } from "three";
import { defaultAnimation, evaluateSceneAnimation, type AnimationLayer, type CurveKey } from "./animation.ts";
import { convertFBX, convertFBXTake, inspectFBXRestSkeleton, readFBXMotion } from "./fbx-import.ts";
import { angleQuaternion, jointLocalMatrix, jointLocalQuaternion, jointRotationFromQuaternion } from "./joint-transform.ts";
import { validateScene } from "./project-archive.ts";
import { emptyScene, type SceneDocument } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import type { Joint } from "./skeleton.ts";

const limbs = ["Left", "Right"].flatMap(side => [
  [`${side}Arm`, [`${side}Shoulder`, "Spine", "Spine1", "Spine2"]],
  [`${side}ForeArm`, [`${side}Arm`]],
  [`${side}Hand`, [`${side}ForeArm`]],
  [`${side}UpLeg`, ["Hips"]],
  [`${side}Leg`, [`${side}UpLeg`]],
  [`${side}Foot`, [`${side}Leg`]],
] as [string, string[]][]);

export const MIXAMO_REQUIRED_ROLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Hips", ["", "Root"]], ["Spine", ["Hips"]], ["Neck", ["Spine", "Spine1", "Spine2"]],
  ["Head", ["Neck"]], ...limbs,
];

/** Three's FBX binding name drops namespace separators. Match the original leaf where available. */
export function mixamoBoneRole(name: string): string {
  return (name.trim().split(/[:|]/).at(-1) ?? "").replace(/^.*mixamorig\d*[_-]?/i, "").toLowerCase();
}

type RestBone = ReturnType<typeof inspectFBXRestSkeleton>[number];
type SourceBone = RestBone & { name: string; role: string; id: string };
export type MixamoSource = ReturnType<typeof inspectMixamoSource>;
export type MixamoMappingRow = { source?: SourceBone; role: string; target?: Joint; message?: string };

export function inspectMixamoSource(group: Awaited<ReturnType<typeof readFBXMotion>>, name: string) {
  const bones = inspectFBXRestSkeleton(group).map(row => {
    const name: string = typeof row.bone.userData.originalName === "string" ? row.bone.userData.originalName : row.bone.name;
    return { ...row, name, role: mixamoBoneRole(name), id: row.bone.uuid };
  });
  if (!bones.length || bones.length > 256) throw Error("A motion source requires 1–256 skeleton joints.");
  const takes = group.animations.filter(clip => clip.tracks.length);
  if (!takes.length || takes.length > 100) throw Error("A motion source requires 1–100 nonempty animation takes.");
  const unit = group.userData.unitScaleFactor;
  const unitScale = typeof unit === "number" && Number.isFinite(unit) && unit > 0 ? unit : undefined;
  return { group, name, bones, takes, unitScale };
}

export async function loadMixamoSource(file: File) {
  return inspectMixamoSource(await readFBXMotion(file), file.name);
}

function groupByRole<T>(items: readonly T[], role: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = role(item), matches = groups.get(key);
    if (matches) matches.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export function mixamoTargetJoints(doc: SceneDocument, rootId: string): Joint[] {
  const children = new Map<string, Joint[]>();
  const root = doc.joints?.find(joint => joint.id === rootId && joint.parentId === null);
  if (!root) return [];
  for (const joint of doc.joints ?? []) {
    if (joint.parentId === null) continue;
    const list = children.get(joint.parentId);
    if (list) list.push(joint);
    else children.set(joint.parentId, [joint]);
  }
  const result = [root];
  for (let i = 0; i < result.length; i++) result.push(...children.get(result[i].id) ?? []);
  return result;
}

function targetRole(name: string, rootName: string) {
  const prefix = rootName.match(/^(.*?)(?:hips|root)$/i)?.[1] ?? "";
  return mixamoBoneRole(name.toLowerCase().startsWith(prefix.toLowerCase()) ? name.slice(prefix.length) : name);
}

export function inspectMixamoMapping(source: MixamoSource, doc: SceneDocument, rootId: string, assignments: ReadonlyMap<string, string> = new Map()) {
  const targetJoints = mixamoTargetJoints(doc, rootId);
  const targetById = new Map(targetJoints.map(joint => [joint.id, joint]));
  const targetByRole = groupByRole(targetJoints, joint => targetRole(joint.name, targetJoints[0].name));
  const sourceByRole = groupByRole(source.bones, bone => bone.role);
  const rowById = new Map<string, MixamoMappingRow>();
  const rows: MixamoMappingRow[] = source.bones.map(bone => {
    const exact = assignments.get(bone.id);
    const candidates = targetByRole.get(bone.role) ?? [];
    const target = exact === undefined ? candidates.length === 1 ? candidates[0] : undefined : targetById.get(exact);
    let message: string | undefined;
    if (!bone.role) message = "Unnamed source joint";
    else if (sourceByRole.get(bone.role)!.length > 1) message = "Duplicate source role";
    else if (!target && exact === undefined && candidates.length > 1) message = "Duplicate target role";
    else if (!target) message = "Missing target joint";
    const row = { source: bone, role: bone.role, target, message };
    rowById.set(bone.id, row);
    return row;
  });
  for (const [role, parents] of MIXAMO_REQUIRED_ROLES) {
    const matches = sourceByRole.get(role.toLowerCase());
    if (!matches) {
      rows.push({ role, message: "Missing required source joint" });
      continue;
    }
    for (const match of matches) {
      const parent = match.parent ? source.bones.find(bone => bone.bone === match.parent)?.role : "";
      const row = rowById.get(match.id)!;
      if (!row.message && !parents.some(name => name.toLowerCase() === parent)) row.message = "Unsupported source parent";
    }
  }
  const assigned = groupByRole(rows.filter(row => row.target), row => row.target!.id);
  const sourceToTarget = new Map(rows.flatMap(row => row.source && row.target ? [[row.source.bone, row.target] as const] : []));
  for (const row of rows) {
    if (row.message || !row.source || !row.target) continue;
    const { source, target } = row;
    const parent = source.parent ? sourceToTarget.get(source.parent) : null;
    const a = new Vector3(...source.pose.position), b = new Vector3(...target.position);
    const offsetTolerance = 1e-5 * Math.max(1, a.length(), b.length());
    const angularError = angleQuaternion(source.pose.rotation).angleTo(jointLocalQuaternion(target, target.rotation ?? [0, 0, 0]));
    if (assigned.get(target.id)!.length > 1) row.message = "Target is assigned more than once";
    else if (source.parent === null && target.id !== rootId || parent !== undefined && target.parentId !== (parent?.id ?? null))
      row.message = "Target parent differs from source";
    else if (a.distanceTo(b) > offsetTolerance) row.message = "Rest offset differs (check rig and units)";
    else if (angularError > 1e-4) row.message = "Rest orientation differs (check axes and rig)";
  }
  const errors: string[] = [];
  if (source.bones.filter(bone => bone.parent === null).length !== 1) errors.push("Choose a source with one skeleton root.");
  if (!targetJoints.length) errors.push("Choose a target skeleton root.");
  const targetIds = new Set([...sourceToTarget.values()].map(joint => joint.id));
  if (doc.constraints?.some(row => row.enabled && targetIds.has(row.targetId))
      || doc.ikHandles?.some(handle => handle.enabled && (targetIds.has(handle.rootId) || targetIds.has(handle.endId))))
    errors.push("Disable IK and incoming constraints on mapped joints before importing FK motion.");
  if (doc.drivenKeys?.some(row => targetIds.has(row.driven.targetId) && /^(position|rotation)\./.test(row.driven.channel)))
    errors.push("Remove driven translation or rotation keys from mapped joints before importing.");
  if (doc.animation?.layers?.some(layer => layer.solo && !layer.mute)) errors.push("Turn off Solo in Animation Layers before importing.");
  return { rows, errors, sourceToTarget, targetJoints, valid: !errors.length && !rows.some(row => row.message) };
}

function validateTake(source: MixamoSource, take: MixamoSource["takes"][number]) {
  const byName = new Map<string, Object3D[]>();
  source.group.traverse(object => {
    const list = byName.get(object.name);
    if (list) list.push(object);
    else byName.set(object.name, [object]);
  });
  const bones = new Set<Object3D>(source.bones.map(row => row.bone)), seen = new Set<string>();
  if (!Number.isFinite(take.duration) || take.duration < 0) throw Error("The selected take has an invalid duration.");
  for (const track of take.tracks) {
    const { nodeName, objectName, propertyName, propertyIndex } = PropertyBinding.parseTrackName(track.name);
    const targets = byName.get(nodeName);
    if (targets?.length !== 1) throw Error(`Missing or duplicate FBX binding: ${nodeName}.`);
    if (!bones.has(targets[0]) || objectName || propertyIndex !== undefined || !["position", "quaternion", "scale"].includes(propertyName))
      throw Error(`Unsupported animation binding: ${track.name}. Export baked joint motion Without Skin.`);
    if (seen.has(track.name)) throw Error(`Duplicate FBX animation channel: ${track.name}.`);
    seen.add(track.name);
    const width = propertyName === "quaternion" ? 4 : 3;
    if (!track.times.length || track.values.length !== width * track.times.length
        || track.times.some((time, index) => !Number.isFinite(time) || time < 0 || time > take.duration || index > 0 && time <= track.times[index - 1])
        || track.values.some(value => !Number.isFinite(value))) throw Error(`Invalid FBX key data: ${track.name}.`);
    if (propertyName === "scale") {
      const rest = targets[0].scale.toArray();
      if (track.values.some((value, index) => Math.abs(value - rest[index % 3]) > 1e-5 * Math.abs(rest[index % 3])))
        throw Error(`${nodeName}: animated joint scaling is unsupported.`);
    }
    if (propertyName === "quaternion") for (let index = 0; index < track.values.length; index += 4) {
      const [x, y, z, w] = track.values.subarray(index, index + 4);
      if (Math.abs(x * x + y * y + z * z + w * w - 1) > 1e-4) throw Error(`Invalid FBX rotation: ${nodeName}.`);
    }
  }
}

type MotionStage = { before: SceneDocument; document: SceneDocument; preview: SceneDocument; name: string; rootId: string; start: number; end: number; jointIds: string[] };
export type MixamoStage = MotionStage;
const uuid = () => crypto.randomUUID();

function prepareTake(source: MixamoSource, takeIndex: number, doc: SceneDocument, rootId: string, assignments?: ReadonlyMap<string, string>) {
  const take = source.takes[takeIndex];
  if (!take) throw Error("Choose an animation take.");
  const mapping = inspectMixamoMapping(source, doc, rootId, assignments);
  if (!mapping.valid) throw Error(mapping.errors[0] ?? "Resolve the highlighted joint mappings.");
  validateTake(source, take);
  const animation = doc.animation ?? defaultAnimation();
  const seed = { ...emptyScene(), animation: { ...defaultAnimation(), fps: animation.fps } };
  return { take, mapping, seed };
}

function composeStage(source: MixamoSource, takeIndex: number, doc: SceneDocument, rootId: string,
  mapping: ReturnType<typeof inspectMixamoMapping>, sampled: ReturnType<typeof convertFBX>): MotionStage {
  const take = source.takes[takeIndex], animation = doc.animation ?? defaultAnimation();
  const range = sampled.clips[0];
  const layerId = uuid();
  let lastFrame = animation.end;
  for (const track of [...animation.tracks, ...(animation.layers ?? []).flatMap(layer => layer.weightTrack ?? [])])
    if (track.keys.length) lastFrame = Math.max(lastFrame, track.keys[track.keys.length - 1].time);
  const hasAuthoredTimeline = !!doc.animation;
  const start = hasAuthoredTimeline ? Math.floor(lastFrame) + 1 : 0;
  const end = start + range.end;
  const gate = (time: number, value: number): CurveKey => ({ id: uuid(), time, value, interpolation: "step", tangentMode: "flat" });
  const name = (take.name.trim() || `Take ${takeIndex + 1}`).slice(0, 200);
  const layer: AnimationLayer = {
    id: layerId, name, mode: "override", weight: 1, mute: false, solo: false, locked: false,
    weightTrack: { id: uuid(), keys: [gate(start - 1, 0), gate(start, 1), gate(end + 1, 0)] },
  };
  const remap = new Map<string, string>(source.bones.map((bone, i) => [sampled.jointIds[i], mapping.sourceToTarget.get(bone.bone)!.id]));
  const tracks = sampled.document.animation!.tracks.map(track => ({
    ...track, targetId: remap.get(track.targetId)!, layerId,
    keys: track.keys.map(key => ({ ...key, time: key.time + start })),
  }));
  const document: SceneDocument = {
    ...doc,
    animation: {
      ...animation, end: Math.max(animation.start + 1, end), activeLayerId: layerId,
      layers: [...animation.layers ?? [], layer], tracks: [...animation.tracks, ...tracks],
    },
  };
  validateScene(document);
  const jointIds = [...remap.values()], mapped = new Set(jointIds);
  const preview: SceneDocument = {
    ...emptyScene(), joints: mapping.targetJoints.filter(joint => mapped.has(joint.id)),
    animation: { ...animation, layers: [layer], tracks },
  };
  return { before: doc, document, preview, name, rootId, start, end, jointIds };
}

function rotationMapper(targetByBone: ReadonlyMap<Bone, Joint>) {
  return (bone: Bone, rotation: Joint["position"]) => {
    const target = targetByBone.get(bone)!;
    return target.orientation ? jointRotationFromQuaternion(target, angleQuaternion(rotation)) : rotation;
  };
}

export function stageMixamoTake(source: MixamoSource, takeIndex: number, doc: SceneDocument, rootId: string, assignments?: ReadonlyMap<string, string>): MotionStage {
  const { take, mapping, seed } = prepareTake(source, takeIndex, doc, rootId, assignments);
  const sampled = convertFBX(source.group, seed, source.name, { clip: take, rotationForBone: rotationMapper(mapping.sourceToTarget) });
  return composeStage(source, takeIndex, doc, rootId, mapping, sampled);
}

export async function stageMixamoTakeAsync(source: MixamoSource, takeIndex: number, doc: SceneDocument, rootId: string,
  assignments: ReadonlyMap<string, string>, signal: AbortSignal): Promise<MotionStage> {
  signal.throwIfAborted();
  const { take, mapping, seed } = prepareTake(source, takeIndex, doc, rootId, assignments);
  // Yielding must never expose mixer changes to the file currently under review.
  const detached = source.group.clone(), targetByBone = new Map<Bone, Joint>();
  let index = 0;
  detached.traverse(object => {
    if ((object as Bone).isBone) targetByBone.set(object as Bone, mapping.sourceToTarget.get(source.bones[index++].bone)!);
  });
  const sampled = await convertFBXTake(detached, seed, source.name, { clip: take, rotationForBone: rotationMapper(targetByBone) }, signal);
  signal.throwIfAborted();
  return composeStage(source, takeIndex, doc, rootId, mapping, sampled);
}

export function commitMixamoTake(store: SceneStore, stage: MotionStage) {
  if (store.getState().document !== stage.before) throw Error("The scene changed. Review the motion again before importing.");
  store.setState({ document: stage.document, editLabel: "Import Motion Clip" });
}

export function mixamoPreviewPose(stage: MotionStage, frame: number) {
  const poses = evaluateSceneAnimation(stage.preview, stage.start + frame);
  const worlds = new Map<string, Matrix4>();
  return stage.preview.joints!.map(joint => {
    const pose = poses.get(joint.id)!;
    const local = jointLocalMatrix(joint, pose.position, pose.rotation);
    const parent = joint.parentId ? worlds.get(joint.parentId) : undefined;
    if (parent) local.premultiply(parent);
    worlds.set(joint.id, local);
    return { id: joint.id, parentId: joint.parentId, position: new Vector3().setFromMatrixPosition(local) };
  });
}
