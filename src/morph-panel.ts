import { evaluateChannels, setKeys, type AnimationChannel } from "./animation.ts";
import type { MeshShapeNode, SplatShapeNode } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export function createMorphPanel(host: HTMLElement, store: SceneStore, options: { getFrame(): number; available(): boolean; canKey(): boolean; onStatus(message: string): void }) {
  const element = document.createElement("section"); element.className = "morph-panel"; host.append(element);
  type Shape = MeshShapeNode | SplatShapeNode;
  let shape: Shape | undefined, signature = "";
  const inputs: HTMLInputElement[] = [], keys: HTMLButtonElement[] = [];
  function update(next: Shape | undefined) {
    shape = next; element.hidden = !shape?.morphTargets?.length;
    const nextSignature = JSON.stringify([shape?.id, shape?.morphTargets?.map(m => m.name)]);
    if (signature !== nextSignature) {
      signature = nextSignature; inputs.length = keys.length = 0; element.replaceChildren();
      const title = document.createElement("h3"); title.textContent = "Blend shapes"; element.append(title);
      shape?.morphTargets?.forEach((m, index) => {
        const row = document.createElement("label"), input = document.createElement("input"), key = document.createElement("button");
        row.style.cssText = "display:flex;align-items:center;gap:6px;margin:8px 0";
        input.type = "number"; input.step = ".01"; input.style.width = "65px"; input.setAttribute("aria-label", `${m.name} weight`);
        key.type = "button"; key.textContent = "Key"; key.setAttribute("aria-label", `Key ${m.name}`);
        function apply(keyed: boolean) {
          if (!shape || !options.available()) return;
          try {
            const value = Number(input.value); if (!Number.isFinite(value) || Math.abs(value) > 1e6) throw Error("Enter a finite blend-shape weight within ±1,000,000.");
            const doc = store.getState().document, current = doc.nodes[shape.id] as Shape, channel = `morph.${index}` as AnimationChannel;
            const animated = doc.animation?.tracks.some(t => t.targetId === current.parentId && t.channel === channel);
            if (keyed || animated) {
              if (!options.canKey()) throw Error("Switch to Animation mode to key blend shapes.");
              const pose = evaluateChannels(doc, current.parentId, options.getFrame()); pose.morphWeights![index] = value;
              setKeys(store, [current.parentId], options.getFrame(), new Map([[current.parentId, pose]]), [channel]);
            } else {
              const updateWeight = <T extends { weight: number }>(targets: T[]) =>
                targets.map((target, i) => i === index ? { ...target, weight: value } : target);
              const changed = current.type === "meshShape"
                ? { ...current, morphTargets: updateWeight(current.morphTargets!) }
                : { ...current, morphTargets: updateWeight(current.morphTargets!) };
              store.setState({ document: { ...doc, nodes: { ...doc.nodes, [current.id]: changed } }, editLabel: "Edit blend shape" });
            }
            options.onStatus("");
          } catch (error) { options.onStatus(error instanceof Error ? error.message : String(error)); }
        }
        input.onchange = () => apply(false); key.onclick = () => apply(true);
        row.append(m.name, input, key); element.append(row); inputs.push(input); keys.push(key);
      });
    }
    if (shape?.morphTargets) {
      const pose = evaluateChannels(store.getState().document, shape.parentId, options.getFrame());
      inputs.forEach((input, i) => { if (document.activeElement !== input) input.value = String(pose.morphWeights?.[i] ?? shape!.morphTargets![i].weight); input.disabled = !options.available(); });
      keys.forEach(key => { key.disabled = !options.available() || !options.canKey(); });
    }
  }
  return { update };
}
