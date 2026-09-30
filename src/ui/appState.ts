import * as vscode from 'vscode';
import { localTotals } from '../activity/localStats';
import type { TrackingController, TrackingSnapshot } from '../activity/trackingController';
import type { AuthManager } from '../auth/authManager';
import type { AuthState } from '../auth/authTypes';
import type { SettingsManager } from '../settings/settingsManager';
import type { SessionStore } from '../storage/sessionStore';
import type { LocalDeviceState, StateStore } from '../storage/stateStore';
import type { EventQueueStore } from '../storage/queueStore';
import type { SyncEngine } from '../sync/syncEngine';
import type { SyncSnapshot } from '../sync/syncTypes';
import type { Logger } from '../utils/logger';
import type { Clock } from '../utils/time';
import { connectionState, type ConnectionState } from './statusModel';

/** Remote totals older than this are not shown. */
const REMOTE_TOTALS_MAX_AGE_MS = 30 * 60 * 1000;
const REFRESH_MS = 60 * 1000;

export interface Totals {
  todaySeconds: number;
  weekSeconds: number;
  /** "account" when the server's all-device totals are used, else this device only. */
  source: 'account' | 'device';
}

export interface AppSnapshot {
  auth: AuthState;
  connection: ConnectionState;
  device: LocalDeviceState | undefined;
  sync: SyncSnapshot;
  tracking: TrackingSnapshot;
  totals: Totals;
  pending: { events: number; sessions: number };
  webUrl: string;
}

/**
 * One read-only view of the extension's state for the UI (status bar, activity view, dashboard,
 * diagnostics). It recomputes totals from local storage at most once a minute.
 */
export class AppState implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<AppSnapshot>();
  private readonly disposables: vscode.Disposable[] = [];
  private localTotals = { todaySeconds: 0, weekSeconds: 0 };
  private pending = { events: 0, sessions: 0 };
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing: Promise<void> | undefined;
  private lastSessionState: string | undefined;
  /** Active seconds of the open session when totals were last computed. */
  private liveAtRefresh: number | undefined;

  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly deps: {
      auth: AuthManager;
      tracking: TrackingController;
      sync: SyncEngine;
      settings: SettingsManager;
      state: StateStore;
      sessions: SessionStore;
      queue: EventQueueStore;
      clock: Clock;
      logger: Logger;
    },
  ) {}

  start(): void {
    const { auth, tracking, sync, settings } = this.deps;
    this.disposables.push(
      auth.onDidChange(() => this.fire()),
      tracking.onDidChange((snapshot) => {
        // Totals change when a session starts or ends; otherwise the live session is enough.
        const key = `${snapshot.sessionState}:${snapshot.session?.clientSessionId ?? ''}`;
        if (key !== this.lastSessionState) {
          this.lastSessionState = key;
          void this.refresh();
        } else {
          this.fire();
        }
      }),
      sync.onDidChange(() => void this.refresh()),
      settings.onDidChange(() => this.fire()),
    );
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    void this.refresh();
  }

  get snapshot(): AppSnapshot {
    const { auth, tracking, sync, settings, state, clock } = this.deps;
    const trackingSnapshot = tracking.snapshot;
    const syncSnapshot = sync.snapshot;
    const live = trackingSnapshot.session;
    // Include the open session's time credited since the last refresh.
    const liveExtra = live ? Math.max(0, live.activeSeconds - (this.liveAtRefresh ?? 0)) : 0;
    const device = {
      todaySeconds: this.localTotals.todaySeconds + liveExtra,
      weekSeconds: this.localTotals.weekSeconds + liveExtra,
    };
    const remote = state.getGlobal('devpulse.remoteSummary');
    const remoteFresh = remote && clock.now() - remote.fetchedAt < REMOTE_TOTALS_MAX_AGE_MS;
    const totals: Totals = remoteFresh
      ? {
          // The server knows every device but not what is still queued here.
          todaySeconds: Math.max(remote.todaySeconds, device.todaySeconds),
          weekSeconds: Math.max(remote.weekSeconds, device.weekSeconds),
          source: 'account',
        }
      : { ...device, source: 'device' };
    return {
      auth: auth.authState,
      connection: connectionState(auth.authState, syncSnapshot.status),
      device: auth.device,
      sync: syncSnapshot,
      tracking: trackingSnapshot,
      totals,
      pending: this.pending,
      webUrl: settings.settings.connection.webUrl,
    };
  }

  /** Recomputes local totals and pending counts from disk. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const now = this.deps.clock.now();
        const stored = await this.deps.sessions.list(now);
        const live = this.deps.tracking.snapshot.session;
        const records = stored
          .map((item) => item.record)
          .filter((record) => record.clientSessionId !== live?.clientSessionId);
        if (live) records.push(live);
        this.liveAtRefresh = live?.activeSeconds;
        this.localTotals = localTotals(records, now);
        const queue = await this.deps.queue.stats();
        this.pending = {
          events: queue.events,
          sessions: stored.filter(
            ({ record, sync }) =>
              !sync.completed && !sync.abandoned && sync.syncedRevision !== record.revision,
          ).length,
        };
      } catch (error) {
        this.deps.logger.warn('Could not compute local totals', error);
      } finally {
        this.refreshing = undefined;
      }
      this.fire();
    })();
    return this.refreshing;
  }

  private fire(): void {
    this.emitter.fire(this.snapshot);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.emitter.dispose();
  }
}
