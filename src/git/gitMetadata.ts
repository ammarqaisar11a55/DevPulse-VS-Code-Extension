import type { RepositoryIdentity } from '../workspace/projectDetector';

export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'other';

export function gitProvider(host: string): GitProvider {
  const lower = host.toLowerCase();
  if (lower === 'github.com' || lower.endsWith('.github.com')) return 'github';
  if (lower === 'gitlab.com' || lower.startsWith('gitlab.')) return 'gitlab';
  if (lower === 'bitbucket.org' || lower.startsWith('bitbucket.')) return 'bitbucket';
  return 'other';
}

/**
 * Normalizes a Git remote URL into a credential-free identity. Supports HTTPS, SSH
 * (`git@host:owner/repo.git` and `ssh://`), and `git://` remotes on any host (GitHub, GitLab,
 * Bitbucket, self-hosted). Local-path remotes return undefined: they identify nothing shareable.
 */
export function normalizeRemoteUrl(raw: string | undefined): RepositoryIdentity | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  let host: string;
  let path: string;

  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) {
      return undefined;
    }
    // Username, password and port are dropped: tokens are often embedded in HTTPS remotes.
    host = url.hostname;
    path = url.pathname;
  } else if (scp?.[1] && scp[2] && !/^[a-z]$/i.test(scp[1])) {
    host = scp[1];
    path = scp[2];
  } else {
    return undefined;
  }

  const segments = path
    .replace(/\.git\/?$/i, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeSafe(segment));
  if (!host || segments.length === 0) return undefined;
  const cleanHost = host.toLowerCase();
  const id = `${cleanHost}/${segments.join('/')}`;
  return {
    id,
    url: `https://${id}`,
    name: segments[segments.length - 1] ?? id,
  };
}

function decodeSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Picks the remote that best identifies the repository: origin, then the upstream's, then any. */
export function preferredRemote(
  remotes: readonly { name: string; fetchUrl?: string; pushUrl?: string }[],
  upstreamRemote?: string,
): string | undefined {
  const byName = (name: string | undefined) => remotes.find((remote) => remote.name === name);
  const remote = byName('origin') ?? byName(upstreamRemote) ?? remotes[0];
  return remote?.fetchUrl ?? remote?.pushUrl;
}

export interface HeadSnapshot {
  branch: string | undefined;
  commit: string | undefined;
  ahead: number | undefined;
}

/**
 * Counts commits made locally between two HEAD snapshots: same branch, new commit, and the
 * branch moved further ahead of its upstream (pulls and checkouts do not increase "ahead").
 */
export function localCommitsBetween(previous: HeadSnapshot, next: HeadSnapshot): number {
  if (!previous.branch || previous.branch !== next.branch) return 0;
  if (!next.commit || previous.commit === next.commit) return 0;
  if (previous.ahead === undefined || next.ahead === undefined) return 0;
  return Math.max(0, next.ahead - previous.ahead);
}
