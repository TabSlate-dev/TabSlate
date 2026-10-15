const SESSION_PARAM = "session";
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * How often an open overlay re-validates its session. Each validation renews
 * the session's 30 s expiry, and each message resets the MV3 service worker's
 * 30 s idle timer, so the in-memory store below survives while the overlay is
 * open. At a third of both windows, one missed heartbeat is tolerated.
 */
export const SEARCH_OVERLAY_HEARTBEAT_MS = 10_000;

interface SearchOverlaySession {
  expiresAt: number;
  tabID: number;
}

/**
 * Sessions expire `ttlMs` after registration or after their last successful
 * validation, whichever is later; revocation ends them at once.
 */
export class SearchOverlaySessionStore {
  private readonly sessions = new Map<string, SearchOverlaySession>();

  public constructor(private readonly ttlMs = 30_000) {}

  public register(nonce: string, tabID: number, now = Date.now()): boolean {
    if (!noncePattern.test(nonce) || tabID < 0) {
      return false;
    }

    this.removeExpired(now);
    this.sessions.set(nonce, { expiresAt: now + this.ttlMs, tabID });
    return true;
  }

  public validate(nonce: string, tabID: number, now = Date.now()): boolean {
    const session = this.sessions.get(nonce);
    if (!session) {
      return false;
    }
    if (session.expiresAt <= now) {
      this.sessions.delete(nonce);
      return false;
    }
    if (session.tabID !== tabID) {
      return false;
    }

    session.expiresAt = now + this.ttlMs;
    return true;
  }

  public revoke(nonce: string, tabID: number): boolean {
    const session = this.sessions.get(nonce);
    if (!session || session.tabID !== tabID) {
      return false;
    }

    this.sessions.delete(nonce);
    return true;
  }

  private removeExpired(now: number) {
    for (const [nonce, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(nonce);
      }
    }
  }
}

export function getSearchOverlaySession(search: string): string | null {
  const session = new URLSearchParams(search).get(SESSION_PARAM);
  if (!session || !noncePattern.test(session)) {
    return null;
  }
  return session;
}
