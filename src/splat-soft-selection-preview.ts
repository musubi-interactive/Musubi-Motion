import { Group, LineBasicMaterial, LineSegments, SphereGeometry, WireframeGeometry, type Object3D } from "three";
import type { SplatSoftSettings } from "./splat-soft-selection.ts";

/** Transient world volume plus CSS-pixel radial feedback. No scene records. */
export function createSplatSoftPreview(viewport: HTMLElement, world: Object3D) {
  const group = new Group(), geometry = new WireframeGeometry(new SphereGeometry(1, 24, 12));
  const material = new LineBasicMaterial({ color: 0xffbe64, transparent: true, opacity: .25, depthTest: false, depthWrite: false });
  const volume = new LineSegments(geometry, material); volume.renderOrder = 100004; group.add(volume); world.add(group); group.visible = false;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6;overflow:hidden";
  const circle = document.createElementNS(svg.namespaceURI, "circle");
  circle.setAttribute("fill", "none"); circle.setAttribute("stroke", "#ffbe64"); circle.setAttribute("stroke-width", "1.5");
  const core = circle.cloneNode() as SVGCircleElement; core.setAttribute("stroke-dasharray", "3 3"); svg.append(circle, core); viewport.append(svg); svg.style.display = "none";
  return {
    showSphere(settings: SplatSoftSettings) {
      group.visible = true; svg.style.display = "none"; group.position.fromArray(settings.center); group.scale.setScalar(settings.worldRadius);
    },
    showRadial(center: { x: number; y: number }, radius: number, inner: number) {
      group.visible = false; svg.style.display = "";
      for (const item of [circle, core]) { item.setAttribute("cx", String(center.x)); item.setAttribute("cy", String(center.y)); }
      circle.setAttribute("r", String(radius)); core.setAttribute("r", String(radius * inner));
    },
    clear() { group.visible = false; svg.style.display = "none"; },
    dispose() { group.removeFromParent(); geometry.dispose(); material.dispose(); svg.remove(); },
  };
}
