import type * as vscode from 'vscode';

/*
 * The subset of the built-in Git extension API (extensions/git/src/api/git.d.ts, version 1) used
 * by DevPulse. Declared locally because the Git extension does not publish typings.
 */

export interface GitRemote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}

export interface GitBranch {
  readonly name?: string;
  readonly commit?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly upstream?: { readonly remote: string; readonly name: string };
}

export interface GitRepositoryState {
  readonly HEAD: GitBranch | undefined;
  readonly remotes: readonly GitRemote[];
  readonly onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
  /** Available in recent VS Code versions; fired for commits made through VS Code. */
  readonly onDidCommit?: vscode.Event<void>;
}

export interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}
