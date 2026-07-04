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
    await firefoxSession.setAccessLevel(accessLevel);
    return;
  }

  const sessionStorage = chrome.storage.session as SessionStorageWithAccessLevel;
  if (typeof sessionStorage.setAccessLevel === "function") {
    await sessionStorage.setAccessLevel({ accessLevel });
  }
}
