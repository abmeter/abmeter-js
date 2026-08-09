import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as abmeter from '../src/index';
import { createBrowserAdapter } from '../src/platform-browser';
import type { PlatformAdapter, PlatformStorage } from '../src/index';

const PAYLOAD = {
  user: { user_id: 'u1', email: null },
  assignments: {
    'button-color': {
      value: 'green',
      parameter_id: 1,
      space_id: 2,
      exposure: { exposable_type: 'Experiment', exposable_id: 3, audience_id: 4 },
    },
  },
};

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  keepalive: boolean;
  body: unknown;
}

let requests: RecordedRequest[];

function installFetchMock(): void {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        url: String(url),
        headers,
        keepalive: init?.keepalive === true,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(url).includes('/user-assignments')) {
        if (headers['If-None-Match'] === 'W/"v1"') return new Response(null, { status: 304 });
        return new Response(JSON.stringify(PAYLOAD), {
          status: 200,
          headers: { ETag: 'W/"v1"', 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ recorded_count: 1, invalid_count: 0 }), { status: 201 });
    })
  );
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

function capturingLifecycle(): {
  adapter: PlatformAdapter['lifecycle'];
  fire: () => void;
  unsubscribed: () => number;
} {
  const handlers = new Set<() => void>();
  let unsubscribed = 0;
  return {
    adapter: {
      onBackground(handler) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
          unsubscribed += 1;
        };
      },
    },
    fire() {
      for (const handler of handlers) handler();
    },
    unsubscribed: () => unsubscribed,
  };
}

function testPlatform(storage: PlatformStorage, lifecycle: PlatformAdapter['lifecycle']): PlatformAdapter {
  return { name: 'test', storage, lifecycle };
}

function cachedEntry(value: unknown): string {
  return JSON.stringify({
    etag: 'W/"v1"',
    payload: {
      user: { user_id: 'u1' },
      assignments: {
        'button-color': { value, parameter_id: 1, space_id: 2, exposure: null },
      },
    },
  });
}

beforeEach(() => {
  installFetchMock();
});

afterEach(async () => {
  await abmeter.reset({ force: true });
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('custom platform adapters', () => {
  it('persists identity and assignments through the injected storage, never localStorage', async () => {
    const storage = memoryStorage();
    const lifecycle = capturingLifecycle();
    abmeter.configure({
      apiKey: 'pk_k',
      baseUrl: 'https://api.test',
      flushInterval: 60_000,
      platform: testPlatform(storage.adapter, lifecycle.adapter),
    });
    await abmeter.ready();

    const trackId = storage.map.get('abmeter:track_id');
    expect(trackId).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.map.has(`abmeter:assignments:${trackId}`)).toBe(true);
    expect(localStorage.length).toBe(0);
  });

  it('hydrates before the refresh, replaying the cached ETag', async () => {
    const storage = memoryStorage({ 'abmeter:assignments:u1': cachedEntry('cached-blue') });
    const lifecycle = capturingLifecycle();
    abmeter.configure({
      apiKey: 'pk_k',
      baseUrl: 'https://api.test',
      user: { userId: 'u1' },
      flushInterval: 60_000,
      platform: testPlatform(storage.adapter, lifecycle.adapter),
    });

    // Init is in flight — nothing resolvable yet, and nothing thrown.
    expect(abmeter.resolveParameter('button-color')).toBeUndefined();
    await abmeter.ready();

    // The refresh replayed W/"v1" and got a 304, so the hydrated map won.
    expect(abmeter.resolveParameter('button-color')).toBe('cached-blue');
    const assignmentsRequest = requests.find((request) => request.url.includes('/user-assignments'));
    expect(assignmentsRequest?.headers['If-None-Match']).toBe('W/"v1"');
  });

  it('drains hard when the lifecycle signals background', async () => {
    const storage = memoryStorage();
    const lifecycle = capturingLifecycle();
    abmeter.configure({
      apiKey: 'pk_k',
      baseUrl: 'https://api.test',
      user: { userId: 'u1' },
      flushInterval: 60_000,
      platform: testPlatform(storage.adapter, lifecycle.adapter),
    });
    await abmeter.ready();
    abmeter.trackEvent('purchase');

    lifecycle.fire();

    await vi.waitFor(() => {
      expect(requests.some((request) => request.url.includes('/events'))).toBe(true);
    });
    const eventRequest = requests.find((request) => request.url.includes('/events'));
    expect(eventRequest?.keepalive).toBe(true);
  });

  it('unsubscribes the lifecycle adapter on reset', async () => {
    const storage = memoryStorage();
    const lifecycle = capturingLifecycle();
    abmeter.configure({
      apiKey: 'pk_k',
      baseUrl: 'https://api.test',
      user: { userId: 'u1' },
      flushInterval: 60_000,
      platform: testPlatform(storage.adapter, lifecycle.adapter),
    });
    await abmeter.ready();

    await abmeter.reset();

    expect(lifecycle.unsubscribed()).toBe(1);
  });
});

describe('createBrowserAdapter', () => {
  it('signals background on visibilitychange to hidden and on pagehide', () => {
    const handler = vi.fn();
    const unsubscribe = createBrowserAdapter().lifecycle.onBackground(handler);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    expect(handler).toHaveBeenCalledTimes(2);

    unsubscribe();
    window.dispatchEvent(new Event('pagehide'));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('mirrors the track id into a cookie alongside localStorage', async () => {
    const storage = createBrowserAdapter().storage;
    await storage.setItem('abmeter:track_id', 'cookie-mirrored-id');

    expect(localStorage.getItem('abmeter:track_id')).toBe('cookie-mirrored-id');
    expect(document.cookie).toContain('abmeter_track_id=cookie-mirrored-id');
    await expect(storage.getItem('abmeter:track_id')).resolves.toBe('cookie-mirrored-id');

    localStorage.clear();
    // The cookie is the longer-lived copy; reads fall back to it.
    await expect(storage.getItem('abmeter:track_id')).resolves.toBe('cookie-mirrored-id');
  });
});
