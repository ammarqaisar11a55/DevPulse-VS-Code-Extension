import * as vscode from 'vscode';
import { Commands } from '../commands';
import type { AppState } from './appState';
import { NotificationPolicy, type NotificationDecision } from './notificationPolicy';

/** Shows the policy's notifications with the relevant action buttons. */
export class Notifier implements vscode.Disposable {
  private readonly policy = new NotificationPolicy();
  private readonly subscription: vscode.Disposable;

  constructor(appState: AppState) {
    this.subscription = appState.onDidChange((snapshot) => {
      for (const decision of this.policy.evaluate(snapshot, Date.now())) this.show(decision);
    });
  }

  private show(decision: NotificationDecision): void {
    const actions: Record<NotificationDecision['kind'], [string, string][]> = {
      revoked: [['Reconnect', Commands.reconnect]],
      reconnect: [['Reconnect', Commands.reconnect]],
      backlog: [
        ['Sync Now', Commands.syncNow],
        ['Show Diagnostics', Commands.showDiagnostics],
      ],
      'sync-error': [['Show Diagnostics', Commands.showDiagnostics]],
    };
    const buttons = actions[decision.kind];
    const show =
      decision.kind === 'backlog'
        ? vscode.window.showInformationMessage
        : vscode.window.showWarningMessage;
    void show(decision.message, ...buttons.map(([label]) => label)).then((picked) => {
      const command = buttons.find(([label]) => label === picked)?.[1];
      if (command) void vscode.commands.executeCommand(command);
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
