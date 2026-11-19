import type { SplatShapeNode } from "./scene-document.ts";
import type { SplatMorphPose } from "./splat-morph.ts";
import type { SplatTransformRuntime } from "./splat-transform-runtime.ts";

/** Scene replacement visits frame zero before restoring the bounded saved time.
 * Saving and opening use the same probes, including legacy out-of-range timestamps. */
export function splatArchiveFrames(settings: { start: number; end: number; fps: number }, seconds: number) {
  const frame = seconds * settings.fps;
  return new Set([0, settings.start, frame, Math.max(settings.start, Math.min(settings.end, frame))]);
}

export type SplatFrameJob = { shape: SplatShapeNode; transforms: SplatTransformRuntime; visits: number; morph?: SplatMorphPose };

/** Preflight the entire requested scene pose before advancing its time. Small edits
 * stay synchronous, and costly poses yield to newer input between work slices. */
export function stageSplatTimelineFrame(jobs: readonly SplatFrameJob[], frame: number,
  signal: AbortSignal, publish: () => void): void | Promise<void> {
  signal.throwIfAborted();
  if (jobs.reduce((n, job) => n + job.visits, 0) < 12000) {
    for (const { shape, transforms, morph } of jobs) transforms.prepare(shape.componentTransforms, shape.deformers,
      shape.scalarMasks, frame, morph);
    publish();
    return;
  }
  return (async () => {
    let sliceStart = performance.now();
    for (const [index, { shape, transforms, morph }] of jobs.entries()) {
      signal.throwIfAborted();
      await transforms.prepareInteractive(shape.componentTransforms, shape.deformers,
        shape.scalarMasks, frame, morph, signal);
      // Many individually inexpensive shapes can still consume a long input task.
      if (index + 1 < jobs.length && performance.now() - sliceStart >= 4) {
        await new Promise(resolve => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
    signal.throwIfAborted();
    publish();
  })();
}
