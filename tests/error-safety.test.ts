import { afterEach, describe, expect, it, vi } from 'vitest';
import { guard, guardAsync } from '../src/error-safety';
import * as abmeter from '../src/index';

afterEach(async () => {
  await abmeter.reset({ force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('guard', () => {
  it('returns the fallback and fires logger + errorCallback on a throw', () => {
    const logger = vi.fn();
    const errorCallback = vi.fn();
    const boom = new Error('boom');

    const result = guard('resolveParameter', undefined, { logger, errorCallback }, () => {
      throw boom;
    });

    expect(result).toBeUndefined();
    expect(logger).toHaveBeenCalledWith('resolveParameter failed', boom);
    expect(errorCallback).toHaveBeenCalledWith(boom);
  });

  it('survives a throwing errorCallback', () => {
    const errorCallback = vi.fn(() => {
      throw new Error('callback broke too');
    });

    expect(
      guard('op', 'fallback', { logger: vi.fn(), errorCallback }, () => {
        throw new Error('boom');
      })
    ).toBe('fallback');
  });

  it('logs to console.error when no logger is configured', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    guard('op', null, {}, () => {
      throw new Error('boom');
    });

    expect(consoleError).toHaveBeenCalled();
  });
});

describe('guardAsync', () => {
  it('returns the fallback on a rejected promise', async () => {
    const logger = vi.fn();

    const result = await guardAsync('flush', 'fallback', { logger }, async () => {
      throw new Error('boom');
    });

    expect(result).toBe('fallback');
    expect(logger).toHaveBeenCalled();
  });
});

describe('public API error safety', () => {
  it('resolveParameter before configure returns undefined instead of throwing', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(abmeter.resolveParameter('anything')).toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
  });

  it('trackEvent before configure is a no-op instead of throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => abmeter.trackEvent('purchase')).not.toThrow();
  });

  it('a failing background refresh fires errorCallback and leaves the SDK usable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    const errorCallback = vi.fn();

    abmeter.configure({
      apiKey: 'pk_k',
      baseUrl: 'https://api.test',
      user: { userId: 'u1' },
      flushInterval: 60_000,
      logger: vi.fn(),
      errorCallback,
    });
    await abmeter.ready();

    expect(errorCallback).toHaveBeenCalledWith(expect.any(TypeError));
    expect(abmeter.resolveParameter('anything')).toBeUndefined();
  });
});
