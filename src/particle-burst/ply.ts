import type { BurstSnapshot } from "./burst.ts";

export const SH_DC = 0.28209479177387814;
export const PLY_FIELDS = [
  "x", "y", "z", "nx", "ny", "nz",
  "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
  "rot_0", "rot_1", "rot_2", "rot_3",
] as const;

/** Binary 3D Gaussian Splatting PLY. Color is DC SH, alpha is logit, scale is ln(sigma), rotation is WXYZ. */
export function encodeBurstPly(snapshot: BurstSnapshot): Blob {
  if (snapshot.count === 0) throw Error("No visible particles at this frame.");
  const header = [
    "ply", "format binary_little_endian 1.0", "element vertex " + snapshot.count,
    ...PLY_FIELDS.map(field => "property float " + field), "end_header", "",
  ].join("\n");
  const bytes = new ArrayBuffer(snapshot.count * PLY_FIELDS.length * 4);
  const view = new DataView(bytes);
  for (let index = 0; index < snapshot.count; index++) {
    const offset = index * PLY_FIELDS.length * 4;
    const alpha = Math.max(1e-6, Math.min(1 - 1e-6, snapshot.opacities[index]));
    const logScale = Math.log(snapshot.diameters[index] / 2);
    for (let i = 0; i < 3; i++) {
      view.setFloat32(offset + i * 4, snapshot.positions[index * 3 + i], true);
      view.setFloat32(offset + (6 + i) * 4, (snapshot.colors[index * 3 + i] - 0.5) / SH_DC, true);
      view.setFloat32(offset + (10 + i) * 4, logScale, true);
    }
    view.setFloat32(offset + 9 * 4, Math.log(alpha / (1 - alpha)), true);
    view.setFloat32(offset + 13 * 4, 1, true);
  }
  return new Blob([header, bytes], { type: "application/octet-stream" });
}
