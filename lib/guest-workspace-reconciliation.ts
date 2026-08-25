import type { PlanResponse, SyncEntityType, SyncPullResponse, SyncPushResponse } from "@/lib/api";
import type { Bookmark, Collection, Workspace } from "@/lib/types";
import { idbBulkWrite, idbDelete, idbGet, idbGetAll, type BulkWriteOp } from "@/lib/idb";
import {
  GUEST_WORKSPACE_PROVENANCE_KEY,
  type GuestWorkspaceDiscardPlan,
  type GuestWorkspacePlan,
  type GuestWorkspaceProvenanceRecord,
  type GuestWorkspaceSnapshot,
  isUntouchedGuestWorkspace,
  planGuestWorkspaceMigration,
  selectGuestMigrationTarget,
} from "@/lib/guest-workspace";
import { syncConflictRegistry, type SyncConflict } from "@/lib/sync-conflicts";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { type GroupTab, type SavedGroup, useGroupsStore } from "@/store/groups-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { readWorkspaceLifecycleIntents } from "@/lib/workspace-lifecycle-state";
import { workspaceHasPendingDeleteIntent } from "@/lib/workspace-lifecycle-coordinator";

export type SyncConflictErrorKey =
  | "sync_noMigrationTarget"
  | "sync_invalidParentConflict"
  | "sync_quotaConflict";

export interface GuestReconciliationResult {
  kind: "none" | "discarded" | "retained" | "migrated" | "conflict";
  needsResweep: boolean;
  targetWorkspaceName?: string;
  errorKey?: SyncConflictErrorKey;
}

interface GuestSnapshotLoadResult {
  snapshot?: GuestWorkspaceSnapshot;
  incomplete: boolean;
}

const NONE_RESULT: GuestReconciliationResult = { kind: "none", needsResweep: false };

function isActiveRemoteWorkspace(workspace: { seq: number; deleted_at?: number }): boolean {
  return workspace.seq > 0 && workspace.deleted_at === undefined;
}

function sourceCollectionIds(snapshot: GuestWorkspaceSnapshot): Set<string> {
  return new Set(snapshot.collections
    .filter((collection) => collection.workspaceId === snapshot.provenance.workspaceId)
    .map((collection) => collection.id));
}

async function loadGuestSnapshot(): Promise<GuestSnapshotLoadResult> {
  const provenanceRecord = await idbGet<GuestWorkspaceProvenanceRecord>("kv", GUEST_WORKSPACE_PROVENANCE_KEY);
  if (!provenanceRecord || provenanceRecord.key !== GUEST_WORKSPACE_PROVENANCE_KEY || provenanceRecord.value.version !== 1) {
    return { incomplete: false };
  }
  const [workspaces, collections, activeBookmarks, archivedBookmarks, trashedBookmarks, groups, groupTabs] =
    await Promise.all([
      idbGetAll<Workspace>("workspaces"),
      idbGetAll<Collection>("collections"),
      idbGetAll<Bookmark>("bookmarks"),
      idbGetAll<Bookmark>("archived-bookmarks"),
      idbGetAll<Bookmark>("trashed-bookmarks"),
      idbGetAll<SavedGroup>("groups"),
      idbGetAll<GroupTab>("group-tabs"),
    ]);
  const workspace = workspaces.find((item) => item.id === provenanceRecord.value.workspaceId);
  const defaultCollection = collections.find((item) => item.id === provenanceRecord.value.defaultCollectionId);
  if (!workspace && !defaultCollection) {
    await idbDelete("kv", GUEST_WORKSPACE_PROVENANCE_KEY);
    return { incomplete: false };
  }
  if (!workspace || !defaultCollection) {
    await syncConflictRegistry.recordRejections([{
      id: provenanceRecord.value.workspaceId,
      type: "workspace",
      reason: "invalid_parent",
    }]);
    return { incomplete: true };
  }
  return {
    incomplete: false,
    snapshot: {
      provenance: provenanceRecord.value,
      workspace,
      collections,
      activeBookmarks,
      archivedBookmarks,
      trashedBookmarks,
      groups,
      groupTabs,
    },
  };
}

function toPlanResult(plan: GuestWorkspacePlan): GuestReconciliationResult {
  if (plan.kind === "discard") {
    return { kind: "discarded", needsResweep: false };
  }
  if (plan.kind === "migrate") {
    return { kind: "migrated", needsResweep: true, targetWorkspaceName: plan.targetWorkspaceName };
  }
  return { kind: "conflict", needsResweep: false, errorKey: "sync_noMigrationTarget" };
}

function planOperations(plan: GuestWorkspacePlan): BulkWriteOp[] {
  if (plan.kind === "conflict") {
    return [];
  }
  const operations: BulkWriteOp[] = [
    ...plan.workspaceDeletes.map((id) => ({ type: "delete" as const, store: "workspaces" as const, key: id })),
    ...plan.collectionDeletes.map((id) => ({ type: "delete" as const, store: "collections" as const, key: id })),
    ...("collectionPuts" in plan
      ? plan.collectionPuts.map((value) => ({ type: "put" as const, store: "collections" as const, value }))
      : []),
    { type: "delete" as const, store: "kv" as const, key: GUEST_WORKSPACE_PROVENANCE_KEY },
  ];
  if (plan.kind === "discard" && plan.activeWorkspaceId === "") {
    operations.push({ type: "delete" as const, store: "kv" as const, key: "activeWorkspaceId" });
  } else {
    operations.push({ type: "put" as const, store: "kv" as const, value: { key: "activeWorkspaceId", value: plan.activeWorkspaceId } });
  }
  if (plan.kind !== "migrate") {
    return operations;
  }
  return [
    ...operations,
    ...plan.bookmarkPuts.active.map((value) => ({ type: "put" as const, store: "bookmarks" as const, value })),
    ...plan.bookmarkPuts.archived.map((value) => ({ type: "put" as const, store: "archived-bookmarks" as const, value })),
    ...plan.bookmarkPuts.trashed.map((value) => ({ type: "put" as const, store: "trashed-bookmarks" as const, value })),
    ...plan.groupPuts.map((value) => ({ type: "put" as const, store: "groups" as const, value })),
  ];
}

function applyPlanToStores(plan: GuestWorkspacePlan): void {
  if (plan.kind === "conflict") {
    return;
  }
  useWorkspaceStore.getState().applyGuestWorkspaceChanges({
    workspaceDeletes: plan.workspaceDeletes,
    collectionPuts: "collectionPuts" in plan ? plan.collectionPuts : [],
    collectionDeletes: plan.collectionDeletes,
    activeWorkspaceId: plan.activeWorkspaceId,
  });
  const applyGuestBookmarkChanges = useBookmarksStore.getState().applyGuestBookmarkChanges;
  if (applyGuestBookmarkChanges) {
    applyGuestBookmarkChanges(
      plan.kind === "migrate" ? plan.bookmarkPuts : { active: [], archived: [], trashed: [] },
    );
  }
  const applyGuestGroupChanges = useGroupsStore.getState().applyGuestGroupChanges;
  if (applyGuestGroupChanges) {
    applyGuestGroupChanges(plan.kind === "migrate" ? plan.groupPuts : []);
  }
}

async function commitPlan(plan: GuestWorkspacePlan, sourceWorkspaceId: string): Promise<GuestReconciliationResult> {
  if (plan.kind === "conflict") {
    return toPlanResult(plan);
  }
  const applied = await syncConflictRegistry.executeClearRootTransaction(
    "workspace",
    sourceWorkspaceId,
    async (mutation) => {
      await idbBulkWrite([...planOperations(plan), mutation.operation]);
    },
    () => applyPlanToStores(plan),
  );
  return applied ? toPlanResult(plan) : NONE_RESULT;
}

function targetFromCurrentState() {
  const state = useWorkspaceStore.getState();
  return selectGuestMigrationTarget(state.workspaces, state.collections, state.activeWorkspaceId);
}

function conflictsForLocalDescendants(snapshot: GuestWorkspaceSnapshot) {
  const collectionIds = sourceCollectionIds(snapshot);
  return [
    ...snapshot.collections
      .filter((collection) => collection.workspaceId === snapshot.provenance.workspaceId)
      .map((collection) => ({
        id: collection.id,
        type: "collection",
        reason: "parent_rejected",
        parent_id: snapshot.provenance.workspaceId,
        parent_type: "workspace",
      })),
    ...[...snapshot.activeBookmarks, ...snapshot.archivedBookmarks, ...snapshot.trashedBookmarks]
      .filter((bookmark) => collectionIds.has(bookmark.collectionId))
      .map((bookmark) => ({
        id: bookmark.id,
        type: "bookmark",
        reason: "parent_rejected",
        parent_id: bookmark.collectionId,
        parent_type: "collection",
      })),
    ...snapshot.groups
      .filter((group) => group.workspaceId === snapshot.provenance.workspaceId)
      .map((group) => ({
        id: group.id,
        type: "saved_group",
        reason: "parent_rejected",
        parent_id: snapshot.provenance.workspaceId,
        parent_type: "workspace",
      })),
  ];
}

function quotaResource(entityType: SyncEntityType): keyof PlanResponse["limits"] {
  if (entityType === "workspace") { return "max_workspaces"; }
  if (entityType === "collection") { return "max_collections"; }
  if (entityType === "bookmark") { return "max_bookmarks"; }
  if (entityType === "tag") { return "max_tags"; }
  return "max_saved_groups";
}

function quotaUsage(entityType: SyncEntityType): keyof PlanResponse["usage"] {
  if (entityType === "workspace") { return "workspaces"; }
  if (entityType === "collection") { return "collections"; }
  if (entityType === "bookmark") { return "bookmarks"; }
  if (entityType === "tag") { return "tags"; }
  return "saved_groups";
}

async function currentPersistentResult(): Promise<GuestReconciliationResult> {
  const errorKey = await getPersistentSyncErrorKey();
  return errorKey ? { kind: "conflict", needsResweep: false, errorKey } : NONE_RESULT;
}

export async function prepareGuestWorkspaceForPull(response: SyncPullResponse): Promise<GuestReconciliationResult> {
  await syncConflictRegistry.ready();
  const loaded = await loadGuestSnapshot();
  if (loaded.incomplete) {
    return currentPersistentResult();
  }
  if (!loaded.snapshot) {
    return NONE_RESULT;
  }
  const markedWorkspaceIsConfirmed = response.entities.workspaces.some((workspace) =>
    workspace.id === loaded.snapshot?.provenance.workspaceId && isActiveRemoteWorkspace(workspace),
  );
  if (markedWorkspaceIsConfirmed) {
    return { kind: "retained", needsResweep: false };
  }
  const hasExistingRemoteWorkspace = response.entities.workspaces.some((workspace) =>
    workspace.id !== loaded.snapshot?.provenance.workspaceId && isActiveRemoteWorkspace(workspace),
  );
  if (!hasExistingRemoteWorkspace) {
    return { kind: "retained", needsResweep: false };
  }
  if (!isUntouchedGuestWorkspace(loaded.snapshot)) {
    return { kind: "retained", needsResweep: false };
  }
  const plan: GuestWorkspacePlan = {
    kind: "discard",
    workspaceDeletes: [loaded.snapshot.provenance.workspaceId],
    collectionDeletes: [loaded.snapshot.provenance.defaultCollectionId],
    activeWorkspaceId: "",
  };
  return commitPlan(plan, loaded.snapshot.provenance.workspaceId);
}

export async function confirmGuestWorkspaceFromPull(response: SyncPullResponse): Promise<void> {
  const provenanceRecord = await idbGet<GuestWorkspaceProvenanceRecord>("kv", GUEST_WORKSPACE_PROVENANCE_KEY);
  if (!provenanceRecord || provenanceRecord.key !== GUEST_WORKSPACE_PROVENANCE_KEY) {
    return;
  }
  const matched = response.entities.workspaces.some((workspace) =>
    workspace.id === provenanceRecord.value.workspaceId && isActiveRemoteWorkspace(workspace),
  );
  if (matched) {
    await idbDelete("kv", GUEST_WORKSPACE_PROVENANCE_KEY);
  }
}

export async function resolveGuestPushRejections(response: SyncPushResponse): Promise<GuestReconciliationResult> {
  await syncConflictRegistry.ready();
  await syncConflictRegistry.recordRejections(response.rejected);
  const loaded = await loadGuestSnapshot();
  if (loaded.incomplete || !loaded.snapshot) {
    return currentPersistentResult();
  }
  const sourceId = loaded.snapshot.provenance.workspaceId;
  const sourceRejection = response.rejected.find((rejection) =>
    rejection.id === sourceId && rejection.type === "workspace",
  );
  if (!sourceRejection || sourceRejection.reason !== "quota_exceeded") {
    return currentPersistentResult();
  }
  const pendingDelete = workspaceHasPendingDeleteIntent(
    await readWorkspaceLifecycleIntents(),
    sourceId,
  );
  if (pendingDelete) {
    return currentPersistentResult();
  }
  const plan = planGuestWorkspaceMigration(loaded.snapshot, targetFromCurrentState());
  if (plan.kind === "conflict") {
    await syncConflictRegistry.recordRejections(conflictsForLocalDescendants(loaded.snapshot));
    return { kind: "conflict", needsResweep: false, errorKey: "sync_noMigrationTarget" };
  }
  return commitPlan(plan, sourceId);
}

export async function sweepAllUnsynced(): Promise<void> {
  await useWorkspaceStore.getState().sweepUnsynced();
  await useBookmarksStore.getState().sweepUnsynced();
  await useGroupsStore.getState().sweepUnsynced();
}

export async function resolveLegacyGuestWorkspaceFailure(
  plan: PlanResponse,
  remote: SyncPullResponse,
): Promise<GuestReconciliationResult> {
  await syncConflictRegistry.ready();
  const loaded = await loadGuestSnapshot();
  if (loaded.incomplete || !loaded.snapshot) {
    return NONE_RESULT;
  }
  const sourceId = loaded.snapshot.provenance.workspaceId;
  const sourceAbsent = !remote.entities.workspaces.some((workspace) => workspace.id === sourceId);
  const hasActiveRemote = remote.entities.workspaces.some(isActiveRemoteWorkspace);
  const maxWorkspaces = plan.limits.max_workspaces;
  if (!sourceAbsent || !hasActiveRemote || maxWorkspaces === -1 || plan.usage.workspaces < maxWorkspaces) {
    return NONE_RESULT;
  }
  const remoteWorkspaces: Workspace[] = remote.entities.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    color: workspace.color ?? "",
    position: workspace.position,
    seq: workspace.seq,
    ...(workspace.deleted_at === undefined ? {} : { deletedAt: workspace.deleted_at }),
  }));
  const remoteCollections: Collection[] = remote.entities.collections.map((collection) => ({
    id: collection.id,
    workspaceId: collection.workspace_id ?? "",
    name: collection.name,
    icon: collection.icon ?? "folder",
    position: collection.position,
    seq: collection.seq,
    isDefault: collection.is_default ?? false,
    ...(collection.deleted_at === undefined ? {} : { deletedAt: collection.deleted_at }),
    ...(collection.archived_at === undefined ? {} : { archivedAt: collection.archived_at }),
  }));
  const target = selectGuestMigrationTarget(remoteWorkspaces, remoteCollections, "");
  if (!target) {
    return { kind: "conflict", needsResweep: false, errorKey: "sync_noMigrationTarget" };
  }
  const reconciliationPlan = planGuestWorkspaceMigration(loaded.snapshot, target);
  if (reconciliationPlan.kind === "conflict") {
    return { kind: "conflict", needsResweep: false, errorKey: "sync_noMigrationTarget" };
  }
  if (reconciliationPlan.kind !== "discard") {
    return commitPlan(reconciliationPlan, sourceId);
  }
  const legacyDiscardPlan: GuestWorkspaceDiscardPlan = {
    ...reconciliationPlan,
    activeWorkspaceId: target.workspace.id,
  };
  const result = await commitPlan(legacyDiscardPlan, sourceId);
  if (result.kind !== "discarded") {
    return result;
  }
  return {
    kind: "migrated",
    needsResweep: true,
    targetWorkspaceName: target.workspace.name,
  };
}

export async function clearCapacityResolvedConflicts(plan: PlanResponse): Promise<boolean> {
  await syncConflictRegistry.ready();
  const slots = new Map<SyncConflict["entityType"], number>();
  for (const entityType of ["workspace", "collection", "bookmark", "tag", "saved_group"] as const) {
    const limit = plan.limits[quotaResource(entityType)];
    const usage = plan.usage[quotaUsage(entityType)];
    slots.set(entityType, limit === -1 ? Number.POSITIVE_INFINITY : Math.max(0, limit - usage));
  }
  const roots = syncConflictRegistry.list()
    .filter((conflict) => conflict.reason === "quota_exceeded" && conflict.parentType === undefined)
    .sort((left, right) => left.createdAt - right.createdAt || left.entityId.localeCompare(right.entityId));
  let cleared = false;
  for (const root of roots) {
    const available = slots.get(root.entityType) ?? 0;
    if (available <= 0) {
      continue;
    }
    await syncConflictRegistry.clearRoot(root.entityType, root.entityId);
    slots.set(root.entityType, available === Number.POSITIVE_INFINITY ? available : available - 1);
    cleared = true;
  }
  return cleared;
}

export async function getPersistentSyncErrorKey(): Promise<SyncConflictErrorKey | null> {
  await syncConflictRegistry.ready();
  const provenanceRecord = await idbGet<GuestWorkspaceProvenanceRecord>("kv", GUEST_WORKSPACE_PROVENANCE_KEY);
  const conflicts = syncConflictRegistry.list();
  const workspaceQuota = provenanceRecord && conflicts.some((conflict) =>
    conflict.entityType === "workspace" && conflict.entityId === provenanceRecord.value.workspaceId &&
    conflict.reason === "quota_exceeded",
  );
  if (workspaceQuota) {
    return "sync_noMigrationTarget";
  }
  if (conflicts.some((conflict) => conflict.reason === "invalid_parent")) {
    return "sync_invalidParentConflict";
  }
  if (conflicts.some((conflict) => conflict.reason === "quota_exceeded" && conflict.parentType === undefined)) {
    return "sync_quotaConflict";
  }
  const conflictKeys = new Set(conflicts.map((conflict) => `${conflict.entityType}:${conflict.entityId}`));
  if (conflicts.some((conflict) => conflict.reason === "parent_rejected" &&
    (conflict.parentType === undefined || conflict.parentId === undefined ||
      !conflictKeys.has(`${conflict.parentType}:${conflict.parentId}`)))) {
    return "sync_invalidParentConflict";
  }
  return null;
}
