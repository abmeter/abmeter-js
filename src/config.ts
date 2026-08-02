import { DEFAULT_BASE_URL, DEFAULT_FLUSH_INTERVAL_MS } from './constants';
import type { UserInput } from './user';

export type Logger = (message: string, payload?: unknown) => void;
export type ErrorCallback = (error: unknown) => void;

export interface ConfigInput {
  apiKey: string;
  baseUrl?: string;
  user?: UserInput;
  /** Milliseconds between background flushes. */
  flushInterval?: number;
  logger?: Logger;
  errorCallback?: ErrorCallback;
}

export interface Config {
  apiKey: string;
  baseUrl: string;
  flushIntervalMs: number;
  logger: Logger;
  errorCallback?: ErrorCallback;
}

const PUBLISHABLE_KEY_PREFIX = 'pk_';

export function resolveConfig(input: ConfigInput): Config {
  if (!input || typeof input.apiKey !== 'string' || input.apiKey.length === 0) {
    throw new Error('abmeter.configure: apiKey is required');
  }

  // Refuse, don't warn: anything embedded in a browser bundle is readable by
  // anyone, so this SDK only accepts keys that are safe to expose. A secret
  // key here would grant full account access to every visitor.
  if (!input.apiKey.startsWith(PUBLISHABLE_KEY_PREFIX)) {
    throw new Error(
      'abmeter.configure: apiKey must be a publishable key (pk_...) — mint one on the ' +
        'Lab API Keys page. Secret keys (api-...) must never be shipped in browser code: ' +
        'anyone can read them from your page source and gain full access to your ABMeter account.'
    );
  }

  return {
    apiKey: input.apiKey,
    baseUrl: (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    flushIntervalMs: input.flushInterval ?? DEFAULT_FLUSH_INTERVAL_MS,
    logger: input.logger ?? defaultLogger,
    errorCallback: input.errorCallback,
  };
}

function defaultLogger(message: string, payload?: unknown): void {
  if (payload === undefined) {
    console.warn(`[abmeter] ${message}`);
  } else {
    console.warn(`[abmeter] ${message}`, payload);
  }
}
