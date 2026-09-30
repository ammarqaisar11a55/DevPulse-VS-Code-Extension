/** Categories the rest of the extension reacts to; see mapping in errorPolicy. */
export type ApiErrorKind =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'NOT_CONNECTED'
  | 'DEVICE_REVOKED'
  | 'API_VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'INVALID_RESPONSE'
  | 'CONFIGURATION_ERROR';

export interface ApiErrorInit {
  status?: number;
  code?: string;
  requestId?: string;
  retryAfterMs?: number;
  details?: { path: string; message: string }[];
}

export class ApiError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly details: { path: string; message: string }[];

  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    init: ApiErrorInit = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.details = init.details ?? [];
  }

  /** Temporary failures worth retrying with backoff. */
  get retryable(): boolean {
    return (
      this.kind === 'NETWORK_ERROR' ||
      this.kind === 'TIMEOUT' ||
      this.kind === 'RATE_LIMITED' ||
      this.kind === 'SERVER_ERROR'
    );
  }

  /** Failures meaning the server could not be reached at all. */
  get offline(): boolean {
    return this.kind === 'NETWORK_ERROR' || this.kind === 'TIMEOUT';
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Reads the delay requested by the server from `Retry-After` (seconds or HTTP date) or the
 * IETF draft `RateLimit` header (`"policy";r=0;t=30`) that the DevPulse API sends.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const rateLimit = headers.get('ratelimit') ?? headers.get('ratelimit-reset');
  if (rateLimit) {
    const match = /(?:^|[;,\s])t=(\d+)/.exec(rateLimit) ?? /^\s*(\d+)\s*$/.exec(rateLimit);
    if (match?.[1]) return Number(match[1]) * 1000;
  }
  return undefined;
}
