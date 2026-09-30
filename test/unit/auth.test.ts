import { describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../../src/auth/authManager';
import { PairingError } from '../../src/auth/authTypes';
import { CredentialStore } from '../../src/auth/credentialStore';
import { normalizePairingKey } from '../../src/auth/pairingKey';
import { defaultDeviceName } from '../../src/devices/deviceInfo';
import { StateStore } from '../../src/storage/stateStore';
import { ApiClient, type FetchLike } from '../../src/sync/apiClient';
import { ApiError } from '../../src/sync/apiErrors';
import { silentLogger } from '../../src/utils/logger';
import { FakeClock, MemoryMemento, MemorySecrets } from './helpers';

const BASE = 'http://localhost:4000/api/v1';
const device = {
  name: 'VS Code on Linux',
  platform: 'linux' as const,
  editor: 'vscode',
  editorVersion: '1.104.0',
  extensionVersion: '0.1.0',
};

function pairResponse(credential = 'dpd_issued', username = 'sam') {
  return new Response(
    JSON.stringify({
      data: {
        credential,
        device: { id: 'dev-1', name: 'VS Code on Linux' },
        account: { username, fullName: 'Sam Carter' },
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
}

function errorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { code: 'X', message } }), { status });
}

function setup(fetchImpl: FetchLike, baseUrl = BASE) {
  const secrets = new MemorySecrets();
  const credentials = new CredentialStore(secrets);
  const state = new StateStore(new MemoryMemento(), new MemoryMemento());
  let currentBase = baseUrl;
  const auth = new AuthManager(
    credentials,
    state,
    new FakeClock(),
    silentLogger,
    () => currentBase,
  );
  const api = new ApiClient({
    baseUrl: () => ({ ok: true, url: currentBase }),
    credential: () => auth.credentialFor(currentBase),
    userAgent: 'test',
    logger: silentLogger,
    fetch: fetchImpl,
  });
  return { auth, api, secrets, state, setBase: (url: string) => (currentBase = url) };
}

describe('normalizePairingKey', () => {
  it.each([
    ['DP-7F3K-X92M-Q8PR', 'DP-7F3K-X92M-Q8PR'],
    ['dp 7f3k x92m q8pr', 'DP-7F3K-X92M-Q8PR'],
    ['7F3KX92MQ8PR', 'DP-7F3K-X92M-Q8PR'],
  ])('accepts %s', (input, expected) => {
    expect(normalizePairingKey(input)).toBe(expected);
  });

  it.each(['', 'DP-7F3K-X92M', 'DP-0F3K-X92M-Q8PR', 'DP-7F3K-X92M-Q8PR-AAAA', 'DP-IL3K-X92M-Q8PR'])(
    'rejects %s',
    (input) => {
      expect(normalizePairingKey(input)).toBeNull();
    },
  );
});

describe('AuthManager', () => {
  it('starts disconnected', async () => {
    const { auth } = setup(vi.fn());
    expect(await auth.initialize()).toBe('NOT_CONNECTED');
  });

  it('pairs with a valid key and stores the credential securely', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(pairResponse());
    const { auth, api, secrets, state } = setup(fetchMock);
    const states: string[] = [];
    auth.onDidChange((s) => states.push(s));

    const result = await auth.connect(api, 'dp-7f3k-x92m-q8pr', device);

    expect(states).toEqual(['PAIRING', 'CONNECTED']);
    expect(result.device.deviceId).toBe('dev-1');
    expect(secrets.values.get('devpulse.deviceCredential')).toBe('dpd_issued');
    // The credential and pairing key never land in plain state.
    expect(JSON.stringify(state.getGlobal('devpulse.device'))).not.toContain('dpd_');
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as { key: string };
    expect(body.key).toBe('DP-7F3K-X92M-Q8PR');
  });

  it('rejects malformed keys without calling the server', async () => {
    const fetchMock = vi.fn<FetchLike>();
    const { auth, api } = setup(fetchMock);
    await expect(auth.connect(api, 'hello', device)).rejects.toMatchObject({
      reason: 'INVALID_KEY_FORMAT',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.authState).toBe('NOT_CONNECTED');
  });

  it.each([
    [400, 'KEY_REJECTED'],
    [429, 'RATE_LIMITED'],
    [500, 'UNEXPECTED'],
  ])('reports HTTP %i during pairing as %s', async (status, reason) => {
    const { auth, api } = setup(vi.fn<FetchLike>().mockResolvedValue(errorResponse(status, 'x')));
    const error = await auth.connect(api, 'DP-7F3K-X92M-Q8PR', device).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PairingError);
    expect((error as PairingError).reason).toBe(reason);
    expect(auth.authState).toBe('NOT_CONNECTED');
  });

  it('reports an unreachable backend', async () => {
    const { auth, api } = setup(vi.fn<FetchLike>().mockRejectedValue(new TypeError('down')));
    await expect(auth.connect(api, 'DP-7F3K-X92M-Q8PR', device)).rejects.toMatchObject({
      reason: 'SERVER_UNREACHABLE',
    });
  });

  it('marks the device revoked on 401 and stops providing the credential', async () => {
    const { auth, api, secrets } = setup(vi.fn<FetchLike>().mockResolvedValue(pairResponse()));
    await auth.connect(api, 'DP-7F3K-X92M-Q8PR', device);
    const handled = await auth.handleApiError(new ApiError('DEVICE_REVOKED', 'revoked'));
    expect(handled).toBe(true);
    expect(auth.authState).toBe('REVOKED');
    expect(secrets.values.size).toBe(0);
    expect(await auth.credentialFor(BASE)).toBeUndefined();
    // Device info is kept so the UI can offer to reconnect; state survives a restart.
    expect(auth.device?.deviceId).toBe('dev-1');
    expect(await auth.initialize()).toBe('REVOKED');
  });

  it('never sends the credential to a different server URL', async () => {
    const { auth, api, setBase } = setup(vi.fn<FetchLike>().mockResolvedValue(pairResponse()));
    await auth.connect(api, 'DP-7F3K-X92M-Q8PR', device);
    expect(await auth.credentialFor(BASE)).toBe('dpd_issued');
    setBase('https://evil.example.com/api/v1');
    expect(await auth.initialize()).toBe('ERROR');
    expect(await auth.credentialFor('https://evil.example.com/api/v1')).toBeUndefined();
  });

  it('detects a missing credential as expired authentication', async () => {
    const { auth, api, secrets } = setup(vi.fn<FetchLike>().mockResolvedValue(pairResponse()));
    await auth.connect(api, 'DP-7F3K-X92M-Q8PR', device);
    secrets.values.clear();
    const fresh = new AuthManager(
      new CredentialStore(secrets),
      // Reuse the same state by reading through the old manager's store.
      (auth as unknown as { state: StateStore }).state,
      new FakeClock(),
      silentLogger,
      () => BASE,
    );
    expect(await fresh.initialize()).toBe('AUTH_EXPIRED');
  });

  it('disconnects: revokes remotely, then clears credentials and device state', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(pairResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { auth, api, secrets } = setup(fetchMock);
    await auth.connect(api, 'DP-7F3K-X92M-Q8PR', device);
    await auth.disconnect(api, true);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${BASE}/integrations/extension/disconnect`);
    expect(secrets.values.size).toBe(0);
    expect(auth.device).toBeUndefined();
    expect(auth.authState).toBe('NOT_CONNECTED');
  });

  it('still disconnects locally when the server is unreachable', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(pairResponse())
      .mockRejectedValueOnce(new TypeError('offline'));
    const { auth, api } = setup(fetchMock);
    await auth.connect(api, 'DP-7F3K-X92M-Q8PR', device);
    await auth.disconnect(api, true);
    expect(auth.authState).toBe('NOT_CONNECTED');
  });

  it('reconnects with a new credential and reports an account change', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(pairResponse('dpd_one', 'sam'))
      .mockResolvedValueOnce(pairResponse('dpd_two', 'alex'));
    const { auth, api, secrets } = setup(fetchMock);
    await auth.connect(api, 'DP-7F3K-X92M-Q8PR', device);
    await auth.handleApiError(new ApiError('DEVICE_REVOKED', 'revoked'));
    const result = await auth.connect(api, 'DP-AAAA-BBBB-CCCC', device);
    expect(result.accountChanged).toBe(true);
    expect(secrets.values.get('devpulse.deviceCredential')).toBe('dpd_two');
    expect(auth.authState).toBe('CONNECTED');
  });
});

describe('defaultDeviceName', () => {
  it('uses the editor and platform, not the hostname', () => {
    expect(defaultDeviceName('Visual Studio Code', 'linux')).toBe('VS Code on Linux');
    expect(defaultDeviceName('Visual Studio Code - Insiders', 'darwin')).toBe(
      'VS Code - Insiders on macOS',
    );
  });
});
