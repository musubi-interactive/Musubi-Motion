import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Original coarse robot, made of anisotropic Gaussian splats, plus an enclosing octahedron.
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, configLoader: "runner", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });

try {
  const { addSplat, emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { encodeProject, decodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const colors = { head: [252, 176, 82], arm: [67, 203, 241], torso: [134, 189, 103], leg: [158, 128, 246], distant: [235, 89, 132] };
  const points = [];
  function patch(color, center, spacing, columns, rows, scales) {
    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < rows; row++) {
        const x = center[0] + (column - (columns - 1) / 2) * spacing[0];
        const y = center[1] + (row - (rows - 1) / 2) * spacing[1];
        const z = center[2] + ((column + row) % 2) * 0.07;
        points.push({ position: [x, y, z], scales, color: colors[color] });
      }
    }
  }
  patch("head", [0, .68, 0], [.12, .10], 3, 3, [.08, .07, .04]);
  patch("torso", [0, .05, 0], [.13, .12], 5, 6, [.08, .065, .055]);
  patch("arm", [-.63, .08, 0], [.10, .13], 2, 5, [.07, .085, .05]);
  patch("arm", [.63, .08, 0], [.10, .13], 2, 5, [.07, .085, .05]);
  patch("leg", [-.19, -.65, 0], [.12, .14], 2, 3, [.07, .09, .04]);
  patch("leg", [.19, -.65, 0], [.12, .14], 2, 3, [.07, .09, .04]);
  patch("distant", [1.56, 0, 0], [.10, .10], 1, 3, [.04, .045, .04]);

  const bytes = new Uint8Array(points.length * 32), write = new DataView(bytes.buffer);
  points.forEach(({ position, scales, color }, index) => {
    const offset = index * 32;
    [...position, ...scales].forEach((value, column) => write.setFloat32(offset + column * 4, value, true));
    bytes.set([...color, 245, 255, 128, 128, 128], offset + 24);
  });
  const asset = { id: "robot-gaussians", kind: "file", fileName: "original-cage-robot.splat", byteLength: bytes.length };
  let doc = addSplat(emptyScene(), asset, "Cage Robot", [0, 0, 0], "robot", "robot-shape").document;
  doc = addSplat(doc, asset, "Robot Reference", [0, 0, 0], "reference", "reference-shape").document;
  doc.nodes.robot.position[0] = -1.3;
  doc.nodes.reference.position[0] = 1.55;

  function mesh(id, name, points, triangles) {
    const vertices = points.map((position, index) => ({ id: `${id}-v${index}`, position }));
    doc.rootIds.push(id);
    doc.nodes[id] = { id, type: "transform", name, parentId: null, hidden: true, position: [-1.3, 0, 0], rotation: [0, 0, 0], rotationOrder: "XYZ", scale: [1, 1, 1] };
    doc.nodes[`${id}-shape`] = { id: `${id}-shape`, type: "meshShape", name: `${name}Shape`, parentId: id, vertices,
      faces: triangles.map((triangle, index) => ({ id: `${id}-f${index}`, vertices: triangle.map(corner => vertices[corner].id) })),
      shading: "flat", wireframe: true, color: "#d6ac69" };
  }
  mesh("cage-driver", "Robot Cage Driver", [[1.38, 0, 0], [-1.38, 0, 0], [0, 1.38, 0], [0, -1.38, 0], [0, 0, 1.1], [0, 0, -1.1]],
    [[4, 0, 2], [4, 2, 1], [4, 1, 3], [4, 3, 0], [5, 2, 0], [5, 1, 2], [5, 3, 1], [5, 0, 3]]);
  mesh("open-driver", "Open Driver", [[1, -1, 0], [0, 1, 0], [-1, -1, 0]], [[0, 1, 2]]);

  const editor = { camera: { position: [0, 0, 7], target: [0, 0, 0], view: "front", height: 3, fov: 42, near: .01, far: 1000 }, time: 0 };
  const archive = await encodeProject(doc, new Map([[asset.id, new File([bytes], asset.fileName)]]), editor);
  await decodeProject(archive);
  await writeFile(new URL("../examples/splat-cage-study.msb", import.meta.url), archive);
  console.log(`Saved a ${points.length}-Gaussian study with a closed octahedron, open rejection case and shared-source reference.`);
} finally { await server.close(); }
