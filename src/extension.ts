import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { Commands } from './commands';
import { SettingsManager } from './settings/settingsManager';
import { createStorage } from './storage/storage';
import { DisposableStore } from './utils/disposables';
import { RedactingLogger } from './utils/logger';
import { systemClock } from './utils/time';

let services: DisposableStore | undefined;

/**
 * Wires the extension's modules together. Each module owns its own behaviour; this function only
 * creates them in dependency order and registers commands. Nothing expensive runs here.
 */
export function activate(context: vscode.ExtensionContext): void {
  const store = new DisposableStore();
  services = store;

  const output = store.add(vscode.window.createOutputChannel('DevPulse'));
  const logger = new RedactingLogger(output);
  const settings = store.add(new SettingsManager());
  logger.configure(settings.settings.logging);
  store.add(settings.onDidChange((next) => logger.configure(next.logging)));

  // Identifies this window; used to coordinate the shared queue between VS Code windows.
  const instanceId = randomUUID();
  const storage = createStorage(context, instanceId, systemClock);
  void storage.queue
    .recoverStaleClaims()
    .catch((error: unknown) => logger.warn('Could not recover queued events', error));

  store.add(vscode.commands.registerCommand(Commands.openSettings, () => settings.open()));
  store.add(vscode.commands.registerCommand(Commands.showLogs, () => output.show(true)));

  logger.info(`DevPulse ${String(context.extension.packageJSON.version)} activated`);
}

export function deactivate(): void {
  services?.dispose();
  services = undefined;
}
