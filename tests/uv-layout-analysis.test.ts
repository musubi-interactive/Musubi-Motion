import { describe, expect, it } from "vitest";
import { ANALYSIS_LIMITS, analyzeUVLayout, texelDensity } from "../src/uv-layout/analysis.ts";
import { parseObjUVLayout, type Position, type UVPoint } from "../src/uv-layout/obj.ts";

const origin = { u: 0, v: 0 };
const triangle: UVPoint[] = [[0, 0], [1, 0], [0, 1]];
const quad: UVPoint[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

function fixture(faces: { uv: UVPoint[]; vertices?: Position[]; name?: string }[]) {
  let offset = 1, name: string | undefined;
  const statements: string[] = [];
  for (const face of faces) {
    if (face.name !== name) {
      name = face.name;
      statements.push(`o ${name ?? "Default object"}`);
    }
    const vertices = face.vertices ?? face.uv.map(([x, y]): Position => [x, y, 0]);
    statements.push(...vertices.map(v => `v ${v.join(" ")}`), ...face.uv.map(uv => `vt ${uv.join(" ")}`));
    statements.push("f " + face.uv.map((_, i) => `${i + offset}/${i + offset}`).join(" "));
    offset += face.uv.length;
  }
  return parseObjUVLayout(statements.join("\n"));
}

describe("OBJ UV diagnostics", () => {
  it("measures rotated 3D area with area-weighted summaries and scale-aware outlier densities", () => {
    const layout = fixture([
      { uv: quad, vertices: [[0, 0, 0], [0, 2, 0], [0, 2, 2], [0, 0, 2]] },
      { uv: quad, vertices: [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]] },
      { uv: quad, name: "Third object" },
    ]);
    const input = JSON.stringify(layout);
    const result = analyzeUVLayout(layout, [0], [origin]);
    expect(result.objects).toHaveLength(1);
    const [object] = result.objects;
    expect(object).toMatchObject({ faces: 2, uvArea: 2, sourceArea: 20, outlierCount: 1 });
    expect(texelDensity(object, 1024, 1)).toBeCloseTo(1024 / Math.sqrt(10));
    expect(object.islands.map(island => texelDensity(island, 2048, 2))).toEqual([512, 256]);
    expect(object.outliers[0].densityRatio * texelDensity(object, 1024, 1)!).toBeCloseTo(512);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].area).toBeCloseTo(1);
    expect(JSON.stringify(layout)).toBe(input);
  });

  it("keeps texture seams as separate islands and only proves positive-area face intersections", () => {
    const layout = parseObjUVLayout([
      "v 0 0 0", "v 1 0 0", "v 0 1 0", "v 1 1 0", "v 2 1 0", "v 1 2 0",
      "vt 0 0", "vt 1 0", "vt 0 1", "vt 1 1", "vt 2 1", "vt 1 2", "vt 1 0", "vt 0 1",
      "f 1/1 2/2 3/3", "f 2/2 4/4 3/3", "f 3/8 2/7 1/1", "f 4/4 5/5 6/6",
    ].join("\n"));
    expect(layout.objects[0].mappedFaces.map(face => face.island)).toEqual([1, 1, 2, 3]);
    const { pairs, truncated } = analyzeUVLayout(layout, [0], [origin, { u: 1, v: 1 }]);
    expect(truncated).toBeNull();
    expect(pairs.map(({ a, b, area }) => [a.face, b.face, area])).toEqual([[0, 2, 0.5]]);
  });

  it("ignores vertex-only contact and contact below the reported overlap tolerance", () => {
    const layout = fixture([
      { uv: [[0, 0], [.4, 0], [0, .4]] },
      { uv: [[.4, 0], [.8, 0], [.4, .4]] },
      { uv: [[.4 - 1e-6, 0], [.4, -.01], [.8, .4]] },
    ]);
    expect(analyzeUVLayout(layout, [0], [origin]).pairs.map(pair => [pair.a.face, pair.b.face])).toEqual([[1, 2]]);
  });

  it("triangulates concavity without counting the notch and clips face pairs to each signed tile", () => {
    const concave: UVPoint[] = [[0, 0], [2, 0], [2, .5], [.5, .5], [.5, 1], [0, 1]];
    const move = (points: UVPoint[]): UVPoint[] => points.map(([x, y]) => [x - 1, y - 2]);
    const layout = fixture([
      { uv: move(concave) },
      { uv: move(concave).reverse() },
      { uv: move([[.75, .75], [1, .75], [.75, .875]]) },
    ]);
    const tiles = [{ u: -1, v: -2 }, { u: 0, v: -2 }, { u: 1, v: -2 }];
    const result = analyzeUVLayout(layout, [0], [...tiles, tiles[0]]);
    expect(result.pairs).toHaveLength(2);
    expect(result.pairs.map(({ tile, area }) => [tile, area])).toEqual([[tiles[0], .75], [tiles[1], .5]]);
    expect(result.objects[0].islands[0].sourceArea).toBeCloseTo(1.25);
  });

  it("reports invalid or unsupported geometry independently of proven overlap", () => {
    const ring = Array.from({ length: 65 }, (_, i): UVPoint => [Math.cos(i * Math.PI / 32), Math.sin(i * Math.PI / 32)]);
    const result = analyzeUVLayout(fixture([
      { uv: quad, vertices: [[0, 0, 0], [1, 0, 0], [1, 1, .01], [0, 1, 0]] },
      { uv: quad, vertices: [[0, 0, 0], [1, 1, 0], [1, 0, 0], [0, 1, 0]] },
      { uv: [[0, 0], [1, 1], [1, 0], [0, 1]], vertices: quad.map(([x, y]) => [x, y, 0]) },
      { uv: triangle, vertices: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] },
      { uv: [[0, 0], [.5, .5], [1, 1]], vertices: [[0, 0, 0], [1, 0, 0], [2, 1, 0]] },
      { uv: ring },
      { uv: quad },
    ]), [0], [origin]);
    expect(result.objects[0]).toMatchObject({
      faces: 1, issues: { tooManyCorners: 1, zeroSourceArea: 1, zeroUVArea: 1, nonplanar: 1, selfIntersecting: 2 },
    });
    expect(result.pairs).toEqual([]);
  });

  it("flags missing UV faces, maintains finite density for tiny valid source polygons, and rejects invalid tile requests", () => {
    const layout = parseObjUVLayout([
      "v 0 0 0", "v 1e-160 0 0", "v 0 1e-160 0", "vt 0 0", "vt 1 0", "vt 0 1", "f 1/1 2/2 3/3", "f 1 2 3",
    ].join("\n"));
    const result = analyzeUVLayout(layout, [0], [origin]);
    expect(result.objects[0].missingUVs).toBe(1);
    expect(texelDensity(result.objects[0], 1024, 1)! / (1024 * 1e160)).toBeCloseTo(1, 2);
    expect(() => analyzeUVLayout(layout, [0], [{ u: -1.5, v: 4 }])).toThrow(/integer/);
  });

  it("marks pair truncation only after the first omitted positive intersection", () => {
    const layout = fixture(Array.from({ length: 34 }, () => ({ uv: triangle })));
    const report = analyzeUVLayout(layout, [0], [origin]);
    expect(report.objects[0].faces).toBe(34);
    expect(report.pairs).toHaveLength(ANALYSIS_LIMITS.pairs);
    expect(report.truncated).toBe("pair limit");
    expect(report.stats.triangleTests).toBe(ANALYSIS_LIMITS.pairs + 1);
  });

  it("stops a crowded spatial bucket before attempting quadratic candidate visits", () => {
    const layout = fixture(Array.from({ length: 2100 }, (_, i) => {
      const y = i * .00001;
      return { uv: [[0, y], [.01, y], [.01, y + .000005]] };
    }));
    const result = analyzeUVLayout(layout, [0], [origin]);
    expect(result.truncated).toBe("candidate budget");
    expect(result.stats).toEqual({ candidateVisits: ANALYSIS_LIMITS.candidateVisits, triangleTests: 0 });
    expect(result.pairs).toEqual([]);
  });

  it("stops exact intersection work at its triangle budget even without any true overlap", () => {
    const layout = fixture(Array.from({ length: 1500 }, (_, i) => {
      const y = i * .00007;
      return { uv: [[0, y], [.7, .7 + y], [.7, .7 + y + .00001]] };
    }));
    const result = analyzeUVLayout(layout, [0], [origin]);
    expect(result.truncated).toBe("triangle budget");
    expect(result.stats.triangleTests).toBe(ANALYSIS_LIMITS.triangleTests);
    expect(result.pairs).toEqual([]);
  }, 10000);
});
