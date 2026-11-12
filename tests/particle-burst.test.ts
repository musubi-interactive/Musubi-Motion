import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { compileBurst, defaultRecipe, lastBurstFrame, parseRecipe } from "../src/particle-burst/burst.ts";
import { encodeBurstPly, PLY_FIELDS, SH_DC } from "../src/particle-burst/ply.ts";

const single = {
  ...defaultRecipe, count: 1, duration: 0, lifetime: 2, speed: 4, speedVariation: 0, gravity: 2, spread: 0,
  elevation: 90, azimuth: 0, originX: 2, originY: 3, originZ: -4,
  birthDiameter: 0.2, deathDiameter: 0.4, birthOpacity: 0.75, deathOpacity: 0.25,
  birthColor: "#ff0000", deathColor: "#0000ff",
};

describe("particle burst recipes", () => {
  it("round-trips saved recipes with fractional angles and rejects unknown, malformed or oversized fields", () => {
    const recipe = { ...defaultRecipe, azimuth: 18.5, spread: 0.25, seed: 0xffffffff };
    expect(parseRecipe(JSON.parse(JSON.stringify(recipe)))).toEqual(recipe);
    expect(() => parseRecipe({ ...recipe, version: 2 })).toThrow("version 1");
    expect(() => parseRecipe({ ...recipe, extra: 1 })).toThrow("fields");
    const { lifetime, ...missing } = recipe;
    expect(() => parseRecipe({ ...missing, extra: 1 })).toThrow("Lifetime");
    expect(() => parseRecipe({ ...recipe, count: 12001 })).toThrow("Count");
    expect(() => parseRecipe({ ...recipe, count: 1.1 })).toThrow("integer");
    expect(() => parseRecipe({ ...recipe, seed: -1 })).toThrow("Seed");
    expect(() => parseRecipe({ ...recipe, gravity: Infinity })).toThrow("Gravity");
    expect(() => parseRecipe({ ...recipe, birthColor: "#ABC" })).toThrow("hex");
  });

  it("evaluates known world-space positions and shading at an absolute time", () => {
    const burst = compileBurst(single);
    const snapshot = burst.sample(24);
    expect(snapshot.count).toBe(1);
    expect([...snapshot.positions]).toEqual([2, 6, -4]);
    expect([...snapshot.colors]).toEqual([0.5, 0, 0.5]);
    expect(snapshot.diameters[0]).toBeCloseTo(0.3);
    expect(snapshot.opacities[0]).toBe(0.5);
    expect(burst.sample(0).count).toBe(1);
    expect(burst.sample(48).count).toBe(0);
    expect(() => burst.sample(NaN)).toThrow("timeline");
    expect(() => burst.sample(-1)).toThrow("timeline");
  });

  it("uses the seed and returns identical PLY bytes after forward and backward seeks", async () => {
    const burst = compileBurst(defaultRecipe);
    const first = Buffer.from(await encodeBurstPly(burst.sample(18)).arrayBuffer());
    burst.sample(55);
    burst.sample(2);
    expect(Buffer.compare(Buffer.from(await encodeBurstPly(burst.sample(18)).arrayBuffer()), first)).toBe(0);
    const different = compileBurst({ ...defaultRecipe, seed: defaultRecipe.seed + 1 });
    expect(Buffer.compare(Buffer.from(await encodeBurstPly(different.sample(18)).arrayBuffer()), first)).not.toBe(0);
  });

  it("stages births across the authored duration and removes all particles at the end", () => {
    const recipe = { ...defaultRecipe, duration: 1, lifetime: 2, count: 5 };
    const burst = compileBurst(recipe);
    expect([0, 6, 12, 18, 24, 48, 72].map(frame => burst.sample(frame).count)).toEqual([1, 2, 3, 4, 5, 4, 0]);
    const fractional = { ...recipe, duration: 0.9, lifetime: 1.1 };
    expect(compileBurst(fractional).sample(lastBurstFrame(fractional)).count).toBe(0);
  });

  it("excludes the final particle at its exact death frame even with nonzero end opacity", () => {
    const recipe = { ...defaultRecipe, count: 4, duration: 0.8, lifetime: 0.2, deathOpacity: 0.5 };
    const burst = compileBurst(recipe);
    const end = lastBurstFrame(recipe);
    expect(end).toBe(24);
    expect(burst.sample(end - 2 ** -48).count).toBe(1);
    const terminal = burst.sample(end);
    expect(terminal.count).toBe(0);
    expect(() => encodeBurstPly(terminal)).toThrow("No visible");
  });

  it("handles full sphere and sustained maximum count with finite samples", () => {
    const recipe = { ...defaultRecipe, spread: 180, duration: 0, count: 12000, gravity: 0 };
    const snapshot = compileBurst(recipe).sample(24);
    expect(snapshot.count).toBe(12000);
    expect(snapshot.positions.every(Number.isFinite)).toBe(true);
    expect(Math.min(...snapshot.positions)).toBeLessThan(-4);
    expect(Math.max(...snapshot.positions)).toBeGreaterThan(4);
  });

  it("drops particles with non-renderable diameter or opacity before encoding", () => {
    for (const recipe of [
      { ...single, birthDiameter: Number.MIN_VALUE, deathDiameter: Number.MIN_VALUE },
      { ...single, birthOpacity: 0, deathOpacity: 0 },
    ]) {
      const snapshot = compileBurst(recipe).sample(24);
      expect(snapshot.count).toBe(0);
      expect(() => encodeBurstPly(snapshot)).toThrow("No visible");
    }
  });
});

it("writes interoperable little-endian Gaussian PLY semantics", async () => {
  const bytes = new Uint8Array(await encodeBurstPly(compileBurst(single).sample(24)).arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const end = text.indexOf("end_header\n") + "end_header\n".length;
  expect(text.slice(0, end).split("\n")).toEqual([
    "ply", "format binary_little_endian 1.0", "element vertex 1",
    ...PLY_FIELDS.map(field => "property float " + field), "end_header", "",
  ]);
  expect(bytes.length - end).toBe(68);
  const view = new DataView(bytes.buffer, end);
  const floats = Array.from({ length: 17 }, (_, i) => view.getFloat32(i * 4, true));
  expect(floats.slice(0, 6)).toEqual([2, 6, -4, 0, 0, 0]);
  expect(floats.slice(6, 9).map(value => value * SH_DC + 0.5)).toEqual([0.5, expect.closeTo(0, 6), 0.5]);
  expect(1 / (1 + Math.exp(-floats[9]))).toBe(0.5);
  for (const logScale of floats.slice(10, 13)) expect(Math.exp(logScale)).toBeCloseTo(0.15, 6);
  expect(floats.slice(13)).toEqual([1, 0, 0, 0]);
});
