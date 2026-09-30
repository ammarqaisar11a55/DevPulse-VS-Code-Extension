# DevPulse API integration

How the VS Code extension uses the DevPulse REST API. The server-side contract is documented in
the web app repository (`DevPulse-Web/docs/API.md`, schemas in `packages/shared`); this document
covers the client's side of it.

## Authentication

The extension authenticates every request (except pairing and health) with a **device
credential**: `Authorization: Bearer dpd_…`.

1. The user generates a one-time connection key in the web app (**Settings → Integrations**).
2. `POST /integrations/pair` with the normalized key (`DP-XXXX-XXXX-XXXX`) and device metadata
   (`name`, `platform`, `editor`, `editorVersion`, `extensionVersion`; no hostname) returns the
   credential, the device, the account and tracking preferences.
3. The credential is stored in VS Code SecretStorage and cached in memory. It is sent only to the
   base URL it was issued by: if `devpulse.api.baseUrl` changes, requests stop until the user
   reconnects, so a changed URL can never receive the credential.

All HTTP goes through one client (`src/sync/apiClient.ts`) that owns the base URL, headers, the
`Authorization` header, a 15-second timeout, response validation and error classification. No
other module builds requests or sees the credential. Redirects are refused.

## Endpoints and rules

| Method  | Path                                 | Notes                                                                                   |
| ------- | ------------------------------------ | --------------------------------------------------------------------------------------- |
| `POST`  | `/integrations/pair`                 | Public; `400` for invalid, expired, used or revoked keys (one generic message)          |
| `GET`   | `/integrations/extension/config`     | On connect and every 3 hours; `idleTimeoutMinutes` is used unless set locally           |
| `GET`   | `/integrations/extension/summary`    | Every 5 minutes; a `404` (older servers) disables it and local totals are shown instead |
| `PATCH` | `/integrations/extension/device`     | `{ name }` (1–60); a `404` falls back to the web Devices page                           |
| `POST`  | `/integrations/extension/disconnect` | Best effort during Disconnect; local credentials are deleted either way                 |
| `POST`  | `/activity/sessions`                 | `clientSessionId` makes it idempotent (`201` created, `200` existing)                   |
| `PATCH` | `/activity/sessions/:id`             | Cumulative totals; `lastHeartbeatAt` while open, `endedAt` to finish                    |
| `POST`  | `/activity/events`                   | Up to 500 events; `clientEventId` deduplicates retries                                  |
| `GET`   | `/health`                            | Diagnostics only                                                                        |

### Sessions

- A session is created with its start time, project reference (`{ name }`, plus `repositoryUrl`
  when allowed), language, repository and branch. Finished sessions that were never uploaded are
  created in one request with `endedAt` and `activeSeconds`.
- Open sessions are heartbeated about once a minute (at least every 5 minutes) with cumulative
  `activeSeconds`, the per-language breakdown (top 20), and counters. A heartbeat never claims the
  session is open later than 90 seconds after the recording window last confirmed it, so a sync
  right after waking from sleep cannot stretch a session.
- Ending sends the same `endedAt` on every retry, which the server accepts idempotently.
- Before upload the client checks the server's timing rules (no start or end in the future, end
  after start, at most 24 hours) and does not send sessions that would be rejected.

### Events

Events are uploaded after their session exists on the server, because `sessionId` must be the
server's id; a segment waits while its session is still being created. Metadata is limited to the
server's allow-list (`fileExtension`, `linesAdded`, `linesRemoved`, `commitCount`, `idleSeconds`,
`debugType`, `reason`), and the privacy policy is applied again at upload time.

## Error handling

| Category               | Trigger                            | Client behavior                                                                                                                                                                  |
| ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NETWORK_ERROR`        | Connection failure                 | Offline state; keep queueing; retry with backoff                                                                                                                                 |
| `TIMEOUT`              | No response in 15 s                | Same as network errors                                                                                                                                                           |
| `DEVICE_REVOKED`       | `401` / `403` on a device endpoint | Delete the credential, stop tracking and syncing, notify once, offer Reconnect; no retry                                                                                         |
| `API_VALIDATION_ERROR` | `400` / `413`                      | Session: stop uploading it. Events: move the segment to a bounded `failed/` folder                                                                                               |
| `NOT_FOUND`            | `404`                              | Session deleted on the web or from an earlier pairing: stop uploading it (never recreate, which could duplicate time); events are resent without the session id                  |
| `CONFLICT`             | `409` on a session update          | The server already ended it (stale timeout, another window, revocation): accept the server's version; an open local session is ended and a new one starts with the next activity |
| `RATE_LIMITED`         | `429`                              | Wait for `Retry-After` or the `RateLimit` header's reset, at least the backoff delay                                                                                             |
| `SERVER_ERROR`         | `5xx`                              | Retry with backoff                                                                                                                                                               |
| `INVALID_RESPONSE`     | Response fails validation          | Treated as a server error                                                                                                                                                        |
| `CONFIGURATION_ERROR`  | Invalid or insecure base URL       | No request is made; the user is told how to fix the setting                                                                                                                      |
| `STORAGE_ERROR`        | SecretStorage unavailable          | Pairing explains that an OS keychain is needed; nothing is stored insecurely                                                                                                     |
| Workspace unsupported  | Virtual or untrusted workspace     | Tracking continues without Git metadata; shown as a limitation                                                                                                                   |

Backoff: attempt 1 immediately, then after 5 s, 15 s, 30 s, 1 min and 5 min (with ±10 % jitter),
capped at one hour for server-requested delays, reset after any successful pass.

## Differences from the original extension plan

The implementation follows the real API instead of the examples in the plan:

- **No access/refresh tokens.** The server issues one long-lived, revocable device credential, so
  there is no token refresh. A `401` means the device was revoked (or disconnected elsewhere) and
  the user must pair again; the `AUTH_EXPIRED` state is used when device information exists but
  the credential is missing from SecretStorage.
- **Device-authenticated summary and rename.** `GET /analytics/overview` and
  `PATCH /devices/:id` require a signed-in web user, so two additive endpoints were added to the
  web app (`GET /integrations/extension/summary` and `PATCH /integrations/extension/device`). The
  extension degrades gracefully on servers without them.
- **File-level tracking** sends file extensions and counts only: the API cannot store file names
  or paths by design.
- **One open session per device.** Starting a session from another window of the same editor
  closes the previous one on the server; the extension handles the resulting `409` as described
  above.
