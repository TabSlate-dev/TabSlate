type SessionStorageWithAccessLevel = chrome.storage.SessionStorageArea & {
  setAccessLevel?: (options: { accessLevel: string }) => Promise<void> | void;
};

export async function restrictSessionStorageToTrustedContexts(): Promise<void> {
  // Firefox has not implemented storage.session.setAccessLevel (bug 1724754).
  // Branching on the compile-time FIREFOX flag keeps the Chrome-only API
  // reference out of the Firefox bundle entirely, since AMO's linter flags
  // it purely based on the built code, regardless of any runtime feature check.
  if (import.meta.env.FIREFOX) {
    return;
  }

  const accessLevel = chrome.storage.AccessLevel?.TRUSTED_CONTEXTS ?? "TRUSTED_CONTEXTS";
  const sessionStorage = chrome.storage.session as SessionStorageWithAccessLevel;
  if (typeof sessionStorage.setAccessLevel === "function") {
    try { await sessionStorage.setAccessLevel({ accessLevel }); } catch { /* unsupported */ }
  }
}
