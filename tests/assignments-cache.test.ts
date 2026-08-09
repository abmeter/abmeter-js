import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssignmentsCache } from '../src/assignments-cache';
import type { AssignmentsPayload } from '../src/assignments-cache';
import type { HttpClient } from '../src/http';
import type { PlatformStorage } from '../src/platform';

const USER = { userId: 'u1', email: 'u1@example.com' };
const NOOP_LOGGER = (): void => {};

function payload(value: unknown): AssignmentsPayload {
  return {
    user: { user_id: 'u1', email: 'u1@example.com' },
    assignments: {
      'button-color': {
        value,
        parameter_id: 1,
        space_id: 2,
        exposure: { exposable_type: 'Experiment', exposable_id: 3, audience_id: 4 },
      },
    },
  };
}

function fakeHttp(fetchAssignments: HttpClient['fetchAssignments']): HttpClient {
  return { fetchAssignments } as unknown as HttpClient;
}

function memoryStorage(seed: Record<string, string> = {}): { adapter: PlatformStorage; map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    adapter: {
      getItem: async (key) => map.get(key) ?? null,
      setItem: async (key, value) => void map.set(key, value),
      removeItem: async (key) => void map.delete(key),
    },
  };
}

function buildCache(http: HttpClient, storage: PlatformStorage): AssignmentsCache {
  return new AssignmentsCache({ http, user: USER, logger: NOOP_LOGGER, storage });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AssignmentsCache', () => {
  it('hydrates from the platform storage', async () => {
    const storage = memoryStorage({
      'abmeter:assignments:u1': JSON.stringify({ etag: 'W/"abc"', payload: payload('cached-blue') }),
    });

    const cache = buildCache(fakeHttp(vi.fn()), storage.adapter);
    await expect(cache.hydrateFromStorage()).resolves.toBe(true);
    expect(cache.resolveValue('button-color')).toBe('cached-blue');
  });

  it('does not hydrate from a corrupt cache entry', async () => {
    const storage = memoryStorage({ 'abmeter:assignments:u1': 'not json' });

    const cache = buildCache(fakeHttp(vi.fn()), storage.adapter);
    await expect(cache.hydrateFromStorage()).resolves.toBe(false);
    expect(cache.resolveValue('button-color')).toBeUndefined();
  });

  it('replaces the map on 200 and persists payload + etag', async () => {
    const storage = memoryStorage();
    const fetchAssignments = vi
      .fn()
      .mockResolvedValue({ status: 200, payload: payload('fresh-green'), etag: 'W/"v2"' });
    const cache = buildCache(fakeHttp(fetchAssignments), storage.adapter);

    await cache.refresh();

    expect(cache.resolveValue('button-color')).toBe('fresh-green');
    await vi.waitFor(() => {
      const stored = JSON.parse(storage.map.get('abmeter:assignments:u1') as string);
      expect(stored.etag).toBe('W/"v2"');
      expect(stored.payload.assignments['button-color'].value).toBe('fresh-green');
    });
  });

  it('replays the cached ETag and keeps the map on 304', async () => {
    const storage = memoryStorage({
      'abmeter:assignments:u1': JSON.stringify({ etag: 'W/"v1"', payload: payload('cached-blue') }),
    });
    const fetchAssignments = vi.fn().mockResolvedValue({ status: 304 });
    const cache = buildCache(fakeHttp(fetchAssignments), storage.adapter);
    await cache.hydrateFromStorage();

    await cache.refresh();

    expect(fetchAssignments).toHaveBeenCalledWith(
      { user_id: 'u1', email: 'u1@example.com' },
      'W/"v1"'
    );
    expect(cache.resolveValue('button-color')).toBe('cached-blue');
  });

  it('still resolves in memory when the storage is unavailable', async () => {
    const broken: PlatformStorage = {
      getItem: async () => {
        throw new Error('storage unavailable');
      },
      setItem: async () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: async () => {},
    };

    const fetchAssignments = vi
      .fn()
      .mockResolvedValue({ status: 200, payload: payload('in-memory'), etag: 'W/"v1"' });
    const cache = buildCache(fakeHttp(fetchAssignments), broken);

    await expect(cache.hydrateFromStorage()).resolves.toBe(false);
    await cache.refresh();
    expect(cache.resolveValue('button-color')).toBe('in-memory');
  });

  it('exposes exposure metadata through resolveAssignment', async () => {
    const storage = memoryStorage();
    const cache = buildCache(
      fakeHttp(vi.fn().mockResolvedValue({ status: 200, payload: payload('v'), etag: undefined })),
      storage.adapter
    );
    await cache.refresh();

    expect(cache.resolveAssignment('button-color')?.exposure).toEqual({
      exposable_type: 'Experiment',
      exposable_id: 3,
      audience_id: 4,
    });
    expect(cache.resolveAssignment('missing')).toBeUndefined();
  });
});
