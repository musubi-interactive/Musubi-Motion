// In-memory only. Float64 buffers preserve Nebula's double-precision state.
export type ParticleCheckpoint = {
  step: number;
  particles: Float64Array;
  emitter: Float64Array;
  surfaceWorld?: Float64Array;
};

export const PARTICLE_CHECKPOINT_INTERVAL = 120;
export const PARTICLE_CHECKPOINT_BYTES = 32 * 1024 * 1024;
const MAX_CHECKPOINTS = 128;

/** Shared across emitters. Bound packed bytes and cap the number of JS wrappers.
 * Evict in insertion order so seeks do not change the eviction policy. */
export class ParticleCheckpointCache {
  private readonly entries = new Map<ParticleCheckpoint, { owner: symbol; bytes: number }>();
  private totalBytes = 0;

  constructor(private readonly maxBytes = PARTICLE_CHECKPOINT_BYTES, private readonly maxEntries = MAX_CHECKPOINTS) {}

  find(owner: symbol, step: number): ParticleCheckpoint | undefined {
    let closest: ParticleCheckpoint | undefined;
    for (const [checkpoint, entry] of this.entries) {
      if (entry.owner === owner && checkpoint.step <= step && (!closest || checkpoint.step > closest.step)) closest = checkpoint;
    }
    return closest;
  }

  add(owner: symbol, checkpoint: ParticleCheckpoint): void {
    const bytes = checkpoint.particles.byteLength + checkpoint.emitter.byteLength + (checkpoint.surfaceWorld?.byteLength ?? 0);
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    if (this.find(owner, checkpoint.step)?.step === checkpoint.step) return;
    while (this.totalBytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries) {
      this.remove(this.entries.keys().next().value!);
    }
    this.entries.set(checkpoint, { owner, bytes });
    this.totalBytes += bytes;
  }

  clear(owner: symbol): void {
    for (const [checkpoint, entry] of this.entries) if (entry.owner === owner) this.remove(checkpoint);
  }

  private remove(checkpoint: ParticleCheckpoint): void {
    this.totalBytes -= this.entries.get(checkpoint)!.bytes;
    this.entries.delete(checkpoint);
  }
}

export const sharedParticleCheckpoints = new ParticleCheckpointCache();
