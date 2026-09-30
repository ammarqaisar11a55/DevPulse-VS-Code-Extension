import * as vscode from 'vscode';
import { Commands } from '../commands';
import { formatDuration } from '../utils/time';
import { languageDisplayName } from '../workspace/languageDetector';
import type { AppState } from './appState';
import { CONNECTION_LABELS, CONNECTION_SYMBOLS, SYNC_LABELS } from './statusModel';

interface MenuItem extends vscode.QuickPickItem {
  command?: string;
}

/** The status bar's quick action menu: a summary followed by the most useful actions. */
export async function showQuickMenu(appState: AppState): Promise<void> {
  const snapshot = appState.snapshot;
  const { tracking, totals, connection } = snapshot;
  const session = tracking.session;
  const paused = tracking.status === 'paused';
  const connected = snapshot.auth === 'CONNECTED';

  const info: MenuItem[] = [
    {
      label: `$(clock) Today: ${formatDuration(totals.todaySeconds)}`,
      description: totals.source === 'account' ? 'all devices' : 'this device',
      command: Commands.openDashboard,
    },
    {
      label: `$(history) Current Session: ${session ? formatDuration(session.activeSeconds) : '—'}`,
      description: session ? tracking.status : undefined,
      command: Commands.openActivity,
    },
    {
      label: `${CONNECTION_SYMBOLS[connection]} ${CONNECTION_LABELS[connection]}`,
      description: snapshot.device?.deviceName,
      detail: SYNC_LABELS[snapshot.sync.status],
      command: Commands.showDiagnostics,
    },
  ];
  if (tracking.projectName) {
    info.push({
      label: `$(folder) Project: ${tracking.projectName}`,
      description: tracking.excluded
        ? 'excluded'
        : tracking.languageId
          ? languageDisplayName(tracking.languageId)
          : undefined,
    });
  }

  const actions: MenuItem[] = [];
  if (connected) {
    actions.push(
      paused
        ? { label: '$(debug-start) Resume Tracking', command: Commands.resumeTracking }
        : { label: '$(debug-pause) Pause Tracking', command: Commands.pauseTracking },
    );
    if (tracking.mode === 'manual' || session) {
      actions.push(
        session
          ? { label: '$(debug-stop) End Session', command: Commands.endSession }
          : { label: '$(play) Start Session', command: Commands.startSession },
      );
    }
    actions.push(
      { label: '$(dashboard) Open Dashboard', command: Commands.openMiniDashboard },
      { label: '$(sync) Sync Now', command: Commands.syncNow },
      { label: '$(link-external) Open DevPulse', command: Commands.openDashboard },
    );
  } else {
    actions.push({ label: '$(plug) Connect Account', command: Commands.connect });
  }
  actions.push(
    { label: '$(gear) Settings', command: Commands.openSettings },
    { label: '$(pulse) Show Diagnostics', command: Commands.showDiagnostics },
  );
  if (connected)
    actions.push({ label: '$(debug-disconnect) Disconnect', command: Commands.disconnect });

  const picked = await vscode.window.showQuickPick<MenuItem>(
    [...info, { label: 'Actions', kind: vscode.QuickPickItemKind.Separator }, ...actions],
    { title: 'DevPulse', placeHolder: 'Choose an action' },
  );
  if (picked?.command) await vscode.commands.executeCommand(picked.command);
}
