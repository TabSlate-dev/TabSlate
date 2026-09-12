const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Whether a configured server URL is safe to send credentials and
 * synchronized data to: https:// for any host, or http:// only for an exact
 * loopback address (local development). Rejects userinfo (user:pass@host)
 * and any other scheme.
 */
export function isSecureServerUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  if (parsed.protocol === "http:") {
    return LOOPBACK_HOSTNAMES.has(parsed.hostname);
  }
  return false;
}
