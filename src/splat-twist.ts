import type { Box3 } from "three";
import {
  createSplatNonlinearFrame, nonlinearControls, nonlinearHandles, nonlinearNumber, prepareNonlinearFrame,
  requireDeformerNumber, requireSplatNonlinearFrame, TO_RADIANS, type SplatNonlinearFrame,
} from "./splat-nonlinear-frame.ts";

interface TwistParams extends SplatNonlinearFrame {
  startAngle: number;
  endAngle: number;
}

const MAX_TWIST = 860;

export const SPLAT_TWIST = {
  kind: "twist",
  name: "Twist",
  create(bounds: Box3): TwistParams {
    return { ...createSplatNonlinearFrame(bounds), startAngle: 0, endAngle: 0 };
  },
  validate(value: unknown): void {
    requireSplatNonlinearFrame(value);
    const { startAngle, endAngle } = value as TwistParams;
    requireDeformerNumber(startAngle, "Start Angle", -MAX_TWIST, MAX_TWIST);
    requireDeformerNumber(endAngle, "End Angle", -MAX_TWIST, MAX_TWIST);
  },
  prepare(params: TwistParams) {
    const { lowBound, highBound } = params;
    const start = params.startAngle * TO_RADIANS;
    const range = (params.endAngle - params.startAngle) * TO_RADIANS;
    const span = highBound - lowBound;
    return prepareNonlinearFrame(params, (point, jacobian, influence) => {
      if (start === 0 && range === 0) return false;
      const { x, y, z } = point;
      const t = (y - lowBound) / span;
      const angle = influence * (start + Math.max(0, Math.min(1, t)) * range);
      const slope = t >= 0 && t <= 1 ? influence * range / span : 0;
      const c = Math.cos(angle), s = Math.sin(angle);
      const resultX = c * x + s * z, resultZ = -s * x + c * z;
      point.set(resultX, y, resultZ);
      jacobian.set(c, slope * resultZ, s, 0, 1, 0, -s, -slope * resultX, c);
      return true;
    });
  },
  controls(params: TwistParams) {
    return [
      nonlinearNumber(params, "startAngle", "Start Angle", -MAX_TWIST, MAX_TWIST, 1),
      nonlinearNumber(params, "endAngle", "End Angle", -MAX_TWIST, MAX_TWIST, 1),
      ...nonlinearControls(params),
    ];
  },
  handle: nonlinearHandles<TwistParams>(),
};
