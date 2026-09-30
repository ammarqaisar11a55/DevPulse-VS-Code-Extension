/** Subset of vscode.SecretStorage used by the extension. */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

const DEVICE_CREDENTIAL_KEY = 'devpulse.deviceCredential';
export const DEVICE_CREDENTIAL_PREFIX = 'dpd_';

/** Secure storage is unavailable (for example no OS keychain on Linux). */
export class StorageError extends Error {
  readonly kind = 'STORAGE_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Keeps the device credential in VS Code's encrypted SecretStorage and caches it in memory.
 * The credential is never logged, displayed, or written anywhere else. If secure storage is
 * unavailable the credential is simply not stored (never downgraded to plain storage).
 */
export class CredentialStore {
  private cached: string | undefined;
  private loaded = false;
  private failure: string | undefined;

  constructor(private readonly secrets: SecretStorageLike) {}

  /** Why secure storage failed, if it did. */
  get unavailableReason(): string | undefined {
    return this.failure;
  }

  async get(): Promise<string | undefined> {
    if (!this.loaded) {
      try {
        const value = await this.secrets.get(DEVICE_CREDENTIAL_KEY);
        this.cached = value?.startsWith(DEVICE_CREDENTIAL_PREFIX) ? value : undefined;
        this.failure = undefined;
      } catch (error) {
        this.cached = undefined;
        this.failure = error instanceof Error ? error.message : 'unknown error';
      }
      this.loaded = true;
    }
    return this.cached;
  }

  async set(credential: string): Promise<void> {
    if (!credential.startsWith(DEVICE_CREDENTIAL_PREFIX)) {
      throw new Error('Unexpected device credential format');
    }
    try {
      await this.secrets.store(DEVICE_CREDENTIAL_KEY, credential);
    } catch {
      throw new StorageError(
        'VS Code could not store the DevPulse credential securely. Make sure your operating system keychain (for example GNOME Keyring or KWallet) is available, then connect again.',
      );
    }
    this.cached = credential;
    this.loaded = true;
    this.failure = undefined;
  }

  async clear(): Promise<void> {
    this.cached = undefined;
    this.loaded = true;
    try {
      await this.secrets.delete(DEVICE_CREDENTIAL_KEY);
    } catch (error) {
      this.failure = error instanceof Error ? error.message : 'unknown error';
    }
  }

  /** Forget the cached value, e.g. after another window changed the secret. */
  invalidate(): void {
    this.loaded = false;
    this.cached = undefined;
  }

  static isCredentialKey(key: string): boolean {
    return key === DEVICE_CREDENTIAL_KEY;
  }
}
