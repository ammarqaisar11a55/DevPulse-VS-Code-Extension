/** Subset of vscode.Memento, so the store can be tested without VS Code. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** Non-secret information about the paired device. The credential lives in SecretStorage. */
export interface LocalDeviceState {
  deviceId: string;
  deviceName: string;
  account: { username: string; fullName: string };
  connectedAt: number;
  /** API base URL the device was paired against; the credential is only valid there. */
  baseUrl: string;
}

/** Tracking preferences from the user's DevPulse account. */
export interface ServerConfigState {
  idleTimeoutMinutes: number;
  trackBranchNames: boolean;
  trackRepositoryUrl: boolean;
  heartbeatIntervalSeconds: number;
  fetchedAt: number;
}

export interface LastSyncState {
  at: number;
  ok: boolean;
  message: string;
}

/** Account-wide totals from the server, when available. */
export interface RemoteSummaryState {
  todaySeconds: number;
  weekSeconds: number;
  fetchedAt: number;
}

interface GlobalKeys {
  'devpulse.device': LocalDeviceState;
  'devpulse.serverConfig': ServerConfigState;
  'devpulse.trackingPaused': boolean;
  'devpulse.lastSync': LastSyncState;
  'devpulse.remoteSummary': RemoteSummaryState;
  'devpulse.welcomeShown': boolean;
  'devpulse.revoked': boolean;
}

interface WorkspaceKeys {
  /** Session this workspace was recording, for recovery after a reload. */
  'devpulse.currentSessionId': string;
}

/**
 * Typed access to globalState and workspaceState. Never store credentials here: these values
 * are kept in plain text by VS Code.
 */
export class StateStore {
  constructor(
    private readonly global: MementoLike,
    private readonly workspace: MementoLike,
  ) {}

  getGlobal<K extends keyof GlobalKeys>(key: K): GlobalKeys[K] | undefined {
    return this.global.get<GlobalKeys[K]>(key);
  }

  async setGlobal<K extends keyof GlobalKeys>(key: K, value: GlobalKeys[K] | undefined) {
    await this.global.update(key, value);
  }

  getWorkspace<K extends keyof WorkspaceKeys>(key: K): WorkspaceKeys[K] | undefined {
    return this.workspace.get<WorkspaceKeys[K]>(key);
  }

  async setWorkspace<K extends keyof WorkspaceKeys>(key: K, value: WorkspaceKeys[K] | undefined) {
    await this.workspace.update(key, value);
  }
}
