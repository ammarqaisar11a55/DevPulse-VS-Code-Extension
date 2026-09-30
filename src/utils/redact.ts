/** Keys whose values are always removed from logged objects. */
const SENSITIVE_KEY =
  /(authorization|credential|token|secret|password|passwd|cookie|pairing.?key|^key$)/i;

const SECRET_PATTERNS: [RegExp, string][] = [
  // DevPulse device credentials.
  [/dpd_[A-Za-z0-9_-]+/g, 'dpd_[REDACTED]'],
  // Pairing keys in canonical or compact form.
  [/\bDP-?[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}\b/gi, 'DP-[REDACTED]'],
  // Authorization headers.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]'],
  // Credentials embedded in URLs (https://user:token@host).
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(:[^/\s@]*)?@/gi, '$1[REDACTED]@'],
];

export function redactString(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    result = result.replace(pattern, replacement);
  return result;
}

/**
 * Returns a copy of `value` that is safe to log: secret-looking strings are masked and values of
 * sensitive keys are dropped. Handles cycles and limits depth.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (seen.has(value)) return '[Circular]';
  if (depth > 5) return '[Truncated]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1, seen));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(entry, depth + 1, seen);
  }
  return output;
}
