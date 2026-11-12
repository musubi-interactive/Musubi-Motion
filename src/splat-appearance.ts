import type { SceneDocument, SplatShapeNode } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import type { SplatSelectionIdentity } from "./splat-component-selection.ts";
import { maskValue, type SplatScalarMask } from "./splat-masks.ts";
import type { GraphProgram, PixelSource } from "./procedural-graph-runtime.ts";

export const APPEARANCE_LIMITS = { layers: 4, sourceCount: 250_000, sceneCount: 500_000, coordinate: 10_000, scale: 8 } as const;
export const APPEARANCE_PLANES = ["XY", "XZ", "YZ"] as const;
export type SplatAppearanceLayer = {
  id: string;
  enabled: boolean;
  space: "object" | "world";
  plane: typeof APPEARANCE_PLANES[number];
  scaleU: number;
  scaleV: number;
  offsetU: number;
  offsetV: number;
  maskId: string | null;
  blend: number;
  color: boolean;
  opacity: boolean;
  scale: boolean;
  scaleMin: number;
  scaleMax: number;
};
export type SplatAppearanceStack = {
  version: 1;
  sourceCount: number;
  layers: readonly SplatAppearanceLayer[];
};

export function newSplatAppearanceLayer(): SplatAppearanceLayer {
  return {
    id: crypto.randomUUID(), enabled: true, space: "object", plane: "XY",
    scaleU: 1, scaleV: 1, offsetU: .5, offsetV: .5, maskId: null, blend: 1,
    color: true, opacity: false, scale: false, scaleMin: .25, scaleMax: 2,
  };
}

const layerKeys = ["id", "enabled", "space", "plane", "scaleU", "scaleV", "offsetU", "offsetV", "maskId",
  "blend", "color", "opacity", "scale", "scaleMin", "scaleMax"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function validateSplatAppearance(shape: SplatShapeNode, decodedCount?: number): number {
  const stack = shape.appearance;
  if (stack === undefined) return 0;
  if (!object(stack) || stack.version !== 1 || Object.keys(stack).length !== 3)
    throw Error("Invalid splat appearance stack. This build supports appearance version 1.");
  if (!Number.isSafeInteger(stack.sourceCount) || !finite(stack.sourceCount, 1, APPEARANCE_LIMITS.sourceCount))
    throw Error("Splat appearance supports up to 250,000 original splats per object.");
  const expected = [decodedCount, shape.componentEdits?.sourceCount, shape.componentTransforms?.sourceCount,
    shape.binding?.weights?.count, shape.scalarMasks?.[0]?.sourceCount, shape.selectionSets?.[0]?.sourceCount];
  if (expected.some(count => count !== undefined && count !== stack.sourceCount))
    throw Error("Splat appearance does not match the decoded original source count.");
  if (!Array.isArray(stack.layers) || !stack.layers.length || stack.layers.length > APPEARANCE_LIMITS.layers)
    throw Error("A splat appearance stack requires between 1 and 4 layers.");
  const ids = new Set<string>();
  for (const layer of stack.layers) {
    if (!object(layer) || Object.keys(layer).length !== layerKeys.length || layerKeys.some(key => !Object.hasOwn(layer, key)) ||
      typeof layer.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(layer.id) || ids.has(layer.id) ||
      typeof layer.enabled !== "boolean" || (layer.space !== "object" && layer.space !== "world") ||
      !APPEARANCE_PLANES.some(plane => plane === layer.plane) ||
      ![layer.scaleU, layer.scaleV, layer.offsetU, layer.offsetV].every(value => finite(value, -APPEARANCE_LIMITS.coordinate, APPEARANCE_LIMITS.coordinate)) ||
      !layer.scaleU || !layer.scaleV || !finite(layer.blend, 0, 1) ||
      ![layer.color, layer.opacity, layer.scale].every(value => typeof value === "boolean") ||
      !finite(layer.scaleMin, .01, APPEARANCE_LIMITS.scale) || !finite(layer.scaleMax, .01, APPEARANCE_LIMITS.scale) ||
      layer.scaleMin > layer.scaleMax ||
      layer.maskId !== null && (typeof layer.maskId !== "string" || !shape.scalarMasks?.some(mask => mask.id === layer.maskId)))
      throw Error("Invalid splat appearance layer, projection, scale range or scalar mask.");
    ids.add(layer.id);
  }
  return stack.sourceCount;
}

export function validateSceneSplatAppearance(doc: SceneDocument) {
  let total = 0;
  for (const node of Object.values(doc.nodes)) if (node.type === "splatShape") total += validateSplatAppearance(node);
  if (!total) return;
  if (total > APPEARANCE_LIMITS.sceneCount) throw Error("Scene splat appearance exceeds 500,000 original splats.");
  if (!doc.proceduralGraph) throw Error("Splat appearance needs a Texture Graph Output. Remove its layers before removing the graph.");
}

export function replaceSplatAppearance(
  doc: SceneDocument, identity: SplatSelectionIdentity, layers: readonly SplatAppearanceLayer[],
): SceneDocument {
  const shape = doc.nodes[identity.shapeId];
  if (shape?.type !== "splatShape" || shape.assetId !== identity.assetId || !Object.hasOwn(doc.assets, identity.assetId))
    throw Error("The selected splat shape or source changed.");
  validateSplatAppearance(shape, identity.count);
  if (JSON.stringify(shape.appearance?.layers ?? []) === JSON.stringify(layers)) return doc;
  const next = { ...shape };
  if (!layers.length) delete next.appearance;
  else next.appearance = { version: 1, sourceCount: identity.count, layers };
  validateSplatAppearance(next, identity.count);
  const result = { ...doc, nodes: { ...doc.nodes, [shape.id]: next } };
  validateSceneSplatAppearance(result);
  return result;
}

export function commitSplatAppearance(store: SceneStore, identity: SplatSelectionIdentity, layers: readonly SplatAppearanceLayer[], label: string) {
  const before = store.getState().document, document = replaceSplatAppearance(before, identity, layers);
  if (document !== before) store.setState({ document, editLabel: label });
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;
const projectAxes = { XY: ["x", "y", "z"], XZ: ["x", "z", "y"], YZ: ["y", "z", "x"] } as const;
type Point = { x: number; y: number; z: number };
export const SPLAT_APPEARANCE_STRIDE = 8;

/** RGB offset, retained source RGB (including SH), opacity factor and isotropic scale. */
export function createSplatAppearanceEvaluator(
  layers: readonly SplatAppearanceLayer[], masks: readonly SplatScalarMask[], graph: GraphProgram,
  images: ReadonlyMap<string, PixelSource>, frame: number, fps: number,
) {
  const active = layers.filter(layer => layer.enabled && layer.blend > 0 && (layer.color || layer.opacity || layer.scale))
    .map(layer => ({ layer, mask: masks.find(mask => mask.id === layer.maskId), axes: projectAxes[layer.plane] }));
  const point: Parameters<GraphProgram["sample"]>[0] = { uv: [0, 0], position: [0, 0, 0], frame, fps };
  const projected = point.position!;
  return (index: number, local: Point, world: Point, output: Float32Array) => {
    let red = 0, green = 0, blue = 0, source = 1, opacity = 1, scale = 1;
    for (const { layer, mask, axes } of active) {
      const amount = layer.blend * (mask ? maskValue(mask, index) : 1);
      if (!amount) continue;
      const center = layer.space === "object" ? local : world;
      point.uv[0] = projected[0] = center[axes[0]] * layer.scaleU + layer.offsetU;
      point.uv[1] = projected[1] = center[axes[1]] * layer.scaleV + layer.offsetV;
      projected[2] = center[axes[2]];
      const rgba = graph.sample(point, images);
      if (!rgba.every(Number.isFinite))
        throw Error("Texture Graph returned a nonfinite appearance sample. Reduce the projection scale or move the source closer to the origin.");
      if (layer.color) {
        red = lerp(red, clamp(rgba[0]), amount); green = lerp(green, clamp(rgba[1]), amount); blue = lerp(blue, clamp(rgba[2]), amount);
        source *= 1 - amount;
      }
      if (layer.opacity) opacity = lerp(opacity, rgba[3], amount);
      if (layer.scale) scale = lerp(scale, lerp(layer.scaleMin, layer.scaleMax, rgba[3]), amount);
    }
    const offset = index * SPLAT_APPEARANCE_STRIDE;
    output[offset] = red; output[offset + 1] = green; output[offset + 2] = blue;
    output[offset + 3] = source; output[offset + 4] = opacity; output[offset + 5] = scale;
  };
}
