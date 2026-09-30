/*
 * Wire types for the DevPulse REST API (see DevPulse-Web docs/API.md and packages/shared).
 * Only the fields the extension uses are declared; parsers below validate them at runtime.
 */
import { bool, num, obj, optStr, str } from '../utils/validate';
import type { ActivityEventType, EventMetadata, ProjectRef } from '../storage/storageTypes';

export type DevicePlatform = 'linux' | 'darwin' | 'win32' | 'other';

export interface PairDeviceRequest {
  key: string;
  device: {
    name: string;
    platform?: DevicePlatform;
    editor?: string;
    editorVersion?: string;
    extensionVersion?: string;
  };
}

export interface ExtensionConfigDto {
  idleTimeoutMinutes: number;
  trackBranchNames: boolean;
  trackRepositoryUrl: boolean;
  heartbeatIntervalSeconds: number;
}

export interface AccountDto {
  username: string;
  fullName: string;
}

export interface DeviceRefDto {
  id: string;
  name: string;
}

export interface PairDeviceResponse {
  credential: string;
  device: DeviceRefDto;
  account: AccountDto;
  config: ExtensionConfigDto;
}

export interface ExtensionConfigResponse {
  config: ExtensionConfigDto;
  device: DeviceRefDto;
  account: AccountDto;
}

/** Totals for the connected account, computed by the server in the user's time zone. */
export interface ExtensionSummaryDto {
  timezone: string;
  todaySeconds: number;
  weekSeconds: number;
}

export interface SessionLanguageDto {
  language: string;
  activeSeconds: number;
}

export interface CreateSessionRequest {
  clientSessionId: string;
  startedAt: string;
  endedAt?: string;
  activeSeconds?: number;
  project?: ProjectRef;
  language?: string | null;
  languages?: SessionLanguageDto[];
  repository?: string | null;
  branch?: string | null;
  editor?: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  commits?: number;
}

export interface UpdateSessionRequest {
  lastHeartbeatAt?: string;
  endedAt?: string;
  activeSeconds?: number;
  language?: string | null;
  languages?: SessionLanguageDto[];
  repository?: string | null;
  branch?: string | null;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  commits?: number;
}

export interface SessionDto {
  id: string;
  status: 'ACTIVE' | 'ENDED';
  startedAt: string;
  endedAt: string | null;
  activeSeconds: number;
}

export interface ActivityEventDto {
  clientEventId: string;
  type: ActivityEventType;
  occurredAt: string;
  sessionId?: string;
  language?: string;
  metadata?: EventMetadata;
}

export interface IngestEventsResult {
  accepted: number;
  duplicates: number;
}

/** Most events the API accepts per request. */
export const MAX_EVENTS_PER_BATCH = 500;

function parseConfig(value: unknown): ExtensionConfigDto {
  const data = obj(value, 'config');
  return {
    idleTimeoutMinutes: num(data.idleTimeoutMinutes, 'config.idleTimeoutMinutes'),
    trackBranchNames: bool(data.trackBranchNames, 'config.trackBranchNames'),
    trackRepositoryUrl: bool(data.trackRepositoryUrl, 'config.trackRepositoryUrl'),
    heartbeatIntervalSeconds: num(data.heartbeatIntervalSeconds, 'config.heartbeatIntervalSeconds'),
  };
}

function parseDevice(value: unknown): DeviceRefDto {
  const data = obj(value, 'device');
  return { id: str(data.id, 'device.id'), name: str(data.name, 'device.name') };
}

function parseAccount(value: unknown): AccountDto {
  const data = obj(value, 'account');
  return {
    username: str(data.username, 'account.username'),
    fullName: str(data.fullName, 'account.fullName'),
  };
}

export const parsers = {
  pair(value: unknown): PairDeviceResponse {
    const data = obj(value, 'data');
    return {
      credential: str(data.credential, 'credential'),
      device: parseDevice(data.device),
      account: parseAccount(data.account),
      config: parseConfig(data.config),
    };
  },
  config(value: unknown): ExtensionConfigResponse {
    const data = obj(value, 'data');
    return {
      config: parseConfig(data.config),
      device: parseDevice(data.device),
      account: parseAccount(data.account),
    };
  },
  summary(value: unknown): ExtensionSummaryDto {
    const data = obj(value, 'data');
    return {
      timezone: str(data.timezone, 'timezone'),
      todaySeconds: num(data.todaySeconds, 'todaySeconds'),
      weekSeconds: num(data.weekSeconds, 'weekSeconds'),
    };
  },
  device(value: unknown): DeviceRefDto {
    return parseDevice(value);
  },
  session(value: unknown): SessionDto {
    const data = obj(value, 'session');
    const status = str(data.status, 'session.status');
    if (status !== 'ACTIVE' && status !== 'ENDED') throw new Error('Unknown session status');
    return {
      id: str(data.id, 'session.id'),
      status,
      startedAt: str(data.startedAt, 'session.startedAt'),
      endedAt: optStr(data.endedAt, 'session.endedAt'),
      activeSeconds: num(data.activeSeconds, 'session.activeSeconds'),
    };
  },
  ingest(value: unknown): IngestEventsResult {
    const data = obj(value, 'data');
    return {
      accepted: num(data.accepted, 'accepted'),
      duplicates: num(data.duplicates, 'duplicates'),
    };
  },
};
