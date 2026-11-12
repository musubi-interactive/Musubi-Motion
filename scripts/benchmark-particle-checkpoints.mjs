import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, platform, totalmem } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Reuse the repository's original generated logo and animated noise ramp.
// Optionally write the longer, higher-rate version as an MSB browser fixture.
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root, configLoader: "runner", cacheDir: resolve(process.env.TEMP ?? root, "particle-checkpoint-benchmark"),
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { decodeProject, encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const { createParticleSimulation } = await server.ssrLoadModule("/src/particle-simulation.ts");
  const { createParticlePoseSampler } = await server.ssrLoadModule("/src/particle-pose-sampler.ts");
  const { ParticleCheckpointCache, PARTICLE_CHECKPOINT_BYTES, PARTICLE_CHECKPOINT_INTERVAL } = await server.ssrLoadModule("/src/particle-checkpoints.ts");
  const opened = await decodeProject(new Uint8Array(await readFile(resolve(root, "examples/particle-map-study.msb"))));
  const doc = opened.scene;
  doc.animation.end = 336;
  const emitters = Object.values(doc.nodes).filter(node => node.type === "particleShape");
  for (const emitter of emitters) {
    emitter.endFrame = 312;
    emitter.rate = 5200;
  }
  const shape = emitters.find(emitter => emitter.emissionMap.source === "graph");
  const mesh = doc.nodes[shape.surfaceId];
  doc.animation.tracks.push({
    id: "benchmark-pose", targetId: mesh.parentId, channel: "position.z", keys: [
      { id: "pose-start", time: 0, value: 0, interpolation: "linear", tangentMode: "auto" },
      { id: "pose-end", time: 312, value: 1.6, interpolation: "linear", tangentMode: "auto" },
    ],
  });
  const archive = await encodeProject(doc, opened.files, { ...opened.editor, time: 0 });
  const roundTrip = await decodeProject(archive);
  assert.deepEqual(roundTrip.scene, doc);
  if (process.argv[2]) await writeFile(resolve(process.argv[2]), archive);

  async function measure(simulation, frame, measurePoses) {
    measurePoses.reset();
    const start = performance.now();
    const result = await simulation.snapshotAt(frame);
    return { result, ms: performance.now() - start, historicalPoseSamples: measurePoses.count() };
  }
  function instrumentPose() {
    const sampler = createParticlePoseSampler(doc);
    let calls = 0;
    return {
      worldAt(frame) { calls++; return sampler.worldAt(frame); },
      reset() { calls = 0; },
      count() { return calls; },
    };
  }
  const warmPose = instrumentPose();
  const warm = createParticleSimulation(doc, shape, warmPose, undefined, new ParticleCheckpointCache());
  const seekResults = [];
  try {
    const prime = await measure(warm, 312, warmPose);
    for (const frame of [242.4, 177.2, 281.4, 216.8]) {
      const coldPose = instrumentPose();
      const cold = createParticleSimulation(doc, shape, coldPose, undefined, null);
      try {
        const replay = await measure(cold, frame, coldPose);
        const cached = await measure(warm, frame, warmPose);
        assert.deepEqual(cached.result, replay.result);
        assert.ok(cached.historicalPoseSamples < replay.historicalPoseSamples);
        seekResults.push({
          frame, liveParticles: cached.result.count,
          coldMs: Number(replay.ms.toFixed(2)), warmMs: Number(cached.ms.toFixed(2)),
          coldPoseSamples: replay.historicalPoseSamples, warmPoseSamples: cached.historicalPoseSamples,
        });
      } finally {
        cold.dispose();
      }
    }
    const sum = field => seekResults.reduce((total, result) => total + result[field], 0);
    console.log(JSON.stringify({
      hardware: { platform: platform(), cpu: cpus()[0]?.model, ramGiB: Math.round(totalmem() / 2 ** 30), node: process.version },
      fixture: { candidatesPerSecond: shape.rate, lifetimeSeconds: shape.lifetime, framesPerSecond: doc.animation.fps, vertices: mesh.vertices.length, faces: mesh.faces.length,
        graphNodes: doc.proceduralGraph.nodes.length, elapsedSeconds: shape.endFrame / doc.animation.fps,
        cacheBytes: PARTICLE_CHECKPOINT_BYTES, checkpointStepInterval: PARTICLE_CHECKPOINT_INTERVAL },
      primeMs: Number(prime.ms.toFixed(2)),
      seekResults,
      speedup: Number((sum("coldMs") / sum("warmMs")).toFixed(2)),
      matched: "byte-identical particle display buffers, counts and simulation frames",
      limit: "Node CPU simulation wall time with cooperative yields, no decode, renderer or UI. Cold seeks disable checkpoints and use fresh pose samplers. Warm targets are distinct and miss the frame output cache.",
    }, null, 2));
  } finally {
    warm.dispose();
  }
} finally {
  await server.close();
}
