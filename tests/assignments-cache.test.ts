import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssignmentsCache } from '../src/assignments-cache';
import type { AssignmentsPayload } from '../src/assignments-cache';
import type { HttpClient } from '../src/http';

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

function buildCache(http: HttpClient): AssignmentsCache {
  return new AssignmentsCache({ http, user: USER, logger: NOOP_LOGGER });
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('AssignmentsCache', () => {
  it('hydrates synchronously from localStorage', () => {
    localStorage.setItem(
      'abmeter:assignments:u1',
      JSON.stringify({ etag: 'W/"abc"', payload: payload('cached-blue') })
    );

    const cache = buildCache(fakeHttp(vi.fn()));
    expect(cache.hydrateFromStorage()).toBe(true);
    expect(cache.resolveValue('button-color')).toBe('cached-blue');
  });

  it('does not hydrate from a corrupt cache entry', () => {
    localStorage.setItem('abmeter:assignments:u1', 'not json');

    const cache = buildCache(fakeHttp(vi.fn()));
    expect(cache.hydrateFromStorage()).toBe(false);
    expect(cache.resolveValue('button-color')).toBeUndefined();
  });

  it('replaces the map on 200 and persists payload + etag', async () => {
    const fetchAssignments = vi
      .fn()
      .mockResolvedValue({ status: 200, payload: payload('fresh-green'), etag: 'W/"v2"' });
    const cache = buildCache(fakeHttp(fetchAssignments));

    await cache.refresh();

    expect(cache.resolveValue('button-color')).toBe('fresh-green');
    const stored = JSON.parse(localStorage.getItem('abmeter:assignments:u1') as string);
    expect(stored.etag).toBe('W/"v2"');
    expect(stored.payload.assignments['button-color'].value).toBe('fresh-green');
  });

  it('replays the cached ETag and keeps the map on 304', async () => {
    localStorage.setItem(
      'abmeter:assignments:u1',
      JSON.stringify({ etag: 'W/"v1"', payload: payload('cached-blue') })
    );
    const fetchAssignments = vi.fn().mockResolvedValue({ status: 304 });
    const cache = buildCache(fakeHttp(fetchAssignments));
    cache.hydrateFromStorage();

    await cache.refresh();

    expect(fetchAssignments).toHaveBeenCalledWith(
      { user_id: 'u1', email: 'u1@example.com' },
      'W/"v1"'
    );
    expect(cache.resolveValue('button-color')).toBe('cached-blue');
  });

  it('still resolves in memory when localStorage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const fetchAssignments = vi
      .fn()
      .mockResolvedValue({ status: 200, payload: payload('in-memory'), etag: 'W/"v1"' });
    const cache = buildCache(fakeHttp(fetchAssignments));

    expect(cache.hydrateFromStorage()).toBe(false);
    await cache.refresh();
    expect(cache.resolveValue('button-color')).toBe('in-memory');
  });

  it('exposes exposure metadata through resolveAssignment', async () => {
    const cache = buildCache(
      fakeHttp(vi.fn().mockResolvedValue({ status: 200, payload: payload('v'), etag: undefined }))
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
