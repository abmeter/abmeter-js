import {
  TRACK_ID_COOKIE_MAX_AGE_SECONDS,
  TRACK_ID_COOKIE_NAME,
  TRACK_ID_STORAGE_KEY,
} from './constants';

export interface UserInput {
  userId?: string;
  email?: string;
}

export interface User {
  userId: string;
  email?: string;
}

// When the caller supplies no id, identity is a generated track id: a random
// UUID persisted in cookie + localStorage and sent as the user_id wire field.
// ~122 bits of randomness make targeted impersonation of anonymous users
// infeasible and keep real user ids out of browser traffic. Note: Safari ITP
// caps JS-set cookies at ~7 days; long experiments should set the cookie
// server-side.
export function ensureUser(input?: UserInput): User {
  const userId = input?.userId ?? loadOrCreateTrackId();
  return input?.email === undefined ? { userId } : { userId, email: input.email };
}

function loadOrCreateTrackId(): string {
  const existing = readCookie(TRACK_ID_COOKIE_NAME) ?? readStorage(TRACK_ID_STORAGE_KEY);
  const trackId = existing ?? generateUuid();
  persistTrackId(trackId);
  return trackId;
}

function persistTrackId(trackId: string): void {
  writeCookie(TRACK_ID_COOKIE_NAME, trackId);
  writeStorage(TRACK_ID_STORAGE_KEY, trackId);
}

function generateUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) || null : null;
}

function writeCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${TRACK_ID_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  } catch {
    // Cookies blocked — localStorage (or memory for the session) still holds the id.
  }
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // localStorage blocked (Safari private mode, extensions) — cookie may still work.
  }
}
