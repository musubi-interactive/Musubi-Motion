import type { ComponentPickPoint as Point } from "./component-picking.ts";
import type { SplatSelectionOperation, SplatSelectionRegion } from "./splat-component-selection.ts";

export type SplatSelectionTool = "box" | "lasso" | "paint" | "sphere" | "radial";
export type SplatBrushSettings = { radius: number; spacing: number; operation: SplatSelectionOperation };
export const MAX_SPLAT_BRUSH_RADIUS = 256;
const MAX_TRACE_POINTS = 8192;
const MAX_COVERAGE_CHECKS = 12_000_000;
const coverageError = "Selection coverage is too complex. Use a shorter lasso or stroke.";

function validPoint({ x, y }: Point) {
  if (![x, y].every(value => Number.isFinite(value) && Math.abs(value) <= 1_000_000)) {
    throw Error("Selection coordinates must be finite canvas pixels.");
  }
}

function addPoint(points: Point[], point: Point) {
  const last = points.at(-1);
  if (last?.x === point.x && last.y === point.y) return;
  if (points.length >= MAX_TRACE_POINTS) throw Error("Selection gesture is too long. Use a shorter lasso or stroke.");
  points.push({ x: point.x, y: point.y });
}

export function createSplatLasso(start: Point) {
  validPoint(start);
  const points: Point[] = [{ ...start }];
  return {
    points,
    add(point: Point) { validPoint(point); addPoint(points, point); },
  };
}

/** CSS-pixel dabs spaced by arc length, independent of pointer event frequency. */
export function createSplatBrushStroke(start: Point, radius: number, spacing: number) {
  validPoint(start);
  if (!Number.isFinite(radius) || radius < 1 || radius > MAX_SPLAT_BRUSH_RADIUS ||
      !Number.isFinite(spacing) || spacing < 1 || spacing > radius) {
    throw Error("Use a brush radius from 1 to 256 px and spacing from 1 px up to the radius.");
  }
  const points: Point[] = [{ ...start }];
  let last = { ...start }, untilNext = spacing;
  function add(point: Point) {
    validPoint(point);
    const dx = point.x - last.x, dy = point.y - last.y, length = Math.hypot(dx, dy);
    if (length === 0) return;
    let step = untilNext;
    for (; step <= length; step += spacing) {
      addPoint(points, { x: last.x + dx * (step / length), y: last.y + dy * (step / length) });
    }
    untilNext = step - length;
    last = { ...point };
  }
  return { points, add, finish(point: Point) { add(point); addPoint(points, point); } };
}

function bounds(points: readonly Point[]) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const { x, y } of points) {
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { left, right, top, bottom };
}

/** Even-odd interior, including edges. A short or collinear trace is a no-op. */
export function splatLassoRegion(points: readonly Point[]): SplatSelectionRegion | undefined {
  if (points.length < 3) return;
  const origin = points[0];
  const axis = points.find(point => point.x !== origin.x || point.y !== origin.y);
  if (!axis || points.every(point => (axis.x - origin.x) * (point.y - origin.y) === (axis.y - origin.y) * (point.x - origin.x))) return;
  const { left, right, top, bottom } = bounds(points);
  // Only compare edges spanning the point's vertical band. Thin polygons retain their exact edges.
  type Edge = { a: Point; dx: number; dy: number; left: number; right: number; top: number; bottom: number; tolerance: number };
  const bands: Edge[][] = Array.from({ length: 64 }, () => []);
  const band = (y: number) => Math.min(bands.length - 1, Math.floor((y - top) / (bottom - top) * bands.length));
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    if (!dx && !dy) continue;
    const edge = { a, dx, dy, left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y),
      tolerance: 1e-9 * Math.max(1, Math.abs(dx), Math.abs(dy)) };
    const end = band(edge.bottom);
    for (let row = band(edge.top); row <= end; row++) bands[row].push(edge);
  }
  let checks = 0;
  return (x, y) => {
    if (x < left || x > right || y < top || y > bottom) return false;
    let inside = false;
    const edges = bands[band(y)];
    checks += edges.length;
    if (checks > MAX_COVERAGE_CHECKS) throw Error(coverageError);
    for (const edge of edges) {
      if (y < edge.top || y > edge.bottom) continue;
      const { a, dx, dy } = edge;
      if (x >= edge.left && x <= edge.right && Math.abs(dx * (y - a.y) - dy * (x - a.x)) <= edge.tolerance) return true;
      if (y < edge.bottom && x < a.x + dx * (y - a.y) / dy) inside = !inside;
    }
    return inside;
  };
}

/** Queries the union of dabs. Each projected component is visited once, even on overlapping passes. */
export function splatBrushRegion(points: readonly Point[], radius: number): SplatSelectionRegion {
  if (!Number.isFinite(radius) || radius < 1 || radius > MAX_SPLAT_BRUSH_RADIUS) throw Error("Use a brush radius from 1 to 256 px.");
  const { left, right, top, bottom } = bounds(points), radiusSquared = radius ** 2;
  const buckets = new Map<number, Map<number, Point[]>>();
  const unique = new Set<string>();
  const cell = (value: number) => Math.floor(value / radius);
  for (const point of points) {
    const key = `${point.x}/${point.y}`;
    if (unique.has(key)) continue;
    unique.add(key);
    const row = cell(point.y), column = cell(point.x);
    let columns = buckets.get(row);
    if (!columns) buckets.set(row, columns = new Map());
    let bucket = columns.get(column);
    if (!bucket) columns.set(column, bucket = []);
    bucket.push(point);
  }
  let checks = 0;
  return (x, y) => {
    if (x < left - radius || x > right + radius || y < top - radius || y > bottom + radius) return false;
    const firstColumn = cell(x - radius), lastColumn = cell(x + radius), lastRow = cell(y + radius);
    for (let row = cell(y - radius); row <= lastRow; row++) {
      const columns = buckets.get(row);
      if (!columns) continue;
      for (let column = firstColumn; column <= lastColumn; column++) {
        const bucket = columns.get(column);
        if (!bucket) continue;
        for (const point of bucket) {
          if (++checks > MAX_COVERAGE_CHECKS) throw Error(coverageError);
          if ((x - point.x) ** 2 + (y - point.y) ** 2 <= radiusSquared) return true;
        }
      }
    }
    return false;
  };
}

/** Noninteractive coverage and cursor. The document and selected IDs are untouched during a drag. */
export function createSplatGestureOverlay(host: HTMLElement) {
  const svg = "http://www.w3.org/2000/svg";
  const surface = document.createElementNS(svg, "svg");
  surface.classList.add("splat-gesture-preview");
  surface.setAttribute("aria-hidden", "true");
  Object.assign(surface.style, { position: "absolute", pointerEvents: "none", zIndex: "3", display: "none" });
  const lassoFill = document.createElementNS(svg, "path"), lassoOutline = document.createElementNS(svg, "path");
  lassoFill.setAttribute("fill", "var(--text)");
  lassoFill.setAttribute("fill-opacity", ".13");
  lassoFill.setAttribute("fill-rule", "evenodd");
  lassoFill.setAttribute("stroke", "#161616");
  lassoFill.setAttribute("stroke-width", "3");
  lassoOutline.setAttribute("fill", "none");
  lassoOutline.setAttribute("stroke", "#fff");
  const brush = document.createElementNS(svg, "g");
  brush.setAttribute("fill", "var(--text)");
  brush.setAttribute("opacity", ".25");
  surface.append(lassoFill, lassoOutline, brush);
  const cursor = document.createElement("div");
  cursor.className = "splat-brush-cursor";
  cursor.setAttribute("aria-hidden", "true");
  Object.assign(cursor.style, { position: "absolute", pointerEvents: "none", zIndex: "4", boxSizing: "border-box",
    border: "1px solid white", borderRadius: "50%", boxShadow: "0 0 0 1px #171717", transform: "translate(-50%, -50%)" });
  cursor.hidden = true;
  host.append(surface, cursor);
  let painted = 0, brushPath: SVGPathElement | undefined, brushData = "";
  return {
    begin(rect: DOMRect) {
      const container = host.getBoundingClientRect();
      painted = 0; brushPath = undefined; brushData = "";
      lassoFill.removeAttribute("d"); lassoOutline.removeAttribute("d"); brush.replaceChildren();
      Object.assign(surface.style, { left: `${rect.left - container.left}px`, top: `${rect.top - container.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`, display: "block" });
    },
    lasso(points: readonly Point[]) {
      const path = `M${points.map(point => `${point.x},${point.y}`).join("L")}Z`;
      lassoFill.setAttribute("d", path);
      lassoOutline.setAttribute("d", path);
    },
    paint(points: readonly Point[], radius: number) {
      if (painted === points.length) return;
      // Keep completed groups immutable so a long stroke never rebuilds the full SVG path.
      for (; painted < points.length; painted++) {
        if (painted % 64 === 0) {
          brushPath?.setAttribute("d", brushData);
          brushPath = document.createElementNS(svg, "path");
          brush.append(brushPath); brushData = "";
        }
        const { x, y } = points[painted];
        brushData += `M${x - radius},${y}a${radius},${radius},0,1,0,${radius * 2},0a${radius},${radius},0,1,0,${-radius * 2},0Z`;
      }
      brushPath?.setAttribute("d", brushData);
    },
    showCursor(clientX: number, clientY: number, radius: number) {
      const rect = host.getBoundingClientRect();
      Object.assign(cursor.style, { left: `${clientX - rect.left}px`, top: `${clientY - rect.top}px`,
        width: `${radius * 2}px`, height: `${radius * 2}px` });
      cursor.hidden = false;
    },
    hideCursor() { cursor.hidden = true; },
    clear() { surface.style.display = "none"; cursor.hidden = true; },
  };
}
