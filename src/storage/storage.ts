import * as path from 'node:path';
import type * as vscode from 'vscode';
import { CredentialStore } from '../auth/credentialStore';
import type { Clock } from '../utils/time';
import { EventQueueStore } from './queueStore';
import { SessionStore } from './sessionStore';
import { StateStore } from './stateStore';

export interface Storage {
  state: StateStore;
  credentials: CredentialStore;
  queue: EventQueueStore;
  sessions: SessionStore;
  /** Root folder for durable data, inside VS Code's per-extension global storage. */
  root: string;
}

/**
 * Creates the extension's storage on VS Code's storage facilities: SecretStorage for the
 * credential, Mementos for small state, and globalStorageUri for the queue and session outbox
 * (shared by all windows, so offline data survives restarts regardless of which window wrote it).
 */
export function createStorage(
  context: vscode.ExtensionContext,
  instanceId: string,
  clock: Clock,
): Storage {
  const root = context.globalStorageUri.fsPath;
  return {
    root,
    state: new StateStore(context.globalState, context.workspaceState),
    credentials: new CredentialStore(context.secrets),
    queue: new EventQueueStore(path.join(root, 'queue'), instanceId, clock),
    sessions: new SessionStore(path.join(root, 'sessions')),
  };
}
