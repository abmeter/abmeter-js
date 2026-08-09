# ABMeter JavaScript SDK

[ABMeter](https://abmeter.ai) is a feature-flag and A/B-testing platform. You define parameters, experiments, and feature flags in the ABMeter Lab; this package reads the value assigned to each visitor in the browser and reports exposures and events back.

Unlike server-side SDKs, the browser receives only the **values already assigned** to the current visitor (`POST /api/v1/user-assignments`), and caches them — your experiment setup never leaves the server, so nothing in your page source reveals what you are testing or how. Reading a value is a synchronous lookup; an exposure is reported only when a value is actually read.

## Install

```bash
npm install abmeter
```

Or from the CDN (exposes `window.abmeter`):

```html
<script src="https://cdn.jsdelivr.net/npm/abmeter@0.3/dist/abmeter.iife.min.js"></script>
```

`@0.3` is a range: it picks up patch releases on its own. Pin the exact version
(`abmeter@0.3.0`) before production — a range still lets a release you did not
deploy reach your site, and only an exact version is served `immutable`. Avoid
the version-less form `npm/abmeter/dist/...` entirely: it follows every release,
breaking ones included. [unpkg](https://unpkg.com/abmeter/) serves the same file
at the same paths.

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

abmeter.trackEvent('purchase', { price: 4.99 });
```

`apiKey` must be a **publishable key** (`pk_...`, minted on the Lab API Keys page) — it is safe to embed in browser code and is limited server-side to the three endpoints this SDK uses. `configure` refuses any other key: secret keys (`api-...`) are never browser-safe.

`configure` returns immediately; identity, the `localStorage`-cached assignment map, and the background refresh (ETag-cached) all settle behind `ready()` — await it before reading parameters. `resolveParameter` returns the cached value and lazily queues an exposure — a value that is fetched but never read produces no exposure.

## Identity

- **Anonymous visitors** get a generated `track id` — a random UUID stored in a cookie and `localStorage` — sent as the `user_id`. Note that Safari caps JavaScript-set cookies at ~7 days; for long-running experiments, set the cookie server-side.
- **Logged-in users**: pass `user: { userId }` yourself. Keep one randomization unit per experiment — do not switch a user's id across the login boundary mid-experiment.
- `email` is optional and used only by email-predicate audiences.

### Decide the identity before the first `configure`

Calling `configure` again with a different `userId` is **not** a supported way to
upgrade an anonymous visitor to a logged-in one. Two things change that you cannot
undo:

- **The visitor may flip variant.** Assignments are fetched per user id, so the second
  `configure` gets a different map. Whatever the page already rendered was for the old
  identity.
- **Attribution splits.** Exposures already recorded carry the old id, everything after
  carries the new one, and results match events to a visitor by the id their exposure was
  recorded under. The two halves never meet — no error, just a metric quietly missing
  conversions.

Queued telemetry itself is safe: `configure` drains the previous configuration in the
background rather than discarding it. Use `await reset()` first if you need certainty
that the drain completed before the page can navigate away.

This matters most in a single-page app served as static files, which cannot know the user
until an auth request returns. Two options that work:

- **Stay anonymous** for the life of the experiment and let the generated track id be the
  randomization unit — correct, and it also measures logged-out traffic.
- **Configure once auth resolves**, and render defaults until then.

## Event submission

Exposures and events are queued and submitted in small batches in the background. The queue drains on `visibilitychange → hidden` and `pagehide` using `fetch(..., { keepalive: true })` with a `sendBeacon` fallback, so data survives tab closes without blocking navigation. Call `abmeter.flush()` on SPA route changes if you want an eager drain.

Content blockers may drop telemetry requests at the network layer; the SDK treats that as expected loss and never throws.

## API

| Function | Description |
| --- | --- |
| `configure(options)` | Initialize the SDK. Options: `apiKey` (required), `baseUrl`, `user: { userId?, email? }`, `flushInterval` (ms, default 1000), `logger`, `errorCallback`. |
| `resolveParameter(slug)` | Resolved value for this user, or `undefined` if unknown. Queues an exposure lazily (deduplicated over a 10-minute window). |
| `getExposure(slug)` | The exposure metadata for a parameter (`null` for feature-flag/default resolutions), without queueing anything. |
| `trackEvent(eventSlug, customFields?)` | Queue an event for the configured user. |
| `flush()` | Drain the queue now (returns a promise). |
| `reset(options?)` | Drain fully and tear down timers/listeners. `configure` again to restart. |

All read/track functions are error-safe: failures are logged (and passed to `errorCallback` when configured) and return a safe default instead of throwing.
