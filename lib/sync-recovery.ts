import type {
  SyncEntity,
  SyncEntityType,
  SyncPushEntities,
  SyncPushPayload,
} from "./api";
import type { SyncEntityReference } from "./sync-conflicts";

const RECOVERY_KEY = "tabslate-sync-recovery";
export const MAX_SYNC_ENTITIES_PER_PUSH = 900;

function getSessionStorage() {
  return globalThis.chrome?.storage?.session;
}

export const SYNC_ENTITY_PAYLOAD_MAPPINGS: ReadonlyArray<{
  entityType: SyncEntityType;
  payloadKey: keyof SyncPushEntities;
}> = [
  { entityType: "workspace", payloadKey: "workspaces" },
  { entityType: "collection", payloadKey: "collections" },
  { entityType: "bookmark", payloadKey: "bookmarks" },
  { entityType: "tag", payloadKey: "tags" },
  { entityType: "saved_group", payloadKey: "groups" },
];

export function createEmptySyncPushPayload(): SyncPushPayload {
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

export function isSyncPushPayloadEmpty(payload: SyncPushPayload): boolean {
  return SYNC_ENTITY_PAYLOAD_MAPPINGS.every(
    ({ payloadKey }) => syncPayloadEntities(payload, payloadKey).length === 0,
  );
}

export function syncPayloadEntities(
  payload: SyncPushPayload,
  payloadKey: keyof SyncPushEntities,
): SyncEntity[] {
  switch (payloadKey) {
    case "workspaces":
      return payload.entities.workspaces;
    case "collections":
      return payload.entities.collections;
    case "bookmarks":
      return payload.entities.bookmarks;
    case "tags":
      return payload.entities.tags;
    case "groups":
      return payload.entities.groups;
  }
}

export function splitSyncPushPayload(full: SyncPushPayload): SyncPushPayload[] {
  const { workspaces, collections, bookmarks, tags, groups } = full.entities;
  const total = workspaces.length + collections.length + bookmarks.length +
    tags.length + groups.length;
  if (total <= MAX_SYNC_ENTITIES_PER_PUSH) {
    return [full];
  }
  const chunks: SyncPushPayload[] = [];
  interface NonBookmarkEntry {
    payloadKey: "workspaces" | "collections" | "tags" | "groups";
    entity: SyncEntity;
  }
  const entries = (
    payloadKey: NonBookmarkEntry["payloadKey"],
    entities: SyncEntity[],
  ): NonBookmarkEntry[] => entities.map((entity) => ({ payloadKey, entity }));
  const nonBookmarks: NonBookmarkEntry[] = [
    ...entries("workspaces", workspaces),
    ...entries("collections", collections),
    ...entries("tags", tags),
    ...entries("groups", groups),
  ];
  for (let index = 0; index < nonBookmarks.length; index += MAX_SYNC_ENTITIES_PER_PUSH) {
    const chunk = createEmptySyncPushPayload();
    for (const { payloadKey, entity } of nonBookmarks.slice(
      index,
      index + MAX_SYNC_ENTITIES_PER_PUSH,
    )) {
      syncPayloadEntities(chunk, payloadKey).push(entity);
    }
    chunks.push(chunk);
  }
  for (let index = 0; index < bookmarks.length; index += MAX_SYNC_ENTITIES_PER_PUSH) {
    const chunk = createEmptySyncPushPayload();
    chunk.entities.bookmarks.push(
      ...bookmarks.slice(index, index + MAX_SYNC_ENTITIES_PER_PUSH),
    );
    chunks.push(chunk);
  }
  return chunks;
}

function mergeEntities(current: SyncEntity[], incoming: SyncEntity[]): SyncEntity[] {
  const merged = new Map<string, SyncEntity>();

  for (const entity of current) {
    merged.set(entity.id, entity);
  }

  for (const entity of incoming) {
    merged.set(entity.id, entity);
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
    _pendingRecoverySnapshot = createEmptySyncPushPayload();
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
  const snapshot = parseRecoverySnapshot(stored[RECOVERY_KEY]);
  await sessionStorage.remove(RECOVERY_KEY);
  return snapshot;
}

function parseRecoverySnapshot(raw: unknown): SyncPushPayload | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null;
    const isPayload = (value: unknown): value is SyncPushPayload => {
      if (!isRecord(value) || !isRecord(value.entities)) {
        return false;
      }
      const entities = value.entities;
      const isEntityArray = (key: keyof SyncPushEntities): boolean => {
        const values = entities[key];
        return Array.isArray(values) && values.every((entity) =>
          isRecord(entity) && typeof entity.id === "string"
        );
      };
      return SYNC_ENTITY_PAYLOAD_MAPPINGS.every(
        ({ payloadKey }) => isEntityArray(payloadKey),
      );
    };
    if (!isPayload(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function extractSyncRecoveryEntities(
  references: readonly SyncEntityReference[],
): Promise<SyncPushPayload> {
  await _storagePersistence.catch(() => {});
  const sessionStorage = getSessionStorage();
  let snapshot = _pendingRecoverySnapshot;
  if (snapshot === null && sessionStorage) {
    const stored = await sessionStorage.get(RECOVERY_KEY);
    snapshot = parseRecoverySnapshot(stored[RECOVERY_KEY]);
  }
  const extracted = selectSyncPayloadEntities(snapshot, references);
  if (snapshot === null) {
    return extracted;
  }

  const referenceIds = referenceIdsByType(references);

  const remainder = createEmptySyncPushPayload();
  for (const { entityType, payloadKey } of SYNC_ENTITY_PAYLOAD_MAPPINGS) {
    const matchingIds = referenceIds.get(entityType);
    const remainingEntities = syncPayloadEntities(remainder, payloadKey);
    for (const entity of syncPayloadEntities(snapshot, payloadKey)) {
      if (!matchingIds?.has(entity.id)) {
        remainingEntities.push(entity);
      }
    }
  }

  _pendingRecoverySnapshot = isSyncPushPayloadEmpty(remainder) ? null : remainder;
  await setRecoverySnapshotInStorage(_pendingRecoverySnapshot);
  return extracted;
}

function referenceIdsByType(
  references: readonly SyncEntityReference[],
): Map<SyncEntityType, Set<string>> {
  const referenceIds = new Map<SyncEntityType, Set<string>>();
  for (const { entityType } of SYNC_ENTITY_PAYLOAD_MAPPINGS) {
    referenceIds.set(entityType, new Set());
  }
  for (const reference of references) {
    referenceIds.get(reference.entityType)?.add(reference.entityId);
  }
  return referenceIds;
}

function selectSyncPayloadEntities(
  snapshot: SyncPushPayload | null,
  references: readonly SyncEntityReference[],
): SyncPushPayload {
  const selected = createEmptySyncPushPayload();
  if (snapshot === null) {
    return selected;
  }
  const referenceIds = referenceIdsByType(references);
  for (const { entityType, payloadKey } of SYNC_ENTITY_PAYLOAD_MAPPINGS) {
    const matchingIds = referenceIds.get(entityType);
    const selectedEntities = syncPayloadEntities(selected, payloadKey);
    for (const entity of syncPayloadEntities(snapshot, payloadKey)) {
      if (matchingIds?.has(entity.id)) {
        selectedEntities.push(structuredClone(entity));
      }
    }
  }
  return selected;
}

export async function copySyncRecoveryEntities(
  references: readonly SyncEntityReference[],
): Promise<SyncPushPayload> {
  await _storagePersistence.catch(() => {});
  let snapshot = _pendingRecoverySnapshot;
  const sessionStorage = getSessionStorage();
  if (snapshot === null && sessionStorage) {
    const stored = await sessionStorage.get(RECOVERY_KEY);
    snapshot = parseRecoverySnapshot(stored[RECOVERY_KEY]);
  }
  return selectSyncPayloadEntities(snapshot, references);
}

export async function pruneSyncRecoveryEntities(
  references: readonly SyncEntityReference[],
): Promise<void> {
  await extractSyncRecoveryEntities(references);
}

export function clearSyncRecoverySnapshot() {
  _pendingRecoverySnapshot = null;
  void setRecoverySnapshotInStorage(null);
}
