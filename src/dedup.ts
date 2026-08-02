import { DEDUP_MAX_KEYS, DEDUP_WINDOW_MS } from './constants';

// Sliding-window exposure dedup: a Map used as an insertion-ordered LRU.
// Re-sighting a key refreshes its slot; eviction drops the oldest entry once
// the cap is hit, so a burst of distinct keys can't grow memory unbounded.
export class ExposureDedup {
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, number>();

  constructor({
    windowMs = DEDUP_WINDOW_MS,
    maxKeys = DEDUP_MAX_KEYS,
    now = Date.now,
  }: { windowMs?: number; maxKeys?: number; now?: () => number } = {}) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
  }

  /** True when the key was already seen inside the window; records the sighting either way. */
  seenRecently(key: string): boolean {
    const timestamp = this.now();
    const seenAt = this.entries.get(key);
    const duplicate = seenAt !== undefined && timestamp - seenAt < this.windowMs;

    this.entries.delete(key);
    this.entries.set(key, duplicate ? (seenAt as number) : timestamp);
    this.evict();
    return duplicate;
  }

  private evict(): void {
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

export function exposureDedupKey(exposure: {
  user_id: string;
  exposable_id: number;
  audience_id: number;
  resolved_value: unknown;
}): string {
  return `${exposure.user_id}|${exposure.exposable_id}|${exposure.audience_id}|${JSON.stringify(exposure.resolved_value)}`;
}
