import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventQueueStore } from '../../src/storage/queueStore';
import type { QueuedEvent } from '../../src/storage/storageTypes';
import { FakeClock, tempDir } from './helpers';

function event(id: string, at = 0): QueuedEvent {
  return { clientEventId: id, type: 'ACTIVITY', occurredAt: at };
}

describe('EventQueueStore', () => {
  let dir: string;
  let cleanup: () => void;
  let clock: FakeClock;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    clock = new FakeClock();
  });
  afterEach(() => cleanup());

  it('enqueues and dequeues segments oldest first', async () => {
    const queue = new EventQueueStore(dir, 'window-a', clock);
    await queue.append([event('1'), event('2')]);
    clock.advance(1000);
    await queue.append([event('3')]);
    expect(await queue.stats()).toMatchObject({ segments: 2, events: 3 });

    const first = await queue.claimNext();
    expect(first?.events.map((e) => e.clientEventId)).toEqual(['1', '2']);
    await queue.complete(first!);
    const second = await queue.claimNext();
    expect(second?.events.map((e) => e.clientEventId)).toEqual(['3']);
    await queue.complete(second!);
    expect(await queue.claimNext()).toBeUndefined();
    expect(await queue.stats()).toMatchObject({ segments: 0, events: 0 });
  });

  it('lets only one window claim a segment', async () => {
    const a = new EventQueueStore(dir, 'window-a', clock);
    const b = new EventQueueStore(dir, 'window-b', clock);
    await a.append([event('1')]);
    const [claimA, claimB] = await Promise.all([a.claimNext(), b.claimNext()]);
    expect([claimA, claimB].filter(Boolean)).toHaveLength(1);
  });

  it('releases a segment for retry, optionally keeping only the remaining events', async () => {
    const queue = new EventQueueStore(dir, 'window-a', clock);
    await queue.append([event('1'), event('2'), event('3')]);
    const claim = await queue.claimNext();
    await queue.release(claim!, claim!.events.slice(2));
    const retry = await queue.claimNext();
    expect(retry?.events.map((e) => e.clientEventId)).toEqual(['3']);
  });

  it('recovers claims left behind by a crashed window', async () => {
    const crashed = new EventQueueStore(dir, 'window-a', clock);
    await crashed.append([event('1')]);
    expect(await crashed.claimNext()).toBeDefined();

    const other = new EventQueueStore(dir, 'window-b', clock);
    expect(await other.recoverStaleClaims()).toBe(0);
    clock.advance(11 * 60 * 1000);
    expect(await other.recoverStaleClaims()).toBe(1);
    expect((await other.claimNext())?.events).toHaveLength(1);
  });

  it('stays bounded by dropping the oldest segments', async () => {
    const queue = new EventQueueStore(dir, 'w', clock, {
      maxSegments: 2,
      staleClaimMs: 1000,
      maxFailedSegments: 1,
    });
    await queue.append([event('1')]);
    clock.advance(1);
    await queue.append([event('2')]);
    clock.advance(1);
    const dropped = await queue.append([event('3'), event('4')]);
    expect(dropped).toBe(1);
    expect((await queue.claimNext())?.events[0]?.clientEventId).toBe('2');
  });

  it('moves rejected segments aside and caps how many are kept', async () => {
    const queue = new EventQueueStore(dir, 'w', clock, {
      maxSegments: 10,
      staleClaimMs: 1000,
      maxFailedSegments: 1,
    });
    await queue.append([event('1')]);
    clock.advance(1);
    await queue.append([event('2')]);
    await queue.fail((await queue.claimNext())!, 'VALIDATION_ERROR');
    await queue.fail((await queue.claimNext())!, 'VALIDATION_ERROR');
    expect(readdirSync(path.join(dir, 'failed'))).toHaveLength(1);
    expect(await queue.stats()).toMatchObject({ events: 0, failedSegments: 1 });
  });

  it('clears everything and reports the count', async () => {
    const queue = new EventQueueStore(dir, 'w', clock);
    await queue.append([event('1'), event('2')]);
    await queue.claimNext();
    expect(await queue.clear()).toBe(2);
    expect(await queue.stats()).toMatchObject({ segments: 0, events: 0 });
  });
});
