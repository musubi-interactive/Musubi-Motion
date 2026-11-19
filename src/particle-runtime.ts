import type { SceneDocument } from "./scene-document.ts";
import type { ParticleShapeNode } from "./particle-emitter.ts";
import { createParticlePoseSampler } from "./particle-pose-sampler.ts";
import { createParticleSimulation, type ParticlePrewarmRange } from "./particle-simulation.ts";
import { createParticleRenderable } from "./particle-renderer.ts";

type PrewarmState = { kind: "idle" | "cancelled" } |
  { kind: "running"; percent: number } |
  { kind: "complete"; range: ParticlePrewarmRange; count: number } |
  { kind: "error"; message: string };

/** Owns cancellable replay independently of document history and render loops. */
export function createParticleRuntime(shape: ParticleShapeNode) {
  const renderer = createParticleRenderable(); renderer.mesh.name = shape.name;
  let previousDoc: SceneDocument | undefined, previousShape: ParticleShapeNode | undefined;
  let previousSampler: ReturnType<typeof createParticlePoseSampler> | undefined, simulation: ReturnType<typeof createParticleSimulation> | undefined;
  let requestedFrame = NaN, generation = 0, disposed = false;
  let status: { count: number; pending: boolean; error?: string } = { count: 0, pending: false };
  let prewarmState: PrewarmState = { kind: "idle" };
  let prewarmJob: { controller: AbortController; changed: () => void } | undefined;

  function cancelPrewarm(notify = true) {
    const job = prewarmJob;
    if (!job) return;
    prewarmJob = undefined;
    job.controller.abort();
    prewarmState = { kind: "cancelled" };
    if (notify) job.changed();
  }
  const replayCache = {
    get state() { return prewarmState; },
    start(range: ParticlePrewarmRange, changed: () => void) {
      if (prewarmJob) return;
      if (disposed || !simulation || status.pending) throw Error("Wait for the current particle replay to finish.");
      const controller = new AbortController();
      const job = { controller, changed };
      prewarmJob = job;
      prewarmState = { kind: "running", percent: 0 };
      const finish = (state: PrewarmState) => {
        if (job !== prewarmJob) return;
        prewarmJob = undefined;
        prewarmState = state;
        changed();
      };
      void simulation.prewarm(range, controller.signal, percent => {
        if (job !== prewarmJob) return;
        prewarmState = { kind: "running", percent };
        changed();
      }).then(count => finish({ kind: "complete", range, count }), error => {
        if (error instanceof Error && error.name === "AbortError") finish({ kind: "cancelled" });
        else finish({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
      changed();
    },
    cancel: () => cancelPrewarm(),
  };

  return {
    ...renderer,
    get status() { return { ...status, replayCache }; },
    request(doc: SceneDocument, next: ParticleShapeNode, frame: number, sampler: ReturnType<typeof createParticlePoseSampler>, changed: () => void) {
      const revised = doc !== previousDoc || next !== previousShape || sampler !== previousSampler;
      if (disposed || (!revised && frame === requestedFrame)) return;
      cancelPrewarm();
      if (revised && prewarmState.kind === "complete") prewarmState = { kind: "idle" };
      const ticket = ++generation; requestedFrame = frame;
      const failed = (error: unknown) => {
        if (disposed || ticket !== generation) return;
        if (error instanceof Error && error.name === "AbortError") {
          requestedFrame = NaN;
          status = { count: status.count, pending: false }; changed(); return;
        }
        const keepLast = next.appearanceMap?.enabled || next.forceField?.enabled;
        if (!keepLast) renderer.clear();
        status = { count: keepLast ? status.count : 0, pending: false, error: error instanceof Error ? error.message : String(error) };
        changed();
      };
      try {
        if (revised || !simulation) {
          simulation?.dispose(); simulation = undefined;
          previousDoc = doc; previousShape = next; previousSampler = sampler;
          simulation = createParticleSimulation(doc, next, sampler); renderer.mesh.name = next.name;
        }
        // Keep the last completed cloud during replay. A superseded request
        // never clears it or publishes a partially reconstructed snapshot.
        status = { ...status, pending: true, error: undefined };
        void simulation.snapshotAt(frame).then(result => {
          if (disposed || ticket !== generation) return;
          renderer.setFrame(result); status = { count: result.count, pending: false }; changed();
        }).catch(failed);
      } catch (error) { failed(error); }
    },
    suspend() {
      cancelPrewarm(false); prewarmState = { kind: "idle" };
      generation++; simulation?.dispose(); simulation = undefined;
      previousDoc = undefined; previousShape = undefined; previousSampler = undefined;
      requestedFrame = NaN; renderer.clear(); status = { count: 0, pending: false };
    },
    dispose() {
      if (disposed) return;
      cancelPrewarm(false); prewarmState = { kind: "idle" };
      disposed = true; generation++; simulation?.dispose(); simulation = undefined;
      previousDoc = undefined; previousShape = undefined; previousSampler = undefined;
      renderer.dispose();
    },
  };
}
