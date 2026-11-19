import { describe, expect, it } from "vitest";
import { Box3 } from "three";
import { setAnimationSettings } from "../src/animation.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { makeDemo, prepareSplat } from "../src/splat-assets.ts";
import { addSplat, emptyScene, type SplatShapeNode } from "../src/scene-document.ts";
import { getSplatDeformerDefinition, type SplatDeformer } from "../src/splat-deformers.ts";
import { latticeRestPoint, resizeSplatLattice } from "../src/splat-lattice.ts";
import { createSplatTransformRuntime } from "../src/splat-transform-runtime.ts";
import { splatArchiveFrames, stageSplatTimelineFrame, type SplatFrameJob } from "../src/splat-timeline.ts";

describe("atomic splat timeline changes", () => {
  it("preflights the same frame set for storing and restoring bounded legacy timestamps", () => {
    expect([...splatArchiveFrames({ start: 8, end: 24, fps: 24 }, 2)]).toEqual([0, 8, 48, 24]);
    expect([...splatArchiveFrames({ start: 0, end: 24, fps: 24 }, .5)]).toEqual([0, 12]);
  });

  it("holds every displayed shape and the current time when a sparse intermediate pose collapses", async () => {
    const meshes = [makeDemo(), makeDemo()];
    const [{ count }] = await Promise.all(meshes.map(mesh => prepareSplat(mesh)));
    const runtimes = meshes.map(mesh => createSplatTransformRuntime(mesh));
    try {
      const source = meshes[0].extSplats!.getSplat(0).center.clone();
      const lattice = resizeSplatLattice(source.toArray(), [2, 2, 2], [2, 2, 2]);
      const common = { id: "layer", name: "Layer", envelope: 1, sourceCount: count, weights: [{ index: 0, weight: 1 }] };
      const cluster: SplatDeformer = { ...common, kind: "cluster",
        params: getSplatDeformerDefinition("cluster")!.create(new Box3(source, source)), keys: [
          { frame: 0, channel: "position.x", value: 2 }, { frame: 1, channel: "position.x", value: 6 },
        ] };
      // Both keyed endpoints are invertible. At the fractional midpoint the reflection
      // collapses the lattice onto a plane, after the first shape already staged its move.
      const foldingLattice: SplatDeformer = { ...common, kind: "lattice", params: lattice,
        keys: lattice.offsets.flatMap((_, i) => {
          const x = latticeRestPoint(lattice, i)[0], channel = "point." + i + ".x";
          return [{ frame: 0, channel, value: x }, { frame: 1, channel, value: 2 * source.x - x }];
        }) };
      let doc = emptyScene();
      const jobs: SplatFrameJob[] = [cluster, foldingLattice].map((entry, i) => {
        const added = addSplat(doc, { id: "a"+i, kind: "procedural", generator: "knot-v1" }, "shape"+i, [0,0,0]);
        doc = added.document;
        const shape = Object.values(doc.nodes).find((n): n is SplatShapeNode => n.type === "splatShape" && n.assetId === "a"+i)!;
        shape.deformers = [entry]; return { shape, transforms: runtimes[i], visits: 1 };
      });
      const rangeStore = createSceneStore(doc, (_doc, _shape, probes) => {
        if (probes.edited.has(3)) throw Error("Invalid new range start");
      });
      expect(() => setAnimationSettings(rangeStore, { start: 3 })).toThrow(/range start/);
      expect(rangeStore.getState().document).toBe(doc);
      let displayed = -1;
      const seek = (frame: number) => stageSplatTimelineFrame(jobs, frame, new AbortController().signal, () => {
        for (const { transforms, shape } of jobs) transforms.update(undefined, shape.deformers, undefined, frame);
        displayed = frame;
      });
      expect(seek(0)).toBeUndefined();
      const before = runtimes.map(runtime => runtime.value);
      expect(() => seek(.5)).toThrow(/collapsed/);
      expect(displayed).toBe(0);
      expect(runtimes[0].value).toBe(before[0]);
      expect(runtimes[1].value).toBe(before[1]);
      expect(runtimes[0].positions([0])[0]).toBeCloseTo(source.x + 2);
      expect(seek(1)).toBeUndefined();
      expect(displayed).toBe(1);
      expect(runtimes[0].positions([0])[0]).toBeCloseTo(source.x + 6);

      const dense = jobs.map(job => ({ ...job, visits: count,
        shape: { ...job.shape, deformers: job.shape.deformers!.map(entry => ({ ...entry, weights: undefined })) } }));
      const controller = new AbortController();
      const pending = stageSplatTimelineFrame(dense, .25, controller.signal, () => { displayed = .25; });
      expect(pending).toBeInstanceOf(Promise);
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(displayed).toBe(1);
    } finally {
      runtimes.forEach(runtime => runtime.dispose());
      meshes.forEach(mesh => mesh.dispose());
    }
  });
});
