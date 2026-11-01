# Changelog

## 0.4.0 (2026-11-01)

- On a 429 the SDK pauses submits for the response's `Retry-After` (30 seconds when the header is missing or unreadable, at least 1 second, at most 600) and retries the batch afterwards instead of dropping it. `ApiError.retryAfterSeconds` carries the pause, and the wait does not count toward the retry limit. The API now exposes `Retry-After` and the `X-RateLimit-*` headers to cross-origin pages, so the browser can read them.
- `ApiError` exposes the API's error `code` and `failureCount`, the number of rejected items in a partial failure.
