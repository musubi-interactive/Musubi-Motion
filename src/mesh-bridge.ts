import { Box3, Vector3 } from "three";
import { meshEdges, setMeshTopology, triangulateMesh, validateMeshShape, type MeshEdge } from "./mesh-modeling.ts";
import { MESH_TEXTURE_SLOTS } from "./mesh-materials.ts";
import type { MeshFace, MeshShapeNode, MeshVertex } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export const MAX_BRIDGE_SEGMENTS = 8;
const MAX_LOOP_EDGES = 32;
const MAX_SOURCE_CORNERS = 4096;

type BridgeDirection = "auto" | "forward" | "reverse";
type BridgeOptions = { direction: BridgeDirection; offset: number; segments: number };
export type MeshBridgeResult = { shape: MeshShapeNode; faceIds: string[]; rings: string[][] };
type Boundary = { vertices: string[]; edgeIds: string[]; followsFace: boolean };
type Triple<T> = [T, T, T];
type CollisionTriangle = {
  ids: Triple<string>; points: Triple<Vector3>; sides: Triple<Vector3>; normal: Vector3; bounds: Box3; faceId: string;
};

const edgeId = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);

function findBoundaries(shape: MeshShapeNode, selected: readonly string[]): Boundary[] {
  if (!selected.length || new Set(selected).size !== selected.length) throw Error("Select distinct boundary edges.");
  if (shape.vertices.length > MAX_SOURCE_CORNERS || shape.faces.reduce((count, face) => count + face.vertices.length, 0) > MAX_SOURCE_CORNERS) {
    throw Error("Bridge supports at most 4,096 source vertices and 4,096 source face corners.");
  }
  const edges = meshEdges(shape);
  const byId = new Map(edges.map(edge => [edge.id, edge]));
  const faces = new Map(shape.faces.map(face => [face.id, face]));
  const neighbors = new Map<string, MeshEdge[]>();
  for (const edge of edges) if (edge.faceIds.length === 1) {
    for (const vertex of edge.vertices) {
      const incident = neighbors.get(vertex) ?? [];
      incident.push(edge); neighbors.set(vertex, incident);
    }
  }
  const visited = new Set<string>();
  const loops: Boundary[] = [];
  for (const id of selected) {
    const seed = byId.get(id);
    if (!seed) throw Error("A selected edge no longer exists.");
    if (seed.faceIds.length !== 1) throw Error("Bridge requires boundary edges with exactly one adjacent face.");
    if (visited.has(id)) continue;
    const vertices: string[] = [];
    const vertexSet = new Set<string>();
    let vertex = seed.vertices[0], next = seed;
    while (!vertexSet.has(vertex)) {
      vertexSet.add(vertex); vertices.push(vertex);
      if (vertices.length > MAX_LOOP_EDGES) throw Error("Bridge supports at most 32 edges per boundary loop.");
      vertex = next.vertices[0] === vertex ? next.vertices[1] : next.vertices[0];
      const fan = neighbors.get(vertex)!;
      if (fan.length !== 2) throw Error("Bridge requires simple closed boundary loops without branches.");
      next = fan[0] === next ? fan[1] : fan[0];
    }
    if (next !== seed || vertex !== vertices[0] || vertices.length < 3) throw Error("Bridge requires simple closed boundary loops.");

    // Canonicalize the start and direction independently of pick order. The
    // face winding then dictates which geometric direction is compatible.
    const start = vertices.indexOf([...vertices].sort()[0]);
    const ordered = [...vertices.slice(start), ...vertices.slice(0, start)];
    if (ordered[1] > ordered.at(-1)!) ordered.splice(1, ordered.length - 1, ...ordered.slice(1).reverse());
    const ids = ordered.map((point, i) => edgeId(point, ordered[(i + 1) % ordered.length]));
    const directions = ids.map((edge, i) => {
      const face = faces.get(byId.get(edge)!.faceIds[0])!;
      return face.vertices[(face.vertices.indexOf(ordered[i]) + 1) % face.vertices.length] === ordered[(i + 1) % ordered.length];
    });
    if (directions.some(direction => direction !== directions[0])) throw Error("Boundary faces need consistent winding.");
    ids.forEach(edge => visited.add(edge));
    loops.push({ vertices: ordered, edgeIds: ids, followsFace: directions[0] });
  }
  return loops.sort((a, b) => a.vertices[0] < b.vertices[0] ? -1 : 1);
}

export function expandBridgeBoundaryEdges(shape: MeshShapeNode, seedIds: readonly string[]): string[] {
  return findBoundaries(shape, seedIds).flatMap(loop => loop.edgeIds);
}

function ringNormal(points: Vector3[]): Vector3 {
  const normal = new Vector3();
  for (let i = 1; i + 1 < points.length; i++) {
    normal.add(points[i].clone().sub(points[0]).cross(points[i + 1].clone().sub(points[0])));
  }
  return normal.normalize();
}

function checkConvexRing(points: Vector3[], normal: Vector3, tolerance: number) {
  if (!normal.lengthSq() || points.some(point => Math.abs(point.clone().sub(points[0]).dot(normal)) > tolerance)) {
    throw Error("Bridge requires planar boundary loops.");
  }
  for (let i = 0; i < points.length; i++) {
    const point = points[i], side = points[(i + 1) % points.length].clone().sub(point);
    if (side.length() <= tolerance) throw Error("A bridge boundary edge collapses at viewport precision.");
    for (let j = 0; j < points.length; j++) {
      if (j === i || j === (i + 1) % points.length) continue;
      if (side.clone().cross(points[j].clone().sub(point)).dot(normal) <= tolerance * side.length()) {
        throw Error("Bridge requires simple, strictly convex boundary loops.");
      }
    }
  }
}

function collisionTriangle(ids: Triple<string>, points: Triple<Vector3>, faceId: string): CollisionTriangle {
  const sides: Triple<Vector3> = [points[1].clone().sub(points[0]), points[2].clone().sub(points[1]), points[0].clone().sub(points[2])];
  const normal = sides[0].clone().cross(sides[1]).normalize();
  return { ids, points, sides, normal, bounds: new Box3().setFromPoints(points), faceId };
}

function collisionTriangles(shape: MeshShapeNode): CollisionTriangle[] {
  const { positions, indices, vertexIds, triangleFaceIds } = triangulateMesh(shape);
  const points = vertexIds.map((_, i) => new Vector3().fromArray(positions, i * 3));
  return triangleFaceIds.map((faceId, i) => {
    const corners = indices.slice(i * 3, i * 3 + 3) as Triple<number>;
    return collisionTriangle(corners.map(index => vertexIds[index]) as Triple<string>, corners.map(index => points[index]) as Triple<Vector3>, faceId);
  });
}

/** Triangle SAT, including in-plane axes in the coplanar case. Use the actual
 * viewport triangles and local-relative projections to avoid large translations. */
function overlaps(a: CollisionTriangle, b: CollisionTriangle, tolerance: number): boolean {
  if (!a.bounds.intersectsBox(b.bounds)) return false;
  const origin = a.points[0];
  const displacement = b.points[0].clone().sub(origin);
  const separated = (axis: Vector3) => {
    const x1 = a.sides[0].dot(axis), x2 = -a.sides[2].dot(axis);
    const y0 = displacement.dot(axis), y1 = y0 + b.sides[0].dot(axis), y2 = y0 - b.sides[2].dot(axis);
    const gap = tolerance * axis.length();
    return Math.max(0, x1, x2) < Math.min(y0, y1, y2) - gap || Math.max(y0, y1, y2) < Math.min(0, x1, x2) - gap;
  };
  if (separated(a.normal) || separated(b.normal)) return false;
  const axis = new Vector3();
  for (const side of a.sides) for (const other of b.sides) if (separated(axis.crossVectors(side, other))) return false;
  for (const triangle of [a, b]) for (const side of triangle.sides) {
    if (separated(axis.crossVectors(side, triangle.normal))) return false;
  }
  return true;
}

function forbiddenContact(a: CollisionTriangle, b: CollisionTriangle, tolerance: number): boolean {
  if (!a.bounds.intersectsBox(b.bounds)) return false;
  const shared = a.ids.filter(id => b.ids.includes(id));
  if (shared.length === 3) return true;
  if (shared.length === 2) {
    // Two non-coplanar triangles sharing an edge can intersect only along that
    // edge. Coplanar triangles with coherent winding overlap if their normals oppose.
    return a.normal.dot(b.normal) < -1 + 1e-10;
  }
  if (!shared.length) return overlaps(a, b, tolerance);
  // Permit exactly the authored shared point. Cut a tolerance-sized corner
  // from one triangle and test the remaining quadrilateral as two triangles.
  const i = a.ids.indexOf(shared[0]);
  const point = a.points[i], next = a.points[(i + 1) % 3], last = a.points[(i + 2) % 3];
  const cut = (towards: Vector3) => point.clone().lerp(towards, Math.min(.5, 16 * tolerance / point.distanceTo(towards)));
  const near = cut(next), far = cut(last);
  return overlaps(collisionTriangle(a.ids, [near, next, last], a.faceId), b, tolerance)
    || overlaps(collisionTriangle(a.ids, [near, last, far], a.faceId), b, tolerance);
}

export function prepareMeshBridge(shape: MeshShapeNode, selected: readonly string[]) {
  if (shape.skin || shape.morphTargets || shape.normals || shape.uvs || shape.uvSets || shape.materials?.some(material => MESH_TEXTURE_SLOTS.some(slot => material[slot]))) {
    throw Error("Bridge supports unskinned meshes without blend shapes, imported normals, UVs or texture maps.");
  }
  const loops = findBoundaries(shape, selected);
  if (loops.length !== 2 || loops.some(loop => loop.edgeIds.some(id => !selected.includes(id)))) {
    throw Error("Select exactly two complete boundary loops. Use Select Boundary Loops to expand picked edges.");
  }
  const [source, target] = loops, count = source.vertices.length;
  if (count !== target.vertices.length) throw Error("The two boundary loops must have equal edge counts.");
  if (source.vertices.some(id => target.vertices.includes(id))) throw Error("Bridge boundary loops must be disjoint.");
  validateMeshShape(shape);
  const positions = new Map(shape.vertices.map(vertex => [vertex.id, new Vector3(...vertex.position)]));
  const [a, b] = loops.map(loop => loop.vertices.map(id => positions.get(id)!));
  const extent = Math.max(...[...a, ...b].map(point => point.distanceTo(a[0])));
  const tolerance = Math.max(1e-9, extent * 1e-7);
  const normalA = ringNormal(a), normalB = ringNormal(b);
  checkConvexRing(a, normalA, tolerance); checkConvexRing(b, normalB, tolerance);
  if (Math.abs(normalA.dot(normalB)) < 1 - 1e-10 || b.some(point => Math.abs(point.clone().sub(b[0]).dot(normalA)) > tolerance) ||
    Math.abs(b[0].clone().sub(a[0]).dot(normalA)) <= 16 * tolerance) {
    throw Error("Bridge requires separated boundary loops in parallel planes.");
  }
  const reversed = source.followsFace === target.followsFace;
  const step = reversed ? -1 : 1;
  if (normalA.dot(normalB) * step <= 0) throw Error("The boundary face winding disagrees across the gap. Check the source shell normals.");
  const targetIndex = (i: number, shift: number) => (count + ((i * step + shift) % count)) % count;
  let nearest = 0, best = Infinity;
  for (let shift = 0; shift < count; shift++) {
    const cost = a.reduce((sum, point, i) => sum + point.distanceToSquared(b[targetIndex(i, shift)]), 0);
    if (cost < best) { best = cost; nearest = shift; }
  }
  // A linear strip stays inside the bounding box of its endpoints for every offset.
  const bounds = new Box3().setFromPoints([...a, ...b].map(point => point.clone().set(Math.fround(point.x), Math.fround(point.y), Math.fround(point.z))));
  const sourceTriangles = collisionTriangles(shape).filter(triangle => bounds.intersectsBox(triangle.bounds));
  const materials = new Map(shape.faces.map(face => [face.id, face.materialIndex]));
  const materialByEdge = new Map(meshEdges(shape).filter(edge => source.edgeIds.includes(edge.id)).map(edge => [edge.id, materials.get(edge.faceIds[0])]));
  const reserved = new Set([...shape.vertices, ...shape.faces].map(component => component.id));
  const generatedId = (base: string) => {
    let id = base, suffix = 0;
    while (reserved.has(id)) id = `${base}_${++suffix}`;
    return id;
  };

  return { source: shape, maxOffset: count - 1, direction: (reversed ? "reverse" : "forward") as Exclude<BridgeDirection, "auto">,
    evaluate({ direction, offset, segments }: BridgeOptions): MeshBridgeResult {
      if (direction !== "auto" && direction !== "forward" && direction !== "reverse") throw Error("Unknown Bridge direction.");
      if (direction !== "auto" && (direction === "reverse") !== reversed) throw Error("This direction would reverse the winding at a boundary. Choose Automatic or the other direction.");
      if (!Number.isInteger(offset) || offset < 0 || offset >= count) throw Error(`Bridge offset must be an integer from 0 to ${count - 1}.`);
      if (!Number.isInteger(segments) || segments < 1 || segments > MAX_BRIDGE_SEGMENTS) throw Error("Bridge segments must be an integer from 1 to 8.");
      const order = a.map((_, i) => targetIndex(i, nearest + offset));
      const end = order.map(i => target.vertices[i]);
      const addedVertices: MeshVertex[] = [];
      const rings = [[...source.vertices]];
      for (let ring = 1; ring < segments; ring++) rings.push(a.map((point, column) => {
        const id = generatedId(`bridge_v_${ring}_${column}`);
        addedVertices.push({ id, position: point.clone().lerp(b[order[column]], ring / segments).toArray() });
        return id;
      }));
      rings.push(end);
      const band: MeshFace[] = [];
      for (let ring = 0; ring < segments; ring++) for (let col = 0; col < count; col++) {
        const next = (col + 1) % count;
        const vertices = [rings[ring][col], rings[ring][next], rings[ring + 1][next], rings[ring + 1][col]];
        if (source.followsFace) vertices.reverse();
        const materialIndex = materialByEdge.get(source.edgeIds[col]);
        band.push({ id: generatedId(`bridge_f_${ring}_${col}`), vertices, ...(materialIndex === undefined ? {} : { materialIndex }) });
      }
      const vertices = [...shape.vertices, ...addedVertices];
      const output = { ...shape, vertices, faces: [...shape.faces, ...band] };
      validateMeshShape(output);
      const triangles = collisionTriangles({ ...shape, vertices, faces: band });
      for (let i = 0; i < triangles.length; i += 2) {
        const [first, second] = [triangles[i], triangles[i + 1]];
        if (first.normal.dot(second.normal) <= 1e-8 || [first, second].some(triangle => triangle.sides.some(side => side.length() <= tolerance))) {
          throw Error("Bridge would create a folded face or collapse at viewport precision. Try a different offset.");
        }
      }
      for (let i = 0; i < triangles.length; i++) {
        const triangle = triangles[i];
        for (const original of sourceTriangles) if (forbiddenContact(triangle, original, tolerance)) {
          throw Error("Bridge would intersect the source mesh. Try a different offset or boundary pair.");
        }
        for (let j = 0; j < i; j++) if (triangles[j].faceId !== triangle.faceId && forbiddenContact(triangle, triangles[j], tolerance)) {
          throw Error("Bridge would intersect itself. Try a different offset.");
        }
      }
      return { shape: output, rings, faceIds: band.map(face => face.id) };
    },
  };
}

export function commitMeshBridge(store: SceneStore, source: MeshShapeNode, result: MeshBridgeResult): void {
  if (store.getState().document.nodes[source.id] !== source) throw Error("The mesh changed during Bridge. Start a new preview.");
  if (result.shape.id !== source.id) throw Error("The Bridge result belongs to another mesh.");
  setMeshTopology(store, source.id, result.shape, "Bridge boundary loops");
}
