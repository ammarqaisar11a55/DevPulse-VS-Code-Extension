import { describe, expect, it } from 'vitest';
import { RedactingLogger } from '../../src/utils/logger';
import { redact, redactString } from '../../src/utils/redact';

function capture() {
  const lines: string[] = [];
  const logger = new RedactingLogger({ appendLine: (line) => lines.push(line) }, () => new Date(0));
  return { lines, logger };
}

describe('redaction', () => {
  it('masks device credentials, pairing keys and bearer tokens', () => {
    const text = redactString(
      'cred dpd_abcDEF123_-x key DP-7F3K-X92M-Q8PR auth Bearer eyJhbGciOi.payload.sig',
    );
    expect(text).not.toContain('abcDEF123');
    expect(text).not.toContain('7F3K');
    expect(text).not.toContain('eyJhbGciOi');
  });

  it('removes credentials embedded in URLs', () => {
    expect(redactString('https://user:ghp_secret@github.com/me/repo.git')).toBe(
      'https://[REDACTED]@github.com/me/repo.git',
    );
  });

  it('drops values of sensitive keys in nested objects', () => {
    const result = redact({ headers: { Authorization: 'x' }, credential: 'y', ok: 1 });
    expect(result).toEqual({
      headers: { Authorization: '[REDACTED]' },
      credential: '[REDACTED]',
      ok: 1,
    });
  });

  it('handles circular structures', () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    expect(redact(value)).toEqual({ a: 1, self: '[Circular]' });
  });
});

describe('RedactingLogger', () => {
  it('only writes warnings and errors while verbose logging is disabled', () => {
    const { lines, logger } = capture();
    logger.info('hello');
    logger.debug('hidden');
    logger.warn('careful');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[WARN] careful');
  });

  it('respects the configured level when enabled', () => {
    const { lines, logger } = capture();
    logger.configure({ enabled: true, level: 'debug' });
    logger.debug('details', { token: 'secret' });
    expect(lines[0]).toContain('[DEBUG] details {"token":"[REDACTED]"}');
  });
});
