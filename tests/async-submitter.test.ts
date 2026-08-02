import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api-error';
import { AsyncSubmitter, chunkForKeepalive } from '../src/async-submitter';
import type { HttpClient } from '../src/http';

interface FakeHttp {
  postExposures: ReturnType<typeof vi.fn>;
  postEvents: ReturnType<typeof vi.fn>;
  beaconExposures: ReturnType<typeof vi.fn>;
  beaconEvents: ReturnType<typeof vi.fn>;
}

function fakeHttp(): FakeHttp {
  return {
    postExposures: vi.fn().mockResolvedValue(undefined),
    postEvents: vi.fn().mockResolvedValue(undefined),
    beaconExposures: vi.fn().mockReturnValue(true),
    beaconEvents: vi.fn().mockReturnValue(true),
  };
}

function buildSubmitter(
  http: FakeHttp,
  overrides: { batchSize?: number; flushIntervalMs?: number; logger?: (m: string, p?: unknown) => void } = {}
): AsyncSubmitter {
  return new AsyncSubmitter({
    http: http as unknown as HttpClient,
    flushIntervalMs: overrides.flushIntervalMs ?? 1000,
    batchSize: overrides.batchSize ?? 3,
    logger: overrides.logger ?? ((): void => {}),
  });
}

// Microtask turns drained by settle(). A flush resolves through a chain of
// awaits (queuedFlush → flushChain → drain → the http promise), each costing a
// turn; the timers are faked, so only microtasks advance. Comfortably above the
// deepest chain — extra turns on an empty queue are free.
const SETTLE_TURNS = 10;

async function settle(): Promise<void> {
  for (let i = 0; i < SETTLE_TURNS; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AsyncSubmitter', () => {
  it('flushes when the batch size is reached', async () => {
    const http = fakeHttp();
    const submitter = buildSubmitter(http, { batchSize: 2 });

    submitter.queueExposure({ n: 1 });
    expect(http.postExposures).not.toHaveBeenCalled();
    submitter.queueExposure({ n: 2 });
    await settle();

    expect(http.postExposures).toHaveBeenCalledWith([{ n: 1 }, { n: 2 }]);
  });

  it('flushes on the interval timer', async () => {
    const http = fakeHttp();
    const submitter = buildSubmitter(http, { flushIntervalMs: 1000 });
    submitter.start();

    submitter.queueEvent({ n: 1 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(http.postEvents).toHaveBeenCalledWith([{ n: 1 }]);
    submitter.stop();
  });

  it('drains on visibilitychange to hidden using the keepalive transport', () => {
    const http = fakeHttp();
    const submitter = buildSubmitter(http);
    submitter.start();
    submitter.queueExposure({ n: 1 });

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(http.postExposures).toHaveBeenCalledWith([{ n: 1 }], { keepalive: true });
    expect(submitter.pending()).toBe(0);
    submitter.stop();
  });

  it('drains on pagehide', () => {
    const http = fakeHttp();
    const submitter = buildSubmitter(http);
    submitter.start();
    submitter.queueEvent({ n: 1 });

    window.dispatchEvent(new Event('pagehide'));

    expect(http.postEvents).toHaveBeenCalledWith([{ n: 1 }], { keepalive: true });
    submitter.stop();
  });

  it('falls back to sendBeacon when the keepalive fetch fails', async () => {
    const http = fakeHttp();
    http.postExposures.mockRejectedValue(new TypeError('network down'));
    const submitter = buildSubmitter(http);
    submitter.queueExposure({ n: 1 });

    submitter.drainOnHide();
    await settle();

    expect(http.beaconExposures).toHaveBeenCalledWith([{ n: 1 }]);
  });

  it('logs and drops when sendBeacon refuses', async () => {
    const logger = vi.fn();
    const http = fakeHttp();
    http.postEvents.mockRejectedValue(new TypeError('network down'));
    http.beaconEvents.mockReturnValue(false);
    const submitter = buildSubmitter(http, { logger });
    submitter.queueEvent({ n: 1 });

    submitter.drainOnHide();
    await settle();

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('beacon refused'));
    expect(submitter.pending()).toBe(0);
  });

  it('re-queues exposures but drops events on an unknown network error', async () => {
    const http = fakeHttp();
    http.postExposures.mockRejectedValue(new TypeError('network down'));
    http.postEvents.mockRejectedValue(new TypeError('network down'));
    const submitter = buildSubmitter(http);

    submitter.queueExposure({ n: 1 });
    submitter.queueEvent({ n: 2 });
    await submitter.flush();

    expect(submitter.pending()).toBe(1); // the exposure, waiting for retry
  });

  it('re-queues both kinds on a retryable API error', async () => {
    const http = fakeHttp();
    http.postExposures.mockRejectedValue(new ApiError(503, { error: 'down' }));
    http.postEvents.mockRejectedValue(new ApiError(503, { error: 'down' }));
    const submitter = buildSubmitter(http);

    submitter.queueExposure({ n: 1 });
    submitter.queueEvent({ n: 2 });
    await submitter.flush();

    expect(submitter.pending()).toBe(2);
  });

  it('drops the batch on a validation error', async () => {
    const http = fakeHttp();
    http.postExposures.mockRejectedValue(
      new ApiError(400, { error: 'invalid', details: { failures: [{ index: 0 }] } })
    );
    const submitter = buildSubmitter(http);

    submitter.queueExposure({ n: 1 });
    await submitter.flush();

    expect(submitter.pending()).toBe(0);
  });

  it('drops a retried item after the max attempts', async () => {
    const http = fakeHttp();
    http.postExposures.mockRejectedValue(new ApiError(503, { error: 'down' }));
    const submitter = buildSubmitter(http);

    submitter.queueExposure({ n: 1 });
    await submitter.flush(); // attempt 1 → retry queue (attempts=1)
    await submitter.flush(); // retry → attempts=2 → re-queued
    await submitter.flush(); // retry → attempts=3 → dropped

    expect(submitter.pending()).toBe(0);
  });

  it('flush() during an in-flight flush resolves only after later-queued items drain', async () => {
    const http = fakeHttp();
    let releaseFirst: () => void = () => {};
    http.postExposures.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseFirst = resolve; })
    );
    const submitter = buildSubmitter(http);

    submitter.queueExposure({ n: 1 });
    const first = submitter.flush(); // in flight, blocked on postExposures
    await settle();

    submitter.queueEvent({ n: 2 });
    const second = submitter.flush();
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await settle();

    expect(secondSettled).toBe(false); // must not resolve while the drain is in flight

    releaseFirst();
    await first;
    await second;

    expect(http.postEvents).toHaveBeenCalledWith([{ n: 2 }]);
    expect(submitter.pending()).toBe(0);
  });

  it('reset drains everything, then reports zero pending', async () => {
    const http = fakeHttp();
    const submitter = buildSubmitter(http, { batchSize: 100 });
    submitter.start();
    submitter.queueExposure({ n: 1 });
    submitter.queueEvent({ n: 2 });

    await submitter.reset();

    expect(http.postExposures).toHaveBeenCalled();
    expect(http.postEvents).toHaveBeenCalled();
    expect(submitter.pending()).toBe(0);
  });

  it('reset({force}) drops without submitting', async () => {
    const http = fakeHttp();
    const submitter = buildSubmitter(http);
    submitter.queueExposure({ n: 1 });

    await submitter.reset({ force: true });

    expect(http.postExposures).not.toHaveBeenCalled();
    expect(submitter.pending()).toBe(0);
  });
});

describe('chunkForKeepalive', () => {
  it('splits by batch size', () => {
    const rows = [1, 2, 3, 4, 5];
    expect(chunkForKeepalive(rows, 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('splits when the byte budget would overflow', () => {
    const big = 'x'.repeat(30_000);
    const rows = [{ big }, { big }, { big }];
    const chunks = chunkForKeepalive(rows, 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(Math.floor(64 * 1024 * 0.8));
    }
  });
});
