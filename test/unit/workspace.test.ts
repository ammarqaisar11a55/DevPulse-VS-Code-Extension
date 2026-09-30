import { describe, expect, it } from 'vitest';
import {
  detectProject,
  projectName,
  workspaceKey,
  workspaceKind,
} from '../../src/workspace/projectDetector';
import { apiLanguage, languageDisplayName } from '../../src/workspace/languageDetector';

describe('detectProject', () => {
  const folder = { uri: 'file:///home/me/Notes-Saver', name: 'Notes-Saver' };

  it('uses the folder name, never the absolute path, as the project name', () => {
    const project = detectProject(folder, undefined);
    expect(project.name).toBe('Notes-Saver');
    expect(project.key).not.toContain('home');
  });

  it('prefers the repository identity so two clones are one project', () => {
    const repo = {
      id: 'github.com/me/notes-saver',
      url: 'https://github.com/me/notes-saver',
      name: 'notes-saver',
    };
    const a = detectProject(folder, repo);
    const b = detectProject({ uri: 'file:///tmp/other-clone', name: 'other-clone' }, repo);
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(detectProject(folder, undefined).key);
  });

  it('keeps different folders apart in multi-root workspaces', () => {
    const frontend = detectProject({ uri: 'file:///ws/frontend', name: 'frontend' }, undefined);
    const backend = detectProject({ uri: 'file:///ws/backend', name: 'backend' }, undefined);
    expect(frontend.key).not.toBe(backend.key);
    expect([frontend.name, backend.name]).toEqual(['frontend', 'backend']);
  });

  it('bounds project names to what the API accepts', () => {
    expect(projectName('   ')).toBe('Untitled project');
    expect(projectName('x'.repeat(100))).toHaveLength(80);
  });
});

describe('workspaceKey', () => {
  it('is stable regardless of folder order and distinguishes workspace files', () => {
    expect(workspaceKey(undefined, ['file:///a', 'file:///b'])).toBe(
      workspaceKey(undefined, ['file:///b', 'file:///a']),
    );
    expect(workspaceKey('file:///x.code-workspace', ['file:///a'])).not.toBe(
      workspaceKey(undefined, ['file:///a']),
    );
    expect(workspaceKey(undefined, [])).toBe('no-workspace');
  });
});

describe('workspaceKind', () => {
  it('classifies local, remote, virtual and empty workspaces', () => {
    expect(workspaceKind(undefined, ['file'])).toBe('local');
    expect(workspaceKind('ssh-remote', ['vscode-remote'])).toBe('remote');
    expect(workspaceKind('ssh-remote', ['file'])).toBe('remote');
    expect(workspaceKind(undefined, ['vscode-vfs'])).toBe('virtual');
    expect(workspaceKind(undefined, [])).toBe('none');
  });
});

describe('language detection', () => {
  it('passes VS Code language ids through in API form', () => {
    expect(apiLanguage('typescript')).toBe('typescript');
    expect(apiLanguage('CPP')).toBe('cpp');
    expect(apiLanguage('objective-c')).toBe('objective-c');
    expect(apiLanguage(undefined)).toBeNull();
    expect(apiLanguage('bad/id')).toBeNull();
  });

  it('shows friendly names', () => {
    expect(languageDisplayName('cpp')).toBe('C++');
    expect(languageDisplayName('kotlin')).toBe('Kotlin');
    expect(languageDisplayName('zig')).toBe('Zig');
    expect(languageDisplayName(null)).toBe('Unknown');
  });
});
