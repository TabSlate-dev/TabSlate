import type { PlanUsage } from "@/lib/api";
import type { Bookmark, Collection, Tag, Workspace } from "@/lib/types";
import type { SavedGroup } from "@/store/groups-store";

export interface QuotaUsageBreakdown {
  total: PlanUsage;
  trash: PlanUsage;
  inUse: PlanUsage;
}

const PLAN_USAGE_KEYS = [
  "workspaces",
  "collections",
  "bookmarks",
  "tags",
  "saved_groups",
] as const satisfies readonly (keyof PlanUsage)[];

export function createZeroPlanUsage(): PlanUsage {
  return {
    workspaces: 0,
    collections: 0,
    bookmarks: 0,
    tags: 0,
    saved_groups: 0,
  };
}

export function createQuotaBreakdown(
  total: PlanUsage,
  trash: PlanUsage,
): QuotaUsageBreakdown {
  const normalizedTotal = createZeroPlanUsage();
  const normalizedTrash = createZeroPlanUsage();
  const inUse = createZeroPlanUsage();

  for (const key of PLAN_USAGE_KEYS) {
    normalizedTotal[key] = Math.max(0, total[key]);
    normalizedTrash[key] = Math.min(
      normalizedTotal[key],
      Math.max(0, trash[key]),
    );
    inUse[key] = normalizedTotal[key] - normalizedTrash[key];
  }

  return { total: normalizedTotal, trash: normalizedTrash, inUse };
}

function isTerminalBookmark(bookmark: Bookmark): boolean {
  return "isTrashed" in bookmark && bookmark.isTrashed === 2;
}

export function calculateGuestQuotaUsage(input: {
  workspaces: readonly Workspace[];
  collections: readonly Collection[];
  bookmarks: readonly Bookmark[];
  archivedBookmarks: readonly Bookmark[];
  trashedBookmarks: readonly Bookmark[];
  groups: readonly SavedGroup[];
  tags: readonly Tag[];
}): QuotaUsageBreakdown {
  const retainedWorkspaceIds = new Set(
    input.workspaces
      .filter((workspace) => workspace.deletedAt !== undefined)
      .map((workspace) => workspace.id),
  );
  const trashedCollectionIds = new Set(
    input.collections
      .filter((collection) => (
        collection.deletedAt !== undefined ||
        retainedWorkspaceIds.has(collection.workspaceId)
      ))
      .map((collection) => collection.id),
  );
  const individuallyTrashedBookmarkIds = new Set(
    input.trashedBookmarks
      .filter((bookmark) => !isTerminalBookmark(bookmark))
      .map((bookmark) => bookmark.id),
  );
  const bookmarksById = new Map<string, Bookmark>();
  for (const bookmark of [
    ...input.bookmarks,
    ...input.archivedBookmarks,
    ...input.trashedBookmarks,
  ]) {
    if (!isTerminalBookmark(bookmark)) {
      bookmarksById.set(bookmark.id, bookmark);
    }
  }

  const total: PlanUsage = {
    workspaces: input.workspaces.length,
    collections: input.collections.length,
    bookmarks: bookmarksById.size,
    tags: input.tags.length,
    saved_groups: input.groups.length,
  };
  const trash: PlanUsage = {
    workspaces: retainedWorkspaceIds.size,
    collections: trashedCollectionIds.size,
    bookmarks: Array.from(bookmarksById.values()).filter((bookmark) => (
      individuallyTrashedBookmarkIds.has(bookmark.id) ||
      trashedCollectionIds.has(bookmark.collectionId)
    )).length,
    tags: 0,
    saved_groups: input.groups.filter((group) => (
      group.deletedAt !== undefined || retainedWorkspaceIds.has(group.workspaceId)
    )).length,
  };

  return createQuotaBreakdown(total, trash);
}
