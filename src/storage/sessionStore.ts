import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { listFiles, readJson, writeJsonAtomic } from './jsonFiles';
import type { SessionRecord, SessionSyncState, StoredSession } from './storageTypes';

const RECORD = /^([\w-]{1,64})\.json$/;
const DAY = 24 * 60 * 60 * 1000;

export function initialSyncState(now: number): SessionSyncState {
  return {
    serverId: null,
    syncedRevision: 0,
    completed: false,
    failures: 0,
    abandoned: false,
    lastError: null,
    updatedAt: now,
  };
}

/**
 * Session outbox. Each session has a content file written by the window recording it and a
 * separate sync-state file written by the sync engine, so the two never overwrite each other.
 * Completed sessions are kept for a week to compute local totals and resolve event session ids.
 */
export class SessionStore {
  constructor(private readonly dir: string) {}

  private recordPath(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  private syncPath(id: string) {
    return path.join(this.dir, `${id}.sync.json`);
  }

  async saveRecord(record: SessionRecord): Promise<void> {
    await writeJsonAtomic(this.recordPath(record.clientSessionId), record);
  }

  async loadRecord(id: string): Promise<SessionRecord | undefined> {
    const record = await readJson<SessionRecord>(this.recordPath(id));
    return record?.schema === 1 ? record : undefined;
  }

  async saveSync(id: string, state: SessionSyncState): Promise<void> {
    await writeJsonAtomic(this.syncPath(id), state);
  }

  async loadSync(id: string, now: number): Promise<SessionSyncState> {
    return (await readJson<SessionSyncState>(this.syncPath(id))) ?? initialSyncState(now);
  }

  async get(id: string, now: number): Promise<StoredSession | undefined> {
    const record = await this.loadRecord(id);
    if (!record) return undefined;
    return { record, sync: await this.loadSync(id, now) };
  }

  async list(now: number): Promise<StoredSession[]> {
    const sessions: StoredSession[] = [];
    for (const name of await listFiles(this.dir)) {
      const id = RECORD.exec(name)?.[1];
      if (!id || id.endsWith('.sync')) continue;
      const stored = await this.get(id, now);
      if (stored) sessions.push(stored);
    }
    return sessions.sort((a, b) => a.record.startedAt - b.record.startedAt);
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.recordPath(id), { force: true });
    await fs.rm(this.syncPath(id), { force: true });
  }

  /**
   * Deletes uploaded sessions older than `keepDays` and, if the outbox is still over
   * `maxSessions`, the oldest sessions regardless of state. Returns unsynced sessions dropped.
   */
  async prune(now: number, keepDays = 8, maxSessions = 500): Promise<number> {
    const sessions = await this.list(now);
    const cutoff = now - keepDays * DAY;
    const kept: StoredSession[] = [];
    for (const session of sessions) {
      const finished = session.sync.completed || session.sync.abandoned;
      const time = session.record.endedAt ?? session.record.lastActivityAt;
      if (finished && time < cutoff) await this.remove(session.record.clientSessionId);
      else kept.push(session);
    }
    let droppedUnsynced = 0;
    for (const session of kept.slice(0, Math.max(0, kept.length - maxSessions))) {
      if (!session.sync.completed) droppedUnsynced += 1;
      await this.remove(session.record.clientSessionId);
    }
    return droppedUnsynced;
  }

  async clearUnsynced(now: number): Promise<number> {
    let removed = 0;
    for (const session of await this.list(now)) {
      if (session.sync.completed || session.record.endedAt === null) continue;
      await this.remove(session.record.clientSessionId);
      removed += 1;
    }
    return removed;
  }

  async clearAll(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}
