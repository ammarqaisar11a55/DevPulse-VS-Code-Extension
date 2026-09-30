import { describe, expect, it } from 'vitest';
import { formatDuration, formatRelative } from '../../src/utils/time';
import { checkServerUrl } from '../../src/utils/url';

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [59, '59s'],
    [60, '1m'],
    [3599, '59m'],
    [3600, '1h'],
    [8040, '2h 14m'],
    [3660, '1h 01m'],
  ])('%i seconds → %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('formatRelative', () => {
  it('describes elapsed time', () => {
    expect(formatRelative(0, 10_000)).toBe('just now');
    expect(formatRelative(0, 120_000)).toBe('2 minutes ago');
    expect(formatRelative(0, 3 * 3600_000)).toBe('3 hours ago');
  });
});

describe('checkServerUrl', () => {
  it('accepts https and loopback http', () => {
    expect(checkServerUrl('https://devpulse.example.com/api/v1/', false)).toEqual({
      ok: true,
      url: 'https://devpulse.example.com/api/v1',
    });
    expect(checkServerUrl('http://localhost:4000/api/v1', false).ok).toBe(true);
    expect(checkServerUrl('http://127.0.0.1:4000/api/v1', false).ok).toBe(true);
    expect(checkServerUrl('http://devpulse.localhost/api/v1', false).ok).toBe(true);
  });

  it('rejects insecure remote URLs unless explicitly allowed', () => {
    expect(checkServerUrl('http://devpulse.example.com/api/v1', false).ok).toBe(false);
    expect(checkServerUrl('http://192.168.1.10:4000/api/v1', true).ok).toBe(true);
  });

  it('rejects URLs with embedded credentials and other schemes', () => {
    expect(checkServerUrl('https://me:pw@devpulse.example.com', false).ok).toBe(false);
    expect(checkServerUrl('ftp://devpulse.example.com', false).ok).toBe(false);
    expect(checkServerUrl('not a url', false).ok).toBe(false);
  });
});
