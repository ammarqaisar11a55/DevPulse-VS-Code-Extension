import type { Logger } from '../utils/logger';
import type { UrlCheck } from '../utils/url';
import { ValidationError } from '../utils/validate';
import { ApiError, retryAfterMs } from './apiErrors';
import {
  parsers,
  type ActivityEventDto,
  type CreateSessionRequest,
  type DeviceRefDto,
  type ExtensionConfigResponse,
  type ExtensionSummaryDto,
  type IngestEventsResult,
  type PairDeviceRequest,
  type PairDeviceResponse,
  type SessionDto,
  type UpdateSessionRequest,
} from './apiTypes';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Validated base URL including `/api/v1`. */
  baseUrl: () => UrlCheck;
  /** Device credential from SecretStorage. */
  credential: () => Promise<string | undefined>;
  userAgent: string;
  logger: Logger;
  fetch?: FetchLike;
  timeoutMs?: number;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface RequestOptions<T> {
  body?: unknown;
  /** Send the device credential. Defaults to true. */
  auth?: boolean;
  parse: (data: unknown) => T;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

interface ErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
    details?: unknown;
  };
}

function kindForStatus(status: number): ApiError['kind'] {
  if (status === 401) return 'DEVICE_REVOKED';
  if (status === 400 || status === 413 || status === 422) return 'API_VALIDATION_ERROR';
  if (status === 403) return 'DEVICE_REVOKED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  return 'SERVER_ERROR';
}

/**
 * The only place that talks HTTP. Owns the base URL, headers, the Authorization header,
 * timeouts and error parsing; endpoint groups below expose typed calls.
 */
export class ApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  readonly integrations = {
    /** Exchanges a one-time pairing key for a device credential. Public endpoint. */
    pair: (body: PairDeviceRequest) =>
      this.request<PairDeviceResponse>('POST', '/integrations/pair', {
        body,
        auth: false,
        parse: (data) => parsers.pair(data),
      }),
    config: () =>
      this.request<ExtensionConfigResponse>('GET', '/integrations/extension/config', {
        parse: (data) => parsers.config(data),
      }),
    /** Revokes this device's own credential. */
    disconnect: () =>
      this.request<null>('POST', '/integrations/extension/disconnect', { parse: () => null }),
  };

  readonly devices = {
    /** Renames the connected device (device-authenticated endpoint). */
    rename: (name: string) =>
      this.request<DeviceRefDto>('PATCH', '/integrations/extension/device', {
        body: { name },
        parse: (data) => parsers.device(data),
      }),
  };

  readonly activity = {
    createSession: (body: CreateSessionRequest) =>
      this.request<SessionDto>('POST', '/activity/sessions', {
        body,
        parse: (data) => parsers.session(data),
      }),
    updateSession: (id: string, body: UpdateSessionRequest) =>
      this.request<SessionDto>('PATCH', `/activity/sessions/${encodeURIComponent(id)}`, {
        body,
        parse: (data) => parsers.session(data),
      }),
    ingestEvents: (events: ActivityEventDto[]) =>
      this.request<IngestEventsResult>('POST', '/activity/events', {
        body: { events },
        parse: (data) => parsers.ingest(data),
      }),
  };

  readonly analytics = {
    /** Account-wide totals for today and this week. */
    summary: () =>
      this.request<ExtensionSummaryDto>('GET', '/integrations/extension/summary', {
        parse: (data) => parsers.summary(data),
      }),
  };

  readonly health = {
    ping: () => this.request<null>('GET', '/health', { auth: false, parse: () => null }),
  };

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request<T>(
    method: Method,
    path: string,
    options: RequestOptions<T>,
  ): Promise<ApiResponse<T>> {
    const base = this.options.baseUrl();
    if (!base.ok) throw new ApiError('CONFIGURATION_ERROR', base.reason);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.options.userAgent,
      'X-DevPulse-Client': 'vscode',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.auth !== false) {
      const credential = await this.options.credential();
      if (!credential) throw new ApiError('NOT_CONNECTED', 'DevPulse is not connected.');
      headers.Authorization = `Bearer ${credential}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${base.url}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      this.options.logger.debug(`${method} ${path} failed`, { timedOut, error });
      throw new ApiError(
        timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        timedOut ? 'The DevPulse server did not respond in time.' : 'Cannot reach DevPulse.',
      );
    } finally {
      clearTimeout(timer);
    }

    const requestId = response.headers.get('x-request-id') ?? undefined;
    this.options.logger.debug(`${method} ${path} → ${response.status}`, {
      ms: Date.now() - started,
      requestId,
    });

    const text = await response.text().catch(() => '');
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!response.ok) throw this.toError(response, json, requestId);

    try {
      const payload =
        response.status === 204 ? null : (json as { data?: unknown } | undefined)?.data;
      return { status: response.status, data: options.parse(payload) };
    } catch (error) {
      const message = error instanceof ValidationError ? error.message : 'Malformed response';
      throw new ApiError('INVALID_RESPONSE', `Unexpected response from DevPulse: ${message}`, {
        status: response.status,
        ...(requestId ? { requestId } : {}),
      });
    }
  }

  private toError(response: Response, json: unknown, requestId: string | undefined): ApiError {
    const body = (json ?? {}) as ErrorBody;
    const code = typeof body.error?.code === 'string' ? body.error.code : undefined;
    const serverMessage =
      typeof body.error?.message === 'string' ? body.error.message : response.statusText;
    const details = Array.isArray(body.error?.details)
      ? body.error.details.flatMap((item: unknown) => {
          const detail = item as { path?: unknown; message?: unknown };
          return typeof detail.path === 'string' && typeof detail.message === 'string'
            ? [{ path: detail.path, message: detail.message }]
            : [];
        })
      : [];
    const kind = kindForStatus(response.status);
    const delay = retryAfterMs(response.headers);
    return new ApiError(kind, serverMessage || `Request failed (${response.status})`, {
      status: response.status,
      ...(code ? { code } : {}),
      ...(requestId ? { requestId } : {}),
      ...(delay !== undefined ? { retryAfterMs: delay } : {}),
      details,
    });
  }
}
