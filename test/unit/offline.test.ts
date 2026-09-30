import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventQueueStore } from '../../src/storage/queueStore';
import { SessionPersister } from '../../src/storage/sessionPersister';
import { SessionStore } from '../../src/storage/sessionStore';
import type { SessionRecord } from '../../src/storage/storageTypes';
import { EventRecorder } from '../../src/sync/eventRecorder';
import { silentLogger } from '../../src/utils/logger';
import { FakeClock, tempDir } from './helpers';

describe('EventRecorder', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = tempDir()));
  afterEach(() => cleanup());

  it('batches events into one durable segment with unique ids', async () => {
    const queue = new EventQueueStore(dir, 'w', new FakeClock());
    const recorder = new EventRecorder(queue, silentLogger);
    recorder.record('SESSION_STARTED', 1, 's1', { language: 'typescript' });
    recorder.record('ACTIVITY', 2, 's1', { metadata: { linesAdded: 2 } });
    recorder.record('IDLE_STARTED', 3, undefined, { metadata: {} });
    expect(recorder.buffered).toBe(3);
    await recorder.flush();
    expect(recorder.buffered).toBe(0);
    expect(await queue.stats()).toMatchObject({ segments: 1, events: 3 });

    const claim = await queue.claimNext();
    const ids = new Set(claim!.events.map((e) => e.clientEventId));
    expect(ids.size).toBe(3);
    expect(claim!.events[2]).not.toHaveProperty('metadata');
    expect(claim!.events[2]).not.toHaveProperty('clientSessionId');
  });

  it('flushes automatically at the threshold', async () => {
    const queue = new EventQueueStore(dir, 'w', new FakeClock());
    const recorder = new EventRecorder(queue, silentLogger, 2);
    recorder.record('ACTIVITY', 1, undefined);
    recorder.record('ACTIVITY', 2, undefined);
    await recorder.flush();
    expect((await queue.stats()).events).toBe(2);
  });

  it('survives a restart: flushed events are read back by a new process', async () => {
    const first = new EventRecorder(new EventQueueStore(dir, 'w1', new FakeClock()), silentLogger);
    first.record('ACTIVITY', 1, 's');
    await first.flush();
    const reopened = new EventQueueStore(dir, 'w2', new FakeClock());
    expect((await reopened.claimNext())?.events).toHaveLength(1);
  });

  it('keeps events in memory when the disk write fails', async () => {
    const broken = {
      append: () => Promise.reject(new Error('EACCES')),
    } as unknown as EventQueueStore;
    const recorder = new EventRecorder(broken, silentLogger);
    recorder.record('ACTIVITY', 1, undefined);
    await recorder.flush();
    expect(recorder.buffered).toBe(1);
  });
});

describe('SessionPersister', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = tempDir()));
  afterEach(() => cleanup());

  const base: SessionRecord = {
    schema: 1,
    clientSessionId: 'abc',
    ownerInstanceId: 'w',
    ownerSeenAt: 0,
    workspaceKey: 'ws',
    project: null,
    projectKey: null,
    startedAt: 0,
    lastActivityAt: 0,
    endedAt: null,
    endReason: null,
    activeSeconds: 0,
    languages: {},
    repository: null,
    branch: null,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commits: 0,
    revision: 1,
  };

  it('writes urgent changes immediately and debounces routine ones', async () => {
    const store = new SessionStore(dir);
    const persister = new SessionPersister(store, silentLogger, 10_000);
    persister.persist(base, true);
    await persister.flush();
    expect((await store.loadRecord('abc'))?.revision).toBe(1);

    const live = { ...base, revision: 2, activeSeconds: 30 };
    persister.persist(live, false);
    live.activeSeconds = 999; // later mutation must not leak into the snapshot
    expect((await store.loadRecord('abc'))?.revision).toBe(1);
    await persister.flush();
    const saved = await store.loadRecord('abc');
    expect(saved?.revision).toBe(2);
    expect(saved?.activeSeconds).toBe(30);
    persister.dispose();
  });
});
