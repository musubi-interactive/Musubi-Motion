import { Bone, BufferGeometry, Matrix4, MeshBasicMaterial, Quaternion, Skeleton, SkinnedMesh, Vector3 } from "three";
import { CCDIKSolver, type IK } from "three/addons/animation/CCDIKSolver.js";
import { baseChannels, evaluateIKBlend, evaluateSceneAnimation, setIKBlendKey, setKeys, validateAnimation, type AnimationPose } from "./animation.ts";
import { unwrapEuler } from "./animation-edit.ts";
import { evaluateDrivenKeys } from "./driven-keys.ts";
import { constraintWorldMatrices, evaluateConstraints } from "./constraints.ts";
import { ikInputConstraintTargets, validateIKControlDependencies } from "./ik-control-plan.ts";
import type { SceneDocument, Vec3 } from "./scene-document.ts";
import { createSceneStore, type SceneStore } from "./scene-store.ts";
import type { Joint } from "./skeleton.ts";
import { solveTwoBoneCorrections } from "./two-bone-ik.ts";
import { jointLocalQuaternion, jointRotationFromQuaternion } from "./joint-transform.ts";

export type IKControlLink = { objectId: string; offset: Vec3 };
export type IKHandle = {
  id: string;
  name: string;
  rootId: string;
  endId: string;
  /** A world-space target in scene units. */
  target: Vec3;
  enabled: boolean;
  iterations: number;
  /** Static fallback without an ik.blend curve: zero retains FK, one solves fully. */
  blend: number;
  solver?: "ccd" | "two-bone";
  /** World-space pole position; required by the analytic two-bone solver. */
  poleTarget?: Vec3;
  /** Linked transform origins plus world-space offsets replace literal targets. */
  targetControl?: IKControlLink;
  poleControl?: IKControlLink;
};
export type IKHandleSettings = Pick<IKHandle, "solver" | "poleTarget" | "targetControl" | "poleControl">;

const vector = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && [0, 1, 2].every(index => typeof value[index] === "number" && Number.isFinite(value[index]) && Math.abs(value[index]) <= 1e6);
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

/** Ordered root to effector, including both endpoints. */
export function ikChain(doc: SceneDocument, rootId: string, endId: string): string[] {
  const joints = new Map((doc.joints ?? []).map(joint => [joint.id, joint]));
  if (rootId === endId || !joints.has(rootId) || !joints.has(endId)) throw Error("Choose different root and end joints.");
  const path: string[] = [], visited = new Set<string>();
  let current: string | null = endId;
  while (current) {
    if (visited.has(current) || path.length > 64) throw Error("Invalid or oversized IK chain.");
    visited.add(current); path.push(current);
    if (current === rootId) return path.reverse();
    current = joints.get(current)?.parentId ?? null;
  }
  throw Error("The end joint must be a descendant of the root joint.");
}

export function validateIKHandles(value: unknown, doc: SceneDocument): asserts value is IKHandle[] {
  if (doc.joints?.some(joint => Object.hasOwn(doc.nodes, joint.id))) throw Error("Joint and object IDs must be distinct.");
  if (!Array.isArray(value) || value.length > 128) throw Error("Invalid IK handles.");
  const ids = new Set<string>(), occupied = new Map<string, string>();
  const joints = new Map((doc.joints ?? []).map(joint => [joint.id, joint]));
  for (const handle of value as IKHandle[]) {
    if (!handle || typeof handle !== "object" || !validId(handle.id) || ids.has(handle.id) || typeof handle.name !== "string" || !handle.name.trim() || handle.name.length > 100
      || !validId(handle.rootId) || !validId(handle.endId) || !vector(handle.target) || typeof handle.enabled !== "boolean"
      || !Number.isInteger(handle.iterations) || handle.iterations < 1 || handle.iterations > 128
      || typeof handle.blend !== "number" || !Number.isFinite(handle.blend) || handle.blend < 0 || handle.blend > 1) throw Error("Invalid IK handle settings.");
    if (Object.hasOwn(doc.nodes, handle.id) || joints.has(handle.id)) throw Error("IK handle IDs must be distinct from object and joint IDs.");
    const chain = ikChain(doc, handle.rootId, handle.endId);
    if (handle.solver !== undefined && !["ccd", "two-bone"].includes(handle.solver)) throw Error("Unknown IK solver.");
    if (handle.poleTarget !== undefined && !vector(handle.poleTarget)) throw Error("IK pole target must contain finite world coordinates within ±1,000,000.");
    for (const link of [handle.targetControl, handle.poleControl]) if (link !== undefined) {
      if (!link || typeof link !== "object" || Array.isArray(link) || !validId(link.objectId) || doc.nodes[link.objectId]?.type !== "transform" || !vector(link.offset)) {
        throw Error("IK control links need an existing transform and finite world offsets within ±1,000,000.");
      }
    }
    if (handle.solver === "two-bone" && (chain.length !== 3 || !vector(handle.poleTarget))) throw Error("Two-bone IK needs exactly three joints and a world-space pole target.");
    for (let index = 0; index < chain.length; index++) {
      const id = chain[index];
      if (occupied.has(id)) throw Error("IK chains cannot share joints. Remove the overlapping handle first.");
      if (index > 0 && new Vector3(...joints.get(id)!.position).lengthSq() < 1e-12) throw Error("IK requires nonzero bone lengths.");
      occupied.set(id, handle.id);
    }
    ids.add(handle.id);
  }
  // A solver on an ancestor can move a second chain even when their explicit
  // paths do not intersect. Reject that order-dependent configuration too.
  for (const handle of value as IKHandle[]) {
    const visited = new Set<string>();
    let parent = joints.get(handle.rootId)?.parentId;
    while (parent) {
      if (visited.has(parent)) throw Error("Invalid joint hierarchy.");
      visited.add(parent);
      if (occupied.has(parent) && occupied.get(parent) !== handle.id) throw Error("IK chains cannot control ancestors of another chain.");
      parent = joints.get(parent)?.parentId;
    }
  }
  validateIKControlDependencies({ ...doc, ikHandles: value });
}

type Rig = { mesh: SkinnedMesh; bones: Map<string, Bone>; indices: Map<string, number>; target: Bone };
const rigs = new WeakMap<Joint[], Rig>();
function rigFor(doc: SceneDocument): Rig {
  const joints = doc.joints ?? [];
  let rig = rigs.get(joints);
  if (rig) return rig;
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  const bones = new Map<string, Bone>(), indices = new Map<string, number>();
  for (const joint of joints) {
    const bone = new Bone(); bone.name = joint.name;
    indices.set(joint.id, bones.size); bones.set(joint.id, bone);
  }
  for (const joint of joints) {
    const parent = joint.parentId ? bones.get(joint.parentId) : mesh;
    if (!parent) throw Error("Missing joint parent.");
    parent.add(bones.get(joint.id)!);
  }
  const target = new Bone(); target.name = "IK target"; mesh.add(target);
  mesh.skeleton = new Skeleton([...bones.values(), target]);
  rig = { mesh, bones, indices, target }; rigs.set(joints, rig);
  return rig;
}

function resetRig(doc: SceneDocument, poses?: ReadonlyMap<string, AnimationPose>): Rig {
  const rig = rigFor(doc);
  for (const joint of doc.joints ?? []) {
    const pose = poses?.get(joint.id), bone = rig.bones.get(joint.id)!;
    bone.position.fromArray(pose?.position ?? joint.position);
    const rotation = pose?.rotation ?? joint.rotation ?? [0, 0, 0];
    bone.quaternion.copy(jointLocalQuaternion(joint, rotation));
    bone.scale.set(1, 1, 1);
  }
  rig.mesh.updateMatrixWorld(true);
  return rig;
}

/** Fresh world matrices, suitable for FK matching and viewport target placement. */
export function jointWorldMatrices(doc: SceneDocument, poses?: ReadonlyMap<string, AnimationPose>): Map<string, Matrix4> {
  const rig = resetRig(doc, poses);
  return new Map([...rig.bones].map(([id, bone]) => [id, bone.matrixWorld.clone()]));
}

/** Places the pole in the displayed FK bend plane, with a stable straight-chain fallback. */
export function defaultPoleTarget(doc: SceneDocument, rootId: string, endId: string, poses?: ReadonlyMap<string, AnimationPose>): Vec3 {
  const chain = ikChain(doc, rootId, endId);
  if (chain.length !== 3) throw Error("Two-bone IK needs exactly three joints.");
  const worlds = jointWorldMatrices(doc, poses), root = new Vector3().setFromMatrixPosition(worlds.get(rootId)!);
  const middle = new Vector3().setFromMatrixPosition(worlds.get(chain[1])!), end = new Vector3().setFromMatrixPosition(worlds.get(endId)!);
  const direction = end.clone().sub(root), upper = middle.clone().sub(root), length = Math.max(upper.length() + end.distanceTo(middle), 1);
  if (direction.lengthSq() < 1e-12) direction.copy(upper);
  if (direction.lengthSq() < 1e-12) direction.set(0, 1, 0);
  direction.normalize();
  const bend = upper.clone().addScaledVector(direction, -upper.dot(direction));
  if (bend.lengthSq() < 1e-12) {
    bend.set(...(Math.abs(direction.x) < 0.8 ? [1, 0, 0] : [0, 1, 0]) as Vec3);
    bend.addScaledVector(direction, -bend.dot(direction));
  }
  return root.addScaledVector(bend.normalize(), length).toArray() as Vec3;
}

export type IKTargetPoints = { target: Vec3; poleTarget?: Vec3 };
/** Resolve already-evaluated transform origins once for all handles. Constraint
 * staging belongs to evaluateRigStages; this helper does not solve constraints. */
export function getIKTargetPoints(doc: SceneDocument, poses: ReadonlyMap<string, AnimationPose>): Map<string, IKTargetPoints> {
  const handles = doc.ikHandles ?? [];
  const worlds = handles.some(handle => handle.targetControl || handle.poleControl) ? constraintWorldMatrices(doc, poses) : undefined;
  function resolve(link: IKControlLink | undefined, fallback: Vec3 | undefined): Vec3 | undefined {
    if (!link) {
      if (fallback === undefined) return undefined;
      if (!vector(fallback)) throw Error("IK target points must be finite and within ±1,000,000 world units.");
      return [...fallback] as Vec3;
    }
    if (!vector(link.offset)) throw Error("IK control offsets must be finite and within ±1,000,000 world units.");
    const world = worlds?.get(link.objectId);
    if (!world || doc.nodes[link.objectId]?.type !== "transform") throw Error("An IK control transform no longer exists.");
    const point = new Vector3().setFromMatrixPosition(world).add(new Vector3(...link.offset)).toArray() as Vec3;
    if (!vector(point)) throw Error("The evaluated IK control target must stay finite and within ±1,000,000 world units.");
    return point;
  }
  return new Map(handles.map(handle => {
    const target = resolve(handle.targetControl, handle.target);
    if (!target) throw Error("An IK handle needs a target point.");
    return [handle.id, { target,
      ...(handle.poleTarget || handle.poleControl ? { poleTarget: resolve(handle.poleControl, handle.poleTarget) } : {}),
    }];
  }));
}

/** Atomic rig stage shared by viewport, matching and historical evaluation.
 * Input poses already include time animation, previews and driven keys. */
export function evaluateRigStages(doc: SceneDocument, poses: Map<string, AnimationPose>, captureStages = false, frame = 0): {
  fkPoses?: Map<string, AnimationPose>; solvedPoses?: Map<string, AnimationPose>;
} {
  if (!Number.isFinite(frame)) throw Error("The IK evaluation frame must be finite.");
  const candidate = new Map(poses), inputTargets = ikInputConstraintTargets(doc);
  if (inputTargets.size) evaluateConstraints(doc, candidate, { includeTargets: inputTargets });
  const fkPoses = captureStages ? new Map(candidate) : undefined;
  evaluateIK(doc, candidate, frame);
  const solvedPoses = captureStages ? new Map(candidate) : undefined;
  evaluateConstraints(doc, candidate, { excludeTargets: inputTargets });
  for (const [id, pose] of candidate) poses.set(id, pose);
  return { fkPoses, solvedPoses };
}

/** Low-level solver. Call evaluateRigStages for linked constrained controls. */
export function evaluateIK(doc: SceneDocument, poses: Map<string, AnimationPose>, frame = 0): void {
  if (!Number.isFinite(frame)) throw Error("The IK evaluation frame must be finite.");
  const handles = (doc.ikHandles ?? []).map(handle => ({ handle, blend: evaluateIKBlend(doc, handle.id, frame) }))
    .filter(({ handle, blend }) => handle.enabled && blend > 0);
  const targetPoints = getIKTargetPoints(doc, poses);
  if (!handles.length) return;
  const rig = resetRig(doc, poses);
  const preferences = new Map((doc.joints ?? []).filter(joint => joint.preferredAngle !== undefined).map(joint => [joint.id, joint.preferredAngle!]));
  const targetPosition = new Vector3(), rootPosition = new Vector3(), endPosition = new Vector3(), localAxis = new Vector3();
  const axis = new Vector3(), direction = new Vector3(), delta = new Quaternion(), worldRotation = new Quaternion();
  for (const { handle, blend } of handles) {
    const chain = ikChain(doc, handle.rootId, handle.endId);
    // Animation can collapse a segment even though the authored rest pose is valid.
    if (chain.slice(1).some(id => rig.bones.get(id)!.position.lengthSq() < 1e-12)) continue;
    const links = chain.slice(0, -1).reverse(), end = rig.bones.get(handle.endId)!;
    const originals = new Map(links.map(id => [id, rig.bones.get(id)!.quaternion.clone()]));
    // Preferred angles seed only this solver's links. Keep the evaluated FK
    // quaternions above as blend origins; ancestors and the effector stay FK.
    let seeded = false;
    for (const id of links) {
      const preferred = preferences.get(id);
      if (!preferred) continue;
      rig.bones.get(id)!.quaternion.copy(jointLocalQuaternion(doc.joints!.find(joint => joint.id === id)!, preferred));
      seeded = true;
    }
    if (seeded) rig.mesh.updateMatrixWorld(true);
    const points = targetPoints.get(handle.id)!;
    targetPosition.fromArray(points.target);
    if (handle.solver === "two-bone") {
      if (chain.length !== 3 || !points.poleTarget) throw Error("Two-bone IK needs exactly three joints and a world-space pole target.");
      const root = rig.bones.get(chain[0])!, middle = rig.bones.get(chain[1])!;
      const correction = solveTwoBoneCorrections(root.matrixWorld, middle.matrixWorld, end.matrixWorld, targetPosition, new Vector3(...points.poleTarget));
      root.quaternion.multiply(correction.root).normalize(); middle.quaternion.multiply(correction.middle).normalize();
      rig.mesh.updateMatrixWorld(true);
    } else {
    rig.target.position.copy(targetPosition); rig.target.updateMatrixWorld(true);
    rootPosition.setFromMatrixPosition(rig.bones.get(handle.rootId)!.matrixWorld);
    endPosition.setFromMatrixPosition(end.matrixWorld);
    // CCD has no bend direction at a collinear singularity. A small, fixed
    // perpendicular seed makes straight/reversed chains deterministic. It is
    // discarded if solving fails, and blend zero always preserves exact FK.
    const rootToEnd = endPosition.clone().sub(rootPosition), rootToTarget = targetPosition.clone().sub(rootPosition);
    if (endPosition.distanceToSquared(targetPosition) > 1e-12 && new Vector3().crossVectors(rootToEnd, rootToTarget).lengthSq() < 1e-12) {
      direction.copy(rootToEnd).normalize();
      if (direction.lengthSq() < 1e-12) direction.set(0, 1, 0);
      axis.crossVectors(direction, Math.abs(direction.x) < 0.8 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
      for (let index = 0; index < links.length; index++) {
        const bone = rig.bones.get(links[index])!;
        bone.getWorldQuaternion(worldRotation).invert();
        localAxis.copy(axis).applyQuaternion(worldRotation);
        bone.quaternion.multiply(delta.setFromAxisAngle(localAxis, 0.02 * (index + 1))).normalize();
        bone.updateMatrixWorld(true);
      }
    }
    const ik: IK = { target: rig.bones.size, effector: rig.indices.get(handle.endId)!,
      links: links.map(id => ({ index: rig.indices.get(id)! })), iteration: 1, maxAngle: Math.PI / 3 };
    const solver = new CCDIKSolver(rig.mesh, [ik]);
    for (let iteration = 0; iteration < handle.iterations; iteration++) {
      // At an exact target/link coincidence its direction is undefined. Stop
      // there while still allowing the descendant links to fold toward it.
      for (let index = 0; index < links.length; index++) {
        rootPosition.setFromMatrixPosition(rig.bones.get(links[index])!.matrixWorld);
        ik.links[index].enabled = rootPosition.distanceToSquared(targetPosition) > 1e-16;
      }
      solver.update();
      for (const id of links) rig.bones.get(id)!.quaternion.normalize();
      rig.mesh.updateMatrixWorld(true);
      endPosition.setFromMatrixPosition(end.matrixWorld);
      if (endPosition.distanceToSquared(targetPosition) < 1e-10) break;
    }
    }
    for (const id of links) {
      const bone = rig.bones.get(id)!, original = originals.get(id)!;
      if (!bone.quaternion.toArray().every(Number.isFinite)) bone.quaternion.copy(original);
      if (blend < 1) bone.quaternion.copy(original.clone().slerp(bone.quaternion, blend));
      const pose = poses.get(id) ?? baseChannels(doc, id);
      const joint = doc.joints!.find(joint => joint.id === id)!;
      poses.set(id, { ...pose, rotation: jointRotationFromQuaternion(joint, bone.quaternion) });
    }
    rig.mesh.updateMatrixWorld(true);
  }
}

function saveHandles(store: SceneStore, handles: IKHandle[], editLabel: string) {
  const doc = store.getState().document;
  const retained = new Set(handles.map(handle => handle.id));
  const removed = new Set((doc.ikHandles ?? []).filter(handle => !retained.has(handle.id)).map(handle => handle.id));
  const next = { ...doc, ikHandles: handles,
    ...(doc.customAttributes && removed.size ? { customAttributes: Object.fromEntries(Object.entries(doc.customAttributes).filter(([id]) => !removed.has(id))) } : {}),
    ...(doc.drivenKeys && removed.size ? { drivenKeys: doc.drivenKeys.filter(relation => !removed.has(relation.driver.targetId) && !removed.has(relation.driven.targetId)) } : {}),
    ...(doc.animation && removed.size ? { animation: { ...doc.animation,
      tracks: doc.animation.tracks.filter(track => !removed.has(track.targetId)) } } : {}) };
  validateIKHandles(handles, next);
  if (next.animation) validateAnimation(next.animation, next);
  if (JSON.stringify(doc.ikHandles ?? []) === JSON.stringify(handles)) return;
  store.setState({ document: next, editLabel });
}
export function createIKHandle(store: SceneStore, rootId: string, endId: string, target?: Vec3, settings: IKHandleSettings = {}): string {
  const doc = store.getState().document;
  ikChain(doc, rootId, endId);
  const endpoint = new Vector3().setFromMatrixPosition(jointWorldMatrices(doc).get(endId)!);
  const id = crypto.randomUUID();
  const handle: IKHandle = { id, name: `ikHandle${(doc.ikHandles?.length ?? 0) + 1}`, rootId, endId,
    target: target ? [...target] : endpoint.toArray() as Vec3, enabled: true, iterations: 64, blend: 1,
    ...(settings.solver !== undefined ? { solver: settings.solver } : {}),
    ...(settings.targetControl !== undefined ? { targetControl: structuredClone(settings.targetControl) } : {}),
    ...(settings.poleControl !== undefined ? { poleControl: structuredClone(settings.poleControl) } : {}),
    ...(settings.poleTarget !== undefined ? { poleTarget: [...settings.poleTarget] as Vec3 } : settings.solver === "two-bone" ? { poleTarget: defaultPoleTarget(doc, rootId, endId) } : {}) };
  saveHandles(store, [...doc.ikHandles ?? [], handle], "Create IK handle");
  return id;
}
export function updateIKHandle(store: SceneStore, id: string, patch: Partial<Omit<IKHandle, "id">>) {
  const handles = store.getState().document.ikHandles ?? [];
  if (!handles.some(handle => handle.id === id)) throw Error("IK handle does not exist.");
  saveHandles(store, handles.map(handle => handle.id === id ? { ...handle, ...structuredClone(patch), id } : handle), "Edit IK handle");
}
export function deleteIKHandle(store: SceneStore, id: string) {
  saveHandles(store, (store.getState().document.ikHandles ?? []).filter(handle => handle.id !== id), "Delete IK handle");
}
export function matchIKToFK(store: SceneStore, id: string, poses?: ReadonlyMap<string, AnimationPose>) {
  const doc = store.getState().document, handle = doc.ikHandles?.find(handle => handle.id === id);
  if (!handle) throw Error("IK handle does not exist.");
  if (handle.targetControl || handle.poleControl) throw Error("This IK handle uses linked controls. Use Match IK controls to FK and key, or unlink the controls before matching literal targets.");
  const target = new Vector3().setFromMatrixPosition(jointWorldMatrices(doc, poses).get(handle.endId)!).toArray() as Vec3;
  updateIKHandle(store, id, { target, ...(handle.solver === "two-bone" ? { poleTarget: defaultPoleTarget(doc, handle.rootId, handle.endId, poses) } : {}) });
}

/** Key the solved local chain rotations at one frame, then key its existing
 * blend curve to zero (or switch its static fallback to FK without a curve).
 * Supply the pose immediately after IK and before constraints; an
 * optional pre-IK pose preserves Euler revolutions in uncommitted previews. */
export function matchFKToIK(
  store: SceneStore, id: string, frame: number,
  poses?: ReadonlyMap<string, AnimationPose>, fkPoses?: ReadonlyMap<string, AnimationPose>,
): void {
  if (!Number.isFinite(frame) || Math.abs(frame) > 1e6) throw Error("The match frame must be finite and between -1000000 and 1000000.");
  const doc = store.getState().document, handle = doc.ikHandles?.find(handle => handle.id === id);
  if (!handle) throw Error("IK handle does not exist.");
  if (!handle.enabled || evaluateIKBlend(doc, id, frame) <= 0) throw Error("Enable the IK handle and set its blend above zero before matching FK.");
  const chain = ikChain(doc, handle.rootId, handle.endId), ids = new Set(chain);
  if (doc.drivenKeys?.some(relation => ids.has(relation.driven.targetId) && relation.driven.channel.startsWith("rotation."))) {
    throw Error("A joint in this chain has driven-key rotation channels. Remove those relationships before matching FK to IK.");
  }
  if (doc.constraints?.some(constraint => constraint.enabled && ids.has(constraint.targetId) && ["orient", "aim", "parent"].includes(constraint.type))) {
    throw Error("A joint in this chain has an active rotation constraint. Disable its orient, aim or parent constraint before matching FK to IK.");
  }
  const base = evaluateSceneAnimation(doc, frame); evaluateDrivenKeys(doc, base);
  for (const [jointId, pose] of fkPoses ?? []) base.set(jointId, pose);
  const sourceStages = evaluateRigStages(doc, base, true, frame);
  const reference = sourceStages.fkPoses!;
  const solved = poses ?? sourceStages.solvedPoses!;
  const keyed = new Map<string, AnimationPose>();
  for (const jointId of chain) {
    const current = solved.get(jointId), previous = reference.get(jointId);
    if (!current || !previous) throw Error("The solved IK pose is incomplete. Evaluate the full chain before matching.");
    for (const pose of [current, previous]) for (const values of [pose.position, pose.rotation, pose.scale]) {
      if (!Array.isArray(values) || values.length !== 3 || !values.every(Number.isFinite)) throw Error("The solved IK pose must contain finite transforms.");
    }
    keyed.set(jointId, { ...current, rotation: unwrapEuler(current.rotation, previous.rotation) });
  }
  // Reuse normal key validation and replacement semantics on a temporary store.
  // Only the final document reaches the live store and its undo history.
  const staging = createSceneStore(doc);
  setKeys(staging, chain, frame, keyed, ["rotation.x", "rotation.y", "rotation.z"]);
  const animatedBlend = doc.animation?.tracks.some(track => track.targetId === id && track.channel === "ik.blend");
  if (animatedBlend) setIKBlendKey(staging, id, frame, 0);
  const next: SceneDocument = animatedBlend ? staging.getState().document : { ...staging.getState().document,
    ikHandles: doc.ikHandles!.map(candidate => candidate.id === id ? { ...candidate, blend: 0 } : candidate) };
  validateIKHandles(next.ikHandles, next);
  if (next.animation) validateAnimation(next.animation, next);
  const check = evaluateSceneAnimation(next, frame); evaluateDrivenKeys(next, check);
  const checkStages = evaluateRigStages(next, check, true, frame);
  const expected = new Map(reference); for (const [jointId, pose] of solved) expected.set(jointId, pose);
  function verifyPose(expected: ReadonlyMap<string, AnimationPose>, actual: ReadonlyMap<string, AnimationPose>) {
    const expectedWorld = jointWorldMatrices(doc, expected), matchedWorld = jointWorldMatrices(next, actual);
    for (const jointId of chain) {
      const before = expectedWorld.get(jointId)!, after = matchedWorld.get(jointId)!;
      const expectedPosition = new Vector3(), actualPosition = new Vector3(), expectedRotation = new Quaternion(), actualRotation = new Quaternion();
      before.decompose(expectedPosition, expectedRotation, new Vector3()); after.decompose(actualPosition, actualRotation, new Vector3());
      const tolerance = 1e-6 + expectedPosition.length() * 1e-10;
      if (!before.elements.every(Number.isFinite) || !after.elements.every(Number.isFinite)
        || expectedPosition.distanceTo(actualPosition) > tolerance || expectedRotation.angleTo(actualRotation) > 1e-6) {
        throw Error("Matching rotation keys would change the chain pose. Key any position previews and resolve driven or constraint dependencies before matching FK to IK.");
      }
    }
  }
  verifyPose(expected, checkStages.solvedPoses!);
  // A chain rotation can also drive an external control whose point constraint
  // moves this chain later. Verify the final constrained result, not just IK.
  if (doc.constraints?.some(constraint => constraint.enabled)) {
    const constrainedExpected = new Map(expected);
    evaluateConstraints(doc, constrainedExpected, { excludeTargets: ikInputConstraintTargets(doc) });
    verifyPose(constrainedExpected, check);
  }
  store.setState({ document: next, editLabel: "Match FK to IK and key" });
}
