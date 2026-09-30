import { describe, expect, it, vi } from 'vitest';
import { ApiClient, type FetchLike } from '../../src/sync/apiClient';
import { ApiError, retryAfterMs } from '../../src/sync/apiErrors';
import { silentLogger } from '../../src/utils/logger';

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(fetchImpl: FetchLike, credential: string | null = 'dpd_secret') {
  return new ApiClient({
    baseUrl: () => ({ ok: true, url: 'http://localhost:4000/api/v1' }),
    credential: () => Promise.resolve(credential ?? undefined),
    userAgent: 'test',
    logger: silentLogger,
    fetch: fetchImpl,
    timeoutMs: 50,
  });
}

const config = {
  idleTimeoutMinutes: 5,
  trackBranchNames: true,
  trackRepositoryUrl: false,
  heartbeatIntervalSeconds: 60,
};

describe('ApiClient', () => {
  it('pairs without sending a credential', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      json(201, {
        data: {
          credential: 'dpd_new',
          device: { id: 'd1', name: 'Laptop' },
          account: { username: 'sam', fullName: 'Sam' },
          config,
        },
      }),
    );
    const result = await client(fetchMock).integrations.pair({
      key: 'DP-AAAA-BBBB-CCCC',
      device: { name: 'Laptop' },
    });
    expect(result.data.credential).toBe('dpd_new');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:4000/api/v1/integrations/pair');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('sends the device credential on authenticated endpoints', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      json(200, {
        data: {
          config,
          device: { id: 'd1', name: 'L' },
          account: { username: 'a', fullName: 'A' },
        },
      }),
    );
    await client(fetchMock).integrations.config();
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer dpd_secret');
  });

  it('refuses authenticated calls without a credential', async () => {
    const fetchMock = vi.fn<FetchLike>();
    await expect(client(fetchMock, null).integrations.config()).rejects.toMatchObject({
      kind: 'NOT_CONNECTED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'API_VALIDATION_ERROR'],
    [401, 'DEVICE_REVOKED'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(json(status, { error: { code: 'X', message: 'Nope', details: [] } }));
    await expect(client(fetchMock).integrations.config()).rejects.toMatchObject({
      kind,
      status,
      message: 'Nope',
    });
  });

  it('reports network failures and timeouts as offline errors', async () => {
    const down = vi.fn<FetchLike>().mockRejectedValue(new TypeError('fetch failed'));
    const error = await client(down)
      .health.ping()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('NETWORK_ERROR');
    expect((error as ApiError).offline).toBe(true);

    const hang = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    await expect(client(hang).health.ping()).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('rejects malformed success responses', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(json(200, { data: { config: {} } }));
    await expect(client(fetchMock).integrations.config()).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
  });

  it('refuses to send requests to an invalid base URL', async () => {
    const fetchMock = vi.fn<FetchLike>();
    const api = new ApiClient({
      baseUrl: () => ({ ok: false, reason: 'insecure' }),
      credential: () => Promise.resolve('dpd_x'),
      userAgent: 't',
      logger: silentLogger,
      fetch: fetchMock,
    });
    await expect(api.integrations.config()).rejects.toMatchObject({ kind: 'CONFIGURATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes the retry delay of rate-limited responses', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        json(
          429,
          { error: { code: 'RATE_LIMITED', message: 'Slow down' } },
          { RateLimit: '"120-in-1min"; r=0; t=42' },
        ),
      );
    await expect(client(fetchMock).activity.ingestEvents([])).rejects.toMatchObject({
      kind: 'RATE_LIMITED',
      retryAfterMs: 42_000,
    });
  });
});

describe('retryAfterMs', () => {
  it('reads Retry-After seconds and dates', () => {
    expect(retryAfterMs(new Headers({ 'Retry-After': '7' }))).toBe(7000);
    expect(retryAfterMs(new Headers({ 'Retry-After': new Date(10_000).toUTCString() }), 4000)).toBe(
      6000,
    );
    expect(retryAfterMs(new Headers())).toBeUndefined();
  });
});
