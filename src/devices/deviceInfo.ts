import * as os from 'node:os';
import type { DeviceInfo } from '../auth/authTypes';

const PLATFORM_LABELS: Record<string, string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
};

export function devicePlatform(platform: string = os.platform()): DeviceInfo['platform'] {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32' ? platform : 'other';
}

export function platformLabel(platform: string = os.platform()): string {
  return PLATFORM_LABELS[platform] ?? 'Unknown OS';
}

/**
 * A readable default device name such as "VS Code on Linux". The hostname and hardware details
 * are deliberately not used; users can rename the device at any time.
 */
export function defaultDeviceName(appName: string, platform: string = os.platform()): string {
  const editor = appName.replace(/^Visual Studio Code/, 'VS Code').trim() || 'VS Code';
  return `${editor} on ${platformLabel(platform)}`.slice(0, 60);
}

export function buildDeviceInfo(options: {
  name: string;
  appName: string;
  editorVersion: string;
  extensionVersion: string;
}): DeviceInfo {
  return {
    name: options.name,
    platform: devicePlatform(),
    editor: /codium/i.test(options.appName) ? 'vscodium' : 'vscode',
    editorVersion: options.editorVersion,
    extensionVersion: options.extensionVersion,
  };
}
