import { ApiError } from './api-error';
import { EVENTS_PATH, EXPOSURES_PATH, USER_ASSIGNMENTS_PATH } from './constants';
import type { AssignmentsPayload } from './assignments-cache';

export interface AssignmentsResponse {
  status: 200 | 304;
  payload?: AssignmentsPayload;
  etag?: string;
}

export interface PostOptions {
  /** Unload path: keepalive fetch + text/plain body (CORS-simple, no preflight). */
  keepalive?: boolean;
}

// fetch-based client for the three browser endpoints. Non-2xx responses throw
// ApiError; network failures propagate the underlying TypeError so the
// submitter can apply its asymmetric unknown-error contract.
export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor({ baseUrl, apiKey }: { baseUrl: string; apiKey: string }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async fetchAssignments(
    body: { user_id: string; email?: string },
    etag?: string
  ): Promise<AssignmentsResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (etag) headers['If-None-Match'] = etag;

    const response = await fetch(`${this.baseUrl}${USER_ASSIGNMENTS_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (response.status === 304) return { status: 304 };
    if (!response.ok) throw new ApiError(response.status, await parseBody(response));

    return {
      status: 200,
      payload: (await response.json()) as AssignmentsPayload,
      etag: response.headers.get('ETag') ?? undefined,
    };
  }

  async postExposures(rows: unknown[], options?: PostOptions): Promise<void> {
    await this.post(EXPOSURES_PATH, rows, options);
  }

  async postEvents(rows: unknown[], options?: PostOptions): Promise<void> {
    await this.post(EVENTS_PATH, rows, options);
  }

  /**
   * Last-resort transport for tab death: sendBeacon cannot set headers, so the
   * API key travels as a query token (accepted server-side only on the two
   * write endpoints). Returns false when the browser refuses the beacon.
   */
  beaconExposures(rows: unknown[]): boolean {
    return this.beacon(EXPOSURES_PATH, rows);
  }

  beaconEvents(rows: unknown[]): boolean {
    return this.beacon(EVENTS_PATH, rows);
  }

  private async post(path: string, rows: unknown[], options?: PostOptions): Promise<void> {
    const keepalive = options?.keepalive ?? false;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      // text/plain on the keepalive path keeps the request CORS-simple (no
      // preflight — a preflight can't complete once the page is gone).
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': keepalive ? 'text/plain' : 'application/json',
      },
      body: JSON.stringify(rows),
      keepalive,
    });
    if (!response.ok) throw new ApiError(response.status, await parseBody(response));
  }

  private beacon(path: string, rows: unknown[]): boolean {
    const sendBeacon = globalThis.navigator?.sendBeacon?.bind(globalThis.navigator);
    if (!sendBeacon) return false;

    const url = `${this.baseUrl}${path}?api_key=${encodeURIComponent(this.apiKey)}`;
    const body = new Blob([JSON.stringify(rows)], { type: 'text/plain' });
    try {
      return sendBeacon(url, body);
    } catch {
      return false;
    }
  }
}

async function parseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
