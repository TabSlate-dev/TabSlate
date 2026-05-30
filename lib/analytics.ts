import { generateId } from "./id";

const ANALYTICS_ID_KEY = "tabslate-analytics-id";

interface AnalyticsProperties {
  [key: string]: boolean | number | string;
}

interface AnalyticsTrackPayload {
  name: string;
  profileId: string;
  properties?: AnalyticsProperties;
}

interface AnalyticsRequestBody {
  type: "track" | "screen_view";
  payload: AnalyticsTrackPayload;
}

let profileId: string | null = null;
let initPromise: Promise<void> | null = null;

function getProcessEnvValue(key: string): string | undefined {
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return processEnv?.[key];
}

function getOpenpanelUrl(): string {
  return import.meta.env.VITE_OPENPANEL_URL ?? getProcessEnvValue("VITE_OPENPANEL_URL") ?? "";
}

function getOpenpanelClientId(): string {
  return import.meta.env.VITE_OPENPANEL_CLIENT_ID ?? getProcessEnvValue("VITE_OPENPANEL_CLIENT_ID") ?? "";
}

function isAnalyticsEnabled(): boolean {
  return getOpenpanelUrl().length > 0 && getOpenpanelClientId().length > 0;
}

async function withAnalyticsLock<T>(task: () => Promise<T>): Promise<T> {
  const navigatorWithLocks = globalThis.navigator;
  if (!navigatorWithLocks?.locks?.request) {
    return task();
  }

  return navigatorWithLocks.locks.request(
    "tabslate-analytics-id",
    { mode: "exclusive" },
    task,
  );
}

async function persistProfileId(nextProfileId: string): Promise<void> {
  await chrome.storage.local.set({
    [ANALYTICS_ID_KEY]: nextProfileId,
  });
}

async function loadStoredProfileId(): Promise<string | null> {
  const result = await chrome.storage.local.get(ANALYTICS_ID_KEY);
  const storedProfileId = result[ANALYTICS_ID_KEY];

  if (typeof storedProfileId !== "string" || storedProfileId.length === 0) {
    return null;
  }

  return storedProfileId;
}

async function init(): Promise<void> {
  if (!isAnalyticsEnabled()) {
    return;
  }

  if (profileId) {
    return;
  }

  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    try {
      await withAnalyticsLock(async () => {
        const storedProfileId = await loadStoredProfileId();
        if (storedProfileId) {
          profileId = storedProfileId;
          return;
        }

        const nextProfileId = generateId();
        await persistProfileId(nextProfileId);
        profileId = nextProfileId;
      });
    } catch {
      if (!profileId) {
        profileId = generateId();
      }
    } finally {
      initPromise = null;
    }
  })();

  await initPromise;
}

async function postTrackEvent(
  openpanelUrl: string,
  openpanelClientId: string,
  body: AnalyticsRequestBody,
): Promise<void> {
  await fetch(`${openpanelUrl.replace(/\/$/, "")}/api/track`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "openpanel-client-id": openpanelClientId,
    },
    body: JSON.stringify(body),
  });
}

function track(name: string, properties?: AnalyticsProperties): void {
  if (!isAnalyticsEnabled()) {
    return;
  }

  void (async () => {
    try {
      if (!profileId) {
        await init();
      }

      if (!profileId) {
        return;
      }

      await postTrackEvent(getOpenpanelUrl(), getOpenpanelClientId(), {
        type: name === "page_view" ? "screen_view" : "track",
        payload: {
          name,
          profileId,
          properties: properties ?? {},
        },
      });
    } catch {
      // Analytics must never interrupt the extension.
    }
  })();
}

export const analytics = {
  init,
  track,
};
