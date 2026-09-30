export type TrackingMode = 'automatic' | 'manual';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const IDLE_THRESHOLD_CHOICES = [1, 2, 5, 10, 15] as const;
export const DEFAULT_IDLE_THRESHOLD_MINUTES = 5;

export interface TrackingSettings {
  enabled: boolean;
  mode: TrackingMode;
  /** Only set when the user chose a value; otherwise the account setting applies. */
  idleThresholdMinutes: number | undefined;
  sessionTimeoutMinutes: number;
  pauseWhenUnfocused: boolean;
}

export interface PrivacySettings {
  trackLanguage: boolean;
  /** File extensions and changed-file/line counts. Names and paths are never sent. */
  trackFileNames: boolean;
  trackRepository: boolean;
  trackGit: boolean;
  trackTerminal: boolean;
  trackDebugging: boolean;
}

export interface ExclusionSettings {
  projects: string[];
  folders: string[];
  languages: string[];
}

export interface ConnectionSettings {
  baseUrl: string;
  webUrl: string;
  allowInsecureHttp: boolean;
}

export interface DevPulseSettings {
  enabled: boolean;
  statusBarEnabled: boolean;
  tracking: TrackingSettings;
  privacy: PrivacySettings;
  exclusions: ExclusionSettings;
  connection: ConnectionSettings;
  syncIntervalSeconds: number;
  logging: { enabled: boolean; level: LogLevel };
}

/** Minimal view of a VS Code WorkspaceConfiguration so settings parsing stays testable. */
export interface ConfigurationReader {
  get(key: string): unknown;
  /** True when the user (or workspace) explicitly set the key. */
  isExplicitlySet(key: string): boolean;
}
