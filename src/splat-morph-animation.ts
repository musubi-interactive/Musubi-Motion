import { evaluateChannels } from "./animation.ts";
import type { SceneDocument, SplatShapeNode } from "./scene-document.ts";
import { splatMorphPose } from "./splat-morph.ts";

export function timelineSplatMorphPose(doc: SceneDocument, shape: SplatShapeNode, frame: number) {
  if (shape.morphSurface) return splatMorphPose(shape, evaluateChannels(doc, shape.parentId, frame).morphWeights);
}
