import { bezierTurningFrames, evaluateCurve, insertCurveKey, tangentSlope, type CurveKey } from "./animation.ts";
import { deformerCurves, type SplatDeformerKey } from "./splat-deformer-curves.ts";
import type { SplatDeformer } from "./splat-deformers.ts";
import { latticeRestPoint, type SplatLattice } from "./splat-lattice.ts";
import type { ControlPoint } from "./splat-control-points.ts";

const same = (a: number, b: number) => Math.abs(a - b) <= 2e-10 * Math.max(1, Math.abs(a), Math.abs(b));
const unsupported = (reason: string) => Error(reason + " The original lattice is intact. Choose Reset point edits and keys to start a new bind.");

/** One degree at a time. The inverse recurrence for reduction is checked at
 * its independent endpoint so a non-representable polynomial is never baked. */
function changeDegree(line: number[], count: number, check: boolean): number[] {
  while (line.length < count) {
    const n = line.length;
    line = [line[0], ...line.slice(1).map((v, i) => v + (line[i] - v) * (i + 1) / n), line[n - 1]];
  }
  while (line.length > count) {
    const n = line.length - 1, next = [line[0]];
    for (let i = 1; i < n; i++) next.push((n * line[i] - i * next[i - 1]) / (n - i));
    if (check && !same(next[n - 1], line[n])) throw unsupported("This lower resolution cannot reproduce the authored shape exactly.");
    line = next;
  }
  return line;
}
function convertGrid(values: number[], original: ControlPoint, target: ControlPoint, check = true) {
  const dims: ControlPoint = [...original];
  for (let axis = 0; axis < 3; axis++) {
    if (dims[axis] === target[axis]) continue;
    const stride = dims.slice(0, axis).reduce((a, b) => a * b, 1);
    const blocks = values.length / (stride * dims[axis]);
    const next = Array<number>(blocks * stride * target[axis]);
    for (let block = 0; block < blocks; block++) for (let offset = 0; offset < stride; offset++) {
      const line = Array.from({ length: dims[axis] }, (_, i) => values[(block * dims[axis] + i) * stride + offset]);
      changeDegree(line, target[axis], check).forEach((v, i) => { next[(block * target[axis] + i) * stride + offset] = v; });
    }
    values = next;
    dims[axis] = target[axis];
  }
  return values;
}

type Segment = { step: boolean; curved: boolean; left: number; right: number; slopeOut: number; slopeIn: number; wOut: number; wIn: number };
function segmentAt(keys: CurveKey[] | undefined, base: number, start: number, end: number): Segment {
  const left = keys ? evaluateCurve(keys, start)! : base, right = keys ? evaluateCurve(keys, end)! : base;
  const constant = { left, right, step: false, curved: false, slopeOut: 0, slopeIn: 0, wOut: 1 / 3, wIn: 1 / 3 };
  if (!keys || start >= keys[keys.length - 1].time || end <= keys[0].time) return constant;
  let curve = keys;
  let i = 0;
  while (i + 1 < curve.length && curve[i + 1].time <= start) i++;
  if (curve[i].interpolation === "step") return { ...constant, step: left !== right };
  const slope = (right - left) / (end - start);
  if (curve[i].interpolation === "linear") return { ...constant, slopeOut: slope, slopeIn: slope };
  if (curve[i].time !== start) { curve = insertCurveKey(curve, start).keys; i++; }
  if (curve[i + 1].time !== end) curve = insertCurveKey(curve, end).keys;
  const slopeOut = tangentSlope(curve, i, "out"), slopeIn = tangentSlope(curve, i + 1, "in");
  return { ...constant, curved: !same(slope, slopeOut) || !same(slope, slopeIn), slopeOut, slopeIn,
    wOut: curve[i].outWeight ?? 1 / 3, wIn: curve[i + 1].inWeight ?? 1 / 3 };
}

/** Preserve the whole Bernstein volume and its derivative at all times, including
 * the authored fallback when keys are removed. Weighted curves with incompatible
 * time parameterizations are refused rather than approximated. */
export function rebindLattice(entry: SplatDeformer, next: SplatLattice, reset = false): SplatDeformer {
  const old = entry.params as SplatLattice;
  const envelope = entry.keys?.filter(key => key.channel === "envelope") ?? [];
  const pointKeys = entry.keys?.filter(key => key.channel !== "envelope") ?? [];
  if (reset || (!pointKeys.length && old.offsets.every(p => p.every(v => v === 0)))) return { ...entry, params: next, keys: envelope };
  if (!old.center.every((v, a) => v === next.center[a]) || !old.size.every((v, a) => v === next.size[a]))
    throw unsupported("Changing the bind bounds changes which splats are inside the lattice.");
  if (old.divisions.every((v, a) => v === next.divisions[a])) return entry;

  const offsets = next.offsets.map((): ControlPoint => [0, 0, 0]);
  const output: SplatDeformerKey[] = [...envelope];
  const curves = deformerCurves(pointKeys);
  const srcRest = old.offsets.map((_, i) => latticeRestPoint(old, i));
  const dstRest = next.offsets.map((_, i) => latticeRestPoint(next, i));
  for (const [axis, name] of ["x", "y", "z"].entries()) {
    const convert = (v: number[]) => convertGrid(v, old.divisions, next.divisions);
    convert(old.offsets.map(p => p[axis])).forEach((v, i) => { offsets[i][axis] = v; });
    const source = old.offsets.map((_, i) => curves.get(`point.${i}.${name}`));
    const frames = [...new Set(source.flatMap(c => c?.map(k => k.time) ?? []))].sort((a, b) => a - b);
    if (!frames.length) continue;
    const base = srcRest.map((p, i) => p[axis] + old.offsets[i][axis]);
    const destination = offsets.map((): SplatDeformerKey[] => []);
    const varying = offsets.map(() => false);
    for (const [i, curve] of source.entries()) if (curve) {
      for (const time of bezierTurningFrames(curve, -Infinity, Infinity)) {
        if (Math.abs(evaluateCurve(curve, time)! - srcRest[i][axis]) > 1e8)
          throw unsupported("A keyed point exceeds its offset limits between keys.");
      }
      // Keep even constant authored channels keyable after resolution changes.
      const weights = convertGrid(source.map((_, j) => Number(i === j)), old.divisions, next.divisions, false);
      weights.forEach((w, j) => { if (w !== 0) varying[j] = true; });
    }
    if (output.length + frames.length * varying.filter(Boolean).length > 4096)
      throw unsupported("The preserved animation would exceed the per-deformer key limit.");
    const keyAt = (frame: number) => {
      const values = convert(source.map((c, i) => c ? evaluateCurve(c, frame)! - srcRest[i][axis] : old.offsets[i][axis]));
      return values.map((v, i): SplatDeformerKey => {
        if (!same(v, offsets[i][axis])) varying[i] = true;
        return { channel: `point.${i}.${name}`, frame, value: dstRest[i][axis] + v };
      });
    };
    let previous = keyAt(frames[0]);
    previous.forEach((k, i) => destination[i].push(k));
    for (let t = 1; t < frames.length; t++) {
      const start = frames[t - 1], end = frames[t], current = keyAt(end);
      const segments = source.map((c, i) => segmentAt(c, base[i], start, end));
      const steps = convert(segments.map(s => s.step ? s.right - s.left : 0));
      const outgoing = convert(segments.map(s => s.slopeOut)), incoming = convert(segments.map(s => s.slopeIn));
      const weighted = segments.filter(s => s.curved);
      const reference = weighted[0];
      if (reference && weighted.some(s => !same(s.wIn, reference.wIn) || !same(s.wOut, reference.wOut)))
        throw unsupported("These animated points have incompatible weighted tangent timing.");
      for (let i = 0; i < offsets.length; i++) {
        const left = previous[i], right = current[i], span = end - start;
        if (!same(steps[i], 0)) {
          if (!same(steps[i], right.value - left.value) || !same(outgoing[i], 0) || !same(incoming[i], 0))
            throw unsupported("A continuous move and a stepped jump share a destination point.");
          left.interpolation = "step";
        } else if (reference && (!same(outgoing[i], (right.value - left.value) / span) || !same(incoming[i], (right.value - left.value) / span))) {
          Object.assign(left, { interpolation: "bezier", tangentMode: "fixed", outSlope: outgoing[i], outWeight: reference.wOut, broken: true });
          Object.assign(right, { tangentMode: "fixed", inSlope: incoming[i], inWeight: reference.wIn, broken: true });
          varying[i] = true;
        }
        destination[i].push(right);
      }
      previous = current;
    }
    for (let i = 0; i < destination.length; i++) if (varying[i]) {
      if (output.length + destination[i].length > 4096) throw unsupported("The preserved animation would exceed the per-deformer key limit.");
      output.push(...destination[i]);
    }
  }
  return { ...entry, params: { ...next, offsets }, keys: output };
}
