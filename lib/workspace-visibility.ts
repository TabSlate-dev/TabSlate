import type { Collection, Workspace } from "@/lib/types";
import { compareActiveCollections } from "@/lib/collection-utils";

export function isActiveWorkspace(
  workspace: Workspace | undefined,
): workspace is Workspace {
  return workspace !== undefined && workspace.deletedAt === undefined;
}

export function getCollectionsUnderActiveWorkspace(
  activeWorkspaceId: string,
  workspaces: readonly Workspace[],
  collections: readonly Collection[],
): Collection[] {
  const activeWorkspace = workspaces.find(
    (workspace) => workspace.id === activeWorkspaceId,
  );
  if (!isActiveWorkspace(activeWorkspace)) {
    return [];
  }
  return collections.filter(
    (collection) => collection.workspaceId === activeWorkspaceId,
  );
}

export function getActiveWorkspaceCollectionIds(
  activeWorkspaceId: string,
  workspaces: readonly Workspace[],
  collections: readonly Collection[],
): Set<string> {
  return new Set(getActiveWorkspaceCollections(
    activeWorkspaceId,
    workspaces,
    collections,
  ).map((collection) => collection.id));
}

export function getActiveWorkspaceCollections(
  activeWorkspaceId: string,
  workspaces: readonly Workspace[],
  collections: readonly Collection[],
): Collection[] {
  return getCollectionsUnderActiveWorkspace(activeWorkspaceId, workspaces, collections)
    .filter((collection) => !collection.deletedAt && !collection.archivedAt)
    .sort(compareActiveCollections);
}

export function belongsToActiveWorkspace(
  collectionId: string,
  activeCollectionIds: ReadonlySet<string>,
): boolean {
  return activeCollectionIds.has(collectionId);
}

export function resolveActiveWorkspaceCollectionTarget(
  collectionId: string,
  activeWorkspaceId: string,
  workspaces: readonly Workspace[],
  collections: readonly Collection[],
): Collection | undefined {
  const activeCollectionIds = getActiveWorkspaceCollectionIds(
    activeWorkspaceId,
    workspaces,
    collections,
  );
  if (!belongsToActiveWorkspace(collectionId, activeCollectionIds)) {
    return undefined;
  }
  return collections.find((collection) => collection.id === collectionId);
}
