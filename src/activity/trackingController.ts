import * as vscode from 'vscode';
import type { AuthManager } from '../auth/authManager';
import type { GitManager } from '../git/gitManager';
import type { PrivacyManager, WorkInput } from '../privacy/privacyManager';
import type { SettingsManager } from '../settings/settingsManager';
import { DEFAULT_IDLE_THRESHOLD_MINUTES } from '../settings/settingsTypes';
import type { SessionPersister } from '../storage/sessionPersister';
import type { SessionStore } from '../storage/sessionStore';
import type { StateStore } from '../storage/stateStore';
import type { SessionRecord } from '../storage/storageTypes';
import type { EventRecorder } from '../sync/eventRecorder';
import type { Logger } from '../utils/logger';
import { MINUTE, type Clock } from '../utils/time';
import type { WorkspaceManager } from '../workspace/workspaceManager';
import { ActivityTracker } from './activityTracker';
import type { ActivitySignal } from './activityTypes';
import {
  SessionManager,
  type EndReason,
  type SessionConfig,
  type SessionState,
} from './sessionManager';

/** How often idle detection, session timeouts and liveness are evaluated. */
const TICK_MS = 15_000;

export type TrackingStatus =
  'not-connected' | 'needs-reconnect' | 'disabled' | 'paused' | 'ready' | 'active' | 'idle';

export interface TrackingSnapshot {
  status: TrackingStatus;
  sessionState: SessionState;
  mode: 'automatic' | 'manual';
  session: SessionRecord | undefined;
  /** Where the user is working now (may differ from the session while browsing). */
  projectName: string | undefined;
  languageId: string | undefined;
  branch: string | undefined;
  excluded: boolean;
  idleThresholdMinutes: number;
  limitations: string[];
}

export interface TrackingDeps {
  settings: SettingsManager;
  state: StateStore;
  auth: AuthManager;
  workspace: WorkspaceManager;
  git: GitManager;
  privacy: PrivacyManager;
  sessions: SessionStore;
  persister: SessionPersister;
  recorder: EventRecorder;
  clock: Clock;
  logger: Logger;
  instanceId: string;
  /** Asks the sync scheduler to upload soon (e.g. after a session ended). */
  requestSync: () => void;
}

/**
 * Connects the activity tracker, workspace and Git detection, the privacy layer and the session
 * engine, and persists what they produce. It is the only place those modules meet.
 */
export class TrackingController implements vscode.Disposable {
  private readonly manager: SessionManager;
  private readonly tracker: ActivityTracker;
  private readonly emitter = new vscode.EventEmitter<TrackingSnapshot>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastInput: WorkInput | undefined;
  private excludedNow = false;

  readonly onDidChange = this.emitter.event;

  constructor(private readonly deps: TrackingDeps) {
    this.manager = new SessionManager(
      this.sessionConfig(),
      deps.clock,
      this.sink(),
      deps.instanceId,
    );
    this.tracker = new ActivityTracker(
      {
        onSignal: (signal) => this.onSignal(signal),
        onFocusChange: (focused, at) => {
          this.manager.onFocusChange(focused, at);
          this.fire();
        },
        onDebug: (transition) =>
          this.manager.debug(transition.kind, transition.debugType, transition.at),
      },
      deps.clock,
      () => deps.settings.settings.privacy,
    );
  }

  get snapshot(): TrackingSnapshot {
    const session = this.manager.current;
    const snapshot = this.deps.workspace.snapshot;
    const limitations: string[] = [];
    if (snapshot.kind === 'virtual') {
      limitations.push('Virtual workspace: Git metadata is unavailable.');
    }
    if (snapshot.kind === 'remote') {
      limitations.push(`Remote workspace (${snapshot.remoteName ?? 'remote'}): tracked remotely.`);
    }
    if (!snapshot.trusted) limitations.push('Untrusted workspace: Git metadata is disabled.');
    if (this.deps.git.availability === 'unavailable') {
      limitations.push('The built-in Git extension is unavailable: Git metadata is disabled.');
    }
    return {
      status: this.status(),
      sessionState: this.manager.state,
      mode: this.deps.settings.settings.tracking.mode,
      session: session
        ? { ...session, activeSeconds: this.manager.liveActiveSeconds() }
        : undefined,
      projectName: this.lastInput?.project?.name,
      languageId: this.lastInput?.activity?.languageId,
      branch: this.lastInput?.branch,
      excluded: this.excludedNow,
      idleThresholdMinutes: this.idleThresholdMinutes(),
      limitations,
    };
  }

  get isPaused(): boolean {
    return this.deps.state.getGlobal('devpulse.trackingPaused') === true;
  }

  async start(): Promise<void> {
    const { settings, workspace, git, auth } = this.deps;
    this.tracker.start();
    this.manager.onFocusChange(this.tracker.windowFocused, this.deps.clock.now());
    this.disposables.push(
      this.tracker,
      settings.onDidChange(() => this.reconfigure()),
      auth.onDidChange(() => this.reconfigure()),
      workspace.onDidChange(({ removed }) => this.onFoldersChanged(removed)),
      git.onDidChange(() => this.refreshGit()),
      git.onDidCommit(({ count }) => this.onCommit(count)),
    );
    this.applyEnabled();
    await this.restore();
    await this.configureGit();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.fire();
  }

  // ------------------------------------------------------------------ commands

  async pause(): Promise<void> {
    await this.deps.state.setGlobal('devpulse.trackingPaused', true);
    // Ends the open session; signals are ignored until tracking resumes.
    this.applyEnabled();
    this.fire();
  }

  async resume(): Promise<void> {
    await this.deps.state.setGlobal('devpulse.trackingPaused', undefined);
    this.applyEnabled();
    this.fire();
  }

  /** Starts a session now. Returns a message when it cannot. */
  startSession(): string | undefined {
    const status = this.status();
    if (status === 'not-connected' || status === 'needs-reconnect') {
      return 'Connect DevPulse before starting a session.';
    }
    if (status === 'paused' || status === 'disabled') return 'Tracking is paused.';
    if (this.manager.current) return 'A coding session is already running.';
    const input = this.inputFor(this.tracker.activeContext());
    const context = this.deps.privacy.workContext(input);
    if (!context) return 'The current project or language is excluded from tracking.';
    this.lastInput = input;
    this.manager.startManually(context);
    this.fire();
    return undefined;
  }

  endSession(reason: EndReason = 'manual'): SessionRecord | undefined {
    const ended = this.manager.endSession(reason);
    this.fire();
    return ended;
  }

  /** The server ended our open session (another window took over); start fresh next time. */
  onSessionSuperseded(clientSessionId: string): void {
    if (this.manager.current?.clientSessionId === clientSessionId) {
      this.deps.logger.info('The server ended the current session; a new one will start');
      this.manager.endSession('recovered');
      this.fire();
    }
  }

  /** Name of the project the user is working in, for the exclusion command. */
  currentProjectName(): string | undefined {
    return (
      this.deps.workspace.projectFor(this.tracker.activeContext())?.name ??
      this.lastInput?.project?.name
    );
  }

  /** Called on deactivate: persist everything without ending the session, so a reload resumes. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const session = this.manager.current;
    if (session)
      this.deps.persister.persist({ ...session, ownerSeenAt: this.deps.clock.now() }, true);
    await Promise.all([this.deps.persister.flush(), this.deps.recorder.flush()]);
  }

  // ------------------------------------------------------------------ internals

  private status(): TrackingStatus {
    const { settings, auth } = this.deps;
    if (auth.authState === 'NOT_CONNECTED' || auth.authState === 'PAIRING') return 'not-connected';
    if (auth.authState !== 'CONNECTED') return 'needs-reconnect';
    if (!settings.settings.enabled) return 'disabled';
    if (this.isPaused || !settings.settings.tracking.enabled) return 'paused';
    switch (this.manager.state) {
      case 'ACTIVE':
        return 'active';
      case 'IDLE':
        return 'idle';
      default:
        return 'ready';
    }
  }

  private recordingAllowed(): boolean {
    const status = this.status();
    return status === 'ready' || status === 'active' || status === 'idle';
  }

  private applyEnabled(): void {
    const allowed = this.recordingAllowed();
    if (allowed) {
      this.manager.setEnabled(true);
      return;
    }
    const status = this.status();
    const reason: EndReason =
      status === 'paused' || status === 'disabled' ? 'paused' : 'disconnected';
    this.manager.setEnabled(false, reason);
  }

  private idleThresholdMinutes(): number {
    return (
      this.deps.settings.settings.tracking.idleThresholdMinutes ??
      this.deps.state.getGlobal('devpulse.serverConfig')?.idleTimeoutMinutes ??
      DEFAULT_IDLE_THRESHOLD_MINUTES
    );
  }

  private sessionConfig(): SessionConfig {
    const tracking = this.deps.settings.settings.tracking;
    const idle = this.idleThresholdMinutes();
    return {
      mode: tracking.mode,
      idleThresholdMs: idle * MINUTE,
      sessionTimeoutMs: Math.max(tracking.sessionTimeoutMinutes, idle) * MINUTE,
      pauseWhenUnfocused: tracking.pauseWhenUnfocused,
    };
  }

  private reconfigure(): void {
    this.manager.configure(this.sessionConfig());
    this.applyEnabled();
    void this.configureGit();
    this.fire();
  }

  private async configureGit(): Promise<void> {
    const privacy = this.deps.settings.settings.privacy;
    const snapshot = this.deps.workspace.snapshot;
    await this.deps.git.configure({
      enabled: privacy.trackGit || privacy.trackRepository,
      trusted: snapshot.trusted,
      virtual: snapshot.kind === 'virtual',
    });
  }

  private inputFor(activity: ActivitySignal['context']): WorkInput {
    const project = this.deps.workspace.projectFor(activity);
    return {
      workspaceKey: this.deps.workspace.snapshot.key,
      activity,
      project,
      branch: this.deps.git.infoFor(project?.folderUri).branch,
    };
  }

  private onSignal(signal: ActivitySignal): void {
    if (!this.recordingAllowed()) return;
    const input = this.inputFor(signal.context);
    const context = this.deps.privacy.workContext(input);
    this.excludedNow = context === undefined;
    this.lastInput = input;
    const lines =
      signal.kind === 'edit'
        ? { added: signal.linesAdded ?? 0, removed: signal.linesRemoved ?? 0 }
        : undefined;
    const before = this.manager.state;
    this.manager.activity(signal.at, context, lines);
    if (this.manager.state !== before) this.fire();
  }

  private onCommit(count: number): void {
    if (!this.recordingAllowed() || !this.deps.privacy.policy.gitActivity) return;
    const now = this.deps.clock.now();
    if (this.manager.current) {
      this.manager.recordCommit(now, count);
    } else {
      this.deps.recorder.record('GIT_COMMIT', now, undefined, { metadata: { commitCount: count } });
    }
  }

  private refreshGit(): void {
    if (!this.lastInput) return;
    this.lastInput = this.inputFor(this.lastInput.activity);
    const context = this.deps.privacy.workContext(this.lastInput);
    if (context) this.manager.updateGit(context.repository, context.branch);
    this.fire();
  }

  private onFoldersChanged(removed: string[]): void {
    const session = this.manager.current;
    if (session && removed.length > 0) {
      const stillOpen = this.deps.workspace.snapshot.folders.some(
        (folder) => this.deps.workspace.projectForFolder(folder.uri)?.key === session.projectKey,
      );
      if (!stillOpen && session.projectKey !== null) this.manager.endSession('workspace-closed');
    }
    void this.configureGit();
    this.fire();
  }

  private tick(): void {
    // Pause state is shared by all windows through globalState.
    const allowedBefore = this.manager.state !== 'DISABLED';
    if (allowedBefore !== this.recordingAllowed()) this.applyEnabled();
    this.manager.tick();
    this.fire();
  }

  /** Resumes this workspace's session after a reload, or closes it if it is stale. */
  private async restore(): Promise<void> {
    const id = this.deps.state.getWorkspace('devpulse.currentSessionId');
    if (!id) return;
    const record = await this.deps.sessions.loadRecord(id);
    if (!record || record.endedAt !== null) {
      await this.deps.state.setWorkspace('devpulse.currentSessionId', undefined);
      return;
    }
    const now = this.deps.clock.now();
    if (this.manager.restore(record, now)) {
      this.deps.logger.info('Resumed the previous coding session');
      return;
    }
    await this.deps.sessions.saveRecord({
      ...record,
      endedAt: Math.max(record.startedAt, record.lastActivityAt),
      endReason: 'recovered',
      ownerInstanceId: this.deps.instanceId,
      ownerSeenAt: now,
      revision: record.revision + 1,
    });
    await this.deps.state.setWorkspace('devpulse.currentSessionId', undefined);
    this.deps.requestSync();
  }

  private sink() {
    return {
      stateChanged: () => this.fire(),
      persist: (record: SessionRecord, urgent: boolean) =>
        this.deps.persister.persist(record, urgent),
      sessionStarted: (record: SessionRecord) => {
        void this.deps.state.setWorkspace('devpulse.currentSessionId', record.clientSessionId);
        this.deps.requestSync();
      },
      sessionEnded: () => {
        void this.deps.state.setWorkspace('devpulse.currentSessionId', undefined);
        void this.deps.persister.flush().then(() => this.deps.recorder.flush());
        this.deps.requestSync();
      },
      event: (
        type: Parameters<EventRecorder['record']>[0],
        at: number,
        record: SessionRecord,
        options?: Parameters<EventRecorder['record']>[3],
      ) => {
        if (!this.recordingAllowed() && type !== 'SESSION_ENDED') return;
        this.deps.recorder.record(type, at, record.clientSessionId, options);
      },
    };
  }

  private fire(): void {
    this.emitter.fire(this.snapshot);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.emitter.dispose();
  }
}
