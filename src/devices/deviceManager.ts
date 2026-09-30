import type { AuthManager } from '../auth/authManager';
import type { StateStore } from '../storage/stateStore';
import { isApiError } from '../sync/apiErrors';
import type { ApiClient } from '../sync/apiClient';
import type { Logger } from '../utils/logger';
import type { Clock } from '../utils/time';

export type RenameResult =
  | { ok: true; name: string }
  | { ok: false; reason: 'invalid' | 'not-connected' | 'unsupported' | 'failed'; message: string };

export function validateDeviceName(value: string): string | undefined {
  const name = value.trim();
  if (!name) return 'Enter a device name.';
  if (name.length > 60) return 'Device names can be at most 60 characters.';
  return undefined;
}

/**
 * Device lifecycle after pairing: renaming (synced to the web app's Devices page) and the
 * account-wide totals shown in the status bar. Revocation is detected by the auth manager.
 */
export class DeviceManager {
  /** False once the server answered 404: it predates the editor summary endpoint. */
  private summarySupported = true;

  constructor(
    private readonly api: ApiClient,
    private readonly auth: AuthManager,
    private readonly state: StateStore,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async rename(value: string): Promise<RenameResult> {
    const problem = validateDeviceName(value);
    if (problem) return { ok: false, reason: 'invalid', message: problem };
    if (!this.auth.isConnected) {
      return {
        ok: false,
        reason: 'not-connected',
        message: 'Connect DevPulse to rename this device.',
      };
    }
    try {
      const { data } = await this.api.devices.rename(value.trim());
      await this.auth.updateDeviceName(data.name);
      return { ok: true, name: data.name };
    } catch (error) {
      if (isApiError(error) && error.kind === 'NOT_FOUND') {
        return {
          ok: false,
          reason: 'unsupported',
          message:
            'Your DevPulse server cannot rename devices from the editor. Rename it on the Devices page instead.',
        };
      }
      if (isApiError(error)) {
        await this.auth.handleApiError(error);
        return { ok: false, reason: 'failed', message: `Renaming failed: ${error.message}` };
      }
      throw error;
    }
  }

  /** Fetches account-wide totals; silently skipped on servers without the endpoint. */
  async refreshSummary(): Promise<void> {
    if (!this.summarySupported || !this.auth.isConnected) return;
    try {
      const { data } = await this.api.analytics.summary();
      await this.state.setGlobal('devpulse.remoteSummary', {
        todaySeconds: data.todaySeconds,
        weekSeconds: data.weekSeconds,
        fetchedAt: this.clock.now(),
      });
    } catch (error) {
      if (isApiError(error) && error.kind === 'NOT_FOUND') {
        this.summarySupported = false;
        this.logger.info('Server has no editor summary endpoint; showing local totals only');
        return;
      }
      if (isApiError(error)) await this.auth.handleApiError(error);
      throw error;
    }
  }
}
