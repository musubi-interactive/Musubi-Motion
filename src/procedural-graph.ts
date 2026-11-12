import { validateSceneSplatAppearance } from "./splat-appearance.ts";
import type { SceneDocument } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import type { TextureAsset } from "./texture-assets.ts";
import { validateParticleEmitters } from "./particle-emitter.ts";

export const GRAPH_LIMITS = { nodes: 48, edges: 96, images: 4, pixels: 8_388_608, layout: 12_000 } as const;
export const GRAPH_KINDS = {
  texture: "Texture Sample",
  uv: "UV",
  position: "Position",
  time: "Time",
  particle: "Particle Attributes",
  vector: "Vector 3",
  noise: "Noise",
  gradient: "Gradient / Ramp",
  add: "Add",
  multiply: "Multiply",
  clamp: "Clamp",
  output: "Output",
} as const;
export type NodeKind = keyof typeof GRAPH_KINDS;
export type PortType = "scalar" | "vec2" | "vec3" | "color";
export const PORT_TYPES: readonly PortType[] = ["scalar", "vec2", "vec3", "color"];
export type Color = [number, number, number];
type Params = {
  texture: { assetId: string };
  uv: Record<string, never>;
  position: Record<string, never>;
  time: Record<string, never>;
  particle: Record<string, never>;
  vector: Record<string, never>;
  noise: { seed: number; scale: number; speed: number };
  gradient: { start: Color; end: Color };
  add: { type: PortType; a: number; b: number };
  multiply: { type: PortType; a: number; b: number };
  clamp: { type: PortType; value: number; min: number; max: number };
  output: { alpha: number };
};
export type GraphNode = { [K in NodeKind]: {
  id: string; kind: K; x: number; y: number; params: Params[K];
} }[NodeKind];
export type PortRef = { node: string; port: string };
export type GraphEdge = { from: PortRef; to: PortRef };
export type ProceduralGraph = { nodes: GraphNode[]; edges: GraphEdge[] };
type TextureLibrary = Readonly<Record<string, TextureAsset>>;
type InputPort = { name: string; types: readonly PortType[] };
type OutputPort = { name: string; type: PortType };

const defaults: Params = {
  texture: { assetId: "" },
  uv: {},
  position: {},
  time: {},
  particle: {},
  vector: {},
  noise: { seed: 1, scale: 6, speed: 1 },
  gradient: { start: [0.025, 0.06, 0.22], end: [1, 0.58, 0.15] },
  add: { type: "scalar", a: 0, b: 0 },
  multiply: { type: "color", a: 1, b: 1 },
  clamp: { type: "scalar", value: 0, min: 0, max: 1 },
  output: { alpha: 1 },
};
export function createGraphNode(kind: NodeKind, id: string, x: number, y: number): GraphNode {
  // Params are indexed by the same discriminant as kind.
  return { id, kind, x, y, params: structuredClone(defaults[kind]) } as GraphNode;
}

export function inputPorts(node: GraphNode): readonly InputPort[] {
  switch (node.kind) {
    case "texture": return [{ name: "uv", types: ["vec2"] }];
    case "noise": return [{ name: "position", types: ["vec2", "vec3"] }, { name: "time", types: ["scalar"] }];
    case "gradient": return [{ name: "factor", types: ["scalar"] }];
    case "add":
    case "multiply": return ["a", "b"].map(name => ({ name, types: [node.params.type, "scalar"] }));
    case "clamp": return [{ name: "value", types: [node.params.type, "scalar"] }, { name: "min", types: ["scalar"] }, { name: "max", types: ["scalar"] }];
    case "vector": return ["x", "y", "z"].map(name => ({ name, types: ["scalar"] }));
    case "output": return [{ name: "color", types: ["color", "scalar"] }, { name: "alpha", types: ["scalar"] },
      { name: "size", types: ["scalar"] }, { name: "field", types: ["vec3"] }];
    default: return [];
  }
}
export function outputPorts(node: GraphNode): readonly OutputPort[] {
  switch (node.kind) {
    case "texture": return [{ name: "color", type: "color" }, { name: "alpha", type: "scalar" }];
    case "uv": return [{ name: "uv", type: "vec2" }];
    case "position": return [{ name: "position", type: "vec3" }];
    case "particle": return ["age", "lifetime", "normalizedAge"].map(name => ({ name, type: "scalar" }));
    case "vector": return [{ name: "vector", type: "vec3" }];
    case "gradient": return [{ name: "color", type: "color" }];
    case "time":
    case "noise": return [{ name: "value", type: "scalar" }];
    case "add":
    case "multiply":
    case "clamp": return [{ name: "value", type: node.params.type }];
    default: return [];
  }
}

const nodeId = /^[A-Za-z0-9_-]{1,64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const keysMatch = (value: Record<string, unknown>, template: object) =>
  Object.keys(value).length === Object.keys(template).length && Object.keys(template).every(key => Object.hasOwn(value, key));
const graphError = (message: string): never => { throw new Error(message); };
const label = (node: GraphNode) => GRAPH_KINDS[node.kind];
export const portKey = ({ node, port }: PortRef) => node + ":" + port;

function validateNode(node: unknown, assets: TextureLibrary): asserts node is GraphNode {
  if (!object(node) || !keysMatch(node, { id: 0, kind: 0, x: 0, y: 0, params: 0 }) ||
    typeof node.id !== "string" || !nodeId.test(node.id) ||
    typeof node.kind !== "string" || !Object.hasOwn(GRAPH_KINDS, node.kind) ||
    !finite(node.x, 0, GRAPH_LIMITS.layout) || !finite(node.y, 0, GRAPH_LIMITS.layout))
    return graphError("Invalid texture graph node or layout.");
  const kind = node.kind as NodeKind;
  const params = node.params;
  if (!object(params) || !keysMatch(params, defaults[kind])) return graphError("Invalid " + GRAPH_KINDS[kind] + " parameters.");
  for (const [key, value] of Object.entries(params)) {
    let valid: boolean;
    switch (key) {
      case "assetId": valid = typeof value === "string" && (value === "" || Object.hasOwn(assets, value)); break;
      case "type": valid = PORT_TYPES.includes(value as PortType); break;
      case "seed": valid = finite(value, 0, 0xffff) && Number.isInteger(value); break;
      case "scale": valid = finite(value, 0.01, 128); break;
      case "speed": valid = finite(value, -16, 16); break;
      case "alpha": valid = finite(value, 0, 1); break;
      case "start":
      case "end": valid = Array.isArray(value) && value.length === 3 && [...value].every(c => finite(c, 0, 1)); break;
      default: valid = finite(value, -1024, 1024);
    }
    if (!valid) graphError(key === "assetId" ? "Texture graph references a missing image asset." : "Invalid " + GRAPH_KINDS[kind] + " " + key + ".");
  }
}

function isPortRef(ref: unknown): ref is PortRef {
  return object(ref) && keysMatch(ref, { node: 0, port: 0 }) &&
    typeof ref.node === "string" && typeof ref.port === "string";
}

export function graphOrder(graph: ProceduralGraph): GraphNode[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const sources = incoming.get(edge.to.node) ?? [];
    sources.push(edge.from.node);
    incoming.set(edge.to.node, sources);
  }
  const visiting = new Set<string>(), visited = new Set<string>(), ordered: GraphNode[] = [];
  function visit(id: string) {
    if (visiting.has(id)) graphError("This connection would create a texture graph cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const source of incoming.get(id) ?? []) visit(source);
    visiting.delete(id);
    visited.add(id);
    ordered.push(nodes.get(id)!);
  }
  for (const node of graph.nodes) visit(node.id);
  return ordered;
}

export function validateProceduralGraph(value: unknown, assets: TextureLibrary = {}): asserts value is ProceduralGraph {
  if (!object(value) || !keysMatch(value, { nodes: 0, edges: 0 }) || !Array.isArray(value.nodes) || !Array.isArray(value.edges))
    return graphError("Invalid texture graph.");
  if (value.nodes.length > GRAPH_LIMITS.nodes || value.edges.length > GRAPH_LIMITS.edges)
    return graphError("Texture graph exceeds 48 nodes or 96 connections.");
  const nodes = new Map<string, GraphNode>(), images = new Set<string>();
  let outputs = 0;
  for (const node of value.nodes) {
    validateNode(node, assets);
    if (nodes.has(node.id)) graphError("Texture graph has duplicate node IDs.");
    nodes.set(node.id, node);
    if (node.kind === "output") outputs++;
    if (node.kind === "texture" && node.params.assetId) images.add(node.params.assetId);
  }
  if (outputs !== 1) graphError("A texture graph must have exactly one Output node.");
  let pixels = 0;
  for (const id of images) pixels += assets[id].width * assets[id].height;
  if (images.size > GRAPH_LIMITS.images || pixels > GRAPH_LIMITS.pixels)
    graphError("Use at most four graph images with at most 8,388,608 pixels combined.");
  const inputs = new Set<string>();
  for (const edge of value.edges) {
    if (!object(edge) || !keysMatch(edge, { from: 0, to: 0 }) || !isPortRef(edge.from) || !isPortRef(edge.to))
      return graphError("Invalid texture graph connection.");
    const { from, to } = edge;
    const source = nodes.get(from.node), destination = nodes.get(to.node);
    const output = source && outputPorts(source).find(port => port.name === from.port);
    const input = destination && inputPorts(destination).find(port => port.name === to.port);
    if (!source || !destination || !output || !input) return graphError("A texture graph connection references a missing port.");
    if (!input.types.includes(output.type))
      graphError("Cannot connect " + label(source) + " (" + output.type + ") to " + label(destination) + " (" + [...new Set(input.types)].join(" or ") + ").");
    const key = portKey(edge.to);
    if (inputs.has(key)) graphError("A texture graph input may have only one connection.");
    inputs.add(key);
  }
  graphOrder(value as ProceduralGraph);
}

export function createProceduralGraph(): ProceduralGraph {
  return { nodes: [createGraphNode("output", "output", 398, 94)], edges: [] };
}

export function animatedNoiseGraph(assetId = ""): ProceduralGraph {
  const nodes = [
    createGraphNode("position", "position", 18, 24),
    createGraphNode("time", "time", 18, 153),
    createGraphNode("noise", "noise", 199, 24),
    createGraphNode("gradient", "gradient", 199, 175),
    createGraphNode("multiply", "multiply", 380, 24),
    createGraphNode("output", "output", 561, 24),
  ];
  const edges: GraphEdge[] = [];
  const wire = (node: string, port: string, toNode: string, toPort: string) =>
    edges.push({ from: { node, port }, to: { node: toNode, port: toPort } });
  wire("position", "position", "noise", "position");
  wire("time", "value", "noise", "time");
  wire("noise", "value", "multiply", "a");
  wire("gradient", "color", "multiply", "b");
  wire("multiply", "value", "output", "color");
  if (assetId) {
    const texture = createGraphNode("texture", "texture", 380, 175);
    if (texture.kind === "texture") texture.params.assetId = assetId;
    nodes.push(texture);
    wire("texture", "alpha", "output", "alpha");
  }
  return { nodes, edges };
}

export function connectGraphPorts(graph: ProceduralGraph, from: PortRef, to: PortRef): ProceduralGraph {
  const existing = graph.edges.find(edge => portKey(edge.to) === portKey(to));
  if (existing && portKey(existing.from) === portKey(from)) return graph;
  return { ...graph, edges: [...graph.edges.filter(edge => edge !== existing), { from, to }] };
}
export function disconnectGraphPort(graph: ProceduralGraph, to: PortRef): ProceduralGraph {
  const edges = graph.edges.filter(edge => portKey(edge.to) !== portKey(to));
  return edges.length === graph.edges.length ? graph : { ...graph, edges };
}
export function deleteGraphNode(graph: ProceduralGraph, id: string): ProceduralGraph {
  const node = graph.nodes.find(item => item.id === id);
  if (!node) return graph;
  if (node.kind === "output") return graphError("The graph requires its Output node.");
  return { nodes: graph.nodes.filter(item => item !== node), edges: graph.edges.filter(edge => edge.from.node !== id && edge.to.node !== id) };
}
export function editGraphNode(graph: ProceduralGraph, id: string, edit: (node: GraphNode) => GraphNode): ProceduralGraph {
  const node = graph.nodes.find(item => item.id === id);
  if (!node) return graph;
  const updated = edit(node);
  return updated === node ? graph : { ...graph, nodes: graph.nodes.map(item => item === node ? updated : item) };
}
export function commitGraphCommand(store: SceneStore, name: string, edit: (graph: ProceduralGraph | undefined) => ProceduralGraph | undefined) {
  const before = store.getState().document;
  const graph = edit(before.proceduralGraph);
  if (graph === before.proceduralGraph) return;
  if (graph) validateProceduralGraph(graph, before.textureAssets);
  const next: SceneDocument = { ...before, proceduralGraph: graph };
  validateSceneSplatAppearance(next);
  validateParticleEmitters(next);
  store.setState({ document: next, editLabel: name });
}
export function graphTextureReferences(graph: ProceduralGraph | undefined, id: string) {
  return graph?.nodes.filter(node => node.kind === "texture" && node.params.assetId === id) ?? [];
}
export function relinkGraphTexture(graph: ProceduralGraph | undefined, from: string, to: string, assets: TextureLibrary) {
  if (!graph || !graphTextureReferences(graph, from).length) return graph;
  const next: ProceduralGraph = {
    ...graph,
    nodes: graph.nodes.map(node => node.kind === "texture" && node.params.assetId === from
      ? { ...node, params: { assetId: to } } : node),
  };
  validateProceduralGraph(next, assets);
  return next;
}
