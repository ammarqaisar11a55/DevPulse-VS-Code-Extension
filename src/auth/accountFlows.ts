import * as vscode from 'vscode';
import { buildDeviceInfo, defaultDeviceName } from '../devices/deviceInfo';
import type { ApiClient } from '../sync/apiClient';
import type { StateStore } from '../storage/stateStore';
import type { Logger } from '../utils/logger';
import { checkServerUrl } from '../utils/url';
import type { SettingsManager } from '../settings/settingsManager';
import type { AuthManager, ConnectResult } from './authManager';
import { PairingError } from './authTypes';
import { normalizePairingKey } from './pairingKey';

export interface AccountHooks {
  /** Runs after a successful pairing (fetch config, start syncing, …). */
  onConnected(result: ConnectResult): Promise<void>;
  /** Ends the current session and makes a final sync attempt; returns items still unsynced. */
  prepareDisconnect(): Promise<number>;
  /** Deletes local activity that was never uploaded. */
  discardUnsynced(): Promise<void>;
}

/** User-facing account flows: connect, reconnect, disconnect and the first-run prompt. */
export class AccountFlows {
  constructor(
    private readonly auth: AuthManager,
    private readonly api: ApiClient,
    private readonly settings: SettingsManager,
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly extensionVersion: string,
    private readonly hooks: AccountHooks,
  ) {}

  async connect(): Promise<boolean> {
    const connection = this.settings.settings.connection;
    const url = checkServerUrl(connection.baseUrl, connection.allowInsecureHttp);
    if (!url.ok) {
      const action = await vscode.window.showErrorMessage(
        `DevPulse cannot connect: ${url.reason}`,
        'Open Settings',
      );
      if (action) await this.settings.open();
      return false;
    }

    if (this.auth.isConnected && this.auth.device) {
      const replace = await vscode.window.showWarningMessage(
        `DevPulse is already connected as ${this.auth.device.account.fullName}. Connect this editor again with a new key?`,
        { modal: true },
        'Connect Again',
      );
      if (replace !== 'Connect Again') return false;
    }

    const key = await vscode.window.showInputBox({
      title: 'Connect DevPulse',
      prompt: 'Enter the connection key from DevPulse → Settings → Integrations → VS Code.',
      placeHolder: 'DP-XXXX-XXXX-XXXX',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (value.replace(/[\s-]/g, '').length < 12) return undefined;
        return normalizePairingKey(value)
          ? undefined
          : 'Connection keys look like DP-7F3K-X92M-Q8PR (letters and digits, no 0, O, 1, I or L).';
      },
    });
    if (key === undefined) return false;

    const info = buildDeviceInfo({
      name: this.auth.device?.deviceName ?? defaultDeviceName(vscode.env.appName),
      appName: vscode.env.appName,
      editorVersion: vscode.version,
      extensionVersion: this.extensionVersion,
    });

    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Connecting to DevPulse…' },
        () => this.auth.connect(this.api, key, info),
      );
      if (result.accountChanged) await this.hooks.discardUnsynced();
      await this.hooks.onConnected(result);
      void vscode.window
        .showInformationMessage(
          `DevPulse connected as ${result.device.account.fullName} on "${result.device.deviceName}". Tracking starts when you start coding.`,
          'Open Dashboard',
          'Rename Device',
        )
        .then((action) => {
          if (action === 'Open Dashboard')
            void vscode.commands.executeCommand('devpulse.openDashboard');
          if (action === 'Rename Device')
            void vscode.commands.executeCommand('devpulse.renameDevice');
        });
      return true;
    } catch (error) {
      const message =
        error instanceof PairingError
          ? error.message
          : 'Connecting to DevPulse failed unexpectedly.';
      if (!(error instanceof PairingError)) this.logger.error('Pairing failed', error);
      const action = await vscode.window.showErrorMessage(message, 'Try Again', 'Open DevPulse');
      if (action === 'Try Again') return this.connect();
      if (action === 'Open DevPulse') await this.openWeb('/settings/integrations');
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.auth.authState === 'NOT_CONNECTED') {
      void vscode.window.showInformationMessage('DevPulse is not connected.');
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      'Disconnect DevPulse from this editor?',
      {
        modal: true,
        detail:
          'The current session is ended and uploaded if possible, then this device is revoked and its credential deleted. Any activity that still cannot be uploaded is deleted from this computer. Data already in your DevPulse account is kept.',
      },
      'Disconnect',
    );
    if (confirm !== 'Disconnect') return;

    const unsynced = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Disconnecting DevPulse…' },
      async () => {
        const remaining = await this.hooks.prepareDisconnect();
        await this.auth.disconnect(this.api, true);
        await this.hooks.discardUnsynced();
        return remaining;
      },
    );
    void vscode.window.showInformationMessage(
      unsynced > 0
        ? `DevPulse disconnected. ${unsynced} unsynced ${unsynced === 1 ? 'item was' : 'items were'} deleted from this computer.`
        : 'DevPulse disconnected. All activity was synced.',
    );
  }

  /** Offers to connect on first run; never forces it. */
  async showWelcomeIfNeeded(): Promise<void> {
    if (this.state.getGlobal('devpulse.welcomeShown') || this.auth.authState !== 'NOT_CONNECTED') {
      return;
    }
    await this.state.setGlobal('devpulse.welcomeShown', true);
    const action = await vscode.window.showInformationMessage(
      'DevPulse installed. Track your coding time and development activity privately.',
      'Connect Account',
      'Continue Without Connecting',
    );
    if (action === 'Connect Account') await this.connect();
  }

  async openWeb(path = '/dashboard'): Promise<void> {
    const connection = this.settings.settings.connection;
    const check = checkServerUrl(connection.webUrl, connection.allowInsecureHttp);
    if (!check.ok) {
      void vscode.window.showErrorMessage(`DevPulse web URL is invalid: ${check.reason}`);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(`${check.url}${path}`));
  }
}
