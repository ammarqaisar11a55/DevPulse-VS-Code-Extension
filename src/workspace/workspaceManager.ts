import * as vscode from 'vscode';
import type { ActivityContext } from '../activity/activityTypes';
import {
  detectProject,
  workspaceKey,
  workspaceKind,
  type ProjectIdentity,
  type RepositoryIdentity,
  type WorkspaceKind,
} from './projectDetector';

export interface RepositoryLookup {
  repositoryFor(folderUri: string): RepositoryIdentity | undefined;
}

export interface WorkspaceSnapshot {
  key: string;
  kind: WorkspaceKind;
  trusted: boolean;
  remoteName: string | undefined;
  folders: { uri: string; name: string }[];
}

/**
 * Tracks the window's workspace: its identity, folders (single, multi-root, workspace file or
 * none), remote/virtual kind and trust. Resolves the project for an activity context.
 */
export class WorkspaceManager implements vscode.Disposable {
  private snapshotValue: WorkspaceSnapshot;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<{ removed: string[] }>();
  private repositories: RepositoryLookup | undefined;

  /** Fires when folders are added or removed; `removed` lists removed folder URIs. */
  readonly onDidChange = this.emitter.event;

  constructor() {
    this.snapshotValue = this.read();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        this.snapshotValue = this.read();
        this.emitter.fire({ removed: event.removed.map((folder) => folder.uri.toString()) });
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.snapshotValue = this.read();
        this.emitter.fire({ removed: [] });
      }),
      this.emitter,
    );
  }

  get snapshot(): WorkspaceSnapshot {
    return this.snapshotValue;
  }

  setRepositoryLookup(lookup: RepositoryLookup): void {
    this.repositories = lookup;
  }

  /** The project an activity belongs to, or undefined outside any workspace folder. */
  projectFor(context: ActivityContext | undefined): ProjectIdentity | undefined {
    const folder = context?.workspaceFolder ?? this.soleFolder();
    if (!folder) return undefined;
    return detectProject(
      { uri: folder.uri, name: folder.name },
      this.repositories?.repositoryFor(folder.uri),
    );
  }

  /** Project of a folder URI, e.g. to check whether a removed folder held the session. */
  projectForFolder(folderUri: string): ProjectIdentity | undefined {
    const folder = this.snapshotValue.folders.find((item) => item.uri === folderUri);
    return folder ? detectProject(folder, this.repositories?.repositoryFor(folder.uri)) : undefined;
  }

  /** In a single-folder workspace, files outside the folder still belong to that project. */
  private soleFolder(): { uri: string; name: string } | undefined {
    return this.snapshotValue.folders.length === 1 ? this.snapshotValue.folders[0] : undefined;
  }

  private read(): WorkspaceSnapshot {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      uri: folder.uri.toString(),
      name: folder.name,
      scheme: folder.uri.scheme,
    }));
    const workspaceFile = vscode.workspace.workspaceFile;
    return {
      key: workspaceKey(
        workspaceFile && workspaceFile.scheme !== 'untitled' ? workspaceFile.toString() : undefined,
        folders.map((folder) => folder.uri),
      ),
      kind: workspaceKind(
        vscode.env.remoteName,
        folders.map((folder) => folder.scheme),
      ),
      trusted: vscode.workspace.isTrusted,
      remoteName: vscode.env.remoteName,
      folders: folders.map(({ uri, name }) => ({ uri, name })),
    };
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
