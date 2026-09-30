/** What kind of editor interaction produced an activity signal. */
export type SignalKind =
  | 'edit'
  | 'selection'
  | 'scroll'
  | 'editorFocus'
  | 'save'
  | 'window'
  | 'terminal'
  | 'debug'
  | 'notebook'
  | 'manual';

/**
 * Where the activity happened. Resolved locally from VS Code metadata; the URI and file name
 * are used only for local decisions (project lookup, exclusions) and are never uploaded.
 */
export interface ActivityContext {
  uri: string;
  scheme: string;
  languageId: string;
  /** Base name, for local sensitive-file checks only. */
  fileName: string;
  /** Extension including the dot (".ts"), or "" when none. */
  fileExtension: string;
  workspaceFolder?: { uri: string; name: string; fsPath?: string };
}

export interface ActivitySignal {
  kind: SignalKind;
  at: number;
  context?: ActivityContext;
  linesAdded?: number;
  linesRemoved?: number;
}

export type DebugTransition = { kind: 'started' | 'stopped'; debugType: string; at: number };
