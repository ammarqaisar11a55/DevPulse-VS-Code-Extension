import { describe, expect, it } from 'vitest';
import { localTotals } from '../../src/activity/localStats';
import type { SessionRecord } from '../../src/storage/storageTypes';

function session(start: Date, minutes: number, activeSeconds: number): SessionRecord {
  const startedAt = start.getTime();
  return {
    schema: 1,
    clientSessionId: String(startedAt),
    ownerInstanceId: 'w',
    ownerSeenAt: 0,
    workspaceKey: 'ws',
    project: null,
    projectKey: null,
    startedAt,
    lastActivityAt: startedAt + minutes * 60_000,
    endedAt: startedAt + minutes * 60_000,
    endReason: null,
    activeSeconds,
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

describe('localTotals', () => {
  // Wednesday 30 September 2026, 15:00 local time.
  const now = new Date(2026, 8, 30, 15).getTime();

  it('sums today and this week', () => {
    const totals = localTotals(
      [
        session(new Date(2026, 8, 30, 9), 60, 3000), // today
        session(new Date(2026, 8, 28, 10), 30, 1200), // Monday
        session(new Date(2026, 8, 27, 10), 30, 900), // last Sunday: previous week
      ],
      now,
    );
    expect(totals).toEqual({ todaySeconds: 3000, weekSeconds: 4200 });
  });

  it('splits sessions that cross midnight', () => {
    const totals = localTotals([session(new Date(2026, 8, 29, 23), 120, 7200)], now);
    expect(totals.todaySeconds).toBe(3600);
    expect(totals.weekSeconds).toBe(7200);
  });
});
