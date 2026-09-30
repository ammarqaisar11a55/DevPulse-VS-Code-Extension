import * as path from 'node:path';
import { glob } from 'glob';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 20_000 });
  const files = await glob('**/*.test.js', { cwd: __dirname });
  for (const file of files.sort()) mocha.addFile(path.resolve(__dirname, file));
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} integration tests failed`)) : resolve(),
    );
  });
}
