import { DEFAULT_RETRY_AFTER_SECONDS, MAX_RETRY_AFTER_SECONDS, MIN_RETRY_AFTER_SECONDS } from './constants';

interface ErrorBody {
  error?: unknown;
  code?: unknown;
  details?: { failures?: unknown[]; invalid_count?: number };
}

const RATE_LIMITED_STATUS = 429;

// Same contract as the Ruby/Python SDKs: retryable (5xx/408/429) errors
// re-queue, partial failures and other 4xx are permanent and drop. A 429
// also carries retryAfterSeconds, the pause the submitter honors.
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details: ErrorBody['details'];
  readonly retryAfterSeconds?: number;

  constructor(status: number, body: unknown, retryAfter?: string | null) {
    const parsed: ErrorBody = typeof body === 'object' && body !== null ? (body as ErrorBody) : {};
    super(typeof parsed.error === 'string' ? parsed.error : `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    if (typeof parsed.code === 'string') this.code = parsed.code;
    this.details = parsed.details;
    if (status === RATE_LIMITED_STATUS) this.retryAfterSeconds = parseRetryAfter(retryAfter);
  }

  get retryable(): boolean {
    return this.status >= 500 || this.status === 408 || this.rateLimited;
  }

  get rateLimited(): boolean {
    return this.status === RATE_LIMITED_STATUS;
  }

  get partialFailure(): boolean {
    return this.status === 400 && Array.isArray(this.details?.failures) && this.details.failures.length > 0;
  }

  get failureCount(): number {
    return this.details?.invalid_count ?? 0;
  }
}

// Delta-seconds only; an HTTP date, a negative or a garbage value gets the default.
function parseRetryAfter(value?: string | null): number {
  const trimmed = value?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(Math.max(Number(trimmed), MIN_RETRY_AFTER_SECONDS), MAX_RETRY_AFTER_SECONDS);
}
