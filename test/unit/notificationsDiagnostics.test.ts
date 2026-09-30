import { describe, expect, it } from 'vitest';
import { buildDiagnostics } from '../../src/diagnostics/diagnosticsService';
import { readSettings } from '../../src/settings/readSettings';
import type { AppSnapshot } from '../../src/ui/appState';
import { BACKLOG_WARNING_THRESHOLD, NotificationPolicy } from '../../src/ui/notificationPolicy';

const now = Date.UTC(2026, 8, 30, 12);

function snapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    auth: 'CONNECTED',
    connection: 'CONNECTED',
    device: {
      deviceId: 'd1',
      deviceName: 'Ubuntu Laptop',
      account: { username: 'sam', fullName: 'Sam Carter' },
      connectedAt: now - 3_600_000,
      baseUrl: 'http://localhost:4000/api/v1',
    },
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
      session: undefined,
      projectName: 'secret-client-project',
      languageId: 'typescript',
      branch: 'feature/top-secret',
      excluded: false,
      idleThresholdMinutes: 5,
      limitations: [],
    },
    totals: { todaySeconds: 3600, weekSeconds: 7200, source: 'device' },
    pending: { events: 0, sessions: 0 },
    webUrl: 'http://localhost:5173',
    ...overrides,
  };
}

describe('NotificationPolicy', () => {
  it('notifies about revocation once per episode', () => {
    const policy = new NotificationPolicy();
    const revoked = snapshot({ auth: 'REVOKED', connection: 'REVOKED' });
    expect(policy.evaluate(revoked, now).map((d) => d.kind)).toEqual(['revoked']);
    expect(policy.evaluate(revoked, now)).toEqual([]);
    policy.evaluate(snapshot(), now);
    expect(policy.evaluate(revoked, now).map((d) => d.kind)).toEqual(['revoked']);
  });

  it('never notifies for routine activity', () => {
    const policy = new NotificationPolicy();
    for (let i = 0; i < 10; i++) expect(policy.evaluate(snapshot(), now + i)).toEqual([]);
  });

  it('warns about a large backlog at most every few hours', () => {
    const policy = new NotificationPolicy();
    const backlog = snapshot({ pending: { events: BACKLOG_WARNING_THRESHOLD + 34, sessions: 0 } });
    expect(policy.evaluate(backlog, now)[0]?.message).toBe('234 activities are waiting to sync.');
    expect(policy.evaluate(backlog, now + 60_000)).toEqual([]);
    expect(policy.evaluate(backlog, now + 7 * 3_600_000)).toHaveLength(1);
  });

  it('surfaces repeated sync errors, but not being offline', () => {
    const policy = new NotificationPolicy();
    const failing = (i: number) =>
      snapshot({
        sync: {
          status: 'error',
          lastResult: {
            ok: false,
            errorKind: 'SERVER_ERROR',
            message: 'Boom',
            sessionsSynced: 0,
            eventsAccepted: 0,
            eventsDuplicate: 0,
            eventsRejected: 0,
            pendingEvents: i,
            pendingSessions: 0,
          },
          lastSuccessAt: undefined,
          nextAttemptInMs: 1000,
        },
      });
    expect(policy.evaluate(failing(1), now)).toEqual([]);
    expect(policy.evaluate(failing(2), now)).toEqual([]);
    expect(policy.evaluate(failing(3), now).map((d) => d.kind)).toEqual(['sync-error']);
    expect(policy.evaluate(failing(4), now)).toEqual([]);

    const offline = new NotificationPolicy();
    for (let i = 0; i < 5; i++) {
      const snap = failing(i);
      expect(offline.evaluate({ ...snap, sync: { ...snap.sync, status: 'offline' } }, now)).toEqual(
        [],
      );
    }
  });
});

describe('buildDiagnostics', () => {
  it('reports state without secrets, file names or credentials', () => {
    const report = buildDiagnostics({
      snapshot: snapshot(),
      settings: readSettings({
        get: (key) =>
          key === 'api.baseUrl' ? 'https://user:pw@devpulse.example.com/api/v1?token=x' : undefined,
        isExplicitlySet: () => false,
      }),
      apiReachable: 'reachable',
      queue: { events: 0, segments: 0, failedSegments: 0 },
      bufferedEvents: 0,
      extensionVersion: '1.0.0',
      editor: { appName: 'Visual Studio Code', version: '1.104.0', remoteName: undefined },
      platform: 'linux x64',
      workspace: { kind: 'local', trusted: true, folders: 1 },
      git: 'active',
      now,
    });
    expect(report).toContain('- Connection: Connected');
    expect(report).toContain('- API: reachable (https://devpulse.example.com/api/v1)');
    expect(report).toContain('- Device: Ubuntu Laptop');
    expect(report).toContain('- Queue: 0 events');
    expect(report).toContain('- Last successful sync: 2 minutes ago');
    expect(report).toContain('- Extension version: 1.0.0');
    expect(report).not.toMatch(/dpd_|pw@|token=|secret-client-project|top-secret/);
  });
});
