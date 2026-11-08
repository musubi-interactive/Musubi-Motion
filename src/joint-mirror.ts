import { copyCustomAttributes } from "./custom-attributes.ts";
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import { evaluateSceneAnimation, setKeys, type AnimationPose } from "./animation.ts";
import { evaluateRigStages, ikChain, jointWorldMatrices } from "./ik.ts";
import { evaluateDrivenKeys } from "./driven-keys.ts";
import { jointLocalQuaternion, jointRotationFromQuaternion } from "./joint-transform.ts";
import { validateScene } from "./project-archive.ts";
import type { SceneDocument, Vec3 } from "./scene-document.ts";
import { createSceneStore, type SceneStore } from "./scene-store.ts";
import { validateJoints, type Joint } from "./skeleton.ts";

export type MirrorAxis = "X" | "Y" | "Z";
export type JointMirrorNames = { search: string; replace: string };
function reflection(axis: MirrorAxis) {
  if (!["X", "Y", "Z"].includes(axis)) throw Error("Choose the X, Y or Z mirror-plane normal.");
  return new Matrix4().makeScale(axis === "X" ? -1 : 1, axis === "Y" ? -1 : 1, axis === "Z" ? -1 : 1);
}
/** Conjugation reflects position and rotation while preserving a right-handed frame. */
export function reflectJointMatrix(matrix: Matrix4, axis: MirrorAxis): Matrix4 {
  const mirror = reflection(axis);
  if (!matrix.elements.every(Number.isFinite)) throw Error("Cannot mirror a non-finite joint matrix.");
  return mirror.clone().multiply(matrix).multiply(mirror);
}
function subtree(doc: SceneDocument, rootId: string): Joint[] {
  validateJoints(doc.joints ?? []);
  const byId = new Map(doc.joints?.map(joint => [joint.id, joint]));
  if (!byId.has(rootId)) throw Error("Choose an existing root joint to mirror.");
  const result: Joint[] = [], pending = [rootId];
  while (pending.length) {
    const id = pending.shift()!; result.push(byId.get(id)!);
    pending.push(...(doc.joints ?? []).filter(joint => joint.parentId === id).map(joint => joint.id).sort());
  }
  return result;
}
function renamed(name: string, names: JointMirrorNames): string {
  if (typeof names?.search !== "string" || !names.search.length || typeof names.replace !== "string" || names.search === names.replace)
    throw Error("Enter distinct, nonempty search text and replacement text for mirrored joint names.");
  if (!name.includes(names.search)) throw Error(`Joint ${name} does not contain the search text.`);
  const result = name.replaceAll(names.search, names.replace);
  if (!result.trim()) throw Error("Mirrored joint names cannot be empty.");
  return result;
}
function angles(quaternion: Quaternion): Vec3 {
  const euler = new Euler().setFromQuaternion(quaternion, "XYZ");
  return [euler.x, euler.y, euler.z].map(value => value === 0 ? 0 : MathUtils.radToDeg(value)) as Vec3;
}
function rotation(matrix: Matrix4): Quaternion {
  const quaternion = new Quaternion(); matrix.decompose(new Vector3(), quaternion, new Vector3()); return quaternion.normalize();
}

/** Mirror the authored subtree only. Animation, constraints, controls, IK and
 * skin influences remain on the source. The duplicate root is a skeleton root. */
export function mirrorJointSubtree(store: SceneStore, rootId: string, options: JointMirrorNames & { axis: MirrorAxis }): Map<string, string> {
  reflection(options.axis);
  const doc = store.getState().document, source = subtree(doc, rootId), worlds = jointWorldMatrices(doc);
  const existingNames = new Set(doc.joints?.map(joint => joint.name)), ids = new Map<string, string>();
  const mirroredWorlds = new Map(source.map(joint => [joint.id, reflectJointMatrix(worlds.get(joint.id)!, options.axis)]));
  const copied = source.map(joint => {
    const name = renamed(joint.name, options);
    if (existingNames.has(name)) throw Error(`Joint name ${name} already exists. Choose a different replacement.`);
    existingNames.add(name);
    const id = crypto.randomUUID(); ids.set(joint.id, id);
    const parentId = ids.get(joint.parentId ?? "") ?? null;
    const local = mirroredWorlds.get(joint.id)!.clone();
    if (parentId) local.premultiply(mirroredWorlds.get(joint.parentId!)!.clone().invert());
    // Reflect rotation channels separately, then derive the static orientation
    // needed to preserve the exact reflected world frame, including a detached root.
    const channelMatrix = new Matrix4().makeRotationFromQuaternion(jointLocalQuaternion({}, joint.rotation ?? [0, 0, 0]));
    const channel = rotation(reflectJointMatrix(channelMatrix, options.axis));
    const orientation = rotation(local).multiply(channel.clone().invert()).normalize();
    const next: Joint = { ...joint, id, name, parentId, position: new Vector3().setFromMatrixPosition(local).toArray() as Vec3,
      orientation: angles(orientation), rotation: angles(channel) };
    if (joint.preferredAngle) {
      const total = new Matrix4().makeRotationFromQuaternion(jointLocalQuaternion(joint, joint.preferredAngle));
      // Internal links use reflected parent-local frames. For a detached root,
      // include the original parent's world rotation in its preferred frame.
      if (!parentId && joint.parentId) total.premultiply(new Matrix4().makeRotationFromQuaternion(rotation(worlds.get(joint.parentId)!)));
      next.preferredAngle = jointRotationFromQuaternion(next, rotation(reflectJointMatrix(total, options.axis)));
    }
    return next;
  });
  const next = { ...doc, joints: [...doc.joints ?? [], ...copied], ...(doc.customAttributes ? { customAttributes: copyCustomAttributes(doc, ids) } : {}) };
  validateScene(next);
  store.setState({ document: next, editLabel: "Mirror joint subtree" });
  return ids;
}

/** Explicit name pairing rejects ambiguous names, missing destinations and self-pairs. */
export function buildJointMirrorPairs(doc: SceneDocument, rootId: string, search: string, replace: string): Map<string, string> {
  const pairs = new Map<string, string>(), targets = new Set<string>();
  for (const joint of subtree(doc, rootId)) {
    const name = renamed(joint.name, { search, replace }), matches = doc.joints!.filter(candidate => candidate.name === name);
    if (matches.length !== 1) throw Error(`Choose one unambiguous destination joint named ${name}.`);
    const targetId = matches[0].id;
    if (targetId === joint.id || targets.has(targetId)) throw Error("Mirror pairs need distinct source/destination joints and unique destinations.");
    pairs.set(joint.id, targetId); targets.add(targetId);
  }
  return pairs;
}

/** Apply a reflected prepared FK pose. Supplying frame keys positions/rotations
 * through the normal animation commands; otherwise updates authored channels. */
export function mirrorJointPose(store: SceneStore, pairs: ReadonlyMap<string, string>, axis: MirrorAxis,
  preparedFK: ReadonlyMap<string, AnimationPose>, options: { frame?: number } = {}): Map<string, AnimationPose> {
  reflection(axis);
  const doc = store.getState().document; validateJoints(doc.joints ?? []);
  if (!(pairs instanceof Map) || !pairs.size || pairs.size > 1000) throw Error("Choose between 1 and 1,000 explicit mirror pairs.");
  const byId = new Map(doc.joints!.map(joint => [joint.id, joint])), targets = new Set(pairs.values());
  if (targets.size !== pairs.size) throw Error("Each mirrored destination may appear only once.");
  const poseChannel = (channel: string) => channel.startsWith("rotation.") || channel.startsWith("position.");
  for (const [source, target] of pairs) {
    if (source === target || !byId.has(source) || !byId.has(target)) throw Error("Mirror pairs must reference distinct existing joints.");
    if (!preparedFK.has(source) || !preparedFK.has(target)) throw Error("Evaluate every source and destination FK pose before mirroring.");
  }
  if (doc.drivenKeys?.some(relation => targets.has(relation.driven.targetId) && poseChannel(relation.driven.channel)))
    throw Error("Remove destination driven-key position/rotation dependencies before mirroring a pose.");
  if (doc.constraints?.some(constraint => constraint.enabled && targets.has(constraint.targetId) && constraint.type !== "scale"))
    throw Error("Disable destination position/rotation constraints before mirroring a pose.");
  if (doc.ikHandles?.some(handle => handle.enabled && ikChain(doc, handle.rootId, handle.endId).some(id => targets.has(id))))
    throw Error("Disable IK affecting destination joints before mirroring a pose.");
  if (options.frame === undefined && doc.animation?.tracks.some(track => targets.has(track.targetId) && poseChannel(track.channel)))
    throw Error("Destination pose channels are animated. Use keyed pose mirroring at the current frame.");
  const input = evaluateSceneAnimation(doc, options.frame ?? 0);
  for (const [id, pose] of preparedFK) {
    if (!byId.has(id)) continue;
    for (const values of [pose.position, pose.rotation]) if (!Array.isArray(values) || values.length !== 3 || ![0, 1, 2].every(axis => Number.isFinite(values[axis])))
      throw Error("Mirror FK inputs need finite XYZ positions and rotations.");
    input.set(id, { ...pose, position: [...pose.position], rotation: [...pose.rotation], scale: [1, 1, 1] });
  }
  const worlds = jointWorldMatrices(doc, input), desired = new Map<string, Matrix4>();
  for (const [source, target] of pairs) desired.set(target, reflectJointMatrix(worlds.get(source)!, axis));
  const output = new Map<string, AnimationPose>();
  for (const targetId of targets) {
    const joint = byId.get(targetId)!, local = desired.get(targetId)!.clone();
    if (joint.parentId) local.premultiply((desired.get(joint.parentId) ?? worlds.get(joint.parentId)!).clone().invert());
    output.set(targetId, { ...input.get(targetId)!, position: new Vector3().setFromMatrixPosition(local).toArray() as Vec3,
      rotation: jointRotationFromQuaternion(joint, rotation(local), input.get(targetId)!.rotation) });
  }
  let next: SceneDocument;
  if (options.frame !== undefined) {
    const staging = createSceneStore(doc);
    setKeys(staging, [...targets], options.frame, output, ["position.x", "position.y", "position.z", "rotation.x", "rotation.y", "rotation.z"]);
    next = staging.getState().document;
  } else next = { ...doc, joints: doc.joints!.map(joint => {
    const pose = output.get(joint.id); return pose ? { ...joint, position: [...pose.position], rotation: [...pose.rotation] } : joint;
  }) };
  validateScene(next);
  // Validate the full composed result, including animation-layer conversion
  // and inherited IK/constraint effects, before exposing any document change.
  const actual = evaluateSceneAnimation(next, options.frame ?? 0);
  for (const [id, pose] of input) if (!targets.has(id)) actual.set(id, pose);
  if (options.frame === undefined) for (const [id, pose] of output) actual.set(id, pose);
  evaluateDrivenKeys(next, actual); evaluateRigStages(next, actual, false, options.frame ?? 0);
  const actualWorld = jointWorldMatrices(next, actual);
  for (const [id, matrix] of desired) if (matrix.elements.some((value, index) => Math.abs(value - actualWorld.get(id)!.elements[index]) > 1e-6))
    throw Error("Mirroring would change the requested destination pose after rig evaluation. Resolve parent constraints, IK or layer dependencies first.");
  if (JSON.stringify(next) !== JSON.stringify(doc)) store.setState({ document: next, editLabel: options.frame === undefined ? "Mirror joint pose" : "Mirror and key joint pose" });
  return output;
}
