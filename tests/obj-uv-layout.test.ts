import { describe, expect, it } from "vitest";
import { parseObjUVLayout } from "../src/uv-layout/obj.ts";
import { firstMappedTile, tileLabel, tileSegments } from "../src/uv-layout/tile.ts";

const vertices = [
  "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "v -1 0.5 0", "v 0 -1 0",
].join("\n");
const polygon = [
  "vt .125 .125", "vt .625 .125", "vt .625 .625", "vt .125 .875", "vt 0 .5",
  "vt .375 0", "vn 0 0 1",
].join("\n");

describe("Wavefront OBJ UV layout", () => {
  it("retains n-gon borders, seams, separate corner indices and shared-edge islands", () => {
    const source = [
      vertices, polygon, "o Shell",
      "f 1/1/1 2/2/1 3/3/1 \\", "  4/4/1 5/5/1 # polygon continued",
      "f -5/-5/-1 -6/-6/-1 -1/-1/-1",
      "vt .625 .125", "vt .625 .625",
      "f 3/8 2/7 6/6", // Same UV values but independent OBJ corner identities.
      "f 3//1 4/4/1 5/5/1",
      "o Separate shell", "f 1/1 2/2 3/3",
    ].join("\r\n");
    const layout = parseObjUVLayout("\uFEFF" + source);
    expect(layout.objects.map(({ name, faces, islands, missing, degenerate, outside, edges }) =>
      ({ name, faces, islands, missing, degenerate, outside, edges: edges.length }))).toEqual([
      { name: "Shell", faces: 4, islands: 2, missing: 1, degenerate: 0, outside: 0, edges: 10 },
      { name: "Separate shell", faces: 1, islands: 1, missing: 0, degenerate: 0, outside: 0, edges: 3 },
    ]);
    expect(layout.objects[0].edges.filter(edge => edge.uses === 2)).toEqual([{ start: 0, end: 1, uses: 2 }]);
    expect(tileSegments(layout, new Set([0]), { u: 0, v: 0 }, false)).toHaveLength(10);
    expect(tileSegments(layout, new Set([0]), { u: 0, v: 0 }, true)).toHaveLength(9);
  });

  it("clips to requested positive and negative tiles without changing source coordinates", () => {
    const layout = parseObjUVLayout([
      vertices, "vt -.75 .25", "vt 1.75 .25", "vt .5 .75", "f 1/1 2/2 3/3",
    ].join("\n"));
    const selected = new Set([0]);
    for (const u of [-1, 0, 1]) {
      const lines = tileSegments(layout, selected, { u, v: 0 }, false);
      expect(lines).toHaveLength(2 + Number(u === 0));
      expect(lines.flat().every(value => value >= 0 && value <= 1)).toBe(true);
    }
    expect(tileSegments(layout, selected, { u: 0, v: 0 }, false)[0]).toEqual([0, .25, 1, .25]);
    expect(tileSegments(layout, selected, { u: 3, v: 0 }, false)).toEqual([]);
    expect(tileSegments(layout, selected, { u: 0, v: 0 }, false)[0]).toEqual([0, .25, 1, .25]);
    expect(layout.coordinates).toEqual([[-.75, .25], [1.75, .25], [.5, .75]]);
    expect(layout.objects[0].outside).toBe(1);
    expect(firstMappedTile(layout, selected, false)).toEqual({ u: 0, v: 0 });
    expect(firstMappedTile(layout, new Set(), false)).toBeUndefined();
    expect(tileLabel({ u: 9, v: 1 })).toBe("UDIM 1020");
    expect(tileLabel({ u: -1, v: 0 })).toBe("Tile -1, 0");
    expect(() => tileSegments(layout, selected, { u: 0.1, v: 0 }, false)).toThrow(/integer/);
  });

  it("accepts optional UV components, marks near-zero area and keeps usable geometry", () => {
    const layout = parseObjUVLayout([
      vertices, "vt .2", "vt .4 0", "vt .6 0 .9", "vt .8 .8", "f 1/1 2/2 3/3", "f 3/3 2/2 4/4",
      "o No UVs", "f 1 2 3",
    ].join("\n"));
    expect(layout.objects[0]).toMatchObject({ islands: 1, degenerate: 1, missing: 0 });
    expect(layout.objects[1]).toMatchObject({ islands: 0, degenerate: 0, missing: 1, edges: [] });
    expect(firstMappedTile(layout, new Set([1]), false)).toBeUndefined();
  });

  it("jumps to a visible edge when an interior diagonal crosses an empty border tile", () => {
    const layout = parseObjUVLayout([
      vertices, "vt -1 -1", "vt 2 2", "vt 2 -1", "vt -1 2", "f 1/1 2/2 3/3", "f 2/2 1/1 4/4",
    ].join("\n"));
    const selected = new Set([0]);
    const allEdges = { u: 0, v: 0 }, borders = { u: 2, v: 0 };
    expect(firstMappedTile(layout, selected, false)).toEqual(allEdges);
    expect(tileSegments(layout, selected, allEdges, false)).toEqual([[0, 0, 1, 1]]);
    expect(tileSegments(layout, selected, allEdges, true)).toEqual([]);
    expect(firstMappedTile(layout, selected, true)).toEqual(borders);
    expect(tileSegments(layout, selected, borders, true)).toEqual([[0, 1, 0, 0]]);
  });

  it("finds a visible tile for an edge whose midpoint rounds to a tile boundary", () => {
    const layout = parseObjUVLayout([
      vertices, "vt .9999999999999999 .5", "vt 1 .5", "vt .5 .75", "f 1/1 2/2 3/3",
    ].join("\n"));
    expect(firstMappedTile(layout, new Set([0]), false)).toEqual({ u: 0, v: 0 });
  });

  it.each([
    ["f 1/1 2/2 0/3", /face index/],
    ["f 1/1 2/2 -7/3", /precedes/],
    ["f 1/-7 2/2 3/3", /precedes/],
    ["f 1/1 2/7 3/3", /missing position, UV or normal/],
    ["f 1/1 2/2 3/3/2", /missing position, UV or normal/],
    ["f 1/1 2/2 3/", /Expected v/],
    ["f 1/1 2/2 3/3 \\\n", /Unfinished/],
    ["vt Infinity 0\nf 1/1 2/2 3/3", /finite coordinate/],
    ["vt 1000001 0\nf 1/1 2/2 3/3", /finite coordinate/],
    [`f ${"1/1 ".repeat(1025)}`, /1,024 corners/],
    [`o ${"a".repeat(257)}`, /Object names/],
    ["# mesh with no polygon faces", /no polygon faces/],
  ])("rejects malformed or out-of-range statement %j", (statement, message) => {
    expect(() => parseObjUVLayout([vertices, polygon, statement].join("\n"))).toThrow(message);
  });
});
