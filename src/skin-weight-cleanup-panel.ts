import { previewWeightCleanup, type CleanupOperation } from "./skin-weight-mirror.ts";
import type { CleanupContext } from "./skin-weight-smoothing.ts";
import { commitWeightRows, setInfluenceLock } from "./skin-weights.ts";
import type { SceneStore } from "./scene-store.ts";
import type { SplatShapeNode } from "./scene-document.ts";

type Options = {
  shape(): SplatShapeNode;
  context(id: string): CleanupContext | undefined;
  targets(count: number): number[];
  joint(): string;
  available(): boolean;
  show(preview?: { shapeId: string; jointId: string; indices: number[]; values: number[] }): void;
};
export function createWeightCleanupPanel(store: SceneStore, options: Options) {
  const element = document.createElement("fieldset");
  element.innerHTML = `<legend>Weight cleanup</legend>
    <label class="weight-check"><input type="checkbox" data-lock>Hold selected influence</label>
    <label>Cleanup operation<select data-op><option value="smooth">Smooth selected weights</option><option value="mirror">Mirror skin weights</option></select></label>
    <label>Distance in object units<input data-radius type="number" min="0.000001" step="any" value="0.1"></label>
    <label data-strength>Strength<input type="number" min="0" max="1" step="0.01" value="0.5"></label>
    <div data-mirror hidden><label>Mirror plane in bind space<select data-axis><option value="0">YZ</option><option value="1">XZ</option><option value="2">XY</option></select></label>
    <label>Source side<select data-side><option value="1">Positive to negative</option><option value="-1">Negative to positive</option></select></label>
    <label>First influence<select data-first></select></label><label>Paired influence<select data-second></select></label>
    <button type="button" data-pair>Pair influences</button> <button type="button" data-clear>Clear pairs</button>
    <p data-pairs></p></div>
    <div class="weight-actions"><button type="button" data-preview>Preview weights</button><button type="button" data-apply disabled>Apply preview</button><button type="button" data-cancel disabled>Cancel preview</button></div><p role="status" aria-live="polite"></p>`;
  const input = (s: string) => element.querySelector<HTMLInputElement>(s)!;
  const select = (s: string) => element.querySelector<HTMLSelectElement>(s)!;
  const button = (s: string) => element.querySelector<HTMLButtonElement>(s)!;
  const lock = input("[data-lock]"), op = select("[data-op]"), radius = input("[data-radius]"), strength = input("[data-strength] input");
  const axis = select("[data-axis]"), side = select("[data-side]"), first = select("[data-first]"), second = select("[data-second]");
  const preview = button("[data-preview]"), apply = button("[data-apply]"), cancel = button("[data-cancel]"), status = element.querySelector("p[role=status]")!;
  let revision = 0, signature = "", active = false;
  let commit: (() => void) | undefined;
  const pairs = new Map<string,string>();
  const names = () => new Map(store.getState().document.joints?.map(joint => [joint.id, joint.name]));
  function showPairs() {
    const n = names();
    element.querySelector("[data-pairs]")!.textContent = [...pairs].filter(([a,b]) => a < b).map(([a,b]) => `${n.get(a) ?? a} ↔ ${n.get(b) ?? b}`).join(", ") || "Unpaired influences keep their joint IDs.";
  }
  function discard() {
    revision++; if (active) options.show(); active = false; commit = undefined;
    apply.disabled = cancel.disabled = true; preview.disabled = false; status.textContent = "";
  }
  function report(error: unknown) { status.textContent = error instanceof Error ? error.message : String(error); }
  lock.onchange = () => { try { setInfluenceLock(store, options.shape().id, options.joint(), lock.checked); } catch(error) { report(error); } };
  button("[data-pair]").onclick = () => {
    discard(); const a = first.value, b = second.value;
    if (!a || !b || a === b) { status.textContent = "Choose two distinct influences."; return; }
    for (const id of [a,b]) if (pairs.has(id)) { pairs.delete(pairs.get(id)!); pairs.delete(id); }
    pairs.set(a,b); pairs.set(b,a); showPairs();
  };
  button("[data-clear]").onclick = () => { discard(); pairs.clear(); showPairs(); };
  cancel.onclick = discard;
  element.addEventListener("input", () => {
    discard(); const mirror = op.value === "mirror";
    element.querySelector<HTMLElement>("[data-mirror]")!.hidden = !mirror;
    element.querySelector<HTMLElement>("[data-strength]")!.hidden = mirror;
  });
  window.addEventListener("keydown", event => {
    if (active && event.key === "Escape") { event.preventDefault(); discard(); }
  }, true);
  preview.onclick = async () => {
    discard(); const token = revision;
    try {
      const shape = options.shape(), context = options.context(shape.id), jointId = options.joint();
      if (!context || !options.available()) throw Error("Select a loaded bound splat object and pause playback.");
      const document = store.getState().document;
      const cancelled = () => token !== revision || store.getState().document !== document || !options.available();
      const operation: CleanupOperation = op.value === "smooth"
        ? {kind:"smooth", strength:strength.valueAsNumber, radius:radius.valueAsNumber, targets:options.targets(context.count)}
        : {kind:"mirror", axis:Number(axis.value) as 0|1|2, direction:Number(side.value) as 1|-1, radius:radius.valueAsNumber, pairs:new Map(pairs)};
      active = true; preview.disabled = true; cancel.disabled = false; status.textContent = "Preparing weight preview…";
      const result = await previewWeightCleanup(context, operation, cancelled);
      if (cancelled()) return;
      const rows = [...result.changes], sample = Array.from({length:Math.min(5000, rows.length)}, (_,i) => rows[Math.floor(i*rows.length/Math.min(5000,rows.length))]);
      options.show({shapeId:shape.id, jointId, indices:sample.map(([id]) => +id), values:sample.map(([,row]) => row.find(v=>v.jointId===jointId)?.weight ?? 0)});
      status.textContent = `${result.matched} matched · ${result.unmatched} unmatched · ${rows.length} changed. Preview shows the selected influence.`;
      commit = () => {
        if (cancelled()) throw Error("Preview changed. Prepare a fresh weight preview.");
        commitWeightRows(store,shape.id,context,result.changes,operation.kind === "smooth" ? "Smooth skin weights" : "Mirror skin weights");
      };
      apply.disabled = !rows.length; preview.disabled = false;
    } catch (error) { if (token === revision) { discard(); report(error); } }
  };
  apply.onclick = () => { try { commit?.(); discard(); } catch (error) { discard(); report(error); } };
  let state: object | undefined, targetKey = "";
  function refresh(shape?: SplatShapeNode, selectionKey = "") {
    const next = store.getState().document, jointId = options.joint(), disabled = !shape?.binding || !options.available();
    selectionKey += "/" + jointId + "/" + shape?.id;
    if (next !== state || selectionKey !== targetKey || disabled && active) { state = next; targetKey = selectionKey; discard(); }
    element.hidden = !shape; element.disabled = disabled;
    if (!shape?.binding) return;
    lock.checked = shape.binding.lockedJointIds?.includes(jointId) ?? false;
    const n = names(), key = JSON.stringify([shape.id,shape.binding.jointIds.map(id => [id,n.get(id)])]);
    if (key !== signature) {
      signature = key; pairs.clear(); showPairs();
      for (const menu of [first,second]) menu.replaceChildren(...shape.binding.jointIds.map(id => new Option(n.get(id) ?? id,id)));
      second.selectedIndex = Math.min(1,second.options.length-1);
    }
  }
  return {element, refresh, get active() { return active; }};
}
