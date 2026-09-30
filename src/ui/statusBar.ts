import * as vscode from 'vscode';
import { Commands } from '../commands';
import type { SettingsManager } from '../settings/settingsManager';
import type { AppSnapshot, AppState } from './appState';
import { statusBarPresentation } from './statusModel';

/** The compact DevPulse status bar item; clicking it opens the quick menu. */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    appState: AppState,
    private readonly settings: SettingsManager,
  ) {
    this.item = vscode.window.createStatusBarItem(
      'devpulse.status',
      vscode.StatusBarAlignment.Left,
      50,
    );
    this.item.name = 'DevPulse';
    this.disposables.push(
      this.item,
      appState.onDidChange((snapshot) => this.render(snapshot)),
      settings.onDidChange(() => this.render(appState.snapshot)),
    );
    this.render(appState.snapshot);
  }

  private render(snapshot: AppSnapshot): void {
    if (!this.settings.settings.statusBarEnabled || !this.settings.settings.enabled) {
      this.item.hide();
      return;
    }
    const view = statusBarPresentation({
      connection: snapshot.connection,
      tracking: snapshot.tracking.status,
      todaySeconds: snapshot.totals.todaySeconds,
      pendingItems: snapshot.pending.events + snapshot.pending.sessions,
    });
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    this.item.accessibilityInformation = { label: view.accessibilityLabel, role: 'button' };
    this.item.backgroundColor =
      view.severity === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : view.severity === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.item.command =
      snapshot.connection === 'NOT_CONNECTED'
        ? Commands.connect
        : snapshot.connection === 'REVOKED' || snapshot.connection === 'AUTH_EXPIRED'
          ? Commands.reconnect
          : Commands.showMenu;
    this.item.show();
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
