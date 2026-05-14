import type { StateStorage } from "zustand/middleware";

const LOCAL_KEY = "tabslate-auth";
const SESSION_KEY = "tabslate-auth-token";

interface StoredAuthBlob {
  state?: { accessToken?: string | null; [key: string]: unknown };
  version?: number;
}

export const authStorageAdapter: StateStorage = {
  getItem: async (_name: string): Promise<string | null> => {
    const [localResult, sessionResult] = await Promise.all([
      chrome.storage.local.get(LOCAL_KEY),
      chrome.storage.session.get(SESSION_KEY),
    ]);

    const localRaw = localResult[LOCAL_KEY];
    if (typeof localRaw !== "string") {
      return null;
    }

    let blob: StoredAuthBlob;
    try {
      blob = JSON.parse(localRaw) as StoredAuthBlob;
    } catch {
      return null;
    }

    if (!blob.state) {
      return localRaw;
    }

    const legacyLocalAccessToken =
      typeof blob.state.accessToken === "string" ? blob.state.accessToken : null;

    delete blob.state.accessToken;

    const sessionRaw = sessionResult[SESSION_KEY];
    if (typeof sessionRaw !== "string") {
      if (!legacyLocalAccessToken) {
        blob.state.accessToken = null;
        return JSON.stringify(blob);
      }

      const sanitizedLocalValue = JSON.stringify(blob);
      blob.state.accessToken = legacyLocalAccessToken;

      await Promise.all([
        new Promise<void>((resolve) => {
          chrome.storage.session.set(
            {
              [SESSION_KEY]: JSON.stringify({
                accessToken: legacyLocalAccessToken,
              }),
            },
            () => resolve(),
          );
        }),
        new Promise<void>((resolve) => {
          chrome.storage.local.set({ [LOCAL_KEY]: sanitizedLocalValue }, () => resolve());
        }),
      ]);

      return JSON.stringify(blob);
    }

    try {
      const sessionBlob = JSON.parse(sessionRaw) as { accessToken?: string | null };
      blob.state.accessToken = sessionBlob.accessToken ?? null;
    } catch {
      blob.state.accessToken = null;
    }

    return JSON.stringify(blob);
  },

  setItem: async (_name: string, value: string): Promise<void> => {
    let blob: StoredAuthBlob;
    try {
      blob = JSON.parse(value) as StoredAuthBlob;
    } catch {
      return;
    }

    const accessToken = blob.state?.accessToken ?? null;
    if (blob.state) {
      delete blob.state.accessToken;
    }

    await Promise.all([
      new Promise<void>((resolve) => {
        chrome.storage.local.set({ [LOCAL_KEY]: JSON.stringify(blob) }, () => resolve());
      }),
      accessToken
        ? new Promise<void>((resolve) => {
            chrome.storage.session.set(
              { [SESSION_KEY]: JSON.stringify({ accessToken }) },
              () => resolve(),
            );
          })
        : new Promise<void>((resolve) => {
            chrome.storage.session.remove(SESSION_KEY, () => resolve());
          }),
    ]);
  },

  removeItem: async (_name: string): Promise<void> => {
    await Promise.all([
      new Promise<void>((resolve) => {
        chrome.storage.local.remove(LOCAL_KEY, () => resolve());
      }),
      new Promise<void>((resolve) => {
        chrome.storage.session.remove(SESSION_KEY, () => resolve());
      }),
    ]);
  },
};
