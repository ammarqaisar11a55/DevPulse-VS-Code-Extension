# Changelog

All notable changes to the DevPulse VS Code extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-03

### Changed

- Connects to the hosted DevPulse service at
  https://devpulse-three-amber.vercel.app by default. Point
  `devpulse.api.baseUrl` and `devpulse.web.url` at your own server to self-host or develop
  locally (for example `http://localhost:4000/api/v1` and `http://localhost:5173`).

### Added

- **Open DevPulse Website** and **Open GitHub Repository** commands, shown as globe and GitHub
  icons in the DevPulse view, in the status bar menu and in the summary dashboard.

### Added

- Account connection with one-time DevPulse connection keys; the device credential is kept in
  VS Code SecretStorage and can be revoked from the web app or with **DevPulse: Disconnect
  Account**.
- Automatic coding-time tracking from editor activity, with idle detection, a configurable
  session timeout, focus-aware counting and an optional manual session mode.
- Project, workspace (single folder, multi-root, workspace files, remote and virtual) and
  language detection; Git branch, repository and commit metadata through the built-in Git
  extension.
- Offline-first synchronization: durable local queue, idempotent session and event uploads,
  exponential backoff and rate-limit handling.
- Status bar item with quick actions, Activity Bar overview, in-editor summary dashboard and
  diagnostics report.
- Privacy controls: conservative defaults, sensitive-file protection, project, folder and
  language exclusions, and pause/resume.
