import { Emitter, System } from "three-nebula";
import { Points } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAnimation } from "../src/animation.ts";
import { createMeshPrimitive, findMeshShape } from "../src/mesh-modeling.ts";
import { ParticleCheckpointCache, sharedParticleCheckpoints, type ParticleCheckpoint } from "../src/particle-checkpoints.ts";
import { createParticleEmitter, findParticleShape, updateParticleEmitter } from "../src/particle-emitter.ts";
import { defaultParticleEmissionMap } from "../src/particle-map-emission.ts";
import { createParticlePoseSampler } from "../src/particle-pose-sampler.ts";
import { createParticleRuntime } from "../src/particle-runtime.ts";
import { createParticleSimulation } from "../src/particle-simulation.ts";
import { animatedNoiseGraph } from "../src/procedural-graph.ts";
import { createSceneStore } from "../src/scene-store.ts";

const cleanup: { dispose(): void }[] = [];
afterEach(() => {
  cleanup.splice(0).forEach(item => item.dispose());
  vi.restoreAllMocks();
});

function fixture(rate = 1500, lifetime = .7) {
  const store = createSceneStore();
  const parent = createMeshPrimitive(store, "cube");
  const mesh = findMeshShape(store.getState().document, parent)!;
  const emitter = createParticleEmitter(store, "surface", { surfaceId: mesh.id });
  const shapeId = findParticleShape(store.getState().document, emitter)!.id;
  store.setState({ document: {
    ...store.getState().document,
    proceduralGraph: animatedNoiseGraph(),
    animation: { ...defaultAnimation(), end: 500 },
  } });
  updateParticleEmitter(store, shapeId, {
    endFrame: 480, rate, lifetime, seed: 418,
    emissionMap: { ...defaultParticleEmissionMap(), enabled: true, source: "graph", bounds: [-1, -1, 1, 1] },
  });
  const doc = store.getState().document;
  return { doc, shape: findParticleShape(doc, emitter)!, sampler: createParticlePoseSampler(doc) };
}

const alive = () => new AbortController().signal;
const noop = () => {};
const range = { start: 19, end: 100 };

describe("particle replay prewarm", () => {
  it("publishes only range checkpoints and matches fresh display buffers, ages and identities at four distinct targets", async () => {
    const { doc, shape, sampler } = fixture();
    const original = JSON.stringify(doc), cache = new ParticleCheckpointCache();
    const warm = createParticleSimulation(doc, shape, sampler, undefined, cache);
    cleanup.push(warm);
    const publish = vi.spyOn(cache, "publishPrewarm"), add = vi.spyOn(cache, "add");
    const addEmitter = System.prototype.addEmitter;
    let active!: Emitter;
    vi.spyOn(System.prototype, "addEmitter").mockImplementation(function (this: System, emitter) {
      active = emitter;
      return addEmitter.call(this, emitter);
    });
    const particles = () => active.particles.map(({ id, spawnIndex, age, position }) =>
      [id, spawnIndex, age, position.x, position.y, position.z]);

    expect(await warm.prewarm(range, alive(), noop)).toBe(6);
    expect(publish).toHaveBeenCalledOnce();
    expect(add.mock.calls.map(([, point]) => point.step)).toEqual([95, 120, 240, 360, 480, 500]);
    for (const frame of [99.4, 43.2, 70.6, 19.8]) {
      const actual = await warm.snapshotAt(frame);
      const state = particles();
      expect(actual.count).toBeGreaterThan(0);
      const fresh = createParticleSimulation(doc, shape, undefined, undefined, null);
      cleanup.push(fresh);
      expect(actual).toEqual(await fresh.snapshotAt(frame));
      expect(particles()).toEqual(state);
    }
    expect(JSON.stringify(doc)).toBe(original);
  });

  it("rejects invalid ranges and expensive work before running the sampler or touching checkpoints", async () => {
    const { doc, shape, sampler } = fixture(5200, 2);
    const world = vi.spyOn(sampler, "worldAt"), cache = new ParticleCheckpointCache();
    const simulation = createParticleSimulation(doc, shape, sampler, undefined, cache);
    cleanup.push(simulation);
    const publish = vi.spyOn(cache, "publishPrewarm");
    for (const invalid of [{ start: NaN, end: 5 }, { start: 20.5, end: 22 }, { start: 3, end: 2 }, { start: -1, end: 24 }, { start: 10, end: 501 }]) {
      await expect(simulation.prewarm(invalid, alive(), noop)).rejects.toThrow("playback range");
    }
    await expect(simulation.prewarm({ start: 400, end: 401 }, alive(), noop)).rejects.toThrow("work limit");
    await expect(simulation.prewarm({ start: 1, end: 336 }, alive(), noop)).rejects.toThrow("staging limit");
    expect(world).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("discards already staged checkpoints on cancellation, preserves existing entries and supports retry", async () => {
    const { doc, shape, sampler } = fixture();
    const clock = vi.spyOn(performance, "now");
    const time = performance.now();
    const controller = new AbortController();
    const world = sampler.worldAt.bind(sampler);
    const cache = new ParticleCheckpointCache(), other = Symbol();
    const otherPoint: ParticleCheckpoint = { step: 5, particles: new Float64Array(1), emitter: new Float64Array(1) };
    cache.add(other, otherPoint);
    const add = vi.spyOn(cache, "add");
    const simulation = createParticleSimulation(doc, shape, {
      worldAt(frame) {
        if (frame > 50 && !controller.signal.aborted) {
          clock.mockReturnValue(time + 1000);
          controller.abort();
        }
        return world(frame);
      },
    }, undefined, cache);
    cleanup.push(simulation);
    await expect(simulation.prewarm(range, controller.signal, noop)).rejects.toMatchObject({ name: "AbortError" });
    clock.mockRestore();
    expect(add).not.toHaveBeenCalled();
    expect(cache.find(other, 5)).toBe(otherPoint);
    expect(await simulation.prewarm(range, alive(), noop)).toBe(6);
  });

  it("aborts a timed-out prewarm without publishing and allows a shorter retry", async () => {
    const { doc, shape, sampler } = fixture();
    const time = performance.now(), clock = vi.spyOn(performance, "now");
    const world = sampler.worldAt.bind(sampler), cache = new ParticleCheckpointCache();
    const simulation = createParticleSimulation(doc, shape, {
      worldAt(frame) {
        if (frame > 50) clock.mockReturnValue(time + 30_000);
        return world(frame);
      },
    }, undefined, cache);
    cleanup.push(simulation);
    const publish = vi.spyOn(cache, "publishPrewarm");
    await expect(simulation.prewarm(range, alive(), noop)).rejects.toThrow("20-second time limit");
    expect(publish).not.toHaveBeenCalled();
    clock.mockRestore();
    expect(await simulation.prewarm({ start: 24, end: 24 }, alive(), noop)).toBe(1);
  });

  it.each(["cancel", "seek", "revision", "suspend", "dispose"] as const)("fences a %s during runtime prewarm", async cause => {
    const { doc, shape, sampler } = fixture();
    const runtime = createParticleRuntime(shape);
    cleanup.push(runtime);
    const publish = vi.spyOn(sharedParticleCheckpoints, "publishPrewarm"), changed = vi.fn();
    runtime.request(doc, shape, 8, sampler, noop);
    await vi.waitFor(() => expect(runtime.status.pending).toBe(false));
    const points = runtime.mesh.children.find(child => child instanceof Points) as Points;
    const count = points.geometry.drawRange.count;
    expect(count).toBeGreaterThan(0);
    const display = points.geometry.getAttribute("position").array.slice(0, count * 3);
    const cache = runtime.status.replayCache;
    cache.start(range, changed);
    expect(cache.state.kind).toBe("running");

    if (cause === "cancel") cache.cancel();
    if (cause === "seek") runtime.request(doc, shape, 9, sampler, noop);
    if (cause === "revision") {
      const revised = { ...doc };
      runtime.request(revised, shape, 8, createParticlePoseSampler(revised), noop);
    }
    if (cause === "suspend") runtime.suspend();
    if (cause === "dispose") runtime.dispose();
    const callbacks = changed.mock.calls.length;
    expect(cache.state.kind).toBe(cause === "suspend" || cause === "dispose" ? "idle" : "cancelled");
    if (cause !== "suspend" && cause !== "dispose") {
      expect(points.geometry.drawRange.count).toBe(count);
      expect(points.geometry.getAttribute("position").array.slice(0, count * 3)).toEqual(display);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(publish).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(callbacks);
    if (cause === "seek" || cause === "revision") await vi.waitFor(() => expect(runtime.status.pending).toBe(false));
  });

  it("shares the byte and entry budgets and evicts by insertion order after a successful range", () => {
    const create = (step: number): ParticleCheckpoint => ({ step, particles: new Float64Array(1), emitter: new Float64Array(1) });
    for (const cache of [new ParticleCheckpointCache(48, 128), new ParticleCheckpointCache(1024, 3)]) {
      const first = Symbol(), second = Symbol();
      const evicted = create(12), retained = create(20), restored = create(30), added = create(40);
      cache.add(second, evicted); cache.add(first, restored); cache.add(second, retained);
      expect(cache.find(second, 12)).toBe(evicted);
      expect(cache.publishPrewarm(first, [restored, added])).toBe(2);
      expect(cache.find(second, 12)).toBeUndefined();
      expect(cache.find(second, 20)).toBe(retained);
      expect(cache.find(first, 30)).toBe(restored);
      expect(cache.find(first, 40)).toBe(added);
      cache.add(second, create(50));
      expect(cache.find(second, 20)).toBeUndefined();
      expect(cache.find(first, 40)).toBe(added);
    }
  });
});
