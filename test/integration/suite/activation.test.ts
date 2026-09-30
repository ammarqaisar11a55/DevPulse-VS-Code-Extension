import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'ammarqaisar11a55.devpulse';

describe('Extension activation', () => {
  it('activates without errors', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension is installed');
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  it('registers every contributed command', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
    const contributed = (
      extension.packageJSON as { contributes: { commands: { command: string }[] } }
    ).contributes.commands.map((item) => item.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const command of contributed)
      assert.ok(registered.has(command), `${command} is registered`);
  });

  it('opens the DevPulse activity view', async () => {
    await vscode.commands.executeCommand('devpulse.openActivity');
  });
});
