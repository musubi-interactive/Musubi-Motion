import { allocateSkinRow, indexSkinNeighborhood, sameSkinRow, smoothSkinRow, type CleanupContext } from "./skin-weight-smoothing.ts";
import { MAX_WEIGHT_EDIT_COMPONENTS, type SkinInfluence } from "./skin-weights.ts";

export type CleanupOperation = { kind: "smooth"; strength: number; radius: number; targets: readonly number[] }
  | { kind: "mirror"; axis: 0 | 1 | 2; direction: 1 | -1; radius: number; pairs: Map<string,string> };

export async function previewWeightCleanup(context: CleanupContext, op: CleanupOperation, cancelled: () => boolean) {
  const length = op.kind === "smooth" ? op.targets.length : context.count;
  if (op.kind === "smooth" && length > MAX_WEIGHT_EDIT_COMPONENTS) throw Error("Smooth at most 20,000 selected originals.");
  const grid = await indexSkinNeighborhood(context, op.radius, cancelled);
  const changes = new Map<string,SkinInfluence[]>();
  let unmatched = 0, matched = 0;
  for (let n = 0; n < length; n++) {
    if (n % 128 === 0) {
      if (n) await new Promise(resolve => setTimeout(resolve, 0));
      if (cancelled()) throw new DOMException("Weight cleanup canceled.", "AbortError");
    }
    const index = op.kind === "smooth" ? op.targets[n] : n;
    const p = grid.point(index);
    if (!p.every(Number.isFinite)) continue;
    let row: SkinInfluence[];
    if (op.kind === "smooth") row = smoothSkinRow(context, grid, index, op.strength);
    else {
      if (p[op.axis]*op.direction >= 0) continue;
      p[op.axis] *= -1;
      const [source] = grid.nearest(p, 1, i => grid.point(i)[op.axis]*op.direction > 0);
      if (source === undefined) { unmatched++; continue; }
      const desired = new Map<string,number>();
      for (const influence of context.getWeights(source)) {
        const id = op.pairs.get(influence.jointId) ?? influence.jointId;
        desired.set(id, (desired.get(id) ?? 0) + influence.weight);
      }
      row = allocateSkinRow(context.getWeights(index), desired, context.locked);
    }
    matched++;
    if (!sameSkinRow(row, context.getWeights(index))) changes.set(String(index), row);
    if (changes.size > MAX_WEIGHT_EDIT_COMPONENTS) throw Error("Cleanup exceeds 20,000 changed originals. Use a smaller region or matching distance.");
  }
  return {changes, matched, unmatched};
}
