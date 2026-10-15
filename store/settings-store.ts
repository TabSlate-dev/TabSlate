import { create } from "zustand";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { hasSettingsSyncConsent } from "@/lib/browser/data-collection";
import {
  fetchRemoteViewPrefs,
  pushViewPrefs,
  readLocalViewPrefs,
  resolvePullAction,
  writeLocalViewPrefs,
  type BookmarkViewPrefs,
  type PreferenceCredentials,
  type PushViewPrefsResult,
} from "@/lib/view-preferences";

const PUSH_DEBOUNCE_MS = 1000;

export type GetPreferenceCredentials = () => PreferenceCredentials | null;

interface SettingsState {
  _hydrated: boolean;
  hydrate: () => Promise<void>;
  reset: () => void;
  /** Remembers how to reach the server for this sync session and reconciles view preferences once. */
  startPreferenceSync: (getCredentials: GetPreferenceCredentials) => Promise<void>;
  /** Reconciles view preferences again, e.g. after Firefox consent is granted. */
  resyncPreferences: () => Promise<void>;
  stopPreferenceSync: () => void;
}

let preferenceCredentials: GetPreferenceCredentials | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let applyingRemote = false;
let sessionVersion = 0;
let localRevision = 0;
let localWrites: Promise<void> = Promise.resolve();
let pushWrites: Promise<void> = Promise.resolve();
let unsubscribeViewPrefs: (() => void) | null = null;

/** Keep async read/modify/write operations ordered with user edits. */
function queueLocalWrite(action: () => Promise<void>): Promise<void> {
  const pending = localWrites.then(action);
  localWrites = pending.catch(() => {});
  return pending;
}

function isCurrentSession(version: number): boolean {
  return version === sessionVersion && preferenceCredentials !== null;
}

function clearPushTimer(): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
}

/** Server and stored values are not user changes, so the subscription ignores them. */
function applyViewPrefs(prefs: BookmarkViewPrefs): void {
  applyingRemote = true;
  try {
    const bookmarks = useBookmarksStore.getState();
    bookmarks.setViewMode(prefs.viewMode);
    bookmarks.setSortBy(prefs.sortBy);
  } finally {
    applyingRemote = false;
  }
}

async function eligibleCredentials(version: number): Promise<PreferenceCredentials | null> {
  if (!isCurrentSession(version) || !(await hasSettingsSyncConsent()) || !isCurrentSession(version)) {
    return null;
  }
  return preferenceCredentials?.() ?? null;
}

/** Dispatched PUTs cannot be revoked. Order them, then drain edits made while waiting. */
function pushDirtyViewPrefs(version = sessionVersion): Promise<void> {
  const pending = pushWrites.then(async () => {
    let revision: number;
    do {
      revision = localRevision;
      await pushDirtySnapshot(version);
    } while (isCurrentSession(version) && revision !== localRevision);
  });
  pushWrites = pending.catch(() => {});
  return pending;
}

async function pushDirtySnapshot(version: number): Promise<void> {
  const credentials = await eligibleCredentials(version);
  if (!credentials) {
    return;
  }
  await localWrites;
  const revision = localRevision;
  const local = await readLocalViewPrefs();
  if (!local?.dirty || !isCurrentSession(version) || revision !== localRevision) {
    return;
  }
  let dispatched = false;
  let outcome: PushViewPrefsResult;
  try {
    outcome = await pushViewPrefs(credentials, local, async () => {
      const current = await eligibleCredentials(version);
      dispatched = current !== null && current.baseUrl === credentials.baseUrl &&
        current.accessToken === credentials.accessToken && revision === localRevision;
      return dispatched;
    });
  } catch {
    // Stays dirty; the next change or pull retries.
    return;
  }
  const current = await eligibleCredentials(version);
  if (!dispatched || outcome.status === "ineligible" || !current ||
    current.baseUrl !== credentials.baseUrl || current.accessToken !== credentials.accessToken) {
    return;
  }
  await queueLocalWrite(async () => {
    const latest = await readLocalViewPrefs();
    if (
      isCurrentSession(version) && revision === localRevision && latest &&
      latest.updatedAt === local.updatedAt && latest.viewMode === local.viewMode && latest.sortBy === local.sortBy
    ) {
      if (outcome.status === "remote-newer") {
        applyViewPrefs(outcome.prefs);
        await writeLocalViewPrefs({ ...outcome.prefs, dirty: false });
      } else {
        await writeLocalViewPrefs({ ...latest, dirty: false });
      }
    }
  });
}

function schedulePush(): void {
  clearPushTimer();
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushDirtyViewPrefs().catch(() => {});
  }, PUSH_DEBOUNCE_MS);
}

async function recordLocalChange(): Promise<void> {
  const { viewMode, sortBy } = useBookmarksStore.getState();
  const prefs = { viewMode, sortBy, updatedAt: Date.now(), dirty: true };
  localRevision += 1;
  await queueLocalWrite(() => writeLocalViewPrefs(prefs));
  schedulePush();
}

async function reconcileViewPrefs(): Promise<void> {
  const version = sessionVersion;
  const credentials = await eligibleCredentials(version);
  if (!credentials) {
    return;
  }
  let remote: BookmarkViewPrefs | null;
  try {
    remote = await fetchRemoteViewPrefs(credentials);
  } catch {
    return;
  }
  let shouldPush = false;
  await queueLocalWrite(async () => {
    // Read after the network response and all earlier user writes have settled.
    const revision = localRevision;
    const local = await readLocalViewPrefs();
    if (!isCurrentSession(version) || revision !== localRevision) {
      return;
    }
    const action = resolvePullAction(local, remote);
    if (action === "apply-remote" && remote) {
      applyViewPrefs(remote);
      await writeLocalViewPrefs({ ...remote, dirty: false });
      return;
    }
    if (action === "push-local" && local) {
      if (!local.dirty) {
        await writeLocalViewPrefs({ ...local, dirty: true });
      }
      shouldPush = true;
    }
  });
  if (shouldPush) {
    await pushDirtyViewPrefs(version);
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  _hydrated: false,
  hydrate: async () => {
    try {
      const local = await readLocalViewPrefs();
      if (local) {
        applyViewPrefs(local);
      }
    } catch {
      // Unreadable preferences keep the defaults.
    }
    unsubscribeViewPrefs?.();
    unsubscribeViewPrefs = useBookmarksStore.subscribe((state, previous) => {
      if (applyingRemote || (state.viewMode === previous.viewMode && state.sortBy === previous.sortBy)) {
        return;
      }
      void recordLocalChange().catch(() => {});
    });
    set({ _hydrated: true });
  },
  reset: () => {
    clearPushTimer();
    preferenceCredentials = null;
    sessionVersion += 1;
    set({ _hydrated: true });
  },
  startPreferenceSync: async (getCredentials) => {
    clearPushTimer();
    sessionVersion += 1;
    preferenceCredentials = getCredentials;
    await reconcileViewPrefs().catch(() => {});
  },
  resyncPreferences: async () => {
    await reconcileViewPrefs().catch(() => {});
  },
  stopPreferenceSync: () => {
    clearPushTimer();
    preferenceCredentials = null;
    sessionVersion += 1;
  },
}));
