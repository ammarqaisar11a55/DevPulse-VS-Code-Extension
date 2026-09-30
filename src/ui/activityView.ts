import * as vscode from 'vscode';
import { Commands } from '../commands';
import { formatDuration, formatRelative } from '../utils/time';
import { languageDisplayName } from '../workspace/languageDetector';
import type { AppSnapshot, AppState } from './appState';
import { CONNECTION_LABELS, CONNECTION_SYMBOLS, SYNC_LABELS, TRACKING_LABELS } from './statusModel';

export const ACTIVITY_VIEW_ID = 'devpulse.activity';

class InfoItem extends vscode.TreeItem {
  constructor(
    label: string,
    value: string,
    icon: string,
    options: { description?: string; tooltip?: string; command?: string; color?: string } = {},
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = options.description ? `${value} · ${options.description}` : value;
    this.iconPath = new vscode.ThemeIcon(
      icon,
      options.color ? new vscode.ThemeColor(options.color) : undefined,
    );
    this.tooltip = options.tooltip ?? `${label}: ${value}`;
    // Screen readers get the full sentence; state is never conveyed by color alone.
    this.accessibilityInformation = { label: `${label}: ${this.description}` };
    if (options.command) this.command = { command: options.command, title: label };
  }
}

/**
 * The DevPulse Activity Bar view: a native tree with today's time, the current session and
 * project, connection and sync state. Richer charts live in the web app.
 */
export class ActivityViewProvider implements vscode.TreeDataProvider<InfoItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly appState: AppState) {
    this.disposables.push(
      this.emitter,
      appState.onDidChange((snapshot) => {
        this.updateContext(snapshot);
        this.emitter.fire();
      }),
    );
    this.updateContext(appState.snapshot);
  }

  getTreeItem(element: InfoItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: InfoItem): InfoItem[] {
    if (element) return [];
    const snapshot = this.appState.snapshot;
    // Unconnected users see the welcome content (viewsWelcome) instead of items.
    if (snapshot.auth === 'NOT_CONNECTED') return [];
    return buildItems(snapshot, Date.now());
  }

  private updateContext(snapshot: AppSnapshot): void {
    void vscode.commands.executeCommand(
      'setContext',
      'devpulse.connected',
      snapshot.auth === 'CONNECTED',
    );
    void vscode.commands.executeCommand(
      'setContext',
      'devpulse.needsReconnect',
      snapshot.auth === 'REVOKED' || snapshot.auth === 'AUTH_EXPIRED' || snapshot.auth === 'ERROR',
    );
    void vscode.commands.executeCommand(
      'setContext',
      'devpulse.paused',
      snapshot.tracking.status === 'paused',
    );
    void vscode.commands.executeCommand(
      'setContext',
      'devpulse.sessionOpen',
      snapshot.tracking.session !== undefined,
    );
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

export function buildItems(snapshot: AppSnapshot, now: number): InfoItem[] {
  const { totals, tracking, sync, connection, pending } = snapshot;
  const scope = totals.source === 'account' ? 'all devices' : 'this device';
  const items: InfoItem[] = [
    new InfoItem('Today', formatDuration(totals.todaySeconds), 'clock', {
      description: scope,
      command: Commands.openDashboard,
    }),
    new InfoItem('This Week', formatDuration(totals.weekSeconds), 'calendar', {
      description: scope,
    }),
  ];

  const session = tracking.session;
  items.push(
    new InfoItem(
      'Current Session',
      session ? formatDuration(session.activeSeconds) : 'None',
      'history',
      {
        description: session ? TRACKING_LABELS[tracking.status] : undefined,
        tooltip: session
          ? `Started ${formatRelative(session.startedAt, now)}${
              session.branch ? ` on ${session.branch}` : ''
            }`
          : 'A session starts automatically when you start coding.',
      },
    ),
  );

  if (tracking.projectName) {
    items.push(
      new InfoItem('Project', tracking.projectName, tracking.excluded ? 'eye-closed' : 'folder', {
        description: tracking.excluded
          ? 'excluded'
          : tracking.languageId
            ? languageDisplayName(tracking.languageId)
            : undefined,
      }),
    );
  }

  items.push(
    new InfoItem('Tracking', TRACKING_LABELS[tracking.status], trackingIcon(tracking.status), {
      command: tracking.status === 'paused' ? Commands.resumeTracking : undefined,
    }),
    new InfoItem(
      'Connection',
      `${CONNECTION_SYMBOLS[connection]} ${CONNECTION_LABELS[connection]}`,
      connection === 'CONNECTED' || connection === 'SYNCING' ? 'plug' : 'debug-disconnect',
      {
        description: snapshot.device?.deviceName,
        command: snapshot.auth === 'CONNECTED' ? undefined : Commands.reconnect,
      },
    ),
  );

  const waiting = pending.events + pending.sessions;
  items.push(
    new InfoItem('Sync', SYNC_LABELS[sync.status], 'sync', {
      description:
        waiting > 0
          ? `${waiting} waiting`
          : sync.lastSuccessAt
            ? formatRelative(sync.lastSuccessAt, now)
            : undefined,
      command: Commands.syncNow,
    }),
  );

  for (const limitation of tracking.limitations) {
    items.push(new InfoItem('Limited', limitation, 'warning'));
  }
  return items;
}

function trackingIcon(status: AppSnapshot['tracking']['status']): string {
  switch (status) {
    case 'active':
      return 'pulse';
    case 'idle':
      return 'watch';
    case 'paused':
    case 'disabled':
      return 'debug-pause';
    default:
      return 'circle-outline';
  }
}
