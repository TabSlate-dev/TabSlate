import { create } from "zustand";
import type { Bookmark } from "@/lib/types";
import { generateId } from "@/lib/id";
import { idbGetAll, idbPut, idbDelete } from "@/lib/idb";
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
    tag_ids: b.tags,
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
  // Data — persisted to IndexedDB
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
  hydrate: () => Promise<void>;

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
  enqueueAllToSync: () => void;
  sweepUnsynced: () => void;
  reassignCollection: (fromId: string, toId: string) => void;

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
      hydrate: async () => {
        const [bookmarks, archivedBookmarks, trashedBookmarks] = await Promise.all([
          idbGetAll<Bookmark>("bookmarks"),
          idbGetAll<Bookmark>("archived-bookmarks"),
          idbGetAll<Bookmark>("trashed-bookmarks"),
        ]);
        set({ bookmarks, archivedBookmarks, trashedBookmarks, _hydrated: true });
      },

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
        idbPut("bookmarks", bookmark);
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
        return bookmark;
      },

      addBookmarks: (newBookmarks) => {
        set((s) => ({ bookmarks: [...newBookmarks, ...s.bookmarks] }));
        for (const b of newBookmarks) { idbPut("bookmarks", b); }
        if (newBookmarks.length > 0) {
          syncEngine?.enqueue({ bookmarks: newBookmarks.map(b => toServerBookmark(b)) });
        }
      },

      updateBookmark: (id, patch) => {
        set((s) => ({
          bookmarks: s.bookmarks.map((b) =>
            b.id === id ? { ...b, ...patch } : b
          ),
        }));
        const updated = get().bookmarks.find(b => b.id === id);
        if (updated) {
          idbPut("bookmarks", updated);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated)] });
        }
      },

      toggleFavorite: (bookmarkId) => {
        set((state) => ({
          bookmarks: state.bookmarks.map((b) =>
            b.id === bookmarkId ? { ...b, isFavorite: !b.isFavorite } : b
          ),
        }));
        const updated = get().bookmarks.find(b => b.id === bookmarkId);
        if (updated) {
          idbPut("bookmarks", updated);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated)] });
        }
      },

      archiveBookmark: (bookmarkId) => {
        const bookmark = get().bookmarks.find((b) => b.id === bookmarkId);
        if (!bookmark) return;
        idbDelete("bookmarks", bookmarkId);
        idbPut("archived-bookmarks", bookmark);
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isArchived: true })] });
        set((state) => ({
          bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
          archivedBookmarks: [...state.archivedBookmarks, bookmark],
        }));
      },

      restoreFromArchive: (bookmarkId) => {
        const bookmark = get().archivedBookmarks.find(b => b.id === bookmarkId);
        if (!bookmark) { return; }
        idbDelete("archived-bookmarks", bookmarkId);
        idbPut("bookmarks", bookmark);
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
        set((state) => ({
          archivedBookmarks: state.archivedBookmarks.filter(b => b.id !== bookmarkId),
          bookmarks: [...state.bookmarks, bookmark],
        }));
      },

      trashBookmark: (bookmarkId) => {
        const bookmark = get().bookmarks.find((b) => b.id === bookmarkId);
        if (!bookmark) return;
        idbDelete("bookmarks", bookmarkId);
        idbPut("trashed-bookmarks", bookmark);
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isTrashed: true })] });
        set((state) => ({
          bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
          trashedBookmarks: [...state.trashedBookmarks, bookmark],
        }));
      },

      restoreFromTrash: (bookmarkId) => {
        const bookmark = get().trashedBookmarks.find(b => b.id === bookmarkId);
        if (!bookmark) { return; }
        idbDelete("trashed-bookmarks", bookmarkId);
        idbPut("bookmarks", bookmark);
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
        set((state) => ({
          trashedBookmarks: state.trashedBookmarks.filter(b => b.id !== bookmarkId),
          bookmarks: [...state.bookmarks, bookmark],
        }));
      },

      permanentlyDelete: (bookmarkId) => {
        const bookmark = get().trashedBookmarks.find(b => b.id === bookmarkId);
        if (bookmark) {
          syncEngine?.enqueue({ bookmarks: [toServerBookmark({ ...bookmark, deletedAt: Date.now() })] });
        }
        idbDelete("trashed-bookmarks", bookmarkId);
        set((state) => ({
          trashedBookmarks: state.trashedBookmarks.filter(b => b.id !== bookmarkId),
        }));
      },

      enqueueAllToSync: () => {
        const { bookmarks, archivedBookmarks, trashedBookmarks } = get();
        syncEngine?.enqueue({
          bookmarks: [
            ...bookmarks.map(b => toServerBookmark(b)),
            ...archivedBookmarks.map(b => toServerBookmark(b, { isArchived: true })),
            ...trashedBookmarks.map(b => toServerBookmark(b, { isTrashed: true })),
          ],
        });
      },

      mergeFromServer: (resp) => {
        if (resp.entities.bookmarks.length === 0) return;
        set((state) => {
          let bookmarks = [...state.bookmarks];
          let archivedBookmarks = [...state.archivedBookmarks];
          let trashedBookmarks = [...state.trashedBookmarks];

          for (const sb of resp.entities.bookmarks) {
            if (sb.deleted_at) {
              bookmarks = bookmarks.filter(b => b.id !== sb.id);
              archivedBookmarks = archivedBookmarks.filter(b => b.id !== sb.id);
              trashedBookmarks = trashedBookmarks.filter(b => b.id !== sb.id);
            } else {
              const existing =
                bookmarks.find(b => b.id === sb.id) ||
                archivedBookmarks.find(b => b.id === sb.id) ||
                trashedBookmarks.find(b => b.id === sb.id);

              bookmarks = bookmarks.filter(b => b.id !== sb.id);
              archivedBookmarks = archivedBookmarks.filter(b => b.id !== sb.id);
              trashedBookmarks = trashedBookmarks.filter(b => b.id !== sb.id);

              const merged: Bookmark = {
                id: sb.id,
                title: sb.title,
                url: sb.url,
                description: sb.description ?? existing?.description ?? "",
                favicon: sb.favicon_url ?? existing?.favicon ?? "",
                collectionId: sb.collection_id ?? existing?.collectionId ?? "",
                tags: sb.tag_ids ?? existing?.tags ?? [],
                createdAt: existing?.createdAt ?? String(sb.created_at),
                isFavorite: sb.is_favorite,
                seq: sb.seq,
              };

              if (sb.is_trashed) {
                trashedBookmarks.push(merged);
              } else if (sb.is_archived) {
                archivedBookmarks.push(merged);
              } else {
                bookmarks.push(merged);
              }
            }
          }

          return { bookmarks, archivedBookmarks, trashedBookmarks };
        });
        // Sync IDB after Zustand state update (fire-and-forget)
        const { bookmarks, archivedBookmarks, trashedBookmarks } = get();
        for (const b of bookmarks) { idbPut("bookmarks", b); }
        for (const b of archivedBookmarks) { idbPut("archived-bookmarks", b); }
        for (const b of trashedBookmarks) { idbPut("trashed-bookmarks", b); }
        for (const sb of resp.entities.bookmarks) {
          if (sb.deleted_at) {
            idbDelete("bookmarks", sb.id);
            idbDelete("archived-bookmarks", sb.id);
            idbDelete("trashed-bookmarks", sb.id);
          }
        }
      },

      sweepUnsynced: () => {
        const { bookmarks, archivedBookmarks, trashedBookmarks } = get();
        const unsynced = [
          ...bookmarks.filter(b => b.seq === 0).map(b => toServerBookmark(b)),
          ...archivedBookmarks.filter(b => b.seq === 0).map(b => toServerBookmark(b, { isArchived: true })),
          ...trashedBookmarks.filter(b => b.seq === 0).map(b => toServerBookmark(b, { isTrashed: true })),
        ];
        if (unsynced.length > 0) { syncEngine?.enqueue({ bookmarks: unsynced }); }
      },

      reassignCollection: (fromId, toId) => {
        const affected = get().bookmarks.filter(b => b.collectionId === fromId);
        if (affected.length > 0) {
          const updated = affected.map(b => ({ ...b, collectionId: toId }));
          for (const b of updated) { idbPut("bookmarks", b); }
          syncEngine?.enqueue({ bookmarks: updated.map(b => toServerBookmark(b)) });
          set((s) => ({
            bookmarks: s.bookmarks.map(b => b.collectionId === fromId ? { ...b, collectionId: toId } : b),
          }));
        }
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
    })
);
