import { defaultAnimation, type AnimationPose, type AnimationTrack } from "./animation.ts";
import type { SceneDocument } from "./scene-document.ts";

type DraftSnapshot = { epoch: number; poses: Map<string, AnimationPose> };

/** Transform drafts must not mask independent edits to mesh blend shapes. */
export function applyTransformPoseDraft(evaluated: AnimationPose, draft: AnimationPose): AnimationPose {
  const { morphWeights: _previousWeights, customValues: _previousCustom, ...transform } = draft;
  return { ...transform, ...(evaluated.customValues ? { customValues: { ...evaluated.customValues } } : {}), ...(evaluated.morphWeights ? { morphWeights: [...evaluated.morphWeights] } : {}) };
}

function copyExistingPoses(document: SceneDocument, poses: ReadonlyMap<string, AnimationPose>) {
  const joints = new Set(document.joints?.map(joint => joint.id));
  const copy = new Map<string, AnimationPose>();
  for (const [id, pose] of poses) {
    if (document.nodes[id]?.type !== "transform" && !joints.has(id)) continue;
    copy.set(id, {
      ...(pose.morphWeights ? { morphWeights: [...pose.morphWeights] } : {}), position: [...pose.position], rotation: [...pose.rotation], scale: [...pose.scale], visibility: pose.visibility,
    });
  }
  return copy;
}

function sameTracks(a: AnimationTrack[], b: AnimationTrack[]): boolean {
  return a.length === b.length && a.every((track, index) => track === b[index] || JSON.stringify(track) === JSON.stringify(b[index]));
}

function changesOnlyIKBlend(next: SceneDocument, previous: SceneDocument): boolean {
  // A blend changes solved output, not the input poses being previewed. Keep
  // this exception independent of command labels and closed to other rig edits.
  const { animation: nextAnimation, ikHandles: nextHandles, ...nextInput } = next;
  const { animation: previousAnimation, ikHandles: previousHandles, ...previousInput } = previous;
  const keys = Object.keys(nextInput) as (keyof typeof nextInput)[];
  if (keys.length !== Object.keys(previousInput).length || keys.some(key => nextInput[key] !== previousInput[key])) return false;

  const handles = nextHandles ?? [], oldHandles = previousHandles ?? [];
  if (handles.length !== oldHandles.length) return false;
  let changed = false;
  for (let index = 0; index < handles.length; index++) {
    if (handles[index] === oldHandles[index]) continue;
    const { blend, ...settings } = handles[index], { blend: oldBlend, ...oldSettings } = oldHandles[index];
    if (JSON.stringify(settings) !== JSON.stringify(oldSettings)) return false;
    changed ||= blend !== oldBlend;
  }
  if (nextAnimation === previousAnimation) return changed;

  // The first blend key materializes default timeline metadata. That is not a
  // timing change; changing FPS, range or loop still invalidates every draft.
  const { tracks, ...settings } = nextAnimation ?? defaultAnimation();
  const { tracks: oldTracks, ...oldSettings } = previousAnimation ?? defaultAnimation();
  if (JSON.stringify(settings) !== JSON.stringify(oldSettings)) return false;
  const isBlend = (track: AnimationTrack) => track.channel === "ik.blend";
  if (!sameTracks(tracks.filter(track => !isBlend(track)), oldTracks.filter(track => !isBlend(track)))) return false;
  changed ||= !sameTracks(tracks.filter(isBlend), oldTracks.filter(isBlend));
  // An unrelated replacement with identical values must not widen the previous
  // invalidation policy merely because this comparison found no differences.
  return changed;
}

function changesOnlyJointMetadata(next: SceneDocument, previous: SceneDocument, field: "preferredAngle" | "showLocalAxes") {
  const { joints, ...inputs } = next, { joints: oldJoints, ...oldInputs } = previous;
  const keys = Object.keys(inputs) as (keyof typeof inputs)[];
  if (keys.length !== Object.keys(oldInputs).length || keys.some(key => inputs[key] !== oldInputs[key])
    || !joints || !oldJoints || joints.length !== oldJoints.length) return false;
  let changed = false;
  for (let index = 0; index < joints.length; index++) {
    if (joints[index] === oldJoints[index]) continue;
    const { [field]: value, ...joint } = joints[index], { [field]: oldValue, ...oldJoint } = oldJoints[index];
    if (JSON.stringify(joint) !== JSON.stringify(oldJoint)) return false;
    changed ||= JSON.stringify(value) !== JSON.stringify(oldValue);
  }
  return changed;
}

function retainsDraft(next: SceneDocument, previous: SceneDocument, label: string) {
  // Joint renames replace their array but do not change the evaluated pose.
  return label.startsWith("Rename") || (
    next.animation === previous.animation && next.joints === previous.joints &&
    next.drivenKeys === previous.drivenKeys && next.ikHandles === previous.ikHandles &&
    next.constraints === previous.constraints
  ) || changesOnlyIKBlend(next, previous) || changesOnlyJointMetadata(next, previous, "preferredAngle")
    || changesOnlyJointMetadata(next, previous, "showLocalAxes");
}

/**
 * Temporary unkeyed poses belong to a document revision and one continuous time
 * editing session. Call clear on scrub, playback, project replacement, or when a
 * pose is consumed by keying. Undo can restore a draft only within that session.
 *
 * Weak keys avoid retaining scene history after Zundo drops an old revision.
 */
export class PoseDrafts {
  private epoch = 0;
  private readonly snapshots = new WeakMap<SceneDocument, DraftSnapshot>();
  private readonly seen = new WeakSet<SceneDocument>();

  /** Snapshot before synchronous store subscribers run, then consume only the
   * channels' destination poses. Mirroring must retain the source preview. */
  preserveAcrossEdit(previous: SceneDocument, poses: ReadonlyMap<string, AnimationPose>, consumedIds: Iterable<string>, action: () => SceneDocument): Map<string, AnimationPose> {
    const saved = copyExistingPoses(previous, poses), consumed = new Set(consumedIds);
    this.capture(previous, saved);
    const next = action();
    const retained = copyExistingPoses(next, saved);
    if (next !== previous) for (const id of consumed) retained.delete(id);
    this.capture(next, retained);
    return retained;
  }

  /** Capture before committing the corresponding immutable document revision. */
  capture(document: SceneDocument, poses: ReadonlyMap<string, AnimationPose>): void {
    this.snapshots.set(document, { epoch: this.epoch, poses: copyExistingPoses(document, poses) });
    this.seen.add(document);
  }

  /** Restore on a document transition; returned poses can safely be edited. */
  restore(next: SceneDocument, previous: SceneDocument, label: string): Map<string, AnimationPose> {
    // The first transition also records the initial, potentially draft-free,
    // document. Otherwise undoing to it could inherit the newer draft.
    this.seen.add(previous);
    let snapshot = this.snapshots.get(next);
    if (!this.seen.has(next) && !snapshot && retainsDraft(next, previous, label)) {
      const source = this.snapshots.get(previous);
      snapshot = {
        epoch: this.epoch,
        poses: source?.epoch === this.epoch ? copyExistingPoses(next, source.poses) : new Map(),
      };
      this.snapshots.set(next, snapshot);
    }
    this.seen.add(next);
    return snapshot?.epoch === this.epoch ? copyExistingPoses(next, snapshot.poses) : new Map();
  }

  /** Invalidate all historical poses without retaining or traversing documents. */
  clear(): void { this.epoch++; }
}
