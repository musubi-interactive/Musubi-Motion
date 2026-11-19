import { MAX_CAGE_VERTICES } from "./splat-cage.ts";
import type { ControlPoint } from "./splat-control-points.ts";
import { propertyInteraction } from "./property-interaction.ts";
import { MAX_LATTICE_DIVISIONS, resizeSplatLattice, type SplatLattice } from "./splat-lattice.ts";

type Actions = {
  rebindLattice(shapeId: string, id: string, params: SplatLattice): void;
  rebindCage(shapeId: string, id: string, meshId: string): void;
};
type ActiveBinding = { shapeId: string; id: string; kind: string; params: unknown; meshes: readonly { id: string; name: string }[] };
const properties = ["center", "size", "divisions"] as const;

export function createSplatCageBindingPanel(actions: Actions) {
  const element = document.createElement("fieldset");
  element.className = "splat-cage-binding";
  element.style.cssText = "min-width:0;margin:8px 0;padding:8px;border:1px solid var(--line);border-radius:3px";
  element.hidden = true;
  element.innerHTML = `<legend>Bind Geometry</legend>
    <div data-lattice-bind><button type="button" data-rebind-lattice>Rebind Lattice</button></div>
    <div data-cage-bind hidden><label>Cage mesh <select aria-label="Cage mesh"></select></label>
      <button type="button" data-rebind-cage>Rebind from Mesh</button>
      <p>Choose a closed polygon mesh with up to ${MAX_CAGE_VERTICES} unique vertices. The mesh must enclose its vertex centroid.</p></div>
    <p>Rebinding resets point edits and keys. Enclose the splats you want the deformer to affect.</p>
    <p role="status" data-bind-status hidden></p>`;
  const latticeGroup = element.querySelector<HTMLDivElement>("[data-lattice-bind]")!;
  const cageGroup = element.querySelector<HTMLDivElement>("[data-cage-bind]")!;
  const latticeButton = element.querySelector<HTMLButtonElement>("[data-rebind-lattice]")!;
  const cageButton = element.querySelector<HTMLButtonElement>("[data-rebind-cage]")!;
  const meshSelect = cageGroup.querySelector("select")!;
  const status = element.querySelector<HTMLParagraphElement>("[data-bind-status]")!;
  let active: ActiveBinding | undefined;
  let signature = "";
  let meshSignature = "";
  const fields: Record<typeof properties[number], HTMLInputElement[]> = { center: [], size: [], divisions: [] };
  const refreshLocks: (() => void)[] = [];
  let focusValue = "";

  function showStatus(message: string) {
    status.textContent = message;
    status.hidden = !message;
  }

  for (const property of properties) {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:4.5em repeat(3,minmax(0,1fr));gap:4px;align-items:center;margin-bottom:6px";
    const caption = { center: "Center", size: "Size", divisions: "Divisions" }[property];
    const heading = document.createElement("span");
    heading.textContent = caption;
    row.append(heading);
    for (const axis of ["X", "Y", "Z"]) {
      const label = document.createElement("label"), input = document.createElement("input"), axisLabel = document.createElement("span");
      axisLabel.textContent = axis;
      label.style.cssText = "display:flex;gap:2px;align-items:center;min-width:0";
      input.type = "number";
      input.required = true;
      // Accept arbitrary finite fractional coordinates; the shared scrub defaults to 0.1.
      input.step = property === "divisions" ? "1" : "any";
      input.style.cssText = "width:100%;min-width:0;text-align:right;font:inherit;padding:5px 3px;border:1px solid var(--line);border-radius:3px;color:var(--text);background:var(--bg)";
      input.setAttribute("aria-label", `Lattice ${caption} ${axis}`);
      if (property === "divisions") { input.min = "2"; input.max = String(MAX_LATTICE_DIVISIONS); }
      if (property === "size") input.min = "0.000001";
      fields[property].push(input);
      input.addEventListener("focus", () => { focusValue = input.value; });
      refreshLocks.push(propertyInteraction(input, () => `splat-lattice-bind:${active?.shapeId}:${active?.id}:${property}:${axis}`, axisLabel));
      input.addEventListener("keydown", event => {
        if (event.key !== "Escape" && event.key !== "Enter") return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === "Escape") input.value = focusValue;
        input.blur();
      });
      label.append(axisLabel, input); row.append(label);
    }
    latticeButton.before(row);
  }

  latticeButton.addEventListener("click", () => {
    if (!active || active.kind !== "lattice") return;
    for (const input of properties.flatMap(property => fields[property])) if (!input.reportValidity()) return;
    const read = (property: typeof properties[number]) => fields[property].map(input => input.valueAsNumber) as ControlPoint;
    try {
      actions.rebindLattice(active.shapeId, active.id, resizeSplatLattice(read("center"), read("size"), read("divisions")));
      showStatus("");
    } catch (error) { showStatus(error instanceof Error ? error.message : "Could not rebind lattice."); }
  });
  cageButton.addEventListener("click", () => {
    if (!active || active.kind !== "cage" || !meshSelect.value) return;
    try {
      actions.rebindCage(active.shapeId, active.id, meshSelect.value);
      showStatus("");
    } catch (error) { showStatus(error instanceof Error ? error.message : "Could not rebind polygon cage."); }
  });
  meshSelect.addEventListener("change", () => { cageButton.disabled = !meshSelect.value; showStatus(""); });

  return {
    element,
    update(value: ActiveBinding | undefined) {
      active = value && (value.kind === "lattice" || value.kind === "cage") ? value : undefined;
      element.hidden = !active;
      latticeGroup.hidden = active?.kind !== "lattice";
      cageGroup.hidden = active?.kind !== "cage";
      const rest = active?.kind === "lattice" ? active.params as SplatLattice : undefined;
      const nextSignature = active ? `${active.shapeId}:${active.id}:${rest ? JSON.stringify(properties.map(name => rest[name])) : ""}` : "";
      const nextMeshes = active?.kind === "cage" ? active.meshes : [];
      const nextMeshSignature = JSON.stringify(nextMeshes);
      if (nextMeshSignature !== meshSignature) {
        const currentMesh = meshSelect.value;
        meshSelect.replaceChildren(new Option(nextMeshes.length ? "Choose a mesh…" : "No polygon meshes", ""), ...nextMeshes.map(mesh => new Option(mesh.name, mesh.id)));
        if (nextMeshes.some(mesh => mesh.id === currentMesh)) meshSelect.value = currentMesh;
        meshSignature = nextMeshSignature;
      }
      if (nextSignature !== signature) meshSelect.value = "";
      meshSelect.disabled = !nextMeshes.length;
      cageButton.disabled = !meshSelect.value;
      if (nextSignature === signature) return;
      signature = nextSignature;
      showStatus("");
      if (rest) for (const property of properties) fields[property].forEach((input, axis) => { input.value = String(rest[property][axis]); });
      for (const refresh of refreshLocks) refresh();
    },
  };
}
