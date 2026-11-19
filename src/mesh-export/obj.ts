import { Matrix3, Vector3 } from "three";
import { evaluateSceneAnimation } from "../animation.ts";
import { constraintWorldMatrices } from "../constraints.ts";
import { evaluateDrivenKeys } from "../driven-keys.ts";
import { evaluateRigStages } from "../ik.ts";
import { triangulateMesh } from "../mesh-modeling.ts";
import type { MeshShapeNode, SceneDocument } from "../scene-document.ts";

export type MeshExportRow = {
  id: string;
  label: string;
  objName: string;
  faceCount: number;
  unavailable?: string;
};

export type MeshExportOptions = {
  space: "world" | "local";
  topology: "polygons" | "triangles";
  frame: number;
};

function unavailableReason(shape: MeshShapeNode): string | undefined {
  if (!shape.faces.length) return "Empty mesh. Add polygon faces in the editor.";
  if (shape.skin && shape.morphTargets?.length) return "Skinned mesh with blend shapes. Use a static copy with both deformations baked to geometry.";
  if (shape.skin) return "Skinned mesh. Use a static copy with skin deformation baked to geometry.";
  if (shape.morphTargets?.length) return "Blend-shape mesh. Use a static copy with the blend shape baked to geometry.";
}

export function listMeshExportRows(scene: SceneDocument): MeshExportRow[] {
  const meshes = Object.values(scene.nodes).filter(node => node.type === "meshShape");
  const shapesPerParent = new Map<string, number>();
  for (const shape of meshes) shapesPerParent.set(shape.parentId, (shapesPerParent.get(shape.parentId) ?? 0) + 1);
  return meshes.map((shape, index) => {
    const name = scene.nodes[shape.parentId].name;
    const label = shapesPerParent.get(shape.parentId) === 1 ? name : name + " / " + shape.name;
    const safeName = label.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "Mesh";
    return {
      id: shape.id, label, objName: (index + 1) + "_" + safeName, faceCount: shape.faces.length,
      unavailable: unavailableReason(shape),
    };
  });
}

function polygonFaces(shape: MeshShapeNode, topology: MeshExportOptions["topology"]): number[][] {
  if (topology === "triangles") {
    const { indices } = triangulateMesh(shape);
    const triangles: number[][] = [];
    for (let offset = 0; offset < indices.length; offset += 3) triangles.push(indices.slice(offset, offset + 3));
    return triangles;
  }
  const byId = new Map(shape.vertices.map(({ id }, index) => [id, index]));
  return shape.faces.map(face => face.vertices.map(id => byId.get(id)!));
}

function vectorText(vector: Vector3, name: string): string {
  if (!Number.isFinite(vector.x) || !Number.isFinite(vector.y) || !Number.isFinite(vector.z)) {
    throw Error(name + " has coordinates outside the supported numeric range. Try Source mesh-local coordinates.");
  }
  return vector.x + " " + vector.y + " " + vector.z;
}

/** Serialize polygon geometry from a validated scene. Indices are global, with a
 * separate namespace for positions, primary UVs and explicitly stored normals. */
export function exportMeshObj(scene: SceneDocument, ids: ReadonlySet<string>, options: MeshExportOptions): Blob {
  const rows = listMeshExportRows(scene).filter(row => ids.has(row.id));
  if (!rows.length) throw Error("Select at least one polygon mesh.");
  const unsupported = rows.find(row => row.unavailable);
  if (unsupported) throw Error(unsupported.label + ": " + unsupported.unavailable);

  let worlds: ReturnType<typeof constraintWorldMatrices> | undefined;
  if (options.space === "world") {
    if (!Number.isFinite(options.frame)) throw Error("Enter a finite frame.");
    const poses = evaluateSceneAnimation(scene, options.frame);
    evaluateDrivenKeys(scene, poses);
    evaluateRigStages(scene, poses, false, options.frame);
    worlds = constraintWorldMatrices(scene, poses);
  }

  const parts = ["# Musubi Motion Mesh Export\n"];
  const point = new Vector3();
  let firstVertex = 1, firstUv = 1, firstNormal = 1;
  for (const row of rows) {
    const shape = scene.nodes[row.id] as MeshShapeNode;
    const world = worlds?.get(shape.parentId);
    const linear = world && new Matrix3().setFromMatrix4(world);
    const determinant = linear ? linear.determinant() : 1;
    if (!Number.isFinite(determinant) || determinant === 0) {
      throw Error(row.label + " has a singular or out-of-range world transform. Try Source mesh-local coordinates.");
    }
    const normalMatrix = shape.normals && linear?.invert().transpose();
    const lines = ["o " + row.objName];

    for (const vertex of shape.vertices) {
      point.fromArray(vertex.position);
      if (world) point.applyMatrix4(world);
      lines.push("v " + vectorText(point, row.label));
    }
    if (shape.uvs) for (const vertex of shape.vertices) {
      const [u, v] = shape.uvs[vertex.id];
      lines.push("vt " + u + " " + v);
    }
    if (shape.normals) for (const vertex of shape.vertices) {
      point.fromArray(shape.normals[vertex.id]);
      if (normalMatrix) point.applyNormalMatrix(normalMatrix);
      lines.push("vn " + vectorText(point, row.label));
    }

    for (const face of polygonFaces(shape, options.topology)) {
      if (determinant < 0) face.reverse();
      const corners = face.map(index => {
        const position = firstVertex + index, uv = shape.uvs ? firstUv + index : "";
        if (shape.normals) return position + "/" + uv + "/" + (firstNormal + index);
        return shape.uvs ? position + "/" + uv : String(position);
      });
      lines.push("f " + corners.join(" "));
    }
    parts.push(lines.join("\n") + "\n");
    firstVertex += shape.vertices.length;
    if (shape.uvs) firstUv += shape.vertices.length;
    if (shape.normals) firstNormal += shape.vertices.length;
  }
  return new Blob(parts, { type: "text/plain" });
}
