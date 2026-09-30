import { describe, expect, it } from 'vitest';
import type { ActivityContext } from '../../src/activity/activityTypes';
import {
  folderExcluded,
  globToRegExp,
  isSensitiveFile,
  sanitizeMetadata,
} from '../../src/privacy/dataFilter';
import { PrivacyManager, uploadPolicy } from '../../src/privacy/privacyManager';
import { readSettings } from '../../src/settings/readSettings';
import type { DevPulseSettings } from '../../src/settings/settingsTypes';
import type { ServerConfigState } from '../../src/storage/stateStore';
import type { ProjectIdentity } from '../../src/workspace/projectDetector';

function settings(values: Record<string, unknown> = {}): DevPulseSettings {
  return readSettings({ get: (key) => values[key], isExplicitlySet: (key) => key in values });
}

const server: ServerConfigState = {
  idleTimeoutMinutes: 5,
  trackBranchNames: true,
  trackRepositoryUrl: true,
  heartbeatIntervalSeconds: 60,
  fetchedAt: 0,
};

const activity: ActivityContext = {
  uri: 'file:///home/me/notes/src/auth.ts',
  scheme: 'file',
  languageId: 'typescript',
  fileName: 'auth.ts',
  fileExtension: '.ts',
  workspaceFolder: { uri: 'file:///home/me/notes', name: 'notes', fsPath: '/home/me/notes' },
};

const project: ProjectIdentity = {
  key: 'k1',
  name: 'notes',
  folderUri: 'file:///home/me/notes',
  repository: { id: 'github.com/me/notes', url: 'https://github.com/me/notes', name: 'notes' },
};

function manager(values: Record<string, unknown> = {}, config: ServerConfigState = server) {
  return new PrivacyManager(
    () => settings(values),
    () => config,
    '/home/me',
  );
}

describe('isSensitiveFile', () => {
  it.each([
    '.env',
    '.env.local',
    'prod.env',
    'server.pem',
    'tls.key',
    'id_rsa',
    'id_ed25519.pub',
    'credentials.json',
    'secrets.yaml',
    '.npmrc',
    'cert.p12',
  ])('flags %s', (name) => expect(isSensitiveFile(name)).toBe(true));
  it.each(['auth.ts', 'environment.ts', 'keyboard.cpp', 'README.md', 'secretary.py'])(
    'allows %s',
    (name) => expect(isSensitiveFile(name)).toBe(false),
  );
});

describe('globs and folder exclusions', () => {
  it('converts globs', () => {
    expect(globToRegExp('**/work/**').test('/home/me/work/app')).toBe(true);
    expect(globToRegExp('/home/*/x').test('/home/me/x')).toBe(true);
    expect(globToRegExp('/home/*/x').test('/home/me/y/x')).toBe(false);
  });

  it('matches folders, their subfolders and ~', () => {
    expect(folderExcluded('/home/me/secret/app', ['~/secret'], '/home/me')).toBe(true);
    expect(folderExcluded('/home/me/secret', ['~/secret/**'], '/home/me')).toBe(true);
    expect(folderExcluded('C:\\Users\\me\\work\\app', ['**/work/**'], 'C:\\Users\\me')).toBe(true);
    expect(folderExcluded('/home/me/notes', ['~/secret'], '/home/me')).toBe(false);
    expect(folderExcluded('/home/me/notes', [], '/home/me')).toBe(false);
  });
});

describe('sanitizeMetadata', () => {
  it('drops unknown keys and file metadata when not allowed', () => {
    const input = {
      fileExtension: '.ts',
      linesAdded: 3,
      reason: 'idle-timeout',
      path: '/home/me/secret.ts',
    } as unknown as Parameters<typeof sanitizeMetadata>[0];
    expect(sanitizeMetadata(input, false)).toEqual({ reason: 'idle-timeout' });
    expect(sanitizeMetadata(input, true)).toEqual({
      fileExtension: '.ts',
      linesAdded: 3,
      reason: 'idle-timeout',
    });
  });

  it('rejects malformed values', () => {
    expect(
      sanitizeMetadata(
        { fileExtension: '../../etc/passwd', debugType: 'node; rm', commitCount: -1 },
        true,
      ),
    ).toBeUndefined();
    expect(sanitizeMetadata({ linesAdded: 5_000_000.7 }, true)).toEqual({ linesAdded: 1_000_000 });
  });
});

describe('uploadPolicy', () => {
  it('uses conservative defaults', () => {
    expect(uploadPolicy(settings(), server)).toEqual({
      language: true,
      fileMetadata: false,
      repositoryUrl: false,
      branch: true,
      gitActivity: true,
    });
  });

  it('requires both the local and account settings', () => {
    const local = settings({ 'privacy.trackRepository': true });
    expect(uploadPolicy(local, server).repositoryUrl).toBe(true);
    expect(uploadPolicy(local, { ...server, trackRepositoryUrl: false }).repositoryUrl).toBe(false);
    expect(uploadPolicy(settings(), { ...server, trackBranchNames: false }).branch).toBe(false);
    expect(uploadPolicy(settings({ 'privacy.trackGit': false }), server).branch).toBe(false);
  });
});

describe('PrivacyManager.workContext', () => {
  const input = { workspaceKey: 'ws', activity, project, branch: 'feature/sync' };

  it('sends project name and language but no paths or file names by default', () => {
    const context = manager().workContext(input)!;
    expect(context.project).toEqual({ name: 'notes' });
    expect(context.language).toBe('typescript');
    expect(context.branch).toBe('feature/sync');
    expect(context.repository).toBeNull();
    expect(context.fileExtension).toBeUndefined();
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('/home/me');
    expect(serialized).not.toContain('auth.ts');
  });

  it('adds repository and file metadata only when allowed', () => {
    const context = manager({
      'privacy.trackRepository': true,
      'privacy.trackFileNames': true,
    }).workContext(input)!;
    expect(context.project).toEqual({
      name: 'notes',
      repositoryUrl: 'https://github.com/me/notes',
    });
    expect(context.repository).toBe('github.com/me/notes');
    expect(context.fileExtension).toBe('.ts');
  });

  it('never attaches metadata of sensitive files', () => {
    const context = manager({ 'privacy.trackFileNames': true }).workContext({
      ...input,
      activity: { ...activity, fileName: '.env.production', fileExtension: '.production' },
    })!;
    expect(context.fileExtension).toBeUndefined();
  });

  it('omits the language when language tracking is off', () => {
    expect(manager({ 'privacy.trackLanguage': false }).workContext(input)?.language).toBeNull();
  });

  it.each([
    [{ 'exclusions.languages': ['TypeScript'] }, 'language'],
    [{ 'exclusions.projects': ['NOTES'] }, 'project'],
    [{ 'exclusions.folders': ['~/notes'] }, 'folder'],
  ])('excludes work matching %j', (values, reason) => {
    const privacy = manager(values);
    expect(privacy.exclusionReason(input)).toBe(reason);
    expect(privacy.workContext(input)).toBeUndefined();
  });

  it('re-applies the policy right before upload', () => {
    const privacy = manager({}, { ...server, trackBranchNames: false });
    expect(
      privacy.filterForUpload({
        branch: 'main',
        repository: 'github.com/me/notes',
        project: { name: 'notes', repositoryUrl: 'https://github.com/me/notes' },
      }),
    ).toEqual({ branch: null, repository: null, project: { name: 'notes' } });
  });
});
