// Installs the packaged VSIX into a clean VS Code profile and runs the integration suite
// against the installed copy, so the published bundle (not the sources) is what gets tested.
//
//   npm run package && npm run compile:integration && npm run test:vsix
//
// Set VSCODE_EXECUTABLE to use an installed VS Code instead of downloading one.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name, publisher, version } = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const vsix = path.join(root, `${name}-${version}.vsix`);
const profile = mkdtempSync(path.join(tmpdir(), 'devpulse-vsix-'));
const extensionsDir = path.join(profile, 'extensions');
const userDataDir = path.join(profile, 'user');

try {
  const executable = process.env.VSCODE_EXECUTABLE ?? (await downloadAndUnzipVSCode());
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
  const install = spawnSync(
    cli,
    [
      ...cliArgs,
      `--extensions-dir=${extensionsDir}`,
      `--user-data-dir=${userDataDir}`,
      '--install-extension',
      vsix,
    ],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  if (install.status !== 0) throw new Error(`VSIX installation failed:\n${install.stderr}`);
  const installed = readdirSync(extensionsDir).find((entry) =>
    entry.toLowerCase().startsWith(`${publisher}.${name}-${version}`.toLowerCase()),
  );
  if (!installed) throw new Error('The VSIX did not install an extension folder');
  console.log(`Installed ${installed} into a clean profile`);

  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: path.join(extensionsDir, installed),
    extensionTestsPath: path.join(root, 'out/test/integration/suite/index'),
    launchArgs: [
      path.join(root, 'test/fixtures/workspace'),
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${userDataDir}`,
    ],
  });
  console.log('Packaged extension passed the integration suite');
} finally {
  rmSync(profile, { recursive: true, force: true });
}
