import * as vscode from 'vscode';
import type { PrivacySettings } from '../settings/settingsTypes';
import type { Clock } from '../utils/time';
import {
  SignalThrottle,
  baseName,
  countLineChanges,
  fileExtensionOf,
  isTrackedScheme,
} from './activitySignals';
import type { ActivityContext, ActivitySignal, DebugTransition, SignalKind } from './activityTypes';

export interface ActivityListener {
  onSignal(signal: ActivitySignal): void;
  onFocusChange(focused: boolean, at: number): void;
  onDebug(transition: DebugTransition): void;
}

/**
 * Converts VS Code editor events into activity signals. It listens only to editor-level events
 * exposed by the VS Code API: no keystrokes, clipboard, screenshots or system-wide input. Document
 * text is never read except to count inserted newlines.
 */
export class ActivityTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly throttle = new SignalThrottle();

  constructor(
    private readonly listener: ActivityListener,
    private readonly clock: Clock,
    private readonly privacy: () => PrivacySettings,
  ) {}

  get windowFocused(): boolean {
    return vscode.window.state.focused;
  }

  start(): void {
    const w = vscode.window;
    this.disposables.push(
      w.onDidChangeActiveTextEditor((editor) => {
        if (editor) this.emitDocument('editorFocus', editor.document);
      }),
      w.onDidChangeTextEditorSelection((event) => {
        // Programmatic selection changes (kind undefined) are not user activity.
        if (event.kind === undefined) return;
        this.emitDocument('selection', event.textEditor.document);
      }),
      w.onDidChangeTextEditorVisibleRanges((event) => {
        if (event.textEditor === w.activeTextEditor) {
          this.emitDocument('scroll', event.textEditor.document);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChange(event)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document === w.activeTextEditor?.document) this.emitDocument('save', document);
      }),
      w.onDidChangeWindowState((state) => {
        this.listener.onFocusChange(state.focused, this.clock.now());
        // "active" flips to true when the user interacts with the window (clicks, menus, …).
        if (state.focused && state.active) this.emitActiveEditor('window');
      }),
      w.onDidChangeNotebookEditorSelection((event) => {
        this.emitDocument('notebook', event.notebookEditor.notebook);
      }),
      w.onDidChangeActiveTerminal((terminal) => {
        if (terminal) this.emitTerminal();
      }),
      w.onDidChangeTerminalState(() => this.emitTerminal()),
      vscode.debug.onDidStartDebugSession((session) => this.onDebug('started', session.type)),
      vscode.debug.onDidTerminateDebugSession((session) => this.onDebug('stopped', session.type)),
      vscode.debug.onDidChangeActiveStackItem(() => {
        if (this.privacy().trackDebugging) this.emitActiveEditor('debug');
      }),
    );
  }

  /** Context of the active editor, used when a session starts without a triggering document. */
  activeContext(): ActivityContext | undefined {
    const document = vscode.window.activeTextEditor?.document;
    return document ? this.contextFor(document) : undefined;
  }

  private onDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0) return;
    const document = event.document;
    // Only edits in a visible editor are the user's typing; background changes (formatters on
    // other files, file watchers, extensions) are ignored.
    const visible = vscode.window.visibleTextEditors.some((editor) => editor.document === document);
    if (!visible) return;
    const context = this.contextFor(document);
    if (!context) return;
    const lines = countLineChanges(
      event.contentChanges.map((change) => ({
        replacedLineSpan: change.range.end.line - change.range.start.line,
        text: change.text,
      })),
    );
    this.listener.onSignal({
      kind: 'edit',
      at: this.clock.now(),
      context,
      linesAdded: lines.added,
      linesRemoved: lines.removed,
    });
  }

  private emitDocument(kind: SignalKind, document: vscode.TextDocument | vscode.NotebookDocument) {
    const context = this.contextFor(document);
    if (!context) return;
    const at = this.clock.now();
    if (!this.throttle.shouldEmit(kind, context.uri, at)) return;
    this.listener.onSignal({ kind, at, context });
  }

  private emitActiveEditor(kind: SignalKind): void {
    const at = this.clock.now();
    if (!this.throttle.shouldEmit(kind, '', at)) return;
    this.listener.onSignal({ kind, at, context: this.activeContext() });
  }

  private emitTerminal(): void {
    if (!this.privacy().trackTerminal || !vscode.window.state.focused) return;
    this.emitActiveEditor('terminal');
  }

  private onDebug(kind: 'started' | 'stopped', debugType: string): void {
    if (!this.privacy().trackDebugging) return;
    const at = this.clock.now();
    this.listener.onDebug({ kind, debugType, at });
    if (kind === 'started') this.emitActiveEditor('debug');
  }

  private contextFor(
    document: vscode.TextDocument | vscode.NotebookDocument,
  ): ActivityContext | undefined {
    const uri = document.uri;
    if (!isTrackedScheme(uri.scheme)) return undefined;
    const languageId =
      'languageId' in document ? document.languageId : (document.notebookType ?? 'notebook');
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const fileName = baseName(uri.path);
    return {
      uri: uri.toString(),
      scheme: uri.scheme,
      languageId,
      fileName,
      fileExtension: fileExtensionOf(fileName),
      ...(folder
        ? {
            workspaceFolder: {
              uri: folder.uri.toString(),
              name: folder.name,
              ...(folder.uri.scheme === 'file' ? { fsPath: folder.uri.fsPath } : {}),
            },
          }
        : {}),
    };
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
