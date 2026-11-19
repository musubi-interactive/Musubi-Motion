import { BufferAttribute, BufferGeometry, DataTexture, DynamicDrawUsage, Group, LineBasicMaterial, LineSegments, Matrix4, Points, PointsMaterial, RGBAFormat, Vector3, Vector4, WebGPUCoordinateSystem, type Camera, type Object3D } from "three";
import { cageEdges, cageRestPoint, type SplatCage } from "./splat-cage.ts";
import { controlPointPosition } from "./splat-control-points.ts";
import { latticeEdges, latticeRestPoint, type SplatLattice } from "./splat-lattice.ts";

export type SplatControlLayout = { points: readonly Vector3[]; edges?: readonly (readonly [number, number])[] };
type ViewRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export function splatCageControlLayout(kind: string, params: unknown): SplatControlLayout | undefined {
  if (kind === "lattice") {
    const lattice = params as SplatLattice;
    return { points: lattice.offsets.map((_, index) => controlPointPosition(lattice, latticeRestPoint, index)), edges: latticeEdges(lattice) };
  }
  if (kind === "cage") {
    const cage = params as SplatCage;
    return { points: cage.offsets.map((_, index) => controlPointPosition(cage, cageRestPoint, index)), edges: cageEdges(cage) };
  }
}

function circularPointTexture() {
  const width = 16;
  const data = new Uint8Array(width * width * 4);
  for (let row = 0; row < width; row++) {
    for (let column = 0; column < width; column++) {
      const radius = Math.hypot((row + 0.5) / width - 0.5, (column + 0.5) / width - 0.5);
      const index = (row * width + column) * 4;
      data.set([255, 255, 255, Math.round(255 * Math.max(0, Math.min(1, (0.5 - radius) * width)))], index);
    }
  }
  const texture = new DataTexture(data, width, width, RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/** Transient editor-local wireframe and point markers, drawn through the splat render. */
export function createSplatControlOverlay(world: Object3D) {
  const group = new Group();
  group.matrixAutoUpdate = false;
  world.add(group);

  const lineGeometry = new BufferGeometry(), pointGeometry = new BufferGeometry(), selectedGeometry = new BufferGeometry();
  const marker = circularPointTexture();
  const lineMaterial = new LineBasicMaterial({ color: 0xffcb81, depthTest: false, depthWrite: false, transparent: true, opacity: 0.62, toneMapped: false });
  const pointMaterial = new PointsMaterial({ color: 0xffcb81, depthTest: false, depthWrite: false, transparent: true, size: 9, sizeAttenuation: false, map: marker, toneMapped: false });
  const selectedMaterial = new PointsMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, size: 13, sizeAttenuation: false, map: marker, toneMapped: false });
  const lines = new LineSegments(lineGeometry, lineMaterial), points = new Points(pointGeometry, pointMaterial), highlight = new Points(selectedGeometry, selectedMaterial);
  lines.renderOrder = 100011; points.renderOrder = 100012; highlight.renderOrder = 100013;
  for (const object of [lines, points, highlight]) object.frustumCulled = false;
  group.add(lines, points, highlight);
  const selectedPosition = new BufferAttribute(new Float32Array(3), 3).setUsage(DynamicDrawUsage);
  selectedGeometry.setAttribute("position", selectedPosition);
  const clip = new Vector4(), projection = new Matrix4();
  let lastLayout: SplatControlLayout | undefined;
  group.visible = false;

  function updateLayout(layout: SplatControlLayout) {
    if (layout === lastLayout) return;
    const edges = layout.edges ?? [];
    let base = pointGeometry.getAttribute("position") as BufferAttribute | undefined;
    if (!base || base.count !== layout.points.length) {
      // A changed topology also needs to retire the GPU storage of the old attributes.
      pointGeometry.dispose();
      lineGeometry.dispose();
      base = new BufferAttribute(new Float32Array(layout.points.length * 3), 3).setUsage(DynamicDrawUsage);
      pointGeometry.setAttribute("position", base);
      lineGeometry.setAttribute("position", base);
    }
    layout.points.forEach((point, index) => base.setXYZ(index, point.x, point.y, point.z));
    base.needsUpdate = true;
    if (layout.edges !== lastLayout?.edges) {
      const previousIndex = lineGeometry.getIndex();
      if (previousIndex?.count === edges.length * 2) {
        edges.forEach(([a, b], index) => { previousIndex.setX(index * 2, a); previousIndex.setX(index * 2 + 1, b); });
        previousIndex.needsUpdate = true;
      } else {
        lineGeometry.dispose();
        lineGeometry.setIndex(edges.flatMap(([a, b]) => [a, b]));
      }
    }
    lines.visible = edges.length > 0;
    lastLayout = layout;
  }

  return {
    update(layout: SplatControlLayout, matrixWorld: Matrix4, selected: number) {
      updateLayout(layout);
      group.visible = layout.points.length > 0;
      group.matrix.copy(matrixWorld);
      group.matrixWorldNeedsUpdate = true;
      const point = layout.points[selected];
      highlight.visible = !!point;
      if (point) { selectedPosition.setXYZ(0, point.x, point.y, point.z); selectedPosition.needsUpdate = true; }
    },
    pick(camera: Camera, rect: ViewRect, clientX: number, clientY: number) {
      if (!group.visible || !lastLayout || rect.width <= 0 || rect.height <= 0) return;
      const x = clientX - rect.left, y = clientY - rect.top;
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) return;
      camera.updateWorldMatrix(true, false);
      group.updateWorldMatrix(true, false);
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(group.matrixWorld);
      const minimumDepth = camera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1;
      let nearest: number | undefined, best = 10 ** 2, depth = Infinity;
      lastLayout.points.forEach((point, index) => {
        clip.set(point.x, point.y, point.z, 1).applyMatrix4(projection);
        if (!(clip.w > 0)) return;
        const nx = clip.x / clip.w, ny = clip.y / clip.w, nz = clip.z / clip.w;
        if (Math.abs(nx) > 1 || Math.abs(ny) > 1 || nz < minimumDepth || nz > 1) return;
        const distance = (x - (nx + 1) * rect.width / 2) ** 2 + (y - (1 - ny) * rect.height / 2) ** 2;
        if (distance < best || (distance === best && nz < depth)) { best = distance; depth = nz; nearest = index; }
      });
      return nearest;
    },
    clear() { group.visible = false; },
    dispose() {
      group.removeFromParent();
      for (const geometry of [lineGeometry, pointGeometry, selectedGeometry]) geometry.dispose();
      for (const material of [lineMaterial, pointMaterial, selectedMaterial]) material.dispose();
      marker.dispose();
    },
  };
}
