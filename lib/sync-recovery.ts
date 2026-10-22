import type {
  SyncEntity,
  SyncEntityType,
  SyncPushEntities,
  SyncPushPayload,
  SyncRejected,
  TagHierarchyRecord,
} from "./api";
import type { SyncEntityReference } from "./sync-conflicts";

const RECOVERY_KEY = "tabslate-sync-recovery";
export const MAX_SYNC_ENTITIES_PER_PUSH = 900;

/**
 * Maximum UTF-8 JSON bytes budgeted for entities in one sync push chunk.
 * This excludes the request envelope, which is small relative to the 512 KiB
 * server body limit.
 */
export const MAX_SYNC_PUSH_BYTES = 384 * 1024;

const syncTextEncoder = new TextEncoder();

/** An entity's JSON UTF-8 length plus one byte reserved for its array separator. */
function syncEntityBytes(entity: SyncEntity): number {
  return syncTextEncoder.encode(JSON.stringify(entity)).length + 1;
}

function chunkSyncEntries<T>(
  entries: readonly T[],
  entityOf: (entry: T) => SyncEntity,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const entry of entries) {
    const bytes = syncEntityBytes(entityOf(entry));
    const exceedsLimit = current.length >= MAX_SYNC_ENTITIES_PER_PUSH ||
      currentBytes + bytes > MAX_SYNC_PUSH_BYTES;
    if (current.length > 0 && exceedsLimit) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += bytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

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

export function matchesCapturedSyncEntity(
  capturedPayload: SyncPushPayload | undefined,
  payloadKey: keyof SyncPushEntities,
  entity: SyncEntity,
): boolean {
  if (!capturedPayload) {
    return true;
  }
  return syncPayloadEntities(capturedPayload, payloadKey).some((captured) =>
    captured.id === entity.id && JSON.stringify(captured) === JSON.stringify(entity)
  );
}

/** Tombstones release sibling names/quota before live parent-before-child writes. */
function orderTagsForPush(tags: SyncEntity[]): SyncEntity[] {
  const compareIds = (a: SyncEntity, b: SyncEntity) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const tombstones = tags.filter(tag => tag.deleted_at != null).sort(compareIds);
  const live = tags.filter(tag => tag.deleted_at == null).sort(compareIds);
  const byId = new Map(live.map(tag => [tag.id, tag]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: SyncEntity[] = [...tombstones];
  const visit = (tag: SyncEntity) => {
    // Invalid cycles remain deterministic and are left to server validation.
    if (visited.has(tag.id) || visiting.has(tag.id)) { return; }
    visiting.add(tag.id);
    const parent = typeof tag.parent_id === "string" ? byId.get(tag.parent_id) : undefined;
    if (parent) { visit(parent); }
    visiting.delete(tag.id);
    visited.add(tag.id);
    ordered.push(tag);
  };
  for (const tag of live) { visit(tag); }
  return ordered;
}

export function acceptedSyncPushPayload(payload: SyncPushPayload, rejected: readonly SyncRejected[]): SyncPushPayload {
  const accepted = createEmptySyncPushPayload();
  for (const { entityType, payloadKey } of SYNC_ENTITY_PAYLOAD_MAPPINGS) {
    for (const entity of syncPayloadEntities(payload, payloadKey)) {
      const denied = rejected.some(item => item.id === entity.id && (
        item.type === entityType || !SYNC_ENTITY_PAYLOAD_MAPPINGS.some(mapping => mapping.entityType === item.type)
      ));
      if (!denied) { syncPayloadEntities(accepted, payloadKey).push(entity); }
    }
  }
  return accepted;
}

export class SyncTagOrderingError extends Error {
  constructor() {
    super("sync_tagOrderingPending");
    this.name = "SyncTagOrderingError";
  }
}

function tagParent(tag: SyncEntity): string {
  return typeof tag.parent_id === "string" ? tag.parent_id : "";
}

/** IDs involved in hierarchy violations introduced by this tentative batch. */
function tagBatchBlockers(before: Map<string, SyncEntity>, updates: readonly SyncEntity[]): Set<string> {
  const graph = new Map(before);
  for (const tag of updates) { graph.set(tag.id, tag); }
  const blockers = new Set<string>();
  const structural = new Set<string>();
  const siblings = new Map<string, SyncEntity[]>();
  const siblingKey = (tag: SyncEntity) => JSON.stringify([
    tagParent(tag), typeof tag.name === "string" ? tag.name.trim().toLowerCase() : tag.id,
  ]);
  for (const tag of graph.values()) {
    if (tag.deleted_at != null) { continue; }
    const key = siblingKey(tag);
    const group = siblings.get(key) ?? [];
    group.push(tag);
    siblings.set(key, group);
  }
  for (const tag of updates) {
    if (tag.deleted_at != null) { continue; }
    const old = before.get(tag.id);
    const parentChanged = !old || old.deleted_at != null || tagParent(old) !== tagParent(tag);
    const nameChanged = !old || old.name !== tag.name;
    if (parentChanged) {
      structural.add(tag.id);
      const parent = graph.get(tagParent(tag));
      if (tagParent(tag) && (!parent || parent.deleted_at != null)) {
        blockers.add(tag.id); blockers.add(tagParent(tag));
      }
    }
    if (!parentChanged && !nameChanged) { continue; }
    for (const sibling of siblings.get(siblingKey(tag)) ?? []) {
      if (sibling.id === tag.id) { continue; }
      const oldSibling = before.get(sibling.id);
      if (old && oldSibling && old.deleted_at == null && oldSibling.deleted_at == null &&
        siblingKey(old) === siblingKey(oldSibling) && siblingKey(old) === siblingKey(tag)) { continue; }
      blockers.add(tag.id); blockers.add(sibling.id);
    }
  }
  for (const tag of graph.values()) {
    if (tag.deleted_at != null) { continue; }
    const path = new Set<string>();
    let node: SyncEntity | undefined = tag;
    let cycle = false;
    while (node && node.deleted_at == null) {
      if (path.has(node.id)) { cycle = true; break; }
      path.add(node.id);
      node = graph.get(tagParent(node));
    }
    if ((cycle || path.size > 5) && [...path].some(id => structural.has(id))) {
      for (const id of path) { blockers.add(id); }
    }
  }
  return blockers;
}

function safeTagBatches(tags: SyncEntity[], authoritative: readonly TagHierarchyRecord[]): SyncEntity[][] {
  const graph = new Map<string, SyncEntity>(authoritative.map(tag => [tag.id, { ...tag }]));
  const pending = new Map(tags.map(tag => [tag.id, tag]));
  const invalid = new Set<string>();
  // Genuine invalid final intents still need server rejection and restoration,
  // but must not disable safe packing for unrelated valid coalesced changes.
  while (true) {
    const blockers = tagBatchBlockers(graph, [...pending.values()]);
    let removed = false;
    for (const id of blockers) {
      if (pending.delete(id)) { invalid.add(id); removed = true; }
    }
    if (!removed) { break; }
  }
  const batches: SyncEntity[][] = [];
  let batch: SyncEntity[] = [];
  let bytes = 0;
  while (pending.size > 0) {
    let progressed = false;
    for (const seed of pending.values()) {
      const group = new Map<string, SyncEntity>([[seed.id, seed]]);
      let safe = false;
      while (true) {
        const blockers = tagBatchBlockers(graph, [...group.values()]);
        if (blockers.size === 0) { safe = true; break; }
        let added = false;
        for (const id of blockers) {
          const dependency = pending.get(id);
          if (dependency && !group.has(id)) { group.set(id, dependency); added = true; }
        }
        if (!added) { break; }
      }
      if (!safe) { continue; }
      const entries = orderTagsForPush([...group.values()]);
      const groupBytes = entries.reduce((total, tag) => total + syncEntityBytes(tag), 0);
      const fits = batch.length + entries.length <= MAX_SYNC_ENTITIES_PER_PUSH &&
        (bytes + groupBytes <= MAX_SYNC_PUSH_BYTES || (batch.length === 0 && entries.length === 1));
      if (!fits) { continue; }
      for (const tag of entries) {
        graph.set(tag.id, tag);
        pending.delete(tag.id);
        batch.push(tag);
      }
      bytes += groupBytes;
      progressed = true;
      break;
    }
    if (progressed) { continue; }
    if (batch.length === 0) { throw new SyncTagOrderingError(); }
    batches.push(batch);
    batch = [];
    bytes = 0;
  }
  if (batch.length > 0) { batches.push(batch); }
  batches.push(...chunkSyncEntries(tags.filter(tag => invalid.has(tag.id)), tag => tag));
  return batches;
}

export function splitSyncPushPayload(full: SyncPushPayload, authoritativeTags?: readonly TagHierarchyRecord[]): SyncPushPayload[] {
  const { workspaces, collections, bookmarks, groups } = full.entities;
  const tags = orderTagsForPush(full.entities.tags);
  const all: SyncEntity[] = [...workspaces, ...collections, ...bookmarks, ...tags, ...groups];
  const totalBytes = all.reduce((sum, entity) => sum + syncEntityBytes(entity), 0);
  if (all.length <= MAX_SYNC_ENTITIES_PER_PUSH && totalBytes <= MAX_SYNC_PUSH_BYTES) {
    return tags.every((tag, index) => tag === full.entities.tags[index])
      ? [full]
      : [{ entities: { ...full.entities, tags } }];
  }
  if (authoritativeTags) {
    const tagBatches = safeTagBatches(tags, authoritativeTags);
    const before = createEmptySyncPushPayload();
    before.entities.workspaces = workspaces;
    before.entities.collections = collections;
    const after = createEmptySyncPushPayload();
    after.entities.groups = groups;
    after.entities.bookmarks = bookmarks;
    return [
      ...(!isSyncPushPayloadEmpty(before) ? splitSyncPushPayload(before) : []),
      ...tagBatches.map(batch => {
        const payload = createEmptySyncPushPayload();
        payload.entities.tags = batch;
        return payload;
      }),
      ...(!isSyncPushPayloadEmpty(after) ? splitSyncPushPayload(after) : []),
    ];
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
  for (const group of chunkSyncEntries(nonBookmarks, (entry) => entry.entity)) {
    const chunk = createEmptySyncPushPayload();
    for (const { payloadKey, entity } of group) {
      syncPayloadEntities(chunk, payloadKey).push(entity);
    }
    chunks.push(chunk);
  }
  for (const group of chunkSyncEntries(bookmarks, (entity) => entity)) {
    const chunk = createEmptySyncPushPayload();
    chunk.entities.bookmarks.push(...group);
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
  capturedPayload?: SyncPushPayload,
): Promise<SyncPushPayload> {
  await _storagePersistence.catch(() => {});
  const sessionStorage = getSessionStorage();
  let snapshot = _pendingRecoverySnapshot;
  if (snapshot === null && sessionStorage) {
    const stored = await sessionStorage.get(RECOVERY_KEY);
    snapshot = parseRecoverySnapshot(stored[RECOVERY_KEY]);
  }
  const extracted = createEmptySyncPushPayload();
  if (snapshot === null) {
    return extracted;
  }

  const referenceIds = referenceIdsByType(references);

  const remainder = createEmptySyncPushPayload();
  for (const { entityType, payloadKey } of SYNC_ENTITY_PAYLOAD_MAPPINGS) {
    const matchingIds = referenceIds.get(entityType);
    const extractedEntities = syncPayloadEntities(extracted, payloadKey);
    const remainingEntities = syncPayloadEntities(remainder, payloadKey);
    for (const entity of syncPayloadEntities(snapshot, payloadKey)) {
      if (
        !matchingIds?.has(entity.id) ||
        !matchesCapturedSyncEntity(capturedPayload, payloadKey, entity)
      ) {
        remainingEntities.push(entity);
      } else {
        extractedEntities.push(entity);
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
  capturedPayload?: SyncPushPayload,
): Promise<void> {
  await extractSyncRecoveryEntities(references, capturedPayload);
}

export function clearSyncRecoverySnapshot() {
  _pendingRecoverySnapshot = null;
  void setRecoverySnapshotInStorage(null);
}
