import { describe, expect, it } from 'vitest';
import {
  gitProvider,
  localCommitsBetween,
  normalizeRemoteUrl,
  preferredRemote,
} from '../../src/git/gitMetadata';

describe('normalizeRemoteUrl', () => {
  it.each([
    ['https://github.com/me/notes-saver.git', 'github.com/me/notes-saver'],
    ['https://github.com/me/notes-saver/', 'github.com/me/notes-saver'],
    ['git@github.com:me/notes-saver.git', 'github.com/me/notes-saver'],
    ['ssh://git@gitlab.com:2222/group/sub/app.git', 'gitlab.com/group/sub/app'],
    ['git@bitbucket.org:team/repo.git', 'bitbucket.org/team/repo'],
    ['https://git.example.com/scm/tools/app', 'git.example.com/scm/tools/app'],
    ['git://example.org/project.git', 'example.org/project'],
  ])('normalizes %s', (input, id) => {
    const result = normalizeRemoteUrl(input);
    expect(result?.id).toBe(id);
    expect(result?.url).toBe(`https://${id}`);
  });

  it('strips credentials embedded in remote URLs', () => {
    const result = normalizeRemoteUrl('https://me:ghp_supersecret@github.com/me/private.git');
    expect(result?.url).toBe('https://github.com/me/private');
    expect(JSON.stringify(result)).not.toContain('ghp_');
    expect(JSON.stringify(normalizeRemoteUrl('https://oauth2:tok@gitlab.com/a/b'))).not.toContain(
      'tok',
    );
  });

  it('ignores local-path and unsupported remotes', () => {
    expect(normalizeRemoteUrl('/home/me/bare-repo.git')).toBeUndefined();
    expect(normalizeRemoteUrl('C:\\repos\\thing')).toBeUndefined();
    expect(normalizeRemoteUrl('file:///srv/git/app.git')).toBeUndefined();
    expect(normalizeRemoteUrl('')).toBeUndefined();
    expect(normalizeRemoteUrl(undefined)).toBeUndefined();
  });

  it('reports the repository name', () => {
    expect(normalizeRemoteUrl('git@github.com:me/Notes-Saver.git')?.name).toBe('Notes-Saver');
  });
});

describe('gitProvider', () => {
  it('detects common hosts without requiring GitHub', () => {
    expect(gitProvider('github.com')).toBe('github');
    expect(gitProvider('gitlab.company.io')).toBe('gitlab');
    expect(gitProvider('bitbucket.org')).toBe('bitbucket');
    expect(gitProvider('git.internal')).toBe('other');
  });
});

describe('preferredRemote', () => {
  it('prefers origin, then the upstream remote, then the first', () => {
    const remotes = [
      { name: 'fork', fetchUrl: 'f' },
      { name: 'upstream', fetchUrl: 'u' },
      { name: 'origin', fetchUrl: 'o' },
    ];
    expect(preferredRemote(remotes)).toBe('o');
    expect(preferredRemote(remotes.slice(0, 2), 'upstream')).toBe('u');
    expect(preferredRemote(remotes.slice(0, 1))).toBe('f');
    expect(preferredRemote([])).toBeUndefined();
  });
});

describe('localCommitsBetween', () => {
  const base = { branch: 'main', commit: 'a', ahead: 0 };
  it('counts new local commits', () => {
    expect(localCommitsBetween(base, { branch: 'main', commit: 'b', ahead: 1 })).toBe(1);
    expect(localCommitsBetween(base, { branch: 'main', commit: 'c', ahead: 2 })).toBe(2);
  });
  it('ignores pulls, checkouts and unknown upstreams', () => {
    expect(localCommitsBetween(base, { branch: 'main', commit: 'b', ahead: 0 })).toBe(0);
    expect(localCommitsBetween(base, { branch: 'dev', commit: 'b', ahead: 1 })).toBe(0);
    expect(
      localCommitsBetween(
        { ...base, ahead: undefined },
        { branch: 'main', commit: 'b', ahead: undefined },
      ),
    ).toBe(0);
  });
});
