// Original deterministic capture with three visibly separated regions and degree-1 SH.
export function createCropExample(): File {
  const properties = [
    "x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2",
    ...Array.from({ length: 9 }, (_, index) => `f_rest_${index}`),
    "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
  ];
  const perCluster = 2_048;
  const count = perCluster * 3;
  const header = [
    "ply", "format binary_little_endian 1.0", "comment Musubi Motion original crop example",
    `element vertex ${count}`, ...properties.map(name => `property float ${name}`), "end_header", "",
  ].join("\n");
  const rows = new ArrayBuffer(count * properties.length * 4);
  const view = new DataView(rows);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const axes = [[-1.6, -0.45, 0.4], [0, 0.65, -0.4], [1.6, -0.25, 0.2]];
  let offset = 0;
  for (let cluster = 0; cluster < axes.length; cluster++) {
    const [x, y, z] = axes[cluster];
    for (let index = 0; index < perCluster; index++) {
      const angle = index * goldenAngle;
      const latitude = 1 - (index + 0.5) * 2 / perCluster;
      const radius = Math.sqrt(1 - latitude * latitude);
      const dx = Math.cos(angle) * radius;
      const dy = Math.sin(angle) * radius;
      const tone = 0.1 + 0.75 * (0.5 + 0.5 * dy);
      const sh = Math.cos(angle) * 0.04;
      const row = [
        x + dx * 0.54, y + dy * 0.39, z + latitude * 0.49,
        dx, dy, latitude, tone, tone, tone,
        sh, 0, 0, sh, 0, 0, sh, 0, 0,
        1.5, -3.3, -3.3, -3.7, 1, 0, 0, 0,
      ];
      for (const value of row) {
        view.setFloat32(offset, value, true);
        offset += 4;
      }
    }
  }
  return new File([header, rows], "crop-example.ply", { type: "application/octet-stream" });
}
