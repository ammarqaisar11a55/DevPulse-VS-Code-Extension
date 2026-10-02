import {
  DEFAULT_IDLE_THRESHOLD_MINUTES,
  type ConfigurationReader,
  type DevPulseSettings,
  type LogLevel,
  type TrackingMode,
} from './settingsTypes';

/** The hosted DevPulse service. Self-hosters and local development override these in settings. */
const DEFAULT_BASE_URL = 'https://devpulse-three-amber.vercel.app/api/v1';
const DEFAULT_WEB_URL = 'https://devpulse-three-amber.vercel.app';

function bool(reader: ConfigurationReader, key: string, fallback: boolean): boolean {
  const value = reader.get(key);
  return typeof value === 'boolean' ? value : fallback;
}

function num(reader: ConfigurationReader, key: string, fallback: number, min: number, max: number) {
  const value = reader.get(key);
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function str(reader: ConfigurationReader, key: string, fallback: string): string {
  const value = reader.get(key);
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function list(reader: ConfigurationReader, key: string, lowerCase = false): string[] {
  const value = reader.get(key);
  if (!Array.isArray(value)) return [];
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => (lowerCase ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
  return [...new Set(items)];
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/** Reads and normalizes every DevPulse setting, falling back to safe defaults. */
export function readSettings(reader: ConfigurationReader): DevPulseSettings {
  const idleExplicit = reader.isExplicitlySet('tracking.idleThreshold');
  const idleThreshold = num(
    reader,
    'tracking.idleThreshold',
    DEFAULT_IDLE_THRESHOLD_MINUTES,
    1,
    60,
  );
  const sessionTimeout = num(reader, 'tracking.sessionTimeout', 15, 5, 120);

  return {
    enabled: bool(reader, 'enabled', true),
    statusBarEnabled: bool(reader, 'statusBar.enabled', true),
    tracking: {
      enabled: bool(reader, 'tracking.enabled', true),
      mode: oneOf<TrackingMode>(reader.get('tracking.mode'), ['automatic', 'manual'], 'automatic'),
      idleThresholdMinutes: idleExplicit ? idleThreshold : undefined,
      sessionTimeoutMinutes: sessionTimeout,
      pauseWhenUnfocused: bool(reader, 'tracking.pauseWhenUnfocused', true),
    },
    privacy: {
      trackLanguage: bool(reader, 'privacy.trackLanguage', true),
      trackFileNames: bool(reader, 'privacy.trackFileNames', false),
      trackRepository: bool(reader, 'privacy.trackRepository', false),
      trackGit: bool(reader, 'privacy.trackGit', true),
      trackTerminal: bool(reader, 'privacy.trackTerminal', false),
      trackDebugging: bool(reader, 'privacy.trackDebugging', true),
    },
    exclusions: {
      projects: list(reader, 'exclusions.projects'),
      folders: list(reader, 'exclusions.folders'),
      languages: list(reader, 'exclusions.languages', true),
    },
    connection: {
      baseUrl: str(reader, 'api.baseUrl', DEFAULT_BASE_URL).replace(/\/+$/, ''),
      webUrl: str(reader, 'web.url', DEFAULT_WEB_URL).replace(/\/+$/, ''),
      allowInsecureHttp: bool(reader, 'api.allowInsecureHttp', false),
    },
    syncIntervalSeconds: num(reader, 'sync.interval', 60, 30, 600),
    logging: {
      enabled: bool(reader, 'logging.enabled', false),
      level: oneOf<LogLevel>(
        reader.get('logging.level'),
        ['debug', 'info', 'warn', 'error'],
        'info',
      ),
    },
  };
}
