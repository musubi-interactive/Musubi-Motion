import {
  BURST_FPS, compileBurst, createBurstSnapshot, defaultRecipe, numbers, parseRecipe,
  type BurstRecipe, type BurstSnapshot,
} from "./burst.ts";

export const MAX_STAGES = 8;
export const MAX_COMPOUND_BIRTHS = numbers.count.max;
export const MAX_COMPOUND_BYTES = 16 * 1024;
export const MAX_STAGE_NAME = 48;
export const stageStart = { label: "Start time (s)", min: 0, max: 30, step: 0.05 } as const;

export type BurstStage = {
  id: string;
  name: string;
  startTime: number;
  enabled: boolean;
  burst: BurstRecipe;
};

export type CompoundRecipe = { version: 2; stages: BurstStage[] };

export const exampleRecipe: CompoundRecipe = {
  version: 2,
  stages: [
    {
      id: "flash", name: "Flash", startTime: 0, enabled: true,
      burst: {
        ...defaultRecipe, count: 18, seed: 189, duration: 0.07, lifetime: 0.45,
        spread: 180, speed: 1.6, speedVariation: 1, gravity: 0,
        birthDiameter: 0.62, deathDiameter: 0.94, birthColor: "#fff6d9", deathColor: "#e4a47a",
        birthOpacity: 0.65, deathOpacity: 0,
      },
    },
    {
      id: "sparks", name: "Sparks", startTime: 0.08, enabled: true,
      burst: {
        ...defaultRecipe, count: 320, seed: 9431, duration: 0.38, lifetime: 1.7,
        spread: 63, speed: 5.3, speedVariation: 3.6, gravity: 5,
        birthColor: "#ffd17d", deathColor: "#f96b39",
      },
    },
    {
      id: "afterburst", name: "Afterburst", startTime: 0.39, enabled: true,
      burst: {
        ...defaultRecipe, count: 110, seed: 551, duration: 0.24, lifetime: 1.05,
        originX: 0.27, originY: 0.95, originZ: -0.2, azimuth: 34, elevation: 24,
        spread: 62, speed: 2.5, speedVariation: 1.9, gravity: 2.6,
        birthDiameter: 0.12, deathDiameter: 0.055, birthColor: "#d8ebff", deathColor: "#7b91df",
      },
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFields(value: Record<string, unknown>, fields: string[]) {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

export function totalBirths(stages: readonly BurstStage[]): number {
  return stages.reduce((total, stage) => total + stage.burst.count, 0);
}

export function parseCompoundRecipe(value: unknown): CompoundRecipe {
  if (!isRecord(value)) throw Error("Expected a particle burst recipe.");
  if (value.version === 1) {
    return { version: 2, stages: [{ id: "burst", name: "Burst", startTime: 0, enabled: true, burst: parseRecipe(value) }] };
  }
  if (value.version !== 2) throw Error("Unsupported particle recipe version. Open a version 1 burst or version 2 compound recipe.");
  if (!hasFields(value, ["version", "stages"]) || !Array.isArray(value.stages)) {
    throw Error("Version 2 recipes must contain a stages list.");
  }
  if (value.stages.length === 0 || value.stages.length > MAX_STAGES) {
    throw Error("Use between 1 and " + MAX_STAGES + " stages.");
  }
  const usedIds = new Set<string>();
  const stages = Array.from(value.stages, (stage: unknown, index): BurstStage => {
    const prefix = "Stage " + (index + 1) + ": ";
    if (!isRecord(stage) || !hasFields(stage, ["id", "name", "startTime", "enabled", "burst"])) {
      throw Error(prefix + "fields do not match version 2.");
    }
    const { id, name, startTime, enabled } = stage;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || usedIds.has(id)) {
      throw Error(prefix + "use a unique stage ID with 1–64 letters, digits, hyphens or underscores.");
    }
    if (typeof name !== "string" || name.length > MAX_STAGE_NAME || !name.trim() || /[\u0000-\u001f\u007f]/.test(name)) {
      throw Error(prefix + "enter a name of 1–" + MAX_STAGE_NAME + " characters without control characters.");
    }
    if (typeof startTime !== "number" || !Number.isFinite(startTime) || startTime < stageStart.min || startTime > stageStart.max) {
      throw Error(prefix + "start time must be from 0 to " + stageStart.max + " seconds.");
    }
    if (typeof enabled !== "boolean") throw Error(prefix + "enabled must be true or false.");
    usedIds.add(id);
    try {
      return { id, name, startTime, enabled, burst: parseRecipe(stage.burst) };
    } catch (error) {
      throw Error(prefix + (error as Error).message);
    }
  });
  if (totalBirths(stages) > MAX_COMPOUND_BIRTHS) {
    throw Error("All stages combined are limited to " + MAX_COMPOUND_BIRTHS.toLocaleString() + " particles.");
  }
  return { version: 2, stages };
}

export function compileCompound(input: CompoundRecipe) {
  const recipe = parseCompoundRecipe(input);
  const stages = recipe.stages.map(({ id, startTime, enabled, burst }) => ({
    id, enabled, compiled: compileBurst(burst, startTime),
  }));
  const lastFrame = Math.ceil(Math.max(...recipe.stages.map(stage =>
    (stage.startTime + stage.burst.duration + stage.burst.lifetime) * BURST_FPS,
  )));
  // Consumed immediately by preview or export; a seek reuses the same bounded storage.
  const snapshot = createBurstSnapshot(totalBirths(recipe.stages));
  return {
    lastFrame,
    sample(frame: number, soloStageId?: string): BurstSnapshot {
      if (!Number.isFinite(frame) || frame < 0 || frame > lastFrame) throw Error("Frame is outside the compound timeline.");
      snapshot.count = 0;
      for (const stage of stages) {
        if (soloStageId === undefined ? stage.enabled : stage.id === soloStageId) {
          stage.compiled.append(frame, snapshot);
        }
      }
      return snapshot;
    },
  };
}
