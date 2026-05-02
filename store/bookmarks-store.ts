import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Bookmark } from "@/lib/types";
import { generateId } from "@/lib/id";
import { chromeStorageAdapter } from "@/lib/chrome-storage-adapter";
import { syncEngine } from "@/lib/sync-engine";
import type { SyncPullResponse } from "@/lib/api";

export type { Bookmark };

type ViewMode = "grid" | "list";
type SortBy = "date-newest" | "date-oldest" | "alpha-az" | "alpha-za";
type FilterType = "all" | "favorites" | "with-tags" | "without-tags";

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------
function toServerBookmark(b: Bookmark, opts: { isArchived?: boolean; isTrashed?: boolean } = {}): object {
  return {
    id: b.id,
    collection_id: b.collectionId || null,
    title: b.title,
    url: b.url,
    favicon_url: b.favicon,
    description: b.description,
    is_favorite: b.isFavorite,
    is_archived: opts.isArchived ?? false,
    is_trashed: opts.isTrashed ?? false,
    position: 0,
    seq: b.seq,
    deleted_at: b.deletedAt ?? null,
    updated_at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Local helpers (module-private)
// ---------------------------------------------------------------------------

function applySearch(bookmarks: Bookmark[], query: string): Bookmark[] {
  if (!query) return bookmarks;
  const lower = query.toLowerCase();
  return bookmarks.filter(
    (b) =>
      b.title.toLowerCase().includes(lower) ||
      b.description.toLowerCase().includes(lower) ||
      b.url.toLowerCase().includes(lower)
  );
}

function applySort(bookmarks: Bookmark[], sortBy: SortBy): Bookmark[] {
  const arr = [...bookmarks];
  switch (sortBy) {
    case "date-newest":
      return arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    case "date-oldest":
      return arr.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    case "alpha-az":
      return arr.sort((a, b) => a.title.localeCompare(b.title));
    case "alpha-za":
      return arr.sort((a, b) => b.title.localeCompare(a.title));
    default:
      return arr;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface BookmarksState {
  // Data — persisted to chrome.storage.local
  bookmarks: Bookmark[];
  archivedBookmarks: Bookmark[];
  trashedBookmarks: Bookmark[];

  // UI state — ephemeral (reset on each session)
  selectedCollection: string;
  selectedTags: string[];
  searchQuery: string;
  viewMode: ViewMode;
  sortBy: SortBy;
  filterType: FilterType;

  // Hydration flag
  _hydrated: boolean;
  setHydrated: () => void;

  // Actions
  setSelectedCollection: (collectionId: string) => void;
  toggleTag: (tagId: string) => void;
  clearTags: () => void;
  setSearchQuery: (query: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setSortBy: (sort: SortBy) => void;
  setFilterType: (filter: FilterType) => void;

  addBookmark: (input: Omit<Bookmark, "id" | "createdAt" | "isFavorite">) => Bookmark;
  addBookmarks: (bookmarks: Bookmark[]) => void;
  updateBookmark: (id: string, patch: Partial<Omit<Bookmark, "id" | "createdAt">>) => void;
  toggleFavorite: (bookmarkId: string) => void;
  archiveBookmark: (bookmarkId: string) => void;
  restoreFromArchive: (bookmarkId: string) => void;
  trashBookmark: (bookmarkId: string) => void;
  restoreFromTrash: (bookmarkId: string) => void;
  permanentlyDelete: (bookmarkId: string) => void;
  mergeFromServer: (resp: SyncPullResponse) => void;

  // Computed
  getFilteredBookmarks: (workspaceCollectionIds: Set<string>) => Bookmark[];
  getFavoriteBookmarks: () => Bookmark[];
  getArchivedBookmarks: () => Bookmark[];
  getTrashedBookmarks: () => Bookmark[];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export const useBookmarksStore = create<BookmarksState>()(
  persist(
    (set, get) => ({
      bookmarks: [],
      archivedBookmarks: [],
      trashedBookmarks: [],

      selectedCollection: "all",
      selectedTags: [],
      searchQuery: "",
      viewMode: "grid",
      sortBy: "date-newest",
      filterType: "all",

      _hydrated: false,
      setHydrated: () => set({ _hydrated: true }),

      setSelectedCollection: (collectionId) =>
        set({ selectedCollection: collectionId }),

      toggleTag: (tagId) =>
        set((state) => ({
          selectedTags: state.selectedTags.includes(tagId)
            ? state.selectedTags.filter((t) => t !== tagId)
            : [...state.selectedTags, tagId],
        })),

      clearTags: () => set({ selectedTags: [] }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setViewMode: (mode) => set({ viewMode: mode }),
      setSortBy: (sort) => set({ sortBy: sort }),
      setFilterType: (filter) => set({ filterType: filter }),

      addBookmark: (input) => {
        const bookmark: Bookmark = {
          id: generateId(),
          createdAt: new Date().toISOString(),
          isFavorite: false,
          ...input,
        };
        set((s) => ({ bookmarks: [bookmark, ...s.bookmarks] }));
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
        return bookmark;
      },

      addBookmarks: (newBookmarks) => {
        set((s) => ({ bookmarks: [...newBookmarks, ...s.bookmarks] }));
      },

      updateBookmark: (id, patch) => {
        set((s) => ({
          bookmarks: s.bookmarks.map((b) =>
            b.id === id ? { ...b, ...patch } : b
          ),
        }));
        const updated = get().bookmarks.find(b => b.id === id);
        if (updated) { syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated)] }); }
      },

      toggleFavorite: (bookmarkId) => {
        set((state) => ({
          bookmarks: state.bookmarks.map((b) =>
            b.id === bookmarkId ? { ...b, isFavorite: !b.isFavorite } : b
          ),
        }));
        const updated = get().bookmarks.find(b => b.id === bookmarkId);
        if (updated) { syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated)] }); }
      },

      archiveBookmark: (bookmarkId) => {
        const bookmark = get().bookmarks.find((b) => b.id === bookmarkId);
        if (!bookmark) return;
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isArchived: true })] });
        set((state) => ({
          bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
          archivedBookmarks: [...state.archivedBookmarks, bookmark],
        }));
      },

      restoreFromArchive: (bookmarkId) =>
        set((state) => {
          const bookmark = state.archivedBookmarks.find(
            (b) => b.id === bookmarkId
          );
          if (!bookmark) return state;
          return {
            archivedBookmarks: state.archivedBookmarks.filter(
              (b) => b.id !== bookmarkId
            ),
            bookmarks: [...state.bookmarks, bookmark],
          };
        }),

      trashBookmark: (bookmarkId) => {
        const bookmark = get().bookmarks.find((b) => b.id === bookmarkId);
        if (!bookmark) return;
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isTrashed: true })] });
        set((state) => ({
          bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
          trashedBookmarks: [...state.trashedBookmarks, bookmark],
        }));
      },

      restoreFromTrash: (bookmarkId) =>
        set((state) => {
          const bookmark = state.trashedBookmarks.find(
            (b) => b.id === bookmarkId
          );
          if (!bookmark) return state;
          return {
            trashedBookmarks: state.trashedBookmarks.filter(
              (b) => b.id !== bookmarkId
            ),
            bookmarks: [...state.bookmarks, bookmark],
          };
        }),

      permanentlyDelete: (bookmarkId) => {
        const bookmark = get().trashedBookmarks.find(b => b.id === bookmarkId);
        if (bookmark) { syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isTrashed: true })] }); }
        set((state) => ({
          trashedBookmarks: state.trashedBookmarks.filter(
            (b) => b.id !== bookmarkId
          ),
        }));
      },

      mergeFromServer: (resp) => {
        set((state) => {
          let bookmarks = [...state.bookmarks];

          for (const sb of resp.entities.bookmarks) {
            if (sb.deleted_at) {
              bookmarks = bookmarks.filter(b => b.id !== sb.id);
            } else {
              const idx = bookmarks.findIndex(b => b.id === sb.id);
              if (idx === -1) {
                bookmarks.push({
                  id: sb.id, title: sb.title, url: sb.url,
                  description: sb.description ?? "", favicon: sb.favicon_url ?? "",
                  collectionId: sb.collection_id ?? "", tags: [],
                  createdAt: String(sb.created_at), isFavorite: sb.is_favorite,
                  seq: sb.seq,
                });
              } else {
                bookmarks[idx] = {
                  ...bookmarks[idx],
                  title: sb.title, url: sb.url, isFavorite: sb.is_favorite,
                  collectionId: sb.collection_id ?? bookmarks[idx].collectionId,
                  seq: sb.seq,
                };
              }
            }
          }

          return { bookmarks };
        });
      },

      // workspaceCollectionIds: Set of collection IDs in the active workspace
      // (pass from caller to avoid circular import with workspace-store)
      getFilteredBookmarks: (workspaceCollectionIds) => {
        const state = get();
        let filtered = state.bookmarks.filter(
          (b) =>
            b.collectionId === "" ||
            workspaceCollectionIds.has(b.collectionId)
        );

        if (state.selectedCollection !== "all") {
          filtered = filtered.filter(
            (b) => b.collectionId === state.selectedCollection
          );
        }

        if (state.selectedTags.length > 0) {
          filtered = filtered.filter((b) =>
            state.selectedTags.some((tag) => b.tags.includes(tag))
          );
        }

        switch (state.filterType) {
          case "favorites":
            filtered = filtered.filter((b) => b.isFavorite);
            break;
          case "with-tags":
            filtered = filtered.filter((b) => b.tags.length > 0);
            break;
          case "without-tags":
            filtered = filtered.filter((b) => b.tags.length === 0);
            break;
        }

        return applySort(applySearch(filtered, state.searchQuery), state.sortBy);
      },

      getFavoriteBookmarks: () => {
        const state = get();
        const filtered = state.bookmarks.filter((b) => b.isFavorite);
        return applySort(applySearch(filtered, state.searchQuery), state.sortBy);
      },

      getArchivedBookmarks: () => {
        const state = get();
        return applySearch([...state.archivedBookmarks], state.searchQuery);
      },

      getTrashedBookmarks: () => {
        const state = get();
        return applySearch([...state.trashedBookmarks], state.searchQuery);
      },
    }),
    {
      name: "tabslate-bookmarks",
      storage: createJSONStorage(() => chromeStorageAdapter),
      partialize: (state) =>
        ({
          bookmarks: state.bookmarks,
          archivedBookmarks: state.archivedBookmarks,
          trashedBookmarks: state.trashedBookmarks,
        } as BookmarksState),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setHydrated();
        }
      },
    }
  )
);

// ---------------------------------------------------------------------------
// Listen for external changes (e.g. popup saved a bookmark)
// ---------------------------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes["tabslate-bookmarks"]) { return; }
  const newValue = changes["tabslate-bookmarks"].newValue;
  if (!newValue) { return; }
  try {
    const parsed = typeof newValue === "string" ? JSON.parse(newValue) : newValue;
    const data = parsed?.state;
    if (data) {
      const current = useBookmarksStore.getState();
      const needsUpdate =
        JSON.stringify(data.bookmarks) !== JSON.stringify(current.bookmarks) ||
        JSON.stringify(data.archivedBookmarks) !== JSON.stringify(current.archivedBookmarks) ||
        JSON.stringify(data.trashedBookmarks) !== JSON.stringify(current.trashedBookmarks);

      if (needsUpdate) {
        useBookmarksStore.setState({
          bookmarks: data.bookmarks ?? [],
          archivedBookmarks: data.archivedBookmarks ?? [],
          trashedBookmarks: data.trashedBookmarks ?? [],
        });
      }
    }
  } catch {
    // ignore malformed data
  }
});
