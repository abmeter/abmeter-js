// The platform seam: everything in the SDK that is not fetch + JSON. The
// browser default lives in platform-browser.ts; other runtimes (React Native)
// supply their own adapter via ConfigInput.platform.

export interface PlatformStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface PlatformLifecycle {
  /**
   * Fires when the app enters "background" — visibility hidden + pagehide in
   * browsers, AppState 'active'→'background'/'inactive' in React Native.
   * Handler is invoked once per transition. Returns an unsubscribe.
   */
  onBackground(handler: () => void): () => void;
}

export interface PlatformAdapter {
  /** 'browser' | 'react-native' | ... — for logs. */
  readonly name: string;
  storage: PlatformStorage;
  lifecycle: PlatformLifecycle;
}
