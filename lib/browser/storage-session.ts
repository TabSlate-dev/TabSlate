type SessionStorageWithAccessLevel = chrome.storage.SessionStorageArea & {
  setAccessLevel?: (options: { accessLevel: string }) => Promise<void> | void;
};

interface FirefoxStorageSession {
  setAccessLevel?: (accessLevel: string) => Promise<void>;
}

export async function restrictSessionStorageToTrustedContexts(): Promise<void> {
  const accessLevel = chrome.storage.AccessLevel?.TRUSTED_CONTEXTS ?? "TRUSTED_CONTEXTS";

  const firefoxSession = (globalThis as typeof globalThis & {
    browser?: { storage?: { session?: FirefoxStorageSession } };
  }).browser?.storage?.session;
  if (typeof firefoxSession?.setAccessLevel === "function") {
    try { await firefoxSession.setAccessLevel(accessLevel); } catch { /* unsupported */ }
    return;
  }

  const sessionStorage = chrome.storage.session as SessionStorageWithAccessLevel;
  if (typeof sessionStorage.setAccessLevel === "function") {
    try { await sessionStorage.setAccessLevel({ accessLevel }); } catch { /* unsupported */ }
  }
}
