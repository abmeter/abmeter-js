import { TRACK_ID_STORAGE_KEY } from './constants';
import type { PlatformStorage } from './platform';

export interface UserInput {
  userId?: string;
  email?: string;
}

export interface User {
  userId: string;
  email?: string;
}

// When the caller supplies no id, identity is a generated track id: a random
// UUID persisted through the platform storage (the browser adapter also
// mirrors it into a cookie; React Native keeps it in AsyncStorage) and sent as
// the user_id wire field. ~122 bits of randomness make targeted impersonation
// of anonymous users infeasible and keep real user ids out of client traffic.
// Note: Safari ITP caps JS-set cookies at ~7 days; long experiments should set
// the cookie server-side.
export async function ensureUser(
  input: UserInput | undefined,
  storage: PlatformStorage
): Promise<User> {
  const userId = input?.userId ?? (await loadOrCreateTrackId(storage));
  return input?.email === undefined ? { userId } : { userId, email: input.email };
}

// Unavailable storage degrades to a per-session id rather than failing
// configure(); every successful load re-persists, refreshing cookie lifetimes.
async function loadOrCreateTrackId(storage: PlatformStorage): Promise<string> {
  let existing: string | null = null;
  try {
    existing = await storage.getItem(TRACK_ID_STORAGE_KEY);
  } catch {
    existing = null;
  }
  const trackId = existing ?? generateUuid();
  try {
    await storage.setItem(TRACK_ID_STORAGE_KEY, trackId);
  } catch {
    // Unwritable storage — the id lives for this session only.
  }
  return trackId;
}

// Random v4 UUID with fallbacks for runtimes without crypto.randomUUID
// (e.g. React Native's Hermes).
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
