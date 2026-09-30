import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../src/storage/sessionStore';
import type { SessionRecord } from '../../src/storage/storageTypes';
import { tempDir } from './helpers';

const DAY = 86_400_000;

function record(id: string, startedAt: number, endedAt: number | null = null): SessionRecord {
  return {
    schema: 1,
    clientSessionId: id,
    ownerInstanceId: 'w',
    ownerSeenAt: startedAt,
    workspaceKey: 'ws',
    project: { name: 'notes-saver' },
    projectKey: 'p',
    startedAt,
    lastActivityAt: endedAt ?? startedAt,
    endedAt,
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
}

describe('SessionStore', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = tempDir()));
  afterEach(() => cleanup());

  it('persists records and sync state separately', async () => {
    const store = new SessionStore(dir);
    await store.saveRecord(record('a', 1000));
    const loaded = await store.get('a', 5000);
    expect(loaded?.record.project?.name).toBe('notes-saver');
    expect(loaded?.sync).toMatchObject({ serverId: null, syncedRevision: 0, completed: false });

    await store.saveSync('a', { ...loaded!.sync, serverId: 'srv-1', syncedRevision: 1 });
    await store.saveRecord({ ...record('a', 1000), revision: 2 });
    const reloaded = await store.get('a', 5000);
    expect(reloaded?.sync.serverId).toBe('srv-1');
    expect(reloaded?.record.revision).toBe(2);
  });

  it('lists sessions in start order and ignores corrupt files', async () => {
    const store = new SessionStore(dir);
    await store.saveRecord(record('late', 2000));
    await store.saveRecord(record('early', 1000));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${dir}/broken.json`, '{nope');
    const ids = (await store.list(0)).map((s) => s.record.clientSessionId);
    expect(ids).toEqual(['early', 'late']);
  });

  it('prunes old uploaded sessions but keeps unsynced ones', async () => {
    const store = new SessionStore(dir);
    const now = 30 * DAY;
    await store.saveRecord(record('old-synced', 0, 1000));
    await store.saveSync('old-synced', {
      serverId: 's',
      syncedRevision: 1,
      completed: true,
      failures: 0,
      abandoned: false,
      lastError: null,
      updatedAt: 0,
    });
    await store.saveRecord(record('old-unsynced', 0, 1000));
    await store.saveRecord(record('recent', now - DAY, now - DAY + 1000));
    expect(await store.prune(now)).toBe(0);
    const ids = (await store.list(now)).map((s) => s.record.clientSessionId).sort();
    expect(ids).toEqual(['old-unsynced', 'recent']);
  });

  it('caps the outbox size', async () => {
    const store = new SessionStore(dir);
    for (let i = 0; i < 5; i++) await store.saveRecord(record(`s${i}`, i * 1000, i * 1000 + 1));
    expect(await store.prune(10_000, 8, 3)).toBe(2);
    expect((await store.list(0)).map((s) => s.record.clientSessionId)).toEqual(['s2', 's3', 's4']);
  });
});
