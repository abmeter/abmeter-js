interface ErrorBody {
  error?: unknown;
  details?: { failures?: unknown[]; invalid_count?: number };
}

// Same contract as the Ruby/Python SDKs: retryable (5xx/408/429) errors
// re-queue, partial failures and other 4xx are permanent and drop.
export class ApiError extends Error {
  readonly status: number;
  readonly details: ErrorBody['details'];

  constructor(status: number, body: unknown) {
    const parsed: ErrorBody = typeof body === 'object' && body !== null ? (body as ErrorBody) : {};
    super(typeof parsed.error === 'string' ? parsed.error : `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.details = parsed.details;
  }

  get retryable(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 429;
  }

  get partialFailure(): boolean {
    return this.status === 400 && Array.isArray(this.details?.failures) && this.details.failures.length > 0;
  }
}
