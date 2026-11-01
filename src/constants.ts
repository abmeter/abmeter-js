export const DEFAULT_BASE_URL = 'https://abmeter.ai';
export const DEFAULT_FLUSH_INTERVAL_MS = 1000;

// Deliberately smaller than Ruby/Python's 100: those serve many users per
// process, a browser serves one, so events are sparse. Small batches stay far
// under the ~64 KiB keepalive/beacon quota and lose less on tab death.
export const BATCH_SIZE = 20;
export const MAX_SUBMIT_ATTEMPTS = 3;
export const MAX_RETRY_QUEUE = 1000;

// 429 handling: pause for Retry-After seconds (default when missing or
// unparsable, capped at the API's rate-limit window). reset() waits out
// pauses for at most MAX_DRAIN_PAUSE_MS in total, then drops what is left.
export const DEFAULT_RETRY_AFTER_SECONDS = 30;
export const MIN_RETRY_AFTER_SECONDS = 1;
export const MAX_RETRY_AFTER_SECONDS = 600;
export const MAX_DRAIN_PAUSE_MS = 5000;

export const DEDUP_WINDOW_MS = 10 * 60 * 1000;
export const DEDUP_MAX_KEYS = 1000;

// fetch keepalive shares a ~64 KiB in-flight quota per page with sendBeacon;
// chunk bodies to 80% of it rather than hoping a batch fits.
export const KEEPALIVE_BODY_LIMIT_BYTES = Math.floor(64 * 1024 * 0.8);

export const ASSIGNMENTS_STORAGE_PREFIX = 'abmeter:assignments:';
export const TRACK_ID_STORAGE_KEY = 'abmeter:track_id';
export const TRACK_ID_COOKIE_NAME = 'abmeter_track_id';
export const TRACK_ID_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const USER_ASSIGNMENTS_PATH = '/api/v1/user-assignments';
export const EXPOSURES_PATH = '/api/v1/exposures';
export const EVENTS_PATH = '/api/v1/events';
