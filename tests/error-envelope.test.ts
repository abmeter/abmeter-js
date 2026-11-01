// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api-error';

// A copy of the API's golden fixture (api/spec/fixtures/error_envelope.json);
// it must stay identical to it.
const FIXTURE = fileURLToPath(new URL('./fixtures/error_envelope.json', import.meta.url));

interface Sample {
  name: string;
  status: number;
  body: string;
  expected: {
    message: string | null;
    code: string | null;
    details: Record<string, unknown>;
    retryable: boolean;
    partial_failure: boolean;
    failure_count: number;
  };
}

const { samples } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { samples: Sample[] };

// Same body handling as the client: a body that is not JSON parses to undefined.
async function errorFor(sample: Sample): Promise<ApiError> {
  const body: unknown = await new Response(sample.body).json().catch(() => undefined);
  return new ApiError(sample.status, body, null);
}

describe('ApiError against the error envelope fixture', () => {
  it.each(samples.map((sample) => [sample.name, sample] as const))('parses the %s sample', async (_name, sample) => {
    const error = await errorFor(sample);
    const { expected } = sample;

    if (expected.message !== null) expect(error.message).toBe(expected.message);
    expect(error.code ?? null).toBe(expected.code);
    expect(error.details ?? {}).toEqual(expected.details);
    expect(error.retryable).toBe(expected.retryable);
    expect(error.partialFailure).toBe(expected.partial_failure);
    expect(error.failureCount).toBe(expected.failure_count);
  });
});
