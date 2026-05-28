import type { SyncPushPayload } from "./api";

const RECOVERY_KEY = "tabslate-sync-recovery";

function getSessionStorage() {
  return globalThis.chrome?.storage?.session;
}

function createEmptySnapshot(): SyncPushPayload {
  return {
    entities: {
      workspaces: [],
      collections: [],
      bookmarks: [],
      tags: [],
      groups: [],
    },
  };
}

function mergeEntities(current: object[], incoming: object[]): object[] {
  const merged = new Map<string, object>();

  for (const entity of current) {
    merged.set((entity as { id: string }).id, entity);
  }

  for (const entity of incoming) {
    merged.set((entity as { id: string }).id, entity);
  }

  return Array.from(merged.values());
}

let _pendingRecoverySnapshot: SyncPushPayload | null = null;
let _storagePersistence: Promise<void> = Promise.resolve();

function setRecoverySnapshotInStorage(snapshot: SyncPushPayload | null) {
  _storagePersistence = _storagePersistence
    .catch(() => {})
    .then(async () => {
      const sessionStorage = getSessionStorage();
      if (!sessionStorage) {
        return;
      }

      if (snapshot === null) {
        await sessionStorage.remove(RECOVERY_KEY);
        return;
      }

      await sessionStorage.set({
        [RECOVERY_KEY]: JSON.stringify(snapshot),
      });
    });

  return _storagePersistence;
}

export function bufferSyncRecoverySnapshot(snapshot: SyncPushPayload) {
  if (_pendingRecoverySnapshot === null) {
    _pendingRecoverySnapshot = createEmptySnapshot();
  }

  _pendingRecoverySnapshot.entities.workspaces = mergeEntities(
    _pendingRecoverySnapshot.entities.workspaces,
    snapshot.entities.workspaces,
  );
  _pendingRecoverySnapshot.entities.collections = mergeEntities(
    _pendingRecoverySnapshot.entities.collections,
    snapshot.entities.collections,
  );
  _pendingRecoverySnapshot.entities.bookmarks = mergeEntities(
    _pendingRecoverySnapshot.entities.bookmarks,
    snapshot.entities.bookmarks,
  );
  _pendingRecoverySnapshot.entities.tags = mergeEntities(
    _pendingRecoverySnapshot.entities.tags,
    snapshot.entities.tags,
  );
  _pendingRecoverySnapshot.entities.groups = mergeEntities(
    _pendingRecoverySnapshot.entities.groups,
    snapshot.entities.groups,
  );

  void setRecoverySnapshotInStorage(_pendingRecoverySnapshot);
}

export function takeSyncRecoverySnapshot(): SyncPushPayload | null {
  if (_pendingRecoverySnapshot === null) {
    return null;
  }

  const snapshot = _pendingRecoverySnapshot;
  _pendingRecoverySnapshot = null;
  void setRecoverySnapshotInStorage(null);
  return snapshot;
}

export async function loadSyncRecoverySnapshot(): Promise<SyncPushPayload | null> {
  if (_pendingRecoverySnapshot !== null) {
    return takeSyncRecoverySnapshot();
  }

  await _storagePersistence.catch(() => {});

  const sessionStorage = getSessionStorage();
  if (!sessionStorage) {
    return null;
  }

  const stored = await sessionStorage.get(RECOVERY_KEY);
  const raw = stored[RECOVERY_KEY];
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }

  try {
    const snapshot = JSON.parse(raw) as SyncPushPayload;
    await sessionStorage.remove(RECOVERY_KEY);
    return snapshot;
  } catch {
    await sessionStorage.remove(RECOVERY_KEY);
    return null;
  }
}

export function clearSyncRecoverySnapshot() {
  _pendingRecoverySnapshot = null;
  void setRecoverySnapshotInStorage(null);
}
