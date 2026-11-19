import { Quaternion, Vector3 } from "three";
import type { SplatDeformerControl } from "./splat-deformers.ts";

export type ControlPoint = [number, number, number];
type PointOffsets = { offsets: ControlPoint[] };
const MAX_COMPONENT = 1e8;

export function validPoint(value: unknown): value is ControlPoint {
  return Array.isArray(value) && value.length === 3 && [0, 1, 2].every(i => typeof value[i] === "number" && Math.abs(value[i]) <= MAX_COMPONENT);
}

export function validControlPoints(value: unknown, count: number): value is ControlPoint[] {
  return Array.isArray(value) && value.length === count && Array.from(value).every(validPoint);
}

export function controlPointPosition<P extends PointOffsets>(params: P, rest: (params: P, index: number) => ControlPoint, index: number, target = new Vector3()) {
  const [x, y, z] = rest(params, index), offset = params.offsets[index];
  return target.set(x + offset[0], y + offset[1], z + offset[2]);
}

export function controlPointChannels<P extends PointOffsets>(params: P, rest: (params: P, index: number) => ControlPoint, label: string, point?: number): SplatDeformerControl<P>[] {
  const controls: SplatDeformerControl<P>[] = [];
  const first = point ?? 0, end = point === undefined ? params.offsets.length : point + 1;
  for (let index = first; index < end && index < params.offsets.length; index++) {
    const bind = rest(params, index);
    for (const [axis, name] of ["X", "Y", "Z"].entries()) {
      controls.push({
        id: `point.${index}.${name.toLowerCase()}`,
        label: `${label} ${index + 1} ${name}`,
        value: bind[axis] + params.offsets[index][axis],
        min: bind[axis] - MAX_COMPONENT,
        max: bind[axis] + MAX_COMPONENT,
        step: 0.01,
        set(valueParams, value) {
          const origin = rest(valueParams, index);
          const offsets = valueParams.offsets.slice();
          const offset: ControlPoint = [...offsets[index]];
          offset[axis] = value - origin[axis];
          offsets[index] = offset;
          return { ...valueParams, offsets };
        },
      });
    }
  }
  return controls;
}

export function controlPointAdapter<P extends PointOffsets>(rest: (params: P, index: number) => ControlPoint, label: string) {
  return {
    count: (params: P) => params.offsets.length,
    name: (index: number) => `${label} ${index + 1}`,
    modes: ["translate"] as const,
    get: (params: P, index: number) => ({ position: controlPointPosition(params, rest, index), rotation: new Quaternion(), scale: new Vector3(1, 1, 1) }),
    set(params: P, index: number, transform: { position: Vector3 }) {
      const [x, y, z] = rest(params, index);
      const offsets = params.offsets.slice();
      offsets[index] = [transform.position.x - x, transform.position.y - y, transform.position.z - z];
      return { ...params, offsets };
    },
  };
}
