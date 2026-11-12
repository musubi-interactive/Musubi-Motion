import {
  Box3, BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, GridHelper, PerspectiveCamera, Points,
  Scene, ShaderMaterial, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { numbers, type BurstSnapshot } from "./burst.ts";

const vertexShader = [
  "attribute float diameter;",
  "attribute float opacity;",
  "attribute vec3 rgb;",
  "uniform float projectionPixels;",
  "uniform float maximumPointSize;",
  "varying vec4 particleColor;",
  "void main() {",
  "  particleColor = vec4(rgb, opacity);",
  "  vec4 eye = modelViewMatrix * vec4(position, 1.0);",
  "  gl_Position = projectionMatrix * eye;",
  "  gl_PointSize = clamp(3.0 * diameter * projectionPixels / max(-eye.z, 0.001), 1.0, maximumPointSize);",
  "}",
].join("\n");

const fragmentShader = [
  "varying vec4 particleColor;",
  "void main() {",
  "  vec2 point = (gl_PointCoord - 0.5) * 6.0;",
  "  float r2 = dot(point, point);",
  "  if (r2 > 9.0) discard;",
  "  gl_FragColor = vec4(particleColor.rgb, particleColor.a * exp(-0.5 * r2));",
  "}",
].join("\n");

export function createBurstPreview(host: HTMLElement) {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.domElement.setAttribute("aria-label", "Particle burst preview. Drag to orbit, right-drag to pan, scroll to zoom.");
  renderer.domElement.setAttribute("role", "img");
  host.append(renderer.domElement);
  const gl = renderer.getContext();
  const maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] as number;
  const scene = new Scene();
  scene.background = new Color("#17181a");
  const grid = new GridHelper(20, 20, "#5c5c62", "#313237");
  scene.add(grid);
  const camera = new PerspectiveCamera(46, 1, 0.01, 40000);
  camera.position.set(4, 2.7, 5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.7, 0);
  controls.update();

  const geometry = new BufferGeometry();
  const buffer = (width: number) => new BufferAttribute(new Float32Array(numbers.count.max * width), width).setUsage(DynamicDrawUsage);
  const position = buffer(3), color = buffer(3), diameter = buffer(1), opacity = buffer(1);
  geometry.setAttribute("position", position);
  geometry.setAttribute("rgb", color);
  geometry.setAttribute("diameter", diameter);
  geometry.setAttribute("opacity", opacity);
  geometry.setDrawRange(0, 0);
  const material = new ShaderMaterial({
    vertexShader, fragmentShader, transparent: true, depthWrite: false, toneMapped: false,
    uniforms: { projectionPixels: { value: 1 }, maximumPointSize: { value: maxPointSize } },
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  const draw = () => renderer.render(scene, camera);
  controls.addEventListener("change", draw);
  const resize = () => {
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    material.uniforms.projectionPixels.value = renderer.domElement.height * camera.projectionMatrix.elements[5] / 2;
    draw();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  function copyAttribute(attribute: BufferAttribute, values: Float32Array, count: number) {
    const length = count * attribute.itemSize;
    if (!length) return;
    (attribute.array as Float32Array).set(values.subarray(0, length));
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, length);
    attribute.needsUpdate = true;
  }

  return {
    show(snapshot: BurstSnapshot) {
      copyAttribute(position, snapshot.positions, snapshot.count);
      copyAttribute(color, snapshot.colors, snapshot.count);
      copyAttribute(diameter, snapshot.diameters, snapshot.count);
      copyAttribute(opacity, snapshot.opacities, snapshot.count);
      geometry.setDrawRange(0, snapshot.count);
      draw();
    },
    frame(snapshot: BurstSnapshot) {
      const bounds = new Box3();
      const center = new Vector3();
      const radius = new Vector3();
      for (let i = 0; i < snapshot.count; i++) {
        center.fromArray(snapshot.positions, i * 3);
        radius.setScalar(1.5 * snapshot.diameters[i]);
        bounds.expandByPoint(center.sub(radius));
        bounds.expandByPoint(center.addScaledVector(radius, 2));
      }
      if (!bounds.isEmpty()) {
        bounds.getCenter(center);
        const diameter = bounds.getSize(new Vector3()).length();
        const direction = camera.position.clone().sub(controls.target).normalize();
        const viewScale = Math.min(camera.aspect, 1) * Math.tan(camera.fov * Math.PI / 360);
        controls.target.copy(center);
        camera.position.copy(center).addScaledVector(direction, Math.max(diameter * 0.65, 0.7) / viewScale);
      } else {
        controls.target.set(0, 0.7, 0);
        camera.position.set(4, 2.7, 5);
      }
      controls.update();
      draw();
    },
    dispose() {
      observer.disconnect();
      controls.dispose();
      material.dispose();
      geometry.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      renderer.dispose();
    },
  };
}
