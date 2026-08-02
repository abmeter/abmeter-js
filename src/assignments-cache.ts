import { ASSIGNMENTS_STORAGE_PREFIX } from './constants';
import type { HttpClient } from './http';
import type { Logger } from './config';
import type { User } from './user';

export interface ExposureMetadata {
  exposable_type: 'Experiment';
  exposable_id: number;
  audience_id: number;
}

export interface Assignment {
  value: unknown;
  parameter_id: number;
  space_id: number;
  /** null for feature-flag and default resolutions — never report those as exposures. */
  exposure: ExposureMetadata | null;
}

export interface AssignmentsPayload {
  user: { user_id: string; email?: string | null };
  assignments: Record<string, Assignment>;
}

interface StoredEntry {
  etag?: string;
  payload: AssignmentsPayload;
}

// The value map + hydration. Cache-then-network: hydrate synchronously from
// localStorage (unblocks first paint), then refresh in the background with
// If-None-Match. localStorage blocked → in-memory only; still works, just no
// cross-session cache.
export class AssignmentsCache {
  private readonly http: HttpClient;
  private readonly user: User;
  private readonly logger: Logger;
  private readonly storage: Storage | null;
  private assignments: Record<string, Assignment> = {};
  private etag?: string;

  constructor({ http, user, logger }: { http: HttpClient; user: User; logger: Logger }) {
    this.http = http;
    this.user = user;
    this.logger = logger;
    this.storage = detectStorage();
  }

  hydrateFromStorage(): boolean {
    const raw = this.storageRead(this.storageKey());
    if (!raw) return false;

    try {
      const entry = JSON.parse(raw) as StoredEntry;
      if (!entry?.payload?.assignments) return false;
      this.assignments = entry.payload.assignments;
      this.etag = entry.etag;
      return true;
    } catch {
      return false;
    }
  }

  async refresh(): Promise<void> {
    const body: { user_id: string; email?: string } =
      this.user.email === undefined
        ? { user_id: this.user.userId }
        : { user_id: this.user.userId, email: this.user.email };

    const response = await this.http.fetchAssignments(body, this.etag);
    if (response.status === 304) return; // cache is current

    if (response.payload) {
      this.assignments = response.payload.assignments;
      this.etag = response.etag;
      this.persist({ etag: response.etag, payload: response.payload });
    }
  }

  resolveValue(slug: string): unknown {
    return this.assignments[slug]?.value;
  }

  resolveAssignment(slug: string): Assignment | undefined {
    return this.assignments[slug];
  }

  has(slug: string): boolean {
    return slug in this.assignments;
  }

  private persist(entry: StoredEntry): void {
    try {
      this.storage?.setItem(this.storageKey(), JSON.stringify(entry));
    } catch (error) {
      this.logger('assignments cache not persisted', error);
    }
  }

  private storageRead(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private storageKey(): string {
    return `${ASSIGNMENTS_STORAGE_PREFIX}${this.user.userId}`;
  }
}

function detectStorage(): Storage | null {
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
