import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as abmeter from '../src/index';

const PAYLOAD = {
  user: { user_id: 'u1', email: null },
  assignments: {
    'button-color': {
      value: 'green',
      parameter_id: 1,
      space_id: 2,
      exposure: { exposable_type: 'Experiment', exposable_id: 3, audience_id: 4 },
    },
    'greeting': {
      value: 'hello',
      parameter_id: 5,
      space_id: 2,
      exposure: null,
    },
  },
};

interface RecordedRequest {
  url: string;
  body: unknown;
}

let requests: RecordedRequest[];

function installFetchMock(payload: unknown = PAYLOAD): void {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).includes('/user-assignments')) {
        const etag = ((init?.headers ?? {}) as Record<string, string>)['If-None-Match'];
        if (etag === 'W/"v1"') return new Response(null, { status: 304 });
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { ETag: 'W/"v1"', 'Content-Type': 'application/json' },
        });
      }
      // The two write endpoints: /exposures and /events.
      return new Response(JSON.stringify({ recorded_count: 1, invalid_count: 0 }), { status: 201 });
    })
  );
}

function exposureRequests(): RecordedRequest[] {
  return requests.filter((request) => request.url.includes('/exposures'));
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

describe('configure', () => {
  it('hydrates from localStorage before the refresh, which replays the cached ETag', async () => {
    localStorage.setItem(
      'abmeter:assignments:u1',
      JSON.stringify({
        etag: 'W/"v1"',
        payload: {
          user: { user_id: 'u1' },
          assignments: {
            'button-color': { value: 'cached-blue', parameter_id: 1, space_id: 2, exposure: null },
          },
        },
      })
    );

    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', user: { userId: 'u1' }, flushInterval: 60_000 });

    // Init (identity + hydrate) is async; ready() is the documented gate.
    expect(abmeter.resolveParameter('button-color')).toBeUndefined();
    await abmeter.ready();
    // The refresh replayed the hydrated W/"v1" and got a 304, so the cached
    // map survived — proof hydration completed before the refresh.
    expect(abmeter.resolveParameter('button-color')).toBe('cached-blue');
  });

  it('holds an event tracked before identity resolves and queues it under the track id', async () => {
    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', flushInterval: 60_000 });
    abmeter.trackEvent('early-tap', { n: 1 });

    await abmeter.ready();
    await abmeter.flush();

    const rows = requests
      .filter((request) => request.url.includes('/events'))
      .flatMap((request) => request.body as Array<Record<string, unknown>>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_slug: 'early-tap', custom_fields: { n: 1 } });
    expect(rows[0]?.user_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates and persists a track id when no userId is supplied', async () => {
    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', flushInterval: 60_000 });
    await abmeter.ready();

    const sent = requests[0]?.body as { user_id: string };
    expect(sent.user_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem('abmeter:track_id')).toBe(sent.user_id);
    expect(document.cookie).toContain(`abmeter_track_id=${sent.user_id}`);
  });

  it('reuses the persisted track id on the next configure', async () => {
    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', flushInterval: 60_000 });
    await abmeter.ready();
    const first = (requests[0]?.body as { user_id: string }).user_id;

    await abmeter.reset({ force: true });
    installFetchMock();
    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', flushInterval: 60_000 });
    await abmeter.ready();

    expect((requests[0]?.body as { user_id: string }).user_id).toBe(first);
  });

  it('drains the previous configuration instead of dropping its queue', async () => {
    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', user: { userId: 'u1' }, flushInterval: 60_000 });
    await abmeter.ready();
    abmeter.trackEvent('purchase', { price: 4.99 });

    // Reconfiguring for a newly logged-in user. The event queued as u1 is
    // already collected — losing it would be a silent hole in the results.
    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', user: { userId: 'u2' }, flushInterval: 60_000 });
    await abmeter.ready();
    await abmeter.flush();

    const rows = requests
      .filter((request) => request.url.includes('/events'))
      .flatMap((request) => request.body as Array<Record<string, unknown>>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_slug: 'purchase', user_id: 'u1' });
  });

  it('throws on a missing apiKey (misconfiguration is loud, not error-safe)', () => {
    expect(() => abmeter.configure({} as never)).toThrow(/apiKey/);
  });

  it('refuses to initialize with a secret (api-) key — never browser-safe', () => {
    expect(() =>
      abmeter.configure({ apiKey: 'api-notForBrowsers123', baseUrl: 'https://api.test' })
    ).toThrow(/publishable key/);
  });

  it('refuses any non-publishable token — only pk_ keys are browser-safe', () => {
    expect(() =>
      abmeter.configure({ apiKey: 'test-api-key', baseUrl: 'https://api.test' })
    ).toThrow(/publishable key/);
  });

  it('accepts a publishable (pk_) key', () => {
    expect(() =>
      abmeter.configure({ apiKey: 'pk_safeForBrowsers123', baseUrl: 'https://api.test', flushInterval: 60_000 })
    ).not.toThrow();
  });
});

describe('resolveParameter', () => {
  it('queues an exposure lazily and dedups repeats', async () => {
    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', user: { userId: 'u1' }, flushInterval: 60_000 });
    await abmeter.ready();

    expect(abmeter.resolveParameter('button-color')).toBe('green');
    expect(abmeter.resolveParameter('button-color')).toBe('green');
    await abmeter.flush();

    const posts = exposureRequests();
    expect(posts).toHaveLength(1);
    const rows = posts[0]?.body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      parameter_id: 1,
      space_id: 2,
      resolved_value: 'green',
      user_id: 'u1',
      exposable_type: 'Experiment',
      exposable_id: 3,
      audience_id: 4,
    });
  });

  it('produces no exposure for feature-flag/default resolutions or unread values', async () => {
    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', user: { userId: 'u1' }, flushInterval: 60_000 });
    await abmeter.ready();

    expect(abmeter.resolveParameter('greeting')).toBe('hello'); // exposure: null
    // 'button-color' is fetched but never read.
    await abmeter.flush();

    expect(exposureRequests()).toHaveLength(0);
  });

  it('returns undefined for a slug the server did not return, without throwing', async () => {
    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', user: { userId: 'u1' }, flushInterval: 60_000 });
    await abmeter.ready();

    expect(abmeter.resolveParameter('nonexistent')).toBeUndefined();
  });
});

describe('getExposure', () => {
  it('returns the exposure record without queueing anything', async () => {
    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', user: { userId: 'u1' }, flushInterval: 60_000 });
    await abmeter.ready();

    const exposure = abmeter.getExposure('button-color');
    expect(exposure).toMatchObject({ exposable_type: 'Experiment', exposable_id: 3 });
    expect(abmeter.getExposure('greeting')).toBeNull();

    await abmeter.flush();
    expect(exposureRequests()).toHaveLength(0);
  });
});

describe('trackEvent', () => {
  it('queues an event with the configured user id and wire shape', async () => {
    abmeter.configure({ apiKey: 'pk_k', baseUrl: 'https://api.test', user: { userId: 'u1' }, flushInterval: 60_000 });
    await abmeter.ready();

    abmeter.trackEvent('purchase', { price: 4.99 });
    await abmeter.flush();

    const posts = requests.filter((request) => request.url.includes('/events'));
    expect(posts).toHaveLength(1);
    const rows = posts[0]?.body as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      event_slug: 'purchase',
      user_id: 'u1',
      custom_fields: { price: 4.99 },
    });
    expect(typeof rows[0]?.occurred_at).toBe('string');
  });
});
