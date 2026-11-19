import type { CurveKey } from "./animation.ts";

/** PR43 archives omit curve fields and use linear segments. The runtime identity
 * stays with the immutable key object through edits and undo. */
export type SplatDeformerKey = { channel: string; frame: number; value: number }
  & Partial<Omit<CurveKey, "time" | "value" | "id">>;
const identities = new WeakMap<SplatDeformerKey, string>();
const curves = new WeakMap<readonly SplatDeformerKey[], Map<string, CurveKey[]>>();

export function deformerCurves(keys: readonly SplatDeformerKey[]) {
  const cached = curves.get(keys);
  if (cached) return cached;
  const result = new Map<string, CurveKey[]>();
  for (const key of keys) {
    let id = identities.get(key);
    if (!id) { id = crypto.randomUUID(); identities.set(key, id); }
    const { channel, frame, ...fields } = key;
    const curve = result.get(channel) ?? [];
    curve.push({ interpolation: "linear", tangentMode: "auto", ...fields, id, time: frame });
    result.set(channel, curve);
  }
  curves.set(keys, result);
  return result;
}

export function storedDeformerKey(channel: string, curve: CurveKey): SplatDeformerKey {
  const { id, time, ...fields } = curve;
  const key = { ...fields, channel, frame: time };
  identities.set(key, id);
  return key;
}

export function changedDeformerKey(key: SplatDeformerKey, value: number): SplatDeformerKey {
  if (key.value === value) return key;
  const next = { ...key, value };
  const id = identities.get(key);
  if (id) identities.set(next, id);
  return next;
}
