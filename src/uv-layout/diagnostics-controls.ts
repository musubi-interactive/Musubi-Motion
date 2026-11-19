import { ANALYSIS_LIMITS, texelDensity, type AnalysisResult, type FaceRef } from "./analysis.ts";
import type { AnalysisRequest, AnalysisResponse } from "./analysis-worker.ts";
import type { MappedFace, UVLayout } from "./obj.ts";
import { clipSegment, firstEdgeTile, MAX_TILE, tileLabel, type Tile } from "./tile.ts";

type Source = { layout: UVLayout; name: string; sha256: string };
type Settings = { mapSize: number; unitScale: number };
type Report = { source: Source; objects: number[]; tiles: Tile[]; result: AnalysisResult };
export type Highlight = { faces: MappedFace[]; second?: MappedFace };
const ISLANDS_PER_PAGE = 100;

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function format(value: number) {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 5 });
}

function readTiles(text: string, previewTile: Tile): Tile[] {
  if (!text.trim()) return [previewTile];
  const tiles = new Map<string, Tile>();
  const values = text.split(";");
  if (values.length > ANALYSIS_LIMITS.tiles) throw Error("Enter up to eight overlap tiles.");
  for (const value of values) {
    const match = /^\s*([+-]?\d+)\s*,\s*([+-]?\d+)\s*$/.exec(value);
    if (!match) throw Error("Enter signed integer U, V pairs separated by semicolons.");
    const u = Number(match[1]), v = Number(match[2]);
    if (Math.abs(u) > MAX_TILE || Math.abs(v) > MAX_TILE) throw Error("Tile coordinates must be within ±1,000,000.");
    tiles.set(`${u},${v}`, { u, v });
  }
  return [...tiles.values()];
}

function options(select: HTMLSelectElement, values: readonly [number, string][], placeholder: string) {
  select.replaceChildren(new Option(placeholder, ""), ...values.map(([index, text]) => new Option(text, String(index))));
  select.disabled = !values.length;
}

function valueOf(select: HTMLSelectElement) {
  return select.value === "" ? -1 : Number(select.value);
}

export function diagnosticsControls(view: {
  tile: () => Tile;
  selected: () => number[];
  showHighlight: (highlight?: Highlight, tile?: Tile) => void;
}) {
  const panel = element("uv-analysis");
  const status = element("uv-analysis-status");
  const results = element("uv-analysis-results");
  const run = element<HTMLButtonElement>("analyze-uv");
  const cancel = element<HTMLButtonElement>("cancel-uv-analysis");
  const undo = element<HTMLButtonElement>("undo-uv-settings");
  const tilesInput = element<HTMLInputElement>("analysis-tiles");
  const objects = element<HTMLSelectElement>("analysis-object");
  const islands = element<HTMLSelectElement>("analysis-island");
  const outliers = element<HTMLSelectElement>("analysis-outlier");
  const pairs = element<HTMLSelectElement>("analysis-pair");
  const previous = element<HTMLButtonElement>("previous-islands");
  const next = element<HTMLButtonElement>("next-islands");
  const fields = {
    mapSize: element<HTMLInputElement>("analysis-resolution"),
    unitScale: element<HTMLInputElement>("analysis-unit-scale"),
  };
  let source: Source | undefined;
  let worker: Worker | undefined;
  let report: Report | undefined;
  let islandPage = 0;
  let settings: Settings = { mapSize: 1024, unitScale: 1 };
  let draft: Partial<Settings> = {};
  const history: Settings[] = [];
  const summary = () => report?.result.objects[valueOf(objects)];

  function say(message: string, error = false) {
    status.classList.toggle("error", error);
    status.textContent = message;
  }

  function densityText(density: number | null) {
    return density === null ? "No measurable faces" : `${format(density)} texels/unit`;
  }

  function renderDensity() {
    const selected = summary();
    if (!selected) return;
    const { mapSize, unitScale } = { ...settings, ...draft };
    const density = texelDensity(selected, mapSize, unitScale);
    element("analysis-object-summary").textContent =
      `${densityText(density)} · ${selected.faces.toLocaleString()} measurable faces`;
    const { nonplanar, selfIntersecting, zeroSourceArea, zeroUVArea, tooManyCorners } = selected.issues;
    const excluded = [
      [selected.missingUVs, "missing UVs"], [nonplanar, "nonplanar"], [selfIntersecting, "self-intersecting or could not triangulate"],
      [zeroSourceArea, "near-zero source area"], [zeroUVArea, "near-zero UV area"], [tooManyCorners, "over 64 corners"],
    ] as const;
    element("analysis-object-issues").textContent =
      excluded.filter(([count]) => count).map(([count, issue]) => `${count.toLocaleString()} ${issue}`).join(" · ");

    const first = islandPage * ISLANDS_PER_PAGE;
    const oldIsland = islands.value, oldOutlier = outliers.value;
    const page = selected.islands.slice(first, first + ISLANDS_PER_PAGE);
    options(islands, page.map(island => [island.island,
      `Island ${island.island} · ${densityText(texelDensity(island, mapSize, unitScale))}`]),
      selected.islands.length ? "Select an island" : "No islands");
    options(outliers, selected.outliers.map(({ ref, densityRatio }, i) => [i,
      `Line ${ref.line} · ${densityText(density! * densityRatio)} (${format((densityRatio - 1) * 100)}%)`]),
      selected.outlierCount ? `Showing ${selected.outliers.length} of ${selected.outlierCount}` : "No outliers");
    if (oldIsland && page.some(({ island }) => String(island) === oldIsland)) islands.value = oldIsland;
    if (oldOutlier && selected.outliers[Number(oldOutlier)]) outliers.value = oldOutlier;

    element("analysis-island-pages").hidden = selected.islands.length <= ISLANDS_PER_PAGE;
    previous.disabled = islandPage === 0;
    next.disabled = first + ISLANDS_PER_PAGE >= selected.islands.length;
    element("analysis-island-range").textContent = `${first + 1}–${first + page.length} of ${selected.islands.length}`;
  }

  function renderResult() {
    if (!report) return;
    const { layout } = report.source;
    const { pairs: overlaps, truncated } = report.result;
    objects.replaceChildren(...report.result.objects.map(({ object }, index) => new Option(layout.objects[object].name, String(index))));
    islandPage = 0;
    options(pairs, overlaps.map(({ a, b, tile }, i) => [i,
      `Lines ${a.line} and ${b.line} · ${tileLabel(tile)}`]), overlaps.length ? "Select a pair" : "No overlap pairs");
    islands.value = outliers.value = "";
    renderDensity();
    results.hidden = false;
    const count = overlaps.length.toLocaleString();
    const incomplete = truncated ? ` Scan truncated at the ${truncated}. More overlaps may exist.` : "";
    say(`${count} overlap ${overlaps.length === 1 ? "pair" : "pairs"} across ${report.tiles.map(tileLabel).join(", ")}.${incomplete}`);
  }

  function stopWorker() {
    worker?.terminate();
    worker = undefined;
    run.disabled = view.selected().length === 0;
    cancel.disabled = true;
  }

  function clearReport() {
    stopWorker();
    report = undefined;
    results.hidden = true;
    view.showHighlight();
    say(run.disabled ? "Select at least one object." : "Choose objects and analyze their UVs.");
  }

  function analyze() {
    if (!source || worker) return;
    const objects = view.selected();
    if (!objects.length) return;
    let tiles: Tile[];
    try {
      tiles = readTiles(tilesInput.value, view.tile());
    } catch (error) {
      say((error as Error).message, true);
      return;
    }
    const current = source;
    let request: Worker;
    try {
      request = new Worker(new URL("./analysis-worker.ts", import.meta.url), { type: "module" });
    } catch {
      say("Could not start UV analysis.", true);
      return;
    }
    worker = request;
    run.disabled = true;
    cancel.disabled = false;
    say("Analyzing selected UVs…");
    function fail() {
      if (worker !== request) return;
      stopWorker();
      say("Could not analyze selected UVs.", true);
    }
    request.addEventListener("error", fail);
    request.addEventListener("messageerror", fail);
    request.addEventListener("message", ({ data }: MessageEvent<AnalysisResponse>) => {
      if (worker !== request) return;
      stopWorker();
      if ("error" in data) {
        say(data.error, true);
        return;
      }
      report = { source: current, objects, tiles, result: data.result };
      view.showHighlight();
      renderResult();
    });
    try {
      request.postMessage({ layout: current.layout, objects, tiles } satisfies AnalysisRequest);
    } catch {
      fail();
    }
  }

  function downloadReport() {
    if (!report) return;
    const { source, objects, tiles, result } = report;
    const { mapSize, unitScale } = settings;
    const summaries = result.objects.map(object => {
      const density = texelDensity(object, mapSize, unitScale);
      return {
        ...object,
        texelsPerUnit: density,
        islands: object.islands.map(island => ({ ...island, texelsPerUnit: texelDensity(island, mapSize, unitScale) })),
        outliers: object.outliers.map(outlier => ({ ...outlier, texelsPerUnit: density! * outlier.densityRatio })),
      };
    });
    const payload = {
      version: 1,
      source: { name: source.name, sha256: source.sha256 },
      settings: { ...settings, objects: objects.map(index => ({ index, name: source.layout.objects[index].name })), tiles },
      limits: ANALYSIS_LIMITS,
      density: "mapSize * sqrt(uvArea / sourceArea) / unitScale",
      results: { ...result, objects: summaries },
    };
    const filename = source.name.replace(/\.obj$/i, "").replace(/[^\w.-]+/g, "_").slice(0, 100) || "layout";
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}_uv-diagnostics.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  function showFaces(faces: MappedFace[], target?: Tile, second?: MappedFace) {
    if (!source || !faces.length) {
      view.showHighlight();
      return;
    }
    const coords = source.layout.coordinates;
    if (!target) {
      const current = view.tile();
      const visible = faces.some(({ uvs }) => uvs.some((uv, i) =>
        clipSegment(coords[uv], coords[uvs[(i + 1) % uvs.length]], current)));
      if (!visible) {
        outer: for (const { uvs } of faces) {
          for (const [i, uv] of uvs.entries()) {
            target = firstEdgeTile(coords[uv], coords[uvs[(i + 1) % uvs.length]]);
            if (target) break outer;
          }
        }
      }
    }
    view.showHighlight({ faces, second }, target);
  }

  function lookup(ref: FaceRef) {
    return source!.layout.objects[ref.object].mappedFaces[ref.face];
  }

  function numericField(name: keyof Settings, step: number) {
    const field = fields[name];
    let drag: { id: number; startX: number; value: number; text: string; draftValue?: number } | undefined;
    field.title = "Middle-drag to adjust. Escape restores the prior value.";

    function preview() {
      if (field.validity.valid) draft[name] = field.valueAsNumber;
      else delete draft[name];
      renderDensity();
    }

    function commit() {
      const value = field.valueAsNumber;
      if (field.validity.valid && value !== settings[name]) {
        history.push(settings);
        if (history.length > 100) history.shift();
        settings = { ...settings, [name]: value };
      }
      delete draft[name];
      field.value = String(settings[name]);
      undo.disabled = !history.length;
      renderDensity();
    }

    function escape() {
      if (drag) {
        const started = drag;
        drag = undefined;
        if (field.hasPointerCapture(started.id)) field.releasePointerCapture(started.id);
        field.value = started.text;
        if (started.draftValue === undefined) delete draft[name];
        else draft[name] = started.draftValue;
      } else {
        delete draft[name];
        field.value = String(settings[name]);
      }
      renderDensity();
    }

    field.addEventListener("input", preview);
    field.addEventListener("change", () => { if (!drag) commit(); });
    field.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        escape();
      } else if (event.key === "Enter" && !drag) {
        event.preventDefault();
        commit();
      }
    });
    field.addEventListener("auxclick", event => {
      if (event.button === 1) event.preventDefault();
    });
    field.addEventListener("pointerdown", event => {
      if (event.button !== 1 || drag) return;
      event.preventDefault();
      field.focus();
      drag = {
        id: event.pointerId, startX: event.clientX, value: draft[name] ?? settings[name],
        text: field.value, draftValue: draft[name],
      };
      field.setPointerCapture(event.pointerId);
    });
    field.addEventListener("pointermove", event => {
      if (drag?.id !== event.pointerId) return;
      const ticks = Math.trunc((event.clientX - drag.startX) / 8);
      const value = Number((drag.value + ticks * step).toFixed(9));
      field.value = ticks === 0 ? drag.text : String(Math.min(Number(field.max), Math.max(Number(field.min), value)));
      preview();
    });
    field.addEventListener("pointerup", event => {
      if (drag?.id !== event.pointerId) return;
      drag = undefined;
      commit();
    });
    field.addEventListener("lostpointercapture", () => { if (drag) escape(); });
  }

  numericField("mapSize", 64);
  numericField("unitScale", 0.1);
  run.addEventListener("click", analyze);
  cancel.addEventListener("click", () => {
    stopWorker();
    say("UV analysis canceled.");
  });
  undo.addEventListener("click", () => {
    const prior = history.pop();
    if (!prior) return;
    settings = prior;
    draft = {};
    fields.mapSize.value = String(settings.mapSize);
    fields.unitScale.value = String(settings.unitScale);
    undo.disabled = !history.length;
    renderDensity();
  });
  objects.addEventListener("change", () => {
    islandPage = 0;
    islands.value = outliers.value = pairs.value = "";
    view.showHighlight();
    renderDensity();
  });
  islands.addEventListener("change", () => {
    pairs.value = outliers.value = "";
    const selected = summary();
    if (!source || !selected) return;
    const id = valueOf(islands);
    showFaces(source.layout.objects[selected.object].mappedFaces.filter(face => face.island === id));
  });
  outliers.addEventListener("change", () => {
    pairs.value = islands.value = "";
    const outlier = summary()?.outliers[valueOf(outliers)];
    showFaces(outlier ? [lookup(outlier.ref)] : []);
  });
  pairs.addEventListener("change", () => {
    islands.value = outliers.value = "";
    const pair = report?.result.pairs[valueOf(pairs)];
    if (pair) showFaces([lookup(pair.a)], pair.tile, lookup(pair.b));
    else view.showHighlight();
  });
  previous.addEventListener("click", () => { islandPage--; renderDensity(); });
  next.addEventListener("click", () => { islandPage++; renderDensity(); });
  tilesInput.addEventListener("change", clearReport);
  element("download-uv-report").addEventListener("click", downloadReport);
  return {
    setSource(value: Source) {
      source = value;
      panel.hidden = false;
      clearReport();
    },
    selectionChanged: clearReport,
    tileChanged() { if (!tilesInput.value.trim()) clearReport(); },
  };
}
