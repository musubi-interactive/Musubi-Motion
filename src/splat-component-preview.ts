import { Color, BufferGeometry, Float32BufferAttribute, Points, PointsMaterial, type Object3D } from "three";
import { SPLAT_HIGHLIGHT_LIMIT } from "./splat-component-selection.ts";

/** Transient bounded center markers; caller explicitly reports the sampled highlight budget. */
export function createSplatComponentPreview() {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(SPLAT_HIGHLIGHT_LIMIT * 3), 3));
  geometry.setAttribute("color", new Float32BufferAttribute(new Float32Array(SPLAT_HIGHLIGHT_LIMIT * 3), 3));
  geometry.setDrawRange(0, 0);
  const material = new PointsMaterial({ vertexColors: true, transparent: true, size: 6, sizeAttenuation: false, depthTest: false, depthWrite: false, toneMapped: false });
  const low = new Color(0x528eff), high = new Color(0xffbe64);
  const points = new Points(geometry, material); points.name = "Selected original splats";
  points.frustumCulled = false; points.renderOrder = 100006; points.raycast = () => {};
  return {
    points,
    update(parent: Object3D, positions: Float32Array, weights?: Float32Array) {
      if (positions.length % 3 || positions.length > SPLAT_HIGHLIGHT_LIMIT * 3) throw Error("Invalid splat selection preview size.");
      let count = 0;
      const attribute = geometry.getAttribute("position");
      const colors = geometry.getAttribute("color");
      if (weights && weights.length !== positions.length / 3) throw Error("Selection preview needs one weight per marker.");
      for (let offset = 0; offset < positions.length; offset += 3) {
        if (![positions[offset], positions[offset + 1], positions[offset + 2]].every(Number.isFinite)) continue;
        attribute.setXYZ(count, positions[offset], positions[offset + 1], positions[offset + 2]);
        const weight = weights?.[offset / 3] ?? 1;
        colors.setXYZ(count++, low.r + (high.r - low.r) * weight, low.g + (high.g - low.g) * weight, low.b + (high.b - low.b) * weight);
      }
      attribute.needsUpdate = true; colors.needsUpdate = true; geometry.setDrawRange(0, count);
      if (points.parent !== parent) parent.add(points);
      points.visible = count > 0;
    },
    clear() { points.removeFromParent(); geometry.setDrawRange(0, 0); },
    dispose() { points.removeFromParent(); geometry.dispose(); material.dispose(); },
  };
}
