import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DevPulseTestApi } from '../../../src/extension';
import { startHttpFakeServer } from './httpFakeServer';

const G = vscode.ConfigurationTarget.Global;

async function waitFor(check: () => boolean | Promise<boolean>, message: string, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out: ${message}`);
}

describe('Tracking and synchronization (mock DevPulse API)', function () {
  this.timeout(60_000);

  let devpulse: DevPulseTestApi;
  let fake: Awaited<ReturnType<typeof startHttpFakeServer>>;
  let editor: vscode.TextEditor;
  const config = () => vscode.workspace.getConfiguration('devpulse');
  const fixture = path.resolve(__dirname, '../../../../test/fixtures/workspace/src/index.ts');

  async function edit(text = '// edit\n') {
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), text));
  }

  before(async () => {
    const extension = vscode.extensions.getExtension<DevPulseTestApi>('ammarqaisar11a55.devpulse')!;
    devpulse = await extension.activate();
    await devpulse.ready;
    fake = await startHttpFakeServer();
    // The test window is usually not focused; count activity anyway.
    await config().update('tracking.pauseWhenUnfocused', false, G);
    await config().update('api.baseUrl', fake.baseUrl, G);
    await waitFor(
      () => devpulse.settings.settings.connection.baseUrl === fake.baseUrl,
      'base URL applied',
    );
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture));
    editor = await vscode.window.showTextDocument(document);
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    for (const key of ['tracking.pauseWhenUnfocused', 'api.baseUrl', 'exclusions.languages']) {
      await config().update(key, undefined, G);
    }
    await fake.close();
  });

  it('does not track before an account is connected', async () => {
    await edit();
    assert.equal(devpulse.tracking.snapshot.status, 'not-connected');
    assert.equal(devpulse.tracking.snapshot.session, undefined);
  });

  it('pairs with a one-time key and rejects its reuse', async () => {
    const info = {
      name: 'VS Code on Linux',
      platform: 'linux' as const,
      editor: 'vscode',
      editorVersion: vscode.version,
      extensionVersion: '0.0.0-test',
    };
    await devpulse.auth.connect(devpulse.api, 'dp test keys aaaa', info);
    assert.equal(devpulse.auth.authState, 'CONNECTED');
    await assert.rejects(devpulse.auth.connect(devpulse.api, 'DP-TEST-KEYS-AAAA', info), {
      reason: 'KEY_REJECTED',
    });
    // The failed attempt keeps the existing connection.
    assert.equal(devpulse.auth.authState, 'CONNECTED');
    devpulse.engine.refreshStatus();
    await waitFor(() => devpulse.tracking.snapshot.status === 'ready', 'tracking ready');
  });

  it('starts one session from editor activity and attributes project and language', async () => {
    await edit();
    await waitFor(() => devpulse.tracking.snapshot.session !== undefined, 'session started');
    const first = devpulse.tracking.snapshot.session!.clientSessionId;
    await edit('const a = 1;\n');
    await edit('const b = 2;\n');
    const snapshot = devpulse.tracking.snapshot;
    assert.equal(snapshot.session!.clientSessionId, first, 'no session fragmentation');
    assert.equal(snapshot.status, 'active');
    assert.equal(snapshot.projectName, 'workspace');
    assert.equal(snapshot.languageId, 'typescript');
  });

  it('uploads the session and events without file names, paths or code', async () => {
    await vscode.commands.executeCommand('devpulse.syncNow');
    await waitFor(() => fake.server.sessions.size === 1 && fake.server.events.size > 0, 'uploaded');
    const session = [...fake.server.sessions.values()][0]!;
    assert.deepEqual(session.body.project, { name: 'workspace' });
    assert.equal(session.body.language, 'typescript');
    assert.equal(session.body.editor, 'vscode');

    const everything = JSON.stringify(fake.server.requests);
    for (const forbidden of ['index.ts', 'fixtures', 'greeting', 'const a', '// edit']) {
      assert.ok(!everything.includes(forbidden), `requests must not contain "${forbidden}"`);
    }
    const create = fake.server.requests.find((request) => request.path === '/activity/sessions');
    assert.ok(create, 'session created through the device endpoint');
  });

  it('pauses: ends the session and records nothing until resumed', async () => {
    await vscode.commands.executeCommand('devpulse.pauseTracking');
    assert.equal(devpulse.tracking.snapshot.status, 'paused');
    assert.equal(devpulse.tracking.snapshot.session, undefined);
    await edit();
    assert.equal(devpulse.tracking.snapshot.session, undefined);

    await vscode.commands.executeCommand('devpulse.syncNow');
    await waitFor(
      () => [...fake.server.sessions.values()].every((session) => session.status === 'ENDED'),
      'session ended on the server',
    );

    await vscode.commands.executeCommand('devpulse.resumeTracking');
    await edit();
    await waitFor(() => devpulse.tracking.snapshot.session !== undefined, 'tracking resumed');
  });

  it('keeps activity while offline and syncs it without duplicates when back online', async () => {
    fake.server.offline = true;
    await edit();
    const result = await devpulse.engine.sync({ force: true });
    assert.equal(result.ok, false);
    assert.equal(devpulse.engine.snapshot.status, 'offline');

    fake.server.offline = false;
    await vscode.commands.executeCommand('devpulse.syncNow');
    await waitFor(() => devpulse.engine.snapshot.status === 'synced', 'synced after reconnect');
    const clientIds = [...fake.server.sessions.values()].map((session) => session.clientSessionId);
    assert.equal(new Set(clientIds).size, clientIds.length, 'no duplicate sessions');
    assert.equal(fake.server.sessions.size, 2);

    // Retrying everything again creates no new sessions (background syncs may still upload
    // newly recorded events, so event counts are not compared here).
    await devpulse.engine.sync({ force: true });
    assert.equal(fake.server.sessions.size, 2);
    const eventIds = fake.server.requests
      .filter((request) => request.path === '/activity/events')
      .flatMap((request) => (request.body as { events: { clientEventId: string }[] }).events)
      .map((event) => event.clientEventId);
    assert.equal(new Set(eventIds).size, fake.server.events.size, 'every event stored once');
  });

  it('does not track excluded languages', async () => {
    await vscode.commands.executeCommand('devpulse.endSession');
    await config().update('exclusions.languages', ['typescript'], G);
    await waitFor(
      () => devpulse.settings.settings.exclusions.languages.includes('typescript'),
      'exclusion applied',
    );
    await edit();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(devpulse.tracking.snapshot.session, undefined);
    assert.equal(devpulse.tracking.snapshot.excluded, true);
    await config().update('exclusions.languages', undefined, G);
  });

  it('stores durable data under the extension global storage', async () => {
    const extension = vscode.extensions.getExtension('ammarqaisar11a55.devpulse')!;
    assert.ok(devpulse.storage.root.toLowerCase().includes(extension.id.toLowerCase()));
    const files = await vscode.workspace.fs.readDirectory(
      vscode.Uri.file(path.join(devpulse.storage.root, 'sessions')),
    );
    assert.ok(files.length > 0, 'session outbox persisted');
    const text = (
      await Promise.all(
        files.map(async ([name]) =>
          Buffer.from(
            await vscode.workspace.fs.readFile(
              vscode.Uri.file(path.join(devpulse.storage.root, 'sessions', name)),
            ),
          ).toString('utf8'),
        ),
      )
    ).join('\n');
    assert.ok(!text.includes('dpd_'), 'no credentials in local files');
  });

  it('stops syncing and asks to reconnect when the device is revoked', async () => {
    fake.server.revoked = true;
    await edit('// after revoke\n');
    await config().update('exclusions.languages', undefined, G);
    await devpulse.engine.sync({ force: true });
    await waitFor(() => devpulse.auth.authState === 'REVOKED', 'device revoked');
    assert.equal(devpulse.tracking.snapshot.status, 'needs-reconnect');
    assert.equal(devpulse.tracking.snapshot.session, undefined);

    const requests = fake.server.requests.length;
    await devpulse.engine.sync({ force: true });
    assert.equal(fake.server.requests.length, requests, 'revoked credential is not retried');
  });
});
