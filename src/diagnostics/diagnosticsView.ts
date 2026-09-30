import * as vscode from 'vscode';

export const DIAGNOSTICS_SCHEME = 'devpulse-diagnostics';

/** Serves the diagnostics report as a read-only virtual document. */
export class DiagnosticsDocumentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private content = '';
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  readonly uri = vscode.Uri.parse(`${DIAGNOSTICS_SCHEME}:DevPulse Diagnostics.md`);

  provideTextDocumentContent(): string {
    return this.content;
  }

  async show(content: string): Promise<void> {
    this.content = content;
    this.emitter.fire(this.uri);
    const document = await vscode.workspace.openTextDocument(this.uri);
    await vscode.languages.setTextDocumentLanguage(document, 'markdown');
    await vscode.window.showTextDocument(document, { preview: true });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
