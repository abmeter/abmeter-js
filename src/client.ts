import { AssignmentsCache } from './assignments-cache';
import { AsyncSubmitter } from './async-submitter';
import { ExposureDedup, exposureDedupKey } from './dedup';
import { HttpClient } from './http';
import { ensureUser } from './user';
import { guard, guardAsync } from './error-safety';
import { resolveConfig } from './config';
import type { Config, ConfigInput } from './config';
import type { User } from './user';

export interface ExposureRecord {
  parameter_id: number;
  space_id: number;
  resolved_value: unknown;
  user_id: string;
  exposable_type: 'Experiment';
  exposable_id: number;
  audience_id: number;
  resolved_at: string;
}

interface ClientState {
  config: Config;
  user: User;
  cache: AssignmentsCache;
  dedup: ExposureDedup;
  submitter: AsyncSubmitter;
  refreshPromise: Promise<void>;
}

let state: ClientState | null = null;

/**
 * Initialize the SDK singleton. Cache-then-network: hydrates synchronously
 * from localStorage when a cached map exists, then refreshes in the background
 * (await ready() to know the refresh settled). Throws on misconfiguration —
 * a bad apiKey must be loud, not error-safe.
 */
export function configure(input: ConfigInput): void {
  const config = resolveConfig(input);
  const user = ensureUser(input.user);
  const http = new HttpClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  const cache = new AssignmentsCache({ http, user, logger: config.logger });
  const submitter = new AsyncSubmitter({
    http,
    flushIntervalMs: config.flushIntervalMs,
    logger: config.logger,
    errorCallback: config.errorCallback,
  });

  // Reconfiguring detaches the previous submitter and lets it drain itself.
  // configure() is synchronous, so the drain cannot be awaited or reported —
  // but dropping the queue would lose exposures and events already collected,
  // a silent hole in the customer's results, while a stray background drain
  // only costs bandwidth. reset({ force: true }) is how a caller opts into
  // discarding, and await reset() is how one gets a guaranteed drain; neither
  // should be the accidental default here. Best-effort: reset() detaches the
  // unload listeners first, so a page dying mid-drain still loses the tail.
  if (state) {
    const previous = state.submitter;
    const pending = previous.pending();
    if (pending > 0) state.config.logger(`configure: draining ${pending} queued items from the previous configuration`);
    void previous.reset().catch(() => {
      // Already logged by the submitter; a failed drain must not break configure().
    });
  }

  cache.hydrateFromStorage();
  submitter.start();
  const refreshPromise = cache.refresh().catch((error) => {
    config.logger('assignments refresh failed', error);
    try {
      config.errorCallback?.(error);
    } catch {
      // errorCallback failures must not surface here
    }
  });

  state = { config, user, cache, dedup: new ExposureDedup(), submitter, refreshPromise };
}

/** Resolves when the background assignments refresh has settled (fetched or failed). */
export function ready(): Promise<void> {
  return state?.refreshPromise ?? Promise.resolve();
}

/**
 * Resolved value for this user, or undefined when unknown/unconfigured. Queues
 * an exposure lazily — only experiment resolutions carry exposure metadata,
 * and repeats inside the dedup window are not re-queued.
 */
export function resolveParameter(slug: string): unknown {
  return guard('resolveParameter', undefined, handlers(), () => {
    const current = requireState();
    const assignment = current.cache.resolveAssignment(slug);
    if (!assignment) {
      current.config.logger(`resolveParameter: unknown parameter '${slug}'`);
      return undefined;
    }

    const exposure = buildExposure(current, slug);
    if (exposure && !current.dedup.seenRecently(exposureDedupKey(exposure))) {
      current.submitter.queueExposure({ ...exposure });
    }
    return assignment.value;
  });
}

/** The exposure record resolveParameter would submit, or null — without queueing anything. */
export function getExposure(slug: string): ExposureRecord | null {
  return guard('getExposure', null, handlers(), () => buildExposure(requireState(), slug));
}

/**
 * Queue an event for the configured user.
 *
 * Deliberately takes no user id, unlike the server-side SDKs: there one
 * process serves every user, so each call must say who it is for, while a
 * page has exactly the one user configure() established. An override would
 * only ever detach the event — results attribute events to a visitor by
 * matching the id their exposure was recorded under, so an event under any
 * other id is stored, counted, and never joined.
 */
export function trackEvent(eventSlug: string, customFields?: Record<string, unknown>): void {
  guard('trackEvent', undefined, handlers(), () => {
    const current = requireState();
    current.submitter.queueEvent({
      event_slug: eventSlug,
      user_id: current.user.userId,
      occurred_at: new Date().toISOString(),
      custom_fields: customFields ?? {},
    });
  });
}

/** Drain the queue now (e.g. on SPA route changes). */
export function flush(): Promise<void> {
  return guardAsync('flush', undefined, handlers(), async () => {
    await state?.submitter.flush();
  });
}

/**
 * Drain fully and tear down timers/listeners; configure() again to restart.
 * force drops the queue instead of draining it.
 */
export function reset(options: { force?: boolean } = {}): Promise<void> {
  return guardAsync('reset', undefined, handlers(), async () => {
    const current = state;
    state = null;
    await current?.submitter.reset(options);
  });
}

function buildExposure(current: ClientState, slug: string): ExposureRecord | null {
  const assignment = current.cache.resolveAssignment(slug);
  if (!assignment?.exposure) return null;

  return {
    parameter_id: assignment.parameter_id,
    space_id: assignment.space_id,
    resolved_value: assignment.value,
    user_id: current.user.userId,
    exposable_type: assignment.exposure.exposable_type,
    exposable_id: assignment.exposure.exposable_id,
    audience_id: assignment.exposure.audience_id,
    resolved_at: new Date().toISOString(),
  };
}

function requireState(): ClientState {
  if (!state) throw new Error('abmeter is not configured — call abmeter.configure(...) first');
  return state;
}

function handlers(): { logger?: (message: string, payload?: unknown) => void; errorCallback?: (error: unknown) => void } {
  return state ? { logger: state.config.logger, errorCallback: state.config.errorCallback } : {};
}
