/** Display names matching the DevPulse web app; other ids are capitalized. */
const DISPLAY_NAMES: Record<string, string> = {
  typescript: 'TypeScript',
  typescriptreact: 'TypeScript (React)',
  javascript: 'JavaScript',
  javascriptreact: 'JavaScript (React)',
  python: 'Python',
  cpp: 'C++',
  c: 'C',
  csharp: 'C#',
  java: 'Java',
  kotlin: 'Kotlin',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  dart: 'Dart',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  json: 'JSON',
  jsonc: 'JSON with Comments',
  yaml: 'YAML',
  markdown: 'Markdown',
  sql: 'SQL',
  shellscript: 'Shell',
  powershell: 'PowerShell',
  dockerfile: 'Dockerfile',
  vue: 'Vue',
  svelte: 'Svelte',
  prisma: 'Prisma',
  plaintext: 'Plain Text',
  xml: 'XML',
  'objective-c': 'Objective-C',
  jupyter: 'Jupyter',
};

const VALID_LANGUAGE = /^[\w#+.\- ]{1,40}$/;

/**
 * Converts a VS Code language identifier into the value sent to the API. VS Code's own language
 * metadata is used directly, so no file-extension table is maintained. Returns null for ids the
 * API would reject.
 */
export function apiLanguage(languageId: string | undefined): string | null {
  if (!languageId) return null;
  const id = languageId.trim().toLowerCase();
  return VALID_LANGUAGE.test(id) ? id : null;
}

export function languageDisplayName(id: string | null | undefined): string {
  if (!id) return 'Unknown';
  return DISPLAY_NAMES[id.toLowerCase()] ?? id.charAt(0).toUpperCase() + id.slice(1);
}
