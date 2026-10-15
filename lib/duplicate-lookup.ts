import type { Bookmark, Collection, Workspace } from "@/lib/types";
import { isActiveWorkspace } from "@/lib/workspace-visibility";
import { urlMatchKey, type UrlMatchTier } from "@/lib/url-match";

export interface BookmarkLibrary {
  bookmarks: readonly Bookmark[];
  collections: readonly Collection[];
  workspaces: readonly Workspace[];
}

export interface DuplicateMatch {
  bookmark: Bookmark;
  /** null for an uncategorized bookmark */
  collection: Collection | null;
  workspace: Workspace | null;
}

export interface DuplicateLookupOptions {
  /** Only consider this workspace's collections (uncategorized bookmarks always count). */
  workspaceId?: string;
}

/**
 * Finds active bookmarks with the same address. Bookmarks under an archived or
 * trashed collection, or a retained (deleted) workspace, are never matched:
 * normal UI must not expose them.
 */
export function findVisibleDuplicates(
  url: string,
  library: BookmarkLibrary,
  tier: UrlMatchTier,
  options: DuplicateLookupOptions = {},
): DuplicateMatch[] {
  const key = urlMatchKey(url, tier);
  const collectionsById = new Map(library.collections.map((collection) => [collection.id, collection]));
  const workspacesById = new Map(library.workspaces.map((workspace) => [workspace.id, workspace]));
  const matches: DuplicateMatch[] = [];

  for (const bookmark of library.bookmarks) {
    if (!bookmark.url || urlMatchKey(bookmark.url, tier) !== key) {
      continue;
    }
    if (bookmark.collectionId === "") {
      matches.push({ bookmark, collection: null, workspace: null });
      continue;
    }
    const collection = collectionsById.get(bookmark.collectionId);
    if (!collection || collection.deletedAt || collection.archivedAt) {
      continue;
    }
    if (options.workspaceId !== undefined && collection.workspaceId !== options.workspaceId) {
      continue;
    }
    const workspace = workspacesById.get(collection.workspaceId);
    if (!isActiveWorkspace(workspace)) {
      continue;
    }
    matches.push({ bookmark, collection, workspace });
  }
  return matches;
}
