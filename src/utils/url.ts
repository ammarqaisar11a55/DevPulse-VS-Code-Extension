export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

/**
 * Validates a configured server URL. HTTPS is required unless the host is loopback or insecure
 * HTTP was explicitly allowed, because the device credential is sent with every request.
 */
export function checkServerUrl(raw: string, allowInsecureHttp: boolean): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid URL.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'The server URL must not contain a user name or password.' };
  }
  if (url.protocol === 'https:') return { ok: true, url: raw.replace(/\/+$/, '') };
  if (url.protocol !== 'http:') {
    return { ok: false, reason: 'The server URL must start with https://.' };
  }
  if (isLoopbackHost(url.hostname) || allowInsecureHttp) {
    return { ok: true, url: raw.replace(/\/+$/, '') };
  }
  return {
    ok: false,
    reason:
      'Insecure http:// URLs are only allowed for localhost. Use https:// or enable devpulse.api.allowInsecureHttp.',
  };
}
