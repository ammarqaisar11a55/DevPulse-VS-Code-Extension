import type { AppSnapshot } from './appState';

/** Queued items above which the user is told that data is waiting. */
export const BACKLOG_WARNING_THRESHOLD = 200;
const BACKLOG_REPEAT_MS = 6 * 60 * 60 * 1000;
/** Consecutive failed passes before a sync error is surfaced. */
const SYNC_ERROR_PASSES = 3;

export interface NotificationDecision {
  kind: 'revoked' | 'reconnect' | 'backlog' | 'sync-error';
  message: string;
}

/**
 * Decides which notifications to show for a state change. Pure, so the anti-spam rules are
 * testable: each kind fires once per episode, and session starts never notify.
 */
export class NotificationPolicy {
  private shown = new Set<string>();
  private lastBacklogAt = 0;
  private failedPasses = 0;
  private lastResult: unknown;

  evaluate(snapshot: AppSnapshot, now: number): NotificationDecision[] {
    const decisions: NotificationDecision[] = [];

    if (snapshot.auth === 'REVOKED') {
      if (this.once('revoked')) {
        decisions.push({
          kind: 'revoked',
          message:
            'This device was revoked from DevPulse. Tracking stopped; unsynced activity stays on this computer until you reconnect.',
        });
      }
    } else if (snapshot.auth === 'AUTH_EXPIRED') {
      if (this.once('reconnect')) {
        decisions.push({
          kind: 'reconnect',
          message: 'DevPulse needs you to reconnect: the saved device credential is missing.',
        });
      }
    } else {
      this.shown.delete('revoked');
      this.shown.delete('reconnect');
    }

    const result = snapshot.sync.lastResult;
    if (result && result !== this.lastResult) {
      this.lastResult = result;
      if (result.ok) {
        this.failedPasses = 0;
        this.shown.delete('sync-error');
      } else if (result.errorKind && result.errorKind !== 'NOT_CONNECTED') {
        this.failedPasses += 1;
      }
    }
    const offline = snapshot.sync.status === 'offline';
    if (
      !offline &&
      snapshot.sync.status === 'error' &&
      this.failedPasses >= SYNC_ERROR_PASSES &&
      this.once('sync-error')
    ) {
      decisions.push({
        kind: 'sync-error',
        message: `DevPulse cannot sync right now (${result?.message ?? 'unknown error'}). Activity is kept locally and retried.`,
      });
    }

    const waiting = snapshot.pending.events + snapshot.pending.sessions;
    if (
      snapshot.auth === 'CONNECTED' &&
      waiting >= BACKLOG_WARNING_THRESHOLD &&
      snapshot.sync.status !== 'syncing' &&
      now - this.lastBacklogAt >= BACKLOG_REPEAT_MS
    ) {
      this.lastBacklogAt = now;
      decisions.push({
        kind: 'backlog',
        message: `${waiting} activities are waiting to sync.`,
      });
    }
    return decisions;
  }

  private once(key: string): boolean {
    if (this.shown.has(key)) return false;
    this.shown.add(key);
    return true;
  }
}
