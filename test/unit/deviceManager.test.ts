import { describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../../src/auth/authManager';
import { CredentialStore } from '../../src/auth/credentialStore';
import { DeviceManager, validateDeviceName } from '../../src/devices/deviceManager';
import { StateStore } from '../../src/storage/stateStore';
import { ApiClient, type FetchLike } from '../../src/sync/apiClient';
import { silentLogger } from '../../src/utils/logger';
import { FakeClock, MemoryMemento, MemorySecrets } from './helpers';

const BASE = 'http://localhost:4000/api/v1';

async function setup(responses: Response[]) {
  const secrets = new MemorySecrets();
  const state = new StateStore(new MemoryMemento(), new MemoryMemento());
  const auth = new AuthManager(
    new CredentialStore(secrets),
    state,
    new FakeClock(),
    silentLogger,
    () => BASE,
  );
  const fetchMock = vi.fn<FetchLike>();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  const api = new ApiClient({
    baseUrl: () => ({ ok: true, url: BASE }),
    credential: () => auth.credentialFor(BASE),
    userAgent: 't',
    logger: silentLogger,
    fetch: fetchMock,
  });
  await auth.connect(api, 'DP-AAAA-BBBB-CCCC', {
    name: 'VS Code on Linux',
    platform: 'linux',
    editor: 'vscode',
    editorVersion: '1',
    extensionVersion: '1',
  });
  return {
    auth,
    api,
    state,
    fetchMock,
    devices: new DeviceManager(api, auth, state, new FakeClock(), silentLogger),
  };
}

const paired = () =>
  new Response(
    JSON.stringify({
      data: {
        credential: 'dpd_x',
        device: { id: 'd1', name: 'VS Code on Linux' },
        account: { username: 'sam', fullName: 'Sam' },
        config: {
          idleTimeoutMinutes: 5,
          trackBranchNames: true,
          trackRepositoryUrl: true,
          heartbeatIntervalSeconds: 60,
        },
      },
    }),
    { status: 201 },
  );

describe('DeviceManager', () => {
  it('validates names', () => {
    expect(validateDeviceName('  ')).toBeDefined();
    expect(validateDeviceName('x'.repeat(61))).toBeDefined();
    expect(validateDeviceName('Work Laptop')).toBeUndefined();
  });

  it('renames the device on the server and locally', async () => {
    const { devices, auth, fetchMock } = await setup([
      paired(),
      new Response(JSON.stringify({ data: { id: 'd1', name: 'Work Laptop' } }), { status: 200 }),
    ]);
    expect(await devices.rename(' Work Laptop ')).toEqual({ ok: true, name: 'Work Laptop' });
    expect(auth.device?.deviceName).toBe('Work Laptop');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({ name: 'Work Laptop' });
  });

  it('explains when the server cannot rename devices', async () => {
    const { devices } = await setup([
      paired(),
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }), {
        status: 404,
      }),
    ]);
    expect(await devices.rename('Work Laptop')).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('stores account totals and stops polling servers without the endpoint', async () => {
    const { devices, state, fetchMock } = await setup([
      paired(),
      new Response(
        JSON.stringify({ data: { timezone: 'UTC', todaySeconds: 3600, weekSeconds: 7200 } }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'x' } }), { status: 404 }),
    ]);
    await devices.refreshSummary();
    expect(state.getGlobal('devpulse.remoteSummary')).toMatchObject({
      todaySeconds: 3600,
      weekSeconds: 7200,
    });
    await devices.refreshSummary();
    await devices.refreshSummary();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
