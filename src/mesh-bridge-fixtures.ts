import type { MeshMaterialData } from "./mesh-materials.ts";
import { meshEdges } from "./mesh-modeling.ts";
import { emptyScene, normalizedChannels, type MeshFace, type MeshShapeNode, type Vec3 } from "./scene-document.ts";

const material = (name: string, color: string): MeshMaterialData => ({ name, color, emissive: "#000000", emissiveIntensity: 1,
  roughness: .7, metalness: 0, opacity: 1, transparent: false, alphaTest: 0, side: 0, depthWrite: true, normalScale: [1, 1] });

/** Original fixture geometry with single-sided materials so winding is visible. */
export function bridgeFixture(kind: "cylinder" | "boxes", count = kind === "boxes" ? 4 : 12) {
  const shape: MeshShapeNode = { id: `${kind}_shape`, parentId: kind, name: `${kind}Shape`, type: "meshShape", vertices: [], faces: [],
    color: "#b4c1ce", wireframe: true, shading: kind === "boxes" ? "flat" : "smooth",
    materials: [material("Teal", "#68b7ba"), material("Gold", "#e2ac6c")] };
  const rings = ["lower_end", "lower_gap", "upper_gap", "upper_end"].map((key, ring) => Array.from({ length: count }, (_, i) => {
    const angle = Math.PI * (2 * i / count + (kind === "boxes" ? .25 : 0));
    const position: Vec3 = [Math.cos(angle) * .85, [-1.5, -.55, .55, 1.5][ring], Math.sin(angle) * .85];
    const id = `${key}_${String(i).padStart(2, "0")}`;
    shape.vertices.push({ id, position });
    return id;
  }));
  function wall(from: string[], to: string[], label: string, upper: boolean) {
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      const face: MeshFace = { id: `${label}_${i}`, vertices: [from[i], to[i], to[next], from[next]], materialIndex: upper ? 1 : i % 2 };
      shape.faces.push(face);
    }
  }
  wall(rings[0], rings[1], "lower", false); wall(rings[2], rings[3], "upper", true);
  if (kind === "boxes") shape.faces.push({ id: "box_lower_cap", vertices: rings[0], materialIndex: 0 },
    { id: "box_upper_cap", vertices: [...rings[3]].reverse(), materialIndex: 1 });
  const edgeIds = meshEdges(shape).filter(edge => edge.faceIds.length === 1 && edge.vertices.every(id => id.includes("_gap_"))).map(edge => edge.id);
  return { shape, edgeIds, rings };
}

export function bridgeFixtureScene() {
  const document = emptyScene();
  for (const kind of ["cylinder", "boxes"] as const) {
    const name = kind === "cylinder" ? "Open cylinder sections" : "Separated open boxes";
    const position: Vec3 = [kind === "cylinder" ? -1.25 : 1.25, 0, 0];
    const { shape } = bridgeFixture(kind);
    document.rootIds.push(kind);
    document.nodes[kind] = { id: kind, name, type: "transform", parentId: null, rotationOrder: "XYZ",
      ...normalizedChannels({ position, rotation: [0, 0, 0], scale: [1, 1, 1] }) };
    document.nodes[shape.id] = shape;
  }
  return document;
}
