import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { DevPulseTestApi } from '../../../src/extension';

async function api(): Promise<DevPulseTestApi> {
  const extension = vscode.extensions.getExtension<DevPulseTestApi>('ammarqaisar11a55.devpulse')!;
  const exports = await extension.activate();
  await exports.ready;
  return exports;
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

describe('Configuration', () => {
  const config = () => vscode.workspace.getConfiguration('devpulse');

  afterEach(async () => {
    for (const key of ['tracking.mode', 'exclusions.languages', 'tracking.idleThreshold']) {
      await config().update(key, undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('exposes conservative privacy defaults', () => {
    assert.equal(config().get('privacy.trackFileNames'), false);
    assert.equal(config().get('privacy.trackRepository'), false);
    assert.equal(config().get('privacy.trackTerminal'), false);
    assert.equal(config().get('logging.enabled'), false);
  });

  it('applies tracking settings without a reload', async () => {
    const devpulse = await api();
    assert.equal(devpulse.tracking.snapshot.mode, 'automatic');
    await config().update('tracking.mode', 'manual', vscode.ConfigurationTarget.Global);
    await waitFor(() => devpulse.tracking.snapshot.mode === 'manual', 'mode switched to manual');

    await config().update('tracking.idleThreshold', 10, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => devpulse.tracking.snapshot.idleThresholdMinutes === 10,
      'idle threshold applied',
    );
  });

  it('normalizes exclusion settings', async () => {
    const devpulse = await api();
    await config().update('exclusions.languages', ['Markdown'], vscode.ConfigurationTarget.Global);
    await waitFor(
      () => devpulse.settings.settings.exclusions.languages.includes('markdown'),
      'language exclusion applied',
    );
  });

  it('keeps the server URL user-scoped so workspaces cannot redirect the credential', () => {
    const inspected = config().inspect('api.baseUrl');
    assert.ok(inspected);
    const extension = vscode.extensions.getExtension('ammarqaisar11a55.devpulse')!;
    const properties = (
      extension.packageJSON as {
        contributes: { configuration: { properties: Record<string, { scope?: string }> }[] };
      }
    ).contributes.configuration.flatMap((section) => Object.entries(section.properties));
    const scopes = Object.fromEntries(properties.map(([key, value]) => [key, value.scope]));
    assert.equal(scopes['devpulse.api.baseUrl'], 'application');
    assert.equal(scopes['devpulse.web.url'], 'application');
    assert.equal(scopes['devpulse.api.allowInsecureHttp'], 'application');
  });
});
