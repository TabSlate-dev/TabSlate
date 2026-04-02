/**
 * Chrome storage helpers — used by the popup to read/write bookmark data
 * in the same format as the Zustand persist middleware used by the newtab.
 *
 * Key layout in chrome.storage.local:
 *   "tabslate-bookmarks"  → Zustand JSON { state: { bookmarks, archivedBookmarks, trashedBookmarks } }
 *   "tabslate-workspace"  → Zustand JSON { state: { workspaces, collections, tags, activeWorkspaceId } }
 */

import type { Bookmark, Collection } from "@/lib/types";
import { generateId } from "@/lib/id";

export type BookmarkInput = {
  title: string;
  url: string;
  favicon: string;
  description?: string;
  collectionId: string;
  tags?: string[];
};

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

async function getRaw(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      resolve(key in result ? (result[key] as string) : null);
    });
  });
}

async function setRaw(key: string, value: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

function parseState<T>(raw: string | null, fallback: T): T {
  if (!raw) { return fallback; }
  try {
    const parsed = JSON.parse(raw);
    return (parsed?.state as T) ?? fallback;
  } catch {
    return fallback;
  }
}

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
  const raw = await getRaw("tabslate-workspace");
  return parseState<WorkspaceStorageState>(raw, {
    workspaces: [],
    collections: [],
    tags: [],
    activeWorkspaceId: "",
  });
}

// ---------------------------------------------------------------------------
// Bookmark data
// ---------------------------------------------------------------------------

interface BookmarkStorageState {
  bookmarks: Bookmark[];
  archivedBookmarks: Bookmark[];
  trashedBookmarks: Bookmark[];
}

async function getBookmarkState(): Promise<BookmarkStorageState> {
  const raw = await getRaw("tabslate-bookmarks");
  return parseState<BookmarkStorageState>(raw, {
    bookmarks: [],
    archivedBookmarks: [],
    trashedBookmarks: [],
  });
}

async function setBookmarkState(state: BookmarkStorageState): Promise<void> {
  // Wrap in Zustand persist format so the newtab onChanged listener picks it up
  const payload = JSON.stringify({ state, version: 0 });
  await setRaw("tabslate-bookmarks", payload);
}

// ---------------------------------------------------------------------------
// Public storageService (used by popup)
// ---------------------------------------------------------------------------

export const storageService = {
  async addBookmark(input: BookmarkInput): Promise<Bookmark> {
    const state = await getBookmarkState();
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
    };
    await setBookmarkState({
      ...state,
      bookmarks: [newBookmark, ...state.bookmarks],
    });
    return newBookmark;
  },
};
