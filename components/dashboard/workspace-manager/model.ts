import type { Bookmark, Collection, Workspace } from "@/lib/types";
import type { SavedGroup } from "@/store/groups-store";
import type { WorkspaceActionResult } from "@/store/workspace-store";
import type { SyncStatus } from "@/lib/sync-engine";

const DAY_MS = 86_400_000;

export interface WorkspaceAggregateCounts {
  collections: number;
  bookmarks: number;
  savedGroups: number;
}

export type WorkspaceRetention =
  | { kind: "guest" }
  | { kind: "unlimited" }
  | { kind: "expired" }
  | { kind: "remaining"; days: number };

export interface WorkspaceManagerCardModel {
  workspace: Workspace;
  counts: WorkspaceAggregateCounts;
  retention: WorkspaceRetention;
  canDelete: boolean;
}

export interface WorkspaceManagerViewModel {
  inUse: WorkspaceManagerCardModel[];
  deleted: WorkspaceManagerCardModel[];
}

export interface WorkspaceDeleteConfirmation {
  workspaceId: string;
  workspaceName: string;
  counts: WorkspaceAggregateCounts;
  retention: WorkspaceRetention;
  quotaMessageKey: "workspaceManager_stillCountsTowardQuota";
}

export type WorkspaceLifecycleAction = "delete" | "restore" | "purge";

export interface WorkspaceLifecycleActionAvailabilityInput {
  action: WorkspaceLifecycleAction;
  activeWorkspaceCount: number;
  isGuest: boolean;
  isOnline: boolean;
  capabilitySupported: boolean;
  dataReady?: boolean;
}

export interface WorkspaceLifecycleActionAvailability {
  enabled: boolean;
  messageKey?:
    | "workspaceManager_lastActiveGuard"
    | "workspaceManager_updateServerRequired"
    | "workspaceManager_offlinePurge"
    | "workspaceManager_loadingData";
}

export interface WorkspaceManagerActionOutcome {
  shouldClose: boolean;
  messageKey: string | null;
}

export interface ExecuteWorkspaceManagerActionInput {
  action: WorkspaceLifecycleAction;
  operation(): Promise<WorkspaceActionResult>;
  setBusy(busy: boolean): void;
}

function getRetention(
  workspace: Workspace,
  now: number,
  trashGraceDays: number,
  isGuest: boolean,
): WorkspaceRetention {
  if (isGuest) {
    return { kind: "guest" };
  }
  if (trashGraceDays < 0) {
    return { kind: "unlimited" };
  }
  if (workspace.deletedAt === undefined) {
    return { kind: "remaining", days: trashGraceDays };
  }

  const expiresAt = workspace.deletedAt + trashGraceDays * DAY_MS;
  if (expiresAt <= now) {
    return { kind: "expired" };
  }
  return {
    kind: "remaining",
    days: Math.ceil((expiresAt - now) / DAY_MS),
  };
}

function createCounts(
  workspaceId: string,
  collections: readonly Collection[],
  bookmarks: readonly Bookmark[],
  groups: readonly SavedGroup[],
): WorkspaceAggregateCounts {
  const workspaceCollections = collections.filter(
    (collection) => collection.workspaceId === workspaceId,
  );
  const collectionIds = new Set(
    workspaceCollections.map((collection) => collection.id),
  );
  return {
    collections: workspaceCollections.length,
    bookmarks: bookmarks.filter((bookmark) => collectionIds.has(bookmark.collectionId)).length,
    savedGroups: groups.filter((group) => group.workspaceId === workspaceId).length,
  };
}

export function createWorkspaceManagerViewModel(input: {
  workspaces: readonly Workspace[];
  collections: readonly Collection[];
  bookmarks: {
    active: readonly Bookmark[];
    archived: readonly Bookmark[];
    trashed: readonly Bookmark[];
  };
  groups: readonly SavedGroup[];
  now: number;
  trashGraceDays: number;
  isGuest: boolean;
}): WorkspaceManagerViewModel {
  const activeWorkspaceCount = input.workspaces.filter(
    (workspace) => workspace.deletedAt === undefined,
  ).length;
  const bookmarksById = new Map<string, Bookmark>();
  for (const bookmark of [
    ...input.bookmarks.active,
    ...input.bookmarks.archived,
    ...input.bookmarks.trashed,
  ]) {
    bookmarksById.set(bookmark.id, bookmark);
  }
  const allBookmarks = Array.from(bookmarksById.values());
  const cards = [...input.workspaces]
    .sort((first, second) => first.position - second.position)
    .map((workspace): WorkspaceManagerCardModel => ({
      workspace,
      counts: createCounts(
        workspace.id,
        input.collections,
        allBookmarks,
        input.groups,
      ),
      retention: getRetention(
        workspace,
        input.now,
        input.trashGraceDays,
        input.isGuest,
      ),
      canDelete: workspace.deletedAt === undefined && activeWorkspaceCount > 1,
    }));

  return {
    inUse: cards.filter((card) => card.workspace.deletedAt === undefined),
    deleted: cards.filter((card) => card.workspace.deletedAt !== undefined),
  };
}

export function canConfirmPermanentDelete(
  typedName: string,
  workspaceName: string,
): boolean {
  return typedName === workspaceName;
}

export function getWorkspaceLifecycleActionAvailability(
  input: WorkspaceLifecycleActionAvailabilityInput,
): WorkspaceLifecycleActionAvailability {
  if (input.dataReady === false) {
    return {
      enabled: false,
      messageKey: "workspaceManager_loadingData",
    };
  }
  if (input.action === "delete" && input.activeWorkspaceCount <= 1) {
    return {
      enabled: false,
      messageKey: "workspaceManager_lastActiveGuard",
    };
  }
  if (!input.isGuest && !input.capabilitySupported) {
    return {
      enabled: false,
      messageKey: "workspaceManager_updateServerRequired",
    };
  }
  if (input.action === "purge" && !input.isGuest && !input.isOnline) {
    return {
      enabled: false,
      messageKey: "workspaceManager_offlinePurge",
    };
  }
  return { enabled: true };
}

export function createDeleteWorkspaceConfirmation(
  card: WorkspaceManagerCardModel,
): WorkspaceDeleteConfirmation {
  return {
    workspaceId: card.workspace.id,
    workspaceName: card.workspace.name,
    counts: card.counts,
    retention: card.retention,
    quotaMessageKey: "workspaceManager_stillCountsTowardQuota",
  };
}

export function getWorkspaceActionResultMessageKey(
  result: WorkspaceActionResult,
  action: WorkspaceLifecycleAction,
): string | null {
  if (result.status === "completed") {
    return null;
  }
  if (result.reason === "last_active_workspace") {
    return "workspaceManager_lastActiveGuard";
  }
  if (result.reason === "server_capability") {
    return "workspaceManager_updateServerRequired";
  }
  if (result.reason === "offline") {
    return action === "purge"
      ? "workspaceManager_offlinePurge"
      : "workspaceManager_actionFailed";
  }
  if (action === "purge" && result.status === "queued") {
    return "workspaceManager_purgePending";
  }
  if (result.status === "queued") {
    return null;
  }
  return "workspaceManager_actionFailed";
}

export function resolveWorkspaceManagerOnlineStatus(
  browserOnline: boolean,
  syncStatus: SyncStatus,
): boolean {
  return browserOnline && syncStatus !== "offline";
}

export async function executeWorkspaceManagerAction({
  action,
  operation,
  setBusy,
}: ExecuteWorkspaceManagerActionInput): Promise<WorkspaceManagerActionOutcome> {
  setBusy(true);
  try {
    const result = await operation();
    const messageKey = getWorkspaceActionResultMessageKey(result, action);
    return {
      shouldClose: messageKey === null,
      messageKey,
    };
  } catch {
    return {
      shouldClose: false,
      messageKey: "workspaceManager_actionFailed",
    };
  } finally {
    setBusy(false);
  }
}
