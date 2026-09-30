import { isApiError } from '../sync/apiErrors';
import type { ApiClient } from '../sync/apiClient';
import type { PairDeviceResponse } from '../sync/apiTypes';
import type { DeviceInfo } from './authTypes';
import { PairingError } from './authTypes';
import { normalizePairingKey } from './pairingKey';

/**
 * Exchanges a one-time pairing key for a device credential. The key itself is never stored:
 * it is consumed by the server and only the returned credential is kept.
 */
export async function pairDevice(
  api: ApiClient,
  rawKey: string,
  device: DeviceInfo,
): Promise<PairDeviceResponse> {
  const key = normalizePairingKey(rawKey);
  if (!key) {
    throw new PairingError(
      'INVALID_KEY_FORMAT',
      'That does not look like a DevPulse connection key (for example DP-7F3K-X92M-Q8PR).',
    );
  }
  try {
    const { data } = await api.integrations.pair({
      key,
      device: {
        name: device.name,
        platform: device.platform,
        editor: device.editor,
        editorVersion: device.editorVersion,
        extensionVersion: device.extensionVersion,
      },
    });
    return data;
  } catch (error) {
    if (!isApiError(error)) throw new PairingError('UNEXPECTED', 'Connecting failed unexpectedly.');
    switch (error.kind) {
      case 'API_VALIDATION_ERROR':
        throw new PairingError(
          'KEY_REJECTED',
          error.message ||
            'This connection key is invalid or has expired. Generate a new one in DevPulse.',
        );
      case 'RATE_LIMITED':
        throw new PairingError(
          'RATE_LIMITED',
          'Too many connection attempts. Wait a few minutes and try again.',
        );
      case 'NETWORK_ERROR':
      case 'TIMEOUT':
        throw new PairingError(
          'SERVER_UNREACHABLE',
          'Cannot reach the DevPulse server. Check your connection and the devpulse.api.baseUrl setting.',
        );
      case 'CONFIGURATION_ERROR':
        throw new PairingError('CONFIGURATION', error.message);
      default:
        throw new PairingError(
          'UNEXPECTED',
          `DevPulse could not register this device (${error.message}). Try again later.`,
        );
    }
  }
}
