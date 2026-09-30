import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

describe('Diagnostics', () => {
  it('shows a report without secrets', async () => {
    await vscode.extensions.getExtension('ammarqaisar11a55.devpulse')!.activate();
    await vscode.commands.executeCommand('devpulse.showDiagnostics');
    let document: vscode.TextDocument | undefined;
    for (let i = 0; i < 50 && !document; i++) {
      document = vscode.workspace.textDocuments.find(
        (item) => item.uri.scheme === 'devpulse-diagnostics',
      );
      if (!document) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(document, 'diagnostics document opened');
    const text = document.getText();
    assert.match(text, /# DevPulse Diagnostics/);
    assert.match(text, /- Connection: Not connected/);
    assert.match(text, /- Extension version: \d+\.\d+\.\d+/);
    assert.doesNotMatch(text, /dpd_|Bearer /);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
});
