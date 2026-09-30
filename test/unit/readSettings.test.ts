import { describe, expect, it } from 'vitest';
import { readSettings } from '../../src/settings/readSettings';
import type { ConfigurationReader } from '../../src/settings/settingsTypes';

function reader(values: Record<string, unknown>): ConfigurationReader {
  return {
    get: (key) => values[key],
    isExplicitlySet: (key) => key in values,
  };
}

describe('readSettings', () => {
  it('uses conservative defaults', () => {
    const settings = readSettings(reader({}));
    expect(settings.enabled).toBe(true);
    expect(settings.tracking.mode).toBe('automatic');
    expect(settings.tracking.idleThresholdMinutes).toBeUndefined();
    expect(settings.privacy).toEqual({
      trackLanguage: true,
      trackFileNames: false,
      trackRepository: false,
      trackGit: true,
      trackTerminal: false,
      trackDebugging: true,
    });
    expect(settings.syncIntervalSeconds).toBe(60);
    expect(settings.logging.enabled).toBe(false);
  });

  it('keeps an explicitly chosen idle threshold', () => {
    const settings = readSettings(reader({ 'tracking.idleThreshold': 10 }));
    expect(settings.tracking.idleThresholdMinutes).toBe(10);
  });

  it('clamps numbers and rejects invalid enum values', () => {
    const settings = readSettings(
      reader({ 'sync.interval': 5, 'tracking.mode': 'turbo', 'logging.level': 'loud' }),
    );
    expect(settings.syncIntervalSeconds).toBe(30);
    expect(settings.tracking.mode).toBe('automatic');
    expect(settings.logging.level).toBe('info');
  });

  it('normalizes exclusion lists', () => {
    const settings = readSettings(
      reader({ 'exclusions.languages': ['Markdown', ' json ', '', 42, 'markdown'] }),
    );
    expect(settings.exclusions.languages).toEqual(['markdown', 'json']);
  });

  it('strips trailing slashes from URLs', () => {
    const settings = readSettings(reader({ 'api.baseUrl': 'https://api.example.com/api/v1/' }));
    expect(settings.connection.baseUrl).toBe('https://api.example.com/api/v1');
  });
});
