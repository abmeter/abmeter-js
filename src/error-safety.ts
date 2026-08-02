import type { ErrorCallback, Logger } from './config';

export interface SafetyHandlers {
  logger?: Logger;
  errorCallback?: ErrorCallback;
}

// The error boundary around the public API: never let SDK internals crash the
// host page, but never swallow silently either — every failure is logged and
// forwarded to errorCallback so a salt-bug-class regression stays visible.
export function guard<R>(operation: string, fallback: R, handlers: SafetyHandlers, fn: () => R): R {
  try {
    return fn();
  } catch (error) {
    report(operation, error, handlers);
    return fallback;
  }
}

export async function guardAsync<R>(
  operation: string,
  fallback: R,
  handlers: SafetyHandlers,
  fn: () => Promise<R>
): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    report(operation, error, handlers);
    return fallback;
  }
}

function report(operation: string, error: unknown, handlers: SafetyHandlers): void {
  if (handlers.logger) {
    handlers.logger(`${operation} failed`, error);
  } else {
    console.error(`[abmeter] ${operation} failed`, error);
  }
  try {
    handlers.errorCallback?.(error);
  } catch {
    // A throwing errorCallback must not take the page down with it.
  }
}
