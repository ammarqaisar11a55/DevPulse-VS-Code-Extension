/**
 * Authentication state of this VS Code installation.
 *
 * The DevPulse API issues one long-lived, revocable device credential at pairing time instead of
 * access/refresh tokens, so "expired" and "revoked" both mean the user must pair again.
 */
export type AuthState =
  /** No device credential; the user has not connected (or disconnected). */
  | 'NOT_CONNECTED'
  /** A pairing request is in flight. */
  | 'PAIRING'
  | 'CONNECTED'
  /** Device state exists but the credential is missing (e.g. the OS keychain was reset). */
  | 'AUTH_EXPIRED'
  /** The server rejected the credential: the device was revoked from the web app. */
  | 'REVOKED'
  /** Connected, but the configured server URL differs from the one the device was paired with. */
  | 'ERROR';

export interface DeviceInfo {
  name: string;
  platform: 'linux' | 'darwin' | 'win32' | 'other';
  editor: string;
  editorVersion: string;
  extensionVersion: string;
}

export type PairingFailure =
  | 'INVALID_KEY_FORMAT'
  | 'KEY_REJECTED'
  | 'RATE_LIMITED'
  | 'SERVER_UNREACHABLE'
  | 'CONFIGURATION'
  | 'UNEXPECTED';

export class PairingError extends Error {
  constructor(
    readonly reason: PairingFailure,
    message: string,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}
