import { BufferGeometry, Float32BufferAttribute, Points, PointsMaterial, type Object3D } from "three";
export const SPLAT_MASK_PREVIEW_LIMIT = 20_000;
export function createSplatMaskPreview() {
  const geometry = new BufferGeometry(); geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(SPLAT_MASK_PREVIEW_LIMIT * 3), 3)); geometry.setAttribute("color", new Float32BufferAttribute(new Float32Array(SPLAT_MASK_PREVIEW_LIMIT * 3), 3)); geometry.setDrawRange(0, 0);
  // Spark draws in Three's transparent queue; the overlay must share that queue
  // for its later renderOrder to place scalar feedback above the source splats.
  const material = new PointsMaterial({ transparent: true, opacity: 1, size: 6, sizeAttenuation: false, vertexColors: true, depthTest: false, depthWrite: false, toneMapped: false });
  const points = new Points(geometry, material); points.name = "Scalar mask overlay (sampled original centers)"; points.frustumCulled = false; points.renderOrder = 100007; points.raycast = () => {};
  return {
    points,
    update(parent: Object3D, positions: Float32Array, values: ArrayLike<number>) {
      if (positions.length !== values.length * 3 || values.length > SPLAT_MASK_PREVIEW_LIMIT) throw Error("Invalid scalar mask overlay size.");
      const p = geometry.getAttribute("position"), colors = geometry.getAttribute("color"); let count = 0;
      for (let i = 0; i < values.length; i++) if ([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]].every(Number.isFinite)) { const shade = .08 + .92 * values[i]; p.setXYZ(count, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]); colors.setXYZ(count++, shade, shade, shade); }
      p.needsUpdate = colors.needsUpdate = true; geometry.setDrawRange(0, count); if (points.parent !== parent) parent.add(points); points.visible = count > 0;
    },
    clear() { points.removeFromParent(); geometry.setDrawRange(0, 0); },
    dispose() { points.removeFromParent(); geometry.dispose(); material.dispose(); },
  };
}
