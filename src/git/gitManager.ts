import * as vscode from 'vscode';
import type { Logger } from '../utils/logger';
import type { RepositoryIdentity } from '../workspace/projectDetector';
import type { GitApi, GitExtension, GitRepository } from './gitApi';
import {
  localCommitsBetween,
  normalizeRemoteUrl,
  preferredRemote,
  type HeadSnapshot,
} from './gitMetadata';

export type GitAvailability =
  'active' | 'disabled' | 'unavailable' | 'untrusted' | 'virtual' | 'starting';

export interface GitInfo {
  repository: RepositoryIdentity | undefined;
  branch: string | undefined;
}

interface TrackedRepository {
  repo: GitRepository;
  head: HeadSnapshot;
  disposables: vscode.Disposable[];
}

/**
 * Reads repository metadata through the built-in Git extension: no git processes are spawned,
 * it works in remote workspaces, and it is inactive in untrusted and virtual workspaces.
 * Only metadata is read: remote URL, branch name and commit counts. Never diffs or messages.
 */
export class GitManager implements vscode.Disposable {
  private api: GitApi | undefined;
  private availabilityValue: GitAvailability = 'disabled';
  private readonly repos = new Map<string, TrackedRepository>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly commitEmitter = new vscode.EventEmitter<{ rootUri: string; count: number }>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  /** Local commits detected in a repository. */
  readonly onDidCommit = this.commitEmitter.event;
  /** Branch or repository set changed. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly logger: Logger) {}

  get availability(): GitAvailability {
    return this.availabilityValue;
  }

  /**
   * Starts or stops Git integration. `enabled` reflects the privacy settings; trust and the
   * workspace kind gate features that need a local repository.
   */
  async configure(options: { enabled: boolean; trusted: boolean; virtual: boolean }) {
    if (!options.enabled) return this.stop('disabled');
    if (options.virtual) return this.stop('virtual');
    if (!options.trusted) return this.stop('untrusted');
    if (this.api) return;
    this.availabilityValue = 'starting';
    try {
      const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!extension) return this.stop('unavailable');
      const exports = extension.isActive ? extension.exports : await extension.activate();
      if (!exports.enabled) return this.stop('unavailable');
      this.attach(exports.getAPI(1));
    } catch (error) {
      this.logger.warn('Git integration unavailable', error);
      this.stop('unavailable');
    }
  }

  /** Repository identity and branch for a folder, when Git integration is active. */
  infoFor(folderUri: string | undefined): GitInfo {
    if (!this.api || !folderUri) return { repository: undefined, branch: undefined };
    let repo: GitRepository | null = null;
    try {
      repo = this.api.getRepository(vscode.Uri.parse(folderUri));
    } catch {
      repo = null;
    }
    if (!repo) return { repository: undefined, branch: undefined };
    const head = repo.state.HEAD;
    return {
      repository: normalizeRemoteUrl(preferredRemote(repo.state.remotes, head?.upstream?.remote)),
      branch: head?.name,
    };
  }

  repositoryFor(folderUri: string): RepositoryIdentity | undefined {
    return this.infoFor(folderUri).repository;
  }

  private attach(api: GitApi): void {
    this.api = api;
    this.availabilityValue = 'active';
    for (const repo of api.repositories) this.track(repo);
    this.disposables.push(
      api.onDidOpenRepository((repo) => {
        this.track(repo);
        this.changeEmitter.fire();
      }),
      api.onDidCloseRepository((repo) => {
        this.untrack(repo.rootUri.toString());
        this.changeEmitter.fire();
      }),
    );
    this.changeEmitter.fire();
  }

  private track(repo: GitRepository): void {
    const key = repo.rootUri.toString();
    if (this.repos.has(key)) return;
    const tracked: TrackedRepository = { repo, head: snapshot(repo), disposables: [] };
    tracked.disposables.push(
      repo.state.onDidChange(() => {
        const next = snapshot(repo);
        const commits = localCommitsBetween(tracked.head, next);
        const branchChanged = next.branch !== tracked.head.branch;
        tracked.head = next;
        if (commits > 0) this.commitEmitter.fire({ rootUri: key, count: commits });
        if (branchChanged) this.changeEmitter.fire();
      }),
    );
    if (repo.onDidCommit) {
      tracked.disposables.push(
        repo.onDidCommit(() => {
          // Without an upstream, "ahead" is unknown, so rely on the explicit commit event.
          if (repo.state.HEAD?.ahead === undefined) {
            this.commitEmitter.fire({ rootUri: key, count: 1 });
          }
        }),
      );
    }
    this.repos.set(key, tracked);
  }

  private untrack(key: string): void {
    const tracked = this.repos.get(key);
    if (!tracked) return;
    for (const disposable of tracked.disposables) disposable.dispose();
    this.repos.delete(key);
  }

  private stop(availability: GitAvailability): void {
    for (const key of [...this.repos.keys()]) this.untrack(key);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    const changed = this.api !== undefined;
    this.api = undefined;
    this.availabilityValue = availability;
    if (changed) this.changeEmitter.fire();
  }

  dispose(): void {
    this.stop('disabled');
    this.commitEmitter.dispose();
    this.changeEmitter.dispose();
  }
}

function snapshot(repo: GitRepository): HeadSnapshot {
  const head = repo.state.HEAD;
  return { branch: head?.name, commit: head?.commit, ahead: head?.ahead };
}
