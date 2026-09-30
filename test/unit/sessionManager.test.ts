import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_MS,
  SessionManager,
  type SessionConfig,
  type SessionSink,
  type SessionState,
  type WorkContext,
} from '../../src/activity/sessionManager';
import type { ActivityEventType, SessionRecord } from '../../src/storage/storageTypes';
import { FakeClock } from './helpers';

const SEC = 1000;
const MIN = 60 * SEC;

const config: SessionConfig = {
  mode: 'automatic',
  idleThresholdMs: 5 * MIN,
  sessionTimeoutMs: 15 * MIN,
  pauseWhenUnfocused: true,
};

function ctx(overrides: Partial<WorkContext> = {}): WorkContext {
  return {
    workspaceKey: 'ws',
    projectKey: 'notes',
    project: { name: 'Notes Saver' },
    language: 'typescript',
    repository: null,
    branch: 'main',
    fileKey: 'auth.ts',
    ...overrides,
  };
}

class RecordingSink implements SessionSink {
  states: SessionState[] = [];
  started: SessionRecord[] = [];
  ended: SessionRecord[] = [];
  events: { type: ActivityEventType; at: number; metadata?: unknown; language?: unknown }[] = [];
  persisted = 0;
  stateChanged(state: SessionState) {
    this.states.push(state);
  }
  persist() {
    this.persisted++;
  }
  sessionStarted(record: SessionRecord) {
    this.started.push({ ...record });
  }
  sessionEnded(record: SessionRecord) {
    this.ended.push({ ...record });
  }
  event(
    type: ActivityEventType,
    at: number,
    _record: SessionRecord,
    options?: { language?: string | null; metadata?: unknown },
  ) {
    this.events.push({ type, at, metadata: options?.metadata, language: options?.language });
  }
  types() {
    return this.events.map((e) => e.type);
  }
}

function setup(overrides: Partial<SessionConfig> = {}) {
  const clock = new FakeClock();
  const sink = new RecordingSink();
  const manager = new SessionManager({ ...config, ...overrides }, clock, sink, 'window-1');
  manager.setEnabled(true);
  const t0 = clock.now();
  /** Activity every `stepMs` for `durationMs`, advancing the clock and ticking. */
  const work = (durationMs: number, stepMs = 30 * SEC, context = ctx(), edit = false) => {
    const end = clock.now() + durationMs;
    while (clock.now() <= end) {
      manager.activity(clock.now(), context, edit ? { added: 1, removed: 0 } : undefined);
      manager.tick();
      if (clock.now() + stepMs > end) break;
      clock.advance(stepMs);
    }
  };
  /** Let time pass without activity, ticking every 15 s like the extension does. */
  const wait = (durationMs: number) => {
    const end = clock.now() + durationMs;
    while (clock.now() < end) {
      clock.advance(Math.min(15 * SEC, end - clock.now()));
      manager.tick();
    }
  };
  return { clock, sink, manager, t0, work, wait };
}

describe('SessionManager', () => {
  it('creates no session when nothing happens (scenario 2)', () => {
    const { manager, sink, wait } = setup();
    wait(20 * MIN);
    expect(manager.current).toBeUndefined();
    expect(manager.state).toBe('READY');
    expect(sink.started).toHaveLength(0);
  });

  it('keeps one session across a short pause (scenario 1)', () => {
    const { manager, sink, work, wait, clock } = setup();
    work(20 * MIN);
    wait(2 * MIN);
    clock.advance(0);
    work(5 * MIN);
    expect(sink.started).toHaveLength(1);
    expect(sink.ended).toHaveLength(0);
    // 20 min + the 2 min gap (below the idle threshold) + 5 min.
    expect(manager.liveActiveSeconds()).toBe(27 * 60);
    expect(manager.state).toBe('ACTIVE');
  });

  it('does not split sessions when switching files', () => {
    const { manager, sink, clock } = setup();
    for (const file of ['auth.ts', 'users.ts', 'middleware.ts', 'server.ts']) {
      manager.activity(clock.now(), ctx({ fileKey: file }), { added: 2, removed: 1 });
      clock.advance(20 * SEC);
    }
    expect(sink.started).toHaveLength(1);
    expect(manager.current?.filesChanged).toBe(4);
    expect(manager.current?.linesAdded).toBe(8);
    expect(manager.current?.linesRemoved).toBe(4);
  });

  it('goes idle at the threshold and resumes the same session without crediting idle time', () => {
    const { manager, sink, work, wait, t0 } = setup();
    work(10 * MIN);
    wait(8 * MIN);
    expect(manager.state).toBe('IDLE');
    const idleStart = sink.events.find((e) => e.type === 'IDLE_STARTED');
    expect(idleStart?.at).toBe(t0 + 10 * MIN);

    work(5 * MIN);
    expect(manager.state).toBe('ACTIVE');
    expect(sink.started).toHaveLength(1);
    const idleEnd = sink.events.find((e) => e.type === 'IDLE_ENDED');
    expect(idleEnd?.metadata).toEqual({ idleSeconds: 8 * 60 });
    expect(manager.liveActiveSeconds()).toBe(15 * 60);
  });

  it('ends the session at the last activity after the session timeout', () => {
    const { manager, sink, work, wait, t0 } = setup();
    work(10 * MIN);
    wait(30 * MIN);
    expect(manager.current).toBeUndefined();
    expect(sink.ended).toHaveLength(1);
    const ended = sink.ended[0]!;
    expect(ended.endedAt).toBe(t0 + 10 * MIN);
    expect(ended.activeSeconds).toBe(10 * 60);
    expect(ended.endReason).toBe('idle-timeout');
    expect(manager.state).toBe('READY');
  });

  it('does not stretch a session across laptop sleep', () => {
    const { manager, sink, work, clock, t0 } = setup();
    work(30 * MIN);
    // Asleep: no ticks run for 9 hours, then the user types.
    clock.advance(9 * 60 * MIN);
    manager.activity(clock.now(), ctx());
    expect(sink.ended).toHaveLength(1);
    expect(sink.ended[0]!.endedAt).toBe(t0 + 30 * MIN);
    expect(sink.ended[0]!.activeSeconds).toBe(30 * 60);
    expect(sink.started).toHaveLength(2);
    expect(manager.current?.startedAt).toBe(clock.now());
  });

  it('computes the plan example deterministically', () => {
    const { manager, sink, clock, work, wait, t0 } = setup();
    work(32 * MIN, 20 * SEC); // 09:00–09:32
    wait(13 * MIN); // idle 09:32–09:45
    work(33 * MIN, 20 * SEC); // 09:45–10:18
    manager.onFocusChange(false, clock.now()); // 10:18 loses focus
    wait(4 * MIN);
    manager.onFocusChange(true, clock.now()); // 10:22 returns
    work(42 * MIN, 20 * SEC); // 10:22–11:04
    manager.endSession('window-closed');

    const session = sink.ended[0]!;
    expect(sink.started).toHaveLength(1);
    expect(session.startedAt).toBe(t0);
    expect(session.endedAt).toBe(t0 + 124 * MIN); // 2h 04m
    expect(session.activeSeconds).toBe((32 + 33 + 42) * 60); // 1h 47m active
  });

  it('never credits time while the window is unfocused', () => {
    const { manager, clock, work } = setup();
    work(MIN, 10 * SEC);
    clock.advance(30 * SEC);
    manager.onFocusChange(false, clock.now()); // blur credits the 30 s since the last signal
    clock.advance(3 * MIN);
    manager.activity(clock.now(), ctx()); // ignored while unfocused
    manager.onFocusChange(true, clock.now());
    clock.advance(20 * SEC);
    manager.activity(clock.now(), ctx());
    expect(manager.liveActiveSeconds()).toBe(60 + 30 + 20);
  });

  it('can count unfocused time when configured', () => {
    const { manager, clock } = setup({ pauseWhenUnfocused: false });
    manager.activity(clock.now(), ctx());
    manager.onFocusChange(false, clock.now());
    clock.advance(2 * MIN);
    manager.activity(clock.now(), ctx());
    expect(manager.liveActiveSeconds()).toBe(120);
  });

  it('pauses: ends the session and ignores activity until resumed', () => {
    const { manager, sink, clock, work } = setup();
    work(5 * MIN);
    clock.advance(30 * SEC);
    manager.setEnabled(false, 'paused');
    expect(manager.state).toBe('DISABLED');
    expect(sink.ended[0]?.endReason).toBe('paused');
    expect(sink.ended[0]?.activeSeconds).toBe(5 * 60 + 30);

    clock.advance(MIN);
    manager.activity(clock.now(), ctx());
    expect(manager.current).toBeUndefined();

    manager.setEnabled(true);
    manager.activity(clock.now(), ctx());
    expect(sink.started).toHaveLength(2);
  });

  it('attributes time per language', () => {
    const { manager, clock } = setup();
    manager.activity(clock.now(), ctx({ language: 'typescript' }));
    clock.advance(MIN);
    manager.activity(clock.now(), ctx({ language: 'css' }));
    clock.advance(2 * MIN);
    manager.activity(clock.now(), ctx({ language: 'css' }));
    expect(manager.current?.languages).toEqual({ typescript: 60, css: 120 });
  });

  it('splits the session when editing in another project, but not when only browsing', () => {
    const { manager, sink, clock } = setup();
    manager.activity(clock.now(), ctx({ projectKey: 'frontend' }), { added: 1, removed: 0 });
    clock.advance(MIN);
    manager.activity(clock.now(), ctx({ projectKey: 'backend' })); // navigation only
    expect(sink.started).toHaveLength(1);
    clock.advance(MIN);
    manager.activity(clock.now(), ctx({ projectKey: 'backend' }), { added: 1, removed: 0 });
    expect(sink.ended).toHaveLength(1);
    expect(sink.ended[0]!.projectKey).toBe('frontend');
    expect(sink.ended[0]!.activeSeconds).toBe(120);
    expect(manager.current?.projectKey).toBe('backend');
    expect(manager.current?.startedAt).toBe(clock.now());
  });

  it('does not credit time spent on excluded work', () => {
    const { manager, clock } = setup();
    manager.activity(clock.now(), ctx());
    clock.advance(MIN);
    manager.activity(clock.now(), undefined); // e.g. an excluded language
    clock.advance(2 * MIN);
    manager.activity(clock.now(), undefined);
    clock.advance(30 * SEC);
    manager.activity(clock.now(), ctx());
    expect(manager.liveActiveSeconds()).toBe(60 + 30);
  });

  it('never starts a session from excluded work', () => {
    const { manager, clock } = setup();
    manager.activity(clock.now(), undefined);
    expect(manager.current).toBeUndefined();
  });

  describe('manual mode', () => {
    it('only starts and ends sessions on command', () => {
      const { manager, sink, clock, wait } = setup({ mode: 'manual' });
      manager.activity(clock.now(), ctx());
      expect(manager.current).toBeUndefined();

      expect(manager.startManually(ctx())).toBe(true);
      clock.advance(MIN);
      manager.activity(clock.now(), ctx());
      wait(60 * MIN);
      expect(manager.current).toBeDefined(); // no automatic end
      expect(manager.state).toBe('IDLE');
      manager.endSession('manual');
      expect(sink.ended[0]?.activeSeconds).toBe(60);
      expect(sink.ended[0]?.endReason).toBe('manual');
    });
  });

  it('splits sessions that reach the maximum length', () => {
    const { manager, sink, clock } = setup();
    for (let elapsed = 0; elapsed <= MAX_SESSION_MS + 10 * MIN; elapsed += 4 * MIN) {
      manager.activity(clock.now(), ctx());
      manager.tick();
      clock.advance(4 * MIN);
    }
    expect(sink.ended[0]?.endReason).toBe('max-length');
    const first = sink.ended[0]!;
    expect(first.endedAt! - first.startedAt).toBeLessThanOrEqual(MAX_SESSION_MS);
    expect(sink.started).toHaveLength(2);
  });

  it('closes the session when the clock moves backwards', () => {
    const { manager, sink, clock, t0 } = setup();
    manager.activity(clock.now(), ctx());
    clock.advance(MIN);
    manager.activity(clock.now(), ctx());
    clock.time = t0 - HOUR();
    manager.activity(clock.now(), ctx());
    expect(sink.ended[0]?.endReason).toBe('clock-changed');
    expect(sink.ended[0]!.endedAt).toBe(t0 + MIN);
    expect(sink.ended[0]!.activeSeconds).toBe(60);
  });

  it('never reports negative or excessive durations', () => {
    const { manager, sink, clock } = setup();
    manager.activity(clock.now(), ctx());
    manager.endSession('manual');
    const record = sink.ended[0]!;
    expect(record.endedAt! - record.startedAt).toBe(0);
    expect(record.activeSeconds).toBe(0);
  });

  it('aggregates editor signals into few ACTIVITY events', () => {
    const { sink, work } = setup();
    work(20 * MIN, 5 * SEC, ctx(), true); // 241 signals
    const activity = sink.events.filter((e) => e.type === 'ACTIVITY');
    expect(activity.length).toBeGreaterThanOrEqual(3);
    expect(activity.length).toBeLessThanOrEqual(5);
    expect(activity[0]?.language).toBe('typescript');
  });

  it('emits lifecycle events', () => {
    const { manager, sink, work, wait } = setup();
    work(MIN);
    wait(6 * MIN);
    work(MIN);
    manager.endSession('manual');
    expect(sink.types()).toEqual(
      expect.arrayContaining(['SESSION_STARTED', 'IDLE_STARTED', 'IDLE_ENDED', 'SESSION_ENDED']),
    );
  });

  describe('restart recovery', () => {
    it('resumes a fresh session from the same workspace', () => {
      const first = setup();
      first.work(10 * MIN);
      const persisted = { ...first.manager.current! };

      const clock = new FakeClock(first.clock.now() + 2 * MIN);
      const sink = new RecordingSink();
      const manager = new SessionManager(config, clock, sink, 'window-2');
      manager.setEnabled(true);
      expect(manager.restore(persisted, clock.now())).toBe(true);
      expect(manager.state).toBe('IDLE');
      expect(manager.current?.ownerInstanceId).toBe('window-2');

      clock.advance(MIN);
      manager.activity(clock.now(), ctx());
      clock.advance(MIN);
      manager.activity(clock.now(), ctx());
      // Downtime while VS Code was closed is idle; the previous 10 min are kept.
      expect(manager.current?.clientSessionId).toBe(persisted.clientSessionId);
      expect(manager.liveActiveSeconds()).toBe(10 * 60 + 60);
    });

    it('refuses stale sessions so the caller can close them', () => {
      const first = setup();
      first.work(10 * MIN);
      const persisted = { ...first.manager.current! };
      const manager = new SessionManager(config, new FakeClock(), new RecordingSink(), 'w2');
      manager.setEnabled(true);
      expect(manager.restore(persisted, persisted.lastActivityAt + 3 * 60 * MIN)).toBe(false);
      expect(manager.current).toBeUndefined();
    });
  });
});

function HOUR() {
  return 60 * MIN;
}
