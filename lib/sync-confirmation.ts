import type {
  SyncEntity,
  SyncPushEntities,
  SyncPushPayload,
} from "@/lib/api";
import type { StoreName } from "@/lib/idb";
import {
  WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY,
  WORKSPACE_LIFECYCLE_INTENTS_KEY,
  type WorkspaceLifecycleIntent,
} from "@/lib/workspace-lifecycle-state";

type ConfirmableStore =
  | "workspaces"
  | "collections"
  | "tags"
  | "bookmarks"
  | "archived-bookmarks"
  | "trashed-bookmarks"
  | "groups";

interface ObjectRecord {
  [key: string]: unknown;
}

interface DeferredRecord {
  version: 1;
  payloadsByWorkspaceId: Record<string, SyncPushPayload>;
}

export interface SyncConfirmationDependencies {
  commit(payload: SyncPushPayload, serverSeq: number): Promise<SyncPushPayload>;
  apply(payload: SyncPushPayload, serverSeq: number): void | Promise<void>;
}

const CONFIRMATION_STORES: StoreName[] = [
  "workspaces",
  "collections",
  "tags",
  "bookmarks",
  "archived-bookmarks",
  "trashed-bookmarks",
  "groups",
  "group-tabs",
  "kv",
];

function isObjectRecord(value: unknown): value is ObjectRecord {
  return typeof value === "object" && value !== null;
}

function isSyncEntity(value: unknown): value is SyncEntity {
  return isObjectRecord(value) && typeof value.id === "string";
}

function readString(record: ObjectRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: ObjectRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: ObjectRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(record: ObjectRecord, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function nullable(value: unknown): unknown {
  return value ?? null;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isIntent(value: unknown): value is WorkspaceLifecycleIntent {
  return isObjectRecord(value) &&
    typeof value.workspaceId === "string" &&
    (value.action === "delete" || value.action === "restore") &&
    typeof value.baseSeq === "number" &&
    typeof value.previousActiveWorkspaceId === "string" &&
    typeof value.createdAt === "number";
}

function hasIntent(
  intents: readonly WorkspaceLifecycleIntent[],
  workspaceId: string,
  action: WorkspaceLifecycleIntent["action"],
): boolean {
  return intents.some((intent) => intent.workspaceId === workspaceId && intent.action === action);
}

function matchesWorkspace(
  record: ObjectRecord,
  entity: SyncEntity,
  intents: readonly WorkspaceLifecycleIntent[],
): boolean {
  const id = readString(record, "id");
  if (id === undefined || id !== entity.id) {
    return false;
  }
  const deletedAt = readNumber(record, "deletedAt");
  if (entity.lifecycle_action === "purge") {
    return deletedAt !== undefined;
  }
  if (
    readString(record, "name") !== entity.name ||
    readString(record, "color") !== entity.color ||
    readNumber(record, "position") !== entity.position) {
    return false;
  }
  if (entity.lifecycle_action === "delete") {
    return deletedAt !== undefined && hasIntent(intents, id, "delete");
  }
  if (entity.lifecycle_action === "restore") {
    return deletedAt === undefined && hasIntent(intents, id, "restore");
  }
  if (hasIntent(intents, id, "delete") && deletedAt !== undefined) {
    return nullable(entity.deleted_at) === null;
  }
  return nullable(entity.deleted_at) === nullable(deletedAt);
}

function matchesCollection(record: ObjectRecord, entity: SyncEntity): boolean {
  return readString(record, "id") === entity.id &&
    nullable(readString(record, "workspaceId")) === nullable(entity.workspace_id) &&
    readString(record, "name") === entity.name &&
    readString(record, "icon") === entity.icon &&
    readNumber(record, "position") === entity.position &&
    nullable(readNumber(record, "deletedAt")) === nullable(entity.deleted_at) &&
    nullable(readNumber(record, "archivedAt")) === nullable(entity.archived_at);
}

function matchesTag(record: ObjectRecord, entity: SyncEntity): boolean {
  return readString(record, "id") === entity.id &&
    readString(record, "name") === entity.name &&
    readString(record, "color") === entity.color &&
    nullable(readNumber(record, "deletedAt")) === nullable(entity.deleted_at);
}

function matchesBookmark(
  store: Extract<ConfirmableStore, "bookmarks" | "archived-bookmarks" | "trashed-bookmarks">,
  record: ObjectRecord,
  entity: SyncEntity,
): boolean {
  const tags = readStringArray(record, "tags");
  const entityTags = Array.isArray(entity.tag_ids) &&
      entity.tag_ids.every((item) => typeof item === "string")
    ? entity.tag_ids
    : undefined;
  const terminalTrash = readNumber(record, "isTrashed") === 2;
  const expectedTrash = store === "trashed-bookmarks" ? (terminalTrash ? 2 : 1) : 0;
  return readString(record, "id") === entity.id &&
    nullable(readString(record, "collectionId")) === nullable(entity.collection_id) &&
    readString(record, "title") === entity.title &&
    readString(record, "url") === entity.url &&
    readString(record, "favicon") === entity.favicon_url &&
    readString(record, "description") === entity.description &&
    readBoolean(record, "isFavorite") === entity.is_favorite &&
    entity.is_archived === (store === "archived-bookmarks") &&
    entity.is_trashed === expectedTrash &&
    tags !== undefined && entityTags !== undefined && stringArraysEqual(tags, entityTags) &&
    entity.position === 0 &&
    nullable(entity.deleted_at) === nullable(terminalTrash ? readNumber(record, "deletedAt") : undefined);
}

function compareTabs(left: ObjectRecord, right: ObjectRecord): number {
  return (readNumber(left, "position") ?? 0) - (readNumber(right, "position") ?? 0) ||
    (readString(left, "id") ?? "").localeCompare(readString(right, "id") ?? "");
}

function matchesGroupTab(record: ObjectRecord, entity: SyncEntity): boolean {
  return readString(record, "id") === entity.id &&
    readString(record, "groupId") === entity.group_id &&
    readString(record, "title") === entity.title &&
    readString(record, "url") === entity.url &&
    readString(record, "favicon") === entity.favicon &&
    readNumber(record, "position") === entity.position;
}

function matchesGroup(
  record: ObjectRecord,
  entity: SyncEntity,
  tabs: readonly ObjectRecord[],
): boolean {
  const entityTabs = Array.isArray(entity.tabs) && entity.tabs.every(isSyncEntity)
    ? [...entity.tabs].sort(compareTabs)
    : undefined;
  const persistedTabs = [...tabs].sort(compareTabs);
  const createdAt = readString(record, "createdAt");
  return readString(record, "id") === entity.id &&
    readString(record, "name") === entity.name &&
    readString(record, "color") === entity.color &&
    readBoolean(record, "isCompact") === entity.is_compact &&
    readString(record, "workspaceId") === entity.workspace_id &&
    (createdAt === undefined ? undefined : new Date(createdAt).getTime()) === entity.created_at &&
    nullable(readNumber(record, "deletedAt")) === nullable(entity.deleted_at) &&
    entityTabs !== undefined && entityTabs.length === persistedTabs.length &&
    persistedTabs.every((tab, index) => {
      const pushedTab = entityTabs[index];
      return pushedTab !== undefined && matchesGroupTab(tab, pushedTab);
    });
}

export function matchesPersistedSyncEntity(
  store: ConfirmableStore,
  persisted: unknown,
  pushed: SyncEntity,
  groupTabs: readonly unknown[],
  intents: readonly WorkspaceLifecycleIntent[],
): boolean {
  if (!isObjectRecord(persisted)) {
    return false;
  }
  if (store === "workspaces") {
    return matchesWorkspace(persisted, pushed, intents);
  }
  if (store === "collections") {
    return matchesCollection(persisted, pushed);
  }
  if (store === "tags") {
    return matchesTag(persisted, pushed);
  }
  if (store === "groups") {
    return matchesGroup(persisted, pushed, groupTabs.filter(isObjectRecord));
  }
  return matchesBookmark(store, persisted, pushed);
}

function emptyPayload(): SyncPushPayload {
  return {
    entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] },
  };
}

function readArray(request: IDBRequest): unknown[] {
  const result: unknown = request.result;
  return Array.isArray(result) ? result : [];
}

function recordsById(records: readonly unknown[]): Map<string, ObjectRecord> {
  const byId = new Map<string, ObjectRecord>();
  for (const record of records) {
    if (!isObjectRecord(record)) {
      continue;
    }
    const id = readString(record, "id");
    if (id !== undefined) {
      byId.set(id, record);
    }
  }
  return byId;
}

function readIntents(value: unknown): WorkspaceLifecycleIntent[] {
  if (!isObjectRecord(value) || !isObjectRecord(value.value) ||
    value.value.version !== 1 || !Array.isArray(value.value.intents)) {
    return [];
  }
  return value.value.intents.filter(isIntent);
}

function readDeferred(value: unknown): DeferredRecord | undefined {
  if (!isObjectRecord(value) || !isObjectRecord(value.value) ||
    value.value.version !== 1 || !isObjectRecord(value.value.payloadsByWorkspaceId)) {
    return undefined;
  }
  const payloadsByWorkspaceId: Record<string, SyncPushPayload> = {};
  for (const [workspaceId, payload] of Object.entries(value.value.payloadsByWorkspaceId)) {
    if (!isObjectRecord(payload) || !isObjectRecord(payload.entities)) {
      continue;
    }
    const entities = payload.entities;
    if (!Array.isArray(entities.workspaces) || !Array.isArray(entities.collections) ||
      !Array.isArray(entities.bookmarks) || !Array.isArray(entities.tags) ||
      !Array.isArray(entities.groups)) {
      continue;
    }
    payloadsByWorkspaceId[workspaceId] = {
      entities: {
        workspaces: entities.workspaces.filter(isSyncEntity),
        collections: entities.collections.filter(isSyncEntity),
        bookmarks: entities.bookmarks.filter(isSyncEntity),
        tags: entities.tags.filter(isSyncEntity),
        groups: entities.groups.filter(isSyncEntity),
      },
    };
  }
  return { version: 1, payloadsByWorkspaceId };
}

function wireEntityEqual(left: SyncEntity, right: SyncEntity): boolean {
  const canonical = (entity: SyncEntity): string => JSON.stringify(
    Object.fromEntries(
      Object.entries(entity)
        .filter(([key]) => key !== "seq" && key !== "updated_at")
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
    ),
  );
  return canonical(left) === canonical(right);
}

function removeConfirmedFromDeferred(
  deferred: DeferredRecord,
  confirmed: SyncPushPayload,
  removeWorkspaceIds: ReadonlySet<string> = new Set(),
): DeferredRecord | undefined {
  const payloadsByWorkspaceId: Record<string, SyncPushPayload> = {};
  const keys: Array<keyof SyncPushEntities> = [
    "workspaces", "collections", "bookmarks", "tags", "groups",
  ];
  for (const [workspaceId, payload] of Object.entries(deferred.payloadsByWorkspaceId)) {
    if (removeWorkspaceIds.has(workspaceId)) {
      continue;
    }
    const next = emptyPayload();
    for (const key of keys) {
      const confirmedEntities: readonly SyncEntity[] = confirmed.entities[key];
      next.entities[key].push(...payload.entities[key].filter((entity) =>
        !confirmedEntities.some((candidate) =>
          candidate.id === entity.id && wireEntityEqual(candidate, entity),
        ),
      ));
    }
    const count = keys.reduce((sum, key) => sum + next.entities[key].length, 0);
    if (count > 0) {
      payloadsByWorkspaceId[workspaceId] = next;
    }
  }
  return Object.keys(payloadsByWorkspaceId).length > 0
    ? { version: 1, payloadsByWorkspaceId }
    : undefined;
}

async function defaultCommit(payload: SyncPushPayload, serverSeq: number): Promise<SyncPushPayload> {
  const { idbTransaction } = await import("@/lib/idb");
  return idbTransaction(CONFIRMATION_STORES, "readwrite", (transaction) => {
    const requests = new Map<StoreName, IDBRequest>();
    for (const store of CONFIRMATION_STORES) {
      if (store === "kv") {
        continue;
      }
      requests.set(store, transaction.objectStore(store).getAll());
    }
    const intentRequest = transaction.objectStore("kv").get(WORKSPACE_LIFECYCLE_INTENTS_KEY);
    const deferredRequest = transaction.objectStore("kv").get(WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY);
    const allRequests = [...requests.values(), intentRequest, deferredRequest];
    for (const request of allRequests) {
      request.onerror = () => transaction.abort();
    }
    const confirmed = emptyPayload();
    let completed = 0;
    const decide = () => {
      completed += 1;
      if (completed !== allRequests.length) {
        return;
      }
      const intents = readIntents(intentRequest.result);
      const tables = new Map<StoreName, Map<string, ObjectRecord>>();
      for (const [store, request] of requests) {
        tables.set(store, recordsById(readArray(request)));
      }
      const groupTabs = [...(tables.get("group-tabs")?.values() ?? [])];
      const confirm = (
        store: ConfirmableStore,
        entity: SyncEntity,
        target: SyncEntity[],
      ): boolean => {
        const record = tables.get(store)?.get(entity.id);
        const tabs = store === "groups"
          ? groupTabs.filter((tab) => readString(tab, "groupId") === entity.id)
          : [];
        if (!record || !matchesPersistedSyncEntity(store, record, entity, tabs, intents)) {
          return false;
        }
        transaction.objectStore(store).put({ ...record, seq: serverSeq });
        target.push(entity);
        return true;
      };
      for (const entity of payload.entities.workspaces) {
        confirm("workspaces", entity, confirmed.entities.workspaces);
      }
      for (const entity of payload.entities.collections) {
        confirm("collections", entity, confirmed.entities.collections);
      }
      for (const entity of payload.entities.tags) {
        confirm("tags", entity, confirmed.entities.tags);
      }
      for (const entity of payload.entities.groups) {
        confirm("groups", entity, confirmed.entities.groups);
      }
      for (const entity of payload.entities.bookmarks) {
        const bookmarkStores: Array<
          "bookmarks" | "archived-bookmarks" | "trashed-bookmarks"
        > = ["bookmarks", "archived-bookmarks", "trashed-bookmarks"];
        for (const store of bookmarkStores) {
          if (confirm(store, entity, confirmed.entities.bookmarks)) {
            break;
          }
        }
      }

      const confirmedDeleteIds = new Set(
        confirmed.entities.workspaces
          .filter((entity) => entity.lifecycle_action === "delete")
          .map((entity) => entity.id),
      );
      if (confirmedDeleteIds.size > 0) {
        const remaining = intents.filter((intent) => !confirmedDeleteIds.has(intent.workspaceId));
        if (remaining.length === 0) {
          transaction.objectStore("kv").delete(WORKSPACE_LIFECYCLE_INTENTS_KEY);
        } else {
          transaction.objectStore("kv").put({
            key: WORKSPACE_LIFECYCLE_INTENTS_KEY,
            value: { version: 1, intents: remaining },
          });
        }
      }
      const deferred = readDeferred(deferredRequest.result);
      if (deferred) {
        const pruned = removeConfirmedFromDeferred(deferred, confirmed, confirmedDeleteIds);
        if (pruned) {
          transaction.objectStore("kv").put({
            key: WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY,
            value: pruned,
          });
        } else {
          transaction.objectStore("kv").delete(WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY);
        }
      }
    };
    for (const request of allRequests) {
      request.onsuccess = decide;
    }
    return confirmed;
  });
}

async function defaultApply(payload: SyncPushPayload, serverSeq: number): Promise<void> {
  const [{ useWorkspaceStore }, { useBookmarksStore }, { useGroupsStore }] = await Promise.all([
    import("@/store/workspace-store"),
    import("@/store/bookmarks-store"),
    import("@/store/groups-store"),
  ]);
  useWorkspaceStore.getState().confirmWorkspaceStoreEntitySeqs(
    {
      workspaces: payload.entities.workspaces,
      collections: payload.entities.collections,
      tags: payload.entities.tags,
    },
    serverSeq,
  );
  useBookmarksStore.getState().confirmBookmarkEntitySeqs(payload.entities.bookmarks, serverSeq);
  useGroupsStore.getState().confirmGroupEntitySeqs(payload.entities.groups, serverSeq);
}

export async function confirmSyncPayload(
  payload: SyncPushPayload,
  serverSeq: number,
  dependencies: SyncConfirmationDependencies = {
    commit: defaultCommit,
    apply: defaultApply,
  },
): Promise<void> {
  const confirmed = await dependencies.commit(payload, serverSeq);
  await dependencies.apply(confirmed, serverSeq);
}

export async function completeWorkspaceLifecycleIntent(workspaceId: string): Promise<void> {
  const { idbTransaction } = await import("@/lib/idb");
  return idbTransaction(["kv"], "readwrite", (transaction) => {
    const intentsRequest = transaction.objectStore("kv").get(WORKSPACE_LIFECYCLE_INTENTS_KEY);
    const deferredRequest = transaction.objectStore("kv").get(WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY);
    for (const request of [intentsRequest, deferredRequest]) {
      request.onerror = () => transaction.abort();
    }
    let completed = 0;
    const update = () => {
      completed += 1;
      if (completed !== 2) {
        return;
      }
      const intents = readIntents(intentsRequest.result)
        .filter((intent) => intent.workspaceId !== workspaceId);
      if (intents.length === 0) {
        transaction.objectStore("kv").delete(WORKSPACE_LIFECYCLE_INTENTS_KEY);
      } else {
        transaction.objectStore("kv").put({
          key: WORKSPACE_LIFECYCLE_INTENTS_KEY,
          value: { version: 1, intents },
        });
      }
      const deferred = readDeferred(deferredRequest.result);
      if (!deferred) {
        return;
      }
      const payloadsByWorkspaceId = Object.fromEntries(
        Object.entries(deferred.payloadsByWorkspaceId)
          .filter(([candidateId]) => candidateId !== workspaceId),
      );
      if (Object.keys(payloadsByWorkspaceId).length === 0) {
        transaction.objectStore("kv").delete(WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY);
      } else {
        transaction.objectStore("kv").put({
          key: WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY,
          value: { version: 1, payloadsByWorkspaceId },
        });
      }
    };
    intentsRequest.onsuccess = update;
    deferredRequest.onsuccess = update;
  });
}
