import { describe, expect, it } from 'vitest';
import type { AppSnapshot } from '../../src/ui/appState';
import { dashboardModel, parseDashboardMessage } from '../../src/ui/dashboardModel';

describe('parseDashboardMessage', () => {
  it('accepts only known actions', () => {
    expect(parseDashboardMessage({ type: 'action', action: 'syncNow' })).toBe('syncNow');
    expect(
      parseDashboardMessage({ type: 'action', action: 'workbench.action.terminal.new' }),
    ).toBeUndefined();
    expect(parseDashboardMessage({ type: 'command', action: 'syncNow' })).toBeUndefined();
    expect(parseDashboardMessage('syncNow')).toBeUndefined();
    expect(parseDashboardMessage(null)).toBeUndefined();
  });

  it('accepts the website and repository links', () => {
    expect(parseDashboardMessage({ type: 'action', action: 'openWebsite' })).toBe('openWebsite');
    expect(parseDashboardMessage({ type: 'action', action: 'openRepository' })).toBe(
      'openRepository',
    );
  });
});

describe('dashboardModel', () => {
  const now = Date.UTC(2026, 8, 30, 12);
  const snapshot = {
    auth: 'CONNECTED',
    connection: 'CONNECTED',
    device: undefined,
    sync: {
      status: 'synced',
      lastResult: undefined,
      lastSuccessAt: now - 120_000,
      nextAttemptInMs: 0,
    },
    tracking: {
      status: 'active',
      sessionState: 'ACTIVE',
      mode: 'automatic',
      session: {
        startedAt: now - 3_600_000,
        activeSeconds: 3060,
        languages: { typescript: 2400, css: 600, json: 0.2 },
      },
      projectName: 'Notes Saver',
      languageId: 'typescript',
      branch: 'main',
      excluded: false,
      idleThresholdMinutes: 5,
      limitations: [],
    },
    totals: { todaySeconds: 16_320, weekSeconds: 99_660, source: 'account' },
    pending: { events: 0, sessions: 0 },
    webUrl: 'http://localhost:5173',
  } as unknown as AppSnapshot;

  it('formats the summary for display', () => {
    const model = dashboardModel(snapshot, now);
    expect(model).toMatchObject({
      today: '4h 32m',
      week: '27h 41m',
      totalsScope: 'All devices',
      session: '51m',
      project: 'Notes Saver',
      language: 'TypeScript',
      sync: '✓ Up to date',
      syncDetail: 'Last sync 2 minutes ago',
    });
    expect(model.languages).toEqual([
      { name: 'TypeScript', share: 80, time: '40m' },
      { name: 'CSS', share: 20, time: '10m' },
    ]);
  });
});
