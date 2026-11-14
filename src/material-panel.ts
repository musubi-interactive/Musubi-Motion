import { MathUtils } from "three";
import {
  commitMeshMaterialTexture, EDITABLE_TEXTURE_SLOTS, materialTextureColorSpace, meshMaterialSlots,
  meshTextureUVEdit, meshUVCoordinates,
  type MaterialTextureTarget, type MeshTextureData, type MeshTextureSettings, type TextureUVField,
} from "./mesh-materials.ts";
import { propertyInteraction } from "./property-interaction.ts";
import type { MeshShapeNode } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import "./material-panel.css";

type Preview = { update(value: number): void; end(): void };
const numericFields: { key: TextureUVField; label: string; step: number; read(source: MeshTextureData): number }[] = [
  { key: "repeatU", label: "Repeat U", step: .1, read: source => source.repeat[0] },
  { key: "repeatV", label: "Repeat V", step: .1, read: source => source.repeat[1] },
  { key: "offsetU", label: "Offset U", step: .05, read: source => source.offset[0] },
  { key: "offsetV", label: "Offset V", step: .05, read: source => source.offset[1] },
  { key: "centerU", label: "Pivot U", step: .05, read: source => source.center[0] },
  { key: "centerV", label: "Pivot V", step: .05, read: source => source.center[1] },
  { key: "rotation", label: "Rotate UV (°)", step: 1, read: source => MathUtils.radToDeg(source.rotation) },
];

export function createMaterialPanel(store: SceneStore, options: {
  selectedMesh(): MeshShapeNode | undefined;
  available(): boolean;
  openAssets(): void;
  preview(target: MaterialTextureTarget, field: TextureUVField): Preview | undefined;
}) {
  const element = document.createElement("section");
  element.className = "material-panel";
  element.setAttribute("aria-label", "Materials");
  element.innerHTML = `
    <p data-mesh></p>
    <div data-controls hidden>
      <label>Material slot <select data-material aria-label="Material slot"></select></label>
      <label>Texture channel <select data-slot aria-label="Texture channel">
        <option value="map">Base Color</option><option value="alphaMap">Opacity</option>
        <option value="normalMap">Normal</option><option value="roughnessMap">Roughness</option>
      </select></label>
      <label>Image <select data-image aria-label="Image"></select></label>
      <div class="material-asset">
        <img alt="" hidden><span data-role></span><button type="button" data-library>Texture Assets…</button>
      </div>
      <fieldset data-mapping hidden><legend>Texture Mapping</legend>
        <label>Color space <select data-color aria-label="Color space"><option value="srgb">sRGB (Color)</option><option value="raw">Raw (Data)</option></select></label>
        <label>UV set <select data-uv aria-label="UV set"></select></label>
        <div class="material-numeric"></div>
        <label>Wrap U <select data-wrap-u aria-label="Wrap U"></select></label>
        <label>Wrap V <select data-wrap-v aria-label="Wrap V"></select></label>
        <label>Filter <select data-filter aria-label="Filter"><option value="nearest">Nearest</option><option value="linear">Linear</option><option value="mipmap">Mipmapped</option></select></label>
        <label class="material-checkbox"><input type="checkbox" data-flip> Flip image vertically</label>
      </fieldset>
    </div>
    <p class="material-status" role="status" hidden></p>`;
  const get = <T extends HTMLElement>(selector: string) => element.querySelector<T>(selector)!;
  const controls = get("[data-controls]"), status = get("[role=status]"), meshName = get("[data-mesh]"), mapping = get<HTMLFieldSetElement>("[data-mapping]");
  const material = get<HTMLSelectElement>("[data-material]"), slot = get<HTMLSelectElement>("[data-slot]"), image = get<HTMLSelectElement>("[data-image]");
  const color = get<HTMLSelectElement>("[data-color]"), uv = get<HTMLSelectElement>("[data-uv]"), filter = get<HTMLSelectElement>("[data-filter]");
  const wrapU = get<HTMLSelectElement>("[data-wrap-u]"), wrapV = get<HTMLSelectElement>("[data-wrap-v]");
  const flip = get<HTMLInputElement>("[data-flip]"), thumbnail = get<HTMLImageElement>("img"), role = get("[data-role]");
  const wraps = [["1001", "Clamp"], ["1000", "Repeat"], ["1002", "Mirror"]] as const;
  for (const control of [wrapU, wrapV]) control.replaceChildren(...wraps.map(([value, name]) => new Option(name, value)));
  get<HTMLButtonElement>("[data-library]").onclick = options.openAssets;
  let index = 0, shapeId: string | undefined, preview: Preview | undefined, revision = 0;
  let rendered: { shape?: MeshShapeNode; library: unknown; available: boolean } | undefined;

  function binding() {
    const shape = options.selectedMesh();
    if (!shape) return;
    const channel = EDITABLE_TEXTURE_SLOTS.find(value => value === slot.value) ?? "map";
    const target: MaterialTextureTarget = { shapeId: shape.id, index, slot: channel };
    return { target, source: shape.materials?.[index]?.[channel], shape };
  }
  function stopPreview() { preview?.end(); preview = undefined; }
  function showStatus(message = "") { status.textContent = message; status.hidden = !message; }
  function edit(edit: Parameters<typeof commitMeshMaterialTexture>[2]) {
    const current = binding();
    if (!current || !options.available()) return;
    try {
      commitMeshMaterialTexture(store, current.target, edit);
      refresh(true);
    } catch (error) {
      refresh(true);
      showStatus((error as Error).message);
    }
  }
  function settings(patch: MeshTextureSettings) { edit({ settings: patch }); }
  const fields = numericFields.map(({ key, label, step, read }) => {
    const fieldLabel = document.createElement("label"), caption = document.createElement("span"), field = document.createElement("input");
    caption.textContent = label;
    field.setAttribute("aria-label", label);
    field.type = "number"; field.step = String(step);
    field.min = key === "rotation" ? "-360000" : "-1000000";
    field.max = key === "rotation" ? "360000" : "1000000";
    fieldLabel.append(caption, field);
    get(".material-numeric").append(fieldLabel);
    const valueForTexture = (value: number) => key === "rotation" ? MathUtils.degToRad(value) : value;
    const valid = () => !!field.value && Number.isFinite(field.valueAsNumber) && !field.validity.rangeUnderflow && !field.validity.rangeOverflow;
    let typed: Preview | undefined;
    const refreshLock = propertyInteraction(field, () => `${shapeId}/${index}/${slot.value}/${key}/${revision}`, caption, () => {
      const current = binding();
      if (!current?.source || !options.available()) return;
      stopPreview();
      const active = options.preview(current.target, key);
      preview = active;
      return active && {
        update(value) { if (preview === active) active.update(valueForTexture(value)); },
        end() { if (preview === active) stopPreview(); },
      };
    }, {
      get: () => locks.has(`${shapeId}/${index}/${slot.value}/${key}`),
      toggle: () => {
        const id = `${shapeId}/${index}/${slot.value}/${key}`;
        if (locks.has(id)) locks.delete(id);
        else locks.add(id);
      },
    });
    field.addEventListener("input", () => {
      const current = binding();
      if (!current?.source || !options.available() || field.readOnly) return;
      if (!valid()) {
        if (typed && preview === typed) stopPreview();
        typed = undefined;
        return;
      }
      if (!typed || preview !== typed) {
        stopPreview();
        typed = preview = options.preview(current.target, key);
      }
      typed?.update(valueForTexture(field.valueAsNumber));
    });
    field.addEventListener("change", () => {
      const current = binding();
      if (typed && preview === typed) stopPreview();
      typed = undefined;
      if (!current?.source || field.readOnly) return;
      if (!valid()) {
        field.value = String(read(current.source));
        return;
      }
      if (field.valueAsNumber !== read(current.source)) {
        settings(meshTextureUVEdit(current.source, key, valueForTexture(field.valueAsNumber)));
      }
    });
    field.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); field.blur(); }
      if (event.key !== "Escape") return;
      const source = binding()?.source;
      if (!source || field.value === String(read(source))) return;
      event.preventDefault();
      event.stopPropagation();
      if (typed && preview === typed) stopPreview();
      typed = undefined;
      field.value = String(read(source));
    });
    return { field, read, refreshLock };
  });
  const locks = new Set<string>();
  material.onchange = () => { index = Number(material.value); refresh(true); };
  slot.onchange = () => refresh(true);
  image.onchange = () => { if (image.value !== "embedded") edit({ assetId: image.value || null }); };
  color.onchange = () => settings({ colorSpace: color.value === "srgb" ? "srgb" : "raw" });
  uv.onchange = () => settings({ channel: Number(uv.value) });
  wrapU.onchange = () => settings({ wrapS: Number(wrapU.value) });
  wrapV.onchange = () => settings({ wrapT: Number(wrapV.value) });
  filter.onchange = () => settings({ filter: filter.value as MeshTextureData["filter"] });
  flip.onchange = () => settings({ flipY: flip.checked });

  function refresh(force = false) {
    const shape = options.selectedMesh(), library = store.getState().document.textureAssets, available = options.available();
    if (!force && rendered && rendered.shape === shape && rendered.library === library && rendered.available === available) return;
    rendered = { shape, library, available };
    stopPreview(); revision++;
    showStatus();
    if (shapeId !== shape?.id) { shapeId = shape?.id; index = 0; slot.value = "map"; }
    controls.hidden = !shape;
    meshName.textContent = shape?.name ?? "Select one polygon mesh.";
    if (!shape) return;
    const materials = meshMaterialSlots(shape);
    if (index >= materials.length) index = 0;
    material.replaceChildren(...materials.map((entry, i) => new Option(`${i + 1}. ${entry.name || "Material"}`, String(i))));
    material.value = String(index);
    const { source, target } = binding()!;
    const asset = source?.assetId ? library?.[source.assetId] : undefined;
    const selected = source?.assetId ?? (source?.dataURI ? "embedded" : "");
    image.replaceChildren(new Option("None", ""), ...Object.values(library ?? {}).map(item => new Option(item.name, item.id)));
    if (selected && !asset) image.append(new Option(source?.dataURI ? "Embedded image" : "Missing texture asset", selected));
    image.value = selected;
    for (const control of [material, slot, image]) control.disabled = !available;
    thumbnail.hidden = !asset;
    if (asset) thumbnail.src = asset.thumbnail;
    else thumbnail.removeAttribute("src");
    const sourceRole = asset ? `${asset.role === "color" ? "Color" : "Data"} image · ${asset.width} × ${asset.height}` : "";
    const scalar = target.slot === "alphaMap" || target.slot === "roughnessMap" ? "Uses green channel" : "";
    role.textContent = [sourceRole, scalar].filter(Boolean).join(" · ");
    mapping.hidden = !source;
    mapping.disabled = !available;
    if (!source) return;
    if (source.assetId && !asset) showStatus("Missing texture asset. Choose another image or clear this channel.");
    const channels = [0, 1, 2, 3].filter(channel => meshUVCoordinates(shape, channel));
    uv.replaceChildren(...channels.map(channel => new Option(`UV ${channel}`, String(channel))));
    if (!channels.includes(source.channel)) {
      uv.append(new Option(`UV ${source.channel} (missing)`, String(source.channel)));
      if (!status.textContent) showStatus(`UV set ${source.channel} is missing.`);
    }
    uv.value = String(source.channel);
    color.value = materialTextureColorSpace(source, target.slot);
    color.disabled = target.slot !== "map";
    wrapU.value = String(source.wrapS); wrapV.value = String(source.wrapT);
    filter.value = source.filter ?? "mipmap";
    flip.checked = source.flipY;
    for (const { field, read, refreshLock } of fields) {
      field.value = String(read(source));
      refreshLock();
    }
  }
  refresh();
  return { element, refresh };
}
