import { createHash } from 'node:crypto';

export interface FolderRef {
  uri: string;
  name: string;
}

export interface RepositoryIdentity {
  /** Normalized, credential-free identity such as "github.com/me/notes-saver". */
  id: string;
  /** Canonical https URL for the API's project matching. */
  url: string;
  name: string;
}

/** A project as known locally. Only `name` (and optionally the repo URL) is ever uploaded. */
export interface ProjectIdentity {
  /** Stable local key: derived from the repository when available, else from the folder. */
  key: string;
  name: string;
  folderUri: string;
  repository: RepositoryIdentity | undefined;
}

export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Derives the project for a workspace folder. The Git repository identity is preferred so the
 * same repository cloned in two places is one project; the folder is the fallback.
 */
export function detectProject(
  folder: FolderRef,
  repository: RepositoryIdentity | undefined,
): ProjectIdentity {
  const source = repository ? `repo:${repository.id.toLowerCase()}` : `folder:${folder.uri}`;
  return {
    key: shortHash(source),
    name: projectName(folder.name),
    folderUri: folder.uri,
    repository,
  };
}

/** API project names are 1–80 characters. */
export function projectName(name: string): string {
  const trimmed = name.trim() || 'Untitled project';
  return trimmed.slice(0, 80);
}

/** Identifies a VS Code window's workspace (workspace file, folders, or none). */
export function workspaceKey(workspaceFile: string | undefined, folders: readonly string[]) {
  if (workspaceFile) return shortHash(`file:${workspaceFile}`);
  if (folders.length > 0) return shortHash(`folders:${[...folders].sort().join('|')}`);
  return 'no-workspace';
}

export type WorkspaceKind = 'local' | 'remote' | 'virtual' | 'none';

/**
 * Classifies the workspace. Remote workspaces (SSH, containers, WSL, Codespaces) run the
 * extension next to the files; virtual workspaces (e.g. github.dev-style file systems) have no
 * local disk or Git CLI, so Git features are unavailable there.
 */
export function workspaceKind(remoteName: string | undefined, folderSchemes: readonly string[]) {
  if (folderSchemes.length === 0) return 'none';
  if (folderSchemes.some((scheme) => scheme !== 'file' && scheme !== 'vscode-remote')) {
    return 'virtual';
  }
  return remoteName ? 'remote' : 'local';
}
