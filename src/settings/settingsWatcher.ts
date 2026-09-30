import * as vscode from 'vscode';
import { Commands } from '../commands';
import { checkServerUrl } from '../utils/url';
import type { SettingsManager } from './settingsManager';
import type { DevPulseSettings } from './settingsTypes';

/**
 * Reacts to setting changes that need the user's attention: an invalid or insecure server URL,
 * or a new server URL that the paired device credential is not valid for.
 */
export class SettingsWatcher implements vscode.Disposable {
  private previous: DevPulseSettings;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly settings: SettingsManager,
    private readonly isPaired: () => boolean,
  ) {
    this.previous = settings.settings;
    this.subscription = settings.onDidChange((next) => this.onChange(next));
  }

  /** Warns once at startup if the configured URL cannot be used. */
  checkInitial(): void {
    this.validate(this.settings.settings);
  }

  private onChange(next: DevPulseSettings): void {
    const before = this.previous;
    this.previous = next;
    const urlChanged =
      before.connection.baseUrl !== next.connection.baseUrl ||
      before.connection.allowInsecureHttp !== next.connection.allowInsecureHttp;
    if (!urlChanged) return;
    if (!this.validate(next)) return;
    if (this.isPaired() && before.connection.baseUrl !== next.connection.baseUrl) {
      void vscode.window
        .showWarningMessage(
          'The DevPulse server URL changed. This editor is paired with the previous server, so syncing is paused until you reconnect.',
          'Reconnect',
        )
        .then((action) => {
          if (action) void vscode.commands.executeCommand(Commands.reconnect);
        });
    }
  }

  private validate(settings: DevPulseSettings): boolean {
    const check = checkServerUrl(
      settings.connection.baseUrl,
      settings.connection.allowInsecureHttp,
    );
    if (check.ok) return true;
    void vscode.window
      .showErrorMessage(`DevPulse server URL is not usable: ${check.reason}`, 'Open Settings')
      .then((action) => {
        if (action) void this.settings.open();
      });
    return false;
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
