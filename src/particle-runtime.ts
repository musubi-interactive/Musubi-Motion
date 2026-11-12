import type { SceneDocument } from "./scene-document.ts";
import type { ParticleShapeNode } from "./particle-emitter.ts";
import { createParticlePoseSampler } from "./particle-pose-sampler.ts";
import { createParticleSimulation } from "./particle-simulation.ts";
import { createParticleRenderable } from "./particle-renderer.ts";

/** Owns cancellable replay independently of document history and render loops. */
export function createParticleRuntime(shape: ParticleShapeNode) {
  const renderer = createParticleRenderable(); renderer.mesh.name = shape.name;
  let previousDoc: SceneDocument | undefined, previousShape: ParticleShapeNode | undefined;
  let previousSampler: ReturnType<typeof createParticlePoseSampler> | undefined, simulation: ReturnType<typeof createParticleSimulation> | undefined;
  let requestedFrame = NaN, generation = 0, disposed = false;
  let status: { count: number; pending: boolean; error?: string } = { count: 0, pending: false };
  return {
    ...renderer,
    get status() { return status; },
    request(doc: SceneDocument, next: ParticleShapeNode, frame: number, sampler: ReturnType<typeof createParticlePoseSampler>, changed: () => void) {
      const revised = doc !== previousDoc || next !== previousShape || sampler !== previousSampler;
      if (disposed || (!revised && frame === requestedFrame)) return;
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
      generation++; simulation?.dispose(); simulation = undefined;
      previousDoc = undefined; previousShape = undefined; previousSampler = undefined;
      requestedFrame = NaN; renderer.clear(); status = { count: 0, pending: false };
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; simulation?.dispose(); simulation = undefined;
      previousDoc = undefined; previousShape = undefined; previousSampler = undefined;
      renderer.dispose();
    },
  };
}
