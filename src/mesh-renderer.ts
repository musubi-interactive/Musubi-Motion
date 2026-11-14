import { Box3, BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { applyMeshTextureUV, createMaterials, disposeMaterials, meshTextureUVEdit, type EditableTextureSlot, type TextureUVField } from "./mesh-materials.ts";
import { meshEdges, triangulateMesh, validateMeshShape } from "./mesh-modeling.ts";
import type { MeshShapeNode, Vec3 } from "./scene-document.ts";
import { deformMeshPositions } from "./mesh-skin.ts";
import type { Matrix4 } from "three";

export type MeshVertexPreview = { id: string; position: Vec3 };

function geometryFor(shape: MeshShapeNode) {
  const data = triangulateMesh(shape), geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(data.positions, 3).setUsage(DynamicDrawUsage));
  geometry.setIndex(data.indices);
  if (shape.uvs) geometry.setAttribute("uv", new BufferAttribute(new Float32Array(shape.vertices.flatMap(v => shape.uvs![v.id])), 2));
  for (const [channel, coordinates] of Object.entries(shape.uvSets ?? {}))
    geometry.setAttribute(`uv${channel}`, new BufferAttribute(new Float32Array(shape.vertices.flatMap(v => coordinates[v.id])), 2));
  if (shape.materials && shape.materials.length > 1) {
    const faces = new Map(shape.faces.map(f => [f.id, f]));
    // Each group is a draw call; contiguous triangles sharing a material are one batch.
    data.triangleFaceIds.forEach((faceId, i) => {
      const materialIndex = faces.get(faceId)!.materialIndex ?? 0, last = geometry.groups[geometry.groups.length - 1];
      if (last && last.materialIndex === materialIndex) last.count += 3;
      else geometry.addGroup(i * 3, 3, materialIndex);
    });
  }
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  if (shape.normals) geometry.setAttribute("normal", new BufferAttribute(new Float32Array(shape.vertices.flatMap(v => shape.normals![v.id])), 3));
  const normals = geometry.getAttribute("normal") as BufferAttribute;
  normals.setUsage(DynamicDrawUsage);
  const vertexIndices = new Map(data.vertexIds.map((id, index) => [id, index]));
  const edgeVertexIndices = new Uint32Array(meshEdges(shape).flatMap(edge => edge.vertices.map(id => vertexIndices.get(id)!)));
  const lines = new Float32Array(edgeVertexIndices.length * 3);
  for (let i = 0; i < edgeVertexIndices.length; i++) lines.set(data.positions.subarray(edgeVertexIndices[i] * 3, edgeVertexIndices[i] * 3 + 3), i * 3);
  const edges = new BufferGeometry(); edges.setAttribute("position", new BufferAttribute(lines, 3).setUsage(DynamicDrawUsage));
  edges.computeBoundingBox(); edges.computeBoundingSphere();
  const smoothGroups = new Map<string, number[]>();
  if (shape.normals) shape.vertices.forEach((vertex, i) => {
    const key = JSON.stringify([vertex.position, shape.normals![vertex.id], shape.skin?.weights[vertex.id], shape.morphTargets?.map(m => m.deltas[vertex.id])]);
    const group = smoothGroups.get(key) ?? []; group.push(i); smoothGroups.set(key, group);
  });
  return { geometry, edges, ...data, vertexIndices, edgeVertexIndices, smoothGroups: [...smoothGroups.values()].filter(g => g.length > 1),
    committedPositions: data.positions.slice(), committedNormals: (normals.array as Float32Array).slice(),
    committedBounds: geometry.boundingBox!.clone(), committedSphere: geometry.boundingSphere!.clone(),
    committedEdgeBounds: edges.boundingBox!.clone(), committedEdgeSphere: edges.boundingSphere!.clone() };
}

/** Document topology is separate from triangulated GPU buffers and face hit mapping. */
export function createMeshRenderable(shape: MeshShapeNode, assets?: Readonly<Record<string, import("./texture-assets.ts").TextureAsset>>) {
  validateMeshShape(shape);
  let data = geometryFor(shape), previous = shape, disposed = false, previewing = false;
  let topologyPreview: ReturnType<typeof geometryFor> | undefined;
  const material = new MeshStandardMaterial({ color: shape.color, roughness: .8, metalness: 0,
    side: DoubleSide, flatShading: shape.shading === "flat", polygonOffset: shape.wireframe, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  let importedMaterials = shape.materials ? createMaterials(shape.materials, shape.shading === "flat", shape.wireframe, assets) : undefined;
  const mesh = new Mesh(data.geometry, material);
  if (importedMaterials) mesh.material = (importedMaterials.length === 1 ? importedMaterials[0] : importedMaterials) as unknown as MeshStandardMaterial; mesh.name = shape.name;
  const lineMaterial = new LineBasicMaterial({ color: 0x252525, transparent: true, opacity: .75 });
  const edges = new LineSegments(data.edges, lineMaterial); edges.visible = shape.wireframe; mesh.add(edges);
  const bounds = data.geometry.boundingBox?.clone() ?? new Box3();

  function recomputeNormals() {
    mesh.geometry.computeVertexNormals();
    const normals = mesh.geometry.getAttribute("normal") as BufferAttribute, total = new Vector3(), current = new Vector3();
    for (const group of data.smoothGroups) {
      total.set(0, 0, 0);
      for (const index of group) total.add(current.fromBufferAttribute(normals, index));
      total.normalize();
      for (const index of group) normals.setXYZ(index, total.x, total.y, total.z);
    }
    normals.needsUpdate = true;
  }

  function updateWirePositions(): void {
    const positions = edges.geometry.getAttribute("position") as BufferAttribute;
    for (let i = 0; i < data.edgeVertexIndices.length; i++) {
      const index = data.edgeVertexIndices[i] * 3;
      positions.setXYZ(i, data.positions[index], data.positions[index + 1], data.positions[index + 2]);
    }
    positions.needsUpdate = true;
  }

  function clearPreview(): void {
    if (disposed) return;
    if (topologyPreview) {
      mesh.geometry = data.geometry;
      edges.geometry = data.edges;
      bounds.copy(data.committedBounds);
      topologyPreview.geometry.dispose();
      topologyPreview.edges.dispose();
      topologyPreview = undefined;
    }
    if (!previewing) return;
    data.positions.set(data.committedPositions);
    const positions = mesh.geometry.getAttribute("position") as BufferAttribute, normals = mesh.geometry.getAttribute("normal") as BufferAttribute;
    normals.array.set(data.committedNormals);
    positions.needsUpdate = true; normals.needsUpdate = true;
    updateWirePositions();
    mesh.geometry.boundingBox!.copy(data.committedBounds); mesh.geometry.boundingSphere!.copy(data.committedSphere);
    edges.geometry.boundingBox!.copy(data.committedEdgeBounds); edges.geometry.boundingSphere!.copy(data.committedEdgeSphere);
    bounds.copy(data.committedBounds); previewing = false;
  }

  return {
    mesh, bounds,
    get centers() { return (topologyPreview ?? data).positions; },
    get triangleFaceIds() { return (topologyPreview ?? data).triangleFaceIds; },
    previewTexture(index: number, slot: EditableTextureSlot, field: TextureUVField) {
      const owner = importedMaterials?.[index], texture = owner?.[slot], source = previous.materials?.[index]?.[slot];
      if (disposed || !texture || !source) return;
      const isCurrent = () => !disposed && importedMaterials?.[index] === owner && owner[slot] === texture;
      return {
        update(value: number) {
          if (isCurrent()) applyMeshTextureUV(texture, { ...source, ...meshTextureUVEdit(source, field, value) });
        },
        end() {
          if (isCurrent()) applyMeshTextureUV(texture, source);
        },
      };
    },
    /** Display validated transient topology while retaining the exact authored buffers. */
    previewTopology(next: MeshShapeNode): void {
      if (disposed || next.id !== previous.id || previous.skin || previous.morphTargets ||
        next.materials !== previous.materials || next.normals !== previous.normals ||
        next.uvs !== previous.uvs || next.uvSets !== previous.uvSets) {
        throw Error("This mesh cannot preview replacement topology.");
      }
      validateMeshShape(next);
      const replacement = geometryFor(next);
      clearPreview();
      topologyPreview = replacement;
      mesh.geometry = replacement.geometry;
      edges.geometry = replacement.edges;
      bounds.copy(replacement.committedBounds);
    },
    /** Transient absolute local edits use the committed tessellation throughout
     * a gesture. Full topology validation and retessellation belong to commit.
     * The returned shape is for overlays only and must not enter document state. */
    previewVertices(changes: readonly MeshVertexPreview[]): MeshShapeNode {
      if (disposed) throw Error("Cannot preview a disposed mesh renderer.");
      if (!Array.isArray(changes)) throw Error("Mesh preview changes must be an array.");
      const edits = new Map<string, Vec3>();
      for (const change of changes as readonly MeshVertexPreview[]) {
        if (!change || typeof change.id !== "string" || !data.vertexIndices.has(change.id)) throw Error("Mesh preview references an unknown vertex.");
        if (edits.has(change.id)) throw Error("Mesh preview vertex IDs must be unique.");
        if (!Array.isArray(change.position) || change.position.length !== 3 || ![0, 1, 2].every(index => typeof change.position[index] === "number" && Number.isFinite(change.position[index]) && Math.abs(change.position[index]) <= 1e6)) throw Error("Mesh preview positions must be finite XYZ values within ±1,000,000.");
        edits.set(change.id, [...change.position]);
      }
      // Finish allocating/validating the ephemeral document view before touching
      // any visible buffer, including a currently active preview.
      const preview: MeshShapeNode = { ...previous, vertices: previous.vertices.map(vertex => {
        const position = edits.get(vertex.id);
        return position ? { ...vertex, position } : vertex;
      }) };
      if (!changes.length) { clearPreview(); return preview; }
      if (topologyPreview) clearPreview();
      data.positions.set(data.committedPositions);
      for (const [id, position] of edits) data.positions.set(position, data.vertexIndices.get(id)! * 3);
      (mesh.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
      recomputeNormals(); mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
      updateWirePositions(); edges.geometry.computeBoundingBox(); edges.geometry.computeBoundingSphere();
      bounds.copy(mesh.geometry.boundingBox!); previewing = true;
      return preview;
    },
    clearPreview,
    applySkin(world: (id: string) => Matrix4 | undefined, morphWeights?: number[]) {
      if ((!previous.skin && !previous.morphTargets) || disposed || previewing || topologyPreview) return;
      deformMeshPositions(previous, world, data.positions, morphWeights);
      (mesh.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
      recomputeNormals(); mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
      updateWirePositions(); edges.geometry.computeBoundingBox(); edges.geometry.computeBoundingSphere();
      bounds.copy(mesh.geometry.boundingBox!);
    },
    update(next: MeshShapeNode, nextAssets = assets) {
      if (disposed) throw Error("Cannot update a disposed mesh renderer.");
      validateMeshShape(next);
      if (topologyPreview) clearPreview();
      if ((previous.skin && !next.skin) || (previous.morphTargets && !next.morphTargets)) { previewing = true; clearPreview(); }
      const groupingChanged = (next.materials?.length ?? 1) > 1 !== ((previous.materials?.length ?? 1) > 1);
      if (next.vertices !== previous.vertices || next.faces !== previous.faces || next.uvs !== previous.uvs || next.uvSets !== previous.uvSets || next.normals !== previous.normals || groupingChanged) {
        const replacement = geometryFor(next), oldGeometry = mesh.geometry, oldEdges = edges.geometry;
        mesh.geometry = replacement.geometry; edges.geometry = replacement.edges; data = replacement;
        bounds.copy(replacement.geometry.boundingBox!); previewing = false; oldGeometry.dispose(); oldEdges.dispose();
      } else clearPreview();
      if (nextAssets !== assets || next.materials !== previous.materials || next.shading !== previous.shading || next.wireframe !== previous.wireframe) {
        const old = importedMaterials;
        const sameRenderSettings = nextAssets === assets && next.shading === previous.shading && next.wireframe === previous.wireframe;
        importedMaterials = next.materials?.map((value, index) => {
          const current = old?.[index];
          if (current && sameRenderSettings && value === previous.materials?.[index]) return current;
          return createMaterials([value], next.shading === "flat", next.wireframe, nextAssets)[0];
        });
        if (old) disposeMaterials(old.filter(value => !importedMaterials?.includes(value)));
        mesh.material = importedMaterials ? (importedMaterials.length === 1 ? importedMaterials[0] : importedMaterials) as unknown as MeshStandardMaterial : material;
      }
      const flatShading = next.shading === "flat";
      if (material.flatShading !== flatShading) { material.flatShading = flatShading; material.needsUpdate = true; }
      material.color.set(next.color); material.polygonOffset = next.wireframe;
      assets = nextAssets;
      mesh.name = next.name; edges.visible = next.wireframe; previous = next;
    },
    dispose() {
      if (disposed) return;
      clearPreview();
      disposed = true;
      mesh.geometry.dispose(); edges.geometry.dispose(); if (importedMaterials) disposeMaterials(importedMaterials); material.dispose(); lineMaterial.dispose(); mesh.removeFromParent();
    },
  };
}
