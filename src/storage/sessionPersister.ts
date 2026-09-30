import type { Logger } from '../utils/logger';
import type { SessionStore } from './sessionStore';
import type { SessionRecord } from './storageTypes';

/**
 * Persists the open session. Routine changes are debounced (activity changes the record many
 * times a minute); lifecycle changes (start, idle, end) are written immediately.
 */
export class SessionPersister {
  private pending: SessionRecord | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: SessionStore,
    private readonly logger: Logger,
    private readonly debounceMs = 5000,
  ) {}

  persist(record: SessionRecord, urgent: boolean): void {
    // Copy: the session manager keeps mutating its record.
    this.pending = { ...record, languages: { ...record.languages } };
    if (urgent) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.debounceMs);
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const record = this.pending;
    this.pending = undefined;
    if (!record) return this.writing;
    this.writing = this.writing
      .then(() => this.store.saveRecord(record))
      .catch((error: unknown) => {
        this.logger.error('Could not save the current session', error);
        // Keep the newest data for the next attempt.
        this.pending ??= record;
      });
    return this.writing;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
