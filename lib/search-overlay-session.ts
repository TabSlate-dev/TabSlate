const SESSION_PARAM = "session";
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SearchOverlaySession {
  expiresAt: number;
  tabID: number;
}

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
    return session.tabID === tabID;
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
