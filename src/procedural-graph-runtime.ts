import {
  graphOrder, inputPorts, outputPorts, portKey, validateProceduralGraph,
  type Color, type GraphNode, type PortType, type ProceduralGraph,
} from "./procedural-graph.ts";
import type { TextureAsset } from "./texture-assets.ts";
import type { ParticleGraphSample, ParticleGraphValues, SampleParticleGraph } from "./particle-map-fields.ts";

export const PREVIEW_SIZE = 256;
const LIMIT = 1e6;
type Vector2 = [number, number];
type Value = number | Vector2 | Color;
type Inputs = Map<string, { node: string; port: string }>;
type GraphSample = { uv: Vector2; position?: Color; frame: number; fps: number } &
  Partial<Pick<ParticleGraphSample, "particleAge" | "particleLifetime">>;
export type PixelSource = { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray };
export type GraphProgram = {
  fragment: string;
  uniforms: Float32Array;
  images: TextureAsset[];
  animated: boolean;
  sample: (point: GraphSample, images?: ReadonlyMap<string, PixelSource>) => [number, number, number, number];
};
type ParticleGraphProgram = GraphProgram & {
  appearanceImages: TextureAsset[];
  fieldImages: TextureAsset[];
  sampleAppearance: SampleParticleGraph;
  sampleField: SampleParticleGraph;
};

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const frac = (value: number) => value - Math.floor(value);
const f = Math.fround;
const mix = (a: number, b: number, t: number) => f(f(a * f(1 - t)) + f(b * t));
const rgbToLinear = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const srgbBytes = Array.from({ length: 256 }, (_, value) => rgbToLinear(value / 255));
const linearToRgb = (c: number) => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
export const displayPixel = (linear: [number, number, number, number]) =>
  linear.map((c, index) => Math.round(255 * (index === 3 ? clamp(c) : linearToRgb(clamp(c)))));
const sizeOf: Record<PortType, number> = { scalar: 1, vec2: 2, vec3: 3, color: 3 };
function components(value: Value, count: number): number[] {
  return typeof value === "number" ? Array.from({ length: count }, () => value) : value;
}
export function graphSeconds(frame: number, fps: number): number {
  if (!Number.isFinite(frame) || Math.abs(frame) > LIMIT || !Number.isFinite(fps) || fps < 1 || fps > 240)
    throw new Error("Texture preview requires a supported timeline frame and FPS.");
  return f(frame / fps);
}

// Wrapping the integer lattice keeps adjacent cells seamless across its period.
function hash(x: number, y: number, z: number, seed: number) {
  let bits = (Math.imul(x & 4095, 0x9e3779b1) ^ Math.imul(y & 4095, 0x85ebca77) ^
    Math.imul(z & 4095, 0xc2b2ae3d) ^ Math.imul(seed, 0x27d4eb2f)) >>> 0;
  bits = Math.imul(bits ^ (bits >>> 16), 0x7feb352d) >>> 0;
  bits = Math.imul(bits ^ (bits >>> 15), 0x846ca68b) >>> 0;
  return ((bits ^ (bits >>> 16)) >>> 8) / 16777216;
}
function noise(position: Value, scale: number, time: number, speed: number, seed: number) {
  const p = position as number[];
  const px = f(f(p[0] ?? 0) * f(scale)), py = f(f(p[1] ?? 0) * f(scale));
  const pz = f(f(f(p[2] ?? 0) * f(scale)) + f(time * f(speed)));
  const x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz);
  const smooth = (p: number) => f(f(p * p) * f(3 - f(2 * p)));
  const u = smooth(frac(px)), v = smooth(frac(py)), w = smooth(frac(pz));
  const plane = (k: number) => mix(mix(hash(x, y, k, seed), hash(x + 1, y, k, seed), u),
    mix(hash(x, y + 1, k, seed), hash(x + 1, y + 1, k, seed), u), v);
  return mix(plane(z), plane(z + 1), w);
}

function sampleTexture(asset: TextureAsset | undefined, images: ReadonlyMap<string, PixelSource> | undefined, uv: Value) {
  if (!asset) return [0, 0, 0, 1];
  const image = images?.get(asset.id);
  if (!image || image.width !== asset.width || image.height !== asset.height || image.rgba.length !== image.width * image.height * 4)
    throw new Error("Missing CPU texture pixels for " + asset.name + ".");
  const [u, v] = uv as Vector2;
  const x = Math.min(image.width - 1, Math.floor(f(clamp(u) * image.width)));
  const y = Math.min(image.height - 1, Math.floor(f(f(1 - clamp(v)) * image.height)));
  const offset = (y * image.width + x) * 4;
  const rgba = image.rgba, r = rgba[offset], g = rgba[offset + 1], b = rgba[offset + 2], a = rgba[offset + 3];
  return asset.role === "color" ? [srgbBytes[r], srgbBytes[g], srgbBytes[b], a / 255]
    : [r / 255, g / 255, b / 255, a / 255];
}

/** Resolve validated wires once. The per-sample path reuses the small slot
 * array and never rebuilds keys or a node/port map for each splat. */
function compileReference(nodes: GraphNode[], inputs: Inputs, assets: Readonly<Record<string, TextureAsset>>, fieldOnly = false) {
  const slots = new Map<string, number>(), values: Value[] = [];
  const zeroField: Color = [0, 0, 0];
  for (const node of nodes) for (const port of outputPorts(node))
    slots.set(portKey({ node: node.id, port: port.name }), slots.size);
  const steps = nodes.map(node => {
    const ins: Record<string, number | undefined> = {};
    const outs: Record<string, number> = {};
    for (const port of inputPorts(node)) {
      const source = inputs.get(portKey({ node: node.id, port: port.name }));
      if (source) ins[port.name] = slots.get(portKey(source));
    }
    for (const port of outputPorts(node)) outs[port.name] = slots.get(portKey({ node: node.id, port: port.name }))!;
    return {
      node,
      read(port: string, fallback: Value): Value {
        const slot = ins[port];
        return slot === undefined ? fallback : values[slot];
      },
      write(port: string, value: Value) { values[outs[port]] = value; },
    };
  });
  return (point: GraphSample, images?: ReadonlyMap<string, PixelSource>, particle?: ParticleGraphValues): ParticleGraphValues["rgba"] | undefined => {
    const time = graphSeconds(point.frame, point.fps);
    const uv = point.uv.map(f) as Vector2;
    const position = (point.position ?? [uv[0], uv[1], 0]).map(f) as Color;
    for (const { node, read, write } of steps) {
      switch (node.kind) {
        case "uv": write("uv", uv); break;
        case "position": write("position", position); break;
        case "time": write("value", time); break;
        case "particle": {
          const age = point.particleAge ?? 0, life = point.particleLifetime ?? 0;
          write("age", f(age)); write("lifetime", f(life)); write("normalizedAge", life > 0 ? f(clamp(age / life)) : 0);
          break;
        }
        case "vector": write("vector", [read("x", 0), read("y", 0), read("z", 0)] as Color); break;
        case "texture": {
          const [r, g, b, a] = sampleTexture(assets[node.params.assetId], images, read("uv", uv));
          write("color", [r, g, b]); write("alpha", a); break;
        }
        case "noise": write("value", noise(read("position", position), node.params.scale, read("time", 0) as number, node.params.speed, node.params.seed)); break;
        case "gradient": {
          const factor = clamp(read("factor", uv[0]) as number);
          const { start, end } = node.params;
          write("color", start.map((value, index) => mix(f(value), f(end[index]), factor)) as Color);
          break;
        }
        case "add":
        case "multiply":
        case "clamp": {
          const count = sizeOf[node.params.type];
          let result: number[];
          if (node.kind === "clamp") {
            const low = read("min", f(node.params.min)) as number;
            const high = read("max", f(node.params.max)) as number;
            result = components(read("value", f(node.params.value)), count).map(x => clamp(x, Math.min(low, high), Math.max(low, high)));
          } else {
            const a = components(read("a", f(node.params.a)), count);
            const b = components(read("b", f(node.params.b)), count);
            const add = node.kind === "add";
            result = a.map((x, i) => clamp(f(add ? x + b[i] : x * b[i]), -LIMIT, LIMIT));
          }
          write("value", count === 1 ? result[0] : result as Vector2 | Color);
          break;
        }
        case "output": {
          if (fieldOnly) {
            particle!.field = read("field", zeroField) as Color;
            return;
          }
          const rgba = [...components(read("color", 0), 3), clamp(read("alpha", f(node.params.alpha)) as number)] as ParticleGraphValues["rgba"];
          if (particle) {
            particle.rgba = rgba;
            particle.size = read("size", 1) as number;
          }
          return rgba;
        }
      }
    }
    throw new Error("Texture graph Output is missing.");
  };
}

const GLSL = "float";
const glslType: Record<PortType, string> = { scalar: GLSL, vec2: "vec2", vec3: "vec3", color: "vec3" };
const shaderPrelude = String.raw`
precision highp float;
precision highp int;
in vec2 uv;
out vec4 preview;
uniform float seconds;
float hashCell(ivec3 cell, uint seed) {
  uvec3 c = uvec3(cell & ivec3(4095));
  uint bits = c.x*0x9e3779b1u ^ c.y*0x85ebca77u ^ c.z*0xc2b2ae3du ^ seed*0x27d4eb2fu;
  bits = (bits ^ (bits >> 16)) * 0x7feb352du;
  bits = (bits ^ (bits >> 15)) * 0x846ca68bu;
  return float((bits ^ (bits >> 16)) >> 8) / 16777216.0;
}
float noisePlane(ivec3 p, uint seed, vec2 t) {
  return mix(
    mix(hashCell(p, seed), hashCell(p + ivec3(1, 0, 0), seed), t.x),
    mix(hashCell(p + ivec3(0, 1, 0), seed), hashCell(p + ivec3(1, 1, 0), seed), t.x), t.y);
}
float latticeNoise(vec3 p, uint seed) {
  ivec3 cell = ivec3(floor(p));
  vec3 t = fract(p);
  t = t*t*(3.0-2.0*t);
  return mix(noisePlane(cell, seed, t.xy), noisePlane(cell + ivec3(0, 0, 1), seed, t.xy), t.z);
}
vec3 decodeColor(vec3 color) {
  return mix(pow((color + 0.055) / 1.055, vec3(2.4)), color / 12.92, lessThanEqual(color, vec3(0.04045)));
}
vec3 encodeColor(vec3 color) {
  color = clamp(color, 0.0, 1.0);
  return mix(1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055, color * 12.92, lessThanEqual(color, vec3(0.0031308)));
}
vec4 readImage(sampler2D image, vec2 coordinate, float srgb) {
  ivec2 size = textureSize(image, 0);
  vec2 q = clamp(coordinate, 0.0, 1.0);
  ivec2 texel = min(size - 1, ivec2(vec2(q.x, 1.0 - q.y) * vec2(size)));
  vec4 pixel = texelFetch(image, texel, 0);
  if (srgb > 0.5) pixel.rgb = decodeColor(pixel.rgb);
  return pixel;
}
`;

export function compileGraph(graph: ProceduralGraph, assets: Readonly<Record<string, TextureAsset>> = {}): ParticleGraphProgram {
  validateProceduralGraph(graph, assets);
  const inputs: Inputs = new Map(graph.edges.map(edge => [portKey(edge.to), edge.from]));
  const dependencies = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const sources = dependencies.get(edge.to.node) ?? [];
    sources.push(edge);
    dependencies.set(edge.to.node, sources);
  }
  const output = graph.nodes.find(node => node.kind === "output")!.id, ordered = graphOrder(graph);
  function branch(ports: readonly string[]) {
    const active = new Set<string>();
    function visit(id: string) {
      if (active.has(id)) return;
      active.add(id);
      for (const edge of dependencies.get(id) ?? [])
        if (id !== output || ports.includes(edge.to.port)) visit(edge.from.node);
    }
    visit(output);
    return ordered.filter(node => active.has(node.id));
  }
  const nodes = branch(["color", "alpha"]);
  const appearanceNodes = inputs.has(portKey({ node: output, port: "size" })) ? branch(["color", "alpha", "size"]) : nodes;
  const fieldNodes = branch(["field"]);
  const lines: string[] = [], uniforms: number[] = [], images: TextureAsset[] = [];
  const variables = new Map<string, { variable: string; type: PortType }>();
  const parameter = (value: number | Color) => {
    const slot = uniforms.length / 4;
    if (typeof value === "number") {
      uniforms.push(value, 0, 0, 0);
      return "params[" + slot + "].x";
    }
    uniforms.push(...value, 0);
    return "params[" + slot + "].xyz";
  };
  for (const [index, node] of nodes.entries()) {
    const get = (port: string) => {
      const source = inputs.get(portKey({ node: node.id, port }));
      return source && variables.get(portKey(source));
    };
    const read = (port: string, fallback: () => string, target: PortType = "scalar") => {
      const found = get(port);
      const value = found ? found.variable : fallback();
      return target !== "scalar" && (!found || found.type === "scalar") ? glslType[target] + "(" + value + ")" : value;
    };
    const write = (port: string, expression: string) => {
      const type = outputPorts(node).find(item => item.name === port)!.type;
      const variable = "n" + index + "_" + port;
      variables.set(portKey({ node: node.id, port }), { variable, type });
      lines.push(glslType[type] + " " + variable + " = " + expression + ";");
    };
    switch (node.kind) {
      case "uv": write("uv", "uv"); break;
      case "position": write("position", "vec3(uv, 0.0)"); break;
      case "time": write("value", "seconds"); break;
      // The graph preview shows a synthetic one-second particle lifetime across U.
      case "particle": write("age", "uv.x"); write("lifetime", "1.0"); write("normalizedAge", "uv.x"); break;
      case "vector": write("vector", "vec3(" + ["x", "y", "z"].map(port => read(port, () => "0.0")).join(", ") + ")"); break;
      case "noise": {
        const coordinate = get("position"), p = coordinate?.variable ?? "vec3(uv, 0.0)";
        const position = coordinate?.type === "vec2" ? "vec3(" + p + ", 0.0)" : p;
        const scale = parameter(node.params.scale), speed = parameter(node.params.speed);
        const time = read("time", () => "0.0"), seed = parameter(node.params.seed);
        write("value", "latticeNoise(" + position + " * " + scale + " + vec3(0.0, 0.0, " + time + " * " + speed + "), uint(" + seed + "))");
        break;
      }
      case "gradient": {
        const factor = read("factor", () => "uv.x");
        write("color", "mix(" + parameter(node.params.start) + ", " + parameter(node.params.end) + ", clamp(" + factor + ", 0.0, 1.0))");
        break;
      }
      case "texture": {
        const asset = assets[node.params.assetId];
        const pixel = "image" + index;
        if (asset) {
          let slot = images.indexOf(asset);
          if (slot === -1) { slot = images.length; images.push(asset); }
          lines.push("vec4 " + pixel + " = readImage(imageSlot" + slot + ", " + (get("uv")?.variable ?? "uv") + ", " + parameter(asset.role === "color" ? 1 : 0) + ");");
        } else lines.push("vec4 " + pixel + " = vec4(0.0, 0.0, 0.0, 1.0);");
        write("color", pixel + ".rgb"); write("alpha", pixel + ".a");
        break;
      }
      case "add":
      case "multiply": {
        const type = node.params.type;
        const a = read("a", () => parameter(node.params.a), type), b = read("b", () => parameter(node.params.b), type);
        write("value", "clamp(" + a + (node.kind === "add" ? " + " : " * ") + b + ", -1e6, 1e6)");
        break;
      }
      case "clamp": {
        const value = read("value", () => parameter(node.params.value), node.params.type);
        const min = read("min", () => parameter(node.params.min)), max = read("max", () => parameter(node.params.max));
        write("value", "clamp(" + value + ", min(" + min + ", " + max + "), max(" + min + ", " + max + "))");
        break;
      }
      case "output": {
        const color = read("color", () => "0.0", "color");
        const alpha = read("alpha", () => parameter(node.params.alpha));
        lines.push("preview = vec4(encodeColor(" + color + "), clamp(" + alpha + ", 0.0, 1.0));");
        break;
      }
    }
  }
  const declarations = images.map((_, i) => "uniform sampler2D imageSlot" + i + ";");
  if (uniforms.length) declarations.push("uniform vec4 params[" + uniforms.length / 4 + "];");
  const collectImages = (branchNodes: GraphNode[]) => [...new Set(branchNodes.flatMap(node =>
    node.kind === "texture" && assets[node.params.assetId] ? [assets[node.params.assetId]] : []))];
  const sample = compileReference(nodes, inputs, assets);
  const sampleAppearance = appearanceNodes === nodes ? sample : compileReference(appearanceNodes, inputs, assets);
  const sampleField = compileReference(fieldNodes, inputs, assets, true);
  return {
    fragment: "#version 300 es\n" + shaderPrelude + declarations.join("\n") + "\nvoid main() {\n" + lines.join("\n") + "\n}",
    uniforms: new Float32Array(uniforms),
    images,
    animated: nodes.some(node => node.kind === "time"),
    sample: (point, pixels) => sample(point, pixels)!,
    appearanceImages: appearanceNodes === nodes ? images : collectImages(appearanceNodes),
    fieldImages: collectImages(fieldNodes),
    sampleAppearance: (point, values, pixels) => { sampleAppearance(point, pixels, values); },
    sampleField: (point, values, pixels) => { sampleField(point, pixels, values); },
  };
}

const vertexSource = "#version 300 es\nout vec2 uv;\nvoid main() {\n" +
  "uv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n" +
  "gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);\n}";

type Linked = { program: WebGLProgram; source: string; params: WebGLUniformLocation | null; seconds: WebGLUniformLocation | null };
export function createGraphPreview(visible: HTMLCanvasElement, onContextChange?: (lost: boolean) => void) {
  const surface = document.createElement("canvas");
  surface.width = surface.height = visible.width = visible.height = PREVIEW_SIZE;
  const gl = surface.getContext("webgl2", { alpha: true, antialias: false, depth: false, premultipliedAlpha: false });
  const screen = visible.getContext("2d");
  if (!gl || !screen) throw new Error("Texture graph preview requires WebGL2.");
  const context = gl, display = screen;
  let linked: Linked | undefined, epoch = 0;
  let textures = new Map<string, WebGLTexture>();
  surface.addEventListener("webglcontextlost", event => {
    event.preventDefault(); epoch++; linked = undefined; textures.clear(); onContextChange?.(true);
  });
  surface.addEventListener("webglcontextrestored", () => onContextChange?.(false));

  function link(source: string): Linked {
    const shaders: WebGLShader[] = [];
    const program = context.createProgram();
    if (!program) throw new Error("Could not allocate texture preview shader.");
    try {
      for (const [type, body] of [[context.VERTEX_SHADER, vertexSource], [context.FRAGMENT_SHADER, source]] as const) {
        const shader = context.createShader(type);
        if (!shader) throw new Error("Could not allocate texture preview shader stage.");
        shaders.push(shader);
        context.shaderSource(shader, body);
        context.compileShader(shader);
        context.attachShader(program, shader);
      }
      context.linkProgram(program);
      if (!context.getProgramParameter(program, context.LINK_STATUS)) {
        const details = shaders.map(shader => context.getShaderInfoLog(shader)).filter(Boolean).join("\n");
        throw new Error("Texture preview shader failed: " + (details || context.getProgramInfoLog(program) || "link failure"));
      }
      const params = context.getUniformLocation(program, "params[0]");
      const seconds = context.getUniformLocation(program, "seconds");
      return { program, source, params, seconds };
    } catch (error) {
      context.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) context.deleteShader(shader);
    }
  }

  async function upload(asset: TextureAsset, valid: () => boolean): Promise<WebGLTexture | undefined> {
    const response = await fetch(asset.dataURI);
    const bitmap = await createImageBitmap(await response.blob(), {
      colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "none",
    });
    try {
      if (!valid()) return;
      if (bitmap.width !== asset.width || bitmap.height !== asset.height ||
        Math.max(bitmap.width, bitmap.height) > context.getParameter(context.MAX_TEXTURE_SIZE))
        throw new Error("Texture exceeds this preview device’s image dimensions.");
      const texture = context.createTexture();
      if (!texture) throw new Error("Could not allocate graph texture.");
      context.bindTexture(context.TEXTURE_2D, texture);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
      context.texImage2D(context.TEXTURE_2D, 0, context.RGBA8, context.RGBA, context.UNSIGNED_BYTE, bitmap);
      if (context.getError() !== context.NO_ERROR) {
        context.deleteTexture(texture);
        throw new Error("Could not upload graph texture " + asset.name + ".");
      }
      return texture;
    } finally {
      bitmap.close();
    }
  }

  function draw(candidate: Linked, current: Map<string, WebGLTexture>, plan: GraphProgram, frame: number, fps: number) {
    const seconds = graphSeconds(frame, fps);
    if (context.isContextLost()) throw new Error("Texture preview graphics context is unavailable.");
    context.viewport(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    context.useProgram(candidate.program);
    context.uniform1f(candidate.seconds, seconds);
    if (candidate.params) context.uniform4fv(candidate.params, plan.uniforms);
    for (const [index, asset] of plan.images.entries()) {
      context.activeTexture(context.TEXTURE0 + index);
      context.bindTexture(context.TEXTURE_2D, current.get(asset.id)!);
      context.uniform1i(context.getUniformLocation(candidate.program, "imageSlot" + index), index);
    }
    context.drawArrays(context.TRIANGLES, 0, 3);
    if (context.getError() !== context.NO_ERROR) throw new Error("Texture preview draw failed.");
    display.globalCompositeOperation = "copy";
    display.drawImage(surface, 0, 0);
  }

  async function render(plan: GraphProgram, frame: number, fps: number, current = () => true) {
    const generation = epoch;
    const valid = () => current() && generation === epoch && !context.isContextLost();
    if (!valid()) return false;
    const previous = linked;
    const candidate = previous?.source === plan.fragment ? previous : link(plan.fragment);
    const staged = new Map<string, WebGLTexture>();
    let applied = false;
    try {
      for (const asset of plan.images) {
        const texture = textures.get(asset.id) ?? await upload(asset, valid);
        if (texture) staged.set(asset.id, texture);
        if (!valid()) return false;
      }
      draw(candidate, staged, plan, frame, fps);
      if (candidate !== previous && previous) context.deleteProgram(previous.program);
      for (const [id, texture] of textures) if (!staged.has(id)) context.deleteTexture(texture);
      linked = candidate;
      textures = staged;
      applied = true;
      return true;
    } finally {
      if (!applied) {
        if (candidate !== previous) context.deleteProgram(candidate.program);
        for (const [id, texture] of staged) if (texture !== textures.get(id)) context.deleteTexture(texture);
      }
    }
  }
  return {
    render,
    clear() {
      epoch++;
      if (linked) context.deleteProgram(linked.program);
      linked = undefined;
      for (const texture of textures.values()) context.deleteTexture(texture);
      textures.clear();
      display.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    },
  };
}
