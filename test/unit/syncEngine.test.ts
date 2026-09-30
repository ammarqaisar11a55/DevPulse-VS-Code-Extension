import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivacyManager } from '../../src/privacy/privacyManager';
import { readSettings } from '../../src/settings/readSettings';
import { EventQueueStore } from '../../src/storage/queueStore';
import { SessionStore } from '../../src/storage/sessionStore';
import type { QueuedEvent, SessionRecord } from '../../src/storage/storageTypes';
import { ApiClient } from '../../src/sync/apiClient';
import { RetryManager } from '../../src/sync/retryManager';
import { ABANDONED_SESSION_MS, SyncEngine } from '../../src/sync/syncEngine';
import { silentLogger } from '../../src/utils/logger';
import { FakeServer } from './fakeServer';
import { FakeClock, tempDir } from './helpers';

const MIN = 60_000;

function record(
  overrides: Partial<SessionRecord> = {},
  start = Date.UTC(2026, 8, 30, 9),
): SessionRecord {
  return {
    schema: 1,
    clientSessionId: randomUUID(),
    ownerInstanceId: 'me',
    ownerSeenAt: start,
    workspaceKey: 'ws',
    project: { name: 'notes', repositoryUrl: 'https://github.com/me/notes' },
    projectKey: 'p',
    startedAt: start,
    lastActivityAt: start + 20 * MIN,
    endedAt: start + 20 * MIN,
    endReason: 'idle-timeout',
    activeSeconds: 18 * 60,
    languages: { typescript: 900, css: 180 },
    repository: 'github.com/me/notes',
    branch: 'main',
    filesChanged: 3,
    linesAdded: 40,
    linesRemoved: 5,
    commits: 1,
    revision: 5,
    ...overrides,
  };
}

function event(clientSessionId?: string, type: QueuedEvent['type'] = 'ACTIVITY'): QueuedEvent {
  return {
    clientEventId: randomUUID(),
    type,
    occurredAt: Date.UTC(2026, 8, 30, 9, 5),
    ...(clientSessionId ? { clientSessionId } : {}),
    language: 'typescript',
    metadata: { linesAdded: 3 },
  };
}

describe('SyncEngine', () => {
  let dir: string;
  let cleanup: () => void;
  let clock: FakeClock;
  let server: FakeServer;
  let sessions: SessionStore;
  let queue: EventQueueStore;
  let connected: boolean;
  let settingsValues: Record<string, unknown>;
  let onAuthError: ReturnType<typeof vi.fn>;
  let onSuperseded: ReturnType<typeof vi.fn>;

  function engine(instanceId = 'me') {
    const api = new ApiClient({
      baseUrl: () => ({ ok: true, url: 'http://localhost:4000/api/v1' }),
      credential: () => Promise.resolve(connected ? 'dpd_test' : undefined),
      userAgent: 'test',
      logger: silentLogger,
      fetch: server.fetch,
    });
    const privacy = new PrivacyManager(
      () => readSettings({ get: (k) => settingsValues[k], isExplicitlySet: () => false }),
      () => undefined,
      '/home/me',
    );
    return new SyncEngine({
      api,
      sessions,
      queue: new EventQueueStore(`${dir}/queue`, instanceId, clock),
      retry: new RetryManager(clock, undefined, (d) => d),
      privacy,
      clock,
      logger: silentLogger,
      instanceId,
      canSync: () => connected,
      onAuthError: onAuthError as never,
      onSessionSuperseded: onSuperseded as never,
      heartbeatIntervalMs: () => 60_000,
    });
  }

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    clock = new FakeClock(Date.UTC(2026, 8, 30, 10));
    server = new FakeServer();
    sessions = new SessionStore(`${dir}/sessions`);
    queue = new EventQueueStore(`${dir}/queue`, 'me', clock);
    connected = true;
    settingsValues = {};
    onAuthError = vi.fn(() => Promise.resolve());
    onSuperseded = vi.fn();
  });
  afterEach(() => cleanup());

  it('uploads a finished session in one idempotent request', async () => {
    const session = record();
    await sessions.saveRecord(session);
    const result = await engine().sync();

    expect(result.ok).toBe(true);
    expect(result.sessionsSynced).toBe(1);
    const [created] = [...server.sessions.values()];
    expect(created?.status).toBe('ENDED');
    expect(created?.activeSeconds).toBe(18 * 60);
    expect(created?.body).toMatchObject({
      clientSessionId: session.clientSessionId,
      editor: 'vscode',
      language: 'typescript',
      languages: [
        { language: 'typescript', activeSeconds: 900 },
        { language: 'css', activeSeconds: 180 },
      ],
      branch: 'main',
      commits: 1,
    });
    expect((await sessions.get(session.clientSessionId, clock.now()))?.sync.completed).toBe(true);
    // Nothing left to do on the next pass.
    server.requests = [];
    await engine().sync();
    expect(server.requests).toHaveLength(0);
  });

  it('applies privacy settings at upload time', async () => {
    await sessions.saveRecord(record());
    await engine().sync();
    const body = [...server.sessions.values()][0]!.body;
    // Repository tracking is off by default; file counts need file metadata tracking.
    expect(body.project).toEqual({ name: 'notes' });
    expect(body.repository).toBeNull();
    expect(body.filesChanged).toBe(0);
    expect(body.linesAdded).toBe(0);
  });

  it('creates open sessions, then heartbeats cumulative totals and ends them', async () => {
    const open = record({ endedAt: null, endReason: null, activeSeconds: 600, revision: 2 });
    await sessions.saveRecord(open);
    const sync = engine();
    await sync.sync();
    const server1 = [...server.sessions.values()][0]!;
    expect(server1.status).toBe('ACTIVE');
    expect(server1.activeSeconds).toBe(600);
    expect(server1.lastHeartbeatAt).toBe(new Date(clock.now()).toISOString());

    await sessions.saveRecord({ ...open, activeSeconds: 900, revision: 3 });
    clock.advance(MIN);
    await sync.sync();
    expect(server1.activeSeconds).toBe(900);

    const endedAt = open.startedAt + 25 * MIN;
    await sessions.saveRecord({
      ...open,
      activeSeconds: 1000,
      endedAt,
      lastActivityAt: endedAt,
      revision: 4,
    });
    await sync.sync();
    expect(server1.status).toBe('ENDED');
    expect(server1.endedAt).toBe(new Date(endedAt).toISOString());
    expect(server.sessions.size).toBe(1);
  });

  it('sends a heartbeat for quiet open sessions so the server keeps them open', async () => {
    const open = record({ endedAt: null, endReason: null });
    await sessions.saveRecord(open);
    const sync = engine();
    await sync.sync();
    server.requests = [];
    clock.advance(MIN);
    await sync.sync();
    expect(server.requests).toHaveLength(0);
    clock.advance(5 * MIN);
    await sync.sync();
    expect(server.requests.map((r) => r.method)).toEqual(['PATCH']);
  });

  it('uploads events after their session and resolves server session ids', async () => {
    const session = record();
    await sessions.saveRecord(session);
    await queue.append([
      event(session.clientSessionId),
      event(session.clientSessionId, 'SESSION_ENDED'),
    ]);
    const result = await engine().sync();
    expect(result.eventsAccepted).toBe(2);
    const serverSessionId = [...server.sessions.values()][0]!.id;
    for (const stored of server.events.values()) expect(stored.sessionId).toBe(serverSessionId);
    expect((await queue.stats()).events).toBe(0);
  });

  it('keeps everything queued while offline and uploads once online without duplicates', async () => {
    const session = record();
    await sessions.saveRecord(session);
    await queue.append([event(session.clientSessionId), event()]);

    server.offline = true;
    const sync = engine();
    const offline = await sync.sync();
    expect(offline.ok).toBe(false);
    expect(offline.errorKind).toBe('NETWORK_ERROR');
    expect(sync.snapshot.status).toBe('offline');
    expect(offline.pendingEvents).toBe(2);
    expect(offline.pendingSessions).toBe(1);

    // Backoff: no immediate retry.
    const skipped = await sync.sync();
    expect(skipped.message).toMatch(/Waiting/);

    server.offline = false;
    clock.advance(10_000);
    const online = await sync.sync();
    expect(online.ok).toBe(true);
    expect(server.sessions.size).toBe(1);
    expect(server.events.size).toBe(2);
    expect(sync.snapshot.status).toBe('synced');
  });

  it('survives a response lost after the server stored the data (retry is deduplicated)', async () => {
    const session = record();
    await sessions.saveRecord(session);
    const events = [event(session.clientSessionId)];
    await queue.append(events);
    await engine().sync();

    // Simulate a crash before local bookkeeping: the same data is queued again.
    await queue.append(events);
    await sessions.saveSync(session.clientSessionId, {
      serverId: null,
      syncedRevision: 0,
      completed: false,
      failures: 0,
      abandoned: false,
      lastError: null,
      updatedAt: 0,
    });
    const result = await engine().sync();
    expect(result.ok).toBe(true);
    expect(result.eventsDuplicate).toBe(1);
    expect(server.sessions.size).toBe(1);
    expect(server.events.size).toBe(1);
  });

  it('backs off on rate limiting using the server delay', async () => {
    await queue.append([event()]);
    server.rateLimitSeconds = 30;
    const sync = engine();
    const result = await sync.sync();
    expect(result.errorKind).toBe('RATE_LIMITED');
    expect(sync.snapshot.status).toBe('rate-limited');
    expect(sync.snapshot.nextAttemptInMs).toBe(30_000);
    expect((await queue.stats()).events).toBe(1);
  });

  it('stops and reports revoked devices without retrying', async () => {
    await queue.append([event()]);
    server.revoked = true;
    const sync = engine();
    const result = await sync.sync();
    expect(result.errorKind).toBe('DEVICE_REVOKED');
    expect(onAuthError).toHaveBeenCalledOnce();
    expect((await queue.stats()).events).toBe(1);
  });

  it('does nothing while disconnected', async () => {
    connected = false;
    await queue.append([event()]);
    const sync = engine();
    await sync.sync();
    expect(server.requests).toHaveLength(0);
    expect(sync.snapshot.status).toBe('disabled');
  });

  it('retries server errors on a later pass', async () => {
    await queue.append([event()]);
    server.failNext = 503;
    const sync = engine();
    expect((await sync.sync()).errorKind).toBe('SERVER_ERROR');
    clock.advance(6_000);
    expect((await sync.sync()).eventsAccepted).toBe(1);
  });

  it('closes sessions abandoned by crashed windows at their last activity', async () => {
    const orphan = record({
      endedAt: null,
      endReason: null,
      ownerInstanceId: 'crashed-window',
      ownerSeenAt: clock.now() - ABANDONED_SESSION_MS - 1,
    });
    await sessions.saveRecord(orphan);
    await engine().sync();
    const serverSession = [...server.sessions.values()][0]!;
    expect(serverSession.status).toBe('ENDED');
    expect(serverSession.endedAt).toBe(new Date(orphan.lastActivityAt).toISOString());
  });

  it('leaves live sessions of other windows alone', async () => {
    await sessions.saveRecord(
      record({
        endedAt: null,
        endReason: null,
        ownerInstanceId: 'other',
        ownerSeenAt: clock.now(),
      }),
    );
    await engine().sync();
    expect(server.sessions.size).toBe(0);
  });

  it('handles sessions ended on the server by marking them done and notifying the owner', async () => {
    const open = record({ endedAt: null, endReason: null, revision: 2 });
    await sessions.saveRecord(open);
    const sync = engine();
    await sync.sync();
    // Another window of this device starts a session: the server ends ours.
    [...server.sessions.values()][0]!.status = 'ENDED';
    await sessions.saveRecord({ ...open, revision: 3, activeSeconds: 700 });
    await sync.sync();
    expect(onSuperseded).toHaveBeenCalledWith(open.clientSessionId);
    expect((await sessions.get(open.clientSessionId, clock.now()))?.sync.completed).toBe(true);
  });

  it('abandons sessions the server rejects and never resends them', async () => {
    const bad = record({ startedAt: clock.now() + 60 * MIN, endedAt: null, endReason: null });
    await sessions.saveRecord(bad);
    await engine().sync();
    expect(server.requests).toHaveLength(0);
    expect((await sessions.get(bad.clientSessionId, clock.now()))?.sync.abandoned).toBe(true);
  });

  it('uploads events without a session id when their session no longer exists', async () => {
    const session = record();
    await sessions.saveRecord(session);
    await sessions.saveSync(session.clientSessionId, {
      serverId: '6f1c2b9e-0000-4000-8000-000000000000',
      syncedRevision: session.revision,
      completed: true,
      failures: 0,
      abandoned: false,
      lastError: null,
      updatedAt: 0,
    });
    await queue.append([event(session.clientSessionId)]);
    const result = await engine().sync();
    expect(result.eventsAccepted).toBe(1);
    expect([...server.events.values()][0]!.sessionId).toBeUndefined();
  });

  it('only sends allow-listed metadata', async () => {
    const e = event();
    (e.metadata as Record<string, unknown>).path = '/home/me/.env';
    settingsValues['privacy.trackFileNames'] = true;
    await queue.append([e]);
    await engine().sync();
    expect([...server.events.values()][0]!.metadata).toEqual({ linesAdded: 3 });
  });

  it('shares one pass between concurrent callers', async () => {
    await queue.append([event()]);
    const sync = engine();
    const [a, b] = await Promise.all([sync.sync(), sync.sync()]);
    expect(a).toBe(b);
    expect(server.events.size).toBe(1);
  });
});
