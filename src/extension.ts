import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { TrackingController } from './activity/trackingController';
import { AccountFlows } from './auth/accountFlows';
import { AuthManager } from './auth/authManager';
import { CredentialStore } from './auth/credentialStore';
import { Commands } from './commands';
import { DeviceManager, validateDeviceName } from './devices/deviceManager';
import { GitManager } from './git/gitManager';
import { PrivacyManager } from './privacy/privacyManager';
import { SettingsManager } from './settings/settingsManager';
import { SessionPersister } from './storage/sessionPersister';
import { createStorage } from './storage/storage';
import { ApiClient } from './sync/apiClient';
import { isApiError, type ApiError } from './sync/apiErrors';
import { EventRecorder } from './sync/eventRecorder';
import { RetryManager } from './sync/retryManager';
import { SyncEngine } from './sync/syncEngine';
import { SyncScheduler } from './sync/syncScheduler';
import { ACTIVITY_VIEW_ID, ActivityViewProvider } from './ui/activityView';
import { AppState } from './ui/appState';
import { DashboardPanel } from './ui/dashboardView';
import { showQuickMenu } from './ui/quickMenu';
import { StatusBar } from './ui/statusBar';
import { DisposableStore } from './utils/disposables';
import { RedactingLogger } from './utils/logger';
import { HOUR, MINUTE, SECOND, systemClock } from './utils/time';
import { checkServerUrl } from './utils/url';
import { WorkspaceManager } from './workspace/workspaceManager';

let services: DisposableStore | undefined;
let shutdown: (() => Promise<void>) | undefined;

/**
 * Wires the extension's modules together. Each module owns its behaviour; this function only
 * creates them in dependency order, connects their events and registers commands. Nothing
 * expensive runs synchronously here.
 */
export function activate(context: vscode.ExtensionContext): void {
  const store = new DisposableStore();
  services = store;
  const version = String(context.extension.packageJSON.version);
  const clock = systemClock;

  // 1. Configuration and logging.
  const output = store.add(vscode.window.createOutputChannel('DevPulse'));
  const logger = new RedactingLogger(output);
  const settings = store.add(new SettingsManager());
  logger.configure(settings.settings.logging);
  store.add(settings.onDidChange((next) => logger.configure(next.logging)));

  // 2. Storage. The instance id identifies this window when coordinating shared files.
  const instanceId = randomUUID();
  const storage = createStorage(context, instanceId, clock);

  // 3. Authentication and API client.
  const baseUrl = () => settings.settings.connection.baseUrl;
  const urlCheck = () => checkServerUrl(baseUrl(), settings.settings.connection.allowInsecureHttp);
  const auth = new AuthManager(storage.credentials, storage.state, clock, logger, baseUrl);
  const api = new ApiClient({
    baseUrl: urlCheck,
    credential: () => auth.credentialFor(baseUrl()),
    userAgent: `DevPulse-VSCode/${version} (${vscode.env.appName} ${vscode.version}; ${process.platform})`,
    logger,
  });

  // 4. Workspace, Git and privacy.
  const workspace = store.add(new WorkspaceManager());
  const git = store.add(new GitManager(logger));
  workspace.setRepositoryLookup(git);
  const privacy = new PrivacyManager(
    () => settings.settings,
    () => storage.state.getGlobal('devpulse.serverConfig'),
    os.homedir(),
  );

  // 5. Recording and synchronization.
  const persister = new SessionPersister(storage.sessions, logger);
  store.add(persister);
  const recorder = new EventRecorder(storage.queue, logger);
  // The scheduler depends on the tracker's callbacks, so it is created afterwards.
  const schedulerRef: { current?: SyncScheduler } = {};
  const tracking = store.add(
    new TrackingController({
      settings,
      state: storage.state,
      auth,
      workspace,
      git,
      privacy,
      sessions: storage.sessions,
      persister,
      recorder,
      clock,
      logger,
      instanceId,
      requestSync: () => schedulerRef.current?.trigger(),
    }),
  );

  const onAuthError = async (error: ApiError) => {
    if (!(await auth.handleApiError(error))) return;
    void vscode.window
      .showWarningMessage(
        'DevPulse was disconnected from your account (the device was revoked). Unsynced activity is kept on this computer until you reconnect.',
        'Reconnect',
      )
      .then((action) => {
        if (action) void vscode.commands.executeCommand(Commands.reconnect);
      });
  };

  const engine = new SyncEngine({
    api,
    sessions: storage.sessions,
    queue: storage.queue,
    retry: new RetryManager(clock),
    privacy,
    clock,
    logger,
    instanceId,
    canSync: () => auth.isConnected && settings.settings.enabled && urlCheck().ok,
    onAuthError,
    onSessionSuperseded: (id) => tracking.onSessionSuperseded(id),
    heartbeatIntervalMs: () =>
      (storage.state.getGlobal('devpulse.serverConfig')?.heartbeatIntervalSeconds ?? 60) * SECOND,
  });

  const devices = new DeviceManager(api, auth, storage.state, clock, logger);

  const refreshConfig = async () => {
    if (!auth.isConnected) return;
    try {
      const { data } = await api.integrations.config();
      await auth.saveConfig(data.config);
      if (data.device.name !== auth.device?.deviceName)
        await auth.updateDeviceName(data.device.name);
    } catch (error) {
      if (isApiError(error)) await onAuthError(error);
      throw error;
    }
  };

  const sync = new SyncScheduler(
    engine,
    () => settings.settings.syncIntervalSeconds * SECOND,
    [
      { name: 'config', everyMs: 3 * HOUR, run: refreshConfig },
      { name: 'summary', everyMs: 5 * MINUTE, run: () => devices.refreshSummary() },
      {
        name: 'prune',
        everyMs: 12 * HOUR,
        run: async () => {
          const dropped = await storage.sessions.prune(clock.now());
          if (dropped > 0)
            logger.warn(`Dropped ${dropped} unsynced sessions to bound local storage`);
        },
      },
    ],
    logger,
  );
  schedulerRef.current = sync;
  store.add(sync);

  // 6. Account flows.
  const account = new AccountFlows(auth, api, settings, storage.state, logger, version, {
    onConnected: async () => {
      engine.refreshStatus();
      sync.invalidate('config');
      sync.invalidate('summary');
      sync.trigger(0);
    },
    prepareDisconnect: async () => {
      tracking.endSession('disconnected');
      await Promise.all([persister.flush(), recorder.flush()]);
      const result = await engine.sync({ force: true });
      return result.pendingEvents + result.pendingSessions;
    },
    discardUnsynced: async () => {
      recorder.discard();
      await storage.queue.clear();
      await storage.sessions.clearAll();
    },
  });

  // Another window connected/disconnected, or connection settings changed.
  store.add(
    context.secrets.onDidChange((event) => {
      if (!CredentialStore.isCredentialKey(event.key)) return;
      storage.credentials.invalidate();
      void auth.initialize().then(() => engine.refreshStatus());
    }),
  );
  store.add(settings.onDidChange(() => void auth.initialize().then(() => engine.refreshStatus())));

  // 7. User interface.
  const appState = store.add(
    new AppState({
      auth,
      tracking,
      sync: engine,
      settings,
      state: storage.state,
      sessions: storage.sessions,
      queue: storage.queue,
      clock,
      logger,
    }),
  );
  store.add(new StatusBar(appState, settings));
  const activityView = store.add(new ActivityViewProvider(appState));
  store.add(vscode.window.createTreeView(ACTIVITY_VIEW_ID, { treeDataProvider: activityView }));
  const dashboard = store.add(new DashboardPanel(appState));

  // 8. Commands.
  const register = (id: string, handler: () => unknown) =>
    store.add(vscode.commands.registerCommand(id, handler));
  register(Commands.connect, () => account.connect());
  register(Commands.reconnect, () => account.connect());
  register(Commands.disconnect, () => account.disconnect());
  register(Commands.pauseTracking, async () => {
    await tracking.pause();
    void vscode.window.showInformationMessage('DevPulse tracking paused.');
  });
  register(Commands.resumeTracking, async () => {
    await tracking.resume();
    void vscode.window.showInformationMessage('DevPulse tracking resumed.');
  });
  register(Commands.startSession, () => {
    const problem = tracking.startSession();
    if (problem) void vscode.window.showWarningMessage(problem);
  });
  register(Commands.endSession, () => {
    if (!tracking.endSession('manual')) {
      void vscode.window.showInformationMessage('No coding session is running.');
    }
  });
  register(Commands.syncNow, async () => {
    await Promise.all([persister.flush(), recorder.flush()]);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'DevPulse: syncing…' },
      () => sync.syncNow(),
    );
    const show = result.ok
      ? vscode.window.showInformationMessage
      : vscode.window.showWarningMessage;
    void show(result.ok ? result.message : `DevPulse sync failed: ${result.message}`);
  });
  register(Commands.clearQueue, async () => {
    const { events } = await storage.queue.stats();
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${events} locally queued ${events === 1 ? 'event' : 'events'}?`,
      {
        modal: true,
        detail:
          'This deletes locally queued events that have not been synchronized yet. Data already synchronized stays in your DevPulse account.',
      },
      'Delete Queue',
    );
    if (confirm !== 'Delete Queue') return;
    recorder.discard();
    const removed = await storage.queue.clear();
    void vscode.window.showInformationMessage(`Deleted ${removed} queued events.`);
  });
  register(Commands.excludeProject, async () => {
    const name = tracking.currentProjectName();
    if (!name) {
      void vscode.window.showInformationMessage('Open a project folder to exclude it.');
      return;
    }
    const current = settings.settings.exclusions.projects;
    if (!current.some((item) => item.toLowerCase() === name.toLowerCase())) {
      await settings.update('exclusions.projects', [...current, name]);
    }
    tracking.endSession('paused');
    void vscode.window.showInformationMessage(`"${name}" is excluded from DevPulse tracking.`);
  });
  register(Commands.renameDevice, async () => {
    const name = await vscode.window.showInputBox({
      title: 'Rename DevPulse Device',
      prompt: 'This name is shown on the Devices page of the DevPulse web app.',
      value: auth.device?.deviceName ?? '',
      validateInput: validateDeviceName,
    });
    if (name === undefined) return;
    const result = await devices.rename(name);
    if (result.ok) {
      void vscode.window.showInformationMessage(`Device renamed to "${result.name}".`);
    } else if (result.reason === 'unsupported') {
      const action = await vscode.window.showWarningMessage(result.message, 'Open Devices');
      if (action) await account.openWeb('/devices');
    } else {
      void vscode.window.showWarningMessage(result.message);
    }
  });
  register(Commands.showMenu, () => showQuickMenu(appState));
  register(Commands.openDashboard, () => account.openWeb('/dashboard'));
  register(Commands.openMiniDashboard, () => dashboard.show());
  register(Commands.openActivity, () =>
    vscode.commands.executeCommand('workbench.view.extension.devpulse'),
  );
  register(Commands.openSettings, () => settings.open());
  register(Commands.showLogs, () => output.show(true));

  // 9. Start: restore state, then begin tracking and syncing in the background.
  shutdown = () => tracking.shutdown();
  void (async () => {
    await storage.queue.recoverStaleClaims().catch((error: unknown) => {
      logger.warn('Could not recover queued events', error);
    });
    await auth.initialize();
    engine.refreshStatus();
    await tracking.start();
    appState.start();
    sync.start();
    await account.showWelcomeIfNeeded();
  })().catch((error: unknown) => logger.error('DevPulse failed to start', error));

  logger.info(`DevPulse ${version} activated`);
}

export async function deactivate(): Promise<void> {
  try {
    await shutdown?.();
  } finally {
    services?.dispose();
    services = undefined;
    shutdown = undefined;
  }
}
