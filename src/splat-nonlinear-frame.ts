import { Euler, Matrix3, Matrix4, Quaternion, Vector3, type Box3 } from "three";

type Tuple3 = [number, number, number];

export interface SplatNonlinearFrame {
  position: Tuple3;
  rotation: Tuple3;
  scale: Tuple3;
  lowBound: number;
  highBound: number;
}

type HandleTransform = { position: Vector3; rotation: Quaternion; scale: Vector3 };
type LocalDeformation = (point: Vector3, jacobian: Matrix3, influence: number) => boolean;

const POSITION_LIMIT = 1e12;
const MIN_FRAME_SCALE = 1e-6;
const MAX_FRAME_SCALE = 1e12;
const MAX_ROTATION = 3600;
const AXES = ["X", "Y", "Z"] as const;
export const MIN_NONLINEAR_SPAN = 0.001;
export const TO_RADIANS = Math.PI / 180;

export function createSplatNonlinearFrame(bounds: Box3): SplatNonlinearFrame {
  const halfExtent = Math.max(...bounds.getSize(new Vector3()).toArray()) / 2;
  const scale = Math.min(MAX_FRAME_SCALE, Math.max(MIN_FRAME_SCALE, halfExtent || 1));
  return {
    position: bounds.getCenter(new Vector3()).toArray(),
    rotation: [0, 0, 0],
    scale: [scale, scale, scale],
    lowBound: -1,
    highBound: 1,
  };
}

export function requireDeformerNumber(value: unknown, label: string, min: number, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
}

export function requireSplatNonlinearFrame(value: unknown): asserts value is SplatNonlinearFrame {
  if (!value || typeof value !== "object") throw new Error("Missing deformer frame.");
  const frame = value as Record<string, unknown>;
  for (const [key, label, min, max] of [
    ["position", "Handle translation", -POSITION_LIMIT, POSITION_LIMIT],
    ["rotation", "Handle rotation", -MAX_ROTATION * TO_RADIANS, MAX_ROTATION * TO_RADIANS],
    ["scale", "Handle scale", MIN_FRAME_SCALE, MAX_FRAME_SCALE],
  ] as const) {
    const values = frame[key];
    if (!Array.isArray(values) || values.length !== 3) throw new Error(`${label} needs three components.`);
    for (const component of values) requireDeformerNumber(component, label, min, max);
  }
  requireDeformerNumber(frame.lowBound, "Low Bound", -10, 0);
  requireDeformerNumber(frame.highBound, "High Bound", 0, 10);
}

export function nonlinearNumber<P, K extends keyof P>(
  params: P, key: K, label: string, min: number, max: number, step: number, toggle?: boolean,
) {
  return {
    id: String(key), label, value: Number(params[key]), min, max, step, toggle,
    set(current: P, value: number): P {
      requireDeformerNumber(value, label, min, max);
      if (toggle && value !== 0 && value !== 1) throw new Error(`${label} must be on or off.`);
      return { ...current, [key]: toggle ? value === 1 : value };
    },
  };
}

export function nonlinearControls<P extends SplatNonlinearFrame>(params: P) {
  const transforms = ([
    ["position", "Translate", -POSITION_LIMIT, POSITION_LIMIT, 0.01, 1],
    ["rotation", "Rotate", -MAX_ROTATION, MAX_ROTATION, 1, TO_RADIANS],
    ["scale", "Scale", MIN_FRAME_SCALE, MAX_FRAME_SCALE, 0.01, 1],
  ] as const).flatMap(([key, label, min, max, step, unit]) =>
    AXES.map((axis, index) => ({
      id: `${key}.${axis.toLowerCase()}`,
      label: `${label} ${axis}`,
      value: params[key][index] / unit,
      min, max, step,
      set(current: P, value: number): P {
        requireDeformerNumber(value, `${label} ${axis}`, min, max);
        const tuple: Tuple3 = [...current[key]];
        tuple[index] = value * unit;
        return { ...current, [key]: tuple };
      },
    })),
  );
  return [
    nonlinearNumber(params, "lowBound", "Low Bound", -10, 0, 0.01),
    nonlinearNumber(params, "highBound", "High Bound", 0, 10, 0.01),
    ...transforms,
  ];
}

function frameTransform(params: SplatNonlinearFrame): HandleTransform {
  return {
    position: new Vector3(...params.position),
    rotation: new Quaternion().setFromEuler(new Euler(...params.rotation)),
    scale: new Vector3(...params.scale),
  };
}

export function nonlinearHandles<P extends SplatNonlinearFrame>() {
  return {
    count: () => 3,
    localAxis: (index: number) => index === 0 ? undefined : "y" as const,
    name: (index: number) => ["Frame", "Low Bound", "High Bound"][index],
    modes: (index: number) => index === 0 ? ["translate", "rotate", "scale"] as const : ["translate"] as const,
    get(params: P, index: number): HandleTransform {
      const transform = frameTransform(params);
      if (index === 0) return transform;
      const bound = index === 1 ? params.lowBound : params.highBound;
      transform.position.add(new Vector3(0, bound * transform.scale.y, 0).applyQuaternion(transform.rotation));
      transform.scale.set(1, 1, 1);
      return transform;
    },
    set(params: P, index: number, transform: HandleTransform): P {
      const frame = frameTransform(params);
      if (index === 0) {
        const { x, y, z } = new Euler().setFromQuaternion(transform.rotation);
        const changeRotation = Math.abs(frame.rotation.dot(transform.rotation)) < 1 - 1e-12;
        return {
          ...params,
          position: transform.position.toArray(),
          rotation: changeRotation ? [x, y, z] : params.rotation,
          scale: transform.scale.toArray(),
        };
      }
      const localY = new Vector3().copy(transform.position).sub(frame.position)
        .applyQuaternion(frame.rotation.invert()).y / frame.scale.y;
      const bound = index === 1 ? "lowBound" : "highBound";
      if (Math.abs(params[bound] - localY) <= 1e-12) return params;
      return { ...params, [bound]: index === 1 ? Math.max(-10, Math.min(0, localY)) : Math.min(10, Math.max(0, localY)) };
    },
  };
}

export function prepareNonlinearFrame(params: SplatNonlinearFrame, deform: LocalDeformation) {
  const { position, rotation, scale } = frameTransform(params);
  // Translation and a uniform scale leave the Jacobian basis unchanged.
  // Most default deformer frames take this branch, including translated rigs.
  if (rotation.x === 0 && rotation.y === 0 && rotation.z === 0 && scale.x === scale.y && scale.y === scale.z) {
    const toLocalScale = 1 / scale.x, localPoint = new Vector3();
    return (input: Vector3, output: Vector3, jacobian: Matrix3, influence: number): void => {
      localPoint.copy(input).sub(position).multiplyScalar(toLocalScale);
      if (!influence || params.highBound - params.lowBound < MIN_NONLINEAR_SPAN || !deform(localPoint, jacobian, influence)) {
        output.copy(input); jacobian.identity();
      } else output.copy(localPoint).multiplyScalar(scale.x).add(position);
    };
  }
  const toObject = new Matrix4().compose(position, rotation, scale);
  const toLocal = toObject.clone().invert();
  const linearToObject = new Matrix3().setFromMatrix4(toObject);
  const linearToLocal = new Matrix3().setFromMatrix4(toLocal);
  const localPoint = new Vector3();
  return (input: Vector3, output: Vector3, jacobian: Matrix3, influence: number): void => {
    if (influence === 0 || params.highBound - params.lowBound < MIN_NONLINEAR_SPAN
      || !deform(localPoint.copy(input).applyMatrix4(toLocal), jacobian, influence)) {
      output.copy(input);
      jacobian.identity();
      return;
    }
    output.copy(localPoint).applyMatrix4(toObject);
    jacobian.multiply(linearToLocal).premultiply(linearToObject);
  };
}
