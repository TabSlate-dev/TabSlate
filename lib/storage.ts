import type { Bookmark, Collection } from "@/lib/types";
import { generateId } from "@/lib/id";
import { idbGetAll, idbGet, idbPut } from "@/lib/idb";

export type BookmarkInput = {
  title: string;
  url: string;
  favicon: string;
  description?: string;
  collectionId: string;
  tags?: string[];
};

// ---------------------------------------------------------------------------
// Workspace data (read-only for popup)
// ---------------------------------------------------------------------------

interface WorkspaceStorageState {
  workspaces: Array<{ id: string; name: string; color: string; position: number }>;
  collections: Collection[];
  tags: Array<{ id: string; name: string; color: string }>;
  activeWorkspaceId: string;
}

export async function getWorkspaceState(): Promise<WorkspaceStorageState> {
  const [workspaces, collections, tags, activeWsKv] = await Promise.all([
    idbGetAll<{ id: string; name: string; color: string; position: number }>("workspaces"),
    idbGetAll<Collection>("collections"),
    idbGetAll<{ id: string; name: string; color: string }>("tags"),
    idbGet<{ key: string; value: string }>("kv", "activeWorkspaceId"),
  ]);
  return {
    workspaces,
    collections,
    tags,
    activeWorkspaceId: activeWsKv?.value ?? "",
  };
}

// ---------------------------------------------------------------------------
// Public storageService (used by popup)
// ---------------------------------------------------------------------------

export const storageService = {
  async addBookmark(input: BookmarkInput): Promise<Bookmark> {
    const newBookmark: Bookmark = {
      id: generateId(),
      title: input.title,
      url: input.url,
      favicon: input.favicon || "",
      description: input.description ?? "",
      collectionId: input.collectionId,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
      isFavorite: false,
      seq: 0,
    };
    await idbPut("bookmarks", newBookmark);
    return newBookmark;
  },
};
