import { countInside, exportCrop, loadCropAsset, type CropAsset, type CropBounds, type CropSide } from "./splat-ply-crop";
import {
  countPartition, createPartitionRecipe, exportPartition, openPartitionRecipe,
  type PartitionRecipe, type PartitionSummary,
} from "./splat-ply-regions";
import type { CaptureRegion } from "./splat-ply-region-spec";

export type CropJob =
  | { kind: "load"; id: number; file: File }
  | { kind: "count"; id: number; bounds: CropBounds }
  | { kind: "export"; id: number; bounds: CropBounds; side: CropSide }
  | { kind: "count-partition" | "export-partition" | "save-recipe"; id: number; regions: CaptureRegion[] }
  | { kind: "open-recipe"; id: number; file: File };
export type CropRequest = CropJob | { kind: "cancel" } | { kind: "accept"; id: number };
export type CropReply =
  | { kind: "loaded"; id: number; bounds: CropBounds; sample: Float64Array; count: number }
  | { kind: "counted"; id: number; inside: number }
  | { kind: "exported"; id: number; file: Blob; side: CropSide }
  | { kind: "counted-partition"; id: number; summary: PartitionSummary }
  | { kind: "exported-partition"; id: number; file: Blob }
  | { kind: "saved-recipe" | "opened-recipe"; id: number; recipe: PartitionRecipe }
  | { kind: "progress"; id: number; ratio: number }
  | { kind: "failed"; id: number; message: string };

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<CropRequest>) => void) | null;
  postMessage(reply: CropReply): void;
};
let asset: CropAsset | undefined;
let staged: { id: number; asset: CropAsset } | undefined;
let controller: AbortController | undefined;
let queue = Promise.resolve();

async function run(request: CropJob, signal: AbortSignal): Promise<void> {
  const { id } = request;
  const progress = (ratio: number) => worker.postMessage({ kind: "progress", id, ratio });
  const reply = (message: CropReply) => {
    signal.throwIfAborted();
    worker.postMessage(message);
  };
  try {
    signal.throwIfAborted();
    if (request.kind === "load") {
      const next = await loadCropAsset(request.file, { signal, progress });
      signal.throwIfAborted();
      staged = { id, asset: next };
      reply({ kind: "loaded", id, bounds: next.bounds, sample: next.sample, count: next.layout.vertexCount });
      return;
    }
    if (!asset) throw new Error("Open a Gaussian PLY first.");
    switch (request.kind) {
      case "count":
        reply({ kind: "counted", id, inside: await countInside(asset, request.bounds, { signal }) });
        break;
      case "export":
        reply({ kind: "exported", id, side: request.side, file: await exportCrop(asset, request.bounds, request.side, { signal, progress }) });
        break;
      case "count-partition":
        reply({ kind: "counted-partition", id, summary: await countPartition(asset, request.regions, { signal, progress }) });
        break;
      case "export-partition":
        reply({ kind: "exported-partition", id, file: await exportPartition(asset, request.regions, { signal, progress }) });
        break;
      case "save-recipe":
        reply({ kind: "saved-recipe", id, recipe: await createPartitionRecipe(asset, request.regions, { signal, progress }) });
        break;
      case "open-recipe":
        reply({ kind: "opened-recipe", id, recipe: await openPartitionRecipe(asset, request.file, { signal, progress }) });
        break;
    }
  } catch (error) {
    if (!signal.aborted) {
      worker.postMessage({ kind: "failed", id, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

worker.onmessage = ({ data }) => {
  if (data.kind === "accept") {
    if (staged?.id === data.id) {
      asset = staged.asset;
      staged = undefined;
    }
    return;
  }
  staged = undefined;
  controller?.abort();
  if (data.kind === "cancel") return;
  controller = new AbortController();
  const { signal } = controller;
  queue = queue.then(() => run(data, signal));
};
