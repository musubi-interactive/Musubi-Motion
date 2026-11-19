import { Matrix4, Vector4, WebGPUCoordinateSystem, type Camera } from "three";

export type ComponentPickPoint = { x: number; y: number };
export type SceneDepthTest = (u: number, v: number, cameraDepth: number) => boolean;
export type SceneDepthReader = (cancelled: () => boolean) => Promise<SceneDepthTest>;
export type ComponentProjectionOptions = {
  readDepth?: SceneDepthReader;
  readPositions: (start: number, count: number) => Float32Array;
  componentCount: number;
  matrixWorld: Matrix4;
  camera: Camera;
  width: number;
  height: number;
  cancelled?: () => boolean;
  yieldTask?: () => Promise<void>;
};
export type ComponentPickOptions = ComponentProjectionOptions & {
  start: ComponentPickPoint;
  end: ComponentPickPoint;
  limit?: number;
};

const CHUNK_SIZE = 4096;
const MAX_SELECTED = 20_000;
const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Shared clipped projection scan. Visits stable original indices in bounded chunks. */
export async function scanProjectedComponents(
  options: ComponentProjectionOptions,
  visit: (index: number, x: number, y: number, depth: number) => void,
): Promise<void> {
  const { componentCount, width, height, readPositions } = options;
  if (!Number.isSafeInteger(componentCount) || componentCount < 0) throw Error("Component count must be a nonnegative safe integer.");
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw Error("Component picking needs a finite, positive viewport width and height.");
  if (typeof readPositions !== "function" || !options.camera?.isCamera || !options.matrixWorld?.isMatrix4) throw Error("Component picking needs a camera, world matrix and position reader.");
  const checkCancelled = () => {
    if (options.cancelled?.()) throw new DOMException("Component selection cancelled; no selection was applied.", "AbortError");
  };
  checkCancelled();
  options.camera.updateWorldMatrix(true, false);
  for (const matrix of [options.matrixWorld, options.camera.projectionMatrix, options.camera.matrixWorldInverse]) {
    if (!matrix.elements.every(Number.isFinite)) throw Error("Component picking matrices must contain finite values.");
  }
  // Snapshot once. Later camera/object changes cannot mix different projections in a scan.
  const view = new Matrix4().multiplyMatrices(options.camera.matrixWorldInverse, options.matrixWorld);
  const projection = options.camera.projectionMatrix.clone(), minimumDepth = options.camera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1;
  const visible = options.readDepth ? await options.readDepth(options.cancelled ?? (() => false)) : undefined;
  checkCancelled();
  const clip = new Vector4();
  const yieldTask = options.yieldTask ?? yieldToUI;
  for (let offset = 0; offset < componentCount; offset += CHUNK_SIZE) {
    checkCancelled();
    const count = Math.min(CHUNK_SIZE, componentCount - offset), positions = readPositions(offset, count);
    if (!(positions instanceof Float32Array) || positions.length !== count * 3) throw Error("Component position reader must return exactly three Float32 values per requested component.");
    checkCancelled();
    for (let local = 0; local < count; local++) {
      const x = positions[local * 3], y = positions[local * 3 + 1], z = positions[local * 3 + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      clip.set(x, y, z, 1).applyMatrix4(view);
      if (clip.z > 0) continue; // Also excludes points behind orthographic cameras with negative near planes.
      const cameraDepth = -clip.z;
      clip.applyMatrix4(projection);
      if (!Number.isFinite(clip.x) || !Number.isFinite(clip.y) || !Number.isFinite(clip.z) || !Number.isFinite(clip.w) || clip.w <= 0) continue;
      const ndcX = clip.x / clip.w, ndcY = clip.y / clip.w, depth = clip.z / clip.w;
      if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || depth < minimumDepth || depth > 1) continue;
      const screenX = (ndcX + 1) * width / 2, screenY = (1 - ndcY) * height / 2, index = offset + local;
      if (visible && !visible(screenX/width, screenY/height, cameraDepth)) continue;
      visit(index, screenX, screenY, depth);
    }
    if (offset + count < componentCount) {
      checkCancelled(); await yieldTask(); checkCancelled();
    }
  }
  checkCancelled();
}

/** Selects projected original component centers, through geometry without occlusion tests. */
export async function pickProjectedComponents(options: ComponentPickOptions): Promise<number[]> {
  const limit = options.limit ?? MAX_SELECTED;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SELECTED) throw Error("Component selection limit must be between 1 and 20,000.");
  const { x: startX, y: startY } = options.start, { x: endX, y: endY } = options.end;
  if (![startX, startY, endX, endY].every(Number.isFinite)) throw Error("Component selection coordinates must be finite canvas pixels.");
  const click = Math.hypot(endX - startX, endY - startY) < 4;
  const left = Math.min(startX, endX), right = Math.max(startX, endX), top = Math.min(startY, endY), bottom = Math.max(startY, endY);
  const result: number[] = [];
  let nearestIndex = -1, nearestDistance = Infinity, nearestDepth = Infinity;
  await scanProjectedComponents(options, (index, screenX, screenY, depth) => {
    if (click) {
      const distance = (screenX - endX) ** 2 + (screenY - endY) ** 2;
      if (distance <= 8 ** 2 && (distance < nearestDistance || (distance === nearestDistance && (depth < nearestDepth || (depth === nearestDepth && index < nearestIndex))))) {
        nearestIndex = index; nearestDistance = distance; nearestDepth = depth;
      }
    } else if (screenX >= left && screenX <= right && screenY >= top && screenY <= bottom) {
      if (result.length >= limit) throw Error(`Component selection exceeds the ${limit.toLocaleString("en-US")} component limit. Select a smaller region.`);
      result.push(index);
    }
  });
  return click ? nearestIndex < 0 ? [] : [nearestIndex] : result;
}
