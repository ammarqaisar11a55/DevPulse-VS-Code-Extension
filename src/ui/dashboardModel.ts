import { formatDuration, formatRelative } from '../utils/time';
import { languageDisplayName } from '../workspace/languageDetector';
import type { AppSnapshot } from './appState';
import { CONNECTION_LABELS, SYNC_LABELS, TRACKING_LABELS } from './statusModel';

/** Plain data sent to the dashboard webview. Only display strings; no identifiers or paths. */
export interface DashboardModel {
  connected: boolean;
  paused: boolean;
  today: string;
  week: string;
  totalsScope: string;
  session: string;
  sessionDetail: string;
  project: string;
  language: string;
  tracking: string;
  connection: string;
  sync: string;
  syncDetail: string;
  languages: { name: string; share: number; time: string }[];
}

export const DASHBOARD_ACTIONS = [
  'openWeb',
  'togglePause',
  'syncNow',
  'openSettings',
  'connect',
] as const;
export type DashboardAction = (typeof DASHBOARD_ACTIONS)[number];

/** Validates a message from the webview; anything unexpected is ignored. */
export function parseDashboardMessage(message: unknown): DashboardAction | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, action } = message as { type?: unknown; action?: unknown };
  if (type !== 'action' || typeof action !== 'string') return undefined;
  return (DASHBOARD_ACTIONS as readonly string[]).includes(action)
    ? (action as DashboardAction)
    : undefined;
}

export function dashboardModel(snapshot: AppSnapshot, now: number): DashboardModel {
  const { tracking, totals, sync } = snapshot;
  const session = tracking.session;
  const languageEntries = session
    ? Object.entries(session.languages).filter(([, seconds]) => seconds >= 1)
    : [];
  const languageTotal = languageEntries.reduce((sum, [, seconds]) => sum + seconds, 0);
  const waiting = snapshot.pending.events + snapshot.pending.sessions;
  return {
    connected: snapshot.auth === 'CONNECTED',
    paused: tracking.status === 'paused',
    today: formatDuration(totals.todaySeconds),
    week: formatDuration(totals.weekSeconds),
    totalsScope: totals.source === 'account' ? 'All devices' : 'This device',
    session: session ? formatDuration(session.activeSeconds) : '—',
    sessionDetail: session
      ? `${TRACKING_LABELS[tracking.status]} · started ${formatRelative(session.startedAt, now)}`
      : 'Starts when you start coding',
    project: tracking.excluded
      ? `${tracking.projectName ?? 'Project'} (excluded)`
      : (tracking.projectName ?? 'No project'),
    language: tracking.languageId ? languageDisplayName(tracking.languageId) : '—',
    tracking: TRACKING_LABELS[tracking.status],
    connection: CONNECTION_LABELS[snapshot.connection],
    sync: SYNC_LABELS[sync.status],
    syncDetail:
      waiting > 0
        ? `${waiting} ${waiting === 1 ? 'item' : 'items'} waiting`
        : sync.lastSuccessAt
          ? `Last sync ${formatRelative(sync.lastSuccessAt, now)}`
          : '',
    languages: languageEntries
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, seconds]) => ({
        name: languageDisplayName(id),
        share: languageTotal > 0 ? Math.round((seconds / languageTotal) * 100) : 0,
        time: formatDuration(seconds),
      })),
  };
}
