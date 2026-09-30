import type { EventMetadata } from '../storage/storageTypes';

/**
 * Files whose metadata is never attached to anything sent, even their extension. Matching is on
 * the base name, case-insensitive.
 */
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.env$/,
  /\.(pem|key|crt|cer|der|p12|pfx|jks|keystore|kdbx|gpg|asc|ovpn)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^credentials(\..+)?$/,
  /^secrets?(\..+)?$/,
  /^\.(npmrc|pypirc|netrc|htpasswd|pgpass|git-credentials)$/,
  /^known_hosts$/,
  /^authorized_keys$/,
];

export function isSensitiveFile(fileName: string): boolean {
  const name = fileName.toLowerCase();
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/** Converts a glob (`**`, `*`, `?`) into an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  // A trailing "/**" also matches the folder itself.
  const trailingAny = pattern.endsWith('/**');
  const glob = trailingAny ? pattern.slice(0, -3) : pattern;
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        source += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}${trailingAny ? '(?:/.*)?' : ''}$`, 'i');
}

/**
 * True when `folderPath` (or anything under it) matches one of the folder globs. Paths are
 * compared with forward slashes; `~` expands to the home directory.
 */
export function folderExcluded(folderPath: string, patterns: readonly string[], home: string) {
  if (patterns.length === 0) return false;
  const normalized = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const homeNormalized = home.replace(/\\/g, '/').replace(/\/+$/, '');
  return patterns.some((pattern) => {
    const expanded = pattern.replace(/^~(?=$|\/)/, homeNormalized).replace(/\\/g, '/');
    const regex = globToRegExp(expanded.replace(/\/+$/, ''));
    if (regex.test(normalized)) return true;
    // A pattern naming a folder also covers its subfolders.
    return globToRegExp(`${expanded.replace(/\/+$/, '')}/**`).test(normalized);
  });
}

const COUNTER_MAX = 1_000_000;

function counter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(COUNTER_MAX, Math.floor(value))
    : undefined;
}

function text(value: unknown, max: number, pattern?: RegExp): string | undefined {
  if (typeof value !== 'string' || !value || value.length > max) return undefined;
  return pattern && !pattern.test(value) ? undefined : value;
}

/**
 * Allow-lists event metadata to exactly what the API accepts; anything else is dropped so file
 * names, paths or content can never be attached by mistake.
 */
export function sanitizeMetadata(
  metadata: EventMetadata | undefined,
  allowFileMetadata: boolean,
): EventMetadata | undefined {
  if (!metadata) return undefined;
  const result: EventMetadata = {};
  const fileExtension = allowFileMetadata
    ? text(metadata.fileExtension, 16, /^\.[\w.+-]*$/)
    : undefined;
  if (fileExtension) result.fileExtension = fileExtension;
  const linesAdded = allowFileMetadata ? counter(metadata.linesAdded) : undefined;
  if (linesAdded) result.linesAdded = linesAdded;
  const linesRemoved = allowFileMetadata ? counter(metadata.linesRemoved) : undefined;
  if (linesRemoved) result.linesRemoved = linesRemoved;
  const commitCount = counter(metadata.commitCount);
  if (commitCount !== undefined) result.commitCount = commitCount;
  const idleSeconds = counter(metadata.idleSeconds);
  if (idleSeconds !== undefined) result.idleSeconds = idleSeconds;
  const debugType = text(metadata.debugType, 40, /^[\w.-]+$/);
  if (debugType) result.debugType = debugType;
  const reason = text(metadata.reason, 80, /^[\w -]+$/);
  if (reason) result.reason = reason;
  return Object.keys(result).length > 0 ? result : undefined;
}
