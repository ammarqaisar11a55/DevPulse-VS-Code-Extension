import type { DevPulseSettings } from '../settings/settingsTypes';
import { redactString } from '../utils/redact';
import { formatDuration, formatRelative } from '../utils/time';
import type { AppSnapshot } from '../ui/appState';
import { CONNECTION_LABELS, SYNC_LABELS, TRACKING_LABELS } from '../ui/statusModel';

export interface DiagnosticsInput {
  snapshot: AppSnapshot;
  settings: DevPulseSettings;
  apiReachable: 'reachable' | 'unreachable' | 'not checked' | 'invalid URL';
  queue: { events: number; segments: number; failedSegments: number };
  bufferedEvents: number;
  extensionVersion: string;
  editor: { appName: string; version: string; remoteName: string | undefined };
  platform: string;
  workspace: { kind: string; trusted: boolean; folders: number };
  git: string;
  now: number;
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

/** Host and path of a URL, never credentials or query strings. */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'invalid URL';
  }
}

/**
 * Builds a diagnostics report that is safe to share with support: it lists states, counts and
 * settings, never credentials, pairing keys, file names or code. The final redaction pass is a
 * safety net on top of that.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const { snapshot, settings, now } = input;
  const session = snapshot.tracking.session;
  const lastResult = snapshot.sync.lastResult;
  const lines = [
    '# DevPulse Diagnostics',
    '',
    `Generated ${new Date(now).toISOString()}. This report contains no credentials, file names or source code.`,
    '',
    '## Connection',
    `- Connection: ${CONNECTION_LABELS[snapshot.connection]}`,
    `- API: ${input.apiReachable} (${safeUrl(settings.connection.baseUrl)})`,
    `- Device: ${snapshot.device?.deviceName ?? '—'}`,
    `- Account: ${snapshot.device ? `@${snapshot.device.account.username}` : '—'}`,
    `- Connected since: ${snapshot.device ? formatRelative(snapshot.device.connectedAt, now) : '—'}`,
    '',
    '## Tracking',
    `- Tracking: ${TRACKING_LABELS[snapshot.tracking.status]} (${snapshot.tracking.mode} mode)`,
    `- Current session: ${
      session
        ? `${formatDuration(session.activeSeconds)} active, started ${formatRelative(session.startedAt, now)}`
        : 'none'
    }`,
    `- Idle threshold: ${snapshot.tracking.idleThresholdMinutes} min · session timeout: ${settings.tracking.sessionTimeoutMinutes} min`,
    `- Pause when unfocused: ${onOff(settings.tracking.pauseWhenUnfocused)}`,
    `- Today: ${formatDuration(snapshot.totals.todaySeconds)} · This week: ${formatDuration(snapshot.totals.weekSeconds)} (${snapshot.totals.source})`,
    '',
    '## Sync',
    `- Status: ${SYNC_LABELS[snapshot.sync.status]}`,
    `- Last successful sync: ${
      snapshot.sync.lastSuccessAt ? formatRelative(snapshot.sync.lastSuccessAt, now) : 'never'
    }`,
    `- Last result: ${lastResult ? `${lastResult.ok ? 'ok' : (lastResult.errorKind ?? 'failed')} — ${lastResult.message}` : '—'}`,
    `- Next retry: ${snapshot.sync.nextAttemptInMs > 0 ? `in ${Math.ceil(snapshot.sync.nextAttemptInMs / 1000)} s` : 'not scheduled'}`,
    `- Queue: ${input.queue.events} events in ${input.queue.segments} segments, ${input.bufferedEvents} in memory, ${input.queue.failedSegments} rejected segments kept`,
    `- Sessions waiting: ${snapshot.pending.sessions}`,
    `- Sync interval: ${settings.syncIntervalSeconds} s`,
    '',
    '## Privacy',
    `- Language: ${onOff(settings.privacy.trackLanguage)} · File metadata: ${onOff(settings.privacy.trackFileNames)} · Repository URL: ${onOff(settings.privacy.trackRepository)}`,
    `- Git metadata: ${onOff(settings.privacy.trackGit)} · Terminal: ${onOff(settings.privacy.trackTerminal)} · Debugging: ${onOff(settings.privacy.trackDebugging)}`,
    `- Exclusions: ${settings.exclusions.projects.length} projects, ${settings.exclusions.folders.length} folders, ${settings.exclusions.languages.length} languages`,
    '',
    '## Environment',
    `- Extension version: ${input.extensionVersion}`,
    `- Editor: ${input.editor.appName} ${input.editor.version}${input.editor.remoteName ? ` (remote: ${input.editor.remoteName})` : ''}`,
    `- Platform: ${input.platform}`,
    `- Workspace: ${input.workspace.kind}, ${input.workspace.folders} folders, ${input.workspace.trusted ? 'trusted' : 'untrusted'}`,
    `- Git integration: ${input.git}`,
    `- Logging: ${settings.logging.enabled ? settings.logging.level : 'warnings only'}`,
  ];
  if (snapshot.tracking.limitations.length > 0) {
    lines.push('', '## Limitations', ...snapshot.tracking.limitations.map((item) => `- ${item}`));
  }
  return redactString(lines.join('\n')) + '\n';
}
