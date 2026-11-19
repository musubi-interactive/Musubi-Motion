import { writeFile } from "node:fs/promises";

// Original Gaussian tower with a raised seam to make axial twists legible.
const levels = 17;
const ring = 16;
const bytes = Buffer.alloc(levels * ring * 32);
for (let level = 0; level < levels; level++) {
  const y = (level - (levels - 1) / 2) / 8;
  for (let sample = 0; sample < ring; sample++) {
    const angle = sample * 2 * Math.PI / ring;
    const seam = sample === 0 || sample === 1;
    const radius = seam ? .37 : .26;
    const x = radius * Math.cos(angle);
    const z = radius * Math.sin(angle);
    const colors = seam ? [250, 179, 53] : level % 4 === 0 ? [200, 219, 228] : [65, 138, 186];
    const offset = (level * ring + sample) * 32;
    const row = [x, y, z, .047, .064, .033];
    row.forEach((value, index) => bytes.writeFloatLE(value, offset + index * 4));
    bytes.set([...colors, 255, 255, 128, 128, 128], offset + 24);
  }
}
await writeFile(new URL("../examples/splat-deformer-tower.splat", import.meta.url), bytes);
console.log(`Wrote ${levels * ring} original splats (${bytes.length} bytes).`);
