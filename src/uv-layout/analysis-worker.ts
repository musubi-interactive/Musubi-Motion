import { analyzeUVLayout, type AnalysisResult } from "./analysis.ts";
import type { UVLayout } from "./obj.ts";
import type { Tile } from "./tile.ts";

export type AnalysisRequest = { layout: UVLayout; objects: number[]; tiles: Tile[] };
export type AnalysisResponse = { result: AnalysisResult } | { error: string };

self.addEventListener("message", ({ data }: MessageEvent<AnalysisRequest>) => {
  let response: AnalysisResponse;
  try {
    response = { result: analyzeUVLayout(data.layout, data.objects, data.tiles) };
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response);
});
