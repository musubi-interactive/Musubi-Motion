import type { Box3 } from "three";
import {
  createSplatNonlinearFrame, nonlinearControls, nonlinearHandles, nonlinearNumber, prepareNonlinearFrame,
  requireDeformerNumber, requireSplatNonlinearFrame, type SplatNonlinearFrame,
} from "./splat-nonlinear-frame.ts";

interface SquashParams extends SplatNonlinearFrame {
  factor: number;
  expand: number;
  maxExpandPosition: number;
  preserveVolume: boolean;
}

const MAX_FACTOR = 3;
const MAX_EXPAND = 4;
const MIN_PEAK = 0.01;
const MAX_PEAK = 0.99;

function profileIntegral(u: number, broadening: number) {
  const cubic = u * u * u;
  const basic = cubic * (1 - 0.5 * u);
  const squared = cubic * u * u * (1.8 + u * (-2 + u * (4 / 7)));
  return basic + broadening * (basic - squared);
}

export const SPLAT_SQUASH = {
  kind: "squash",
  name: "Squash and Stretch",
  create(bounds: Box3): SquashParams {
    return {
      ...createSplatNonlinearFrame(bounds), factor: 0, expand: 1, maxExpandPosition: 0.5, preserveVolume: false,
    };
  },
  validate(value: unknown): void {
    requireSplatNonlinearFrame(value);
    const { factor, expand, maxExpandPosition, preserveVolume } = value as SquashParams;
    requireDeformerNumber(factor, "Factor", -MAX_FACTOR, MAX_FACTOR);
    requireDeformerNumber(expand, "Expand", 0, MAX_EXPAND);
    requireDeformerNumber(maxExpandPosition, "Max Expand Position", MIN_PEAK, MAX_PEAK);
    if (typeof preserveVolume !== "boolean") throw new Error("Preserve Volume must be on or off.");
  },
  prepare(params: SquashParams) {
    const { factor, expand, maxExpandPosition: peak, highBound, lowBound, preserveVolume } = params;
    const span = highBound - lowBound;
    const broadening = preserveVolume ? expand / (1 + expand) : 0;
    const totalArea = profileIntegral(1, broadening);
    // The profile is a pair of smoothsteps peaking at the authored position.
    // Its enclosed area drives the axial displacement and gives rigid tails.
    function area(t: number, u: number) {
      return t <= peak ? peak * profileIntegral(u, broadening)
        : totalArea - (1 - peak) * profileIntegral(u, broadening);
    }
    function distanceToBound(t: number) {
      return t <= peak ? t / peak : (1 - t) / (1 - peak);
    }
    const pivotT = span > 0 ? (-lowBound) / span : 0;
    const pivotArea = area(pivotT, distanceToBound(pivotT));
    return prepareNonlinearFrame(params, (point, jacobian, influence) => {
      const logScale = factor * influence * Math.LN2;
      if (logScale === 0) return false;
      const { x, y, z } = point;
      const t = Math.max(0, Math.min(1, (y - lowBound) / span));
      const u = distanceToBound(t);
      const bulge = u * u * (3 - 2 * u);
      const segment = t <= peak ? peak : peak - 1;
      const bulgeSlope = 6 * u * (1 - u) / (span * segment);
      const change = Math.expm1(logScale);
      const profile = bulge + broadening * bulge * (1 - bulge);
      const axial = 1 + change * profile;
      const axialSlope = change * bulgeSlope * (1 + broadening * (1 - 2 * bulge));
      const radial = preserveVolume ? 1 / Math.sqrt(axial) : Math.exp(-0.5 * logScale * expand * bulge);
      const radialSlope = -0.5 * radial * (preserveVolume ? axialSlope / axial : logScale * expand * bulgeSlope);
      point.set(radial * x, y + span * change * (area(t, u) - pivotArea), radial * z);
      jacobian.set(radial, radialSlope * x, 0, 0, axial, 0, 0, radialSlope * z, radial);
      return true;
    });
  },
  controls(params: SquashParams) {
    return [
      nonlinearNumber(params, "factor", "Factor", -MAX_FACTOR, MAX_FACTOR, 0.1),
      nonlinearNumber(params, "expand", "Expand", 0, MAX_EXPAND, 0.1),
      nonlinearNumber(params, "maxExpandPosition", "Max Expand Position", MIN_PEAK, MAX_PEAK, 0.01),
      nonlinearNumber(params, "preserveVolume", "Preserve Volume", 0, 1, 1, true),
      ...nonlinearControls(params),
    ];
  },
  handle: nonlinearHandles<SquashParams>(),
};
