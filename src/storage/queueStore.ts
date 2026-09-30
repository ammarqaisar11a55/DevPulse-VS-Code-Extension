import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Clock } from '../utils/time';
import { isNotFound, listFiles, readJson, writeJsonAtomic } from './jsonFiles';
import type { QueuedEvent } from './storageTypes';

export interface QueueLimits {
  /** Oldest segments beyond this are dropped so a long offline period cannot fill the disk. */
  maxSegments: number;
  /** Claims older than this belong to a window that died mid-upload and are released. */
  staleClaimMs: number;
  /** Rejected segments kept for diagnostics. */
  maxFailedSegments: number;
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  maxSegments: 2000,
  staleClaimMs: 10 * 60 * 1000,
  maxFailedSegments: 20,
};

export interface ClaimedSegment {
  /** Name of the segment before it was claimed. */
  name: string;
  claimedPath: string;
  events: QueuedEvent[];
}

const SEGMENT = /^(\d{15})-(\d+)-[0-9a-f-]{36}\.json$/;
const CLAIMED = /^(.+\.json)\.claimed\.([\w-]+)\.(\d+)$/;

/**
 * Durable, append-only event queue stored as small segment files.
 *
 * - Writers never modify existing segments, so no locking is needed between VS Code windows.
 * - A window claims a segment for upload by renaming it (atomic); only one window can win.
 * - Segments are processed oldest first and one at a time, so the whole queue is never loaded
 *   into memory.
 */
export class EventQueueStore {
  private readonly failedDir: string;

  constructor(
    private readonly dir: string,
    private readonly instanceId: string,
    private readonly clock: Clock,
    private readonly limits: QueueLimits = DEFAULT_QUEUE_LIMITS,
  ) {
    this.failedDir = path.join(dir, 'failed');
  }

  /** Persists events as a new segment. Returns the number of old events dropped to stay bounded. */
  async append(events: QueuedEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const stamp = String(this.clock.now()).padStart(15, '0');
    const name = `${stamp}-${events.length}-${randomUUID()}.json`;
    await writeJsonAtomic(path.join(this.dir, name), events);
    return this.enforceLimit();
  }

  /** Number of queued (including claimed) segments and events, computed from file names only. */
  async stats(): Promise<{ segments: number; events: number; failedSegments: number }> {
    const names = await listFiles(this.dir);
    let segments = 0;
    let events = 0;
    for (const name of names) {
      const base = CLAIMED.exec(name)?.[1] ?? name;
      const match = SEGMENT.exec(base);
      if (!match) continue;
      segments += 1;
      events += Number(match[2]);
    }
    const failedSegments = (await listFiles(this.failedDir)).length;
    return { segments, events, failedSegments };
  }

  /** Claims the oldest unclaimed segment for upload, or returns undefined if none are ready. */
  async claimNext(): Promise<ClaimedSegment | undefined> {
    const names = (await listFiles(this.dir)).filter((name) => SEGMENT.test(name)).sort();
    for (const name of names) {
      const claimedPath = path.join(
        this.dir,
        `${name}.claimed.${this.instanceId}.${this.clock.now()}`,
      );
      try {
        await fs.rename(path.join(this.dir, name), claimedPath);
      } catch (error) {
        if (isNotFound(error)) continue; // Another window claimed it first.
        throw error;
      }
      const events = await readJson<QueuedEvent[]>(claimedPath);
      if (!Array.isArray(events)) {
        await this.discardClaimed(claimedPath, name, 'corrupt');
        continue;
      }
      return { name, claimedPath, events };
    }
    return undefined;
  }

  /** The segment was uploaded: delete it. */
  async complete(claim: ClaimedSegment): Promise<void> {
    await fs.rm(claim.claimedPath, { force: true });
  }

  /**
   * Returns a claimed segment to the queue for a later retry, optionally with fewer events
   * (for example after some of them were uploaded).
   */
  async release(claim: ClaimedSegment, remaining: QueuedEvent[] = claim.events): Promise<void> {
    if (remaining.length === 0) {
      await this.complete(claim);
      return;
    }
    const target = path.join(this.dir, claim.name);
    if (remaining.length === claim.events.length) {
      await fs.rename(claim.claimedPath, target);
      return;
    }
    const match = SEGMENT.exec(claim.name);
    const stamp = match?.[1] ?? String(this.clock.now()).padStart(15, '0');
    await writeJsonAtomic(
      path.join(this.dir, `${stamp}-${remaining.length}-${randomUUID()}.json`),
      remaining,
    );
    await fs.rm(claim.claimedPath, { force: true });
  }

  /** The server permanently rejected the segment: keep a bounded copy for diagnostics. */
  async fail(claim: ClaimedSegment, reason: string): Promise<void> {
    await this.discardClaimed(claim.claimedPath, claim.name, reason);
  }

  /** Releases segments claimed by windows that stopped (crash, reload) before finishing. */
  async recoverStaleClaims(): Promise<number> {
    let recovered = 0;
    for (const name of await listFiles(this.dir)) {
      const match = CLAIMED.exec(name);
      if (!match?.[1] || !match[3]) continue;
      const mine = match[2] === this.instanceId;
      const stale = this.clock.now() - Number(match[3]) > this.limits.staleClaimMs;
      if (!mine && !stale) continue;
      try {
        await fs.rename(path.join(this.dir, name), path.join(this.dir, match[1]));
        recovered += 1;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return recovered;
  }

  /** Deletes every queued event. Returns how many were removed. */
  async clear(): Promise<number> {
    const { events } = await this.stats();
    for (const name of await listFiles(this.dir)) {
      const base = CLAIMED.exec(name)?.[1] ?? name;
      if (SEGMENT.test(base)) await fs.rm(path.join(this.dir, name), { force: true });
    }
    await fs.rm(this.failedDir, { recursive: true, force: true });
    return events;
  }

  private async enforceLimit(): Promise<number> {
    const names = (await listFiles(this.dir)).filter((name) => SEGMENT.test(name)).sort();
    const excess = names.length - this.limits.maxSegments;
    let dropped = 0;
    for (const name of names.slice(0, Math.max(0, excess))) {
      dropped += Number(SEGMENT.exec(name)?.[2] ?? 0);
      await fs.rm(path.join(this.dir, name), { force: true });
    }
    return dropped;
  }

  private async discardClaimed(claimedPath: string, name: string, reason: string) {
    await fs.mkdir(this.failedDir, { recursive: true });
    const safeReason = reason.replace(/[^\w-]/g, '_').slice(0, 40);
    await fs.rename(claimedPath, path.join(this.failedDir, `${name}.${safeReason}`));
    const failed = (await listFiles(this.failedDir)).sort();
    for (const old of failed.slice(0, Math.max(0, failed.length - this.limits.maxFailedSegments))) {
      await fs.rm(path.join(this.failedDir, old), { force: true });
    }
  }
}
