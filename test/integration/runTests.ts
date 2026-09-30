import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Runs the integration suite inside an Extension Development Host. Set VSCODE_EXECUTABLE to use
 * an installed VS Code; otherwise @vscode/test-electron downloads a matching build.
 */
async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'devpulse-vscode-'));
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, 'suite/index'),
      ...(process.env.VSCODE_EXECUTABLE
        ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE }
        : {}),
      launchArgs: [
        path.join(root, 'test/fixtures/workspace'),
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${userDataDir}`,
      ],
      extensionTestsEnv: { DEVPULSE_TEST: '1' },
    });
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error('Integration tests failed', error);
  process.exit(1);
});
