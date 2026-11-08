import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createMeshPrimitive, findMeshShape } from "../src/mesh-modeling.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { createParticleEmitter, findParticleShape, updateParticleEmitter } from "../src/particle-emitter.ts";
import { createParticleSimulation, type ParticleSimulation } from "../src/particle-simulation.ts";
import { defaultParticleEmissionMap, particleMapDensity, particleMapUV } from "../src/particle-map-emission.ts";
import { animatedNoiseGraph, commitGraphCommand, createGraphNode } from "../src/procedural-graph.ts";
import { prepareTexture, relinkTexture, removeTexture } from "../src/texture-assets.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { defaultAnimation } from "../src/animation.ts";
import type { SceneDocument } from "../src/scene-document.ts";

const simulations: ParticleSimulation[] = [];
afterEach(() => simulations.splice(0).forEach(s => s.dispose()));
function fixture() {
  const store = createSceneStore(), id = createMeshPrimitive(store, "plane", { size: 2 }), mesh = findMeshShape(store.getState().document, id)!;
  const emitter = createParticleEmitter(store, "surface", { surfaceId: mesh.id }), shapeId = findParticleShape(store.getState().document, emitter)!.id;
  updateParticleEmitter(store, shapeId, { rate: 500, lifetime: 3, endFrame: 120, speed: 0, speedRandom: 0, acceleration: [0, 0, 0], drag: 0 });
  const output = createGraphNode("output", "out", 0, 0), gradient = createGraphNode("gradient", "gradient", 0, 0);
  if (gradient.kind === "gradient") gradient.params = { start: [0, 0, 0], end: [1, 1, 1] };
  store.setState({ document: { ...store.getState().document, proceduralGraph: { nodes: [gradient, output], edges: [{ from: { node: "gradient", port: "color" }, to: { node: "out", port: "color" } }] } } });
  const map = { ...defaultParticleEmissionMap(), enabled: true, source: "graph" as const, bounds: [-1, -1, 1, 1] as [number, number, number, number] };
  updateParticleEmitter(store, shapeId, { emissionMap: map });
  const shape = () => findParticleShape(store.getState().document, emitter)!;
  const sim = (doc = store.getState().document, pixels?: Parameters<typeof createParticleSimulation>[3]) => {
    const result = createParticleSimulation(doc, doc.nodes[shapeId] as ReturnType<typeof shape>, undefined, pixels); simulations.push(result); return result;
  };
  return { store, emitter, shapeId, mesh, map, shape, sim };
}
const camera = { position: [0, 4, 5] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 42, near: .01, far: 1000 };
describe("surface texture emission", () => {
  it("thins spatially, suppresses exact zero and preserves the maximum base rate", async () => {
    const f = fixture(), frame = await f.sim().snapshotAt(24);
    expect(frame.count).toBeGreaterThan(190); expect(frame.count).toBeLessThan(300);
    const meanX = Array.from(frame.positions).filter((_, i) => i % 3 === 0).reduce((a, b) => a + b, 0) / frame.count;
    expect(meanX).toBeGreaterThan(.2);
    updateParticleEmitter(f.store, f.shapeId, { emissionMap: { ...f.map, strength: 0 } });
    expect((await f.sim().snapshotAt(24)).count).toBe(0);
    const doc = f.store.getState().document, out = createGraphNode("output", "out", 0, 0), scalar = createGraphNode("add", "scalar", 0, 0);
    if (scalar.kind === "add") scalar.params = { type: "scalar", a: 1024, b: 1024 };
    f.store.setState({ document: { ...doc, proceduralGraph: { nodes: [scalar, out], edges: [{ from: { node: "scalar", port: "value" }, to: { node: "out", port: "color" } }] } } });
    updateParticleEmitter(f.store, f.shapeId, { emissionMap: f.map });
    expect((await f.sim().snapshotAt(24)).count).toBe(500);
    if (scalar.kind === "add") scalar.params = { type: "scalar", a: -1, b: 0 };
    expect((await f.sim().snapshotAt(24)).count).toBe(0);
  });
  it("samples animated graph at each historical birth, byte-identical across FPS and seek order", async () => {
    const f = fixture(); f.store.setState({ document: { ...f.store.getState().document, proceduralGraph: animatedNoiseGraph() } });
    const doc = f.store.getState().document, serialized = JSON.stringify(doc), sim = f.sim(), expected = await f.sim().snapshotAt(36);
    await sim.snapshotAt(60); await sim.snapshotAt(3); expect(await sim.snapshotAt(36)).toEqual(expected);
    for (const frame of [1, 4, 9, 18, 36]) await sim.snapshotAt(frame);
    expect(await sim.snapshotAt(36)).toEqual(expected); expect(JSON.stringify(doc)).toBe(serialized);
    const doubled = structuredClone(doc); doubled.animation = { ...defaultAnimation(), fps: 48 }; const shape = doubled.nodes[f.shapeId] as ReturnType<typeof f.shape>; shape.endFrame *= 2;
    const other = await f.sim(doubled).snapshotAt(72);
    expect(other.positions).toEqual(expected.positions); expect(other.count).toBe(expected.count);
    const changed = structuredClone(doc); (changed.nodes[f.shapeId] as ReturnType<typeof f.shape>).seed += 1;
    expect((await f.sim(changed).snapshotAt(36)).positions).not.toEqual(expected.positions);
    const staticGraph = structuredClone(doc); staticGraph.proceduralGraph!.edges = staticGraph.proceduralGraph!.edges.filter(e => e.from.node !== "time");
    expect((await f.sim(staticGraph).snapshotAt(36)).positions).not.toEqual(expected.positions);
  });
  it("makes UV and explicit local projection agree, with visible rejection of absent UVs", async () => {
    const f = fixture(), local = await f.sim().snapshotAt(24), doc = f.store.getState().document;
    const uvs = Object.fromEntries(f.mesh.vertices.map(v => [v.id, [(v.position[0] + 1) / 2, (v.position[2] + 1) / 2]]));
    f.store.setState({ document: { ...doc, nodes: { ...doc.nodes, [f.mesh.id]: { ...f.mesh, uvs } } } });
    updateParticleEmitter(f.store, f.shapeId, { emissionMap: { ...f.map, projection: "uv" } });
    expect((await f.sim().snapshotAt(24)).positions).toEqual(local.positions);
    const bad = structuredClone(f.store.getState().document); delete (bad.nodes[f.mesh.id] as typeof f.mesh).uvs;
    expect(() => f.sim(bad)).toThrow(/UV coordinates/);
    expect(particleMapUV({ ...f.map, projection: "yz" }, [9, -1, 1], [0, 0])).toEqual([0, 1]);
  });
  it("rejects invalid settings atomically and commits one undoable map update", () => {
    const f = fixture(), before = f.store.getState().document, history = f.store.temporal.getState().pastStates.length;
    for (const strength of [-1, 2, NaN, Infinity]) expect(() => updateParticleEmitter(f.store, f.shapeId, { emissionMap: { ...f.map, strength } })).toThrow();
    for (const rate of [-1, 10001, NaN, Infinity]) expect(() => updateParticleEmitter(f.store, f.shapeId, { rate })).toThrow();
    expect(() => updateParticleEmitter(f.store, f.shapeId, { emissionMap: { ...f.map, bounds: [0, 0, 0, 1] } })).toThrow();
    expect(f.store.getState().document).toBe(before); expect(f.store.temporal.getState().pastStates.length).toBe(history);
    updateParticleEmitter(f.store, f.shapeId, { emissionMap: { ...f.map, strength: .3 } });
    expect(f.store.temporal.getState().pastStates.length).toBe(history + 1); f.store.temporal.getState().undo(); expect(f.store.getState().document).toBe(before);
    f.store.temporal.getState().redo(); expect(f.shape().emissionMap!.strength).toBe(.3);
    expect(particleMapDensity(f.map, [-2, -2, -2, 1])).toBe(0); expect(particleMapDensity(f.map, [2, 2, 2, 1])).toBe(1);
    expect(() => particleMapDensity(f.map, [NaN, 0, 0, 1])).toThrow(/non-finite/);
  });
  it("preserves the untextured path exactly when the map is disabled", async () => {
    const f = fixture(); updateParticleEmitter(f.store, f.shapeId, { emissionMap: { ...f.map, enabled: false } });
    const disabled = await f.sim().snapshotAt(24), plain = structuredClone(f.store.getState().document); delete (plain.nodes[f.shapeId] as ReturnType<typeof f.shape>).emissionMap;
    expect(await f.sim(plain).snapshotAt(24)).toEqual(disabled); expect(disabled.count).toBe(500);
  });
  it("samples image alpha with UV orientation, protects disabled refs, relinks and reopens repeatably", async () => {
    const f = fixture(), bytes = await readFile(new URL("../examples/textures/musubi-checker.png", import.meta.url)), thumbnail = "data:image/png;base64," + bytes.toString("base64");
    const a = await prepareTexture(new File([bytes], "mask.png"), "data", async () => ({ alpha: true, thumbnail }));
    const b = { ...a, id: "tex_" + "2".repeat(64), name: "Relink target" };
    f.store.setState({ document: { ...f.store.getState().document, textureAssets: { [a.id]: a, [b.id]: b } } });
    updateParticleEmitter(f.store, f.shapeId, { emissionMap: { ...f.map, source: "image", assetId: a.id, channel: "alpha" } });
    const rgba = new Uint8Array(a.width * a.height * 4);
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) if (y < a.height / 2) rgba[(y * a.width + x) * 4 + 3] = 255;
    const pixels = new Map([[a.id, { width: a.width, height: a.height, rgba }]]), doc = f.store.getState().document;
    const expected = await f.sim(doc, pixels).snapshotAt(24);
    expect(expected.count).toBeGreaterThan(180); for (let i = 2; i < expected.positions.length; i += 3) expect(expected.positions[i]).toBeGreaterThanOrEqual(0);
    expect(() => removeTexture(doc, a.id)).toThrow(/referenced/);
    const disabled = structuredClone(doc); (disabled.nodes[f.shapeId] as ReturnType<typeof f.shape>).emissionMap!.enabled = false;
    expect(() => removeTexture(disabled, a.id)).toThrow(/referenced/);
    const linked = relinkTexture(doc, a.id, b.id); expect((linked.nodes[f.shapeId] as ReturnType<typeof f.shape>).emissionMap!.assetId).toBe(b.id);
    expect(removeTexture(linked, a.id).textureAssets?.[a.id]).toBeUndefined();
    // Only a valid content-addressed image is persisted; b is a ref-only relink fixture.
    const saved = structuredClone(doc); delete saved.textureAssets![b.id];
    const archive = await encodeProject(saved, new Map(), { camera, time: 1 }), opened = await decodeProject(archive);
    expect((await f.sim(opened.scene, pixels).snapshotAt(24)).positions).toEqual(expected.positions);
    const entries = unzipSync(archive), manifest = JSON.parse(strFromU8(entries["scene.json"])); (manifest.scene as SceneDocument).nodes[f.shapeId] = { ...f.shape(), emissionMap: { ...f.map, source: "image", assetId: b.id } };
    entries["scene.json"] = strToU8(JSON.stringify(manifest)); await expect(decodeProject(zipSync(entries))).rejects.toThrow(/missing image/);
  });
  it("cancels a superseded mapped replay and disposes safely", async () => {
    const f = fixture(), sim = f.sim();
    const old = sim.snapshotAt(100), latest = sim.snapshotAt(12);
    await expect(old).rejects.toMatchObject({ name: "AbortError" }); expect((await latest).count).toBeGreaterThan(0);
    sim.dispose(); await expect(sim.snapshotAt(24)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("bounds retained decoded pixels across active emitter instances before authoring", () => {
    const f = fixture(), id = "tex_" + "a".repeat(64), before = f.store.getState().document;
    // Header/byte validation belongs to Texture Assets; this isolates map allocation accounting.
    const asset = { id, width: 2048, height: 4096, name: "Budget", mime: "image/png", dataURI: "", thumbnail: "", byteLength: 0, alpha: false, role: "data" as const };
    f.store.setState({ document: { ...before, textureAssets: { [id]: asset } } });
    updateParticleEmitter(f.store, f.shapeId, { emissionMap: { ...f.map, source: "image", assetId: id } });
    const second = createParticleEmitter(f.store, "surface", { surfaceId: f.mesh.id }), next = findParticleShape(f.store.getState().document, second)!, original = f.store.getState().document;
    expect(() => updateParticleEmitter(f.store, next.id, { emissionMap: { ...f.map, source: "image", assetId: id } })).toThrow(/scene's.*pixel budget/);
    expect(f.store.getState().document).toBe(original);
    updateParticleEmitter(f.store, f.shapeId, { emissionMap: { ...f.map, source: "image", assetId: id, enabled: false } });
    expect(() => updateParticleEmitter(f.store, next.id, { emissionMap: { ...f.map, source: "image", assetId: id } })).not.toThrow();
    updateParticleEmitter(f.store, f.shapeId, { emissionMap: f.map });
    const graphBefore = f.store.getState().document, texture = createGraphNode("texture", "map_image", 0, 0);
    if (texture.kind === "texture") texture.params.assetId = id;
    expect(() => commitGraphCommand(f.store, "Over-budget graph", () => ({ nodes: [texture, createGraphNode("output", "out", 0, 0)], edges: [{ from: { node: "map_image", port: "color" }, to: { node: "out", port: "color" } }] }))).toThrow(/scene's.*pixel budget/);
    expect(f.store.getState().document).toBe(graphBefore);
  });
});
