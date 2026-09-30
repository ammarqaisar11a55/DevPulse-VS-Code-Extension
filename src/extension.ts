import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { AccountFlows } from './auth/accountFlows';
import { AuthManager } from './auth/authManager';
import { CredentialStore } from './auth/credentialStore';
import { Commands } from './commands';
import { SettingsManager } from './settings/settingsManager';
import { createStorage } from './storage/storage';
import { ApiClient } from './sync/apiClient';
import { DisposableStore } from './utils/disposables';
import { RedactingLogger } from './utils/logger';
import { systemClock } from './utils/time';
import { checkServerUrl } from './utils/url';

let services: DisposableStore | undefined;

/**
 * Wires the extension's modules together. Each module owns its own behaviour; this function only
 * creates them in dependency order and registers commands. Nothing expensive runs here.
 */
export function activate(context: vscode.ExtensionContext): void {
  const store = new DisposableStore();
  services = store;
  const version = String(context.extension.packageJSON.version);

  // Configuration and logging.
  const output = store.add(vscode.window.createOutputChannel('DevPulse'));
  const logger = new RedactingLogger(output);
  const settings = store.add(new SettingsManager());
  logger.configure(settings.settings.logging);
  store.add(settings.onDidChange((next) => logger.configure(next.logging)));

  // Storage. The instance id identifies this window when coordinating the shared queue.
  const instanceId = randomUUID();
  const storage = createStorage(context, instanceId, systemClock);
  void storage.queue
    .recoverStaleClaims()
    .catch((error: unknown) => logger.warn('Could not recover queued events', error));

  // Authentication and API.
  const baseUrl = () => settings.settings.connection.baseUrl;
  const auth = new AuthManager(storage.credentials, storage.state, systemClock, logger, baseUrl);
  const api = new ApiClient({
    baseUrl: () => checkServerUrl(baseUrl(), settings.settings.connection.allowInsecureHttp),
    credential: () => auth.credentialFor(baseUrl()),
    userAgent: `DevPulse-VSCode/${version} (${vscode.env.appName} ${vscode.version}; ${process.platform})`,
    logger,
  });
  const account = new AccountFlows(auth, api, settings, storage.state, logger, version, {
    onConnected: async () => undefined,
    prepareDisconnect: async () => 0,
    discardUnsynced: async () => undefined,
  });

  // Another window connected or disconnected, or the server URL changed.
  store.add(
    context.secrets.onDidChange((event) => {
      if (!CredentialStore.isCredentialKey(event.key)) return;
      storage.credentials.invalidate();
      void auth.initialize();
    }),
  );
  store.add(
    settings.onDidChange(() => {
      void auth.initialize();
    }),
  );

  const register = (id: string, handler: () => unknown) =>
    store.add(vscode.commands.registerCommand(id, handler));
  register(Commands.connect, () => account.connect());
  register(Commands.reconnect, () => account.connect());
  register(Commands.disconnect, () => account.disconnect());
  register(Commands.openSettings, () => settings.open());
  register(Commands.showLogs, () => output.show(true));

  void auth.initialize().then(() => account.showWelcomeIfNeeded());
  logger.info(`DevPulse ${version} activated`);
}

export function deactivate(): void {
  services?.dispose();
  services = undefined;
}
