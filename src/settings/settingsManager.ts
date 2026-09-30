import * as vscode from 'vscode';
import { readSettings } from './readSettings';
import type { ConfigurationReader, DevPulseSettings } from './settingsTypes';

const SECTION = 'devpulse';

function vscodeReader(): ConfigurationReader {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    get: (key) => config.get(key),
    isExplicitlySet: (key) => {
      const inspected = config.inspect(key);
      return (
        inspected?.globalValue !== undefined ||
        inspected?.workspaceValue !== undefined ||
        inspected?.workspaceFolderValue !== undefined
      );
    },
  };
}

/** Holds the current DevPulse settings and notifies listeners when they change. */
export class SettingsManager implements vscode.Disposable {
  private current: DevPulseSettings;
  private readonly emitter = new vscode.EventEmitter<DevPulseSettings>();
  private readonly subscription: vscode.Disposable;

  readonly onDidChange = this.emitter.event;

  constructor() {
    this.current = readSettings(vscodeReader());
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(SECTION)) return;
      this.current = readSettings(vscodeReader());
      this.emitter.fire(this.current);
    });
  }

  get settings(): DevPulseSettings {
    return this.current;
  }

  /** Writes a user-level setting (never workspace-level, so it follows the user). */
  async update(key: string, value: unknown): Promise<void> {
    await vscode.workspace
      .getConfiguration(SECTION)
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  open(): Thenable<unknown> {
    return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId()}`);
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

export function extensionId(): string {
  return 'ammarqaisar11a55.devpulse';
}
