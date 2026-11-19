import type { SkinInfluence, Vec3 } from "./scene-document.ts";
import type { SkinWeightContext } from "./skin-weights.ts";

export type CleanupContext = SkinWeightContext & { restPosition(index: number): Vec3 | undefined; locked: ReadonlySet<string> };
const limit = 200_000;

/** Immutable rest-space grid. Stable distance ties use the original asset index. */
export async function indexSkinNeighborhood(context: CleanupContext, radius: number, cancelled: () => boolean) {
  if (!Number.isFinite(radius) || radius <= 0) throw Error("Choose a positive finite neighborhood distance in object units.");
  if (context.count > limit || !Number.isSafeInteger(context.count) || context.count < 1) throw Error("Weight cleanup supports 1 to 200,000 bound originals per object.");
  const cells = new Map<string, number[]>(), positions = new Float64Array(context.count * 3).fill(NaN);
  const cell = (n: number) => Math.floor(n / radius);
  for (let i = 0; i < context.count; i++) {
    if (i % 2048 === 0) {
      if (i) await new Promise(resolve => setTimeout(resolve, 0));
      if (cancelled()) throw new DOMException("Weight cleanup canceled.", "AbortError");
    }
    const p = context.restPosition(i);
    if (!p) continue;
    if (!p.every(Number.isFinite) || p.some(n => !Number.isSafeInteger(cell(n)))) throw Error("Rest centers exceed the neighborhood coordinate range.");
    positions.set(p, i * 3);
    const key = p.map(cell).join("/");
    const bucket = cells.get(key);
    if (bucket) bucket.push(i); else cells.set(key, [i]);
  }
  let visits = 0;
  function point(index: number): Vec3 { return [positions[index*3], positions[index*3+1], positions[index*3+2]]; }
  function nearest(p: Vec3, count: number, accepts: (i: number) => boolean) {
    const best: {index: number; distance: number}[] = [];
    let localVisits = 0;
    const [cx, cy, cz] = p.map(cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const index of cells.get(`${cx+dx}/${cy+dy}/${cz+dz}`) ?? []) {
        if (++localVisits > 16_384 || ++visits > 8_000_000) throw Error("Neighborhood is too dense. Reduce the distance or selected region.");
        if (!accepts(index)) continue;
        const distance = (positions[index*3]-p[0])**2 + (positions[index*3+1]-p[1])**2 + (positions[index*3+2]-p[2])**2;
        if (distance > radius*radius) continue;
        const at = best.findIndex(hit => hit.distance > distance || hit.distance === distance && hit.index > index);
        if (at >= 0) best.splice(at, 0, {index, distance}); else if (best.length < count) best.push({index, distance});
        if (best.length > count) best.pop();
      }
    }
    return best.map(hit => hit.index);
  }
  return {point, nearest};
}

export type SkinNeighborhood = Awaited<ReturnType<typeof indexSkinNeighborhood>>;

/** Keep held target weights exactly, allocating remaining capacity to up to four positive influences. */
export function allocateSkinRow(current: SkinInfluence[], desired: Map<string,number>, locked: ReadonlySet<string>): SkinInfluence[] {
  if (!current.length || current.length > 4 || current.some(r => !(r.weight > 0) || !Number.isFinite(r.weight)) || Math.abs(current.reduce((sum,r) => sum+r.weight,0)-1) > 1e-8) throw Error("Cannot clean up an unbound or invalid weight row.");
  const held = current.filter(row => locked.has(row.jointId)), remaining = 1 - held.reduce((sum, row) => sum + row.weight, 0);
  if (remaining < -1e-8) throw Error("Locked weights exceed one.");
  if (remaining <= 0 || held.length === current.length && Math.abs(remaining) < 1e-8) return held;
  const free = [...desired].filter(([id,weight]) => !locked.has(id) && weight > 0)
    .sort(([a,wa],[b,wb]) => wb-wa || (a < b ? -1 : 1)).slice(0,4-held.length);
  const sum = free.reduce((n,[,w]) => n+w,0);
  if (!(sum > 0) || !Number.isFinite(sum)) throw Error("No unlocked influence can receive the remaining skin weight.");
  return [...held,...free.map(([jointId,weight]) => ({jointId,weight:weight/sum*remaining}))];
}

export function sameSkinRow(a: SkinInfluence[], b: SkinInfluence[]) {
  return a.length === b.length && a.every(row => Math.abs((b.find(v => v.jointId === row.jointId)?.weight ?? 0) - row.weight) < 1e-12);
}

export function smoothSkinRow(context: CleanupContext, grid: SkinNeighborhood, index: number, amount: number) {
  if (!(amount >= 0 && amount <= 1)) throw Error("Smooth strength must be between zero and one.");
  const current = context.getWeights(index), position = grid.point(index);
  if (!amount || !position.every(Number.isFinite)) return current;
  const neighbors = grid.nearest(position, 8, other => other !== index);
  if (!neighbors.length) return current;
  const desired = new Map(current.map(row => [row.jointId, row.weight * (1-amount)]));
  for (const neighbor of neighbors) for (const {jointId, weight} of context.getWeights(neighbor)) {
    desired.set(jointId, (desired.get(jointId) ?? 0) + amount * weight / neighbors.length);
  }
  return allocateSkinRow(current, desired, context.locked);
}
