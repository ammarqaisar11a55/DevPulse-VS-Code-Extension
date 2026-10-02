# DevPulse — Developer Productivity

DevPulse tracks your coding time privately inside VS Code and syncs it to your DevPulse account,
where the web app turns it into dashboards, goals and analytics. The extension collects **activity
metadata only**: how long you code, in which project and language. It never records keystrokes,
clipboard contents or source code.

- [Features](#features)
- [Installation](#installation)
- [Connecting your account](#connecting-your-account)
- [How tracking works](#how-tracking-works)
- [Privacy](#privacy)
- [Settings](#settings)
- [Commands](#commands)
- [Offline behavior](#offline-behavior)
- [Supported platforms and workspaces](#supported-platforms-and-workspaces)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Testing](#testing)
- [Packaging](#packaging)
- [API integration](#api-integration)

## Features

- **Automatic coding-time tracking** from editor activity, with idle detection and sessions that
  survive file switching, short breaks and window reloads.
- **Projects and languages**: activity is attributed to the workspace folder you are working in
  (multi-root aware) and to VS Code's language of the file.
- **Git metadata** (optional): branch and commit counts, read through VS Code's built-in Git
  extension.
- **Offline first**: everything is queued on disk and uploaded when the connection returns, with no
  duplicates.
- **Status bar** with today's time and quick actions, an **Activity Bar overview**, a small
  **summary dashboard**, and a **diagnostics report** that is safe to share.
- **Privacy controls**: conservative defaults, pause/resume, and project, folder and language
  exclusions.

## Installation

Install **DevPulse — Developer Productivity** from the VS Code Marketplace, or install a packaged
build:

```bash
code --install-extension devpulse-1.0.0.vsix
```

Requires VS Code 1.90 or newer.

## Connecting your account

The extension never asks for your DevPulse password. It uses a one-time connection key:

1. In the DevPulse web app open **Settings → Integrations → VS Code** and click
   **Generate connection key** (for example `DP-7F3K-X92M-Q8PR`). The key works once and expires
   after 10 minutes.
2. In VS Code run **DevPulse: Connect Account** (Command Palette, the status bar item, or the
   DevPulse Activity Bar view) and paste the key. Case, spaces and dashes do not matter.
3. DevPulse registers this editor as a device and stores the device credential in VS Code's
   encrypted **SecretStorage**. Tracking starts with your next edit.

You can rename the device with **DevPulse: Rename Device**; the name appears on the web app's
**Devices** page. If you use a self-hosted DevPulse server, set `devpulse.api.baseUrl` and
`devpulse.web.url` first (see [Settings](#settings)).

**Disconnecting.** **DevPulse: Disconnect Account** ends the current session, makes a final sync
attempt, revokes the device on the server and deletes the credential. Anything that still could
not be uploaded is deleted from this computer, and the confirmation tells you how much. Data already
in your account is kept. Revoking the device from the web app has the same effect on the server;
the extension notices on its next request, stops tracking and offers to reconnect. Unsynced
activity is kept until you reconnect to the same account.

## How tracking works

DevPulse listens to VS Code editor events: switching editors, edits in visible editors, cursor and
selection changes, scrolling, saves, notebook selection, window interaction, and optionally
debugging and terminal focus. Each event only updates an in-memory "last activity" time.

- **Active time.** Time between two activity signals counts as active when the gap is at most the
  **idle threshold** (default 5 minutes, or the idle timeout from your DevPulse account settings).
  Longer gaps are idle time.
- **Sessions.** A session starts with your first activity in a workspace and continues while you
  switch files, take short breaks or reload the window. It ends after the **session timeout**
  (default 15 minutes without activity), when you pause tracking, or when you start editing in a
  different project. An ended session's end time is your last activity, so a laptop that slept
  overnight never produces an 18-hour session. Sessions are capped below the server's 24-hour
  limit.
- **Window focus.** While the VS Code window is not focused no time is counted; counting resumes
  with your next edit or navigation after you return (configurable with
  `devpulse.tracking.pauseWhenUnfocused`).
- **Manual mode.** With `devpulse.tracking.mode` set to `manual`, sessions only start and end with
  **DevPulse: Start Session** and **DevPulse: End Session**. Idle time is still excluded from
  active time.
- **Multiple windows.** Each window tracks its own workspace. Because the DevPulse server keeps one
  open session per device, switching between windows closes the previous window's session on the
  server; the next activity there starts a new one.
- **Aggregation.** Instead of one upload per keystroke, activity is summarized: sessions are
  updated with cumulative totals about once a minute (the heartbeat), and editor signals are
  folded into one `ACTIVITY` event per five-minute window.

The status bar shows today's coding time. When the server is reachable it shows your account-wide
total across all devices; otherwise the time recorded on this computer.

## Privacy

DevPulse is an activity collector, not a surveillance tool. Defaults are conservative, and every
upload passes through a privacy filter that also re-applies your current settings right before
sending.

### What DevPulse sends

| Data                                                                             | When                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Session start and end times, active seconds, and periodic heartbeats             | Always while tracking                                                     |
| Project name (the workspace folder name, never its path)                         | Always while tracking                                                     |
| Programming language ids (for example `typescript`) and time per language        | `devpulse.privacy.trackLanguage` (on)                                     |
| Activity events: type, timestamp, idle seconds, end reason, debugger type        | Always while tracking (debugger type only with debugging)                 |
| Git branch name, and the number of commits                                       | `devpulse.privacy.trackGit` (on); branches also need your account setting |
| Repository URL such as `github.com/you/app` (credentials always removed)         | `devpulse.privacy.trackRepository` (off) and account setting              |
| File extensions (such as `.ts`) and counts of changed files and lines            | `devpulse.privacy.trackFileNames` (off)                                   |
| Device name, operating system family, editor name and version, extension version | At pairing and in request headers                                         |

Your DevPulse account settings can switch branch and repository tracking off for all devices; both
the extension and the server then drop them.

### What DevPulse never sends or records

- **Keystrokes.** DevPulse does not log keys. When a document changes, the inserted text is
  inspected in memory only to count line breaks for the line counters, then discarded.
- **Source code or file contents**, diffs and commit messages.
- **File names and paths.** Not even with file metadata enabled: only the extension is sent.
  Files that look sensitive (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `credentials.*`,
  `secrets.*`, `.npmrc` and similar) never contribute any file metadata.
- **Clipboard contents**, **screenshots**, and **terminal input or output** (terminal tracking
  only notices that you focused the terminal).
- **Environment variable values, passwords and secrets.**
- **System-wide keyboard or mouse activity.** Only VS Code's own editor events are used.
- **Your hostname** or other hardware details.

### Stored on this computer

- The device credential, in VS Code **SecretStorage** (your operating system's keychain). It is
  never written to settings, logs or plain files. If no keychain is available, DevPulse refuses to
  store the credential rather than storing it insecurely.
- Queued events and recent sessions (the same data listed above) in VS Code's per-extension storage
  folder, kept for about a week after upload so local totals and retries work. **DevPulse: Clear
  Local Activity Queue** deletes queued events that have not been uploaded.
- Logs in the **DevPulse** output channel: warnings and errors only unless you enable
  `devpulse.logging.enabled`. Credentials, pairing keys and authorization headers are always
  redacted.

### Exclusions and pausing

- **DevPulse: Pause Tracking** stops recording in every window until you resume; nothing that
  happens while paused is recorded or queued.
- **DevPulse: Exclude Current Project** adds the project to `devpulse.exclusions.projects`.
- `devpulse.exclusions.folders` accepts globs such as `~/work/**`, and
  `devpulse.exclusions.languages` accepts language ids such as `markdown` or `plaintext`. Excluded
  work never counts and never creates sessions or events.
- In untrusted workspaces, a workspace's own `.vscode/settings.json` cannot change DevPulse's
  privacy or exclusion settings, and the server URL can only be set in your user settings, so a
  repository cannot redirect your credential.

## Settings

| Setting                                | Default                                          | Description                                                                 |
| -------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| `devpulse.enabled`                     | `true`                                           | Turn the whole extension off without uninstalling it                        |
| `devpulse.statusBar.enabled`           | `true`                                           | Show the status bar item                                                    |
| `devpulse.tracking.enabled`            | `true`                                           | Record activity (off is the same as paused)                                 |
| `devpulse.tracking.mode`               | `automatic`                                      | `automatic` or `manual` sessions                                            |
| `devpulse.tracking.idleThreshold`      | account setting, else `5`                        | Minutes without activity before you are idle (1, 2, 5, 10 or 15)            |
| `devpulse.tracking.sessionTimeout`     | `15`                                             | Minutes of inactivity that end a session (5–120)                            |
| `devpulse.tracking.pauseWhenUnfocused` | `true`                                           | Do not count time while the window is unfocused                             |
| `devpulse.privacy.trackLanguage`       | `true`                                           | Send language ids                                                           |
| `devpulse.privacy.trackFileNames`      | `false`                                          | Send file extensions and changed file/line counts (never names or paths)    |
| `devpulse.privacy.trackRepository`     | `false`                                          | Send the repository URL                                                     |
| `devpulse.privacy.trackGit`            | `true`                                           | Send branch names and commit counts                                         |
| `devpulse.privacy.trackTerminal`       | `false`                                          | Count terminal focus as activity                                            |
| `devpulse.privacy.trackDebugging`      | `true`                                           | Count debugging as activity and send debug start/stop events                |
| `devpulse.exclusions.projects`         | `[]`                                             | Project names that are never tracked                                        |
| `devpulse.exclusions.folders`          | `[]`                                             | Folder globs that are never tracked                                         |
| `devpulse.exclusions.languages`        | `[]`                                             | Language ids that do not count                                              |
| `devpulse.api.baseUrl`                 | `https://devpulse-three-amber.vercel.app/api/v1` | DevPulse API URL (user settings only)                                       |
| `devpulse.web.url`                     | `https://devpulse-three-amber.vercel.app`        | DevPulse web app URL, for Open Dashboard (user settings only)               |
| `devpulse.api.allowInsecureHttp`       | `false`                                          | Allow `http://` on hosts other than `localhost` (development networks only) |
| `devpulse.sync.interval`               | `60`                                             | Seconds between background syncs (30–600)                                   |
| `devpulse.logging.enabled`             | `false`                                          | Detailed, redacted logs in the DevPulse output channel                      |
| `devpulse.logging.level`               | `info`                                           | Minimum level when logging is enabled                                       |

The URL defaults point at a local development server. For a deployed DevPulse, set both URLs, for
example `https://devpulse.example.com/api/v1` and `https://devpulse.example.com`. HTTPS is
required except for `localhost`.

## Commands

All commands are in the Command Palette under **DevPulse**:

| Command                     | What it does                                                  |
| --------------------------- | ------------------------------------------------------------- |
| Connect Account / Reconnect | Pair this editor with a connection key                        |
| Disconnect Account          | Revoke this device and delete its credential                  |
| Pause / Resume Tracking     | Stop or restart recording in all windows                      |
| Start / End Session         | Explicit session control (the default is automatic)           |
| Sync Now                    | Upload immediately and show the result                        |
| Open Dashboard              | Open the web dashboard in your browser                        |
| Show Summary Dashboard      | Open the in-editor summary                                    |
| Open Activity               | Show the DevPulse Activity Bar view                           |
| Rename Device               | Change the device name shown in the web app                   |
| Exclude Current Project     | Never track the current project                               |
| Show Diagnostics            | A support-safe report of the extension's state                |
| Clear Local Activity Queue  | Delete queued events that were not uploaded (asks to confirm) |
| Open Settings / Show Logs   | DevPulse settings and the output channel                      |
| Open DevPulse Website       | Open the DevPulse web app (also a globe icon in the view)     |
| Open GitHub Repository      | Open this extension's source code and issues on GitHub        |

## Offline behavior

When the server cannot be reached DevPulse keeps tracking. Sessions and events are written to disk
and uploaded automatically once the server is reachable again, oldest first and in small batches,
even after VS Code was closed in between. Every session and event carries a client-generated id,
so retries after timeouts or crashes never create duplicates. Failed uploads are retried with
exponential backoff (5 s, 15 s, 30 s, 1 min, then every 5 min) and server rate limits are
respected. The queue is bounded; if it grows large (for example after days offline) DevPulse tells
you how many activities are waiting.

## Supported platforms and workspaces

- **Operating systems:** Windows, macOS and Linux.
- **Workspaces:** single folders, multi-root workspaces (activity goes to the folder containing the
  active file), `.code-workspace` files, and windows without a folder (time is recorded without a
  project).
- **Remote development** (SSH, WSL, Dev Containers, Codespaces): DevPulse runs next to your files,
  so Git metadata works; the credential stays in your local keychain.
- **Virtual workspaces:** time is tracked; Git metadata is unavailable.
- **Untrusted workspaces:** time is tracked; Git metadata is disabled until you trust the folder.

Limitations are shown in the Activity Bar view and in the diagnostics report.

## Troubleshooting

Start with **DevPulse: Show Diagnostics**: it shows the connection, API reachability, queue, last
sync result and settings without any secrets, and you can share it with support.

| Symptom                                | What to do                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "This connection key is invalid"       | Keys work once and expire after 10 minutes. Generate a new one and paste it right away.                                                                    |
| "Cannot reach the DevPulse server"     | Check your network and `devpulse.api.baseUrl`. Activity keeps being recorded and syncs later.                                                              |
| Status bar says **Needs Reconnection** | The device was revoked or the credential is missing. Run **DevPulse: Reconnect Account** with a new key.                                                   |
| "Could not store the credential"       | VS Code's SecretStorage needs an OS keychain. On Linux install and unlock GNOME Keyring or KWallet (see VS Code's "Troubleshooting keychain issues" docs). |
| Server URL changed                     | A credential only works with the server that issued it; reconnect after changing `devpulse.api.baseUrl`.                                                   |
| No time recorded                       | Check that tracking is not paused, the project or language is not excluded, and the window is focused.                                                     |
| Lots of items waiting                  | Run **DevPulse: Sync Now**; the diagnostics report shows the last error.                                                                                   |

For details, enable `devpulse.logging.enabled`, reproduce the problem and run **DevPulse: Show
Logs**. Logs are redacted but review them before sharing.

## Development

Requirements: Node.js 20 or newer and VS Code 1.90 or newer.

```bash
npm install
npm run watch
```

Press **F5** (the **Run Extension** launch configuration) to open an Extension Development Host.
To develop against a local DevPulse server, run the web app's API (`npm run dev` in `DevPulse-Web`)
and keep the default URLs.

| Script                     | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `npm run compile`          | Development build to `dist/`                                      |
| `npm run watch`            | Rebuild on change                                                 |
| `npm run build`            | Minified production build                                         |
| `npm run typecheck`        | Strict TypeScript checks for sources and tests                    |
| `npm run lint`             | ESLint                                                            |
| `npm run format`           | Prettier                                                          |
| `npm test`                 | Unit tests (Vitest)                                               |
| `npm run test:integration` | Integration tests in an Extension Development Host                |
| `npm run test:e2e`         | Opt-in contract test against a running DevPulse API               |
| `npm run package`          | Build `devpulse-<version>.vsix`                                   |
| `npm run test:vsix`        | Install the VSIX in a clean profile and run the integration suite |

### Architecture

```text
src/
├── extension.ts          wiring only: creates modules in dependency order, registers commands
├── activity/             editor signals, idle detection, session state machine, tracking controller
├── auth/                 pairing, credential storage, connection state, account flows
├── workspace/            workspace kinds, project identity, language ids
├── git/                  built-in Git extension adapter and remote URL normalization
├── privacy/              upload policy, exclusions, sensitive files, metadata allow-list
├── sync/                 typed API client, retry/backoff, event recorder, sync engine and scheduler
├── storage/              SecretStorage, Mementos, durable queue and session outbox
├── devices/              device naming and account totals
├── ui/                   status bar, quick menu, Activity Bar view, dashboard webview, notifications
├── diagnostics/          support-safe diagnostics report
└── settings/             settings parsing and change handling
```

Editor events flow one way: `ActivityTracker` → `PrivacyManager` (with workspace and Git
context) → `SessionManager` (the only place session transitions happen) → session outbox and event
queue on disk → `SyncEngine` → API. The UI reads a single `AppState` snapshot. Pure logic (session
math, privacy, sync, storage) has no `vscode` dependency and is unit-tested directly.

## Testing

- **Unit tests** (`npm test`) cover idle detection and the session state machine (including sleep,
  clock changes, pause, manual mode and restart recovery), project and language detection, Git URL
  normalization, the queue and session outbox, the API client, pairing and revocation, the privacy
  filter, and the sync engine against a fake server that follows the real API contract (offline
  recovery, idempotent retries, rate limiting).
- **Integration tests** (`npm run test:integration`) run inside VS Code with that fake API served
  over HTTP and real editor edits: activation, commands, views, the dashboard, configuration,
  pairing, session attribution, uploads free of file names and code, pause, offline recovery,
  exclusions and revocation. Set `VSCODE_EXECUTABLE` to use an installed VS Code; otherwise a
  matching build is downloaded. With the Snap package of VS Code on Linux, GTK may abort when it is
  started outside the Snap; point `GSETTINGS_SCHEMA_DIR` at a schema folder that contains the
  `org.gnome.settings-daemon.plugins.xsettings` keys, or use the downloaded build.
- **Live contract test** (`npm run test:e2e`) talks to a real DevPulse API. It needs a test
  account: set `DEVPULSE_E2E_API`, `DEVPULSE_E2E_IDENTIFIER` and `DEVPULSE_E2E_PASSWORD`.

## Packaging

```bash
npm run package
```

produces `devpulse-<version>.vsix` containing only the minified bundle, icon, manifest, README,
changelog and license. Verify it the way users get it:

```bash
npm run compile:integration && npm run test:vsix
```

## API integration

The extension talks only to the DevPulse REST API under `/api/v1`, authenticated with the device
credential, and uses these endpoints:

| Method  | Path                                 | Used for                                   |
| ------- | ------------------------------------ | ------------------------------------------ |
| `POST`  | `/integrations/pair`                 | Exchange a connection key for a credential |
| `GET`   | `/integrations/extension/config`     | Account tracking preferences (every 3 h)   |
| `GET`   | `/integrations/extension/summary`    | Today and this week across devices (5 min) |
| `PATCH` | `/integrations/extension/device`     | Rename this device                         |
| `POST`  | `/integrations/extension/disconnect` | Revoke this device                         |
| `POST`  | `/activity/sessions`                 | Start or record a session (idempotent)     |
| `PATCH` | `/activity/sessions/:id`             | Heartbeat, update and end a session        |
| `POST`  | `/activity/events`                   | Upload batched events (deduplicated)       |
| `GET`   | `/health`                            | Reachability check in diagnostics          |

See [docs/API-INTEGRATION.md](docs/API-INTEGRATION.md) for the request rules, error handling and
how the contract differs from the original extension plan.

## License

[MIT](LICENSE) © 2026 Muhammad Ammar Qaisar
