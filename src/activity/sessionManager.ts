import { randomUUID } from 'node:crypto';
import type {
  ActivityEventType,
  EventMetadata,
  ProjectRef,
  SessionRecord,
} from '../storage/storageTypes';
import type { Clock } from '../utils/time';
import { IdleDetector } from './idleDetector';

export type SessionState = 'DISABLED' | 'READY' | 'ACTIVE' | 'IDLE';
export type TrackingMode = 'automatic' | 'manual';

export type EndReason =
  | 'idle-timeout'
  | 'paused'
  | 'manual'
  | 'window-closed'
  | 'project-changed'
  | 'max-length'
  | 'clock-changed'
  | 'recovered'
  | 'disconnected'
  | 'workspace-closed';

/** Upper bound below the server's 24 h limit so sessions are always accepted. */
export const MAX_SESSION_MS = 23 * 60 * 60 * 1000;
/** Length of the window for aggregated ACTIVITY events. */
export const ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
/** How often the owner re-persists an open session so other windows know it is alive. */
export const OWNER_REFRESH_MS = 60 * 1000;

export interface SessionConfig {
  mode: TrackingMode;
  idleThresholdMs: number;
  sessionTimeoutMs: number;
  pauseWhenUnfocused: boolean;
}

/**
 * Where work happens, already resolved by the workspace module and filtered by the privacy layer.
 * `projectKey` and `fileKey` are local identities and are never uploaded.
 */
export interface WorkContext {
  workspaceKey: string;
  projectKey: string | null;
  project: ProjectRef | null;
  language: string | null;
  repository: string | null;
  branch: string | null;
  fileKey?: string;
  fileExtension?: string;
}

export interface SessionSink {
  stateChanged(state: SessionState): void;
  /** The record changed and should be persisted (the caller may debounce). */
  persist(record: SessionRecord, urgent: boolean): void;
  sessionStarted(record: SessionRecord): void;
  sessionEnded(record: SessionRecord): void;
  event(
    type: ActivityEventType,
    at: number,
    record: SessionRecord,
    options?: { language?: string | null; metadata?: EventMetadata },
  ): void;
}

interface ActivityWindow {
  start: number;
  linesAdded: number;
  linesRemoved: number;
  languages: Map<string, number>;
  extensions: Map<string, number>;
  active: boolean;
}

/**
 * The single owner of session transitions:
 *
 *   DISABLED → READY → ACTIVE ⇄ IDLE → (ended) → READY
 *
 * Event handlers elsewhere only report signals; every transition happens here. All times come
 * from the injected clock or the signal, so results are deterministic and testable.
 */
export class SessionManager {
  private stateValue: SessionState = 'DISABLED';
  private session: SessionRecord | undefined;
  private detector: IdleDetector | undefined;
  private context: WorkContext | undefined;
  private files = new Set<string>();
  private focused = true;
  /** True while the latest signals came from excluded work. */
  private inExcluded = false;
  private window: ActivityWindow | undefined;

  constructor(
    private config: SessionConfig,
    private readonly clock: Clock,
    private readonly sink: SessionSink,
    private readonly instanceId: string,
  ) {}

  get state(): SessionState {
    return this.stateValue;
  }

  get current(): SessionRecord | undefined {
    return this.session;
  }

  get isFocused(): boolean {
    return this.focused;
  }

  /** Active seconds credited to the open session so far. */
  liveActiveSeconds(): number {
    return this.session ? Math.floor(this.session.activeSeconds) : 0;
  }

  configure(config: SessionConfig): void {
    this.config = config;
    this.detector?.setThreshold(config.idleThresholdMs);
  }

  /** Tracking enabled (resume) or disabled (pause, disconnected, excluded). */
  setEnabled(enabled: boolean, reason: EndReason = 'paused'): void {
    if (!enabled) {
      if (this.session) this.end(reason, this.clock.now());
      this.transition('DISABLED');
    } else if (this.stateValue === 'DISABLED') {
      this.transition('READY');
    }
  }

  /** A qualifying activity signal. `context` is undefined when the work is excluded. */
  activity(
    at: number,
    context: WorkContext | undefined,
    lines?: { added: number; removed: number },
  ) {
    if (this.stateValue === 'DISABLED') return;
    if (this.config.pauseWhenUnfocused && !this.focused) return;

    if (!context) {
      // Excluded work: credit up to the switch, then never credit the excluded time. Excluded
      // signals do not count as activity, so the tracked session goes idle and ends normally.
      if (this.session && this.detector) {
        if (!this.inExcluded && this.stateValue === 'ACTIVE') this.creditTo(at);
        this.detector.skipUntil(at);
      }
      this.inExcluded = true;
      return;
    }
    this.inExcluded = false;

    if (!this.session) {
      if (this.config.mode === 'automatic') this.start(at, context);
      if (this.session) this.applyLines(context, lines, at);
      return;
    }

    const detector = this.detector!;
    if (at < this.session.lastActivityAt || at < this.session.startedAt) {
      // The clock moved backwards: close what we have and start fresh.
      this.end('clock-changed', this.session.lastActivityAt);
      if (this.config.mode === 'automatic') this.start(at, context);
      return;
    }

    const gap = detector.gapAt(at);
    const tooLong = at - this.session.startedAt > MAX_SESSION_MS;
    if ((this.config.mode === 'automatic' && gap > this.config.sessionTimeoutMs) || tooLong) {
      // Asleep, away, or the session hit its maximum length.
      this.end(tooLong ? 'max-length' : 'idle-timeout', this.session.lastActivityAt);
      this.start(at, context);
      this.applyLines(context, lines, at);
      return;
    }

    const projectChanged =
      lines !== undefined &&
      context.projectKey !== null &&
      context.projectKey !== this.session.projectKey;
    if (projectChanged) {
      // Editing in another project: the server attributes a session to one project.
      this.creditTo(at);
      this.end('project-changed', at);
      this.start(at, context);
      this.applyLines(context, lines, at);
      return;
    }

    if (this.stateValue === 'ACTIVE' && detector.isIdleAt(at)) {
      // The idle check has not run yet (e.g. right after sleep); record the idle period now.
      this.transition('IDLE');
      this.sink.event('IDLE_STARTED', this.session.lastActivityAt, this.session);
      this.flushWindow(at, true);
    }

    if (this.stateValue === 'IDLE') {
      const idleSeconds = Math.round(gap / 1000);
      detector.restartAt(at);
      this.session.lastActivityAt = at;
      this.transition('ACTIVE');
      this.sink.event('IDLE_ENDED', at, this.session, { metadata: { idleSeconds } });
    } else {
      this.creditTo(at);
    }
    this.context = context;
    this.applyLines(context, lines, at);
    this.touch(false);
  }

  onFocusChange(focused: boolean, at: number): void {
    if (focused === this.focused) return;
    if (!focused && this.session && this.stateValue === 'ACTIVE') {
      // Leaving the window is itself an interaction; credit up to now, then stop.
      this.creditTo(at);
      this.touch(false);
    }
    this.focused = focused;
    if (focused && this.config.pauseWhenUnfocused) {
      // Unfocused time is never credited; activity resumes with the next signal.
      this.detector?.skipUntil(at);
    }
  }

  /** Starts a session explicitly (manual mode, or the Start Session command). */
  startManually(context: WorkContext): boolean {
    if (this.stateValue === 'DISABLED' || this.session) return false;
    this.start(this.clock.now(), context);
    return true;
  }

  /** Ends the open session. Returns the ended record, if any. */
  endSession(reason: EndReason): SessionRecord | undefined {
    if (!this.session) return undefined;
    return this.end(reason, this.clock.now());
  }

  /** Periodic evaluation: idle detection, session timeout, aggregation and liveness. */
  tick(now = this.clock.now()): void {
    const session = this.session;
    const detector = this.detector;
    if (!session || !detector) return;

    if (this.stateValue === 'ACTIVE' && detector.isIdleAt(now)) {
      this.transition('IDLE');
      this.sink.event('IDLE_STARTED', session.lastActivityAt, session);
      this.flushWindow(now, true);
      this.touch(true);
    }

    const idleFor = now - session.lastActivityAt;
    if (
      this.stateValue === 'IDLE' &&
      this.config.mode === 'automatic' &&
      idleFor >= this.config.sessionTimeoutMs
    ) {
      this.end('idle-timeout', session.lastActivityAt);
      return;
    }
    if (now - session.startedAt > MAX_SESSION_MS) {
      this.end('max-length', Math.min(now, session.startedAt + MAX_SESSION_MS));
      return;
    }

    this.flushWindow(now, false);
    if (now - session.ownerSeenAt >= OWNER_REFRESH_MS) this.touch(false);
  }

  /** Records a Git commit made during the session. */
  recordCommit(at: number, count = 1): void {
    if (!this.session) return;
    this.session.commits += count;
    this.sink.event('GIT_COMMIT', at, this.session, { metadata: { commitCount: count } });
    this.touch(true);
  }

  /** Updates Git metadata (branch changes) for the open session. */
  updateGit(repository: string | null, branch: string | null): void {
    if (this.context) this.context = { ...this.context, repository, branch };
    if (!this.session) return;
    if (this.session.branch === branch && this.session.repository === repository) return;
    this.session.branch = branch;
    this.session.repository = repository;
    this.touch(false);
  }

  debug(kind: 'started' | 'stopped', debugType: string, at: number): void {
    if (!this.session) return;
    this.sink.event(kind === 'started' ? 'DEBUG_STARTED' : 'DEBUG_STOPPED', at, this.session, {
      metadata: { debugType: debugType.slice(0, 40) },
    });
  }

  /**
   * Adopts a session persisted by this workspace before a reload when it is still fresh;
   * otherwise returns false and the caller finalizes it.
   */
  restore(record: SessionRecord, now: number): boolean {
    if (this.session || this.stateValue === 'DISABLED' || record.endedAt !== null) return false;
    const fresh =
      now >= record.lastActivityAt &&
      now - record.lastActivityAt < this.config.sessionTimeoutMs &&
      now - record.startedAt < MAX_SESSION_MS;
    if (!fresh) return false;
    this.session = { ...record, ownerInstanceId: this.instanceId, ownerSeenAt: now };
    this.detector = new IdleDetector(this.config.idleThresholdMs, record.lastActivityAt);
    this.detector.skipUntil(now);
    this.context = {
      workspaceKey: record.workspaceKey,
      projectKey: record.projectKey,
      project: record.project,
      language: topLanguage(record.languages),
      repository: record.repository,
      branch: record.branch,
    };
    this.files = new Set();
    this.transition('IDLE');
    this.touch(true);
    return true;
  }

  private start(at: number, context: WorkContext): void {
    this.session = {
      schema: 1,
      clientSessionId: randomUUID(),
      ownerInstanceId: this.instanceId,
      ownerSeenAt: at,
      workspaceKey: context.workspaceKey,
      project: context.project,
      projectKey: context.projectKey,
      startedAt: at,
      lastActivityAt: at,
      endedAt: null,
      endReason: null,
      activeSeconds: 0,
      languages: {},
      repository: context.repository,
      branch: context.branch,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      commits: 0,
      revision: 1,
    };
    this.detector = new IdleDetector(this.config.idleThresholdMs, at);
    this.context = context;
    this.files = new Set();
    this.window = undefined;
    this.transition('ACTIVE');
    this.sink.sessionStarted(this.session);
    this.sink.event('SESSION_STARTED', at, this.session, { language: context.language });
    this.sink.persist(this.session, true);
  }

  private end(reason: EndReason, endAt: number): SessionRecord {
    const session = this.session!;
    if (this.stateValue === 'ACTIVE' && this.detector && endAt >= session.lastActivityAt) {
      this.creditTo(endAt);
    }
    const endedAt = Math.max(
      session.startedAt,
      Math.min(endAt, session.startedAt + MAX_SESSION_MS),
    );
    this.flushWindow(endedAt, true);
    session.endedAt = endedAt;
    session.lastActivityAt = Math.min(session.lastActivityAt, endedAt);
    session.activeSeconds = Math.min(
      Math.round(session.activeSeconds),
      Math.floor((endedAt - session.startedAt) / 1000),
    );
    session.endReason = reason;
    session.revision += 1;
    session.ownerSeenAt = this.clock.now();
    this.sink.event('SESSION_ENDED', endedAt, session, { metadata: { reason } });
    this.sink.persist(session, true);
    this.sink.sessionEnded(session);
    this.session = undefined;
    this.detector = undefined;
    this.window = undefined;
    if (this.stateValue !== 'DISABLED') this.transition('READY');
    return session;
  }

  /** Credits active time up to `at` to the current language. */
  private creditTo(at: number): void {
    const session = this.session;
    const detector = this.detector;
    if (!session || !detector) return;
    const creditedMs = detector.record(at);
    session.lastActivityAt = Math.max(session.lastActivityAt, detector.lastActivityAt);
    if (creditedMs <= 0) return;
    const seconds = creditedMs / 1000;
    session.activeSeconds += seconds;
    const language = this.context?.language;
    if (language) session.languages[language] = (session.languages[language] ?? 0) + seconds;
    const window = this.ensureWindow(at);
    window.active = true;
    if (language) window.languages.set(language, (window.languages.get(language) ?? 0) + seconds);
    const extension = this.context?.fileExtension;
    if (extension)
      window.extensions.set(extension, (window.extensions.get(extension) ?? 0) + seconds);
  }

  private applyLines(
    context: WorkContext,
    lines: { added: number; removed: number } | undefined,
    at: number,
  ): void {
    const session = this.session;
    if (!session || !lines) return;
    session.linesAdded += lines.added;
    session.linesRemoved += lines.removed;
    if (context.fileKey && !this.files.has(context.fileKey)) {
      this.files.add(context.fileKey);
      session.filesChanged += 1;
    }
    const window = this.ensureWindow(at);
    window.linesAdded += lines.added;
    window.linesRemoved += lines.removed;
    window.active = true;
  }

  private ensureWindow(at: number): ActivityWindow {
    if (!this.window) {
      this.window = {
        start: at,
        linesAdded: 0,
        linesRemoved: 0,
        languages: new Map(),
        extensions: new Map(),
        active: false,
      };
    }
    return this.window;
  }

  /** Emits one aggregated ACTIVITY event per window instead of one per editor signal. */
  private flushWindow(now: number, force: boolean): void {
    const window = this.window;
    const session = this.session;
    if (!window || !session) return;
    if (!force && now - window.start < ACTIVITY_WINDOW_MS) return;
    this.window = undefined;
    if (!window.active) return;
    const metadata: EventMetadata = {};
    if (window.linesAdded > 0) metadata.linesAdded = window.linesAdded;
    if (window.linesRemoved > 0) metadata.linesRemoved = window.linesRemoved;
    const extension = topKey(window.extensions);
    if (extension) metadata.fileExtension = extension;
    this.sink.event('ACTIVITY', window.start, session, {
      language: topKey(window.languages) ?? this.context?.language ?? null,
      metadata,
    });
  }

  private touch(urgent: boolean): void {
    const session = this.session;
    if (!session) return;
    session.revision += 1;
    session.ownerSeenAt = this.clock.now();
    this.sink.persist(session, urgent);
  }

  private transition(next: SessionState): void {
    if (next === this.stateValue) return;
    this.stateValue = next;
    this.sink.stateChanged(next);
  }
}

function topKey(values: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestValue = -1;
  for (const [key, value] of values) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

export function topLanguage(languages: Record<string, number>): string | null {
  return topKey(new Map(Object.entries(languages))) ?? null;
}
