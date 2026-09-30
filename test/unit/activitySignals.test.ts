import { describe, expect, it } from 'vitest';
import {
  SignalThrottle,
  baseName,
  countLineChanges,
  fileExtensionOf,
  isTrackedScheme,
} from '../../src/activity/activitySignals';

describe('countLineChanges', () => {
  it('counts typing on one line as no line change', () => {
    expect(countLineChanges([{ replacedLineSpan: 0, text: 'abc' }])).toEqual({
      added: 0,
      removed: 0,
    });
  });

  it('counts inserted newlines as added lines', () => {
    expect(countLineChanges([{ replacedLineSpan: 0, text: 'a\nb\nc\n' }])).toEqual({
      added: 3,
      removed: 0,
    });
  });

  it('counts deleted line spans as removed lines', () => {
    expect(countLineChanges([{ replacedLineSpan: 4, text: '' }])).toEqual({
      added: 0,
      removed: 4,
    });
  });

  it('nets replacements and sums multiple changes', () => {
    expect(
      countLineChanges([
        { replacedLineSpan: 2, text: 'x\n' },
        { replacedLineSpan: 0, text: '\n\n' },
      ]),
    ).toEqual({ added: 2, removed: 1 });
  });
});

describe('SignalThrottle', () => {
  it('emits once per interval per kind and key', () => {
    const throttle = new SignalThrottle(1000);
    expect(throttle.shouldEmit('selection', 'a', 0)).toBe(true);
    expect(throttle.shouldEmit('selection', 'a', 500)).toBe(false);
    expect(throttle.shouldEmit('selection', 'b', 500)).toBe(true);
    expect(throttle.shouldEmit('scroll', 'a', 500)).toBe(true);
    expect(throttle.shouldEmit('selection', 'a', 1000)).toBe(true);
  });

  it('does not get stuck when the clock goes backwards', () => {
    const throttle = new SignalThrottle(1000);
    throttle.shouldEmit('edit', 'a', 10_000);
    expect(throttle.shouldEmit('edit', 'a', 5_000)).toBe(true);
  });
});

describe('document helpers', () => {
  it('only tracks editor document schemes', () => {
    expect(isTrackedScheme('file')).toBe(true);
    expect(isTrackedScheme('vscode-remote')).toBe(true);
    expect(isTrackedScheme('output')).toBe(false);
    expect(isTrackedScheme('debug')).toBe(false);
  });

  it('extracts base names and extensions', () => {
    expect(baseName('/home/me/project/src/auth.ts')).toBe('auth.ts');
    expect(baseName('C:\\work\\main.cpp')).toBe('main.cpp');
    expect(fileExtensionOf('App.KT')).toBe('.kt');
    expect(fileExtensionOf('.env')).toBe('');
    expect(fileExtensionOf('Makefile')).toBe('');
  });
});
