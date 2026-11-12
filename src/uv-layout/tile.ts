import type { UVLayout, UVPoint } from "./obj.ts";

export type Tile = { u: number; v: number };
export type Segment = [x1: number, y1: number, x2: number, y2: number];
export const MAX_TILE = 1_000_000;

export function tileLabel({ u, v }: Tile): string {
  return u >= 0 && u <= 9 && v >= 0 ? `UDIM ${1001 + u + 10 * v}` : `Tile ${u}, ${v}`;
}

function* selectedEdges(layout: UVLayout, selected: ReadonlySet<number>, bordersOnly: boolean) {
  for (const [index, object] of layout.objects.entries()) {
    if (!selected.has(index)) continue;
    for (const edge of object.edges) {
      if (!bordersOnly || edge.uses !== 2) yield edge;
    }
  }
}

export function firstMappedTile(layout: UVLayout, selected: ReadonlySet<number>, bordersOnly: boolean): Tile | undefined {
  for (const edge of selectedEdges(layout, selected, bordersOnly)) {
    const start = layout.coordinates[edge.start], end = layout.coordinates[edge.end];
    if (start[0] === end[0] && start[1] === end[1]) continue;
    const midpoint: UVPoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    // The midpoint can round to an endpoint exactly on a tile boundary.
    for (const [u, v] of [midpoint, start, end]) {
      const tile = { u: Math.floor(u), v: Math.floor(v) };
      if (clipSegment(start, end, tile)) return tile;
    }
  }
}

function clipSegment(start: UVPoint, end: UVPoint, { u, v }: Tile): Segment | undefined {
  const x = start[0] - u, y = start[1] - v;
  const dx = end[0] - start[0], dy = end[1] - start[1];
  let enter = 0, exit = 1;
  for (const [offset, delta] of [[x, dx], [y, dy]]) {
    if (delta === 0) {
      if (offset < 0 || offset > 1) return;
    } else {
      const a = -offset / delta, b = (1 - offset) / delta;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
    }
  }
  if (enter >= exit || (dx === 0 && dy === 0)) return;
  // Remove only floating-point overshoot after clipping the source line.
  const unit = (value: number) => Math.min(1, Math.max(0, value));
  return [unit(x + enter * dx), unit(y + enter * dy), unit(x + exit * dx), unit(y + exit * dy)];
}

export function tileSegments(layout: UVLayout, selected: ReadonlySet<number>, tile: Tile, bordersOnly: boolean): Segment[] {
  if (![tile.u, tile.v].every(value => Number.isInteger(value) && Math.abs(value) <= MAX_TILE)) {
    throw Error("UV tiles require integer U and V coordinates within ±1,000,000.");
  }
  const segments: Segment[] = [];
  for (const edge of selectedEdges(layout, selected, bordersOnly)) {
    const line = clipSegment(layout.coordinates[edge.start], layout.coordinates[edge.end], tile);
    if (line) segments.push(line);
  }
  return segments;
}

export function drawTile(canvas: HTMLCanvasElement, segments: readonly Segment[], color: string,
  preview?: { checker: boolean; dark: boolean }): void {
  const context = canvas.getContext("2d");
  if (!context) throw Error("A Canvas 2D context is unavailable.");
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  if (preview) {
    context.fillStyle = preview.dark ? "#252525" : "#f3f3f3";
    context.fillRect(0, 0, width, height);
    if (preview.checker) {
      context.fillStyle = preview.dark ? "#303030" : "#dedede";
      for (let row = 0; row < 8; row++) {
        for (let column = row % 2; column < 8; column += 2) {
          context.fillRect(column * width / 8, row * height / 8, width / 8, height / 8);
        }
      }
    }
  }
  context.beginPath();
  for (const [x1, y1, x2, y2] of segments) {
    context.moveTo(x1 * width, (1 - y1) * height);
    context.lineTo(x2 * width, (1 - y2) * height);
  }
  context.strokeStyle = color;
  context.lineWidth = preview ? 1.35 * width / Math.max(1, canvas.clientWidth) : Math.max(1.5, width / 512);
  context.lineCap = "round";
  context.stroke();
}
