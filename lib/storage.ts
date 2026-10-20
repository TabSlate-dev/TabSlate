import type { Bookmark, Collection, Tag, Workspace } from "@/lib/types";
import { generateId } from "@/lib/id";
import { idbGetAll, idbGet, idbPut } from "@/lib/idb";
import { resolveActiveWorkspaceCollectionTarget } from "@/lib/workspace-visibility";
import { findVisibleDuplicates, type DuplicateMatch } from "@/lib/duplicate-lookup";

export interface BookmarkInput {
  title: string;
  url: string;
  favicon: string;
  description?: string;
  notes?: string;
  collectionId: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Workspace data (read-only for popup)
// ---------------------------------------------------------------------------

interface WorkspaceStorageState {
  workspaces: Workspace[];
  collections: Collection[];
  tags: Tag[];
  activeWorkspaceId: string;
}

export async function getWorkspaceState(): Promise<WorkspaceStorageState> {
  const [workspaces, collections, tags, activeWsKv] = await Promise.all([
    idbGetAll<Workspace>("workspaces"),
    idbGetAll<Collection>("collections"),
    idbGetAll<Tag>("tags"),
    idbGet<{ key: string; value: string }>("kv", "activeWorkspaceId"),
  ]);
  return {
    workspaces,
    collections,
    tags,
    activeWorkspaceId: activeWsKv?.value ?? "",
  };
}

/**
 * Saved bookmarks that look like the given page (loose tier), for the popup's
 * notice. A failed lookup reports no duplicates so saving still works.
 */
export async function findSavedDuplicates(url: string): Promise<DuplicateMatch[]> {
  try {
    const [bookmarks, state] = await Promise.all([idbGetAll<Bookmark>("bookmarks"), getWorkspaceState()]);
    return findVisibleDuplicates(
      url,
      { bookmarks, collections: state.collections, workspaces: state.workspaces },
      "loose",
    );
  } catch (err) {
    console.warn("[TabSlate] duplicate lookup failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public storageService (used by popup)
// ---------------------------------------------------------------------------

export const storageService = {
  async addBookmark(input: BookmarkInput): Promise<Bookmark> {
    const state = await getWorkspaceState();
    const target = resolveActiveWorkspaceCollectionTarget(
      input.collectionId,
      state.activeWorkspaceId,
      state.workspaces,
      state.collections,
    );
    if (!target) {
      throw new Error("active Workspace Collection target is unavailable");
    }
    const newBookmark: Bookmark = {
      id: generateId(),
      title: input.title,
      url: input.url,
      favicon: input.favicon || "",
      description: input.description ?? "",
      notes: input.notes ?? "",
      collectionId: target.id,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: Date.now(),
      isFavorite: false,
      seq: 0,
    };
    await idbPut("bookmarks", newBookmark);
    return newBookmark;
  },
  async addTag(name: string, color: string): Promise<import("@/lib/types").Tag> {
    const newTag = {
      id: generateId(),
      name,
      color,
      seq: 0,
    };
    await idbPut("tags", newTag);
    return newTag;
  },
};
