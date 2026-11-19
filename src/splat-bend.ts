import type { Box3 } from "three";
import {
  createSplatNonlinearFrame, nonlinearControls, nonlinearHandles, nonlinearNumber, prepareNonlinearFrame,
  requireDeformerNumber, requireSplatNonlinearFrame, TO_RADIANS, type SplatNonlinearFrame,
} from "./splat-nonlinear-frame.ts";

interface BendParams extends SplatNonlinearFrame {
  curvature: number;
}

export const SPLAT_BEND = {
  kind: "bend",
  name: "Bend",
  create(bounds: Box3): BendParams {
    return { ...createSplatNonlinearFrame(bounds), curvature: 0 };
  },
  validate(value: unknown): void {
    requireSplatNonlinearFrame(value);
    requireDeformerNumber((value as BendParams).curvature, "Curvature", -230, 230);
  },
  prepare(params: BendParams) {
    const { lowBound, highBound } = params;
    const curvature = params.curvature * TO_RADIANS;
    return prepareNonlinearFrame(params, (point, jacobian, influence) => {
      const k = curvature * influence;
      if (k === 0) return false;
      const { x, y, z } = point;
      const clampedY = Math.max(lowBound, Math.min(highBound, y));
      const tail = y - clampedY;
      const angle = k * clampedY, c = Math.cos(angle), s = Math.sin(angle);
      const halfSine = Math.sin(angle / 2);
      const arcY = angle === 0 ? clampedY : clampedY * (s / angle);
      // Classical cylindrical bend has axial scale 1-kx. Extend its radius
      // smoothly before the axis collapses, with positive radial derivative.
      const radial = k * x;
      const correction = 1 + 4 * (radial - 0.5);
      const radius = radial <= 0.5 ? 1 - radial : 0.25 + 0.25 / correction;
      const bendX = radial <= 0.5 ? x : (1 - radius) / k;
      const radialDerivative = radial <= 0.5 ? 1 : 1 / (correction * correction);
      const axialDerivative = tail === 0 ? radius : 1;
      point.set(c * bendX + 2 * halfSine * (halfSine / k) + s * tail,
        radius * arcY + c * tail, z);
      jacobian.set(
        c * radialDerivative, s * axialDerivative, 0,
        -s * radialDerivative, c * axialDerivative, 0,
        0, 0, 1,
      );
      return true;
    });
  },
  controls(params: BendParams) {
    return [
      nonlinearNumber(params, "curvature", "Curvature", -230, 230, 1),
      ...nonlinearControls(params),
    ];
  },
  handle: nonlinearHandles<BendParams>(),
};
