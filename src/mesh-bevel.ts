import { Vector3 } from "three";
import { meshEdges, setMeshTopology, triangulateMesh, validateMeshShape, type MeshEdge } from "./mesh-modeling.ts";
import type { MeshFace, MeshShapeNode, MeshVertex } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export const MAX_BEVEL_SEGMENTS = 8;
const MAX_SELECTED_EDGES = 24;
const MAX_SOURCE_CORNERS = 4096;
const MAX_RESULT_CORNERS = 8192;
const ANGLE_TOLERANCE = 1e-5;

export type MeshBevelOptions = { width: number; segments: number };
export type MeshBevelResult = {
  shape: MeshShapeNode;
  /** Each source face keeps its ID. Each source edge maps to surviving or replacement rails. */
  edgeMap: ReadonlyMap<string, readonly string[]>;
  bandFaces: ReadonlyMap<string, readonly string[]>;
};

type Plane = { normal: Vector3; distance: number };
type Cut = { plane: Plane; face: MeshFace };
type Shell = { faces: MeshFace[]; edges: MeshEdge[]; selected: MeshEdge[] };
const edgeKey = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);

function adjacentShells(shape: MeshShapeNode, edges: MeshEdge[], selected: MeshEdge[]): Shell[] {
  const faces = new Map(shape.faces.map(face => [face.id, face]));
  const edgesByFace = new Map(shape.faces.map(face => [face.id, [] as MeshEdge[]]));
  for (const edge of edges) for (const faceId of edge.faceIds) edgesByFace.get(faceId)!.push(edge);
  const shells: Shell[] = [];
  const visited = new Set<string>();
  const shellByFace = new Map<string, Shell>();
  for (const edge of selected) {
    const seed = edge.faceIds[0];
    const existing = shellByFace.get(seed);
    if (existing) { existing.selected.push(edge); continue; }
    const shell: Shell = { faces: [], edges: [], selected: [edge] };
    const shellEdges = new Set<MeshEdge>();
    const pending = [seed];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      shellByFace.set(id, shell);
      shell.faces.push(faces.get(id)!);
      for (const neighbor of edgesByFace.get(id)!) {
        if (neighbor.faceIds.length !== 2) throw Error("Bevel requires closed shells. The selected shell contains a boundary edge.");
        shellEdges.add(neighbor);
        for (const next of neighbor.faceIds) if (!visited.has(next)) pending.push(next);
      }
    }
    shell.edges = [...shellEdges];
    shells.push(shell);
  }
  return shells;
}

function shellGeometry(shell: Shell, positions: ReadonlyMap<string, Vector3>) {
  const vertexIds = [...new Set(shell.faces.flatMap(face => face.vertices))];
  const origin = positions.get(vertexIds[0])!;
  const local = new Map(vertexIds.map(id => [id, positions.get(id)!.clone().sub(origin)]));
  const points = [...local.values()];
  const extent = Math.max(...points.map(point => point.length()));
  const tolerance = Math.max(1e-12, extent * 1e-8);
  // Three's generated primitives start as Float32 coordinates. Allow their
  // rounding noise when testing support planes, independently of clipping.
  const convexTolerance = Math.max(tolerance, extent * 1e-7);
  const center = new Vector3();
  for (const point of points) center.addScaledVector(point, 1 / points.length);
  const planes = new Map<string, Plane>();
  for (const face of shell.faces) {
    const corners = face.vertices.map(id => local.get(id)!);
    const base = corners[0];
    const normal = new Vector3();
    for (let index = 1; index + 1 < corners.length; index++) {
      normal.add(corners[index].clone().sub(base).cross(corners[index + 1].clone().sub(base)));
    }
    normal.normalize();
    const hasConcaveCorner = corners.some((point, index) => {
      const previous = corners[(index + corners.length - 1) % corners.length];
      const next = corners[(index + 1) % corners.length];
      return point.clone().sub(previous).cross(next.clone().sub(point)).dot(normal) < -tolerance * extent;
    });
    if (normal.dot(center.clone().sub(base)) > 0) normal.negate();
    const distance = normal.dot(base);
    if (distance - normal.dot(center) <= tolerance ||
      corners.some(point => Math.abs(normal.dot(point) - distance) > tolerance) || hasConcaveCorner ||
      points.some(point => normal.dot(point) - distance > convexTolerance)) {
      throw Error("Bevel supports closed convex shells with planar, convex faces.");
    }
    planes.set(face.id, { normal, distance });
  }
  return { origin, local, planes, tolerance };
}

function createCuts(shell: Shell, faces: ReadonlyMap<string, MeshFace>, local: ReadonlyMap<string, Vector3>,
  planes: ReadonlyMap<string, Plane>, width: number, segments: number, nextId: () => string): Cut[] {
  const cuts: Cut[] = [];
  for (const edge of shell.selected) {
    const [firstId, secondId] = edge.faceIds;
    const first = planes.get(firstId)!.normal;
    const second = planes.get(secondId)!.normal;
    const angle = first.angleTo(second);
    if (angle < ANGLE_TOLERANCE || angle > Math.PI - ANGLE_TOLERANCE) {
      throw Error("Bevel requires a distinct angle between the selected edge's two faces.");
    }
    const radius = width / Math.tan(angle / 2);
    const center = local.get(edge.vertices[0])!.clone()
      .addScaledVector(first.clone().add(second), -radius / (1 + first.dot(second)));
    const tangent = second.clone().addScaledVector(first, -first.dot(second)).normalize();
    const halfSegment = angle / segments / 2;
    const materialIndex = faces.get(firstId)!.materialIndex;
    for (let segment = 0; segment < segments; segment++) {
      const parameter = (segment * 2 + 1) * halfSegment;
      const normal = first.clone().multiplyScalar(Math.cos(parameter)).addScaledVector(tangent, Math.sin(parameter));
      cuts.push({
        plane: { normal, distance: normal.dot(center) + radius * Math.cos(halfSegment) },
        face: { id: nextId(), vertices: [], ...(materialIndex === undefined ? {} : { materialIndex }) },
      });
    }
  }
  return cuts;
}

/** Clip a closed shell by one profile plane and close the resulting single ring.
 * The intersection cache gives opposite half-edges the same authored vertex. */
function clip(faces: MeshFace[], positions: Map<string, Vector3>, { plane, face: cap }: Cut,
  tolerance: number, nextId: () => string): MeshFace[] {
  const distances = new Map<string, number>();
  for (const face of faces) for (const id of face.vertices) {
    if (distances.has(id)) continue;
    const distance = plane.normal.dot(positions.get(id)!) - plane.distance;
    distances.set(id, Math.abs(distance) <= tolerance ? 0 : distance);
  }
  const crossing = new Map<string, string>();
  function intersect(a: string, b: string, da: number, db: number) {
    const key = edgeKey(a, b);
    const existing = crossing.get(key);
    if (existing) return existing;
    const id = nextId();
    crossing.set(key, id);
    positions.set(id, positions.get(a)!.clone().lerp(positions.get(b)!, da / (da - db)));
    distances.set(id, 0);
    return id;
  }
  const boundary = new Map<string, [string, string]>();
  const retained: MeshFace[] = [];
  for (const face of faces) {
    const vertices: string[] = [];
    for (const [index, a] of face.vertices.entries()) {
      const b = face.vertices[(index + 1) % face.vertices.length];
      const da = distances.get(a)!;
      const db = distances.get(b)!;
      if (da <= 0) vertices.push(a);
      if (da * db < 0) vertices.push(intersect(a, b, da, db));
    }
    if (vertices.length < 3) throw Error("Bevel width removes a face. Use a smaller Width.");
    if (vertices.length > 64) throw Error("Bevel would produce a face with more than 64 corners.");
    retained.push(vertices.length === face.vertices.length && vertices.every((id, index) => id === face.vertices[index])
      ? face : { ...face, vertices });
    for (const [index, a] of vertices.entries()) {
      const b = vertices[(index + 1) % vertices.length];
      if (distances.get(a) !== 0 || distances.get(b) !== 0) continue;
      const key = edgeKey(a, b);
      if (boundary.has(key)) boundary.delete(key);
      else boundary.set(key, [b, a]);
    }
  }
  const next = new Map(boundary.values());
  const seed = next.keys().next().value;
  if (!seed || next.size !== boundary.size || next.size < 3 || next.size > 64) {
    throw Error("Bevel could not form a supported closed profile. Adjust Width or Segments.");
  }
  const ring = [seed];
  let id = next.get(seed);
  while (id && id !== seed && ring.length < next.size) {
    ring.push(id);
    id = next.get(id);
  }
  if (id !== seed || ring.length !== next.size) throw Error("Bevel intersections must form one closed profile.");
  return [...retained, { ...cap, vertices: ring }];
}

function verifyViewportPrecision(shape: MeshShapeNode, generated: ReadonlyMap<string, MeshVertex>) {
  const { positions, indices } = triangulateMesh(shape);
  const originals = shape.vertices.map(vertex => new Vector3(...vertex.position));
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), exact = new Vector3(), direction = new Vector3();
  for (let index = 0; index < indices.length; index += 3) {
    const i = indices[index], j = indices[index + 1], k = indices[index + 2];
    if (![i, j, k].some(vertex => generated.has(shape.vertices[vertex].id))) continue;
    a.fromArray(positions, i * 3);
    b.fromArray(positions, j * 3);
    c.fromArray(positions, k * 3);
    exact.subVectors(originals[j], originals[i]).cross(direction.subVectors(originals[k], originals[i]));
    if (b.sub(a).cross(c.sub(a)).dot(exact) <= 0) throw Error("Bevel Width is too small for viewport precision.");
  }
}

function retainedSegments(source: MeshEdge, candidates: readonly MeshEdge[], original: ReadonlyMap<string, Vector3>,
  generated: ReadonlyMap<string, MeshVertex>): string[] {
  const start = original.get(source.vertices[0])!;
  const axis = original.get(source.vertices[1])!.clone().sub(start);
  const lengthSquared = axis.lengthSq();
  return candidates.filter(edge => {
    const [a, b] = edge.vertices.map(id => {
      const point = original.get(id) ?? new Vector3(...generated.get(id)!.position);
      return point.clone().sub(start).dot(axis) / lengthSquared;
    });
    return Math.min(1, Math.max(a, b)) - Math.max(0, Math.min(a, b)) > 1e-8;
  }).map(edge => edge.id);
}

/** Capture a validated immutable source once. Slider edits always evaluate from
 * that source, including after an invalid candidate. */
export function prepareMeshBevel(shape: MeshShapeNode, edgeIds: readonly string[]) {
  if (shape.skin || shape.morphTargets || shape.uvs || shape.uvSets || shape.normals) {
    throw Error("Bevel requires an unskinned mesh without blend shapes, imported normals or UVs.");
  }
  if (!edgeIds.length || edgeIds.length > MAX_SELECTED_EDGES) throw Error("Select 1–24 mesh edges to bevel.");
  if (shape.faces.reduce((sum, face) => sum + face.vertices.length, 0) > MAX_SOURCE_CORNERS ||
    shape.vertices.length > MAX_SOURCE_CORNERS) {
    throw Error("Bevel supports meshes with up to 4,096 vertices and face corners.");
  }
  validateMeshShape(shape);
  const edges = meshEdges(shape);
  const requested = new Set(edgeIds);
  const selected = edges.filter(edge => requested.has(edge.id));
  if (selected.length !== requested.size) throw Error("A selected edge no longer exists.");
  if (selected.some(edge => edge.faceIds.length !== 2)) throw Error("Boundary and nonmanifold edges cannot be beveled.");
  const pairCounts = new Map<string, number>();
  for (const edge of edges) {
    if (edge.faceIds.length !== 2) continue;
    const key = edgeKey(edge.faceIds[0], edge.faceIds[1]);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  if (selected.some(edge => pairCounts.get(edgeKey(edge.faceIds[0], edge.faceIds[1])) !== 1)) {
    throw Error("Choose unsplit edges. Bevel requires each selected edge to be the single shared edge between its two faces.");
  }
  const positions = new Map(shape.vertices.map(vertex => [vertex.id, new Vector3(...vertex.position)]));
  const faces = new Map(shape.faces.map(face => [face.id, face]));
  const shells = adjacentShells(shape, edges, selected).map(shell => ({ shell, ...shellGeometry(shell, positions) }));
  const shortest = Math.min(...shells.flatMap(({ shell }) => shell.edges.map(({ vertices: [a, b] }) => positions.get(a)!.distanceTo(positions.get(b)!))));
  const originalIds = new Set([...positions.keys(), ...faces.keys()]);
  const touched = new Set(shells.flatMap(({ shell }) => shell.faces.map(face => face.id)));
  return {
    source: shape,
    evaluate({ width, segments }: MeshBevelOptions): MeshBevelResult {
      if (!Number.isFinite(width) || width < 0 || width > 1) throw Error("Bevel Width must be a fraction between 0 and 1.");
      if (!Number.isInteger(segments) || segments < 1 || segments > MAX_BEVEL_SEGMENTS) throw Error("Bevel Segments must be an integer from 1 to 8.");
      const edgeMap = new Map(edges.map(edge => [edge.id, [edge.id]]));
      const bandFaces = new Map<string, string[]>();
      if (width === 0) return { shape, edgeMap, bandFaces };
      // Half the shortest edge bounds symmetric trimming. Leave a small
      // margin so opposite cuts at full Width cannot meet on a regular shell.
      const distance = width * shortest * .45;
      const clipped = new Map<string, MeshFace>();
      const added: MeshFace[] = [];
      const generated = new Map<string, MeshVertex>();
      let cursor = 0;
      function nextId() {
        let id: string;
        do { id = `bevel_${++cursor}`; } while (originalIds.has(id));
        return id;
      }
      for (const { shell, origin, local, planes, tolerance } of shells) {
        if (distance <= tolerance * 4) throw Error("Bevel Width is too small to represent on this mesh.");
        const cuts = createCuts(shell, faces, local, planes, distance, segments, nextId);
        const temporary = new Map(local);
        let remaining = shell.faces;
        for (const cut of cuts) {
          remaining = clip(remaining, temporary, cut, tolerance, nextId);
          const active = new Set(remaining.flatMap(face => face.vertices));
          for (const id of temporary.keys()) if (!active.has(id)) temporary.delete(id);
        }
        for (const face of remaining) {
          if (faces.has(face.id)) clipped.set(face.id, face);
          else added.push(face);
          for (const id of face.vertices) if (!positions.has(id) && !generated.has(id)) {
            generated.set(id, { id, position: temporary.get(id)!.clone().add(origin).toArray() });
          }
        }
        for (const [index, edge] of shell.selected.entries()) {
          bandFaces.set(edge.id, cuts.slice(index * segments, (index + 1) * segments).map(cut => cut.face.id));
        }
      }
      const outputFaces = [...shape.faces.map(face => clipped.get(face.id) ?? face), ...added];
      if (outputFaces.reduce((sum, face) => sum + face.vertices.length, 0) > MAX_RESULT_CORNERS) {
        throw Error("Bevel would produce more than 8,192 face corners.");
      }
      const usedIds = new Set(outputFaces.flatMap(face => face.vertices));
      const previouslyUsed = new Set(shells.flatMap(({ shell }) => shell.faces.flatMap(face => face.vertices)));
      const output: MeshShapeNode = { ...shape, faces: outputFaces, vertices: [
        ...shape.vertices.filter(vertex => usedIds.has(vertex.id) || !previouslyUsed.has(vertex.id)), ...generated.values(),
      ] };
      validateMeshShape(output);
      verifyViewportPrecision(output, generated);
      const nextEdges = meshEdges(output);
      const byFaces = new Map<string, MeshEdge[]>();
      for (const edge of nextEdges) {
        if (edge.faceIds.length !== 2 && edge.faceIds.some(id => clipped.has(id) || !faces.has(id))) {
          throw Error("Bevel produced an open shell.");
        }
        if (edge.faceIds.length === 2) {
          const key = edgeKey(edge.faceIds[0], edge.faceIds[1]);
          const list = byFaces.get(key) ?? [];
          list.push(edge);
          byFaces.set(key, list);
        }
      }
      const exactEdges = new Set(nextEdges.map(edge => edge.id));
      for (const edge of edges) {
        if (!edge.faceIds.every(id => touched.has(id))) continue;
        const [a, b] = edge.faceIds;
        const band = bandFaces.get(edge.id);
        if (!band) {
          if (exactEdges.has(edge.id)) continue;
          const retained = retainedSegments(edge, byFaces.get(edgeKey(a, b)) ?? [], positions, generated);
          if (!retained.length) throw Error("Bevel width consumes an edge. Use a smaller Width.");
          edgeMap.set(edge.id, retained);
          continue;
        }
        const chain = [a, ...band, b];
        const rails = chain.slice(1).map((id, index) => byFaces.get(edgeKey(chain[index], id)));
        if (rails.some(pair => !pair?.length)) throw Error("Bevel width consumes an edge. Use a smaller Width.");
        edgeMap.set(edge.id, rails.flatMap(pair => pair?.map(candidate => candidate.id) ?? []));
      }
      return { shape: output, edgeMap, bandFaces };
    },
  };
}

export function commitMeshBevel(store: SceneStore, source: MeshShapeNode, result: MeshBevelResult): void {
  if (store.getState().document.nodes[source.id] !== source) throw Error("The mesh changed during Bevel. Start a new preview.");
  if (result.shape.id !== source.id) throw Error("The Bevel result belongs to another mesh.");
  if (result.shape !== source) setMeshTopology(store, source.id, result.shape, "Bevel edges");
}
