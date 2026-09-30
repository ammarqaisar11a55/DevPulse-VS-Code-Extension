/**
 * Live contract test against a running DevPulse backend. Opt-in:
 *
 *   DEVPULSE_E2E_API=http://localhost:4000/api/v1 \
 *   DEVPULSE_E2E_IDENTIFIER=<user> DEVPULSE_E2E_PASSWORD=<password> npm run test:e2e
 *
 * It signs in as the given (test) user to create pairing keys, then exercises the extension's
 * real client code: pairing, session and event sync, idempotent retries, and disconnect.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthManager } from '../../src/auth/authManager';
import { CredentialStore } from '../../src/auth/credentialStore';
import { PairingError } from '../../src/auth/authTypes';
import { PrivacyManager } from '../../src/privacy/privacyManager';
import { readSettings } from '../../src/settings/readSettings';
import { EventQueueStore } from '../../src/storage/queueStore';
import { SessionStore } from '../../src/storage/sessionStore';
import { StateStore } from '../../src/storage/stateStore';
import type { SessionRecord } from '../../src/storage/storageTypes';
import { ApiClient } from '../../src/sync/apiClient';
import { RetryManager } from '../../src/sync/retryManager';
import { SyncEngine } from '../../src/sync/syncEngine';
import { silentLogger } from '../../src/utils/logger';
import { systemClock } from '../../src/utils/time';
import { MemoryMemento, MemorySecrets, tempDir } from '../unit/helpers';

const API = process.env.DEVPULSE_E2E_API ?? 'http://localhost:4000/api/v1';
const IDENTIFIER = process.env.DEVPULSE_E2E_IDENTIFIER;
const PASSWORD = process.env.DEVPULSE_E2E_PASSWORD;

const device = {
  name: `E2E ${new Date().toISOString().slice(0, 16)}`,
  platform: 'linux' as const,
  editor: 'vscode',
  editorVersion: '1.104.0',
  extensionVersion: '0.1.0-e2e',
};

describe.skipIf(!IDENTIFIER || !PASSWORD)('live DevPulse API', () => {
  let accessToken = '';
  let cleanup: () => void;
  let dir: string;
  const deviceIds: string[] = [];

  async function userRequest(method: string, path: string, body?: unknown) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as { data: never }) : null };
  }

  async function newPairingKey(): Promise<string> {
    const { status, json } = await userRequest('POST', '/integrations/pairing-keys');
    expect(status).toBe(201);
    return (json!.data as { key: string }).key;
  }

  function client() {
    const secrets = new MemorySecrets();
    const state = new StateStore(new MemoryMemento(), new MemoryMemento());
    const auth = new AuthManager(
      new CredentialStore(secrets),
      state,
      systemClock,
      silentLogger,
      () => API,
    );
    const api = new ApiClient({
      baseUrl: () => ({ ok: true, url: API }),
      credential: () => auth.credentialFor(API),
      userAgent: 'DevPulse-VSCode/e2e',
      logger: silentLogger,
    });
    return { auth, api, state };
  }

  beforeAll(async () => {
    ({ dir, cleanup } = tempDir());
    const response = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    accessToken = ((await response.json()) as { data: { accessToken: string } }).data.accessToken;
  });

  afterAll(async () => {
    for (const id of deviceIds) await userRequest('DELETE', `/devices/${id}`);
    cleanup?.();
  });

  it('rejects malformed, unknown and reused keys', async () => {
    const { auth, api } = client();
    await expect(auth.connect(api, 'nope', device)).rejects.toMatchObject({
      reason: 'INVALID_KEY_FORMAT',
    });
    await expect(auth.connect(api, 'DP-AAAA-BBBB-CCCC', device)).rejects.toBeInstanceOf(
      PairingError,
    );

    const key = await newPairingKey();
    const first = client();
    const result = await first.auth.connect(
      first.api,
      key.toLowerCase().replace(/-/g, ' '),
      device,
    );
    deviceIds.push(result.device.deviceId);
    const second = client();
    await expect(second.auth.connect(second.api, key, device)).rejects.toMatchObject({
      reason: 'KEY_REJECTED',
    });
  });

  it('pairs, syncs a session with events idempotently, and disconnects', async () => {
    const { auth, api } = client();
    const paired = await auth.connect(api, await newPairingKey(), device);
    deviceIds.push(paired.device.deviceId);
    expect(auth.authState).toBe('CONNECTED');

    const { data: remote } = await api.integrations.config();
    expect(remote.device.id).toBe(paired.device.deviceId);
    expect(remote.config.heartbeatIntervalSeconds).toBeGreaterThan(0);

    // Device-authenticated rename and account summary.
    const renamed = await api.devices.rename(`${device.name} (renamed)`);
    expect(renamed.data).toEqual({ id: paired.device.deviceId, name: `${device.name} (renamed)` });
    const summary = await api.analytics.summary();
    expect(summary.data.weekSeconds).toBeGreaterThanOrEqual(summary.data.todaySeconds);
    expect(summary.data.timezone).toEqual(expect.any(String));

    const sessions = new SessionStore(`${dir}/sessions`);
    const queue = new EventQueueStore(`${dir}/queue`, 'e2e', systemClock);
    const privacy = new PrivacyManager(
      () => readSettings({ get: () => undefined, isExplicitlySet: () => false }),
      () => undefined,
      '/home/e2e',
    );
    const engine = new SyncEngine({
      api,
      sessions,
      queue,
      retry: new RetryManager(systemClock),
      privacy,
      clock: systemClock,
      logger: silentLogger,
      instanceId: 'e2e',
      canSync: () => auth.isConnected,
      onAuthError: async (error) => {
        await auth.handleApiError(error);
      },
      onSessionSuperseded: () => undefined,
      heartbeatIntervalMs: () => 60_000,
    });

    const start = Date.now() - 40 * 60_000;
    const record: SessionRecord = {
      schema: 1,
      clientSessionId: randomUUID(),
      ownerInstanceId: 'e2e',
      ownerSeenAt: Date.now(),
      workspaceKey: 'e2e',
      project: { name: 'DevPulse E2E' },
      projectKey: 'e2e',
      startedAt: start,
      lastActivityAt: start + 20 * 60_000,
      endedAt: null,
      endReason: null,
      activeSeconds: 1100,
      languages: { typescript: 900, css: 200 },
      repository: null,
      branch: 'e2e/branch',
      filesChanged: 2,
      linesAdded: 10,
      linesRemoved: 1,
      commits: 1,
      revision: 3,
    };
    await sessions.saveRecord(record);
    const eventIds = [randomUUID(), randomUUID()];
    await queue.append([
      {
        clientEventId: eventIds[0]!,
        type: 'SESSION_STARTED',
        occurredAt: start,
        clientSessionId: record.clientSessionId,
        language: 'typescript',
      },
      {
        clientEventId: eventIds[1]!,
        type: 'IDLE_STARTED',
        occurredAt: start + 20 * 60_000,
        clientSessionId: record.clientSessionId,
      },
    ]);

    const first = await engine.sync();
    expect(first).toMatchObject({ ok: true, eventsAccepted: 2 });
    const serverId = (await sessions.get(record.clientSessionId, Date.now()))!.sync.serverId!;
    let detail = await userRequest('GET', `/sessions/${serverId}`);
    expect(detail.json!.data).toMatchObject({
      status: 'ACTIVE',
      activeSeconds: 1100,
      source: 'EXTENSION',
    });

    // End the session and resend the same events (as after a crash): no duplicates.
    const endedAt = start + 30 * 60_000;
    await sessions.saveRecord({
      ...record,
      endedAt,
      lastActivityAt: endedAt,
      activeSeconds: 1500,
      revision: 4,
    });
    await queue.append([
      {
        clientEventId: eventIds[0]!,
        type: 'SESSION_STARTED',
        occurredAt: start,
        clientSessionId: record.clientSessionId,
      },
    ]);
    const second = await engine.sync();
    expect(second).toMatchObject({ ok: true, eventsAccepted: 0, eventsDuplicate: 1 });

    detail = await userRequest('GET', `/sessions/${serverId}`);
    expect(detail.json!.data).toMatchObject({
      status: 'ENDED',
      activeSeconds: 1500,
      durationSeconds: 1800,
      idleSeconds: 300,
      language: 'typescript',
      project: expect.objectContaining({ name: 'DevPulse E2E' }),
    });

    // Disconnect revokes the credential on the server.
    await auth.disconnect(api, true);
    const again = client();
    await again.state.setGlobal('devpulse.device', {
      deviceId: paired.device.deviceId,
      deviceName: 'x',
      account: paired.device.account,
      connectedAt: 0,
      baseUrl: API,
    });
    const devices = await userRequest('GET', '/devices');
    const revoked = (devices.json!.data as { id: string; revokedAt: string | null }[]).find(
      (item) => item.id === paired.device.deviceId,
    );
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it('detects a device revoked from the web app', async () => {
    const { auth, api } = client();
    const paired = await auth.connect(api, await newPairingKey(), device);
    deviceIds.push(paired.device.deviceId);
    expect((await userRequest('DELETE', `/devices/${paired.device.deviceId}`)).status).toBe(204);
    const error = await api.integrations.config().catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'DEVICE_REVOKED', status: 401 });
    await auth.handleApiError(error as never);
    expect(auth.authState).toBe('REVOKED');
  });
});
