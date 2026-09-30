import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { Commands } from '../commands';
import type { AppState } from './appState';
import { dashboardModel, parseDashboardMessage, type DashboardAction } from './dashboardModel';

const VIEW_TYPE = 'devpulse.dashboard';

const ACTION_COMMANDS: Record<DashboardAction, string | ((paused: boolean) => string)> = {
  openWeb: Commands.openDashboard,
  togglePause: (paused) => (paused ? Commands.resumeTracking : Commands.pauseTracking),
  syncNow: Commands.syncNow,
  openSettings: Commands.openSettings,
  connect: Commands.connect,
};

/**
 * A small in-editor summary. It complements the web dashboard (linked from here) instead of
 * duplicating its analytics. The webview runs only the inline script below, under a strict CSP.
 */
export class DashboardPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly appState: AppState) {
    this.disposables.push(appState.onDidChange(() => this.post()));
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'DevPulse',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: false },
    );
    panel.webview.html = renderHtml(panel.webview.cspSource, randomBytes(16).toString('base64'));
    panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        if ((message as { type?: unknown })?.type === 'ready') {
          this.post();
          return;
        }
        const action = parseDashboardMessage(message);
        if (!action) return;
        const target = ACTION_COMMANDS[action];
        const command =
          typeof target === 'function'
            ? target(this.appState.snapshot.tracking.status === 'paused')
            : target;
        void vscode.commands.executeCommand(command);
      },
      undefined,
      this.disposables,
    );
    panel.onDidDispose(() => (this.panel = undefined), undefined, this.disposables);
    this.panel = panel;
  }

  private post(): void {
    if (!this.panel?.visible) return;
    void this.panel.webview.postMessage({
      type: 'state',
      data: dashboardModel(this.appState.snapshot, Date.now()),
    });
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

function renderHtml(cspSource: string, nonce: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DevPulse</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 24px;
    max-width: 880px;
  }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
  .card {
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-radius: 6px;
    padding: 14px 16px;
  }
  .label { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 0; }
  .value { font-size: 1.6em; font-weight: 600; margin: 6px 0 2px; font-variant-numeric: tabular-nums; }
  .value.small { font-size: 1.15em; }
  .detail { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 0; min-height: 1.2em; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 22px 0; }
  button {
    font: inherit;
    padding: 6px 14px;
    border-radius: 2px;
    border: 1px solid var(--vscode-button-border, transparent);
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    cursor: pointer;
  }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  h2 { font-size: 1.05em; font-weight: 600; margin: 8px 0 10px; }
  .lang { display: grid; grid-template-columns: 9em 1fr 5em; gap: 10px; align-items: center; margin: 6px 0; }
  .bar { height: 8px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.2)); border-radius: 4px; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: var(--vscode-progressBar-background); }
  body.vscode-high-contrast .bar > span, body.vscode-high-contrast-light .bar > span { background: var(--vscode-contrastActiveBorder, currentColor); }
  .muted { color: var(--vscode-descriptionForeground); }
  .hidden { display: none; }
  footer { margin-top: 28px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
</style>
</head>
<body>
  <h1>DevPulse</h1>
  <p class="subtitle" id="status" role="status" aria-live="polite">Loading…</p>

  <section class="grid" aria-label="Coding time">
    <div class="card"><p class="label">Today</p><p class="value" id="today">—</p><p class="detail" id="scope"></p></div>
    <div class="card"><p class="label">This Week</p><p class="value" id="week">—</p><p class="detail" id="scope2"></p></div>
    <div class="card"><p class="label">Current Session</p><p class="value" id="session">—</p><p class="detail" id="sessionDetail"></p></div>
    <div class="card"><p class="label">Current Project</p><p class="value small" id="project">—</p><p class="detail" id="tracking"></p></div>
    <div class="card"><p class="label">Active Language</p><p class="value small" id="language">—</p><p class="detail"></p></div>
    <div class="card"><p class="label">Sync</p><p class="value small" id="sync">—</p><p class="detail" id="syncDetail"></p></div>
  </section>

  <nav class="actions" aria-label="Actions">
    <button class="primary" data-action="openWeb">Open Full Dashboard</button>
    <button data-action="togglePause" id="pause">Pause Tracking</button>
    <button data-action="syncNow">Sync Now</button>
    <button data-action="openSettings">Settings</button>
    <button class="primary hidden" data-action="connect" id="connect">Connect Account</button>
  </nav>

  <section aria-labelledby="languagesTitle">
    <h2 id="languagesTitle">Languages this session</h2>
    <div id="languages"><p class="muted">No coding time in this session yet.</p></div>
  </section>

  <footer>DevPulse records coding time and metadata only — never keystrokes, clipboard contents or source code.</footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const setText = (id, value) => { byId(id).textContent = value; };

  for (const button of document.querySelectorAll('button[data-action]')) {
    button.addEventListener('click', () => vscode.postMessage({ type: 'action', action: button.dataset.action }));
  }

  function render(model) {
    setText('status', model.connection + ' · Tracking: ' + model.tracking);
    setText('today', model.today);
    setText('week', model.week);
    setText('scope', model.totalsScope);
    setText('scope2', model.totalsScope);
    setText('session', model.session);
    setText('sessionDetail', model.sessionDetail);
    setText('project', model.project);
    setText('tracking', 'Tracking: ' + model.tracking);
    setText('language', model.language);
    setText('sync', model.sync);
    setText('syncDetail', model.syncDetail);
    setText('pause', model.paused ? 'Resume Tracking' : 'Pause Tracking');
    byId('pause').classList.toggle('hidden', !model.connected);
    byId('connect').classList.toggle('hidden', model.connected);

    const container = byId('languages');
    container.replaceChildren();
    if (model.languages.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No coding time in this session yet.';
      container.append(empty);
      return;
    }
    for (const language of model.languages) {
      const row = document.createElement('div');
      row.className = 'lang';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', language.name + ': ' + language.share + ' percent, ' + language.time);
      const name = document.createElement('span');
      name.textContent = language.name;
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span');
      fill.style.width = Math.max(0, Math.min(100, Number(language.share) || 0)) + '%';
      bar.append(fill);
      const share = document.createElement('span');
      share.className = 'muted';
      share.textContent = language.share + '% · ' + language.time;
      row.append(name, bar, share);
      container.append(row);
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'state' && message.data) render(message.data);
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
