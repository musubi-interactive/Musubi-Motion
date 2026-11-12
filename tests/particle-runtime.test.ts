import { beforeEach, describe, expect, it, vi } from "vitest";
import { Group, Points } from "three";
import { createParticleRuntime } from "../src/particle-runtime.ts";
import { createParticleSimulation, type ParticleFrame } from "../src/particle-simulation.ts";
import { createParticleEmitter, findParticleShape } from "../src/particle-emitter.ts";
import { createParticlePoseSampler } from "../src/particle-pose-sampler.ts";
import { createSceneStore } from "../src/scene-store.ts";

vi.mock("../src/particle-simulation.ts", () => ({ createParticleSimulation: vi.fn() }));
const factory = vi.mocked(createParticleSimulation);

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function simulation() {
  const jobs: ReturnType<typeof deferred<ParticleFrame>>[] = [];
  return { jobs, snapshotAt: vi.fn((_frame: number) => { const job = deferred<ParticleFrame>(); jobs.push(job); return job.promise; }), dispose: vi.fn() };
}
function frame(x: number, count = 1): ParticleFrame {
  return { count, simulationFrame: x, positions: new Float32Array(Array.from({ length: count }, (_, index) => [x + index, 0, 0]).flat()),
    colors: new Float32Array(count * 3).fill(1), sizes: new Float32Array(count).fill(.1), opacities: new Float32Array(count).fill(1) };
}
async function resolve(job: ReturnType<typeof deferred<ParticleFrame>>, value: ParticleFrame) {
  job.resolve(value); await job.promise; await Promise.resolve();
}
async function reject(job: ReturnType<typeof deferred<ParticleFrame>>, error: Error) {
  job.reject(error); await job.promise.catch(() => {}); await Promise.resolve();
}
function fixture() {
  const store = createSceneStore(), id = createParticleEmitter(store, "omni"), doc = store.getState().document;
  const shape = findParticleShape(doc, id)!, sampler = createParticlePoseSampler(doc), runtime = createParticleRuntime(shape), changed = vi.fn();
  const cloud = runtime.mesh.children.find(child => child instanceof Points) as Points;
  return { doc, shape, sampler, runtime, changed, cloud };
}

beforeEach(() => factory.mockReset());

describe("asynchronous particle runtime", () => {
  it("deduplicates an unchanged document/frame both while pending and after completion", async () => {
    const fake = simulation(); factory.mockReturnValue(fake);
    const { doc, shape, sampler, runtime, changed } = fixture();
    runtime.request(doc, shape, 24, sampler, changed); runtime.request(doc, shape, 24, sampler, changed);
    expect(factory).toHaveBeenCalledTimes(1); expect(fake.snapshotAt).toHaveBeenCalledTimes(1);
    expect(runtime.status).toEqual({ count: 0, pending: true, error: undefined });
    await resolve(fake.jobs[0], frame(24, 2));
    runtime.request(doc, shape, 24, sampler, changed);
    expect(fake.snapshotAt).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1);
    expect(runtime.status).toEqual({ count: 2, pending: false }); runtime.dispose();
  });

  it("ignores an older frame result that arrives after the latest request has completed", async () => {
    const fake = simulation(); factory.mockReturnValue(fake);
    const { doc, shape, sampler, runtime, changed, cloud } = fixture();
    runtime.request(doc, shape, 10, sampler, changed); runtime.request(doc, shape, 40, sampler, changed);
    await resolve(fake.jobs[1], frame(40, 2));
    await resolve(fake.jobs[0], frame(10, 3));
    expect(runtime.status).toEqual({ count: 2, pending: false }); expect(cloud.geometry.drawRange.count).toBe(2);
    expect(cloud.geometry.getAttribute("position").getX(0)).toBe(40); expect(changed).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1); runtime.dispose();
  });

  it("replaces simulation on document revision and ignores errors from the disposed revision", async () => {
    const old = simulation(), latest = simulation(); factory.mockReturnValueOnce(old).mockReturnValueOnce(latest);
    const { doc, shape, sampler, runtime, changed, cloud } = fixture();
    runtime.request(doc, shape, 24, sampler, changed);
    const revised = { ...doc }, nextShape = { ...shape, name: "Revised emitter" };
    runtime.request(revised, nextShape, 24, sampler, changed);
    expect(old.dispose).toHaveBeenCalledTimes(1); expect(factory).toHaveBeenCalledTimes(2);
    await reject(old.jobs[0], new Error("Stale revision failed"));
    expect(runtime.status.pending).toBe(true); expect(runtime.status.error).toBeUndefined(); expect(changed).not.toHaveBeenCalled();
    await resolve(latest.jobs[0], frame(99));
    expect(runtime.mesh.name).toBe("Revised emitter"); expect(cloud.geometry.getAttribute("position").getX(0)).toBe(99);
    expect(runtime.status).toEqual({ count: 1, pending: false }); expect(changed).toHaveBeenCalledTimes(1); runtime.dispose();
  });

  it("keeps constructor failure authoritative over an old pending result and recovers on a valid document", async () => {
    const old = simulation(), recovered = simulation();
    factory.mockReturnValueOnce(old).mockImplementationOnce(() => { throw Error("Historical transform is invalid"); }).mockReturnValueOnce(recovered);
    const { doc, shape, sampler, runtime, changed, cloud } = fixture();
    runtime.request(doc, shape, 24, sampler, changed);
    const broken = { ...doc };
    expect(() => runtime.request(broken, shape, 48, sampler, changed)).not.toThrow();
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.status).toEqual({ count: 0, pending: false, error: "Historical transform is invalid" }); expect(changed).toHaveBeenCalledTimes(1);
    await resolve(old.jobs[0], frame(24, 4));
    expect(cloud.geometry.drawRange.count).toBe(0); expect(runtime.status.error).toBe("Historical transform is invalid"); expect(changed).toHaveBeenCalledTimes(1);
    runtime.request({ ...doc }, shape, 48, sampler, changed);
    expect(runtime.status.error).toBeUndefined(); expect(runtime.status.pending).toBe(true);
    await resolve(recovered.jobs[0], frame(48, 2));
    expect(factory).toHaveBeenCalledTimes(3); expect(runtime.status).toEqual({ count: 2, pending: false });
    expect(cloud.geometry.getAttribute("position").getX(0)).toBe(48); expect(changed).toHaveBeenCalledTimes(2); runtime.dispose();
  });

  it("suspends displayed and pending work, then allows the same document/frame to restart", async () => {
    const old = simulation(), resumed = simulation(); factory.mockReturnValueOnce(old).mockReturnValueOnce(resumed);
    const { doc, shape, sampler, runtime, changed, cloud } = fixture();
    runtime.request(doc, shape, 12, sampler, changed); await resolve(old.jobs[0], frame(12));
    runtime.request(doc, shape, 24, sampler, changed); runtime.suspend();
    expect(old.dispose).toHaveBeenCalledTimes(1); expect(cloud.geometry.drawRange.count).toBe(0); expect(runtime.status).toEqual({ count: 0, pending: false });
    await resolve(old.jobs[1], frame(24, 3));
    expect(changed).toHaveBeenCalledTimes(1); expect(cloud.geometry.drawRange.count).toBe(0);
    runtime.request(doc, shape, 24, sampler, changed); expect(factory).toHaveBeenCalledTimes(2);
    await resolve(resumed.jobs[0], frame(100, 2));
    expect(runtime.status).toEqual({ count: 2, pending: false }); expect(cloud.geometry.getAttribute("position").getX(0)).toBe(100); runtime.dispose();
  });

  it("ignores work completed after disposal and never starts another simulation", async () => {
    const fake = simulation(); factory.mockReturnValue(fake);
    const { doc, shape, sampler, runtime, changed, cloud } = fixture(), parent = new Group(); parent.add(runtime.mesh);
    runtime.request(doc, shape, 24, sampler, changed); runtime.dispose(); runtime.dispose();
    await resolve(fake.jobs[0], frame(24, 5));
    runtime.request({ ...doc }, shape, 48, sampler, changed);
    expect(fake.dispose).toHaveBeenCalledTimes(1); expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.snapshotAt).toHaveBeenCalledTimes(1); expect(changed).not.toHaveBeenCalled();
    expect(cloud.geometry.drawRange.count).toBe(0); expect(runtime.mesh.parent).toBeNull();
  });

  it("keeps the last complete cloud during backward replay and supersession", async () => {
    const fake = simulation(); factory.mockReturnValue(fake);
    const { doc, shape, sampler, runtime, changed, cloud } = fixture();
    runtime.request(doc, shape, 48, sampler, changed); await resolve(fake.jobs[0], frame(48, 3));
    expect(cloud.geometry.drawRange.count).toBe(3);
    runtime.request(doc, shape, 12, sampler, changed);
    expect(cloud.geometry.drawRange.count).toBe(3); expect(runtime.status).toEqual({ count: 3, pending: true, error: undefined });
    expect(factory).toHaveBeenCalledTimes(1);
    runtime.request(doc, shape, 16, sampler, changed);
    await reject(fake.jobs[1], new DOMException("Superseded", "AbortError"));
    expect(runtime.status.pending).toBe(true); expect(cloud.geometry.getAttribute("position").getX(0)).toBe(48);
    await resolve(fake.jobs[2], frame(16));
    expect(runtime.status).toEqual({ count: 1, pending: false }); expect(cloud.geometry.getAttribute("position").getX(0)).toBe(16); runtime.dispose();
  });

  it("disposes preview state on cancellation and keeps the last valid display while restoring authored state", async () => {
    const authored = simulation(), preview = simulation(), restored = simulation();
    factory.mockReturnValueOnce(authored).mockReturnValueOnce(preview).mockReturnValueOnce(restored);
    const { doc, shape, sampler, runtime, changed, cloud } = fixture();
    runtime.request(doc, shape, 24, sampler, changed); await resolve(authored.jobs[0], frame(24));
    const draftShape = { ...shape, seed: shape.seed + 1 };
    const draft = { ...doc, nodes: { ...doc.nodes, [shape.id]: draftShape } };
    runtime.request(draft, draftShape, 24, createParticlePoseSampler(draft), changed);
    runtime.request(doc, shape, 24, sampler, changed);
    expect(authored.dispose).toHaveBeenCalledTimes(1); expect(preview.dispose).toHaveBeenCalledTimes(1);
    await resolve(preview.jobs[0], frame(123, 3));
    expect(cloud.geometry.getAttribute("position").getX(0)).toBe(24);
    await reject(restored.jobs[0], new DOMException("Interrupted", "AbortError"));
    expect(runtime.status).toEqual({ count: 1, pending: false });
    runtime.request(doc, shape, 24, sampler, changed);
    await resolve(restored.jobs[1], frame(24));
    expect(cloud.geometry.getAttribute("position").getX(0)).toBe(24); runtime.dispose();
  });

  it("clears the visible cloud and reports a latest-request async error without reviving older output", async () => {
    const fake = simulation(); factory.mockReturnValue(fake);
    const { doc, shape, sampler, runtime, changed, cloud } = fixture();
    runtime.request(doc, shape, 12, sampler, changed); await resolve(fake.jobs[0], frame(12));
    runtime.request(doc, shape, 24, sampler, changed); runtime.request(doc, shape, 36, sampler, changed);
    await reject(fake.jobs[2], new Error("Replay failed"));
    expect(runtime.status).toEqual({ count: 0, pending: false, error: "Replay failed" }); expect(cloud.geometry.drawRange.count).toBe(0);
    await resolve(fake.jobs[1], frame(24, 2));
    expect(runtime.status.error).toBe("Replay failed"); expect(cloud.geometry.drawRange.count).toBe(0); expect(changed).toHaveBeenCalledTimes(2); runtime.dispose();
  });

  it("keeps the last complete cloud when a particle texture effect cannot evaluate", async () => {
    const old = simulation(), invalid = simulation();
    factory.mockReturnValueOnce(old).mockReturnValueOnce(invalid);
    const { doc, shape, sampler, runtime, changed, cloud } = fixture();
    runtime.request(doc, shape, 12, sampler, changed);
    await resolve(old.jobs[0], frame(12, 2));
    const nextShape = { ...shape, forceField: { enabled: true, space: "world" as const, strength: 3 } };
    const nextDoc = { ...doc, nodes: { ...doc.nodes, [shape.id]: nextShape } };
    runtime.request(nextDoc, nextShape, 24, createParticlePoseSampler(nextDoc), changed);
    await reject(invalid.jobs[0], Error("Texture Graph returned a non-finite particle force."));
    expect(runtime.status).toEqual({ count: 2, pending: false, error: "Texture Graph returned a non-finite particle force." });
    expect(cloud.geometry.getAttribute("position").getX(0)).toBe(12);
    runtime.dispose();
  });
});
