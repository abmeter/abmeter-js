import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api-error';

describe('ApiError', () => {
  it('parses delta-seconds Retry-After on a 429', () => {
    const error = new ApiError(429, { error: 'Rate limit exceeded' }, '42');

    expect(error.rateLimited).toBe(true);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(42);
  });

  it.each([
    ['missing', null],
    ['absent', undefined],
    ['garbage', 'soon'],
    ['negative', '-5'],
    ['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT'],
  ])('falls back to 30 seconds when Retry-After is %s', (_label, header) => {
    expect(new ApiError(429, {}, header).retryAfterSeconds).toBe(30);
  });

  it('raises a zero Retry-After to one second', () => {
    expect(new ApiError(429, {}, '0').retryAfterSeconds).toBe(1);
  });

  it('caps Retry-After at 600 seconds', () => {
    expect(new ApiError(429, {}, '86400').retryAfterSeconds).toBe(600);
  });

  it('carries no Retry-After on other statuses', () => {
    const error = new ApiError(503, { error: 'down' }, '10');

    expect(error.rateLimited).toBe(false);
    expect(error.retryAfterSeconds).toBeUndefined();
  });
});
