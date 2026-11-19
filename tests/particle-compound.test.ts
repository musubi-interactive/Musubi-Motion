import { describe, expect, it } from "vitest";
import { BURST_FPS, compileBurst, defaultRecipe } from "../src/particle-burst/burst.ts";
import {
  MAX_COMPOUND_BIRTHS, MAX_COMPOUND_BYTES, MAX_STAGES, compileCompound, exampleRecipe,
  parseCompoundRecipe, totalBirths, type BurstStage,
} from "../src/particle-burst/compound.ts";
import { encodeBurstPly } from "../src/particle-burst/ply.ts";

const compound = (...stages: BurstStage[]) => ({ version: 2 as const, stages });
const first = exampleRecipe.stages[0];
const second = exampleRecipe.stages[1];

describe("compound particle burst recipes", () => {
  it("round-trips the original example and upgrades a valid single emitter without changing its bake", async () => {
    expect(parseCompoundRecipe(JSON.parse(JSON.stringify(exampleRecipe)))).toEqual(exampleRecipe);
    const v1 = { ...defaultRecipe, seed: 522 };
    const upgraded = parseCompoundRecipe(v1);
    expect(upgraded).toEqual(compound({ id: "burst", name: "Burst", enabled: true, startTime: 0, burst: v1 }));
    const bake = await encodeBurstPly(compileCompound(upgraded).sample(10.5)).arrayBuffer();
    expect(bake).toEqual(await encodeBurstPly(compileBurst(v1).sample(10.5)).arrayBuffer());
  });

  it("rejects unsupported versions, missing/foreign fields, duplicate IDs and invalid stage values", () => {
    expect(() => parseCompoundRecipe({ version: 3 })).toThrow("Unsupported particle recipe version");
    expect(() => parseCompoundRecipe({ ...exampleRecipe, stray: true })).toThrow("stages list");
    expect(() => parseCompoundRecipe(compound())).toThrow("between 1 and");
    expect(() => parseCompoundRecipe({ version: 2, stages: Array(1) })).toThrow("fields do not match");
    expect(() => parseCompoundRecipe(compound(first, { ...second, id: first.id }))).toThrow("unique stage ID");
    expect(() => parseCompoundRecipe(compound({ ...first, extra: 1 }))).toThrow("fields do not match");
    expect(() => parseCompoundRecipe(compound({ ...first, name: "   " }))).toThrow("name");
    expect(() => parseCompoundRecipe(compound({ ...first, name: "A\nB" }))).toThrow("control characters");
    expect(() => parseCompoundRecipe(compound({ ...first, enabled: 1 } as unknown as BurstStage))).toThrow("enabled");
    expect(() => parseCompoundRecipe(compound({ ...first, startTime: Number.NaN }))).toThrow("start time");
    expect(() => parseCompoundRecipe(compound({ ...first, burst: { ...first.burst, seed: 1.25 } }))).toThrow("Stage 1: Seed");
  });

  it("bounds all births including disabled stages and reuses one bounded seek buffer", () => {
    const stages = Array.from({ length: MAX_STAGES }, (_, index) => ({
      ...second, id: "stage-" + index, name: "⭐".repeat(20),
      startTime: 0, burst: { ...second.burst, count: MAX_COMPOUND_BIRTHS / MAX_STAGES, duration: 0 },
    }));
    const recipe = compound(...stages);
    expect(totalBirths(stages)).toBe(MAX_COMPOUND_BIRTHS);
    expect(new TextEncoder().encode(JSON.stringify(recipe, null, 2)).length).toBeLessThan(MAX_COMPOUND_BYTES);
    const baked = compileCompound(recipe);
    const start = baked.sample(0);
    expect(start.count).toBe(MAX_COMPOUND_BIRTHS);
    expect(start.positions.byteLength + start.colors.byteLength + start.diameters.byteLength + start.opacities.byteLength)
      .toBe(MAX_COMPOUND_BIRTHS * 32);
    expect(baked.sample(12.25)).toBe(start);
    expect(() => parseCompoundRecipe(compound(...stages, { ...first }))).toThrow("between 1 and");
    const disabledOverBudget = { ...stages[0], enabled: false, burst: { ...stages[0].burst, count: stages[0].burst.count + 1 } };
    expect(() => compileCompound(compound(disabledOverBudget, ...stages.slice(1)))).toThrow("All stages combined");
  });
});

describe("compound particle burst sampling", () => {
  it("includes exact births and excludes exact deaths for a fractional stage offset", async () => {
    const stage = {
      ...first, startTime: 0.39,
      burst: { ...first.burst, count: 2, duration: 0.08, lifetime: 0.2, deathOpacity: 0.5 },
    };
    const { startTime, burst } = stage;
    const birth = startTime * BURST_FPS;
    const lastBirth = (startTime + burst.duration) * BURST_FPS;
    const death = (startTime + burst.lifetime) * BURST_FPS;
    const lastDeath = (startTime + burst.duration + burst.lifetime) * BURST_FPS;
    const recipe = compound(stage);
    const sample = compileCompound(recipe);
    expect([birth - 1e-10, birth, lastBirth, death, lastDeath - 1e-10, lastDeath, sample.lastFrame].map(frame => sample.sample(frame).count))
      .toEqual([0, 1, 2, 1, 1, 0, 0]);
    expect(() => encodeBurstPly(sample.sample(sample.lastFrame))).toThrow("No visible");
    const cold = await encodeBurstPly(compileCompound(recipe).sample(lastBirth)).arrayBuffer();
    expect(await encodeBurstPly(sample.sample(lastBirth)).arrayBuffer()).toEqual(cold);
    expect(() => sample.sample(-1)).toThrow("timeline");
    expect(() => sample.sample(Infinity)).toThrow("timeline");
  });

  it("writes stages in authored order and keeps their samples stable across unrelated edits", async () => {
    const frame = 9.75;
    const original = compileCompound(compound(first, second));
    const stageRows = (target: typeof original, id: string) => {
      const snapshot = target.sample(frame, id);
      return [...snapshot.positions.subarray(0, snapshot.count * 3)];
    };
    const firstRows = stageRows(original, first.id);
    const secondRows = stageRows(original, second.id);
    const all = original.sample(frame);
    expect([...all.positions.subarray(0, all.count * 3)]).toEqual([...firstRows, ...secondRows]);

    const renamed = { ...second, name: "Revised sparks", burst: { ...second.burst, seed: second.burst.seed + 1 } };
    const edited = compileCompound(compound(renamed, first));
    expect(stageRows(edited, first.id)).toEqual(firstRows);
    const editedSecondRows = stageRows(edited, second.id);
    expect(editedSecondRows).not.toEqual(secondRows);
    const reordered = edited.sample(frame);
    expect([...reordered.positions.subarray(0, reordered.count * 3)]).toEqual([...editedSecondRows, ...firstRows]);
    expect(await encodeBurstPly(edited.sample(frame, first.id)).arrayBuffer())
      .toEqual(await encodeBurstPly(original.sample(frame, first.id)).arrayBuffer());
  });

  it("solos the requested stage, including disabled stages, without affecting the composed bake", async () => {
    const target = compileCompound(compound(first, { ...second, enabled: false }));
    const before = await encodeBurstPly(target.sample(9.75)).arrayBuffer();
    expect(target.sample(9.75, second.id).count).toBeGreaterThan(first.burst.count);
    expect(await encodeBurstPly(target.sample(9.75)).arrayBuffer()).toEqual(before);
    expect(target.sample(9.75).count).toBe(first.burst.count);
    expect(target.sample(9.75, "missing").count).toBe(0);
  });
});
