import type { SignalKind } from './activityTypes';

/**
 * URI schemes whose documents count as coding activity. Output panes, debug consoles, logs and
 * other extension-internal documents are ignored.
 */
const TRACKED_SCHEMES = new Set([
  'file',
  'untitled',
  'vscode-remote',
  'vscode-vfs',
  'vscode-notebook-cell',
  'vscode-userdata',
  'git',
]);

export function isTrackedScheme(scheme: string): boolean {
  return TRACKED_SCHEMES.has(scheme);
}

export interface TextChange {
  /** Lines spanned by the replaced range (end.line - start.line). */
  replacedLineSpan: number;
  /** The inserted text; only its newline count is used. It is never stored or sent. */
  text: string;
}

/**
 * Estimates added and removed lines from a document change using only line counts: a change
 * replacing N lines with text containing M newlines adds max(M - N, 0) and removes max(N - M, 0).
 */
export function countLineChanges(changes: readonly TextChange[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    let inserted = 0;
    for (let i = 0; i < change.text.length; i++) if (change.text.charCodeAt(i) === 10) inserted++;
    const delta = inserted - change.replacedLineSpan;
    if (delta > 0) added += delta;
    else removed -= delta;
  }
  return { added, removed };
}

/**
 * Drops bursts of identical signals: selection and scroll events fire many times per second but
 * one per interval is enough to know the user is active.
 */
export class SignalThrottle {
  private readonly last = new Map<string, number>();

  constructor(private readonly intervalMs = 1000) {}

  shouldEmit(kind: SignalKind, key: string, at: number): boolean {
    const id = `${kind}:${key}`;
    const previous = this.last.get(id);
    if (previous !== undefined && at - previous < this.intervalMs && at >= previous) return false;
    this.last.set(id, at);
    if (this.last.size > 200) this.last.clear();
    return true;
  }
}

export function fileExtensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}
