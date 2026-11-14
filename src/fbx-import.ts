import { AnimationMixer, Bone, Euler, Group, LoadingManager, LoopOnce, MathUtils, Matrix3, Matrix4, Mesh, Quaternion, SkinnedMesh, Texture, TextureLoader, Vector3, type AnimationClip } from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { defaultAnimation, type AnimationChannel, type AnimationTrack } from "./animation.ts";
import { unwrapEuler } from "./animation-edit.ts";
import { validateScene } from "./project-archive.ts";
import { validateMeshShape } from "./mesh-modeling.ts";
import { uniqueName, type MeshShapeNode, type SceneDocument, type TransformChannels, type Vec3 } from "./scene-document.ts";
import type { Joint } from "./skeleton.ts";
import { captureMaterials, disposeMaterials, MESH_TEXTURE_SLOTS } from "./mesh-materials.ts";
import type { MeshSkin } from "./mesh-skin.ts";

const id = () => crypto.randomUUID();
export function hasCompletePNG(dataURI: string): boolean {
  if (!dataURI.startsWith("data:image/png;")) return true;
  const encoded = dataURI.slice(dataURI.indexOf(",") + 1);
  try { return atob(encoded.slice(-24)).endsWith("\x00\x00\x00\x00IEND\xaeB\x60\x82"); } catch { return false; }
}
const identity = (): TransformChannels => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
function channels(matrix: Matrix4, label: string): TransformChannels {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3(); matrix.decompose(p, q, s);
  const rebuilt = new Matrix4().compose(p, q, s);
  if (s.toArray().some(n => !Number.isFinite(n) || n < .001)
    || matrix.elements.some((n, i) => !Number.isFinite(n) || Math.abs(n - rebuilt.elements[i]) > 1e-5 * Math.max(1, Math.abs(n))))
    throw Error(`${label}: reflected, sheared, or near-zero transforms are unsupported. Apply transforms before exporting FBX.`);
  const e = new Euler().setFromQuaternion(q, "XYZ");
  return { position: p.toArray().map(n => n === 0 ? 0 : n) as Vec3, rotation: [e.x, e.y, e.z].map(n => n === 0 ? 0 : MathUtils.radToDeg(n)) as Vec3, scale: s.toArray() as Vec3 };
}
function rigid(bone: Bone): Matrix4 {
  const pose = channels(bone.matrixWorld, bone.name || "Joint");
  if (Math.max(...pose.scale) - Math.min(...pose.scale) > 1e-5 * Math.max(...pose.scale))
    throw Error(`${bone.name}: nonuniform joint scaling is unsupported. Apply armature scale before exporting.`);
  return new Matrix4().compose(new Vector3(...pose.position), new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3)), new Vector3(1, 1, 1));
}

// FBX splits vertices at UV/normal seams. Welding by position can also join
// unrelated shells, so separate disconnected fans and overlapping edges again.
function separateMeshFans(shape: MeshShapeNode): boolean {
  const vertices = new Map(shape.vertices.map(v => [v.id, v]));
  let changed = false;
  const duplicate = (key: string) => {
    if (shape.vertices.length >= 100000) throw Error("Imported mesh exceeds 100,000 vertices after separating topology.");
    const original = vertices.get(key)!, next = { id: `v${shape.vertices.length}`, position: [...original.position] as Vec3 };
    shape.vertices.push(next); vertices.set(next.id, next);
    for (const set of Object.values(shape.uvSets ?? {})) set[next.id] = [...set[key]];
    if (shape.uvs) shape.uvs[next.id] = [...shape.uvs[key]];
    for (const morph of shape.morphTargets ?? []) morph.deltas[next.id] = [...morph.deltas[key]];
    if (shape.skin) shape.skin.weights[next.id] = shape.skin.weights[key].map(i => ({ ...i }));
    if (shape.normals) shape.normals[next.id] = [...shape.normals[key]];
    changed = true; return next.id;
  };
  const directed = new Set<string>();
  for (const face of shape.faces) {
    if (face.vertices.some((v, i) => directed.has(`${v}/${face.vertices[(i + 1) % 3]}`))) face.vertices = face.vertices.map(duplicate);
    face.vertices.forEach((v, i) => directed.add(`${v}/${face.vertices[(i + 1) % 3]}`));
  }
  const edges = new Map<string, number[]>(), incident = new Map<string, number[]>();
  const originalFaces = shape.faces.map(face => [...face.vertices]);
  shape.faces.forEach((face, i) => face.vertices.forEach((v, k) => {
    const faces = incident.get(v) ?? []; faces.push(i); incident.set(v, faces);
    const next = face.vertices[(k + 1) % 3], key = [v, next].sort().join("/");
    const connected = edges.get(key) ?? []; connected.push(i); edges.set(key, connected);
  }));
  for (const [vertex, faces] of incident) {
    const remaining = new Set(faces); let first = true;
    while (remaining.size) {
      const seed = remaining.values().next().value!, pending = [seed], component: number[] = [];
      while (pending.length) {
        const f = pending.pop()!; if (!remaining.delete(f)) continue; component.push(f);
        for (const other of originalFaces[f]) if (other !== vertex)
          for (const neighbor of edges.get([vertex, other].sort().join("/")) ?? []) if (remaining.has(neighbor)) pending.push(neighbor);
      }
      if (!first) {
        const replacement = duplicate(vertex);
        for (const f of component) shape.faces[f].vertices = shape.faces[f].vertices.map(v => v === vertex ? replacement : v);
      }
      first = false;
    }
  }
  return changed;
}

/** Error-bounded reduction: every sampled value remains within tolerance. */
function reducedSamples(times: number[], values: number[], steps: Set<number>, tolerance: number, budget?: { remaining: number }): number[] {
  const keep = new Set([0, times.length - 1]);
  for (const i of steps) { keep.add(i); if (i + 1 < times.length) keep.add(i + 1); }
  const boundaries = [...keep].sort((a, b) => a - b), pending: [number, number][] = [];
  for (let i = 1; i < boundaries.length; i++) pending.push([boundaries[i - 1], boundaries[i]]);
  while (pending.length) {
    const [a, b] = pending.pop()!; let worst = tolerance, chosen = -1;
    if (budget) {
      budget.remaining -= b - a - 1;
      if (budget.remaining < 0) throw Error("The take is too complex to reduce. Export a shorter range or lower the scene FPS.");
    }
    for (let i = a + 1; i < b; i++) {
      const linear = values[a] + (values[b] - values[a]) * (times[i] - times[a]) / (times[b] - times[a]);
      const error = Math.abs(values[i] - linear);
      if (error > worst) { worst = error; chosen = i; }
    }
    if (chosen >= 0) { keep.add(chosen); pending.push([a, chosen], [chosen, b]); }
  }
  return [...keep].sort((a, b) => a - b);
}

function readBoneRest(source: Group) {
  source.updateMatrixWorld(true);
  const bones: Bone[] = [];
  source.traverse(object => { if ((object as Bone).isBone) bones.push(object as Bone); });
  const boneSet = new Set(bones);
  const boneParents = new Map(bones.map(b => {
    let parent = b.parent;
    while (parent && !boneSet.has(parent as Bone)) parent = parent.parent;
    return [b, parent as Bone | null] as const;
  }));
  const restRigid = new Map(bones.map(b => [b, rigid(b)]));
  const rows = bones.map(bone => {
    const parent = boneParents.get(bone), matrix = restRigid.get(bone)!.clone();
    if (parent) matrix.premultiply(restRigid.get(parent)!.clone().invert());
    return { bone, parent: parent ?? null, pose: channels(matrix, bone.name) };
  });
  return { bones, boneParents, restRigid, rows };
}

export function inspectFBXRestSkeleton(source: Group) {
  return readBoneRest(source).rows;
}

type SkeletalTake = { clip: AnimationClip; rotationForBone?(bone: Bone, rotation: Vec3): Vec3 };

function* convertFBXWork(source: Group, doc: SceneDocument, name: string, take?: SkeletalTake) {
  const { bones, boneParents, restRigid, rows } = readBoneRest(source);
  const meshes: Mesh[] = [], warnings = new Set<string>();
  if (!take) source.traverse(object => { if ((object as Mesh).isMesh) meshes.push(object as Mesh); });
  if (!bones.length && !meshes.length) throw Error("This FBX contains no meshes or skeleton joints.");
  if (bones.length + (doc.joints?.length ?? 0) > 1000) throw Error("The scene supports at most 1,000 joints.");
  const boneIds = new Map(bones.map(b => [b, id()]));
  const restScale = new Map(bones.map(b => [b, new Vector3().setFromMatrixScale(b.matrixWorld)]));
  const jointNames = new Set(doc.joints?.map(j => j.name));
  const joints: Joint[] = rows.map(({ bone, parent, pose }) => {
    const base = bone.name || "joint"; let jointName = base, suffix = 2;
    while (jointNames.has(jointName)) jointName = `${base}_${suffix++}`;
    jointNames.add(jointName);
    return { id: boneIds.get(bone)!, name: jointName, parentId: parent ? boneIds.get(parent)! : null, position: pose.position, rotation: pose.rotation };
  });
  let next: SceneDocument = { ...doc, nodes: { ...doc.nodes }, rootIds: [...doc.rootIds], joints: [...doc.joints ?? [], ...joints] };
  const meshIds = new Map<Mesh, string>();
  for (const mesh of meshes) {
    const geometry = mesh.geometry, positions = geometry.getAttribute("position"), index = geometry.index;
    const count = index?.count ?? positions?.count ?? 0;
    if (!positions || count === 0) continue;
    if (count % 3 || count / 3 > 100000) throw Error(`${mesh.name}: meshes support at most 100,000 triangular faces.`);
    const skinned = (mesh as SkinnedMesh).isSkinnedMesh ? mesh as SkinnedMesh : undefined;
    const skinIndices = geometry.getAttribute("skinIndex"), skinWeights = geometry.getAttribute("skinWeight");
    let skin: MeshSkin | undefined;
    if (skinned) {
      if (!skinIndices || !skinWeights || skinned.skeleton.bones.some(b => !boneIds.has(b))) throw Error(`${mesh.name}: incomplete skin or skeleton.`);
      skin = {
        jointIds: skinned.skeleton.bones.map(b => boneIds.get(b)!),
        // Preserve the original FBX inverse binds, including its constant uniform bone scale.
        inverseBindMatrices: skinned.skeleton.bones.map((b, i) => restRigid.get(b)!.clone().invert().multiply(b.matrixWorld).multiply(skinned.skeleton.boneInverses[i]).toArray()),
        weights: {},
      };
    }
    const transformId = id(), shapeId = id(), objectName = uniqueName(next, mesh.name || name);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];


    const color = (materials[0] as { color?: { getHexString(): string } }).color?.getHexString() ?? "b8bdc5";
    const shape: MeshShapeNode = { id: shapeId, type: "meshShape", name: `${objectName}Shape`, parentId: transformId,
      vertices: [], faces: [], color: `#${color}`, shading: "smooth", wireframe: false, ...(skin ? { skin } : {}) };
    shape.materials = captureMaterials(materials);
    // Some exporters write a zero scalar alongside an opacity texture whose
    // pixels contain the actual visibility. Multiplying both hides every face.
    shape.materials.forEach((data, i) => {
      if (data.opacity === 0 && (materials[i] as import("three").MeshPhongMaterial).alphaMap) {
        data.opacity = 1; data.transparent = true;
        warnings.add(`Material ${data.name || objectName}: normalized exporter zero opacity scalar alongside an opacity-map reference.`);
      }
    });
    const uv = geometry.getAttribute("uv");
    const normals = geometry.getAttribute("normal");
    if (normals) shape.normals = {};
    if (uv) shape.uvs = {};
    const extraUVs = [1, 2, 3].map(i => geometry.getAttribute(`uv${i}`));
    if (extraUVs.some(Boolean)) shape.uvSets = Object.fromEntries(extraUVs.flatMap((a, i) => a ? [[String(i + 1), {}]] : []));
    const morphs = geometry.morphAttributes.position ?? [];
    for (const material of shape.materials) for (const slot of MESH_TEXTURE_SLOTS) {
      const map = material[slot]; if (!map) continue;
      if (!(map.channel === 0 ? uv : extraUVs[map.channel - 1])) {
        warnings.add(`${objectName}: ${slot} references missing UV set ${map.channel}; this texture was omitted.`); delete material[slot];
      }
    }
    if (morphs.length > 128) throw Error("Meshes support at most 128 blend shapes.");
    if (morphs.length) shape.morphTargets = morphs.map((m, i) => ({ name: m.name || Object.keys(mesh.morphTargetDictionary ?? {}).find(k => mesh.morphTargetDictionary![k] === i) || `Shape ${i + 1}`, weight: mesh.morphTargetInfluences?.[i] ?? 0, deltas: {} }));
    const welded = new Map<string, string>(), p = new Vector3();
    const vertexFor = (i: number) => {
      p.fromBufferAttribute(positions, i);
      if (skinned) p.applyMatrix4(skinned.bindMatrix);
      let influences: { joint: number; weight: number }[] = [];
      if (skin) {
        const merged = new Map<number, number>();
        for (let k = 0; k < 4; k++) {
          const joint = skinIndices.getComponent(i, k), weight = skinWeights.getComponent(i, k);
          if (!Number.isFinite(weight) || weight < 0) throw Error("Invalid FBX skin weight.");
          if (weight > 0) {
            if (!Number.isInteger(joint) || joint < 0 || joint >= skin.jointIds.length) throw Error("Invalid FBX skin joint index.");
            merged.set(joint, (merged.get(joint) ?? 0) + weight);
          }
        }
        const total = [...merged.values()].reduce((a, b) => a + b, 0);
        if (!total) throw Error(`${mesh.name}: a skinned vertex has no influences.`);
        influences = [...merged].sort(([a], [b]) => a - b).map(([joint, weight]) => ({ joint, weight: weight / total }));
      }
      const texcoord: [number, number] | undefined = uv ? [uv.getX(i), uv.getY(i)] : undefined;
      const normal = normals ? new Vector3().fromBufferAttribute(normals, i) : undefined;
      if (normal && skinned) normal.applyMatrix3(new Matrix3().getNormalMatrix(skinned.bindMatrix));
      normal?.normalize();
      const deltas = morphs.map(m => {
        const delta = new Vector3().fromBufferAttribute(m, i);
        if (!geometry.morphTargetsRelative) delta.sub(new Vector3().fromBufferAttribute(positions, i));
        if (skinned) delta.applyMatrix3(new Matrix3().setFromMatrix4(skinned.bindMatrix));
        return delta.toArray() as Vec3;
      });
      const extraCoords = extraUVs.map(a => a ? [a.getX(i), a.getY(i)] as [number, number] : undefined);
      const key = JSON.stringify([p.toArray(), influences, texcoord, deltas, extraCoords, normal?.toArray()]);
      const found = welded.get(key); if (found) return found;
      if (shape.vertices.length >= 100000) throw Error(`${mesh.name}: meshes support at most 100,000 vertices.`);
      const vertexId = `v${shape.vertices.length}`;
      shape.vertices.push({ id: vertexId, position: p.toArray() as Vec3 }); welded.set(key, vertexId);
      if (skin) skin.weights[vertexId] = influences;
      if (normal) shape.normals![vertexId] = normal.toArray() as Vec3;
      if (texcoord) shape.uvs![vertexId] = texcoord;
      extraCoords.forEach((coord, j) => { if (coord) shape.uvSets![String(j + 1)][vertexId] = coord; });
      deltas.forEach((delta, m) => { shape.morphTargets![m].deltas[vertexId] = delta; });
      return vertexId;
    };
    for (let i = 0; i < count; i += 3) {
      const vertices = [0, 1, 2].map(k => vertexFor(index ? index.getX(i + k) : i + k));
      if (new Set(vertices).size !== 3) { warnings.add("Degenerate triangles were skipped."); continue; }
      const materialIndex = geometry.groups.find(g => i >= g.start && i < g.start + g.count)?.materialIndex ?? 0;
      shape.faces.push({ id: `f${i / 3}`, vertices, materialIndex });
    }
    if (separateMeshFans(shape)) warnings.add("Disconnected or overlapping mesh regions were separated to preserve valid editable topology.");
    validateMeshShape(shape);
    const pose = skin ? identity() : channels(mesh.matrixWorld, objectName);
    next.nodes[transformId] = { id: transformId, type: "transform", name: objectName, parentId: null, rotationOrder: "XYZ", ...pose };
    next.nodes[shapeId] = shape; next.rootIds.push(transformId); meshIds.set(mesh, transformId);
  }
  if (!meshIds.size && !bones.length) throw Error("This FBX contains no usable geometry or skeleton.");

  const animation = doc.animation ?? defaultAnimation(), fps = animation.fps;
  const tracks: AnimationTrack[] = [], clipRanges: { name: string; start: number; end: number }[] = [];
  let start = animation.tracks.length ? Math.ceil(animation.end) + 1 : 0;
  const targets = [...bones.map(b => ({ object: b, id: boneIds.get(b)!, joint: true })),
    ...[...meshIds].filter(([mesh]) => !(mesh as SkinnedMesh).isSkinnedMesh).map(([object, targetId]) => ({ object, id: targetId, joint: false }))];
  const raw = new Map<string, { targetId: string; channel: AnimationChannel; times: number[]; values: number[]; steps: Set<number> }>();
  let sampleValues = 0;
  const mixer = new AnimationMixer(source);
  const sampleBatch = Math.max(1, Math.floor(15000 / Math.max(1, bones.length * 6)));
  try {
    for (const clip of take ? [take.clip] : source.animations) {
      if (!clip.tracks.length) continue;
      if (!Number.isFinite(clip.duration) || clip.duration < 0) throw Error("FBX contains an invalid animation duration.");
      const frames = Math.ceil(clip.duration * fps);
      sampleValues += (frames + 1) * ([...meshIds.keys()].reduce((n, mesh) => n + (mesh.morphTargetInfluences?.length ?? 0), 0) + targets.reduce((n, target) => n + (target.joint ? 6 : 9), 0));
      if (frames > 100000 || sampleValues > 2000000 || start + frames > 1e6) throw Error("FBX animation is too large. Export shorter clips or use a lower scene FPS.");
      const action = mixer.clipAction(clip); action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
      const previous = new Map<string, Vec3>();
      for (let frame = 0; frame <= frames; frame++) {
        if (take && frame % sampleBatch === 0) yield;
        mixer.setTime(Math.min(frame / fps, clip.duration)); source.updateMatrixWorld(true);
        const worlds = new Map(bones.map(b => {
          const scale = new Vector3().setFromMatrixScale(b.matrixWorld);
          if (scale.distanceTo(restScale.get(b)!) > 1e-5 * restScale.get(b)!.length()) throw Error(`${b.name}: animated joint scaling is not supported.`);
          return [b, rigid(b)] as const;
        }));
        for (const [mesh, targetId] of meshIds) for (let m = 0; m < (mesh.morphTargetInfluences?.length ?? 0); m++) {
          const channel = `morph.${m}` as AnimationChannel, key = `${targetId}:${channel}`;
          let row = raw.get(key);
          if (!row) { row = { targetId, channel, times: [], values: [], steps: new Set() }; raw.set(key, row); }
          if (frame === 0 && row.times.length) row.steps.add(row.times.length - 1);
          row.times.push(start + frame); row.values.push(mesh.morphTargetInfluences![m]);
        }
        for (const target of targets) {
          const matrix = target.joint ? worlds.get(target.object as Bone)!.clone() : target.object.matrixWorld;
          const parent = target.joint ? boneParents.get(target.object as Bone) : undefined;
          if (parent) matrix.premultiply(worlds.get(parent)!.clone().invert());
          const pose = channels(matrix, target.object.name);
          if (target.joint && take?.rotationForBone) pose.rotation = take.rotationForBone(target.object as Bone, pose.rotation);
          if (previous.has(target.id)) pose.rotation = unwrapEuler(pose.rotation, previous.get(target.id)!);
          previous.set(target.id, pose.rotation);
          for (const kind of target.joint ? ["position", "rotation"] as const : ["position", "rotation", "scale"] as const) {
            for (let axis = 0; axis < 3; axis++) {
              const channel = `${kind}.${"xyz"[axis]}` as AnimationChannel, key = `${target.id}:${channel}`;
              let row = raw.get(key);
              if (!row) { row = { targetId: target.id, channel, times: [], values: [], steps: new Set() }; raw.set(key, row); }
              if (frame === 0 && row.times.length) row.steps.add(row.times.length - 1);
              row.times.push(start + frame); row.values.push(pose[kind][axis] === 0 ? 0 : pose[kind][axis]);
            }
          }
        }
      }
      clipRanges.push({ name: clip.name || `Clip ${clipRanges.length + 1}`, start, end: start + frames });
      start += frames + 1;
      action.stop(); mixer.stopAllAction(); source.updateMatrixWorld(true);
    }
  } finally { mixer.stopAllAction(); mixer.uncacheRoot(source); source.updateMatrixWorld(true); }
  const reductionBudget = take ? { remaining: 16_000_000 } : undefined;
  let reduced = 0;
  for (const row of raw.values()) {
    if (take && reduced++ % 24 === 0) yield;
    const keys: AnimationTrack["keys"] = [];
    const tolerance = row.channel.startsWith("rotation.") ? .05 : .0001;
    for (const i of reducedSamples(row.times, row.values, row.steps, tolerance, reductionBudget)) {
      keys.push({ id: id(), time: row.times[i], value: row.values[i], interpolation: row.steps.has(i) ? "step" : "linear", tangentMode: "auto" });
    }
    tracks.push({ id: id(), targetId: row.targetId, channel: row.channel, keys });
  }
  if (tracks.length) next = { ...next, animation: { ...animation, start: animation.tracks.length ? Math.min(animation.start, clipRanges[0].start) : 0,
    end: Math.max(animation.tracks.length ? animation.end : 1, start - 1), tracks: [...animation.tracks, ...tracks] } };
  validateScene(next);
  return { document: next, objectIds: [...meshIds.values()], jointIds: [...boneIds.values()], warnings: [...warnings], clips: clipRanges };
}

/** Convert a parsed FBX atomically; callers commit only after full validation. */
export function convertFBX(source: Group, doc: SceneDocument, name: string, take?: SkeletalTake) {
  const work = convertFBXWork(source, doc, name, take);
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

/** Sample a single take in batches while the editor can process cancel and new input. */
export async function convertFBXTake(source: Group, doc: SceneDocument, name: string, take: SkeletalTake, signal: AbortSignal) {
  signal.throwIfAborted();
  const work = convertFBXWork(source, doc, name, take);
  let step = work.next();
  try {
    while (!step.done) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal.throwIfAborted();
      step = work.next();
    }
    return step.value;
  } finally {
    if (!step.done) work.return(undefined as never);
  }
}

/** Read a local animation-only FBX without loading referenced images. */
export async function readFBXMotion(file: File): Promise<Group> {
  if (!/\.fbx$/i.test(file.name)) throw Error("Choose an FBX motion file.");
  if (!file.size || file.size > 32 * 1024 * 1024) throw Error("Motion FBX files must be between 1 byte and 32 MiB.");
  const manager = new LoadingManager(), textures: Texture[] = [], meshes: Mesh[] = [];
  class IgnoreTextures extends TextureLoader {
    override load(url: string) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      const texture = new Texture();
      textures.push(texture);
      return texture;
    }
  }
  manager.addHandler(/.*/, new IgnoreTextures(manager));
  try {
    const source = new FBXLoader(manager).parse(await file.arrayBuffer(), "");
    source.traverse(object => { if ((object as Mesh).isMesh) meshes.push(object as Mesh); });
    if (meshes.length) throw Error("Choose the Mixamo animation FBX downloaded Without Skin.");
    return source;
  } finally {
    for (const mesh of meshes) {
      mesh.geometry.dispose();
      disposeMaterials(mesh.material);
      if ((mesh as SkinnedMesh).isSkinnedMesh) (mesh as SkinnedMesh).skeleton.dispose();
    }
    textures.forEach(texture => texture.dispose());
  }
}

/** FBX is parsed locally. Unsupported texture references never trigger network requests. */
export async function importFBX(file: File, doc: SceneDocument, sidecars: File[] = []) {
  if (file.size > 128 * 1024 * 1024) throw Error("FBX imports are limited to 128 MiB.");
  const manager = new LoadingManager(), textures: Texture[] = [], pending: Promise<void>[] = [], warnings: string[] = [];
  const basename = (value: string) => { try { value = decodeURIComponent(value); } catch { /* literal percent in a filename */ } return value.replaceAll("\\", "/").split("/").pop()!.toLowerCase(); };
  class LocalTextures extends TextureLoader {
    override load(url: string) {
      const texture = new Texture(); textures.push(texture);
      pending.push((async () => {
        let dataURI: string;
        // FBXLoader fills the texture name synchronously after load() returns.
        await Promise.resolve();
        const replacements = sidecars.filter(f => basename(f.name).replace(/\.[^.]+$/, "") === texture.name.toLowerCase());
        if ((url.startsWith("data:") || url.startsWith("blob:")) && replacements.length === 1) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          url = replacements[0].name;
        }
        if (url.startsWith("data:")) { if (url.length > 24 * 1024 * 1024) throw Error("Texture exceeds 16 MiB."); dataURI = url; }
        else {
          let blob: Blob;
          if (url.startsWith("blob:")) { blob = await (await fetch(url)).blob(); URL.revokeObjectURL(url); }
          else {
            const matches = sidecars.filter(f => basename(f.name) === basename(url));
            if (matches.length !== 1) { warnings.push(`Texture ${basename(url)} is missing or ambiguous. Select it together with the FBX.`); return; }
            const file = matches[0], ext = file.name.split(".").pop()!.toLowerCase();
            const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" } as Record<string,string>)[ext];
            blob = mime ? new Blob([file], { type: mime }) : file;
          }
          if (blob.size > 16 * 1024 * 1024) throw Error("Texture exceeds 16 MiB.");
          dataURI = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = () => reject(Error("Could not read texture.")); reader.readAsDataURL(blob); });
        }
        if (!/^data:image\/(png|jpeg|webp|gif|bmp);base64,/i.test(dataURI)) throw Error("Texture format unsupported. Use PNG, JPEG, WebP, GIF, or BMP.");
        if (!hasCompletePNG(dataURI)) {
            warnings.push(`Texture ${texture.name || "image"} contains truncated PNG data and was omitted. Select the complete image alongside the FBX to replace it.`);
            return;
        }
        if (typeof Image !== "undefined") {
          const image = new Image(); image.src = dataURI;
          try { await image.decode(); } catch { throw Error("Could not decode texture image. Use a valid PNG, JPEG, WebP, GIF, or BMP."); }
          if (image.width * image.height > 64 * 1024 * 1024) throw Error("Texture exceeds 64 million pixels.");
        }
        texture.userData.musubiDataURI = dataURI;
        // Runtime materials load these embedded images; no external URL is retained.
      })());
      return texture;
    }
  }
  manager.addHandler(/.*/, new LocalTextures(manager));
  let source: Group | undefined;
  try {
    source = new FBXLoader(manager).parse(await file.arrayBuffer(), "");
    await Promise.all(pending);
    const result = convertFBX(source, doc, file.name.replace(/\.fbx$/i, ""));
    result.warnings.push(...warnings); return result;
  } finally {
    await Promise.allSettled(pending);
    source?.traverse(object => {
      if (!(object as Mesh).isMesh) return;
      const mesh = object as Mesh; mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
      if ((mesh as SkinnedMesh).isSkinnedMesh) (mesh as SkinnedMesh).skeleton.dispose();
    });
    textures.forEach(texture => texture.dispose());
  }
}
