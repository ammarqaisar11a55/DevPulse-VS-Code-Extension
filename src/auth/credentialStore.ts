/** Subset of vscode.SecretStorage used by the extension. */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

const DEVICE_CREDENTIAL_KEY = 'devpulse.deviceCredential';
export const DEVICE_CREDENTIAL_PREFIX = 'dpd_';

/**
 * Keeps the device credential in VS Code's encrypted SecretStorage and caches it in memory.
 * The credential is never logged, displayed, or written anywhere else.
 */
export class CredentialStore {
  private cached: string | undefined;
  private loaded = false;

  constructor(private readonly secrets: SecretStorageLike) {}

  async get(): Promise<string | undefined> {
    if (!this.loaded) {
      const value = await this.secrets.get(DEVICE_CREDENTIAL_KEY);
      this.cached = value?.startsWith(DEVICE_CREDENTIAL_PREFIX) ? value : undefined;
      this.loaded = true;
    }
    return this.cached;
  }

  async set(credential: string): Promise<void> {
    if (!credential.startsWith(DEVICE_CREDENTIAL_PREFIX)) {
      throw new Error('Unexpected device credential format');
    }
    await this.secrets.store(DEVICE_CREDENTIAL_KEY, credential);
    this.cached = credential;
    this.loaded = true;
  }

  async clear(): Promise<void> {
    this.cached = undefined;
    this.loaded = true;
    await this.secrets.delete(DEVICE_CREDENTIAL_KEY);
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
