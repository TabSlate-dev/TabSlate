import type { SyncPushPayload } from "@/lib/api";

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
}

export function takeSyncRecoverySnapshot(): SyncPushPayload | null {
  if (_pendingRecoverySnapshot === null) {
    return null;
  }

  const snapshot = _pendingRecoverySnapshot;
  _pendingRecoverySnapshot = null;
  return snapshot;
}

export function clearSyncRecoverySnapshot() {
  _pendingRecoverySnapshot = null;
}
