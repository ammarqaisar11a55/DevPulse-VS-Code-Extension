import { describe, expect, it } from 'vitest';
import { connectionState, statusBarPresentation } from '../../src/ui/statusModel';

describe('connectionState', () => {
  it('derives user-facing connection states', () => {
    expect(connectionState('NOT_CONNECTED', 'disabled')).toBe('NOT_CONNECTED');
    expect(connectionState('CONNECTED', 'synced')).toBe('CONNECTED');
    expect(connectionState('CONNECTED', 'pending')).toBe('CONNECTED');
    expect(connectionState('CONNECTED', 'syncing')).toBe('SYNCING');
    expect(connectionState('CONNECTED', 'offline')).toBe('OFFLINE');
    expect(connectionState('CONNECTED', 'error')).toBe('ERROR');
    expect(connectionState('REVOKED', 'disabled')).toBe('REVOKED');
    expect(connectionState('AUTH_EXPIRED', 'disabled')).toBe('AUTH_EXPIRED');
  });
});

describe('statusBarPresentation', () => {
  const base = {
    connection: 'CONNECTED' as const,
    tracking: 'active' as const,
    todaySeconds: 8040,
    pendingItems: 0,
  };

  it('shows today when connected', () => {
    const view = statusBarPresentation(base);
    expect(view.text).toBe('$(pulse) DevPulse 2h 14m');
    expect(view.accessibilityLabel).toContain('2 hours 14 minutes of coding today');
    expect(view.accessibilityLabel).toContain('Connected');
  });

  it('shows paused and offline states with text, not only color', () => {
    expect(statusBarPresentation({ ...base, tracking: 'paused' }).text).toBe(
      '$(debug-pause) DevPulse Paused',
    );
    const offline = statusBarPresentation({ ...base, connection: 'OFFLINE', pendingItems: 34 });
    expect(offline.text).toContain('DevPulse Offline');
    expect(offline.tooltip).toContain('34 items are waiting to sync');
  });

  it('asks for reconnection after revocation', () => {
    const view = statusBarPresentation({ ...base, connection: 'REVOKED' });
    expect(view.text).toBe('$(warning) DevPulse Needs Reconnection');
    expect(view.severity).toBe('warning');
  });

  it('invites unconnected users to connect', () => {
    const view = statusBarPresentation({
      ...base,
      connection: 'NOT_CONNECTED',
      tracking: 'not-connected',
    });
    expect(view.accessibilityLabel).toMatch(/not connected/);
  });
});
