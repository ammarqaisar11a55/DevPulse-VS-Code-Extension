import type { ApiErrorKind } from './apiErrors';

export type SyncStatus =
  /** Everything uploaded (or nothing to upload). */
  | 'synced'
  | 'syncing'
  /** Items are waiting; the next pass will upload them. */
  | 'pending'
  | 'offline'
  | 'rate-limited'
  | 'error'
  /** Not connected or DevPulse disabled. */
  | 'disabled';

export interface SyncResult {
  ok: boolean;
  sessionsSynced: number;
  eventsAccepted: number;
  eventsDuplicate: number;
  eventsRejected: number;
  /** Items still waiting after this pass. */
  pendingSessions: number;
  pendingEvents: number;
  errorKind?: ApiErrorKind;
  message: string;
}

export interface SyncSnapshot {
  status: SyncStatus;
  lastResult: SyncResult | undefined;
  lastSuccessAt: number | undefined;
  nextAttemptInMs: number;
}
