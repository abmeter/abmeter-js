import {
  TRACK_ID_COOKIE_MAX_AGE_SECONDS,
  TRACK_ID_COOKIE_NAME,
  TRACK_ID_STORAGE_KEY,
} from './constants';
import type { PlatformAdapter, PlatformLifecycle, PlatformStorage } from './platform';

/**
 * The default platform: localStorage + the tab-death listeners. On background
 * the page may never run again, so the submitter drains with its
 * fire-and-forget keepalive/beacon transports.
 */
export function createBrowserAdapter(): PlatformAdapter {
  return { name: 'browser', storage: browserStorage(), lifecycle: browserLifecycle() };
}

// localStorage behind a write probe: blocked storage (Safari private mode,
// extensions) degrades to an inert adapter — in-memory only, no errors. A
// later setItem failure (quota) still rejects, so the caller can log it.
//
// The track id additionally mirrors into a cookie — a browser identity
// affordance (~365-day lifetime beats localStorage across origin-partitioning
// quirks) kept here, behind the browser factory, rather than modeled in
// PlatformStorage: no other platform has an analogous API. Reads prefer the
// cookie so the longer-lived copy wins; every write refreshes both.
function browserStorage(): PlatformStorage {
  const storage = detectLocalStorage();
  return {
    async getItem(key: string): Promise<string | null> {
      if (key === TRACK_ID_STORAGE_KEY) {
        const fromCookie = readCookie(TRACK_ID_COOKIE_NAME);
        if (fromCookie) return fromCookie;
      }
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    async setItem(key: string, value: string): Promise<void> {
      if (key === TRACK_ID_STORAGE_KEY) writeCookie(TRACK_ID_COOKIE_NAME, value);
      storage?.setItem(key, value);
    },
    async removeItem(key: string): Promise<void> {
      try {
        storage?.removeItem(key);
      } catch {
        // Blocked storage held nothing to remove.
      }
    },
  };
}

function browserLifecycle(): PlatformLifecycle {
  return {
    onBackground(handler) {
      // Never unload/beforeunload — those break bfcache and don't fire on
      // mobile. visibilitychange→hidden and pagehide are the reliable pair.
      const onVisibilityChange = (): void => {
        if (globalThis.document?.visibilityState === 'hidden') handler();
      };
      const onPageHide = (): void => handler();
      globalThis.document?.addEventListener('visibilitychange', onVisibilityChange);
      globalThis.window?.addEventListener('pagehide', onPageHide);
      return () => {
        globalThis.document?.removeEventListener('visibilitychange', onVisibilityChange);
        globalThis.window?.removeEventListener('pagehide', onPageHide);
      };
    },
  };
}

function detectLocalStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    const probe = 'abmeter:probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
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
    // Cookies blocked — localStorage still holds the id.
  }
}
