import { Box3, Matrix3, Matrix4, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { makeDemo, prepareSplat } from "../src/splat-assets.ts";
import { addSplat, emptyScene, type SplatShapeNode } from "../src/scene-document.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { createBinding } from "../src/splat-binding.ts";
import { gaussianFactor } from "../src/splat-component-transforms.ts";
import { createSplatTransformRuntime } from "../src/splat-transform-runtime.ts";
import {
  evaluateSplatDeformers, getSplatDeformerDefinition, keySplatDeformer, validateShapeDeformers,
  withSplatDeformerControl, withSplatDeformerWeights, type SplatDeformer,
} from "../src/splat-deformers.ts";
import type { SplatScalarMask } from "../src/splat-masks.ts";

const origin = new Vector3(), cluster = getSplatDeformerDefinition("cluster")!;
function entry(id = "cluster", count = 3): SplatDeformer {
  return { id, kind: "cluster", name: id, sourceCount: count, params: cluster.create(new Box3(origin, origin)), envelope: 1 };
}
const points = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 2)];
const read = (index: number, target: Vector3) => { target.copy(points[index]); };
const translated = (node: SplatDeformer, amount: number) => withSplatDeformerControl(node, "position.x", amount);
const rotated = (node: SplatDeformer, amount: number) => withSplatDeformerControl(node, "rotation.z", amount);
function matrixAt(value: ReturnType<typeof evaluateSplatDeformers>, index: number) {
  const matrix = value?.records.find(record => record.index === index)?.matrix;
  return matrix ? new Matrix4().fromArray(matrix) : new Matrix4();
}

describe("weighted cluster stack", () => {
  it("multiplies selection weight, envelope, and mask on stable source indices", () => {
    const weights = [{ index: 0, weight: .5 }, { index: 2, weight: 1 }];
    const mask: SplatScalarMask = { id: "weight", name: "weight", assetId: "asset", version: 1, sourceCount: 3, locked: false,
      componentLocks: [], data: { kind: "dense", values: [.25, 1, 0] } };
    const stack = [{ ...translated(entry(), 8), weights, envelope: .5, maskId: mask.id }];
    const result = evaluateSplatDeformers(stack, [mask], undefined, 0, read)!;
    expect(result.records.map(record => record.index)).toEqual([0]);
    expect(points[0].clone().applyMatrix4(matrixAt(result, 0)).toArray()).toEqual([1.5, 0, 0]);
    expect(points[1].clone().applyMatrix4(matrixAt(result, 1)).toArray()).toEqual(points[1].toArray());
    expect(withSplatDeformerWeights(stack[0], [0, 1], .25).weights).toEqual([{ index: 0, weight: .25 }, { index: 1, weight: .25 }, { index: 2, weight: 1 }]);
  });

  it("retains authored turns when translating a rotated cluster handle", () => {
    const node = rotated(entry(), 450);
    const handle = cluster.handle!;
    const pose = handle.get(node.params, 0);
    pose.position.set(2, 3, 1);
    const updated = handle.set(node.params, 0, pose);
    expect(updated.rotation).toEqual([0, 0, 450]);
    expect(updated.position).toEqual([2, 3, 1]);
  });

  it("uses ordered transforms after component edits, retaining intact affine covariance", () => {
    const rest = { version: 1 as const, sourceCount: 3, records: [{ index: 0, matrix: new Matrix4().makeTranslation(1, 0, 0).toArray() }] };
    const shift = translated(entry("shift"), 3), turn = rotated(entry("turn"), 90);
    const forward = matrixAt(evaluateSplatDeformers([shift, turn], [], rest, 0, read), 0);
    const backward = matrixAt(evaluateSplatDeformers([turn, shift], [], rest, 0, read), 0);
    expect(points[0].clone().applyMatrix4(forward).y).toBeCloseTo(5);
    expect(points[0].clone().applyMatrix4(backward).x).toBeCloseTo(3);
    const halfTurn = { ...rotated(entry(), 180), envelope: .5 };
    const half = matrixAt(evaluateSplatDeformers([halfTurn], [], undefined, 0, read), 0);
    const factor = new Matrix3().setFromMatrix4(gaussianFactor(points[0], new Vector3(2, 1, .5), cluster.handle!.get(entry().params, 0).rotation, half));
    const covariance = factor.clone().multiply(factor.clone().transpose()).elements;
    expect(covariance[0]).toBeCloseTo(1);
    expect(covariance[4]).toBeCloseTo(4);
    expect(covariance[8]).toBeCloseTo(.25);
    expect(evaluateSplatDeformers([entry()], [], rest, 0, read)).toBe(rest);
  });

  it("samples historical and fractional poses and roundtrips their authoring", async () => {
    let node = keySplatDeformer(keySplatDeformer(entry(), "position.x", 0, 0), "position.x", 8, 4);
    node = keySplatDeformer(keySplatDeformer(node, "envelope", 0, 0), "envelope", 8, 1);
    const { document } = addSplat(emptyScene(), { id: "proc", kind: "procedural", generator: "knot-v1" }, "Cluster test", [0, 0, 0], "cluster-object", "cluster-shape");
    const shape = document.nodes["cluster-shape"] as SplatShapeNode;
    shape.deformers = [node];
    const editor = { camera: { position: [0, 0, 5] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 42, near: .1, far: 50 }, time: 0 };
    const reopened = await decodeProject(await encodeProject(document, new Map(), editor));
    const nodeAfter = (reopened.scene.nodes[shape.id] as SplatShapeNode).deformers![0];
    expect(nodeAfter).toEqual(node);
    for (const [frame, expected] of [[8, 5], [2.5, 1.390625], [0, 1], [8, 5]]) {
      const value = evaluateSplatDeformers([nodeAfter], [], undefined, frame, read);
      expect(points[0].clone().applyMatrix4(matrixAt(value, 0)).x).toBeCloseTo(expected);
    }
    expect(() => validateShapeDeformers(shape, 4)).toThrow(/original decoded/);
    (shape as SplatShapeNode).deformers = [{ ...node, maskId: "missing" }];
    expect(() => validateScene(document)).toThrow(/mask/);
    (shape as SplatShapeNode).deformers = [{ ...node, keys: [{ channel: "position.y", frame: 0, value: Infinity }] }];
    expect(() => validateScene(document)).toThrow(/key/);
  });

  it("stages transforms before skinning and preserves the previous runtime on invalid preview", async () => {
    const mesh = makeDemo(), data = await prepareSplat(mesh);
    const runtime = createSplatTransformRuntime(mesh), original = mesh.extSplats!.getSplat(0).center.clone();
    const move = { ...translated(entry("move", data.count), 2), weights: [{ index: 0, weight: 1 }] };
    runtime.update(undefined, [move]);
    expect(runtime.positions([0])[0]).toBeCloseTo(original.x + 2);
    expect(runtime.bounds(index => index === 0).getCenter(new Vector3()).x).toBeCloseTo(original.x + 2);
    const oversized = Array.from({ length: 4 }, (_, number) => ({
      ...withSplatDeformerControl(entry(String(number), data.count), "scale.x", 1000),
      weights: [{ index: 0, weight: 1 }],
    }));
    expect(() => runtime.prepare(undefined, oversized)).toThrow(/out-of-range/);
    expect(runtime.positions([0])[0]).toBeCloseTo(original.x + 2);
    runtime.setBound(true);
    const binding = createBinding(mesh, { meshSpace: true, jointIds: ["bone"], restMatrices: [new Matrix4().toArray()] }, undefined, [], runtime);
    binding.update(() => new Matrix4().makeRotationZ(Math.PI / 2));
    const posed = binding.getComponentPositions([0]);
    expect(posed[0]).toBeCloseTo(-original.y);
    expect(posed[1]).toBeCloseTo(original.x + 2);
    expect(mesh.extSplats!.getSplat(0).center.toArray()).toEqual(original.toArray());
    binding.dispose();
    runtime.dispose();
    mesh.dispose();
  });
});
