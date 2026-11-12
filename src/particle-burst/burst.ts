export const BURST_FPS = 24;
export const MAX_RECIPE_BYTES = 4096;

export const numbers = {
  count: { label: "Count", min: 1, max: 12000, step: 1 },
  seed: { label: "Seed", min: 0, max: 0xffffffff, step: 1 },
  duration: { label: "Emission duration (s)", min: 0, max: 10, step: 0.05 },
  lifetime: { label: "Lifetime (s)", min: 0.05, max: 20, step: 0.05 },
  originX: { label: "Origin X", min: -100, max: 100, step: 0.1 },
  originY: { label: "Origin Y", min: -100, max: 100, step: 0.1 },
  originZ: { label: "Origin Z", min: -100, max: 100, step: 0.1 },
  azimuth: { label: "Azimuth (°)", min: -180, max: 180, step: 1 },
  elevation: { label: "Elevation (°)", min: -90, max: 90, step: 1 },
  spread: { label: "Cone half-angle (°)", min: 0, max: 180, step: 1 },
  speed: { label: "Speed", min: 0, max: 50, step: 0.1 },
  speedVariation: { label: "Speed variation", min: 0, max: 50, step: 0.1 },
  gravity: { label: "Gravity (−Y)", min: -50, max: 50, step: 0.1 },
  birthDiameter: { label: "Start diameter", min: 0, max: 5, step: 0.01 },
  deathDiameter: { label: "End diameter", min: 0, max: 5, step: 0.01 },
  birthOpacity: { label: "Start opacity", min: 0, max: 1, step: 0.01 },
  deathOpacity: { label: "End opacity", min: 0, max: 1, step: 0.01 },
} as const;

export type NumberField = keyof typeof numbers;
export type BurstRecipe = Record<NumberField, number> & {
  version: 1;
  birthColor: string;
  deathColor: string;
};

export const defaultRecipe: Readonly<BurstRecipe> = Object.freeze({
  version: 1,
  count: 600, seed: 23, duration: 0.5, lifetime: 2,
  originX: 0, originY: 0, originZ: 0, azimuth: 0, elevation: 90, spread: 42,
  speed: 3.2, speedVariation: 2.6, gravity: 3,
  birthDiameter: 0.09, deathDiameter: 0.03,
  birthColor: "#ffdfa7", deathColor: "#ed683b", birthOpacity: 0.85, deathOpacity: 0,
});

const numberFields = Object.keys(numbers) as NumberField[];

export function parseRecipe(value: unknown): BurstRecipe {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw Error("Expected a particle burst recipe.");
  const recipe = value as Record<string, unknown>;
  if (!Object.hasOwn(recipe, "version") || recipe.version !== 1) throw Error("This tool supports version 1 particle burst recipes.");
  if (Object.keys(recipe).length !== numberFields.length + 3) throw Error("The recipe fields do not match version 1.");
  for (const field of numberFields) {
    const number = recipe[field];
    const { label, min, max } = numbers[field];
    const integer = field === "count" || field === "seed";
    if (!Object.hasOwn(recipe, field) || typeof number !== "number" || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
      throw Error(label + " must be " + (integer ? "an integer" : "a number") + " from " + min + " to " + max + ".");
    }
  }
  for (const field of ["birthColor", "deathColor"] as const) {
    if (!Object.hasOwn(recipe, field) || typeof recipe[field] !== "string" || !/^#[0-9a-f]{6}$/i.test(recipe[field])) {
      throw Error("Start and end colors must use six-digit hex RGB.");
    }
  }
  return { ...recipe } as BurstRecipe;
}

export const lastBurstFrame = (recipe: BurstRecipe) => Math.ceil((recipe.duration + recipe.lifetime) * BURST_FPS);

export type BurstSnapshot = {
  count: number;
  positions: Float32Array;
  colors: Float32Array;
  diameters: Float32Array;
  opacities: Float32Array;
};

function colorChannels(hex: string) {
  const rgb = Number.parseInt(hex.slice(1), 16);
  return [(rgb >> 16) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255];
}

export function compileBurst(input: BurstRecipe) {
  const recipe = parseRecipe(input);
  const toRadians = Math.PI / 180;
  const azimuth = recipe.azimuth * toRadians;
  const elevation = recipe.elevation * toRadians;
  const minimumCosine = Math.cos(recipe.spread * toRadians);
  const axis = [Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)];
  const tangent = [-Math.sin(azimuth), 0, Math.cos(azimuth)];
  const bitangent = [Math.sin(elevation) * Math.cos(azimuth), -Math.cos(elevation), Math.sin(elevation) * Math.sin(azimuth)];
  const velocities = new Float64Array(recipe.count * 3);
  let seed = recipe.seed;

  const uniform = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let index = 0; index < recipe.count; index++) {
    // Uniform over the cone's solid angle, including an isotropic sphere at 180°.
    const cosine = minimumCosine + uniform() * (1 - minimumCosine);
    const sine = Math.sqrt(1 - cosine * cosine);
    const phase = uniform() * 2 * Math.PI;
    const u = sine * Math.cos(phase);
    const v = sine * Math.sin(phase);
    const speed = Math.max(0, recipe.speed + (uniform() - 0.5) * recipe.speedVariation);
    for (let i = 0; i < 3; i++) velocities[index * 3 + i] = speed * (cosine * axis[i] + u * tangent[i] + v * bitangent[i]);
  }

  const birthColor = colorChannels(recipe.birthColor);
  const deathColor = colorChannels(recipe.deathColor);
  // The caller consumes these buffers before the next sample. Retain capacity across seeks and playback.
  const snapshot: BurstSnapshot = {
    count: 0,
    positions: new Float32Array(recipe.count * 3),
    colors: new Float32Array(recipe.count * 3),
    diameters: new Float32Array(recipe.count),
    opacities: new Float32Array(recipe.count),
  };

  return {
    sample(frame: number): BurstSnapshot {
      if (!Number.isFinite(frame) || frame < 0 || frame > lastBurstFrame(recipe)) throw Error("Frame is outside the burst timeline.");
      let count = 0;
      for (let index = 0; index < recipe.count; index++) {
        // Compute the fraction first so the last birth is exactly at duration.
        // Compare in frames to keep the lifetime half-open across seconds conversions.
        const birth = (index / Math.max(1, recipe.count - 1)) * recipe.duration;
        const birthFrame = birth * BURST_FPS;
        const deathFrame = (birth + recipe.lifetime) * BURST_FPS;
        if (frame < birthFrame || frame >= deathFrame) continue;
        const age = (frame - birthFrame) / BURST_FPS;
        const ageFraction = age / recipe.lifetime;
        const opacity = Math.fround(recipe.birthOpacity + (recipe.deathOpacity - recipe.birthOpacity) * ageFraction);
        const diameter = Math.fround(recipe.birthDiameter + (recipe.deathDiameter - recipe.birthDiameter) * ageFraction);
        if (opacity <= 0 || diameter <= 0) continue;
        const from = index * 3;
        const to = count * 3;
        snapshot.positions[to] = recipe.originX + velocities[from] * age;
        snapshot.positions[to + 1] = recipe.originY + velocities[from + 1] * age - 0.5 * recipe.gravity * age * age;
        snapshot.positions[to + 2] = recipe.originZ + velocities[from + 2] * age;
        for (let i = 0; i < 3; i++) snapshot.colors[to + i] = birthColor[i] + (deathColor[i] - birthColor[i]) * ageFraction;
        snapshot.diameters[count] = diameter;
        snapshot.opacities[count] = opacity;
        count++;
      }
      snapshot.count = count;
      return snapshot;
    },
  };
}
