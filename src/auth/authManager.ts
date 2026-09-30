import type { ApiError } from '../sync/apiErrors';
import type { ApiClient } from '../sync/apiClient';
import type { ExtensionConfigDto } from '../sync/apiTypes';
import type { LocalDeviceState, StateStore } from '../storage/stateStore';
import type { Logger } from '../utils/logger';
import type { Clock } from '../utils/time';
import type { AuthState, DeviceInfo } from './authTypes';
import type { CredentialStore } from './credentialStore';
import { pairDevice } from './pairingService';

type Listener = (state: AuthState) => void;

export interface ConnectResult {
  device: LocalDeviceState;
  /** True when the new account differs from the previously connected one. */
  accountChanged: boolean;
}

/**
 * Owns the connection lifecycle: pairing, the stored credential, revocation and disconnect.
 * Other modules never touch the credential; the API client asks `credentialFor` for it.
 */
export class AuthManager {
  private current: AuthState = 'NOT_CONNECTED';
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly credentials: CredentialStore,
    private readonly state: StateStore,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly currentBaseUrl: () => string,
  ) {}

  get authState(): AuthState {
    return this.current;
  }

  get device(): LocalDeviceState | undefined {
    return this.state.getGlobal('devpulse.device');
  }

  get isConnected(): boolean {
    return this.current === 'CONNECTED';
  }

  onDidChange(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Restores the state from storage at startup or after another window changed it. */
  async initialize(): Promise<AuthState> {
    // Never throws: unreadable secure storage is reported as a missing credential.
    const credential = await this.credentials.get();
    if (this.credentials.unavailableReason) {
      this.logger.warn('Secure storage is unavailable', {
        reason: this.credentials.unavailableReason,
      });
    }
    const device = this.device;
    if (this.state.getGlobal('devpulse.revoked')) {
      this.set('REVOKED');
    } else if (credential && device) {
      this.set(device.baseUrl === this.currentBaseUrl() ? 'CONNECTED' : 'ERROR');
    } else if (device && !credential) {
      this.set('AUTH_EXPIRED');
    } else {
      this.set('NOT_CONNECTED');
    }
    return this.current;
  }

  /**
   * The credential for API requests, only when it was issued by the currently configured server,
   * so changing the URL can never send it to a different host.
   */
  async credentialFor(baseUrl: string): Promise<string | undefined> {
    if (this.current !== 'CONNECTED') return undefined;
    if (this.device?.baseUrl !== baseUrl) return undefined;
    return this.credentials.get();
  }

  async connect(api: ApiClient, key: string, info: DeviceInfo): Promise<ConnectResult> {
    const previous = this.current;
    this.set('PAIRING');
    try {
      const response = await pairDevice(api, key, info);
      const before = this.device;
      await this.credentials.set(response.credential);
      const device: LocalDeviceState = {
        deviceId: response.device.id,
        deviceName: response.device.name,
        account: response.account,
        connectedAt: this.clock.now(),
        baseUrl: this.currentBaseUrl(),
      };
      await this.state.setGlobal('devpulse.device', device);
      await this.state.setGlobal('devpulse.revoked', undefined);
      await this.saveConfig(response.config);
      this.set('CONNECTED');
      this.logger.info('Device connected', { deviceId: device.deviceId });
      return {
        device,
        accountChanged:
          before !== undefined &&
          (before.account.username !== device.account.username ||
            before.baseUrl !== device.baseUrl),
      };
    } catch (error) {
      this.set(previous === 'PAIRING' ? 'NOT_CONNECTED' : previous);
      throw error;
    }
  }

  /**
   * Disconnects locally. When `revokeRemotely` is set the server is asked to revoke the
   * credential first (best effort: an offline disconnect still clears local credentials).
   */
  async disconnect(api: ApiClient | undefined, revokeRemotely: boolean): Promise<void> {
    if (revokeRemotely && api && this.current === 'CONNECTED') {
      try {
        await api.integrations.disconnect();
      } catch (error) {
        this.logger.warn('Could not revoke the device on the server', error);
      }
    }
    await this.credentials.clear();
    await this.state.setGlobal('devpulse.device', undefined);
    await this.state.setGlobal('devpulse.serverConfig', undefined);
    await this.state.setGlobal('devpulse.remoteSummary', undefined);
    await this.state.setGlobal('devpulse.revoked', undefined);
    this.set('NOT_CONNECTED');
  }

  /** Reacts to an authentication failure from any API call. */
  async handleApiError(error: ApiError): Promise<boolean> {
    if (error.kind !== 'DEVICE_REVOKED') return false;
    if (this.current !== 'CONNECTED') return true;
    this.logger.warn('The server rejected the device credential; marking device revoked');
    // Never retry a revoked credential: delete it, but keep device info for the reconnect prompt.
    await this.credentials.clear();
    await this.state.setGlobal('devpulse.revoked', true);
    this.set('REVOKED');
    return true;
  }

  async saveConfig(config: ExtensionConfigDto): Promise<void> {
    await this.state.setGlobal('devpulse.serverConfig', { ...config, fetchedAt: this.clock.now() });
  }

  async updateDeviceName(name: string): Promise<void> {
    const device = this.device;
    if (device) await this.state.setGlobal('devpulse.device', { ...device, deviceName: name });
  }

  private set(next: AuthState): void {
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}
