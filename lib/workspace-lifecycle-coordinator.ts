import {
  isKnownSyncRejectionReason,
  isSyncEntityType,
  type KnownSyncRejectionReason,
  type ServerWorkspace,
  type SyncEntity,
  type SyncPullResponse,
  type SyncPushPayload,
  type SyncRejected,
} from "@/lib/api";
import {
  completeWorkspaceLifecycleIntent,
  confirmSyncPayload,
} from "@/lib/sync-confirmation";
import type { SyncResolutionContext } from "@/lib/sync-engine";
import {
  createEmptySyncPushPayload,
  isSyncPushPayloadEmpty,
  splitSyncPushPayload,
} from "@/lib/sync-recovery";
import {
  type SyncConflict,
  type SyncEntityReference,
} from "@/lib/sync-conflicts";
import {
  readWorkspaceLifecycleDeferredSync,
  readWorkspaceFullPull,
  readWorkspaceLifecycleIntents,
  invalidateWorkspaceFullPull,
  mergeWorkspaceLifecycleCapability,
  removeWorkspaceLifecycleDeferredPayload,
  removeWorkspaceLifecycleIntent,
  workspaceFullPullKey,
  type WorkspaceLifecycleIntent,
} from "@/lib/workspace-lifecycle-state";
import type { WorkspaceAggregateIds } from "@/lib/workspace-aggregate";
import type { BulkWriteOp } from "@/lib/idb";
import type { Bookmark, Collection, Tag, Workspace } from "@/lib/types";
import type { GroupTab, SavedGroup } from "@/store/groups-store";

export interface WorkspaceLifecycleAggregatePayload {
  references: SyncEntityReference[];
  activeWorkspacePayload: SyncPushPayload;
  collectionsAndGroupsPayload: SyncPushPayload;
  bookmarksPayload: SyncPushPayload;
}

export interface WorkspaceLifecycleCoordinatorServices {
  readIntents(): Promise<WorkspaceLifecycleIntent[]>;
  loadAggregatePayload(workspaceId: string): Promise<WorkspaceLifecycleAggregatePayload>;
  confirmPayload(payload: SyncPushPayload, serverSeq: number): Promise<void>;
  removeIntent(workspaceId: string): Promise<void>;
  removeDeferred(workspaceId: string): Promise<void>;
  completeIntent(workspaceId: string): Promise<void>;
  hasDeferred(workspaceId: string): Promise<boolean>;
  rollbackLastActive(intent: WorkspaceLifecycleIntent): Promise<void>;
  cleanTerminal(
    context: SyncResolutionContext,
    workspaceId: string,
  ): Promise<void>;
  clearConflictTree(workspaceId: string): Promise<void>;
}

export interface WorkspaceLifecycleCoordinatorDependencies {
  context: SyncResolutionContext;
  userId: string;
  serverOrigin: string;
  authoritativeWorkspaces: readonly ServerWorkspace[];
  authoritativeFullPull: boolean;
  reportConflict(conflict: SyncConflict): Promise<void>;
  notify(messageKey: string): void;
  services?: Partial<WorkspaceLifecycleCoordinatorServices>;
}

export function workspaceHasPendingDeleteIntent(
  intents: readonly WorkspaceLifecycleIntent[],
  workspaceId: string,
): boolean {
  return intents.some((intent) =>
    intent.workspaceId === workspaceId && intent.action === "delete",
  );
}

export interface WorkspacePullCheckpoint {
  serverUrl: string;
  userId: string;
  serverSeq: number;
  capabilitySupported: boolean;
  isCurrent(): boolean;
}

export interface WorkspacePullCheckpointDependencies {
  commit(
    operations: BulkWriteOp[],
    isCurrent: () => boolean,
  ): Promise<boolean>;
  apply(serverSeq: number): void;
}

export interface AuthoritativeWorkspacePullDependencies {
  context: SyncResolutionContext;
  response: SyncPullResponse;
  responseIsAuthoritativeFullPull?: boolean;
  serverUrl: string;
  userId: string;
  services?: {
    readFullPull(): Promise<object | undefined>;
    persistCapability(supported: boolean): Promise<void>;
    invalidateFullPull(): Promise<void>;
  };
}

export interface WorkspacePullMergeSummary {
  terminalWorkspaceIds: readonly string[];
  restoredWorkspaceIds: readonly string[];
}

export interface WorkspacePullOrchestrationDependencies<
  MergeSummary extends WorkspacePullMergeSummary,
> {
  isCurrent(): boolean;
  prepareGuest(): Promise<void>;
  mergeWorkspaces(): Promise<MergeSummary>;
  mergeGroups(): Promise<void>;
  mergeBookmarks(): Promise<void>;
  cleanTerminalAggregates(summary: MergeSummary): Promise<void>;
  clearRestoredConflictTrees(summary: MergeSummary): Promise<void>;
  confirmGuest(): Promise<void>;
  reconcileLifecycle(): Promise<void>;
  sweepUnsynced(): Promise<void>;
  commitCheckpoint(): Promise<boolean>;
}

export async function orchestrateWorkspacePull<
  MergeSummary extends WorkspacePullMergeSummary,
>(
  dependencies: WorkspacePullOrchestrationDependencies<MergeSummary>,
): Promise<boolean> {
  const current = () => dependencies.isCurrent();
  if (!current()) {
    return false;
  }
  await dependencies.prepareGuest();
  if (!current()) {
    return false;
  }
  const summary = await dependencies.mergeWorkspaces();
  if (!current()) {
    return false;
  }
  await dependencies.mergeGroups();
  if (!current()) {
    return false;
  }
  await dependencies.mergeBookmarks();
  if (!current()) {
    return false;
  }
  await dependencies.cleanTerminalAggregates(summary);
  if (!current()) {
    return false;
  }
  await dependencies.clearRestoredConflictTrees(summary);
  if (!current()) {
    return false;
  }
  await dependencies.confirmGuest();
  if (!current()) {
    return false;
  }
  await dependencies.reconcileLifecycle();
  if (!current()) {
    return false;
  }
  await dependencies.sweepUnsynced();
  if (!current()) {
    return false;
  }
  return dependencies.commitCheckpoint();
}

export async function resolveAuthoritativeWorkspacePull(
  dependencies: AuthoritativeWorkspacePullDependencies,
): Promise<{
  response: SyncPullResponse;
  capabilitySupported: boolean;
  authoritativeFullPull: boolean;
}> {
  const services = dependencies.services ?? {
    readFullPull: () => readWorkspaceFullPull(dependencies.serverUrl, dependencies.userId),
    persistCapability: (supported: boolean) => mergeWorkspaceLifecycleCapability(
      dependencies.serverUrl,
      dependencies.userId,
      supported,
    ),
    invalidateFullPull: () => invalidateWorkspaceFullPull(
      dependencies.serverUrl,
      dependencies.userId,
    ),
  };
  let response = dependencies.response;
  let authoritativeFullPull = dependencies.responseIsAuthoritativeFullPull === true;
  let capabilitySupported = response.capabilities?.workspace_parent_tombstone === true;
  if (capabilitySupported) {
    await services.persistCapability(true);
    const marker = await services.readFullPull();
    if (!marker) {
      response = await dependencies.context.pullConfirmed(0);
      authoritativeFullPull = true;
      capabilitySupported = response.capabilities?.workspace_parent_tombstone === true;
    }
  }
  if (!capabilitySupported) {
    await services.persistCapability(false);
    await services.invalidateFullPull();
  }
  return { response, capabilitySupported, authoritativeFullPull };
}

export async function commitWorkspacePullCheckpoint(
  checkpoint: WorkspacePullCheckpoint,
  dependencies?: WorkspacePullCheckpointDependencies,
): Promise<boolean> {
  if (!checkpoint.isCurrent()) {
    return false;
  }
  const operations: BulkWriteOp[] = [{
    type: "put",
    store: "kv",
    value: { key: "localSeq", value: checkpoint.serverSeq },
  }];
  if (checkpoint.capabilitySupported) {
    operations.push({
      type: "put",
      store: "kv",
      value: {
        key: workspaceFullPullKey(checkpoint.serverUrl, checkpoint.userId),
        value: {
          version: 1,
          userId: checkpoint.userId,
          serverOrigin: new URL(checkpoint.serverUrl).origin,
          serverSeq: checkpoint.serverSeq,
          completedAt: Date.now(),
        },
      },
    });
  }
  const commit = dependencies?.commit ?? commitCurrentCheckpoint;
  const committed = await commit(operations, checkpoint.isCurrent);
  if (!committed || !checkpoint.isCurrent()) {
    return false;
  }
  if (dependencies) {
    dependencies.apply(checkpoint.serverSeq);
    return true;
  }
  const { useWorkspaceStore } = await import("@/store/workspace-store");
  if (!checkpoint.isCurrent()) {
    return false;
  }
  useWorkspaceStore.setState({ localSeq: checkpoint.serverSeq });
  return true;
}

async function commitCurrentCheckpoint(
  operations: BulkWriteOp[],
  isCurrent: () => boolean,
): Promise<boolean> {
  const { getDB } = await import("@/lib/idb");
  if (!isCurrent()) {
    return false;
  }
  const database = await getDB();
  if (!isCurrent()) {
    return false;
  }
  const stores = [...new Set(operations.map((operation) => operation.store))];
  return new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(stores, "readwrite");
    let wrote = false;
    let retired = false;
    transaction.oncomplete = () => resolve(wrote && isCurrent());
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => {
      if (retired) {
        resolve(false);
        return;
      }
      reject(transaction.error);
    };
    const store = transaction.objectStore("kv");
    const before = store.get("localSeq");
    before.onerror = () => transaction.abort();
    before.onsuccess = () => {
      if (!isCurrent()) {
        retired = true;
        transaction.abort();
        return;
      }
      for (const operation of operations) {
        const target = transaction.objectStore(operation.store);
        if (operation.type === "delete") {
          target.delete(operation.key);
        } else {
          target.put(operation.value);
        }
      }
      wrote = true;
      const after = store.get("localSeq");
      after.onerror = () => transaction.abort();
      after.onsuccess = () => {
        if (!isCurrent()) {
          retired = true;
          transaction.abort();
        }
      };
    };
  });
}

function toWorkspaceEntity(workspace: Workspace): SyncEntity {
  return {
    id: workspace.id,
    name: workspace.name,
    color: workspace.color,
    position: workspace.position,
    seq: workspace.seq,
    deleted_at: null,
    updated_at: Date.now(),
  };
}

function toCollectionEntity(collection: Collection): SyncEntity {
  return {
    id: collection.id,
    workspace_id: collection.workspaceId || null,
    name: collection.name,
    icon: collection.icon,
    position: collection.position,
    seq: collection.seq,
    deleted_at: collection.deletedAt ?? null,
    archived_at: collection.archivedAt ?? null,
    updated_at: Date.now(),
    is_deleted: collection.deletedAt ? 1 : 0,
  };
}

function toTagEntity(tag: Tag): SyncEntity {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    seq: tag.seq,
    deleted_at: tag.deletedAt ?? null,
    updated_at: Date.now(),
  };
}

function toBookmarkEntity(
  bookmark: Bookmark & { isTrashed?: number },
  bucket: "active" | "archived" | "trashed",
): SyncEntity {
  const isTrashed = bucket === "trashed" ? (bookmark.isTrashed === 2 ? 2 : 1) : 0;
  return {
    id: bookmark.id,
    collection_id: bookmark.collectionId || null,
    title: bookmark.title,
    url: bookmark.url,
    favicon_url: bookmark.favicon,
    description: bookmark.description,
    is_favorite: bookmark.isFavorite,
    is_archived: bucket === "archived",
    is_trashed: isTrashed,
    tag_ids: bookmark.tags,
    position: 0,
    seq: bookmark.seq,
    deleted_at: isTrashed === 2 ? (bookmark.deletedAt ?? Date.now()) : null,
    updated_at: Date.now(),
  };
}

function toGroupEntity(group: SavedGroup, tabs: readonly GroupTab[]): SyncEntity {
  return {
    id: group.id,
    name: group.name,
    color: group.color,
    is_compact: group.isCompact,
    seq: group.seq,
    deleted_at: group.deletedAt ?? null,
    is_deleted: group.deletedAt ? 1 : 0,
    created_at: new Date(group.createdAt).getTime(),
    updated_at: Date.now(),
    workspace_id: group.workspaceId,
    tabs: tabs
      .filter((tab) => tab.groupId === group.id)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
      .map((tab) => ({
        id: tab.id,
        group_id: tab.groupId,
        title: tab.title,
        url: tab.url,
        favicon: tab.favicon,
        position: tab.position,
      })),
  };
}

function mergeEntityArrays(
  deferred: readonly SyncEntity[],
  current: readonly SyncEntity[],
): SyncEntity[] {
  const entities = new Map(deferred.map((entity) => [entity.id, entity]));
  for (const entity of current) {
    entities.set(entity.id, entity);
  }
  return [...entities.values()];
}

function payloadReferences(payload: SyncPushPayload): SyncEntityReference[] {
  const references = (
    entityType: SyncEntityReference["entityType"],
    entities: readonly SyncEntity[],
  ): SyncEntityReference[] => entities.map((entity) => ({
    entityType,
    entityId: entity.id,
  }));
  return [
    ...references("workspace", payload.entities.workspaces),
    ...references("collection", payload.entities.collections),
    ...references("bookmark", payload.entities.bookmarks),
    ...references("tag", payload.entities.tags),
    ...references("saved_group", payload.entities.groups),
  ];
}

function deduplicateReferences(references: readonly SyncEntityReference[]): SyncEntityReference[] {
  const result = new Map<string, SyncEntityReference>();
  for (const reference of references) {
    result.set(`${reference.entityType}:${reference.entityId}`, reference);
  }
  return [...result.values()];
}

export interface WorkspaceLifecycleAggregateRecords {
  workspace: Workspace | undefined;
  collections: Collection[];
  activeBookmarks: Bookmark[];
  archivedBookmarks: Bookmark[];
  trashedBookmarks: Array<Bookmark & { isTrashed?: number }>;
  tags: Tag[];
  groups: SavedGroup[];
  groupTabs: GroupTab[];
  deferred: SyncPushPayload;
}

export async function loadWorkspaceLifecycleAggregatePayload(
  workspaceId: string,
): Promise<WorkspaceLifecycleAggregatePayload> {
  const { idbGet, idbGetAll } = await import("@/lib/idb");
  const [
    workspace,
    collections,
    activeBookmarks,
    archivedBookmarks,
    trashedBookmarks,
    tags,
    groups,
    groupTabs,
    deferredRecord,
  ] = await Promise.all([
    idbGet<Workspace>("workspaces", workspaceId),
    idbGetAll<Collection>("collections"),
    idbGetAll<Bookmark>("bookmarks"),
    idbGetAll<Bookmark>("archived-bookmarks"),
    idbGetAll<Bookmark & { isTrashed?: number }>("trashed-bookmarks"),
    idbGetAll<Tag>("tags"),
    idbGetAll<SavedGroup>("groups"),
    idbGetAll<GroupTab>("group-tabs"),
    readWorkspaceLifecycleDeferredSync(),
  ]);
  return buildWorkspaceLifecycleAggregatePayload(workspaceId, {
    workspace,
    collections,
    activeBookmarks,
    archivedBookmarks,
    trashedBookmarks,
    tags,
    groups,
    groupTabs,
    deferred: deferredRecord.payloadsByWorkspaceId[workspaceId] ?? createEmptySyncPushPayload(),
  });
}

export function buildWorkspaceLifecycleAggregatePayload(
  workspaceId: string,
  records: WorkspaceLifecycleAggregateRecords,
): WorkspaceLifecycleAggregatePayload {
  const {
    workspace,
    collections,
    activeBookmarks,
    archivedBookmarks,
    trashedBookmarks,
    tags,
    groups,
    groupTabs,
    deferred,
  } = records;
  const deferredCollectionIds = new Set(deferred.entities.collections.map((entity) => entity.id));
  const currentCollections = collections.filter((collection) =>
    (collection.workspaceId === workspaceId && collection.seq === 0) ||
    deferredCollectionIds.has(collection.id),
  );
  const aggregateCollectionIds = new Set(
    collections.filter((collection) => collection.workspaceId === workspaceId).map((collection) => collection.id),
  );
  for (const entity of deferred.entities.collections) {
    aggregateCollectionIds.add(entity.id);
  }
  const deferredGroupIds = new Set(deferred.entities.groups.map((entity) => entity.id));
  const currentGroups = groups.filter((group) =>
    (group.workspaceId === workspaceId && group.seq === 0) ||
    deferredGroupIds.has(group.id),
  );
  const deferredBookmarkIds = new Set(deferred.entities.bookmarks.map((entity) => entity.id));
  const currentBookmarks = [
    ...activeBookmarks
      .filter((bookmark) =>
        (aggregateCollectionIds.has(bookmark.collectionId) && bookmark.seq === 0) ||
        deferredBookmarkIds.has(bookmark.id))
      .map((bookmark) => toBookmarkEntity(bookmark, "active")),
    ...archivedBookmarks
      .filter((bookmark) =>
        (aggregateCollectionIds.has(bookmark.collectionId) && bookmark.seq === 0) ||
        deferredBookmarkIds.has(bookmark.id))
      .map((bookmark) => toBookmarkEntity(bookmark, "archived")),
    ...trashedBookmarks
      .filter((bookmark) =>
        (aggregateCollectionIds.has(bookmark.collectionId) && bookmark.seq === 0) ||
        deferredBookmarkIds.has(bookmark.id))
      .map((bookmark) => toBookmarkEntity(bookmark, "trashed")),
  ];
  const referencedTagIds = new Set<string>();
  for (const bookmark of [...deferred.entities.bookmarks, ...currentBookmarks]) {
    if (!Array.isArray(bookmark.tag_ids)) {
      continue;
    }
    for (const tagId of bookmark.tag_ids) {
      if (typeof tagId === "string") {
        referencedTagIds.add(tagId);
      }
    }
  }
  const deferredTagIds = new Set(deferred.entities.tags.map((entity) => entity.id));
  const currentTags = tags.filter((tag) =>
    deferredTagIds.has(tag.id) || (tag.seq === 0 && referencedTagIds.has(tag.id)),
  );
  const activeWorkspacePayload = createEmptySyncPushPayload();
  if (workspace) {
    activeWorkspacePayload.entities.workspaces.push(toWorkspaceEntity(workspace));
  } else {
    activeWorkspacePayload.entities.workspaces.push(...deferred.entities.workspaces.filter(
      (entity) => entity.id === workspaceId,
    ).map((entity) => {
      const { lifecycle_action: _lifecycleAction, deleted_at: _deletedAt, ...active } = entity;
      return active;
    }));
  }
  const collectionsAndGroupsPayload = createEmptySyncPushPayload();
  collectionsAndGroupsPayload.entities.collections.push(...mergeEntityArrays(
    deferred.entities.collections,
    currentCollections.map(toCollectionEntity),
  ));
  collectionsAndGroupsPayload.entities.groups.push(...mergeEntityArrays(
    deferred.entities.groups,
    currentGroups.map((group) => toGroupEntity(group, groupTabs)),
  ));
  collectionsAndGroupsPayload.entities.tags.push(...mergeEntityArrays(
    deferred.entities.tags,
    currentTags.map(toTagEntity),
  ));
  const bookmarksPayload = createEmptySyncPushPayload();
  bookmarksPayload.entities.bookmarks.push(...mergeEntityArrays(
    deferred.entities.bookmarks,
    currentBookmarks,
  ));
  return {
    references: deduplicateReferences([
      ...payloadReferences(deferred),
      ...payloadReferences(activeWorkspacePayload),
      ...payloadReferences(collectionsAndGroupsPayload),
      ...payloadReferences(bookmarksPayload),
    ]),
    activeWorkspacePayload,
    collectionsAndGroupsPayload,
    bookmarksPayload,
  };
}

async function hasDeferred(workspaceId: string): Promise<boolean> {
  const record = await readWorkspaceLifecycleDeferredSync();
  return record.payloadsByWorkspaceId[workspaceId] !== undefined;
}

async function rollbackLastActive(intent: WorkspaceLifecycleIntent): Promise<void> {
  const { idbTransaction } = await import("@/lib/idb");
  let restored: Workspace | undefined;
  await idbTransaction(["workspaces", "kv"], "readwrite", (transaction) => {
    const workspaceRequest = transaction.objectStore("workspaces").get(intent.workspaceId);
    const intentsRequest = transaction.objectStore("kv").get("workspace-lifecycle-intents-v1");
    const deferredRequest = transaction.objectStore("kv").get(
      "workspace-lifecycle-deferred-sync-v1",
    );
    for (const request of [workspaceRequest, intentsRequest, deferredRequest]) {
      request.onerror = () => transaction.abort();
    }
    let completed = 0;
    const update = () => {
      completed += 1;
      if (completed !== 3) {
        return;
      }
      const current: unknown = workspaceRequest.result;
      if (typeof current !== "object" || current === null || !("id" in current) ||
        typeof current.id !== "string") {
        return;
      }
      const workspace: Workspace = {
        id: current.id,
        name: "name" in current && typeof current.name === "string" ? current.name : "",
        color: "color" in current && typeof current.color === "string" ? current.color : "",
        position: "position" in current && typeof current.position === "number" ? current.position : 0,
        seq: intent.baseSeq,
        ...( "deletionModel" in current && (current.deletionModel === 0 || current.deletionModel === 1)
          ? { deletionModel: current.deletionModel }
          : {}),
      };
      restored = workspace;
      transaction.objectStore("workspaces").put(workspace);
      transaction.objectStore("kv").put({
        key: "activeWorkspaceId",
        value: intent.previousActiveWorkspaceId,
      });
      const persisted: unknown = intentsRequest.result;
      const currentIntents = typeof persisted === "object" && persisted !== null &&
          "value" in persisted && typeof persisted.value === "object" && persisted.value !== null &&
          "intents" in persisted.value && Array.isArray(persisted.value.intents)
        ? persisted.value.intents.filter((candidate) =>
            typeof candidate !== "object" || candidate === null ||
            !("workspaceId" in candidate) || candidate.workspaceId !== intent.workspaceId,
          )
        : [];
      if (currentIntents.length === 0) {
        transaction.objectStore("kv").delete("workspace-lifecycle-intents-v1");
      } else {
        transaction.objectStore("kv").put({
          key: "workspace-lifecycle-intents-v1",
          value: { version: 1, intents: currentIntents },
        });
      }
      const persistedDeferred: unknown = deferredRequest.result;
      if (typeof persistedDeferred === "object" && persistedDeferred !== null &&
        "value" in persistedDeferred && typeof persistedDeferred.value === "object" &&
        persistedDeferred.value !== null && "payloadsByWorkspaceId" in persistedDeferred.value &&
        typeof persistedDeferred.value.payloadsByWorkspaceId === "object" &&
        persistedDeferred.value.payloadsByWorkspaceId !== null) {
        const payloadsByWorkspaceId = Object.fromEntries(
          Object.entries(persistedDeferred.value.payloadsByWorkspaceId)
            .filter(([workspaceId]) => workspaceId !== intent.workspaceId),
        );
        if (Object.keys(payloadsByWorkspaceId).length === 0) {
          transaction.objectStore("kv").delete("workspace-lifecycle-deferred-sync-v1");
        } else {
          transaction.objectStore("kv").put({
            key: "workspace-lifecycle-deferred-sync-v1",
            value: { version: 1, payloadsByWorkspaceId },
          });
        }
      }
    };
    workspaceRequest.onsuccess = update;
    intentsRequest.onsuccess = update;
    deferredRequest.onsuccess = update;
  });
  if (!restored) {
    return;
  }
  const { useWorkspaceStore } = await import("@/store/workspace-store");
  useWorkspaceStore.setState((state) => ({
    workspaces: state.workspaces.map((candidate) =>
      candidate.id === restored?.id ? restored : candidate,
    ),
    activeWorkspaceId: intent.previousActiveWorkspaceId,
  }));
}

export async function blockPruneAndCleanTerminalAggregates(
  context: SyncResolutionContext,
  workspaceIds: readonly string[],
): Promise<void> {
  const {
    clearWorkspaceAggregate,
    loadWorkspaceAggregateIds,
    toSyncEntityReferences,
  } = await import("@/lib/workspace-aggregate");
  for (const workspaceId of workspaceIds) {
    const ids = await loadWorkspaceAggregateIds(workspaceId);
    if (!context.isCurrent()) {
      throw new Error("Sync resolution is no longer current");
    }
    const references = toSyncEntityReferences(ids);
    context.blockEntities(references);
    await context.pruneEntities(references);
    if (!context.isCurrent()) {
      throw new Error("Sync resolution is no longer current");
    }
    let committedIds: WorkspaceAggregateIds | undefined;
    await clearWorkspaceAggregate(workspaceId, (ids) => {
      committedIds = ids;
    });
    if (committedIds) {
      await applyAggregateCleanupToStores(committedIds);
    }
    if (!context.isCurrent()) {
      throw new Error("Sync resolution is no longer current");
    }
  }
}

async function applyAggregateCleanupToStores(ids: WorkspaceAggregateIds): Promise<void> {
  const [{ useWorkspaceStore }, { useBookmarksStore }, { useGroupsStore }] = await Promise.all([
    import("@/store/workspace-store"),
    import("@/store/bookmarks-store"),
    import("@/store/groups-store"),
  ]);
  useWorkspaceStore.getState().removeWorkspaceAggregateFromState(ids);
  useBookmarksStore.getState().removeWorkspaceAggregateFromState(ids);
  useGroupsStore.getState().removeWorkspaceAggregateFromState(ids);
}

const defaultServices: WorkspaceLifecycleCoordinatorServices = {
  readIntents: readWorkspaceLifecycleIntents,
  loadAggregatePayload: loadWorkspaceLifecycleAggregatePayload,
  confirmPayload: confirmSyncPayload,
  removeIntent: removeWorkspaceLifecycleIntent,
  removeDeferred: removeWorkspaceLifecycleDeferredPayload,
  completeIntent: completeWorkspaceLifecycleIntent,
  hasDeferred,
  rollbackLastActive,
  cleanTerminal: (context, workspaceId) =>
    blockPruneAndCleanTerminalAggregates(context, [workspaceId]),
  clearConflictTree: async (workspaceId) => {
    const { syncConflictRegistry } = await import("@/lib/sync-conflicts");
    await syncConflictRegistry.clearRoot("workspace", workspaceId);
  },
};

function createLifecyclePayload(
  aggregate: WorkspaceLifecycleAggregatePayload,
  action: "delete" | "restore",
): SyncPushPayload {
  const payload = createEmptySyncPushPayload();
  const current = aggregate.activeWorkspacePayload.entities.workspaces[0];
  if (current) {
    payload.entities.workspaces.push({
      ...current,
      lifecycle_action: action,
      ...(action === "delete" ? { deleted_at: Date.now() } : { deleted_at: null }),
    });
  }
  return payload;
}

function knownReason(rejection: SyncRejected): KnownSyncRejectionReason | undefined {
  return isKnownSyncRejectionReason(rejection.reason) ? rejection.reason : undefined;
}

function assertCurrent(context: SyncResolutionContext): void {
  if (!context.isCurrent()) {
    throw new Error("Sync resolution is no longer current");
  }
}

async function recordRejection(
  dependencies: WorkspaceLifecycleCoordinatorDependencies,
  intent: WorkspaceLifecycleIntent,
  rejection: SyncRejected,
): Promise<void> {
  const createdAt = Date.now();
  if (isSyncEntityType(rejection.type)) {
    await dependencies.reportConflict({
      entityType: rejection.type,
      entityId: rejection.id,
      reason: rejection.reason,
      ...(isSyncEntityType(rejection.parent_type) && rejection.parent_id
        ? { parentType: rejection.parent_type, parentId: rejection.parent_id }
        : {}),
      createdAt,
    });
  }
  await dependencies.reportConflict({
    entityType: "workspace",
    entityId: intent.workspaceId,
    reason: rejection.reason,
    createdAt,
  });
}

async function quarantineIntentAggregate(
  dependencies: WorkspaceLifecycleCoordinatorDependencies,
  services: WorkspaceLifecycleCoordinatorServices,
  intent: WorkspaceLifecycleIntent,
): Promise<void> {
  const aggregate = await services.loadAggregatePayload(intent.workspaceId);
  assertCurrent(dependencies.context);
  await dependencies.context.captureDeferredEntities(
    intent.workspaceId,
    aggregate.references,
  );
  assertCurrent(dependencies.context);
  for (const reference of aggregate.references) {
    if (reference.entityType === "workspace") {
      continue;
    }
    await dependencies.reportConflict({
      entityType: reference.entityType,
      entityId: reference.entityId,
      reason: "parent_deleted",
      parentType: "workspace",
      parentId: intent.workspaceId,
      createdAt: Date.now(),
    });
  }
}

async function pushPhase(
  dependencies: WorkspaceLifecycleCoordinatorDependencies,
  services: WorkspaceLifecycleCoordinatorServices,
  intent: WorkspaceLifecycleIntent,
  payload: SyncPushPayload,
): Promise<SyncRejected | undefined> {
  if (isSyncPushPayloadEmpty(payload)) {
    return undefined;
  }
  for (const chunk of splitSyncPushPayload(payload)) {
    assertCurrent(dependencies.context);
    const response = await dependencies.context.pushConfirmed(chunk);
    assertCurrent(dependencies.context);
    const rejection = response.rejected[0];
    if (rejection) {
      if (knownReason(rejection) === "permanently_deleted") {
        await services.cleanTerminal(dependencies.context, intent.workspaceId);
        return rejection;
      }
      if (knownReason(rejection) === "last_active_workspace") {
        await services.rollbackLastActive(intent);
        dependencies.notify("workspaceLifecycle_lastActiveWorkspace");
        return rejection;
      }
      await quarantineIntentAggregate(dependencies, services, intent);
      await recordRejection(dependencies, intent, rejection);
      assertCurrent(dependencies.context);
      return rejection;
    }
    await services.confirmPayload(chunk, response.server_seq);
    assertCurrent(dependencies.context);
  }
  return undefined;
}

async function completeIntent(
  services: WorkspaceLifecycleCoordinatorServices,
  workspaceId: string,
): Promise<void> {
  await services.completeIntent(workspaceId);
}

async function reconcileDelete(
  dependencies: WorkspaceLifecycleCoordinatorDependencies,
  services: WorkspaceLifecycleCoordinatorServices,
  intent: WorkspaceLifecycleIntent,
  remote: ServerWorkspace | undefined,
): Promise<void> {
  if (remote?.is_deleted === 2) {
    await services.cleanTerminal(dependencies.context, intent.workspaceId);
    return;
  }
  if (remote?.is_deleted === 1) {
    const aggregate = await services.loadAggregatePayload(intent.workspaceId);
    const hasDescendants = aggregate.references.some((reference) =>
      reference.entityType !== "workspace",
    );
    const deferredRemains = await services.hasDeferred(intent.workspaceId);
    if (deferredRemains || hasDescendants) {
      await quarantineIntentAggregate(dependencies, services, intent);
    }
    await services.removeIntent(intent.workspaceId);
    if (deferredRemains || hasDescendants) {
      await dependencies.reportConflict({
        entityType: "workspace",
        entityId: intent.workspaceId,
        reason: "parent_deleted",
        createdAt: Date.now(),
      });
    }
    return;
  }
  if (!remote && intent.baseSeq > 0) {
    if (!dependencies.authoritativeFullPull) {
      return;
    }
    await quarantineIntentAggregate(dependencies, services, intent);
    await dependencies.reportConflict({
      entityType: "workspace",
      entityId: intent.workspaceId,
      reason: "permanently_deleted",
      createdAt: Date.now(),
    });
    return;
  }

  let aggregate = await services.loadAggregatePayload(intent.workspaceId);
  assertCurrent(dependencies.context);
  await dependencies.context.captureDeferredEntities(intent.workspaceId, aggregate.references);
  assertCurrent(dependencies.context);
  aggregate = await services.loadAggregatePayload(intent.workspaceId);
  assertCurrent(dependencies.context);
  const phases = [
    aggregate.activeWorkspacePayload,
    aggregate.collectionsAndGroupsPayload,
    aggregate.bookmarksPayload,
  ];
  for (const phase of phases) {
    if (await pushPhase(dependencies, services, intent, phase)) {
      return;
    }
  }
  aggregate = await services.loadAggregatePayload(intent.workspaceId);
  assertCurrent(dependencies.context);
  await pushPhase(
    dependencies,
    services,
    intent,
    createLifecyclePayload(aggregate, "delete"),
  );
}

async function reconcileRestore(
  dependencies: WorkspaceLifecycleCoordinatorDependencies,
  services: WorkspaceLifecycleCoordinatorServices,
  intent: WorkspaceLifecycleIntent,
  remote: ServerWorkspace | undefined,
): Promise<void> {
  if (remote?.is_deleted === 2) {
    await services.cleanTerminal(dependencies.context, intent.workspaceId);
    return;
  }
  if (!remote && intent.baseSeq > 0) {
    if (!dependencies.authoritativeFullPull) {
      return;
    }
    await quarantineIntentAggregate(dependencies, services, intent);
    await dependencies.reportConflict({
      entityType: "workspace",
      entityId: intent.workspaceId,
      reason: "permanently_deleted",
      createdAt: Date.now(),
    });
    return;
  }
  const aggregate = await services.loadAggregatePayload(intent.workspaceId);
  assertCurrent(dependencies.context);
  if (remote?.is_deleted === 1) {
    const restore = createLifecyclePayload(aggregate, "restore");
    if (await pushPhase(dependencies, services, intent, restore)) {
      return;
    }
    if (remote.deletion_model === 0) {
      dependencies.notify("workspaceLifecycle_legacyArchiveStateLimited");
    }
  } else if (!remote && intent.baseSeq === 0) {
    if (await pushPhase(dependencies, services, intent, aggregate.activeWorkspacePayload)) {
      return;
    }
  }
  const deferredPhases = [
    aggregate.collectionsAndGroupsPayload,
    aggregate.bookmarksPayload,
  ];
  for (const phase of deferredPhases) {
    if (await pushPhase(dependencies, services, intent, phase)) {
      return;
    }
  }
  await completeIntent(services, intent.workspaceId);
  assertCurrent(dependencies.context);
  await services.clearConflictTree(intent.workspaceId);
  assertCurrent(dependencies.context);
}

export async function reconcileWorkspaceLifecycleIntents(
  dependencies: WorkspaceLifecycleCoordinatorDependencies,
): Promise<void> {
  const services: WorkspaceLifecycleCoordinatorServices = {
    ...defaultServices,
    ...dependencies.services,
  };
  const authoritative = new Map(
    dependencies.authoritativeWorkspaces.map((workspace) => [workspace.id, workspace]),
  );
  const intents = await services.readIntents();
  assertCurrent(dependencies.context);
  for (const intent of intents.sort((left, right) =>
    left.createdAt - right.createdAt || left.workspaceId.localeCompare(right.workspaceId),
  )) {
    assertCurrent(dependencies.context);
    const remote = authoritative.get(intent.workspaceId);
    if (intent.action === "delete") {
      await reconcileDelete(dependencies, services, intent, remote);
    } else {
      await reconcileRestore(dependencies, services, intent, remote);
    }
  }
}
