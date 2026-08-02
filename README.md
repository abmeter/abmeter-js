# ABMeter JavaScript SDK

[ABMeter](https://abmeter.ai) is a feature-flag and A/B-testing platform. You define parameters, experiments, and feature flags in the ABMeter Lab; this package reads the value assigned to each visitor in the browser and reports exposures and events back.

Unlike server-side SDKs, the browser never receives assignment rules, salts, or audience definitions. The SDK asks the ABMeter API for **pre-evaluated assignments** for the current user (`POST /api/v1/user-assignments`) and caches the resulting value map. Reading a value is a synchronous map lookup; an exposure is reported only when a value is actually read.

## Install

```bash
npm install abmeter
```

Or from the CDN (exposes `window.abmeter`):

```html
<script src="https://cdn.jsdelivr.net/npm/abmeter@0.1.0/dist/abmeter.iife.min.js"></script>
```

Pin the version. Dropping it — `npm/abmeter/dist/...` — resolves to whatever is
latest, which is handy for a first try and wrong in production: a release you
did not deploy would change your site. [unpkg](https://unpkg.com/abmeter/) serves
the same file at the same path.

## Quick start

```js
import * as abmeter from 'abmeter';

abmeter.configure({
  apiKey: 'YOUR_API_KEY',
  baseUrl: 'https://abmeter.ai',
  // Optional: identify a logged-in user. When omitted, the SDK generates a
  // stable anonymous track id (a random UUID persisted in cookie + localStorage).
  user: { userId: 'user_123', email: 'user@example.com' },
});

const buttonColor = abmeter.resolveParameter('button-color');

abmeter.trackEvent('purchase', undefined, { price: 4.99 });
```

`apiKey` must be a **publishable key** (`pk_...`, minted on the Lab API Keys page) — it is safe to embed in browser code and is limited server-side to the three endpoints this SDK uses. `configure` refuses any other key: secret keys (`api-...`) are never browser-safe.

`configure` hydrates synchronously from `localStorage` when a cached assignment map exists (no flash of defaults on repeat visits) and refreshes it in the background with ETag caching. `resolveParameter` returns the cached value and lazily queues an exposure — a value that is fetched but never read produces no exposure.

## Identity

- **Anonymous visitors** get a generated `track id` — a random UUID stored in a cookie and `localStorage` — sent as the `user_id`. Note that Safari caps JavaScript-set cookies at ~7 days; for long-running experiments, set the cookie server-side.
- **Logged-in users**: pass `user: { userId }` yourself. Keep one randomization unit per experiment — do not switch a user's id across the login boundary mid-experiment.
- `email` is optional and used only by email-predicate audiences.

## Event submission

Exposures and events are queued and submitted in small batches in the background. The queue drains on `visibilitychange → hidden` and `pagehide` using `fetch(..., { keepalive: true })` with a `sendBeacon` fallback, so data survives tab closes without blocking navigation. Call `abmeter.flush()` on SPA route changes if you want an eager drain.

Content blockers may drop telemetry requests at the network layer; the SDK treats that as expected loss and never throws.

## API

| Function | Description |
| --- | --- |
| `configure(options)` | Initialize the SDK. Options: `apiKey` (required), `baseUrl`, `user: { userId?, email? }`, `flushInterval` (ms, default 1000), `logger`, `errorCallback`. |
| `resolveParameter(slug)` | Resolved value for this user, or `undefined` if unknown. Queues an exposure lazily (deduplicated over a 10-minute window). |
| `getExposure(slug)` | The exposure metadata for a parameter (`null` for feature-flag/default resolutions), without queueing anything. |
| `trackEvent(eventSlug, userId?, customFields?)` | Queue an event. `userId` defaults to the configured user. |
| `flush()` | Drain the queue now (returns a promise). |
| `reset(options?)` | Drain fully and tear down timers/listeners. `configure` again to restart. |

All read/track functions are error-safe: failures are logged (and passed to `errorCallback` when configured) and return a safe default instead of throwing.
