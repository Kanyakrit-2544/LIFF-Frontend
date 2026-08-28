export interface LegacyMirrorCount {
  source: number;
  scrubbed: number;
  dirty: number;
}

/** A mirror is complete only when every source row exists and no queued work remains. */
export function legacyMirrorCountsOk(counts: readonly LegacyMirrorCount[]): boolean {
  return counts.every((count) => count.source === count.scrubbed && count.dirty === 0);
}
