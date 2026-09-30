import type { SessionRecord } from '../storage/storageTypes';

export interface LocalTotals {
  todaySeconds: number;
  weekSeconds: number;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Monday 00:00 local time of the week containing `ms`. */
function startOfWeek(ms: number): number {
  const date = new Date(startOfDay(ms));
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

/** Active seconds of a session falling inside [from, to), assuming even distribution. */
function activeWithin(record: SessionRecord, from: number, to: number): number {
  const end = record.endedAt ?? record.lastActivityAt;
  const start = record.startedAt;
  if (end <= start) return start >= from && start < to ? record.activeSeconds : 0;
  const overlap = Math.max(0, Math.min(end, to) - Math.max(start, from));
  return (record.activeSeconds * overlap) / (end - start);
}

/**
 * Coding time recorded on this computer today and this week (local time, weeks start Monday),
 * computed from the local session outbox. Account-wide totals come from the server.
 */
export function localTotals(records: readonly SessionRecord[], now: number): LocalTotals {
  const day = startOfDay(now);
  const week = startOfWeek(now);
  let todaySeconds = 0;
  let weekSeconds = 0;
  for (const record of records) {
    todaySeconds += activeWithin(record, day, day + 86_400_000 * 2);
    weekSeconds += activeWithin(record, week, week + 86_400_000 * 8);
  }
  return { todaySeconds: Math.floor(todaySeconds), weekSeconds: Math.floor(weekSeconds) };
}
