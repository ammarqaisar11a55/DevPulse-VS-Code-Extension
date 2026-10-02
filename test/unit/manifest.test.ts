import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Commands } from '../../src/commands';

interface Manifest {
  contributes: {
    commands: { command: string }[];
    menus: Record<string, { command: string }[]>;
  };
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;

describe('package.json contributions', () => {
  it('declares exactly the commands the extension registers', () => {
    const declared = manifest.contributes.commands.map((entry) => entry.command).sort();
    expect(declared).toEqual(Object.values(Commands).sort());
  });

  it('only references declared commands in menus', () => {
    const declared = new Set(Object.values(Commands) as string[]);
    for (const entries of Object.values(manifest.contributes.menus)) {
      for (const entry of entries) expect(declared).toContain(entry.command);
    }
  });

  it('shows the website and repository links in the DevPulse view toolbar', () => {
    const toolbar = manifest.contributes.menus['view/title']!.map((entry) => entry.command);
    expect(toolbar).toEqual(
      expect.arrayContaining([Commands.openWebsite, Commands.openRepository]),
    );
  });
});
