import { ApiError } from './api-error';
import {
  BATCH_SIZE,
  KEEPALIVE_BODY_LIMIT_BYTES,
  MAX_RETRY_QUEUE,
  MAX_SUBMIT_ATTEMPTS,
} from './constants';
import type { ErrorCallback, Logger } from './config';
import type { HttpClient } from './http';
import type { PlatformLifecycle } from './platform';

type Kind = 'exposure' | 'event';

interface QueueItem {
  kind: Kind;
  data: Record<string, unknown>;
  attempts: number;
}

export interface SubmitterOptions {
  http: HttpClient;
  flushIntervalMs: number;
  batchSize?: number;
  logger: Logger;
  errorCallback?: ErrorCallback;
  /** Drain-moment source (browser: visibilitychange/pagehide; RN: AppState). */
  lifecycle: PlatformLifecycle;
}

// Main-thread queue: setInterval + batch-size trigger, drained hard when the
// platform lifecycle signals background. The drain uses keepalive fetch with a
// sendBeacon fallback; a refused beacon is logged and dropped — ad-blockers
// exist, loss is expected, never fatal. (On React Native neither transport
// trick exists or is needed: fetch ignores keepalive and the beacon branch is
// never viable, so the drain is a plain fetch.)
export class AsyncSubmitter {
  private readonly http: HttpClient;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly logger: Logger;
  private readonly errorCallback?: ErrorCallback;
  private readonly lifecycle: PlatformLifecycle;

  private exposures: QueueItem[] = [];
  private events: QueueItem[] = [];
  private retryQueue: QueueItem[] = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private queuedFlush: Promise<void> | null = null;
  private unsubscribeBackground: (() => void) | null = null;

  constructor(options: SubmitterOptions) {
    this.http = options.http;
    this.flushIntervalMs = options.flushIntervalMs;
    this.batchSize = options.batchSize ?? BATCH_SIZE;
    this.logger = options.logger;
    this.errorCallback = options.errorCallback;
    this.lifecycle = options.lifecycle;
  }

  start(): void {
    if (this.timer === null) {
      this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    }
    this.unsubscribeBackground ??= this.lifecycle.onBackground(() => this.drainOnHide());
  }

  /** Detach timer + listeners without draining. reset() is the draining teardown. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribeBackground?.();
    this.unsubscribeBackground = null;
  }

  queueExposure(data: Record<string, unknown>): void {
    this.exposures.push({ kind: 'exposure', data, attempts: 0 });
    this.flushIfFull();
  }

  queueEvent(data: Record<string, unknown>): void {
    this.events.push({ kind: 'event', data, attempts: 0 });
    this.flushIfFull();
  }

  pending(): number {
    return this.exposures.length + this.events.length + this.retryQueue.length;
  }

  /**
   * Drain the queues over the network. One retry batch is attempted per flush;
   * items failing during this flush land in the retry queue and wait for the
   * next one, so a failing server can't spin this loop forever.
   *
   * Passes are serialized, never concurrent. flush() during a running pass
   * returns a promise for the NEXT pass — resolving early while a drain is
   * still in flight would break callers (SPA route changes, the canonical
   * app's pre-close barrier) that await flush() as proof nothing is queued.
   * Callers arriving in the same window share one queued pass.
   */
  flush(): Promise<void> {
    if (this.queuedFlush) return this.queuedFlush;

    const pass = this.flushChain.then(() => {
      this.queuedFlush = null;
      return this.drain();
    });
    this.queuedFlush = pass;
    this.flushChain = pass.catch(() => undefined);
    return pass;
  }

  private async drain(): Promise<void> {
    await this.retryOneBatch();
    while (this.exposures.length > 0 || this.events.length > 0) {
      if (this.exposures.length > 0) {
        await this.submitBatch('exposure', this.exposures.splice(0, this.batchSize));
      }
      if (this.events.length > 0) {
        await this.submitBatch('event', this.events.splice(0, this.batchSize));
      }
    }
  }

  /**
   * Drain fully and tear down. Terminates even against a failing server: every
   * failed batch either drops (validation, events on network error) or re-queues
   * with attempts++ and drops at MAX_SUBMIT_ATTEMPTS.
   */
  async reset(options: { force?: boolean } = {}): Promise<void> {
    this.stop();
    if (options.force) {
      const dropped = this.pending();
      this.exposures = [];
      this.events = [];
      this.retryQueue = [];
      if (dropped > 0) this.logger(`reset(force): dropped ${dropped} queued items`);
      return;
    }
    while (this.pending() > 0) {
      await this.flush();
    }
  }

  /**
   * Tab-death drain: chunked keepalive fetch (text/plain, CORS-simple) with a
   * sendBeacon fallback when the fetch fails. Fire-and-forget by necessity —
   * the page may be gone before any response arrives.
   */
  drainOnHide(): void {
    const items = [...this.retryQueue, ...this.exposures, ...this.events];
    this.retryQueue = [];
    this.exposures = [];
    this.events = [];

    for (const kind of ['exposure', 'event'] as const) {
      const rows = items.filter((item) => item.kind === kind).map((item) => item.data);
      for (const chunk of chunkForKeepalive(rows, this.batchSize)) {
        this.sendChunkOnHide(kind, chunk);
      }
    }
  }

  private sendChunkOnHide(kind: Kind, rows: unknown[]): void {
    const beaconFallback = (): void => {
      const accepted =
        kind === 'exposure' ? this.http.beaconExposures(rows) : this.http.beaconEvents(rows);
      if (!accepted) this.logger(`beacon refused; dropping ${rows.length} ${kind}s`);
    };

    try {
      const post =
        kind === 'exposure'
          ? this.http.postExposures(rows, { keepalive: true })
          : this.http.postEvents(rows, { keepalive: true });
      post.catch(beaconFallback);
    } catch {
      beaconFallback();
    }
  }

  private flushIfFull(): void {
    if (this.exposures.length + this.events.length >= this.batchSize) void this.flush();
  }

  private async retryOneBatch(): Promise<void> {
    if (this.retryQueue.length === 0) return;
    const batch = this.retryQueue.splice(0, this.batchSize);
    const byKind = new Map<Kind, QueueItem[]>();
    for (const item of batch) {
      const bucket = byKind.get(item.kind) ?? [];
      bucket.push(item);
      byKind.set(item.kind, bucket);
    }
    for (const [kind, items] of byKind) {
      await this.submitBatch(kind, items);
    }
  }

  private async submitBatch(kind: Kind, items: QueueItem[]): Promise<void> {
    const rows = items.map((item) => item.data);
    try {
      if (kind === 'exposure') {
        await this.http.postExposures(rows);
      } else {
        await this.http.postEvents(rows);
      }
    } catch (error) {
      this.handleSubmitError(kind, items, error);
    }
  }

  // The asymmetric retry contract shared with Ruby/Python: retryable API
  // error → re-queue (max attempts); validation/permanent → drop; unknown
  // network error → exposures re-queued (they feed the completeness gate),
  // events dropped.
  private handleSubmitError(kind: Kind, items: QueueItem[], error: unknown): void {
    if (error instanceof ApiError) {
      if (error.retryable) {
        this.logger(`retryable API error for ${items.length} ${kind}s`, error.message);
        this.requeue(items);
      } else if (error.partialFailure) {
        this.logger(`partial failure, dropping batch of ${items.length} ${kind}s`, error.message);
      } else {
        this.logger(`permanent API error, dropping ${items.length} ${kind}s`, error.message);
      }
    } else if (kind === 'exposure') {
      this.logger(`network error, re-queueing ${items.length} exposures`, error);
      this.requeue(items);
    } else {
      this.logger(`network error, dropping ${items.length} events`, error);
    }
    this.errorCallback?.(error);
  }

  private requeue(items: QueueItem[]): void {
    for (const item of items) {
      item.attempts += 1;
      if (item.attempts >= MAX_SUBMIT_ATTEMPTS) {
        this.logger(`max retries exceeded, dropping ${item.kind}`);
      } else if (this.retryQueue.length >= MAX_RETRY_QUEUE) {
        this.logger(`retry queue full, dropping ${item.kind}`);
      } else {
        this.retryQueue.push(item);
      }
    }
  }
}

// Split rows so each JSON body stays under the shared keepalive/beacon quota.
// String length approximates bytes (payloads are ASCII-dominant); the 20%
// headroom in the limit absorbs the difference.
export function chunkForKeepalive(rows: unknown[], batchSize: number): unknown[][] {
  const chunks: unknown[][] = [];
  let current: unknown[] = [];
  let currentBytes = 2; // []

  for (const row of rows) {
    const rowBytes = JSON.stringify(row).length + 1;
    const overflow = currentBytes + rowBytes > KEEPALIVE_BODY_LIMIT_BYTES || current.length >= batchSize;
    if (overflow && current.length > 0) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
