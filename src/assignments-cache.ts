import { ASSIGNMENTS_STORAGE_PREFIX } from './constants';
import type { HttpClient } from './http';
import type { Logger } from './config';
import type { PlatformStorage } from './platform';
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

// The value map + hydration. Cache-then-network: hydrate from the platform
// storage, then refresh with If-None-Match — both awaited by ready(), in that
// order, so the cached ETag is replayed. Storage blocked → in-memory only;
// still works, just no cross-session cache.
export class AssignmentsCache {
  private readonly http: HttpClient;
  private readonly user: User;
  private readonly logger: Logger;
  private readonly storage: PlatformStorage;
  private assignments: Record<string, Assignment> = {};
  private etag?: string;

  constructor({
    http,
    user,
    logger,
    storage,
  }: {
    http: HttpClient;
    user: User;
    logger: Logger;
    storage: PlatformStorage;
  }) {
    this.http = http;
    this.user = user;
    this.logger = logger;
    this.storage = storage;
  }

  async hydrateFromStorage(): Promise<boolean> {
    let raw: string | null;
    try {
      raw = await this.storage.getItem(this.storageKey());
    } catch {
      return false;
    }
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
    const onError = (error: unknown): void => this.logger('assignments cache not persisted', error);
    try {
      void this.storage.setItem(this.storageKey(), JSON.stringify(entry)).catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  private storageKey(): string {
    return `${ASSIGNMENTS_STORAGE_PREFIX}${this.user.userId}`;
  }
}
