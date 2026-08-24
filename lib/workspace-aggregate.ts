import {
  idbTransaction,
  type BulkWriteOp,
  type StoreName,
} from "./idb";
import {
  syncConflictRegistry,
  type SyncEntityReference,
} from "./sync-conflicts";
import {
  WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY,
  WORKSPACE_LIFECYCLE_INTENTS_KEY,
} from "./workspace-lifecycle-state";

const ACTIVE_WORKSPACE_KEY = "activeWorkspaceId";
const GUEST_WORKSPACE_PROVENANCE_KEY = "guest-workspace-provenance-v1";
const GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY =
  "guest-workspace-orphan-recovery-v1";

const AGGREGATE_STORES: StoreName[] = [
  "workspaces",
  "collections",
  "bookmarks",
  "archived-bookmarks",
  "trashed-bookmarks",
  "groups",
  "group-tabs",
  "kv",
];

const AGGREGATE_DESCENDANT_STORES: StoreName[] = [
  "collections",
  "bookmarks",
  "archived-bookmarks",
  "trashed-bookmarks",
  "groups",
  "group-tabs",
];

const BOOKMARK_STORES: StoreName[] = [
  "bookmarks",
  "archived-bookmarks",
  "trashed-bookmarks",
];

export interface WorkspaceAggregateIds {
  workspaceId: string;
  collectionIds: string[];
  bookmarkIds: string[];
  groupIds: string[];
  groupTabIds: string[];
}

interface WorkspaceAggregateSets {
  collectionIds: Set<string>;
  bookmarkIds: Set<string>;
  groupIds: Set<string>;
  groupTabIds: Set<string>;
}

interface WorkspacePositionRecord {
  id: string;
  position: number;
  deletedAt?: number;
}

interface KVRecord {
  key: string;
  value: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringProperty(value: unknown, property: string): string | undefined {
  if (!isObject(value) || !(property in value)) {
    return undefined;
  }
  const propertyValue = value[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function readNumberProperty(value: unknown, property: string): number | undefined {
  if (!isObject(value) || !(property in value)) {
    return undefined;
  }
  const propertyValue = value[property];
  return typeof propertyValue === "number" && Number.isFinite(propertyValue)
    ? propertyValue
    : undefined;
}

function readRecords(request: IDBRequest): unknown[] {
  const result: unknown = request.result;
  return Array.isArray(result) ? result : [];
}

function createAggregateSets(): WorkspaceAggregateSets {
  return {
    collectionIds: new Set(),
    bookmarkIds: new Set(),
    groupIds: new Set(),
    groupTabIds: new Set(),
  };
}

function toAggregateIds(
  workspaceId: string,
  sets: WorkspaceAggregateSets,
): WorkspaceAggregateIds {
  return {
    workspaceId,
    collectionIds: [...sets.collectionIds].sort(),
    bookmarkIds: [...sets.bookmarkIds].sort(),
    groupIds: [...sets.groupIds].sort(),
    groupTabIds: [...sets.groupTabIds].sort(),
  };
}

function abortOnRequestError(
  transaction: IDBTransaction,
  request: IDBRequest,
): void {
  request.onerror = () => transaction.abort();
}

function deleteRecord(
  transaction: IDBTransaction,
  store: StoreName,
  id: string,
): void {
  transaction.objectStore(store).delete(id);
}

function queueBookmarkDiscovery(
  transaction: IDBTransaction,
  collectionId: string,
  sets: WorkspaceAggregateSets,
  shouldDelete: boolean,
): void {
  for (const store of BOOKMARK_STORES) {
    const request = transaction.objectStore(store)
      .index("collectionId")
      .getAll(collectionId);
    abortOnRequestError(transaction, request);
    request.onsuccess = () => {
      for (const record of readRecords(request)) {
        const id = readStringProperty(record, "id");
        if (!id) {
          continue;
        }
        sets.bookmarkIds.add(id);
        if (shouldDelete) {
          deleteRecord(transaction, store, id);
        }
      }
    };
  }
}

function queueGroupTabDiscovery(
  transaction: IDBTransaction,
  groupId: string,
  sets: WorkspaceAggregateSets,
  shouldDelete: boolean,
): void {
  const request = transaction.objectStore("group-tabs")
    .index("groupId")
    .getAll(groupId);
  abortOnRequestError(transaction, request);
  request.onsuccess = () => {
    for (const record of readRecords(request)) {
      const id = readStringProperty(record, "id");
      if (!id) {
        continue;
      }
      sets.groupTabIds.add(id);
      if (shouldDelete) {
        deleteRecord(transaction, "group-tabs", id);
      }
    }
  };
}

function queueAggregateDiscovery(
  transaction: IDBTransaction,
  workspaceId: string,
  shouldDelete: boolean,
): WorkspaceAggregateSets {
  const sets = createAggregateSets();
  const collectionsRequest = transaction.objectStore("collections")
    .index("workspaceId")
    .getAll(workspaceId);
  abortOnRequestError(transaction, collectionsRequest);
  collectionsRequest.onsuccess = () => {
    for (const record of readRecords(collectionsRequest)) {
      const id = readStringProperty(record, "id");
      if (!id) {
        continue;
      }
      sets.collectionIds.add(id);
      if (shouldDelete) {
        deleteRecord(transaction, "collections", id);
      }
      queueBookmarkDiscovery(transaction, id, sets, shouldDelete);
    }
  };

  const groupsRequest = transaction.objectStore("groups")
    .index("workspaceId")
    .getAll(workspaceId);
  abortOnRequestError(transaction, groupsRequest);
  groupsRequest.onsuccess = () => {
    for (const record of readRecords(groupsRequest)) {
      const id = readStringProperty(record, "id");
      if (!id) {
        continue;
      }
      sets.groupIds.add(id);
      if (shouldDelete) {
        deleteRecord(transaction, "groups", id);
      }
      queueGroupTabDiscovery(transaction, id, sets, shouldDelete);
    }
  };
  return sets;
}

function readKVRecord(request: IDBRequest): KVRecord | undefined {
  const result: unknown = request.result;
  if (!isObject(result) || !("key" in result) || typeof result.key !== "string" ||
    !("value" in result)) {
    return undefined;
  }
  return { key: result.key, value: result.value };
}

function isWorkspaceMetadataEntry(value: unknown): value is { workspaceId: string } {
  return isObject(value) && "workspaceId" in value &&
    typeof value.workspaceId === "string";
}

function queueIntentCleanup(
  transaction: IDBTransaction,
  workspaceId: string,
): void {
  const store = transaction.objectStore("kv");
  const request = store.get(WORKSPACE_LIFECYCLE_INTENTS_KEY);
  abortOnRequestError(transaction, request);
  request.onsuccess = () => {
    const record = readKVRecord(request);
    if (!record || !isObject(record.value) || !("version" in record.value) ||
      record.value.version !== 1 || !("intents" in record.value) ||
      !Array.isArray(record.value.intents)) {
      return;
    }
    const intents = record.value.intents.filter((intent) =>
      !isWorkspaceMetadataEntry(intent) || intent.workspaceId !== workspaceId);
    if (intents.length === 0) {
      store.delete(WORKSPACE_LIFECYCLE_INTENTS_KEY);
      return;
    }
    store.put({
      key: WORKSPACE_LIFECYCLE_INTENTS_KEY,
      value: { version: 1, intents },
    });
  };
}

function queueDeferredPayloadCleanup(
  transaction: IDBTransaction,
  workspaceId: string,
): void {
  const store = transaction.objectStore("kv");
  const request = store.get(WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY);
  abortOnRequestError(transaction, request);
  request.onsuccess = () => {
    const record = readKVRecord(request);
    if (!record || !isObject(record.value) || !("version" in record.value) ||
      record.value.version !== 1 || !("payloadsByWorkspaceId" in record.value) ||
      !isObject(record.value.payloadsByWorkspaceId)) {
      return;
    }
    const payloadsByWorkspaceId = Object.fromEntries(
      Object.entries(record.value.payloadsByWorkspaceId)
        .filter(([candidateId]) => candidateId !== workspaceId),
    );
    if (Object.keys(payloadsByWorkspaceId).length === 0) {
      store.delete(WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY);
      return;
    }
    store.put({
      key: WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY,
      value: { version: 1, payloadsByWorkspaceId },
    });
  };
}

function queueGuestMetadataCleanup(
  transaction: IDBTransaction,
  workspaceId: string,
): void {
  const store = transaction.objectStore("kv");
  const provenanceRequest = store.get(GUEST_WORKSPACE_PROVENANCE_KEY);
  abortOnRequestError(transaction, provenanceRequest);
  provenanceRequest.onsuccess = () => {
    const record = readKVRecord(provenanceRequest);
    if (record && isWorkspaceMetadataEntry(record.value) &&
      record.value.workspaceId === workspaceId) {
      store.delete(GUEST_WORKSPACE_PROVENANCE_KEY);
    }
  };

  const recoveryRequest = store.get(GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY);
  abortOnRequestError(transaction, recoveryRequest);
  recoveryRequest.onsuccess = () => {
    const record = readKVRecord(recoveryRequest);
    if (!record || !Array.isArray(record.value)) {
      return;
    }
    const remaining = record.value.filter((entry) =>
      !isWorkspaceMetadataEntry(entry) || entry.workspaceId !== workspaceId);
    store.put({ key: GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY, value: remaining });
  };
}

function readWorkspacePositionRecord(value: unknown): WorkspacePositionRecord | undefined {
  const id = readStringProperty(value, "id");
  const position = readNumberProperty(value, "position");
  if (!id || position === undefined) {
    return undefined;
  }
  const deletedAt = readNumberProperty(value, "deletedAt");
  return deletedAt === undefined ? { id, position } : { id, position, deletedAt };
}

function selectReplacementWorkspace(
  workspaceId: string,
  terminalPosition: number | undefined,
  workspaces: WorkspacePositionRecord[],
): WorkspacePositionRecord | undefined {
  const candidates = workspaces
    .filter((workspace) => workspace.id !== workspaceId && workspace.deletedAt === undefined)
    .sort((a, b) => {
      if (terminalPosition !== undefined) {
        const distance = Math.abs(a.position - terminalPosition) -
          Math.abs(b.position - terminalPosition);
        if (distance !== 0) {
          return distance;
        }
        return a.id.localeCompare(b.id);
      }
      const position = a.position - b.position;
      return position !== 0 ? position : a.id.localeCompare(b.id);
    });
  return candidates[0];
}

function queueActiveWorkspaceCleanup(
  transaction: IDBTransaction,
  workspaceId: string,
): void {
  const workspacesStore = transaction.objectStore("workspaces");
  const kvStore = transaction.objectStore("kv");
  const terminalRequest = workspacesStore.get(workspaceId);
  const workspacesRequest = workspacesStore.getAll();
  const activeRequest = kvStore.get(ACTIVE_WORKSPACE_KEY);
  for (const request of [terminalRequest, workspacesRequest, activeRequest]) {
    abortOnRequestError(transaction, request);
  }
  let terminalRead = false;
  let workspacesRead = false;
  let activeRead = false;
  let terminalPosition: number | undefined;
  let workspaces: WorkspacePositionRecord[] = [];
  let activeWorkspaceId: string | undefined;
  let updated = false;
  const updateActiveWorkspace = () => {
    if (updated || !terminalRead || !workspacesRead || !activeRead ||
      activeWorkspaceId !== workspaceId) {
      return;
    }
    updated = true;
    const replacement = selectReplacementWorkspace(
      workspaceId,
      terminalPosition,
      workspaces,
    );
    if (!replacement) {
      kvStore.delete(ACTIVE_WORKSPACE_KEY);
      return;
    }
    kvStore.put({ key: ACTIVE_WORKSPACE_KEY, value: replacement.id });
  };
  terminalRequest.onsuccess = () => {
    terminalRead = true;
    terminalPosition = readNumberProperty(terminalRequest.result, "position");
    updateActiveWorkspace();
  };
  workspacesRequest.onsuccess = () => {
    workspacesRead = true;
    workspaces = readRecords(workspacesRequest)
      .map(readWorkspacePositionRecord)
      .filter((workspace) => workspace !== undefined);
    updateActiveWorkspace();
  };
  activeRequest.onsuccess = () => {
    activeRead = true;
    const record = readKVRecord(activeRequest);
    activeWorkspaceId = typeof record?.value === "string" ? record.value : undefined;
    updateActiveWorkspace();
  };
}

function applyOperation(transaction: IDBTransaction, operation: BulkWriteOp): void {
  const store = transaction.objectStore(operation.store);
  if (operation.type === "delete") {
    store.delete(operation.key);
    return;
  }
  store.put(operation.value);
}

export function loadWorkspaceAggregateIds(
  workspaceId: string,
): Promise<WorkspaceAggregateIds> {
  return idbTransaction(
    AGGREGATE_DESCENDANT_STORES,
    "readonly",
    (transaction) => {
      return queueAggregateDiscovery(transaction, workspaceId, false);
    },
  ).then((sets) => toAggregateIds(workspaceId, sets));
}

export function permanentlyDeleteWorkspaceAggregate(
  workspaceId: string,
  conflictOperation: BulkWriteOp,
): Promise<WorkspaceAggregateIds> {
  return idbTransaction(
    AGGREGATE_STORES,
    "readwrite",
    (transaction) => {
      const sets = queueAggregateDiscovery(transaction, workspaceId, true);
      queueActiveWorkspaceCleanup(transaction, workspaceId);
      queueIntentCleanup(transaction, workspaceId);
      queueDeferredPayloadCleanup(transaction, workspaceId);
      queueGuestMetadataCleanup(transaction, workspaceId);
      transaction.objectStore("workspaces").delete(workspaceId);
      applyOperation(transaction, conflictOperation);
      return sets;
    },
  ).then((sets) => toAggregateIds(workspaceId, sets));
}

export function clearWorkspaceAggregate(
  workspaceId: string,
  onCommitted: (ids: WorkspaceAggregateIds) => void,
): Promise<WorkspaceAggregateIds | undefined> {
  return (async () => {
    let committedIds: WorkspaceAggregateIds | undefined;
    await syncConflictRegistry.executeClearRootTransaction(
      "workspace",
      workspaceId,
      async (mutation) => {
        committedIds = await permanentlyDeleteWorkspaceAggregate(
          workspaceId,
          mutation.operation,
        );
      },
      () => {
        if (committedIds) {
          onCommitted(committedIds);
        }
      },
    );
    return committedIds;
  })();
}

export function toSyncEntityReferences(
  ids: WorkspaceAggregateIds,
): SyncEntityReference[] {
  const references = (
    entityType: SyncEntityReference["entityType"],
    entityIds: string[],
  ): SyncEntityReference[] => entityIds.map((entityId) => ({
    entityType,
    entityId,
  }));
  return [
    { entityType: "workspace", entityId: ids.workspaceId },
    ...references("collection", ids.collectionIds),
    ...references("bookmark", ids.bookmarkIds),
    ...references("saved_group", ids.groupIds),
  ];
}
