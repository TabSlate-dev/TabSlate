import type { StateStorage } from "zustand/middleware";

const LOCAL_KEY = "tabslate-auth";
const SESSION_KEY = "tabslate-auth-token";

interface StoredAuthBlob {
  state?: { accessToken?: string | null; [key: string]: unknown };
  version?: number;
}

interface BrowserStorageArea {
  get: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
}

function getBrowserStorageArea(
  area: "local" | "session",
): BrowserStorageArea | null {
  const browserStorage = (globalThis as typeof globalThis & {
    browser?: { storage?: { local?: BrowserStorageArea; session?: BrowserStorageArea } };
  }).browser?.storage;

  if (area === "local") {
    return browserStorage?.local ?? null;
  }

  return browserStorage?.session ?? null;
}

async function storageGet(
  area: "local" | "session",
  key: string,
): Promise<Record<string, unknown>> {
  const browserArea = getBrowserStorageArea(area);
  if (browserArea) {
    return browserArea.get(key);
  }

  return chrome.storage[area].get(key);
}

async function storageSet(
  area: "local" | "session",
  items: Record<string, unknown>,
): Promise<void> {
  const browserArea = getBrowserStorageArea(area);
  if (browserArea) {
    await browserArea.set(items);
    return;
  }

  await new Promise<void>((resolve) => {
    chrome.storage[area].set(items, () => resolve());
  });
}

async function storageRemove(
  area: "local" | "session",
  key: string,
): Promise<void> {
  const browserArea = getBrowserStorageArea(area);
  if (browserArea) {
    await browserArea.remove(key);
    return;
  }

  await new Promise<void>((resolve) => {
    chrome.storage[area].remove(key, () => resolve());
  });
}

export const authStorageAdapter: StateStorage = {
  getItem: async (_name: string): Promise<string | null> => {
    const [localResult, sessionResult] = await Promise.all([
      storageGet("local", LOCAL_KEY),
      storageGet("session", SESSION_KEY),
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
        storageSet("session", {
          [SESSION_KEY]: JSON.stringify({
            accessToken: legacyLocalAccessToken,
          }),
        }),
        storageSet("local", { [LOCAL_KEY]: sanitizedLocalValue }),
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
      storageSet("local", { [LOCAL_KEY]: JSON.stringify(blob) }),
      accessToken
        ? storageSet("session", { [SESSION_KEY]: JSON.stringify({ accessToken }) })
        : storageRemove("session", SESSION_KEY),
    ]);
  },

  removeItem: async (_name: string): Promise<void> => {
    await Promise.all([
      storageRemove("local", LOCAL_KEY),
      storageRemove("session", SESSION_KEY),
    ]);
  },
};
