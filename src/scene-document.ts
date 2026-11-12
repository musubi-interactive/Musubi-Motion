export type Vec3 = [number, number, number];
export type { ParticleShapeNode } from "./particle-emitter.ts";
export type TransformChannels = {
  position: Vec3;
  rotation: Vec3; // Euler degrees; XYZ order, local to parent.
  scale: Vec3;
};
export type TransformNode = TransformChannels & {
  hidden?: boolean; // Outliner visibility override, independent of animation keys.
  affine?: number[]; // Optional column-major 3×3 linear compensation for world-axis transforms.
  pivot?: Vec3;
  pivotCompensation?: Vec3;
  id: string;
  type: "transform";
  name: string;
  parentId: string | null;
  rotationOrder: "XYZ";
};
export type SkinInfluence = { jointId: string; weight: number };
export type SkinWeights = { count: number; overrides: Record<string, SkinInfluence[]> };
export type SkinBinding = { meshSpace?: boolean; jointIds: string[]; restMatrices: number[][]; weights?: SkinWeights };
export type SplatShapeNode = {
  attributePaint?: import("./splat-attribute-paint.ts").SplatAttributePaint;
  appearance?: import("./splat-appearance.ts").SplatAppearanceStack;
  selectionSets?: import("./splat-masks.ts").SplatSelectionSet[];
  scalarMasks?: import("./splat-masks.ts").SplatScalarMask[];
  componentTransforms?: import("./splat-component-transforms.ts").SplatComponentTransforms;
  componentEdits?: import("./splat-component-edits.ts").SplatComponentEdits;
  elasticity?: import("./elasticity").Elasticity;
  binding?: SkinBinding;
  id: string;
  type: "splatShape";
  name: string;
  parentId: string;
  assetId: string;
  offset: Vec3;
};
export type CurveControlPoint = [number, number, number, number]; // local XYZ, positive rational weight
export type CurveShapeNode = {
  id: string;
  type: "curveShape";
  name: string;
  parentId: string;
  degree: 1 | 2 | 3;
  points: CurveControlPoint[];
  knots: number[];
  closed: boolean; // join the rendered endpoints; does not make the NURBS periodic
  color: string;
};
export type MeshVertex = { id: string; position: Vec3 };
export type MeshFace = { id: string; vertices: string[]; materialIndex?: number };
export type MeshShapeNode = {
  normals?: Record<string, Vec3>;
  materials?: import("./mesh-materials.ts").MeshMaterialData[];
  uvs?: Record<string, [number, number]>;
  uvSets?: Record<string, Record<string, [number, number]>>;
  morphTargets?: { name: string; weight: number; deltas: Record<string, Vec3> }[];
  skin?: import("./mesh-skin.ts").MeshSkin;
  id: string;
  type: "meshShape";
  name: string;
  parentId: string;
  vertices: MeshVertex[];
  faces: MeshFace[];
  color: string;
  shading: "flat" | "smooth";
  wireframe: boolean;
};
export type AssetRecord = { id: string } & (
  | { kind: "procedural"; generator: "knot-v1" }
  | { kind: "file"; fileName: string; byteLength: number }
);
export type SceneDocument = {
  customAttributes?: Record<string, import("./custom-attributes.ts").CustomAttribute[]>;
  textureAssets?: Record<string, import("./texture-assets.ts").TextureAsset>;
  proceduralGraph?: import("./procedural-graph.ts").ProceduralGraph;
  animation?: import("./animation.ts").AnimationData;
  drivenKeys?: import("./driven-keys.ts").DrivenKeyRelationship[];
  ikHandles?: import("./ik.ts").IKHandle[];
  constraints?: import("./constraints.ts").Constraint[];
  joints?: import("./skeleton.ts").Joint[];
  format: "musubi-scene";
  version: 2;
  upAxis: "Y";
  units: "unitless";
  rootIds: string[];
  nodes: Record<string, TransformNode | SplatShapeNode | CurveShapeNode | MeshShapeNode | import("./particle-emitter.ts").ParticleShapeNode>;
  assets: Record<string, AssetRecord>;
};

export function emptyScene(): SceneDocument {
  return {
    format: "musubi-scene",
    version: 2,
    upAxis: "Y",
    units: "unitless",
    rootIds: [],
    nodes: {},
    assets: {},
  };
}

export function transformNodes(doc: SceneDocument): TransformNode[] {
  return Object.values(doc.nodes).filter(
    (node): node is TransformNode => node.type === "transform",
  );
}

export function uniqueName(
  doc: SceneDocument,
  requested: string,
  parentId: string | null = null,
  exceptId?: string,
): string {
  const base = requested.trim().replace(/[|:]/g, "_").slice(0, 80) || "splat";
  const names = new Set(
    Object.values(doc.nodes)
      .filter((n) => n.parentId === parentId && n.id !== exceptId)
      .map((n) => n.name),
  );
  let name = base,
    suffix = 1;
  while (names.has(name)) name = `${base}${suffix++}`;
  return name;
}

export function normalizedChannels(
  channels: TransformChannels,
): TransformChannels {
  for (const values of [channels.position, channels.rotation, channels.scale]) {
    if (values.length !== 3 || !values.every(Number.isFinite))
      throw new Error("Transform values must be finite numbers.");
  }
  return {
    position: [...channels.position],
    rotation: [...channels.rotation],
    scale: channels.scale.map((value) => Math.max(0.001, value)) as Vec3,
  };
}

export function addSplat(
  doc: SceneDocument,
  asset: AssetRecord,
  requestedName: string,
  offset: Vec3,
  id = crypto.randomUUID(),
  shapeId = crypto.randomUUID(),
): { document: SceneDocument; id: string } {
  const name = uniqueName(doc, requestedName);
  const node: TransformNode = {
    id,
    type: "transform",
    name,
    parentId: null,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    rotationOrder: "XYZ",
  };
  const shape: SplatShapeNode = {
    id: shapeId,
    type: "splatShape",
    name: `${name}Shape`,
    parentId: id,
    assetId: asset.id,
    offset: [...offset],
  };
  return {
    id,
    document: {
      ...doc,
      rootIds: [...doc.rootIds, id],
      nodes: { ...doc.nodes, [id]: node, [shapeId]: shape },
      assets: { ...doc.assets, [asset.id]: asset },
    },
  };
}

// Scene metadata is renderer-independent. Asset bytes are intentionally external.
export function deleteSceneItems(doc: SceneDocument, ids: Iterable<string>,
  ikPoints?: ReadonlyMap<string, { target: Vec3; poleTarget?: Vec3 }>): SceneDocument {
  const removed = new Set(ids);
  const all = [...Object.values(doc.nodes), ...(doc.joints ?? [])];
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of all) if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) {
      removed.add(node.id); changed = true;
    }
  }
  const nodes = Object.fromEntries(Object.entries(doc.nodes).filter(([id]) => !removed.has(id)));
  for (const node of Object.values(nodes)) if (node.type === "meshShape" && node.skin?.jointIds.some(id => removed.has(id))) {
    const { skin: _skin, ...unbound } = node;
    nodes[node.id] = unbound;
  }
  for (const handle of doc.ikHandles ?? []) if (removed.has(handle.rootId) || removed.has(handle.endId)) removed.add(handle.id);
  const retainedAssets = new Set(Object.values(nodes).filter(n => n.type === "splatShape").map(n => n.assetId));
  const freezePoint = (point: Vec3 | undefined, fallback: Vec3): Vec3 =>
    point?.length === 3 && [0, 1, 2].every(i => Number.isFinite(point[i]) && Math.abs(point[i]) <= 1e6)
      ? [...point] : [...fallback];
  return { ...doc, nodes, ...(doc.customAttributes ? { customAttributes: Object.fromEntries(Object.entries(doc.customAttributes).filter(([id]) => !removed.has(id))) } : {}), rootIds: doc.rootIds.filter(id => !removed.has(id)),
    ...(doc.animation ? { animation: { ...doc.animation, tracks: doc.animation.tracks.filter(t => !removed.has(t.targetId)) } } : {}),
    ...(doc.drivenKeys ? { drivenKeys: doc.drivenKeys.filter(r => !removed.has(r.driver.targetId) && !removed.has(r.driven.targetId)) } : {}),
    ...(doc.ikHandles ? { ikHandles: doc.ikHandles.filter(h => !removed.has(h.rootId) && !removed.has(h.endId)).map(handle => {
      const unlinkTarget = handle.targetControl && removed.has(handle.targetControl.objectId);
      const unlinkPole = handle.poleControl && removed.has(handle.poleControl.objectId);
      if (!unlinkTarget && !unlinkPole) return handle;
      const next = { ...handle }, points = ikPoints?.get(handle.id);
      if (unlinkTarget) { next.target = freezePoint(points?.target, handle.target); delete next.targetControl; }
      if (unlinkPole) { next.poleTarget = freezePoint(points?.poleTarget, handle.poleTarget ?? [0, 0, 0]); delete next.poleControl; }
      return next;
    }) } : {}),
    ...(doc.constraints ? { constraints: doc.constraints.filter(c => !removed.has(c.sourceId) && !removed.has(c.targetId)) } : {}),
    assets: Object.fromEntries(Object.entries(doc.assets).filter(([id]) => retainedAssets.has(id))),
    ...(doc.joints ? { joints: doc.joints.filter(j => !removed.has(j.id)) } : {}),
  };
}

export function serializeScene(doc: SceneDocument): string {
  return JSON.stringify(doc, null, 2);
}
