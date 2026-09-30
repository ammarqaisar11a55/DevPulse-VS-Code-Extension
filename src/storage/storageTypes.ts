/*
 * Local persistence models. These are deliberately separate from the server DTOs: they describe
 * what the extension keeps on disk between restarts, never credentials.
 */

/** Project reference as sent to the API, already filtered by privacy settings. */
export interface ProjectRef {
  name: string;
  repositoryUrl?: string;
}

export const ACTIVITY_EVENT_TYPES = [
  'ACTIVITY',
  'SESSION_STARTED',
  'SESSION_ENDED',
  'FILE_OPENED',
  'FILE_CHANGED',
  'IDLE_STARTED',
  'IDLE_ENDED',
  'GIT_COMMIT',
  'DEBUG_STARTED',
  'DEBUG_STOPPED',
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

/** The only metadata keys the API accepts; anything else is rejected server-side. */
export interface EventMetadata {
  fileExtension?: string;
  linesAdded?: number;
  linesRemoved?: number;
  commitCount?: number;
  idleSeconds?: number;
  debugType?: string;
  reason?: string;
}

/** An activity event waiting in the offline queue. */
export interface QueuedEvent {
  clientEventId: string;
  type: ActivityEventType;
  /** Epoch milliseconds (UTC). */
  occurredAt: number;
  /** Local session id; resolved to the server id when the event is uploaded. */
  clientSessionId?: string;
  language?: string;
  metadata?: EventMetadata;
}

/** Content of a coding session, written only by the window that records it. */
export interface SessionRecord {
  schema: 1;
  clientSessionId: string;
  /** Window instance recording this session; other windows leave live sessions alone. */
  ownerInstanceId: string;
  /** Last time the owner persisted the record (epoch ms), used to detect abandoned sessions. */
  ownerSeenAt: number;
  /** Identifies the VS Code workspace so a reloaded window can resume its session. */
  workspaceKey: string;
  project: ProjectRef | null;
  /** Stable local identity of the project (never uploaded). */
  projectKey: string | null;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  endReason: string | null;
  activeSeconds: number;
  /** Active seconds per language id. */
  languages: Record<string, number>;
  repository: string | null;
  branch: string | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  /** Incremented on every change so the sync engine knows what it has uploaded. */
  revision: number;
}

/** Upload progress for a session, kept in a separate file from its content. */
export interface SessionSyncState {
  serverId: string | null;
  syncedRevision: number;
  /** True once the final (ended) revision was accepted by the server. */
  completed: boolean;
  failures: number;
  /** Set when the server permanently rejected the session; it is no longer retried. */
  abandoned: boolean;
  lastError: string | null;
  updatedAt: number;
}

export interface StoredSession {
  record: SessionRecord;
  sync: SessionSyncState;
}
