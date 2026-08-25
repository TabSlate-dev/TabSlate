import { idbGetAll, idbTransaction, type StoreName } from "@/lib/idb";
import type { Bookmark, Collection, Workspace } from "@/lib/types";
import {
  WORKSPACE_LIFECYCLE_INTENTS_KEY,
  type WorkspaceLifecycleIntent,
} from "@/lib/workspace-lifecycle-state";
import type { GroupTab, SavedGroup } from "@/store/groups-store";

export const GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY =
  "guest-workspace-orphan-recovery-v1";

export const GUEST_WORKSPACE_LEGACY_RESTORE_EVENT =
  "tabslate-guest-workspace-legacy-restored";

const ACTIVE_WORKSPACE_KEY = "activeWorkspaceId";
const RECOVERED_WORKSPACE_NAME = "Recovered Workspace";
const RECOVERY_STORES: StoreName[] = [
  "workspaces",
  "collections",
  "bookmarks",
  "archived-bookmarks",
  "trashed-bookmarks",
  "groups",
  "group-tabs",
  "kv",
];

export interface RecoveredGuestWorkspaceRecord {
  workspaceId: string;
  collectionIds: string[];
  groupIds: string[];
  recoveredAt: number;
}

interface KVRecord {
  key: string;
  value: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const candidate = value[property];
  return typeof candidate === "string" ? candidate : undefined;
}

function numberProperty(value: unknown, property: string): number | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const candidate = value[property];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function readRecords(request: IDBRequest): unknown[] {
  const result: unknown = request.result;
  return Array.isArray(result) ? result : [];
}

function readKVRecord(request: IDBRequest): KVRecord | undefined {
  const result: unknown = request.result;
  if (!isObject(result) || typeof result.key !== "string" || !("value" in result)) {
    return undefined;
  }
  return { key: result.key, value: result.value };
}

function isRecoveredRecord(value: unknown): value is RecoveredGuestWorkspaceRecord {
  return isObject(value) &&
    typeof value.workspaceId === "string" && value.workspaceId.length > 0 &&
    Array.isArray(value.collectionIds) && value.collectionIds.every((id) => typeof id === "string") &&
    Array.isArray(value.groupIds) && value.groupIds.every((id) => typeof id === "string") &&
    typeof value.recoveredAt === "number" && Number.isFinite(value.recoveredAt);
}

function readRecoveryRecords(request: IDBRequest): RecoveredGuestWorkspaceRecord[] | undefined {
  const record = readKVRecord(request);
  if (!record || !Array.isArray(record.value) || !record.value.every(isRecoveredRecord)) {
    return undefined;
  }
  return record.value.map((value) => ({
    ...value,
    collectionIds: [...value.collectionIds],
    groupIds: [...value.groupIds],
  }));
}

function isLifecycleIntent(value: unknown): value is WorkspaceLifecycleIntent {
  return isObject(value) &&
    typeof value.workspaceId === "string" &&
    (value.action === "delete" || value.action === "restore") &&
    typeof value.baseSeq === "number" &&
    typeof value.previousActiveWorkspaceId === "string" &&
    typeof value.createdAt === "number";
}

function readLifecycleIntents(request: IDBRequest): WorkspaceLifecycleIntent[] {
  const record = readKVRecord(request);
  if (!record || !isObject(record.value) || record.value.version !== 1 ||
    !Array.isArray(record.value.intents)) {
    return [];
  }
  return record.value.intents.filter(isLifecycleIntent);
}

function abortOnError(transaction: IDBTransaction, request: IDBRequest): void {
  request.onerror = () => transaction.abort();
}

function finiteDeletionTimes(records: readonly unknown[]): number[] {
  return records.flatMap((record) => {
    const deletedAt = numberProperty(record, "deletedAt");
    return deletedAt === undefined ? [] : [deletedAt];
  });
}

function clearDeletedAt(record: Record<string, unknown>): Record<string, unknown> {
  const { deletedAt: _deletedAt, ...retained } = record;
  return { ...retained, seq: 0 };
}

function clearBookmarkTrashState(record: Record<string, unknown>): Record<string, unknown> {
  const {
    deletedAt: _deletedAt,
    isTrashed: _isTrashed,
    ...retained
  } = record;
  return { ...retained, seq: 0 };
}

function upsertWorkspace(
  workspaces: Workspace[],
  restored: Workspace,
): Workspace[] {
  const remaining = workspaces.filter((workspace) => workspace.id !== restored.id);
  return [...remaining, restored];
}

function upsertCollections(
  collections: Collection[],
  restored: Collection[],
): Collection[] {
  const restoredIds = new Set(restored.map((collection) => collection.id));
  return [
    ...collections.filter((collection) => !restoredIds.has(collection.id)),
    ...restored,
  ];
}

export function recoverLegacyGuestWorkspaceOrphans(): Promise<
  RecoveredGuestWorkspaceRecord[]
> {
  const recovered: RecoveredGuestWorkspaceRecord[] = [];
  return idbTransaction(RECOVERY_STORES, "readwrite", (transaction) => {
    const workspacesRequest = transaction.objectStore("workspaces").getAll();
    const collectionsRequest = transaction.objectStore("collections").getAll();
    const activeBookmarksRequest = transaction.objectStore("bookmarks").getAll();
    const archivedBookmarksRequest = transaction.objectStore("archived-bookmarks").getAll();
    const trashedBookmarksRequest = transaction.objectStore("trashed-bookmarks").getAll();
    const groupsRequest = transaction.objectStore("groups").getAll();
    const markerRequest = transaction.objectStore("kv").get(
      GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY,
    );
    const intentsRequest = transaction.objectStore("kv").get(
      WORKSPACE_LIFECYCLE_INTENTS_KEY,
    );
    const activeWorkspaceRequest = transaction.objectStore("kv").get(ACTIVE_WORKSPACE_KEY);
    const requests = [
      workspacesRequest,
      collectionsRequest,
      activeBookmarksRequest,
      archivedBookmarksRequest,
      trashedBookmarksRequest,
      groupsRequest,
      markerRequest,
      intentsRequest,
      activeWorkspaceRequest,
    ];
    for (const request of requests) {
      abortOnError(transaction, request);
    }

    let completed = 0;
    const migrate = () => {
      completed += 1;
      if (completed !== requests.length) {
        return;
      }
      const existingMarker = readRecoveryRecords(markerRequest);
      if (existingMarker) {
        recovered.push(...existingMarker);
        return;
      }

      const workspaces = readRecords(workspacesRequest);
      const collections = readRecords(collectionsRequest);
      const groups = readRecords(groupsRequest);
      const bookmarks = [
        ...readRecords(activeBookmarksRequest),
        ...readRecords(archivedBookmarksRequest),
        ...readRecords(trashedBookmarksRequest),
      ];
      const resolvedWorkspaceIds = new Set(
        workspaces.flatMap((workspace) => {
          const id = stringProperty(workspace, "id");
          return id ? [id] : [];
        }),
      );
      const unresolvedWorkspaceIds = new Set<string>();
      for (const descendant of [...collections, ...groups]) {
        const workspaceId = stringProperty(descendant, "workspaceId");
        if (workspaceId && !resolvedWorkspaceIds.has(workspaceId)) {
          unresolvedWorkspaceIds.add(workspaceId);
        }
      }
      const activeRecord = readKVRecord(activeWorkspaceRequest);
      const previousActiveWorkspaceId = typeof activeRecord?.value === "string"
        ? activeRecord.value
        : "";
      const existingIntents = readLifecycleIntents(intentsRequest);
      const recoveredAt = Date.now();
      const maximumPosition = workspaces.reduce<number>((maximum, workspace) => {
        const position = numberProperty(workspace, "position");
        return position === undefined ? maximum : Math.max(maximum, position);
      }, -1);
      let nextPosition = maximumPosition + 1;
      const intents = [...existingIntents];

      for (const workspaceId of [...unresolvedWorkspaceIds].sort()) {
        const workspaceCollections = collections.filter((collection) =>
          stringProperty(collection, "workspaceId") === workspaceId &&
          Boolean(stringProperty(collection, "id")),
        );
        const workspaceGroups = groups.filter((group) =>
          stringProperty(group, "workspaceId") === workspaceId &&
          Boolean(stringProperty(group, "id")),
        );
        const collectionIds = workspaceCollections.flatMap((collection) => {
          const id = stringProperty(collection, "id");
          return id ? [id] : [];
        }).sort();
        const collectionIdSet = new Set(collectionIds);
        const workspaceBookmarks = bookmarks.filter((bookmark) => {
          const collectionId = stringProperty(bookmark, "collectionId");
          return collectionId !== undefined && collectionIdSet.has(collectionId);
        });
        const deletionTimes = finiteDeletionTimes([
          ...workspaceCollections,
          ...workspaceGroups,
          ...workspaceBookmarks,
        ]);
        if (deletionTimes.length === 0) {
          continue;
        }
        const deletedAt = Math.min(...deletionTimes);
        const groupIds = workspaceGroups.flatMap((group) => {
          const id = stringProperty(group, "id");
          return id ? [id] : [];
        }).sort();
        const workspace: Workspace = {
          id: workspaceId,
          name: RECOVERED_WORKSPACE_NAME,
          color: "gray",
          position: nextPosition,
          seq: 0,
          deletedAt,
          deletionModel: 0,
        };
        nextPosition += 1;
        transaction.objectStore("workspaces").put(workspace);
        const intent: WorkspaceLifecycleIntent = {
          workspaceId,
          action: "delete",
          baseSeq: 0,
          previousActiveWorkspaceId,
          createdAt: deletedAt,
        };
        const existingIndex = intents.findIndex((candidate) => candidate.workspaceId === workspaceId);
        if (existingIndex === -1) {
          intents.push(intent);
        } else {
          intents[existingIndex] = intent;
        }
        recovered.push({ workspaceId, collectionIds, groupIds, recoveredAt });
      }

      if (recovered.length > 0) {
        transaction.objectStore("kv").put({
          key: WORKSPACE_LIFECYCLE_INTENTS_KEY,
          value: { version: 1, intents },
        });
      }
      transaction.objectStore("kv").put({
        key: GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY,
        value: recovered,
      });
    };
    for (const request of requests) {
      request.onsuccess = migrate;
    }
    return recovered;
  });
}

export async function restoreRecoveredGuestAggregate(
  workspaceId: string,
): Promise<void> {
  if (workspaceId.length === 0) {
    return;
  }
  let restored = false;
  await idbTransaction(RECOVERY_STORES, "readwrite", (transaction) => {
    const workspaceRequest = transaction.objectStore("workspaces").get(workspaceId);
    const collectionsRequest = transaction.objectStore("collections").getAll();
    const activeBookmarksRequest = transaction.objectStore("bookmarks").getAll();
    const archivedBookmarksRequest = transaction.objectStore("archived-bookmarks").getAll();
    const trashedBookmarksRequest = transaction.objectStore("trashed-bookmarks").getAll();
    const groupsRequest = transaction.objectStore("groups").getAll();
    const markerRequest = transaction.objectStore("kv").get(
      GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY,
    );
    const intentsRequest = transaction.objectStore("kv").get(
      WORKSPACE_LIFECYCLE_INTENTS_KEY,
    );
    const requests = [
      workspaceRequest,
      collectionsRequest,
      activeBookmarksRequest,
      archivedBookmarksRequest,
      trashedBookmarksRequest,
      groupsRequest,
      markerRequest,
      intentsRequest,
    ];
    for (const request of requests) {
      abortOnError(transaction, request);
    }

    let completed = 0;
    const restore = () => {
      completed += 1;
      if (completed !== requests.length) {
        return;
      }
      const records = readRecoveryRecords(markerRequest);
      const recovery = records?.find((candidate) => candidate.workspaceId === workspaceId);
      const workspace: unknown = workspaceRequest.result;
      if (!records || !recovery || !isObject(workspace) ||
        stringProperty(workspace, "id") !== workspaceId ||
        stringProperty(workspace, "name") !== RECOVERED_WORKSPACE_NAME ||
        numberProperty(workspace, "deletionModel") !== 0 ||
        numberProperty(workspace, "seq") !== 0) {
        return;
      }
      const collectionIds = new Set(recovery.collectionIds);
      const groupIds = new Set(recovery.groupIds);
      const restoredWorkspace = clearDeletedAt(workspace);
      transaction.objectStore("workspaces").put({
        ...restoredWorkspace,
        deletionModel: 1,
      });

      for (const collection of readRecords(collectionsRequest)) {
        const id = stringProperty(collection, "id");
        if (id && collectionIds.has(id) && isObject(collection)) {
          transaction.objectStore("collections").put(clearDeletedAt(collection));
        }
      }
      for (const group of readRecords(groupsRequest)) {
        const id = stringProperty(group, "id");
        if (id && groupIds.has(id) && isObject(group)) {
          transaction.objectStore("groups").put(clearDeletedAt(group));
        }
      }
      for (const bookmark of readRecords(activeBookmarksRequest)) {
        const collectionId = stringProperty(bookmark, "collectionId");
        if (collectionId && collectionIds.has(collectionId) && isObject(bookmark)) {
          transaction.objectStore("bookmarks").put(clearBookmarkTrashState(bookmark));
        }
      }
      for (const bookmark of readRecords(archivedBookmarksRequest)) {
        const collectionId = stringProperty(bookmark, "collectionId");
        if (collectionId && collectionIds.has(collectionId) && isObject(bookmark)) {
          transaction.objectStore("archived-bookmarks").put(clearBookmarkTrashState(bookmark));
        }
      }
      for (const bookmark of readRecords(trashedBookmarksRequest)) {
        const id = stringProperty(bookmark, "id");
        const collectionId = stringProperty(bookmark, "collectionId");
        if (id && collectionId && collectionIds.has(collectionId) && isObject(bookmark)) {
          transaction.objectStore("trashed-bookmarks").delete(id);
          transaction.objectStore("bookmarks").put(clearBookmarkTrashState(bookmark));
        }
      }

      const rootDeletedAt = numberProperty(workspace, "deletedAt");
      const intents = readLifecycleIntents(intentsRequest).filter((intent) =>
        intent.workspaceId !== workspaceId || intent.action !== "delete" ||
        intent.baseSeq !== 0 || intent.createdAt !== rootDeletedAt,
      );
      if (intents.length === 0) {
        transaction.objectStore("kv").delete(WORKSPACE_LIFECYCLE_INTENTS_KEY);
      } else {
        transaction.objectStore("kv").put({
          key: WORKSPACE_LIFECYCLE_INTENTS_KEY,
          value: { version: 1, intents },
        });
      }
      transaction.objectStore("kv").put({ key: ACTIVE_WORKSPACE_KEY, value: workspaceId });
      transaction.objectStore("kv").put({
        key: GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY,
        value: records.filter((candidate) => candidate.workspaceId !== workspaceId),
      });
      restored = true;
    };
    for (const request of requests) {
      request.onsuccess = restore;
    }
  });

  if (!restored) {
    return;
  }
  const [
    { useWorkspaceStore },
    { useBookmarksStore },
    { useGroupsStore },
  ] = await Promise.all([
    import("@/store/workspace-store"),
    import("@/store/bookmarks-store"),
    import("@/store/groups-store"),
  ]);
  const [workspaces, collections, groups, groupTabs, archivedBookmarks, trashedBookmarks] =
    await Promise.all([
      idbGetAll<Workspace>("workspaces"),
      idbGetAll<Collection>("collections"),
      idbGetAll<SavedGroup>("groups"),
      idbGetAll<GroupTab>("group-tabs"),
      idbGetAll<Bookmark>("archived-bookmarks"),
      idbGetAll<Bookmark>("trashed-bookmarks"),
    ]);
  const restoredWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const restoredCollections = collections.filter((collection) =>
    collection.workspaceId === workspaceId,
  );
  if (restoredWorkspace) {
    useWorkspaceStore.setState((state) => ({
      workspaces: upsertWorkspace(state.workspaces, restoredWorkspace),
      collections: upsertCollections(state.collections, restoredCollections),
      activeWorkspaceId: workspaceId,
    }));
  }
  await useBookmarksStore.getState().reloadActive();
  const bookmarkState = useBookmarksStore.getState();
  useBookmarksStore.setState({
    ...(bookmarkState._archivedLoaded ? { archivedBookmarks } : {}),
    ...(bookmarkState._trashedLoaded ? { trashedBookmarks } : {}),
  });
  useGroupsStore.setState({ groups, groupTabs });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GUEST_WORKSPACE_LEGACY_RESTORE_EVENT));
  }
}
