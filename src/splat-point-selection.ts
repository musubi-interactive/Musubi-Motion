import { Quaternion, Vector3 } from "three";
import type { SplatDeformerHandleTransform } from "./splat-deformers.ts";
import type { ControlPoint } from "./splat-control-points.ts";

export function latticePointGroup(divisions: ControlPoint, point: number, axis: number, plane: boolean) {
  const [x, y, z] = divisions;
  const coords = (i: number) => [i % x, Math.floor(i / x) % y, Math.floor(i / (x * y))];
  const anchor = coords(point);
  return Array.from({ length: x * y * z }, (_, i) => i).filter(i =>
    coords(i).every((value, a) => (plane ? a !== axis : a === axis) || value === anchor[a]));
}
type PointHandle<P> = {
  get(params: P, index: number): SplatDeformerHandleTransform;
  set(params: P, index: number, transform: SplatDeformerHandleTransform): P;
};
export function selectedPointPose<P>(adapter: PointHandle<P>, params: P, indices: readonly number[]) {
  if (indices.length === 1) return adapter.get(params, indices[0]);
  const position = new Vector3();
  for (const index of indices) position.add(adapter.get(params, index).position);
  return { position: position.divideScalar(indices.length), rotation: new Quaternion(), scale: new Vector3(1, 1, 1) };
}
export function transformSelectedPoints<P>(adapter: PointHandle<P>, params: P, indices: readonly number[], next: SplatDeformerHandleTransform): P {
  if (indices.length === 1) return adapter.set(params, indices[0], next);
  const pivot = selectedPointPose(adapter, params, indices).position;
  let result = params;
  for (const index of indices) {
    const pose = adapter.get(params, index);
    pose.position.sub(pivot).multiply(next.scale).applyQuaternion(next.rotation).add(next.position);
    result = adapter.set(result, index, pose);
  }
  return result;
}
