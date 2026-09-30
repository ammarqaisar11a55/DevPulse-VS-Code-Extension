import type { PrivacyManager } from '../privacy/privacyManager';
import { sanitizeMetadata } from '../privacy/dataFilter';
import type { EventQueueStore, ClaimedSegment } from '../storage/queueStore';
import type { SessionStore } from '../storage/sessionStore';
import type {
  QueuedEvent,
  SessionRecord,
  SessionSyncState,
  StoredSession,
} from '../storage/storageTypes';
import type { Logger } from '../utils/logger';
import { toIso, type Clock } from '../utils/time';
import { topLanguage } from '../activity/sessionManager';
import { ApiError, isApiError } from './apiErrors';
import type { ApiClient } from './apiClient';
import {
  MAX_EVENTS_PER_BATCH,
  type ActivityEventDto,
  type CreateSessionRequest,
  type SessionLanguageDto,
  type UpdateSessionRequest,
} from './apiTypes';
import type { RetryManager } from './retryManager';
import type { SyncResult, SyncSnapshot, SyncStatus } from './syncTypes';

/** Open sessions whose window has not refreshed them for this long are treated as abandoned. */
export const ABANDONED_SESSION_MS = 3 * 60 * 1000;
/** Heartbeat an open session at least this often even without changes. */
export const HEARTBEAT_MAX_INTERVAL_MS = 5 * 60 * 1000;
/** The API rejects timestamps further in the future than this. */
const FUTURE_TOLERANCE_MS = 4 * 60 * 1000;
const MAX_SESSION_SECONDS = 24 * 3600;
/** Segments uploaded per pass, so a large backlog is processed incrementally. */
const SEGMENTS_PER_PASS = 20;

export interface SyncEngineDeps {
  api: ApiClient;
  sessions: SessionStore;
  queue: EventQueueStore;
  retry: RetryManager;
  privacy: PrivacyManager;
  clock: Clock;
  logger: Logger;
  instanceId: string;
  /** False when disconnected, disabled or misconfigured. */
  canSync: () => boolean;
  /** Called for 401/403 responses; the engine stops until the state changes. */
  onAuthError: (error: ApiError) => Promise<void>;
  /** The server ended a session this window is still recording (e.g. another window took over). */
  onSessionSuperseded: (clientSessionId: string) => void;
  /** Heartbeat interval requested by the server. */
  heartbeatIntervalMs: () => number;
}

type Listener = (snapshot: SyncSnapshot) => void;

/** Aborts the current pass after a retryable failure. */
class StopPass extends Error {
  constructor(readonly apiError: ApiError) {
    super(apiError.message);
  }
}

/**
 * Uploads locally recorded work. Sessions are synced first (so events can reference their server
 * ids), then queued events oldest-first. Every request is idempotent (clientSessionId,
 * clientEventId), so retries after timeouts or crashes never create duplicates.
 */
export class SyncEngine {
  private running: Promise<SyncResult> | undefined;
  private statusValue: SyncStatus = 'disabled';
  private lastResult: SyncResult | undefined;
  private lastSuccessAt: number | undefined;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly deps: SyncEngineDeps) {}

  get snapshot(): SyncSnapshot {
    return {
      status: this.statusValue,
      lastResult: this.lastResult,
      lastSuccessAt: this.lastSuccessAt,
      nextAttemptInMs: this.deps.retry.remainingMs(),
    };
  }

  onDidChange(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Runs one pass unless one is running (then joins it) or backoff forbids it (unless forced). */
  sync(options: { force?: boolean } = {}): Promise<SyncResult> {
    if (this.running) return this.running;
    if (!this.deps.canSync()) {
      this.setStatus('disabled');
      return Promise.resolve(this.skipped('DevPulse is not connected.'));
    }
    if (!options.force && !this.deps.retry.canAttempt()) {
      return Promise.resolve(this.skipped('Waiting before retrying.'));
    }
    this.running = this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Re-evaluates the idle status (e.g. after connecting or disconnecting). */
  refreshStatus(): void {
    if (!this.deps.canSync()) this.setStatus('disabled');
    else if (this.statusValue === 'disabled') this.setStatus('pending');
  }

  private async pass(): Promise<SyncResult> {
    this.setStatus('syncing');
    const result: SyncResult = {
      ok: true,
      sessionsSynced: 0,
      eventsAccepted: 0,
      eventsDuplicate: 0,
      eventsRejected: 0,
      pendingSessions: 0,
      pendingEvents: 0,
      message: '',
    };
    try {
      await this.syncSessions(result);
      await this.syncEvents(result);
      this.deps.retry.recordSuccess();
      this.lastSuccessAt = this.deps.clock.now();
    } catch (error) {
      const apiError =
        error instanceof StopPass
          ? error.apiError
          : isApiError(error)
            ? error
            : new ApiError('SERVER_ERROR', 'Synchronization failed unexpectedly.');
      if (!(error instanceof StopPass) && !isApiError(error)) {
        this.deps.logger.error('Unexpected synchronization failure', error);
      }
      result.ok = false;
      result.errorKind = apiError.kind;
      result.message = apiError.message;
      if (apiError.kind === 'DEVICE_REVOKED' || apiError.kind === 'NOT_CONNECTED') {
        await this.deps.onAuthError(apiError);
      } else {
        this.deps.retry.recordFailure(apiError.retryAfterMs);
      }
    }

    const counts = await this.pendingCounts();
    result.pendingSessions = counts.sessions;
    result.pendingEvents = counts.events;
    if (result.ok) {
      result.message = `Synced ${result.eventsAccepted} activity ${
        result.eventsAccepted === 1 ? 'event' : 'events'
      } and ${result.sessionsSynced} session ${result.sessionsSynced === 1 ? 'update' : 'updates'}.`;
    }
    this.lastResult = result;
    this.setStatus(this.statusFor(result));
    return result;
  }

  private statusFor(result: SyncResult): SyncStatus {
    if (!this.deps.canSync()) return 'disabled';
    if (result.ok) return result.pendingEvents + result.pendingSessions > 0 ? 'pending' : 'synced';
    switch (result.errorKind) {
      case 'NETWORK_ERROR':
      case 'TIMEOUT':
        return 'offline';
      case 'RATE_LIMITED':
        return 'rate-limited';
      default:
        return 'error';
    }
  }

  // ---------------------------------------------------------------- sessions

  private async syncSessions(result: SyncResult): Promise<void> {
    const now = this.deps.clock.now();
    for (const stored of await this.deps.sessions.list(now)) {
      const { record } = stored;
      let { sync } = stored;
      if (sync.completed || sync.abandoned) continue;

      if (record.endedAt === null && record.ownerInstanceId !== this.deps.instanceId) {
        if (now - record.ownerSeenAt < ABANDONED_SESSION_MS) continue; // Another window's.
        await this.finalizeAbandoned(record);
      }
      const current = (await this.deps.sessions.get(record.clientSessionId, now)) ?? stored;
      sync = current.sync;
      if (!this.needsUpload(current, now)) continue;
      if (await this.uploadSession(current.record, sync)) result.sessionsSynced += 1;
    }
  }

  private needsUpload({ record, sync }: StoredSession, now: number): boolean {
    if (!sync.serverId) return true;
    if (record.revision !== sync.syncedRevision) return true;
    // Keep the server from closing a quiet open session (it closes after 30 min).
    return record.endedAt === null && now - sync.updatedAt >= HEARTBEAT_MAX_INTERVAL_MS;
  }

  /** A window closed or crashed with a session open: end it where activity stopped. */
  private async finalizeAbandoned(record: SessionRecord): Promise<void> {
    const finalized: SessionRecord = {
      ...record,
      endedAt: Math.max(record.startedAt, record.lastActivityAt),
      endReason: 'recovered',
      ownerInstanceId: this.deps.instanceId,
      ownerSeenAt: this.deps.clock.now(),
      revision: record.revision + 1,
    };
    await this.deps.sessions.saveRecord(finalized);
    this.deps.logger.info('Closed a session left open by a previous window');
  }

  private async uploadSession(record: SessionRecord, sync: SessionSyncState): Promise<boolean> {
    const now = this.deps.clock.now();
    const id = record.clientSessionId;
    const problem = timingProblem(record, now);
    if (problem) {
      await this.saveSync(id, { ...sync, abandoned: true, lastError: problem });
      this.deps.logger.warn(`Session not uploaded: ${problem}`);
      return false;
    }
    const revision = record.revision;
    const ended = record.endedAt !== null;
    try {
      let serverId = sync.serverId;
      if (!serverId) {
        const created = await this.deps.api.activity.createSession(this.createBody(record));
        serverId = created.data.id;
        const done = ended && created.data.status === 'ENDED';
        sync = { ...sync, serverId, syncedRevision: done ? revision : 0, completed: done };
        await this.saveSync(id, sync);
        if (done) return true;
      }
      await this.deps.api.activity.updateSession(serverId, this.updateBody(record, now));
      await this.saveSync(id, {
        ...sync,
        serverId,
        syncedRevision: revision,
        completed: ended,
        failures: 0,
        lastError: null,
      });
      return true;
    } catch (error) {
      if (!isApiError(error)) throw error;
      return this.handleSessionError(record, sync, error);
    }
  }

  private async handleSessionError(
    record: SessionRecord,
    sync: SessionSyncState,
    error: ApiError,
  ): Promise<boolean> {
    const id = record.clientSessionId;
    switch (error.kind) {
      case 'CONFLICT':
        // The server already ended this session (stale timeout, another window of this device
        // started a session, or revocation). Its stored version stands.
        await this.saveSync(id, { ...sync, completed: true, lastError: 'ended-on-server' });
        if (record.endedAt === null && record.ownerInstanceId === this.deps.instanceId) {
          this.deps.onSessionSuperseded(id);
        }
        return false;
      case 'NOT_FOUND':
        // Deleted on the web, or recorded by a previous pairing of this editor. Recreating it
        // could duplicate time, so stop uploading it.
        await this.saveSync(id, { ...sync, abandoned: true, lastError: 'not-found' });
        if (record.endedAt === null && record.ownerInstanceId === this.deps.instanceId) {
          this.deps.onSessionSuperseded(id);
        }
        return false;
      case 'API_VALIDATION_ERROR':
        this.deps.logger.warn('The server rejected a session', {
          details: error.details,
          requestId: error.requestId,
        });
        await this.saveSync(id, {
          ...sync,
          abandoned: true,
          lastError: error.message.slice(0, 200),
        });
        return false;
      default:
        await this.saveSync(id, {
          ...sync,
          failures: sync.failures + 1,
          lastError: error.kind,
        });
        throw new StopPass(error);
    }
  }

  private createBody(record: SessionRecord): CreateSessionRequest {
    const body: CreateSessionRequest = {
      clientSessionId: record.clientSessionId,
      startedAt: toIso(record.startedAt),
      editor: 'vscode',
      ...this.metadata(record),
    };
    if (record.project) body.project = record.project;
    if (record.endedAt !== null) {
      body.endedAt = toIso(record.endedAt);
      body.activeSeconds = activeSecondsOf(record);
    }
    return this.deps.privacy.filterForUpload(body);
  }

  private updateBody(record: SessionRecord, now: number): UpdateSessionRequest {
    const body: UpdateSessionRequest = {
      activeSeconds: activeSecondsOf(record),
      ...this.metadata(record),
    };
    if (record.endedAt !== null) {
      body.endedAt = toIso(record.endedAt);
    } else {
      // Heartbeat: the session is open until now (idle time included, as wall-clock duration).
      const heartbeat = Math.min(now, record.startedAt + MAX_SESSION_SECONDS * 1000);
      body.lastHeartbeatAt = toIso(Math.max(record.lastActivityAt, heartbeat));
    }
    return this.deps.privacy.filterForUpload(body);
  }

  private metadata(record: SessionRecord) {
    const policy = this.deps.privacy.policy;
    const languages = policy.language ? languageBreakdown(record) : [];
    return {
      language: policy.language ? topLanguage(record.languages) : null,
      ...(languages.length > 0 ? { languages } : {}),
      repository: record.repository,
      branch: record.branch,
      filesChanged: policy.fileMetadata ? clampCounter(record.filesChanged) : 0,
      linesAdded: policy.fileMetadata ? clampCounter(record.linesAdded) : 0,
      linesRemoved: policy.fileMetadata ? clampCounter(record.linesRemoved) : 0,
      commits: policy.gitActivity ? clampCounter(record.commits) : 0,
    };
  }

  private async saveSync(id: string, state: SessionSyncState): Promise<void> {
    await this.deps.sessions.saveSync(id, { ...state, updatedAt: this.deps.clock.now() });
  }

  // ------------------------------------------------------------------ events

  private async syncEvents(result: SyncResult): Promise<void> {
    for (let i = 0; i < SEGMENTS_PER_PASS; i++) {
      const claim = await this.deps.queue.claimNext();
      if (!claim) return;
      const uploaded = await this.uploadSegment(claim, result);
      if (!uploaded) return;
    }
  }

  /** Returns false when the pass should stop processing segments. */
  private async uploadSegment(claim: ClaimedSegment, result: SyncResult): Promise<boolean> {
    const now = this.deps.clock.now();
    const prepared = await this.prepareEvents(claim.events, now);
    if (prepared === 'wait') {
      // A referenced session is not on the server yet; try again after it syncs.
      await this.deps.queue.release(claim);
      return false;
    }
    if (prepared.length === 0) {
      await this.deps.queue.complete(claim);
      return true;
    }

    let events = prepared;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        for (let offset = 0; offset < events.length; offset += MAX_EVENTS_PER_BATCH) {
          const batch = events.slice(offset, offset + MAX_EVENTS_PER_BATCH);
          const { data } = await this.deps.api.activity.ingestEvents(batch);
          result.eventsAccepted += data.accepted;
          result.eventsDuplicate += data.duplicates;
        }
        await this.deps.queue.complete(claim);
        return true;
      } catch (error) {
        if (!isApiError(error)) {
          await this.deps.queue.release(claim);
          throw error;
        }
        if (error.kind === 'NOT_FOUND' && attempt === 0) {
          // A referenced session no longer exists on the server: keep the events unattached.
          events = events.map(({ sessionId: _omit, ...event }) => event);
          continue;
        }
        if (error.kind === 'API_VALIDATION_ERROR' || error.kind === 'NOT_FOUND') {
          this.deps.logger.warn('The server rejected queued events', {
            details: error.details,
            requestId: error.requestId,
          });
          result.eventsRejected += claim.events.length;
          await this.deps.queue.fail(claim, error.code ?? error.kind);
          return true;
        }
        await this.deps.queue.release(claim);
        throw new StopPass(error);
      }
    }
    return true;
  }

  private async prepareEvents(
    events: QueuedEvent[],
    now: number,
  ): Promise<ActivityEventDto[] | 'wait'> {
    const policy = this.deps.privacy.policy;
    const serverIds = new Map<string, string | null>();
    const prepared: ActivityEventDto[] = [];
    for (const event of events) {
      // Clock sanity: the API rejects future timestamps; such events are dropped.
      if (event.occurredAt > now + FUTURE_TOLERANCE_MS) continue;
      if (!policy.gitActivity && event.type === 'GIT_COMMIT') continue;
      const dto: ActivityEventDto = {
        clientEventId: event.clientEventId,
        type: event.type,
        occurredAt: toIso(event.occurredAt),
      };
      if (event.clientSessionId) {
        let serverId = serverIds.get(event.clientSessionId);
        if (serverId === undefined) {
          const stored = await this.deps.sessions.get(event.clientSessionId, now);
          if (stored && !stored.sync.serverId && !stored.sync.abandoned) return 'wait';
          serverId = stored?.sync.serverId ?? null;
          if (stored?.sync.abandoned && stored.sync.lastError === 'not-found') serverId = null;
          serverIds.set(event.clientSessionId, serverId);
        }
        if (serverId) dto.sessionId = serverId;
      }
      if (event.language && policy.language) dto.language = event.language;
      const metadata = sanitizeMetadata(event.metadata, policy.fileMetadata);
      if (metadata) dto.metadata = metadata;
      prepared.push(dto);
    }
    return prepared;
  }

  // ------------------------------------------------------------------ helpers

  async pendingCounts(): Promise<{ sessions: number; events: number }> {
    const now = this.deps.clock.now();
    const sessions = (await this.deps.sessions.list(now)).filter(
      ({ record, sync }) =>
        !sync.completed && !sync.abandoned && sync.syncedRevision !== record.revision,
    ).length;
    const { events } = await this.deps.queue.stats();
    return { sessions, events };
  }

  private skipped(message: string): SyncResult {
    return {
      ok: false,
      sessionsSynced: 0,
      eventsAccepted: 0,
      eventsDuplicate: 0,
      eventsRejected: 0,
      pendingSessions: 0,
      pendingEvents: 0,
      message,
    };
  }

  private setStatus(status: SyncStatus): void {
    if (status === this.statusValue && status !== 'syncing') return;
    this.statusValue = status;
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function activeSecondsOf(record: SessionRecord): number {
  const end = record.endedAt ?? record.lastActivityAt;
  const duration = Math.max(0, Math.floor((end - record.startedAt) / 1000));
  return Math.min(Math.max(0, Math.round(record.activeSeconds)), duration, MAX_SESSION_SECONDS);
}

function languageBreakdown(record: SessionRecord): SessionLanguageDto[] {
  return Object.entries(record.languages)
    .map(([language, seconds]) => ({ language, activeSeconds: Math.round(seconds) }))
    .filter((entry) => entry.activeSeconds > 0)
    .sort((a, b) => b.activeSeconds - a.activeSeconds)
    .slice(0, 20);
}

function clampCounter(value: number): number {
  return Math.min(1_000_000, Math.max(0, Math.floor(value)));
}

/** Local sanity checks mirroring the server's timing rules. */
export function timingProblem(record: SessionRecord, now: number): string | undefined {
  if (record.startedAt > now + FUTURE_TOLERANCE_MS) return 'start time is in the future';
  if (record.endedAt !== null) {
    if (record.endedAt < record.startedAt) return 'negative duration';
    if (record.endedAt > now + FUTURE_TOLERANCE_MS) return 'end time is in the future';
    if (record.endedAt - record.startedAt > MAX_SESSION_SECONDS * 1000) return 'session too long';
  }
  return undefined;
}
