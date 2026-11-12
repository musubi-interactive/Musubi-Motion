import { Emitter, System } from "three-nebula";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAnimation, type AnimationTrack } from "../src/animation.ts";
import { createMeshPrimitive, findMeshShape } from "../src/mesh-modeling.ts";
import { ParticleCheckpointCache, type ParticleCheckpoint } from "../src/particle-checkpoints.ts";
import { createParticleEmitter, findParticleShape, updateParticleEmitter } from "../src/particle-emitter.ts";
import { defaultParticleEmissionMap } from "../src/particle-map-emission.ts";
import { createParticlePoseSampler } from "../src/particle-pose-sampler.ts";
import { createParticleSimulation, type ParticleSimulation } from "../src/particle-simulation.ts";
import { animatedNoiseGraph } from "../src/procedural-graph.ts";
import { createSceneStore } from "../src/scene-store.ts";

const active: ParticleSimulation[] = [];
afterEach(() => {
  active.splice(0).forEach(simulation => simulation.dispose());
  vi.restoreAllMocks();
});

function animatedSurface(mapped: boolean) {
  const store = createSceneStore();
  const parent = createMeshPrimitive(store, "cube", { size: 2 });
  const mesh = findMeshShape(store.getState().document, parent)!;
  const emitter = createParticleEmitter(store, "surface", { surfaceId: mesh.id });
  const shapeId = findParticleShape(store.getState().document, emitter)!.id;
  store.setState({ document: { ...store.getState().document, proceduralGraph: animatedNoiseGraph() } });
  updateParticleEmitter(store, shapeId, {
    startFrame: -12, endFrame: 108, rate: 240, lifetime: 1.3, seed: 795,
    speedRandom: 1.2, drag: .21, acceleration: [.5, -1.7, -.1],
    colors: ["#123456", "#f9e3d7"], sizes: [0, .2], opacities: [.91, .2],
    attraction: { strength: 1.1, radius: 8, position: [1, 1, 2] },
    turbulence: { strength: .14, scale: .8 },
    emissionMap: { ...defaultParticleEmissionMap(), enabled: mapped, source: "graph", bounds: [-1, -1, 1, 1] },
  });
  function track(channel: AnimationTrack["channel"], from: number, to: number): AnimationTrack {
    return {
      id: channel.replace(".", "-"), targetId: parent, channel, keys: [
        { id: "first", time: -12, value: from, interpolation: "linear", tangentMode: "auto" },
        { id: "last", time: 108, value: to, interpolation: "linear", tangentMode: "auto" },
      ],
    };
  }
  const doc = {
    ...store.getState().document,
    animation: { ...defaultAnimation(), tracks: [track("scale.x", 1, 2), track("position.z", -1, 2.5)] },
  };
  const shape = findParticleShape(doc, emitter)!;
  function makeSimulation(cache: ParticleCheckpointCache | null) {
    const sampler = createParticlePoseSampler(doc);
    const worldAt = vi.spyOn(sampler, "worldAt");
    const simulation = createParticleSimulation(doc, shape, sampler, undefined, cache);
    active.push(simulation);
    return { simulation, worldAt };
  }
  return { doc, makeSimulation };
}

function observeParticles() {
  const addEmitter = System.prototype.addEmitter;
  let activeEmitter: Emitter;
  vi.spyOn(System.prototype, "addEmitter").mockImplementation(function (this: System, emitter) {
    activeEmitter = emitter;
    return addEmitter.call(this, emitter);
  });
  return () => activeEmitter.particles.map(particle => ({
    id: particle.id, age: particle.age, spawnIndex: particle.spawnIndex,
    position: [particle.position.x, particle.position.y, particle.position.z],
    velocity: [particle.velocity.x, particle.velocity.y, particle.velocity.z],
    rng: particle.rng(),
  }));
}

describe("bounded particle replay checkpoints", () => {
  it.each([true, false])("matches independent replay with mapped emission %s", async mapped => {
    const { doc, makeSimulation } = animatedSurface(mapped);
    const capture = observeParticles();
    const before = JSON.stringify(doc), cache = new ParticleCheckpointCache();
    const warm = makeSimulation(cache);
    await warm.simulation.snapshotAt(96);
    warm.worldAt.mockClear();
    const atBoundary = await warm.simulation.snapshotAt(60);
    expect(atBoundary.count).toBeGreaterThan(10);
    expect(warm.worldAt).not.toHaveBeenCalled();
    const identity = capture();
    expect(atBoundary).toEqual(await makeSimulation(null).simulation.snapshotAt(60));
    expect(capture()).toEqual(identity);

    for (const frame of [36.4, 61.2, 12.8, 84.6, 48.4]) {
      warm.worldAt.mockClear();
      const actual = await warm.simulation.snapshotAt(frame);
      const observed = capture();
      const cold = makeSimulation(null);
      expect(actual).toEqual(await cold.simulation.snapshotAt(frame));
      expect(capture()).toEqual(observed);
      expect(warm.worldAt.mock.calls.length).toBeLessThan(cold.worldAt.mock.calls.length);
      cold.simulation.dispose();
    }
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("evicts by bytes and insertion order, caps small entries, and isolates owners", () => {
    const cache = new ParticleCheckpointCache(32, 2), first = Symbol(), second = Symbol();
    const checkpoint = (step: number, count = 1): ParticleCheckpoint => ({
      step, particles: new Float64Array(count), emitter: new Float64Array(1),
    });
    const a = checkpoint(120), b = checkpoint(240), c = checkpoint(360);
    cache.add(first, a); cache.add(second, b);
    expect(cache.find(first, 119)).toBeUndefined();
    expect(cache.find(first, 240)).toBe(a);
    cache.add(first, checkpoint(480, 20));
    expect(cache.find(first, 240)).toBe(a);
    cache.add(first, c);
    expect(cache.find(first, 240)).toBeUndefined();
    expect(cache.find(second, 360)).toBe(b);
    expect(cache.find(first, 360)).toBe(c);
    cache.clear(first);
    expect(cache.find(first, 360)).toBeUndefined();
    expect(cache.find(second, 360)).toBe(b);

    const tinyEntries = new ParticleCheckpointCache(1024, 1);
    tinyEntries.add(first, a); tinyEntries.add(second, b);
    expect(tinyEntries.find(first, 240)).toBeUndefined();
    expect(tinyEntries.find(second, 240)).toBe(b);
  });

  it("supersedes in-progress replay and drops retained checkpoints on disposal", async () => {
    const { makeSimulation } = animatedSurface(true), cache = new ParticleCheckpointCache();
    const add = vi.spyOn(cache, "add");
    const { simulation } = makeSimulation(cache);
    await simulation.snapshotAt(72);
    const owner = add.mock.calls[0][0];
    expect(cache.find(owner, 1000)).toBeDefined();
    const stale = simulation.snapshotAt(98);
    const latest = simulation.snapshotAt(57.4);
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    expect(await latest).toEqual(await makeSimulation(null).simulation.snapshotAt(57.4));
    simulation.dispose();
    expect(cache.find(owner, 1000)).toBeUndefined();
    await expect(simulation.snapshotAt(57.4)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a partial warm restore and replays the latest seek from a clean engine", async () => {
    const store = createSceneStore(), emitter = createParticleEmitter(store, "omni");
    const shapeId = findParticleShape(store.getState().document, emitter)!.id;
    updateParticleEmitter(store, shapeId, { rate: 360, lifetime: 2 });
    const doc = store.getState().document, shape = findParticleShape(doc, emitter)!;
    const simulation = createParticleSimulation(doc, shape, undefined, undefined, new ParticleCheckpointCache());
    const uncached = createParticleSimulation(doc, shape, undefined, undefined, null);
    active.push(simulation, uncached);
    await simulation.snapshotAt(72);
    const setup = vi.spyOn(Emitter.prototype, "setupParticle");
    const stale = simulation.snapshotAt(24);
    expect(setup.mock.calls.length).toBeGreaterThan(0);
    expect(setup.mock.calls.length).toBeLessThan(360);
    const abandonedEmitter = setup.mock.contexts[0] as Emitter;
    const latest = simulation.snapshotAt(12.4);
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    expect(abandonedEmitter.particles).toHaveLength(0);
    expect(await latest).toEqual(await uncached.snapshotAt(12.4));
  });
});
