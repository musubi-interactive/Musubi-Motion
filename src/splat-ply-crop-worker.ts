import { countInside, exportCrop, loadCropAsset, type CropAsset, type CropBounds, type CropSide } from "./splat-ply-crop";

type Job =
  | { kind: "load"; id: number; file: File }
  | { kind: "count"; id: number; bounds: CropBounds }
  | { kind: "export"; id: number; bounds: CropBounds; side: CropSide };
export type CropRequest = Job | { kind: "cancel" } | { kind: "accept"; id: number };
export type CropReply =
  | { kind: "loaded"; id: number; bounds: CropBounds; sample: Float64Array; count: number }
  | { kind: "counted"; id: number; inside: number }
  | { kind: "exported"; id: number; file: Blob; side: CropSide }
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

async function run(request: Job, signal: AbortSignal): Promise<void> {
  const { id } = request;
  const progress = (ratio: number) => worker.postMessage({ kind: "progress", id, ratio });
  try {
    signal.throwIfAborted();
    if (request.kind === "load") {
      const next = await loadCropAsset(request.file, { signal, progress });
      signal.throwIfAborted();
      staged = { id, asset: next };
      worker.postMessage({
        kind: "loaded", id, bounds: next.bounds, sample: next.sample, count: next.layout.vertexCount,
      });
    } else {
      if (!asset) throw new Error("Open a Gaussian PLY before cropping.");
      if (request.kind === "count") {
        const inside = await countInside(asset, request.bounds, { signal });
        signal.throwIfAborted();
        worker.postMessage({ kind: "counted", id, inside });
      } else {
        const file = await exportCrop(asset, request.bounds, request.side, { signal, progress });
        signal.throwIfAborted();
        worker.postMessage({ kind: "exported", id, file, side: request.side });
      }
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
