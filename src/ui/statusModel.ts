import type { TrackingStatus } from '../activity/trackingController';
import type { AuthState } from '../auth/authTypes';
import type { SyncStatus } from '../sync/syncTypes';
import { formatDuration } from '../utils/time';

/** Connection states shown to the user. */
export type ConnectionState =
  | 'NOT_CONNECTED'
  | 'PAIRING'
  | 'CONNECTED'
  | 'SYNCING'
  | 'OFFLINE'
  | 'AUTH_EXPIRED'
  | 'REVOKED'
  | 'ERROR';

export function connectionState(auth: AuthState, sync: SyncStatus): ConnectionState {
  switch (auth) {
    case 'NOT_CONNECTED':
    case 'PAIRING':
    case 'AUTH_EXPIRED':
    case 'REVOKED':
      return auth;
    case 'ERROR':
      return 'ERROR';
    case 'CONNECTED':
      if (sync === 'syncing') return 'SYNCING';
      if (sync === 'offline') return 'OFFLINE';
      if (sync === 'error') return 'ERROR';
      return 'CONNECTED';
  }
}

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  NOT_CONNECTED: 'Not connected',
  PAIRING: 'Connecting…',
  CONNECTED: 'Connected',
  SYNCING: 'Syncing',
  OFFLINE: 'Offline',
  AUTH_EXPIRED: 'Needs reconnection',
  REVOKED: 'Device revoked — needs reconnection',
  ERROR: 'Error',
};

/** Text symbols accompany every state so it is never conveyed by color alone. */
export const CONNECTION_SYMBOLS: Record<ConnectionState, string> = {
  NOT_CONNECTED: '○',
  PAIRING: '↻',
  CONNECTED: '●',
  SYNCING: '↻',
  OFFLINE: '○',
  AUTH_EXPIRED: '!',
  REVOKED: '!',
  ERROR: '!',
};

export const SYNC_LABELS: Record<SyncStatus, string> = {
  synced: '✓ Up to date',
  syncing: '↻ Syncing',
  pending: '↻ Waiting to sync',
  offline: '○ Offline — activity is queued',
  'rate-limited': '↻ Paused by the server — retrying later',
  error: '! Sync error',
  disabled: '○ Not syncing',
};

export const TRACKING_LABELS: Record<TrackingStatus, string> = {
  'not-connected': 'Not tracking (not connected)',
  'needs-reconnect': 'Not tracking (reconnect needed)',
  disabled: 'Disabled',
  paused: 'Paused',
  ready: 'Enabled — waiting for activity',
  active: 'Active',
  idle: 'Idle',
};

export interface StatusInput {
  connection: ConnectionState;
  tracking: TrackingStatus;
  todaySeconds: number;
  pendingItems: number;
}

export interface StatusBarPresentation {
  text: string;
  tooltip: string;
  accessibilityLabel: string;
  severity: 'normal' | 'warning' | 'error';
}

function spokenDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  parts.push(`${rest} ${rest === 1 ? 'minute' : 'minutes'}`);
  return parts.join(' ');
}

/** Decides what the status bar shows for a given state. */
export function statusBarPresentation(input: StatusInput): StatusBarPresentation {
  const today = formatDuration(input.todaySeconds);
  const spoken = `${spokenDuration(input.todaySeconds)} of coding today`;
  const connection = CONNECTION_LABELS[input.connection];
  const tracking = TRACKING_LABELS[input.tracking];
  const pending =
    input.pendingItems > 0
      ? `\n${input.pendingItems} ${input.pendingItems === 1 ? 'item is' : 'items are'} waiting to sync.`
      : '';
  const tooltip = `DevPulse — ${connection}\nToday: ${today}\nTracking: ${tracking}${pending}\n\nClick for DevPulse actions.`;

  switch (input.connection) {
    case 'NOT_CONNECTED':
      return {
        text: '$(pulse) DevPulse',
        tooltip: 'DevPulse is not connected.\n\nClick to connect your account.',
        accessibilityLabel: 'DevPulse: not connected. Activate to connect your account.',
        severity: 'normal',
      };
    case 'PAIRING':
      return {
        text: '$(sync~spin) DevPulse',
        tooltip: 'Connecting to DevPulse…',
        accessibilityLabel: 'DevPulse: connecting',
        severity: 'normal',
      };
    case 'AUTH_EXPIRED':
    case 'REVOKED':
    case 'ERROR':
      return {
        text: '$(warning) DevPulse Needs Reconnection',
        tooltip: `DevPulse — ${connection}\n\nClick to reconnect.`,
        accessibilityLabel: `DevPulse: ${connection}. Activate to reconnect.`,
        severity: input.connection === 'ERROR' ? 'error' : 'warning',
      };
    default:
      break;
  }

  if (input.tracking === 'paused' || input.tracking === 'disabled') {
    return {
      text: '$(debug-pause) DevPulse Paused',
      tooltip,
      accessibilityLabel: `DevPulse: tracking paused, ${spoken}, ${connection}`,
      severity: 'normal',
    };
  }
  if (input.connection === 'OFFLINE') {
    return {
      text: `$(cloud-offline) DevPulse Offline · ${today}`,
      tooltip,
      accessibilityLabel: `DevPulse: offline, activity is queued, ${spoken}`,
      severity: 'normal',
    };
  }
  const icon = input.connection === 'SYNCING' ? '$(sync~spin)' : '$(pulse)';
  return {
    text: `${icon} DevPulse ${today}`,
    tooltip,
    accessibilityLabel: `DevPulse: ${spoken}, tracking ${tracking.toLowerCase()}, ${connection}`,
    severity: 'normal',
  };
}
