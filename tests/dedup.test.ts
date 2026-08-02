import { describe, expect, it } from 'vitest';
import { ExposureDedup, exposureDedupKey } from '../src/dedup';

describe('ExposureDedup', () => {
  it('reports a repeat inside the window as seen', () => {
    const dedup = new ExposureDedup({ now: () => 1000 });
    expect(dedup.seenRecently('k')).toBe(false);
    expect(dedup.seenRecently('k')).toBe(true);
  });

  it('counts a sighting past the window boundary as new', () => {
    let clock = 0;
    const dedup = new ExposureDedup({ windowMs: 600_000, now: () => clock });

    expect(dedup.seenRecently('k')).toBe(false);
    clock = 599_999;
    expect(dedup.seenRecently('k')).toBe(true);
    clock = 600_000;
    expect(dedup.seenRecently('k')).toBe(false);
  });

  it('evicts the oldest key at capacity', () => {
    const dedup = new ExposureDedup({ maxKeys: 2, now: () => 0 });
    dedup.seenRecently('a');
    dedup.seenRecently('b');
    dedup.seenRecently('c'); // evicts a

    expect(dedup.seenRecently('a')).toBe(false);
  });

  it('keeps a re-sighted key alive in LRU order', () => {
    const dedup = new ExposureDedup({ maxKeys: 2, now: () => 0 });
    dedup.seenRecently('a');
    dedup.seenRecently('b');
    dedup.seenRecently('a'); // refreshes a's slot
    dedup.seenRecently('c'); // evicts b, not a

    expect(dedup.seenRecently('a')).toBe(true);
    expect(dedup.seenRecently('b')).toBe(false);
  });

  it('treats the same user with a different resolved value as a new exposure', () => {
    const base = { user_id: 'u1', exposable_id: 1, audience_id: 2 };
    const dedup = new ExposureDedup({ now: () => 0 });

    expect(dedup.seenRecently(exposureDedupKey({ ...base, resolved_value: 'blue' }))).toBe(false);
    expect(dedup.seenRecently(exposureDedupKey({ ...base, resolved_value: 'green' }))).toBe(false);
    expect(dedup.seenRecently(exposureDedupKey({ ...base, resolved_value: 'blue' }))).toBe(true);
  });
});
