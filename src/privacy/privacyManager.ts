import { createHash } from 'node:crypto';
import type { ActivityContext } from '../activity/activityTypes';
import type { WorkContext } from '../activity/sessionManager';
import type { DevPulseSettings } from '../settings/settingsTypes';
import type { ServerConfigState } from '../storage/stateStore';
import type { ProjectRef } from '../storage/storageTypes';
import { apiLanguage } from '../workspace/languageDetector';
import type { ProjectIdentity } from '../workspace/projectDetector';
import { folderExcluded, isSensitiveFile } from './dataFilter';

/**
 * What may leave this computer. A field is only sent when both the local privacy setting and
 * the DevPulse account setting allow it (the server also drops disallowed fields).
 */
export interface UploadPolicy {
  language: boolean;
  fileMetadata: boolean;
  repositoryUrl: boolean;
  branch: boolean;
  gitActivity: boolean;
}

export function uploadPolicy(
  settings: DevPulseSettings,
  server: ServerConfigState | undefined,
): UploadPolicy {
  const privacy = settings.privacy;
  return {
    language: privacy.trackLanguage,
    fileMetadata: privacy.trackFileNames,
    repositoryUrl: privacy.trackRepository && (server?.trackRepositoryUrl ?? true),
    branch: privacy.trackGit && (server?.trackBranchNames ?? true),
    gitActivity: privacy.trackGit,
  };
}

export type ExclusionReason = 'language' | 'project' | 'folder';

export interface WorkInput {
  workspaceKey: string;
  activity: ActivityContext | undefined;
  project: ProjectIdentity | undefined;
  branch: string | undefined;
}

/**
 * The privacy layer: every piece of work metadata passes through here before a session or event
 * is created. Excluded work yields no context at all.
 */
export class PrivacyManager {
  constructor(
    private readonly settings: () => DevPulseSettings,
    private readonly serverConfig: () => ServerConfigState | undefined,
    private readonly homeDir: string,
  ) {}

  get policy(): UploadPolicy {
    return uploadPolicy(this.settings(), this.serverConfig());
  }

  exclusionReason(input: WorkInput): ExclusionReason | undefined {
    const { exclusions } = this.settings();
    const languageId = input.activity?.languageId.toLowerCase();
    if (languageId && exclusions.languages.includes(languageId)) return 'language';
    const projectName = input.project?.name.toLowerCase();
    if (projectName && exclusions.projects.some((name) => name.toLowerCase() === projectName)) {
      return 'project';
    }
    const repoName = input.project?.repository?.name.toLowerCase();
    if (repoName && exclusions.projects.some((name) => name.toLowerCase() === repoName)) {
      return 'project';
    }
    const folderPath = input.activity?.workspaceFolder?.fsPath;
    if (folderPath && folderExcluded(folderPath, exclusions.folders, this.homeDir)) return 'folder';
    return undefined;
  }

  /** Builds the filtered context for the session engine, or undefined if the work is excluded. */
  workContext(input: WorkInput): WorkContext | undefined {
    if (this.exclusionReason(input)) return undefined;
    const policy = this.policy;
    const activity = input.activity;
    const sensitive = activity ? isSensitiveFile(activity.fileName) : false;
    return {
      workspaceKey: input.workspaceKey,
      projectKey: input.project?.key ?? null,
      project: input.project ? this.projectRef(input.project, policy) : null,
      language: policy.language ? apiLanguage(activity?.languageId) : null,
      repository: policy.repositoryUrl ? (input.project?.repository?.id ?? null) : null,
      branch: policy.branch ? (input.branch?.slice(0, 200) ?? null) : null,
      ...(activity ? { fileKey: localFileKey(activity.uri) } : {}),
      ...(activity && policy.fileMetadata && !sensitive && activity.fileExtension
        ? { fileExtension: activity.fileExtension }
        : {}),
    };
  }

  projectRef(project: ProjectIdentity, policy = this.policy): ProjectRef {
    return policy.repositoryUrl && project.repository
      ? { name: project.name, repositoryUrl: project.repository.url }
      : { name: project.name };
  }

  /** Re-applies the current policy to data recorded earlier, right before upload. */
  filterForUpload<
    T extends { repository?: string | null; branch?: string | null; project?: ProjectRef },
  >(payload: T): T {
    const policy = this.policy;
    const result = { ...payload };
    if (!policy.branch && 'branch' in result) result.branch = null;
    if (!policy.repositoryUrl) {
      if ('repository' in result) result.repository = null;
      if (result.project) result.project = { name: result.project.name };
    }
    return result;
  }
}

/** Local-only identity for counting distinct changed files; a one-way hash of the URI. */
function localFileKey(uri: string): string {
  return createHash('sha256').update(uri).digest('hex').slice(0, 16);
}
