import { create } from "zustand";
import type { Bookmark } from "@/lib/types";
import { generateId } from "@/lib/id";
import { idbGetAll, idbPut, idbDelete, idbBulkWrite, type BulkWriteOp } from "@/lib/idb";
import { syncEngine } from "@/lib/sync-engine";
import type { SyncPullResponse } from "@/lib/api";
import { usePlanStore, guardQuota } from "@/store/plan-store";
import { normalizeFavicon } from "@/lib/bookmark-utils";

export type { Bookmark };

type ViewMode = "grid" | "list";
type SortBy = "date-newest" | "date-oldest" | "alpha-az" | "alpha-za";
type FilterType = "all" | "favorites" | "with-tags" | "without-tags";

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------
function toServerBookmark(b: Bookmark, opts: { isArchived?: boolean; isTrashed?: number } = {}): object {
  return {
    id: b.id,
    collection_id: b.collectionId || null,
    title: b.title,
    url: b.url,
    favicon_url: b.favicon,
    description: b.description,
    is_favorite: b.isFavorite,
    is_archived: opts.isArchived ?? false,
    is_trashed: opts.isTrashed ?? 0,
    tag_ids: b.tags,
    position: 0,
    seq: b.seq,
    // Only send deleted_at for permanent deletes (isTrashed: 2).
    // For soft-trashed (1) we use deletedAt locally for grace-period expiry only
    // and must NOT send it to the server — the server reads deleted_at as a
    // permanent-deletion tombstone in mergeFromServer.
    deleted_at: opts.isTrashed === 2 ? (b.deletedAt ?? Date.now()) : null,
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
  reset: () => void;

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
  _bulkAddBookmarks: (bookmarks: Bookmark[]) => void;
  updateBookmark: (id: string, patch: Partial<Omit<Bookmark, "id" | "createdAt">>) => void;
  toggleFavorite: (bookmarkId: string) => void;
  archiveBookmark: (bookmarkId: string) => void;
  restoreFromArchive: (bookmarkId: string) => void;
  trashBookmark: (bookmarkId: string) => void;
  restoreFromTrash: (bookmarkId: string, collectionIdOverride?: string) => void;
  permanentlyDelete: (bookmarkId: string) => void;
  mergeFromServer: (resp: SyncPullResponse) => void;
  enqueueAllToSync: () => void;
  sweepUnsynced: () => void;
  archiveCollectionBookmarks: (collectionId: string) => void;
  trashCollectionBookmarks: (collectionId: string) => void;
  restoreCollectionBookmarks: (collectionId: string) => void;
  permanentlyDeleteCollectionBookmarks: (collectionId: string) => void;
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
        // One-time migration: data: favicon URLs from chrome.tabs.favIconUrl are large
        // base64 blobs. Replace with lightweight domain-derived URLs and persist to IDB
        // so future loads are already clean (no-op for already-normalized bookmarks).
        const migrate = (store: "bookmarks" | "archived-bookmarks" | "trashed-bookmarks") =>
          (b: Bookmark): Bookmark => {
            if (!b.favicon.startsWith("data:")) { return b; }
            const fixed = { ...b, favicon: normalizeFavicon(b.favicon, b.url) };
            idbPut(store, fixed);
            return fixed;
          };
        set({
          bookmarks: bookmarks.map(migrate("bookmarks")),
          archivedBookmarks: archivedBookmarks.map(migrate("archived-bookmarks")),
          trashedBookmarks: trashedBookmarks.map(migrate("trashed-bookmarks")),
          _hydrated: true,
        });
      },

      reset: () => {
        set({
          bookmarks: [],
          archivedBookmarks: [],
          trashedBookmarks: [],
          selectedCollection: "all",
          selectedTags: [],
          searchQuery: "",
          _hydrated: true,
        });
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

      addBookmark: (input) =>
        guardQuota("bookmark", get().bookmarks.length, { id: "", createdAt: "", isFavorite: false, ...input } as Bookmark, () => {
          const bookmark: Bookmark = {
            id: generateId(),
            createdAt: new Date().toISOString(),
            isFavorite: false,
            ...input,
            favicon: normalizeFavicon(input.favicon, input.url),
          };
          set((s) => ({ bookmarks: [bookmark, ...s.bookmarks] }));
          idbPut("bookmarks", bookmark);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
          usePlanStore.getState().incrementUsage("bookmark");
          return bookmark;
        }),

      addBookmarks: (newBookmarks) =>
        guardQuota("bookmark", get().bookmarks.length, undefined, () => {
          const normalized = newBookmarks.map((b) => ({ ...b, favicon: normalizeFavicon(b.favicon, b.url) }));
          set((s) => ({ bookmarks: [...normalized, ...s.bookmarks] }));
          for (const b of normalized) { idbPut("bookmarks", b); }
          if (normalized.length > 0) {
            syncEngine?.enqueue({ bookmarks: normalized.map((b) => toServerBookmark(b)) });
          }
          usePlanStore.getState().incrementUsage("bookmark", normalized.length);
        }),

      _bulkAddBookmarks: (newBookmarks) => {
        if (newBookmarks.length === 0) { return; }
        const normalized = newBookmarks.map((b) => ({ ...b, favicon: normalizeFavicon(b.favicon, b.url) }));
        set((s) => ({ bookmarks: [...normalized, ...s.bookmarks] }));
        for (const b of normalized) { idbPut("bookmarks", b); }
        syncEngine?.enqueue({ bookmarks: normalized.map(b => toServerBookmark(b)) });
      },

      updateBookmark: (id, patch) => {
        const s = get();
        const inActive = s.bookmarks.some((b) => b.id === id);
        const inArchived = !inActive && s.archivedBookmarks.some((b) => b.id === id);
        const inTrashed = !inActive && !inArchived && s.trashedBookmarks.some((b) => b.id === id);
        if (!inActive && !inArchived && !inTrashed) { return; }

        set((state) => ({
          ...(inActive && { bookmarks: state.bookmarks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }),
          ...(inArchived && { archivedBookmarks: state.archivedBookmarks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }),
          ...(inTrashed && { trashedBookmarks: state.trashedBookmarks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }),
        }));

        const after = get();
        if (inActive) {
          const b = after.bookmarks.find((x) => x.id === id);
          if (b) { idbPut("bookmarks", b); syncEngine?.enqueue({ bookmarks: [toServerBookmark(b)] }); }
        } else if (inArchived) {
          const ab = after.archivedBookmarks.find((x) => x.id === id);
          if (ab) { idbPut("archived-bookmarks", ab); syncEngine?.enqueue({ bookmarks: [toServerBookmark(ab, { isArchived: true })] }); }
        } else {
          const tb = after.trashedBookmarks.find((x) => x.id === id);
          if (tb) { idbPut("trashed-bookmarks", tb); syncEngine?.enqueue({ bookmarks: [toServerBookmark(tb, { isTrashed: 1 })] }); }
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
        if (!bookmark) { return; }
        const trashed = { ...bookmark, deletedAt: Date.now() };
        idbDelete("bookmarks", bookmarkId);
        idbPut("trashed-bookmarks", trashed);
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(trashed, { isTrashed: 1 })] });
        set((state) => ({
          bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
          trashedBookmarks: [...state.trashedBookmarks, trashed],
        }));
      },

      restoreFromTrash: (bookmarkId, collectionIdOverride) => {
        const bookmark = get().trashedBookmarks.find(b => b.id === bookmarkId);
        if (!bookmark) { return; }
        const restored = collectionIdOverride !== undefined
          ? { ...bookmark, collectionId: collectionIdOverride }
          : bookmark;
        idbDelete("trashed-bookmarks", bookmarkId);
        idbPut("bookmarks", restored);
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(restored)] });
        set((state) => ({
          trashedBookmarks: state.trashedBookmarks.filter(b => b.id !== bookmarkId),
          bookmarks: [...state.bookmarks, restored],
        }));
      },

      permanentlyDelete: (bookmarkId) => {
        const bookmark = get().trashedBookmarks.find(b => b.id === bookmarkId);
        if (bookmark) {
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isTrashed: 2 })] });
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
            ...trashedBookmarks.map(b => toServerBookmark(b, { isTrashed: 1 })),
          ],
        });
      },

      mergeFromServer: (resp) => {
        if (resp.entities.bookmarks.length === 0) return;

        const touchedIds = new Set(resp.entities.bookmarks.map((b) => b.id));

        // IDB cleanup for permanently deleted and soft-deleted records (fire-and-forget)
        for (const sb of resp.entities.bookmarks) {
          if (sb.is_trashed === 2 || sb.deleted_at) {
            idbDelete("bookmarks", sb.id);
            idbDelete("archived-bookmarks", sb.id);
            idbDelete("trashed-bookmarks", sb.id);
          }
        }

        set((state) => {
          // Build a Map of existing touched items for O(1) lookup (avoids O(n×m) find per item).
          const existingById = new Map<string, Bookmark>();
          for (const b of state.bookmarks) {
            if (touchedIds.has(b.id)) existingById.set(b.id, b);
          }
          for (const b of state.archivedBookmarks) {
            if (touchedIds.has(b.id)) existingById.set(b.id, b);
          }
          for (const b of state.trashedBookmarks) {
            if (touchedIds.has(b.id)) existingById.set(b.id, b);
          }

          // Classify incoming items into destination buckets
          const toActive: Bookmark[] = [];
          const toArchived: Bookmark[] = [];
          const toTrashed: Bookmark[] = [];

          for (const sb of resp.entities.bookmarks) {
            if (sb.is_trashed === 2 || sb.deleted_at) continue;
            const existing = existingById.get(sb.id);
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
              toTrashed.push(merged);
            } else if (sb.is_archived) {
              toArchived.push(merged);
            } else {
              toActive.push(merged);
            }
          }

          // Single filter pass per bucket (O(n) total) then append new items
          return {
            bookmarks: [
              ...state.bookmarks.filter((b) => !touchedIds.has(b.id)),
              ...toActive,
            ],
            archivedBookmarks: [
              ...state.archivedBookmarks.filter((b) => !touchedIds.has(b.id)),
              ...toArchived,
            ],
            trashedBookmarks: [
              ...state.trashedBookmarks.filter((b) => !touchedIds.has(b.id)),
              ...toTrashed,
            ],
          };
        });

        // IDB writes for updated items (fire-and-forget)
        const { bookmarks: cur, archivedBookmarks: curArchived, trashedBookmarks: curTrashed } = get();
        for (const b of cur) {
          if (touchedIds.has(b.id)) idbPut("bookmarks", b);
        }
        for (const b of curArchived) {
          if (touchedIds.has(b.id)) idbPut("archived-bookmarks", b);
        }
        for (const b of curTrashed) {
          if (touchedIds.has(b.id)) idbPut("trashed-bookmarks", b);
        }
      },

      sweepUnsynced: () => {
        const { bookmarks, archivedBookmarks, trashedBookmarks } = get();
        const unsynced = [
          ...bookmarks.filter(b => b.seq === 0).map(b => toServerBookmark(b)),
          ...archivedBookmarks.filter(b => b.seq === 0).map(b => toServerBookmark(b, { isArchived: true })),
          ...trashedBookmarks.filter(b => b.seq === 0).map(b => toServerBookmark(b, { isTrashed: 1 })),
        ];
        if (unsynced.length > 0) { syncEngine?.enqueue({ bookmarks: unsynced }); }
      },

      archiveCollectionBookmarks: (collectionId) => {
        const affected = get().bookmarks.filter((b) => b.collectionId === collectionId);
        if (affected.length === 0) { return; }
        const ops: BulkWriteOp[] = [
          ...affected.map((b) => ({ type: "delete" as const, store: "bookmarks" as const, key: b.id })),
          ...affected.map((b) => ({ type: "put" as const, store: "archived-bookmarks" as const, value: b })),
        ];
        void idbBulkWrite(ops);
        syncEngine?.enqueue({ bookmarks: affected.map((b) => toServerBookmark(b, { isArchived: true })) });
        set((s) => ({
          bookmarks: s.bookmarks.filter((b) => b.collectionId !== collectionId),
          archivedBookmarks: [...s.archivedBookmarks, ...affected],
        }));
      },

      trashCollectionBookmarks: (collectionId) => {
        const active = get().bookmarks.filter((b) => b.collectionId === collectionId);
        const archived = get().archivedBookmarks.filter((b) => b.collectionId === collectionId);
        const all = [...active, ...archived];
        if (all.length === 0) { return; }
        const now = Date.now();
        const trashed = all.map((b) => ({ ...b, deletedAt: now }));
        const ops: BulkWriteOp[] = [
          ...active.map((b) => ({ type: "delete" as const, store: "bookmarks" as const, key: b.id })),
          ...archived.map((b) => ({ type: "delete" as const, store: "archived-bookmarks" as const, key: b.id })),
          ...trashed.map((b) => ({ type: "put" as const, store: "trashed-bookmarks" as const, value: b })),
        ];
        void idbBulkWrite(ops);
        syncEngine?.enqueue({ bookmarks: trashed.map((b) => toServerBookmark(b, { isTrashed: 1 })) });
        set((s) => ({
          bookmarks: s.bookmarks.filter((b) => b.collectionId !== collectionId),
          archivedBookmarks: s.archivedBookmarks.filter((b) => b.collectionId !== collectionId),
          trashedBookmarks: [...s.trashedBookmarks, ...trashed],
        }));
        usePlanStore.getState().decrementUsage("bookmark", all.length);
      },

      restoreCollectionBookmarks: (collectionId) => {
        const fromArchive = get().archivedBookmarks.filter((b) => b.collectionId === collectionId);
        const fromTrash = get().trashedBookmarks.filter((b) => b.collectionId === collectionId);
        const all = [...fromArchive, ...fromTrash];
        if (all.length === 0) { return; }
        const ops: BulkWriteOp[] = [
          ...fromArchive.map((b) => ({ type: "delete" as const, store: "archived-bookmarks" as const, key: b.id })),
          ...fromTrash.map((b) => ({ type: "delete" as const, store: "trashed-bookmarks" as const, key: b.id })),
          ...all.map((b) => ({ type: "put" as const, store: "bookmarks" as const, value: b })),
        ];
        void idbBulkWrite(ops);
        syncEngine?.enqueue({ bookmarks: all.map((b) => toServerBookmark(b)) });
        set((s) => ({
          archivedBookmarks: s.archivedBookmarks.filter((b) => b.collectionId !== collectionId),
          trashedBookmarks: s.trashedBookmarks.filter((b) => b.collectionId !== collectionId),
          bookmarks: [...s.bookmarks, ...all],
        }));
      },

      permanentlyDeleteCollectionBookmarks: (collectionId) => {
        const trashed = get().trashedBookmarks.filter((b) => b.collectionId === collectionId);
        const archived = get().archivedBookmarks.filter((b) => b.collectionId === collectionId);
        const all = [...trashed, ...archived];
        if (all.length === 0) { return; }
        syncEngine?.enqueue({ bookmarks: all.map((b) => toServerBookmark(b, { isTrashed: 2 })) });
        const ops: BulkWriteOp[] = [
          ...trashed.map((b) => ({ type: "delete" as const, store: "trashed-bookmarks" as const, key: b.id })),
          ...archived.map((b) => ({ type: "delete" as const, store: "archived-bookmarks" as const, key: b.id })),
        ];
        void idbBulkWrite(ops);
        set((s) => ({
          trashedBookmarks: s.trashedBookmarks.filter((b) => b.collectionId !== collectionId),
          archivedBookmarks: s.archivedBookmarks.filter((b) => b.collectionId !== collectionId),
        }));
      },

      reassignCollection: (fromId, toId) => {
        const affected = get().bookmarks.filter(b => b.collectionId === fromId);
        if (affected.length === 0) { return; }
        const updated = affected.map(b => ({ ...b, collectionId: toId }));
        for (const b of updated) { idbPut("bookmarks", b); }
        syncEngine?.enqueue({ bookmarks: updated.map(b => toServerBookmark(b)) });
        set((s) => ({
          bookmarks: s.bookmarks.map(b => b.collectionId === fromId ? { ...b, collectionId: toId } : b),
        }));
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
