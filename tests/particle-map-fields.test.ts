import { describe, expect, it, vi } from "vitest";
import { Matrix4, Vector3 } from "three";
import { Particle } from "three-nebula";
import {
  applyParticleGraphAppearance, createParticleGraphSampler, defaultParticleGraphAppearance,
  defaultParticleGraphField, ParticleGraphForce, type ParticleGraphSample,
} from "../src/particle-map-fields.ts";
import { createParticleEmitter, findParticleShape, updateParticleEmitter, type ParticleEmitterPatch, type ParticleShapeNode } from "../src/particle-emitter.ts";
import { ParticleCheckpointCache } from "../src/particle-checkpoints.ts";
import { createParticleSimulation } from "../src/particle-simulation.ts";
import { compileGraph } from "../src/procedural-graph-runtime.ts";
import { commitGraphCommand, createGraphNode, type GraphEdge, type GraphNode, type ProceduralGraph } from "../src/procedural-graph.ts";
import { decodeProject, encodeProject, type EditorSnapshot } from "../src/project-archive.ts";
import { createSceneStore } from "../src/scene-store.ts";
import type { SceneDocument } from "../src/scene-document.ts";
import type { TextureAsset } from "../src/texture-assets.ts";

describe("particle graph consumer", () => {
  it("passes world or emitter-space positions, age, lifetime and absolute frame separately", () => {
    const world = new Matrix4().makeRotationZ(Math.PI / 2).scale(new Vector3(3, 2, 1)).setPosition(4, 5, 6);
    const worldPoint = new Vector3(1, 2, 3).applyMatrix4(world);
    let observed: ParticleGraphSample | undefined;
    const emitter = createParticleGraphSampler(point => { observed = structuredClone(point); }, "emitter", 48);
    emitter.setFrame(32.25, world);
    emitter.sample(worldPoint, .25, 2);
    expect(observed).toMatchObject({ frame: 32.25, fps: 48, particleAge: .25, particleLifetime: 2, uv: [.125, .5] });
    expect(observed!.position[0]).toBeCloseTo(1, 12);
    expect(observed!.position[1]).toBeCloseTo(2, 12);
    expect(observed!.position[2]).toBeCloseTo(3, 12);
    const scene = createParticleGraphSampler(point => { observed = structuredClone(point); }, "world", 24);
    scene.setFrame(-10);
    scene.sample(worldPoint, 1, 2);
    expect(observed).toMatchObject({ frame: -10, fps: 24, position: worldPoint.toArray(), uv: [.5, .5] });
  });

  it("preserves field direction and bounds acceleration after emitter-space conversion", () => {
    const emitter = createParticleGraphSampler(() => {}, "emitter", 24);
    emitter.setFrame(12, new Matrix4().makeRotationZ(Math.PI / 2).scale(new Vector3(20, 4, 1)).setPosition(8, 0, 0));
    const acceleration = emitter.force([10, 0, 0], -100, new Vector3());
    expect(acceleration.x).toBeCloseTo(0, 12);
    expect(acceleration.y).toBeCloseTo(-100, 12);
    expect(acceleration.z).toBeCloseTo(0, 12);
    expect(emitter.force([.25, 0, 0], 4, new Vector3()).length()).toBeCloseTo(1, 12);
    expect(() => emitter.setFrame(1, new Matrix4().makeScale(0, 1, 1))).toThrow(/invertible/);
    expect(() => emitter.force([NaN, 0, 0], 1, new Vector3())).toThrow(/non-finite/);
  });

  it("samples the Nebula pre-integration position and pre-step age", () => {
    const particle = new Particle();
    particle.position.set(3, 2, 1);
    particle.age = .125;
    particle.life = 2;
    const force = new ParticleGraphForce({ ...defaultParticleGraphField(), strength: 8 }, (point, values) => {
      expect(point).toMatchObject({ frame: 16, position: [3, 2, 1], particleAge: .0625, particleLifetime: 2 });
      values.field = [.5, 0, -.25];
    }, 24);
    force.setFrame(16);
    force.mutate(particle, .0625);
    expect(particle.acceleration.x).toBe(4);
    expect(particle.acceleration.z).toBe(-2);
  });

  it("blends selected linear display channels and clamps size and opacity", () => {
    const color = { r: .1, g: .2, b: .3 }, settings = { ...defaultParticleGraphAppearance(), blend: .5 };
    const sample = { rgba: [1, .4, -.2, .25], size: 1000, field: [0, 0, 0] } as Parameters<typeof applyParticleGraphAppearance>[1];
    const result = applyParticleGraphAppearance(settings, sample, color, .8, .1);
    expect([color.r, color.g, color.b]).toEqual([.55, .30000000000000004, .15]);
    expect(result.opacity).toBe(.5);
    expect(result.diameter).toBe(.45);
    expect(() => applyParticleGraphAppearance(settings, { ...sample, size: NaN }, color, 1, 1)).toThrow(/non-finite/);
  });
});


function graph(nodes: GraphNode[], edges: [string, string, string, string][]): ProceduralGraph {
  return { nodes: [...nodes, createGraphNode("output", "out", 600, 0)], edges: edges.map(([node, port, target, input]): GraphEdge => ({
    from: { node, port }, to: { node: target, port: input },
  })) };
}

function scalar(id: string, a: number, kind: "add" | "multiply" = "add", b = 0): GraphNode {
  return { id, kind, x: 10, y: 20, params: { type: "scalar", a, b } };
}

function fieldGraph(animated = false) {
  const vector = createGraphNode("vector", "v", 100, 0);
  if (!animated) return graph([vector, scalar("constant", 1)], [["constant", "value", "v", "x"], ["v", "vector", "out", "field"]]);
  return graph([vector, scalar("phase", 1, "multiply", .6), scalar("shift", 0, "add", -.5),
    createGraphNode("time", "t", 0, 0), createGraphNode("noise", "noise", 30, 0),
    createGraphNode("position", "position", 40, 0)], [
    ["t", "value", "phase", "a"], ["phase", "value", "noise", "time"], ["position", "position", "noise", "position"],
    ["noise", "value", "shift", "a"], ["shift", "value", "v", "x"], ["v", "vector", "out", "field"],
  ]);
}

function fixture(proceduralGraph: ProceduralGraph, patch: ParticleEmitterPatch, rotation: [number, number, number] = [0, 0, 0]) {
  const store = createSceneStore();
  store.setState({ document: { ...store.getState().document, proceduralGraph } });
  const emitter = createParticleEmitter(store, "directional", { rotation });
  const id = findParticleShape(store.getState().document, emitter)!.id;
  updateParticleEmitter(store, id, {
    rate: 1, lifetime: 4, speed: 0, speedRandom: 0, acceleration: [0, 0, 0], drag: 0, sizes: [.1, .1], opacities: [1, 1],
    ...patch,
  });
  const doc = () => store.getState().document;
  const shape = (scene: SceneDocument = doc()) => scene.nodes[id] as ParticleShapeNode;
  return { store, doc, shape, id };
}

describe("authored particle graph effects", () => {
  it("isolates field-only images from existing RGBA consumers and samples typed output branches", () => {
    const image = { id: "image", width: 1, height: 1, role: "data" } as TextureAsset;
    const texture = createGraphNode("texture", "texture", 20, 0);
    if (texture.kind === "texture") texture.params.assetId = image.id;
    const program = compileGraph(graph([texture, scalar("size", .5), createGraphNode("vector", "v", 30, 0)], [
      ["texture", "alpha", "v", "x"], ["v", "vector", "out", "field"], ["size", "value", "out", "size"],
    ]), { [image.id]: image });
    const point: ParticleGraphSample = { uv: [0, 0], position: [0, 0, 0], frame: 0, fps: 24, particleAge: 0, particleLifetime: 4 };
    const sample = { rgba: [0, 0, 0, 0], size: 0, field: [0, 0, 0] } as Parameters<typeof program.sampleField>[1];
    expect(program.images).toEqual([]);
    expect(program.fieldImages).toEqual([image]);
    expect(program.sample(point)).toEqual([0, 0, 0, 1]);
    program.sampleAppearance(point, sample);
    expect(sample.size).toBe(.5);
    const pixels = new Map([[image.id, { width: 1, height: 1, rgba: new Uint8Array([0, 0, 0, 128]) }]]);
    program.sampleField(point, sample, pixels);
    expect(sample.field).toEqual([128 / 255, 0, 0]);
  });

  it("uses exact requested time for color without advancing completed position or particle age", async () => {
    const appearance = graph([createGraphNode("time", "time", 0, 0), createGraphNode("particle", "particle", 50, 0)], [
      ["time", "value", "out", "color"], ["particle", "age", "out", "alpha"], ["particle", "lifetime", "out", "size"],
    ]);
    const f = fixture(appearance, { appearanceMap: { ...defaultParticleGraphAppearance(), enabled: true } });
    const simulation = createParticleSimulation(f.doc(), f.shape());
    try {
      const a = await simulation.snapshotAt(12), b = await simulation.snapshotAt(12.1);
      expect(a.positions).toEqual(b.positions);
      expect(a.simulationFrame).toBe(b.simulationFrame);
      expect(a.opacities).toEqual(b.opacities);
      expect(a.opacities[0]).toBeCloseTo(.5);
      expect(a.sizes[0]).toBeCloseTo(.4);
      expect(a.colors[0]).toBeCloseTo(.5);
      expect(b.colors[0]).toBeGreaterThan(a.colors[0]);
      expect(await simulation.snapshotAt(12)).toEqual(a);
    } finally { simulation.dispose(); }
  });

  it("integrates acceleration in the selected space and keeps zero strength byte-identical", async () => {
    const f = fixture(fieldGraph(), { forceField: { enabled: true, space: "emitter", strength: 6 } }, [0, 0, 90]);
    const local = createParticleSimulation(f.doc(), f.shape());
    const world = createParticleSimulation(f.doc(), { ...f.shape(), forceField: { enabled: true, space: "world", strength: 6 } });
    const zero = createParticleSimulation(f.doc(), { ...f.shape(), forceField: { enabled: true, space: "emitter", strength: 0 } });
    const plain = createParticleSimulation(f.doc(), { ...f.shape(), forceField: undefined });
    try {
      const expected = 6 * 120 * 119 / (2 * 120 * 120);
      const a = await local.snapshotAt(24), b = await world.snapshotAt(24);
      expect(a.positions[0]).toBeCloseTo(0, 12);
      expect(a.positions[1]).toBeCloseTo(expected, 5);
      expect(b.positions[0]).toBeCloseTo(expected, 5);
      expect(b.positions[1]).toBe(0);
      expect(await zero.snapshotAt(24)).toEqual(await plain.snapshotAt(24));
    } finally { [local, world, zero, plain].forEach(simulation => simulation.dispose()); }
  });

  it("matches checkpoint seeks to cold historical field replay and offline archive reopen", async () => {
    const f = fixture(fieldGraph(true), { forceField: { enabled: true, space: "emitter", strength: 9 }, rate: 40, lifetime: 1.8 });
    const editor: EditorSnapshot = { time: 0, camera: { position: [0, 2, 6], target: [0, 0, 0], fov: 45, near: .01, far: 100 } };
    const reopened = await decodeProject(await encodeProject(f.doc(), new Map(), editor));
    expect(reopened.scene).toEqual(f.doc());
    const warm = createParticleSimulation(f.doc(), f.shape(), undefined, undefined, new ParticleCheckpointCache());
    try {
      await warm.snapshotAt(102);
      for (const frame of [61.2, 37.8, 84.8, 28.2]) {
        const cold = createParticleSimulation(reopened.scene, f.shape(reopened.scene), undefined, undefined, null);
        try { expect(await warm.snapshotAt(frame)).toEqual(await cold.snapshotAt(frame)); }
        finally { cold.dispose(); }
      }
    } finally { warm.dispose(); }
  });

  it("discards a superseded partial force batch before advancing the shared engine", async () => {
    const f = fixture(fieldGraph(true), { forceField: { enabled: true, space: "world", strength: 9 }, rate: 120, lifetime: 1.8 });
    const warm = createParticleSimulation(f.doc(), f.shape(), undefined, undefined, new ParticleCheckpointCache());
    const cold = createParticleSimulation(f.doc(), f.shape(), undefined, undefined, null);
    const prepare = ParticleGraphForce.prototype.prepare;
    let reachedBatch!: () => void, releaseBatch!: () => void;
    const paused = new Promise<void>(resolve => { reachedBatch = resolve; });
    const release = new Promise<void>(resolve => { releaseBatch = resolve; });
    try {
      await warm.snapshotAt(80);
      const spy = vi.spyOn(ParticleGraphForce.prototype, "prepare").mockImplementationOnce(function (this: ParticleGraphForce, particles, dt, yieldIfNeeded, check) {
        return prepare.call(this, particles, dt, async () => {
          reachedBatch();
          await release;
          await yieldIfNeeded();
        }, check);
      });
      try {
        const superseded = warm.snapshotAt(80.8);
        const rejection = expect(superseded).rejects.toMatchObject({ name: "AbortError" });
        await paused;
        const latest = warm.snapshotAt(84.4);
        releaseBatch();
        await rejection;
        expect(await latest).toEqual(await cold.snapshotAt(84.4));
      } finally { spy.mockRestore(); }
    } finally {
      releaseBatch();
      warm.dispose();
      cold.dispose();
    }
  });

  it("validates strength, missing graph and field capacity before changing history", () => {
    const setting = { enabled: true, space: "world", strength: 4 } as const;
    const f = fixture(fieldGraph(), { forceField: setting, lifetime: 3 });
    const before = f.doc(), undoCount = f.store.temporal.getState().pastStates.length;
    expect(() => updateParticleEmitter(f.store, f.id, { forceField: { ...setting, strength: NaN } })).toThrow(/strength/);
    expect(() => updateParticleEmitter(f.store, f.id, { rate: 800 })).toThrow(/2,000/);
    expect(() => commitGraphCommand(f.store, "Remove active field graph", () => undefined)).toThrow(/Texture Graph/);
    expect(f.doc()).toBe(before);
    expect(f.store.temporal.getState().pastStates.length).toBe(undoCount);
    updateParticleEmitter(f.store, f.id, { forceField: { ...setting, strength: 7 } });
    expect(f.store.temporal.getState().pastStates.length).toBe(undoCount + 1);
    f.store.temporal.getState().undo();
    expect(f.doc()).toBe(before);
    f.store.temporal.getState().redo();
    expect(f.shape().forceField!.strength).toBe(7);
  });
});
