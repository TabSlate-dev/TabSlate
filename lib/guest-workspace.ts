import type { Bookmark, Collection, Workspace } from "@/lib/types";
import type { GroupTab, SavedGroup } from "@/store/groups-store";

export const GUEST_WORKSPACE_PROVENANCE_KEY = "guest-workspace-provenance-v1";

export interface GuestWorkspaceFingerprint {
  workspaceName: string;
  workspaceColor: string;
  workspacePosition: number;
  collectionName: string;
  collectionIcon: string;
  collectionPosition: number;
}

export interface GuestWorkspaceProvenanceValue {
  version: 1;
  state: "pending-server-confirmation";
  workspaceId: string;
  defaultCollectionId: string;
  fingerprint: GuestWorkspaceFingerprint;
}

export interface GuestWorkspaceProvenanceRecord {
  key: typeof GUEST_WORKSPACE_PROVENANCE_KEY;
  value: GuestWorkspaceProvenanceValue;
}

export interface GuestWorkspaceSeed {
  workspace: Workspace;
  collection: Collection;
  provenance: GuestWorkspaceProvenanceRecord;
}

export interface GuestWorkspaceSnapshot {
  provenance: GuestWorkspaceProvenanceValue;
  workspace?: Workspace;
  collections: Collection[];
  activeBookmarks: Bookmark[];
  archivedBookmarks: Bookmark[];
  trashedBookmarks: Bookmark[];
  groups: SavedGroup[];
  groupTabs: GroupTab[];
}

export interface GuestMigrationTarget {
  workspace: Workspace;
  defaultCollection: Collection;
}

export interface GuestBookmarkUpdates {
  active: Bookmark[];
  archived: Bookmark[];
  trashed: Bookmark[];
}

export interface GuestWorkspaceChanges {
  workspaceDeletes: string[];
  collectionPuts: Collection[];
  collectionDeletes: string[];
  activeWorkspaceId?: string;
}

export interface GuestWorkspaceDiscardPlan {
  kind: "discard";
  workspaceDeletes: string[];
  collectionDeletes: string[];
  /** Empty during a normal pre-pull discard; a confirmed target during legacy recovery. */
  activeWorkspaceId: string;
}

export interface GuestWorkspaceMigrationPlan {
  kind: "migrate";
  targetWorkspaceId: string;
  targetWorkspaceName: string;
  workspaceDeletes: string[];
  collectionPuts: Collection[];
  collectionDeletes: string[];
  bookmarkPuts: GuestBookmarkUpdates;
  groupPuts: SavedGroup[];
  activeWorkspaceId: string;
}

export interface GuestWorkspaceConflictPlan {
  kind: "conflict";
  sourceWorkspaceId: string;
  reason: "no_valid_target";
}

export type GuestWorkspacePlan =
  | GuestWorkspaceDiscardPlan
  | GuestWorkspaceMigrationPlan
  | GuestWorkspaceConflictPlan;

export function createGuestWorkspaceSeed(
  workspaceId: string,
  collectionId: string,
  position: number,
): GuestWorkspaceSeed {
  const workspace: Workspace = {
    id: workspaceId, name: "My Workspace", color: "blue", position, seq: 0,
  };
  const collection: Collection = {
    id: collectionId, workspaceId, name: "Default", icon: "inbox",
    position: 0, isDefault: true, seq: 0,
  };
  return {
    workspace,
    collection,
    provenance: {
      key: GUEST_WORKSPACE_PROVENANCE_KEY,
      value: {
        version: 1,
        state: "pending-server-confirmation",
        workspaceId,
        defaultCollectionId: collectionId,
        fingerprint: {
          workspaceName: workspace.name,
          workspaceColor: workspace.color,
          workspacePosition: workspace.position,
          collectionName: collection.name,
          collectionIcon: collection.icon,
          collectionPosition: collection.position,
        },
      },
    },
  };
}

function matchesGuestWorkspaceFingerprint(
  workspace: Workspace,
  fingerprint: GuestWorkspaceFingerprint,
): boolean {
  return workspace.name === fingerprint.workspaceName &&
    workspace.color === fingerprint.workspaceColor &&
    workspace.position === fingerprint.workspacePosition;
}

function matchesGuestDefaultFingerprint(
  collection: Collection,
  fingerprint: GuestWorkspaceFingerprint,
): boolean {
  return collection.name === fingerprint.collectionName &&
    collection.icon === fingerprint.collectionIcon &&
    collection.position === fingerprint.collectionPosition;
}

function isActiveUnsyncedWorkspace(workspace: Workspace): boolean {
  return workspace.seq === 0 && workspace.deletedAt === undefined;
}

function isActiveUnsyncedDefault(collection: Collection): boolean {
  return collection.seq === 0 && collection.isDefault === true &&
    collection.deletedAt === undefined && collection.archivedAt === undefined;
}

export function isUntouchedGuestWorkspace(snapshot: GuestWorkspaceSnapshot): boolean {
  const { provenance, workspace } = snapshot;
  if (!workspace || workspace.id !== provenance.workspaceId) {
    return false;
  }
  if (!isActiveUnsyncedWorkspace(workspace) ||
    !matchesGuestWorkspaceFingerprint(workspace, provenance.fingerprint)) {
    return false;
  }

  const sourceCollections = snapshot.collections.filter(
    (collection) => collection.workspaceId === workspace.id,
  );
  const sourceDefault = sourceCollections.find(
    (collection) => collection.id === provenance.defaultCollectionId,
  );
  if (sourceCollections.length !== 1 || !sourceDefault ||
    !isActiveUnsyncedDefault(sourceDefault) ||
    !matchesGuestDefaultFingerprint(sourceDefault, provenance.fingerprint)) {
    return false;
  }

  const sourceCollectionIds = new Set(sourceCollections.map((collection) => collection.id));
  const hasBookmark = [
    ...snapshot.activeBookmarks,
    ...snapshot.archivedBookmarks,
    ...snapshot.trashedBookmarks,
  ].some((bookmark) => sourceCollectionIds.has(bookmark.collectionId));
  const hasGroup = snapshot.groups.some((group) => group.workspaceId === workspace.id);
  return !hasBookmark && !hasGroup;
}

export function selectGuestMigrationTarget(
  workspaces: Workspace[],
  collections: Collection[],
  activeWorkspaceId: string,
): GuestMigrationTarget | null {
  const confirmed = workspaces
    .filter((workspace) => workspace.seq > 0 && workspace.deletedAt === undefined)
    .sort((left, right) => left.position - right.position);
  const selected = confirmed.find((workspace) => workspace.id === activeWorkspaceId) ?? confirmed[0];
  if (!selected) {
    return null;
  }
  const defaultCollection = collections.find((collection) =>
    collection.workspaceId === selected.id &&
    collection.seq > 0 &&
    collection.isDefault === true &&
    collection.deletedAt === undefined &&
    collection.archivedAt === undefined,
  );
  if (!defaultCollection) {
    return null;
  }
  return { workspace: selected, defaultCollection };
}

export function planGuestWorkspaceMigration(
  snapshot: GuestWorkspaceSnapshot,
  target: GuestMigrationTarget | null,
): GuestWorkspacePlan {
  const sourceWorkspace = snapshot.workspace;
  if (!sourceWorkspace || sourceWorkspace.id !== snapshot.provenance.workspaceId || !target) {
    return {
      kind: "conflict",
      sourceWorkspaceId: snapshot.provenance.workspaceId,
      reason: "no_valid_target",
    };
  }
  if (isUntouchedGuestWorkspace(snapshot)) {
    return {
      kind: "discard",
      workspaceDeletes: [sourceWorkspace.id],
      collectionDeletes: [snapshot.provenance.defaultCollectionId],
      activeWorkspaceId: "",
    };
  }

  const sourceCollections = snapshot.collections.filter(
    (collection) => collection.workspaceId === sourceWorkspace.id,
  );
  const sourceDefault = sourceCollections.find(
    (collection) => collection.id === snapshot.provenance.defaultCollectionId,
  );
  const mergeDefault = sourceDefault !== undefined &&
    isActiveUnsyncedDefault(sourceDefault) &&
    matchesGuestDefaultFingerprint(sourceDefault, snapshot.provenance.fingerprint);
  const maxTargetPosition = snapshot.collections
    .filter((collection) => collection.workspaceId === target.workspace.id)
    .reduce((maxPosition, collection) => Math.max(maxPosition, collection.position), -1);
  const collectionPuts = sourceCollections
    .filter((collection) => !mergeDefault || collection.id !== sourceDefault?.id)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
    .map((collection, index) => ({
      ...collection,
      workspaceId: target.workspace.id,
      position: maxTargetPosition + index + 1,
      isDefault: false,
      seq: 0,
    }));
  const rewriteBucket = (bookmarks: Bookmark[]): Bookmark[] => {
    if (!mergeDefault || !sourceDefault) {
      return [];
    }
    return bookmarks
      .filter((bookmark) => bookmark.collectionId === sourceDefault.id)
      .map((bookmark) => ({
        ...bookmark,
        collectionId: target.defaultCollection.id,
        seq: 0,
      }));
  };

  return {
    kind: "migrate",
    targetWorkspaceId: target.workspace.id,
    targetWorkspaceName: target.workspace.name,
    workspaceDeletes: [sourceWorkspace.id],
    collectionPuts,
    collectionDeletes: mergeDefault && sourceDefault ? [sourceDefault.id] : [],
    bookmarkPuts: {
      active: rewriteBucket(snapshot.activeBookmarks),
      archived: rewriteBucket(snapshot.archivedBookmarks),
      trashed: rewriteBucket(snapshot.trashedBookmarks),
    },
    groupPuts: snapshot.groups
      .filter((group) => group.workspaceId === sourceWorkspace.id)
      .map((group) => ({ ...group, workspaceId: target.workspace.id, seq: 0 })),
    activeWorkspaceId: target.workspace.id,
  };
}
