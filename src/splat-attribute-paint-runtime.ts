import { dyno, type SplatMesh } from "@sparkjsdev/spark";
import { DataTexture, FloatType, RGBAFormat } from "three";
import type { SplatAppearanceRead } from "./splat-appearance-runtime.ts";
import type { SplatAttributePaint } from "./splat-attribute-paint.ts";

const WIDTH = 1024;

/** Sorted original IDs, two RGBA32F texels per authored record. */
export function createSplatAttributePaintRuntime(mesh: SplatMesh, appearance: () => SplatAppearanceRead | undefined) {
  let value: SplatAttributePaint | undefined;
  let texels = new Float32Array(WIDTH * 4);
  let texture = new DataTexture(texels, WIDTH, 1, RGBAFormat, FloatType);
  const map = dyno.dynoSampler2D(texture), count = dyno.dynoInt(0);
  const modifier = new dyno.Dyno({
    inTypes: { covsplat: dyno.CovSplat, map: "sampler2D", count: "int" },
    outTypes: { covsplat: dyno.CovSplat }, inputs: { map, count },
    statements: ({ inputs, outputs }) => {
      const splat = outputs.covsplat, image = inputs.map;
      return [
        ` ${splat} = ${inputs.covsplat};`,
        ` if (isCovSplatActive(${splat}.flags)) {`,
        `   int lo = 0; int hi = ${inputs.count};`,
        "   for (int step = 0; step < 17; ++step) {",
        "     if (lo >= hi) break;",
        "     int mid = (lo + hi) / 2;",
        `     vec4 row = texelFetch(${image}, ivec2((mid % 512) * 2, mid / 512), 0);`,
        "     int id = int(row.x) + (int(row.y) << 16);",
        `     if (id < ${splat}.index) lo = mid + 1; else hi = mid;`,
        "   }",
        `   if (lo < ${inputs.count}) {`,
        "     ivec2 pixel = ivec2((lo % 512) * 2, lo / 512);",
        `     vec4 row = texelFetch(${image}, pixel, 0);`,
        `     if (int(row.x) + (int(row.y) << 16) == ${splat}.index) {`,
        `       vec4 paint = texelFetch(${image}, pixel + ivec2(1, 0), 0);`,
        "       if (paint.a > 0.0) {",
        `         vec3 rgb = max(${splat}.rgba.rgb, 0.0);`,
        "         vec3 linear = mix(pow((rgb + 0.055) / 1.055, vec3(2.4)), rgb / 12.92, lessThanEqual(rgb, vec3(0.04045)));",
        "         linear = linear * (1.0 - paint.a) + paint.rgb;",
        `         ${splat}.rgba.rgb = mix(1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055, linear * 12.92, lessThanEqual(linear, vec3(0.0031308)));`,
        "       }",
        `       ${splat}.rgba.a = ${splat}.rgba.a * (1.0 - row.w) + row.z;`,
        "     }",
        "   }",
        " }",
      ];
    },
  });
  mesh.covObjectModifiers = [...(mesh.covObjectModifiers ?? []), modifier];
  mesh.updateGenerator();
  const runtime = {
    opacity(index: number, source: number) {
      const base = appearance()?.opacity(index, source) ?? source, records = value?.records;
      if (!records) return base;
      let left = 0, right = records.length;
      while (left < right) {
        const mid = (left + right) >>> 1;
        if (records[mid][0] < index) left = mid + 1; else right = mid;
      }
      const row = records[left];
      return row?.[0] === index ? base * (1 - row[6]) + row[5] : base;
    },
    scale(index: number) { return appearance()?.scale(index) ?? 1; },
    update(next: SplatAttributePaint | undefined) {
      if (next === value) return false;
      const rows = next?.records ?? [];
      const height = Math.max(1, Math.ceil(rows.length / (WIDTH / 2)));
      if (texture.image.height !== height) {
        texture.dispose();
        texels = new Float32Array(WIDTH * height * 4);
        texture = new DataTexture(texels, WIDTH, height, RGBAFormat, FloatType);
        map.value = texture;
      }
      rows.forEach(([id, red, green, blue, colorWeight, opacity, opacityWeight], row) => {
        const offset = row * 8;
        texels[offset] = id & 65535; texels[offset + 1] = id >>> 16;
        texels[offset + 2] = opacity; texels[offset + 3] = opacityWeight;
        texels[offset + 4] = red; texels[offset + 5] = green;
        texels[offset + 6] = blue; texels[offset + 7] = colorWeight;
      });
      value = next; count.value = rows.length; texture.needsUpdate = true; mesh.updateVersion();
      return true;
    },
    dispose() {
      mesh.covObjectModifiers = mesh.covObjectModifiers?.filter(candidate => candidate !== modifier);
      mesh.updateGenerator(); texture.dispose();
    },
  };
  return runtime;
}
export type SplatAttributePaintRuntime = ReturnType<typeof createSplatAttributePaintRuntime>;
