import { randomUUID } from 'node:crypto';
import type { FetchLike } from '../../src/sync/apiClient';

interface ServerSession {
  id: string;
  clientSessionId: string;
  status: 'ACTIVE' | 'ENDED';
  startedAt: string;
  endedAt: string | null;
  lastHeartbeatAt: string | null;
  activeSeconds: number;
  body: Record<string, unknown>;
}

/**
 * In-memory stand-in for the DevPulse API that follows the real contract: idempotent session
 * creation by clientSessionId, 409 for timing changes to ended sessions, event deduplication
 * by clientEventId, 401 for revoked devices.
 */
export class FakeServer {
  sessions = new Map<string, ServerSession>();
  events = new Map<string, Record<string, unknown>>();
  requests: { method: string; path: string; body: unknown }[] = [];
  offline = false;
  revoked = false;
  rateLimitSeconds: number | undefined;
  failNext: number | undefined;
  credential = 'dpd_test';
  /** One-time pairing keys still valid. */
  pairingKeys = new Set<string>(['DP-TEST-KEYS-AAAA']);
  deviceName = 'VS Code on Linux';
  summary = { timezone: 'UTC', todaySeconds: 0, weekSeconds: 0 };

  get fetch(): FetchLike {
    return async (url, init) => this.handle(url, init);
  }

  private json(status: number, body?: unknown, headers: Record<string, string> = {}) {
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  }

  private error(status: number, code: string, message: string) {
    return this.json(status, { error: { code, message, requestId: 'req' } });
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    if (this.offline) throw new TypeError('fetch failed');
    const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    this.requests.push({ method, path, body });

    if (this.failNext) {
      const status = this.failNext;
      this.failNext = undefined;
      return this.error(status, 'INTERNAL_ERROR', 'Boom');
    }
    if (this.rateLimitSeconds !== undefined) {
      return this.json(
        429,
        { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
        { RateLimit: `"120-in-1min"; r=0; t=${this.rateLimitSeconds}` },
      );
    }
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    if (path !== '/integrations/pair' && path !== '/health') {
      if (this.revoked || auth !== `Bearer ${this.credential}`) {
        return this.error(401, 'UNAUTHORIZED', 'This device is not connected.');
      }
    }

    if (method === 'GET' && path === '/health') return this.json(200, { data: { status: 'ok' } });
    if (method === 'POST' && path === '/integrations/pair') return this.pair(body!);
    if (method === 'GET' && path === '/integrations/extension/config') {
      return this.json(200, {
        data: {
          config: {
            idleTimeoutMinutes: 5,
            trackBranchNames: true,
            trackRepositoryUrl: true,
            heartbeatIntervalSeconds: 60,
          },
          device: { id: 'device-1', name: this.deviceName },
          account: { username: 'sam', fullName: 'Sam Carter' },
        },
      });
    }
    if (method === 'GET' && path === '/integrations/extension/summary') {
      return this.json(200, { data: this.summary });
    }
    if (method === 'PATCH' && path === '/integrations/extension/device') {
      this.deviceName = String(body?.name ?? '').trim();
      return this.json(200, { data: { id: 'device-1', name: this.deviceName } });
    }
    if (method === 'POST' && path === '/integrations/extension/disconnect') {
      this.revoked = true;
      return this.json(204);
    }
    if (method === 'POST' && path === '/activity/sessions') return this.createSession(body!);
    const patch = /^\/activity\/sessions\/([\w-]+)$/.exec(path);
    if (method === 'PATCH' && patch) return this.updateSession(patch[1]!, body!);
    if (method === 'POST' && path === '/activity/events') return this.ingest(body!);
    return this.error(404, 'NOT_FOUND', 'Route not found');
  }

  private pair(body: Record<string, unknown>) {
    const key = String(body.key);
    if (!this.pairingKeys.delete(key)) {
      return this.error(400, 'VALIDATION_ERROR', 'This connection key is invalid or has expired.');
    }
    this.revoked = false;
    const device = body.device as { name?: string } | undefined;
    this.deviceName = device?.name ?? this.deviceName;
    return this.json(201, {
      data: {
        credential: this.credential,
        device: { id: 'device-1', name: this.deviceName },
        account: { username: 'sam', fullName: 'Sam Carter' },
        config: {
          idleTimeoutMinutes: 5,
          trackBranchNames: true,
          trackRepositoryUrl: true,
          heartbeatIntervalSeconds: 60,
        },
      },
    });
  }

  private createSession(body: Record<string, unknown>) {
    const clientSessionId = String(body.clientSessionId);
    const existing = [...this.sessions.values()].find((s) => s.clientSessionId === clientSessionId);
    if (existing) return this.json(200, { data: this.dto(existing) });
    // A new session supersedes any session this device left open.
    for (const session of this.sessions.values()) {
      if (session.status === 'ACTIVE') {
        session.status = 'ENDED';
        session.endedAt = session.lastHeartbeatAt ?? session.startedAt;
      }
    }
    const ended = typeof body.endedAt === 'string';
    const session: ServerSession = {
      id: randomUUID(),
      clientSessionId,
      status: ended ? 'ENDED' : 'ACTIVE',
      startedAt: String(body.startedAt),
      endedAt: ended ? String(body.endedAt) : null,
      lastHeartbeatAt: ended ? String(body.endedAt) : String(body.startedAt),
      activeSeconds: ended ? Number(body.activeSeconds ?? 0) : 0,
      body,
    };
    this.sessions.set(session.id, session);
    return this.json(201, { data: this.dto(session) });
  }

  private updateSession(id: string, body: Record<string, unknown>) {
    const session = this.sessions.get(id);
    if (!session) return this.error(404, 'NOT_FOUND', 'Session not found');
    const timing = 'endedAt' in body || 'lastHeartbeatAt' in body || 'activeSeconds' in body;
    if (timing && session.status === 'ENDED') {
      if (body.endedAt && body.endedAt === session.endedAt)
        return this.json(200, { data: this.dto(session) });
      return this.error(409, 'CONFLICT', 'This session has already ended');
    }
    if (typeof body.activeSeconds === 'number') session.activeSeconds = body.activeSeconds;
    if (typeof body.lastHeartbeatAt === 'string') session.lastHeartbeatAt = body.lastHeartbeatAt;
    if (typeof body.endedAt === 'string') {
      session.endedAt = body.endedAt;
      session.status = 'ENDED';
    }
    session.body = { ...session.body, ...body };
    return this.json(200, { data: this.dto(session) });
  }

  private ingest(body: Record<string, unknown>) {
    const events = body.events as Record<string, unknown>[];
    let accepted = 0;
    for (const event of events) {
      if (event.sessionId && !this.sessions.has(String(event.sessionId))) {
        return this.error(404, 'NOT_FOUND', 'Session not found');
      }
    }
    for (const event of events) {
      const id = String(event.clientEventId);
      if (this.events.has(id)) continue;
      this.events.set(id, event);
      accepted++;
    }
    return this.json(202, { data: { accepted, duplicates: events.length - accepted } });
  }

  private dto(session: ServerSession) {
    return {
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      activeSeconds: session.activeSeconds,
    };
  }
}
