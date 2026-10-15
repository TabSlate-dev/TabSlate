import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { isActiveWorkspace } from "@/lib/workspace-visibility";

/**
 * Shows one bookmark in the main list: switches to its workspace and
 * collection, clears the tag, filter and search state that could hide it, and
 * flashes it. Returns false for an unknown bookmark or one the normal list
 * never shows (archived or trashed collection, retained workspace).
 */
export function revealBookmark(bookmarkId: string): boolean {
  const bookmarks = useBookmarksStore.getState();
  const bookmark = bookmarks.bookmarks.get(bookmarkId);
  if (!bookmark) {
    return false;
  }

  let targetCollection = "all";
  if (bookmark.collectionId !== "") {
    const workspaceState = useWorkspaceStore.getState();
    const collection = workspaceState.collections.find((candidate) => candidate.id === bookmark.collectionId);
    if (!collection || collection.deletedAt || collection.archivedAt) {
      return false;
    }
    const workspace = workspaceState.workspaces.find((candidate) => candidate.id === collection.workspaceId);
    if (!isActiveWorkspace(workspace)) {
      return false;
    }
    if (workspaceState.activeWorkspaceId !== workspace.id) {
      workspaceState.setActiveWorkspaceId(workspace.id);
    }
    targetCollection = collection.id;
  }

  bookmarks.setSelectedCollection(targetCollection);
  bookmarks.clearTags();
  bookmarks.setFilterType("all");
  bookmarks.setSearchQuery("");
  bookmarks.setHighlightedBookmarkId(bookmark.id);
  return true;
}
