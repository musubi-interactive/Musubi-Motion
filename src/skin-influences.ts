import { Matrix4 } from "three";
import type { SkinBinding, SkinInfluence } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import { MAX_WEIGHT_OVERRIDES, validateSkinWeightCount, validateSkinWeights, type SkinWeightContext } from "./skin-weights.ts";

/** Changing the automatic distance-weight palette would change untouched rows.
 * Materialize the effective weights first so palette edits preserve all rows. */
function prepare(store: SceneStore, shapeId: string, context: SkinWeightContext) {
  const doc = store.getState().document, shape = doc.nodes[shapeId];
  if (shape?.type !== "splatShape" || !shape.binding) throw Error("Select a bound splat shape.");
  const binding = shape.binding;
  validateSkinWeights(binding); validateSkinWeightCount(binding, context.count);
  if (!Number.isSafeInteger(context.count) || context.count < 0 || context.count > MAX_WEIGHT_OVERRIDES)
    throw Error("Preserving influence weights requires at most 200,000 loaded components. The binding was not changed.");
  const overrides: Record<string, SkinInfluence[]> = {};
  for (let index = 0; index < context.count; index++) {
    const row = binding.weights?.overrides[String(index)] ?? context.getWeights(index);
    overrides[String(index)] = row.map(entry => ({ ...entry }));
  }
  validateSkinWeights({ ...binding, weights: { count: context.count, overrides } });
  return { doc, shape, binding, overrides };
}
function commit(store: SceneStore, shapeId: string, prepared: ReturnType<typeof prepare>, binding: SkinBinding, editLabel: string) {
  validateSkinWeights(binding);
  if (store.getState().document !== prepared.doc) throw Error("The scene changed while reading weights. Retry the influence edit.");
  store.setState({ document: { ...prepared.doc, nodes: { ...prepared.doc.nodes, [shapeId]: { ...prepared.shape, binding } } }, editLabel });
}

/** Add with zero effective weight; subsequent paint/numeric edits assign weight.
 * restMatrix is the joint's current bind matrix in the splat object's space. */
export function addSkinInfluence(store: SceneStore, shapeId: string, jointId: string, restMatrix: readonly number[], context: SkinWeightContext): void {
  const doc = store.getState().document, shape = doc.nodes[shapeId];
  if (shape?.type !== "splatShape" || !shape.binding) throw Error("Select a bound splat shape.");
  if (!doc.joints?.some(joint => joint.id === jointId)) throw Error("Choose an existing joint to add.");
  if (shape.binding.jointIds.includes(jointId)) return;
  if (shape.binding.jointIds.length >= 256) throw Error("A binding supports at most 256 joint influences.");
  if (!Array.isArray(restMatrix) || restMatrix.length !== 16 || !Array.from({ length: 16 }, (_, i) => restMatrix[i]).every(Number.isFinite)
    || Math.abs(restMatrix[3]) > 1e-8 || Math.abs(restMatrix[7]) > 1e-8 || Math.abs(restMatrix[11]) > 1e-8 || Math.abs(restMatrix[15] - 1) > 1e-8
    || Math.abs(new Matrix4().fromArray(restMatrix).determinant()) < 1e-12) throw Error("The added influence requires a finite invertible affine bind matrix.");
  const prepared = prepare(store, shapeId, context), { binding, overrides } = prepared;
  commit(store, shapeId, prepared, { ...binding, jointIds: [...binding.jointIds, jointId], restMatrices: [...binding.restMatrices, [...restMatrix]], weights: { count: context.count, overrides } }, "Add skin influence");
}

/** Remaining weights retain their proportions. A sole removed influence needs
 * an explicit replacement; this never silently chooses an unrelated joint. */
export function removeSkinInfluence(store: SceneStore, shapeId: string, jointId: string, context: SkinWeightContext, replacementId?: string): void {
  const prepared = prepare(store, shapeId, context), { binding, overrides } = prepared;
  if (binding.lockedJointIds?.length) throw Error("Unlock held influences before removing a bound joint.");
  const index = binding.jointIds.indexOf(jointId);
  if (index < 0) throw Error("Choose a bound joint influence to remove.");
  if (binding.jointIds.length === 1) throw Error("Cannot remove the last bound influence. Unbind the object instead.");
  if (replacementId !== undefined && (replacementId === jointId || !binding.jointIds.includes(replacementId))) throw Error("Choose a different bound replacement influence.");
  for (const [key, row] of Object.entries(overrides)) {
    const remaining = row.filter(entry => entry.jointId !== jointId), total = remaining.reduce((sum, entry) => sum + entry.weight, 0);
    if (remaining.length === row.length) continue;
    if (total <= 0) {
      if (!replacementId) throw Error("Some components use only this influence. Choose an explicit replacement before removing it.");
      overrides[key] = [{ jointId: replacementId, weight: 1 }];
    } else overrides[key] = remaining.map(entry => ({ ...entry, weight: entry.weight / total }));
  }
  commit(store, shapeId, prepared, { ...binding, jointIds: binding.jointIds.filter(id => id !== jointId), restMatrices: binding.restMatrices.filter((_, i) => i !== index), weights: { count: context.count, overrides } }, "Remove skin influence");
}
