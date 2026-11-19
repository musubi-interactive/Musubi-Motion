import type { SceneDocument } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import { SPLAT_DEFORMER_LIMITS } from "./splat-deformers.ts";

function historySize(doc: SceneDocument, seen: Set<object>) {
  let bytes = 0;
  for (const shape of Object.values(doc.nodes)) if (shape.type === "splatShape") for (const entry of shape.deformers ?? []) {
    if (entry.weights && !seen.has(entry.weights)) {
      seen.add(entry.weights);
      bytes += entry.weights.length * 72;
    }
    if (entry.keys && !seen.has(entry.keys)) {
      seen.add(entry.keys);
      bytes += entry.keys.length * 224;
    }
    if (entry.params && typeof entry.params === "object" && !seen.has(entry.params)) {
      seen.add(entry.params);
      bytes += JSON.stringify(entry.params).length * 8;
    }
  }
  return bytes;
}

export function assertSplatDeformerUndoFits(before: SceneDocument, after: SceneDocument) {
  const seen = new Set<object>();
  if (historySize(after, seen) + historySize(before, seen) > SPLAT_DEFORMER_LIMITS.historyBytes)
    throw Error("This edit exceeds the splat deformer undo budget.");
}

export function trimSplatDeformerHistory(store: SceneStore) {
  const seen = new Set<object>();
  let bytes = historySize(store.getState().document, seen);
  const past = store.temporal.getState().pastStates;
  let first = past.length;
  while (first > 0) {
    const state = past[first - 1];
    if (state.document) bytes += historySize(state.document, seen);
    if (bytes > SPLAT_DEFORMER_LIMITS.historyBytes) break;
    first--;
  }
  if (first) store.temporal.setState({ pastStates: past.slice(first) });
}
