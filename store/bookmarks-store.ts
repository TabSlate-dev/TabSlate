import { create } from "zustand";
import type { Bookmark } from "@/lib/types";
import { generateId } from "@/lib/id";
import { idbGet, idbGetAll, idbGetByIndex, idbPut, idbDelete, idbBulkWrite, type BulkWriteOp } from "@/lib/idb";
import { syncEngine } from "@/lib/sync-engine";
import type { SyncPullResponse } from "@/lib/api";
import { usePlanStore, guardQuota } from "@/store/plan-store";
import { normalizeFavicon } from "@/lib/bookmark-utils";

export type { Bookmark };

type ViewMode = "grid" | "list";
type SortBy = "date-newest" | "date-oldest" | "alpha-az" | "alpha-za";
type FilterType = "all" | "favorites" | "with-tags" | "without-tags";
type BookmarkStoreName = "bookmarks" | "archived-bookmarks" | "trashed-bookmarks";

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

function migrateBookmarkForStore(store: BookmarkStoreName, bookmark: Bookmark): Bookmark {
  if (!bookmark.favicon.startsWith("data:")) {
    return bookmark;
  }
  const fixed = { ...bookmark, favicon: normalizeFavicon(bookmark.favicon, bookmark.url) };
  void idbPut(store, fixed);
  return fixed;
}

async function readBookmarkStore(store: BookmarkStoreName): Promise<Bookmark[]> {
  const bookmarks = await idbGetAll<Bookmark>(store);
  return bookmarks.map((bookmark) => migrateBookmarkForStore(store, bookmark));
}

async function readArchivedBookmarksForCollection(collectionId: string): Promise<Bookmark[]> {
  const bookmarks = await idbGetByIndex<Bookmark>("archived-bookmarks", "collectionId", collectionId);
  return bookmarks.map((bookmark) => migrateBookmarkForStore("archived-bookmarks", bookmark));
}

async function readBookmarkById(store: BookmarkStoreName, id: string): Promise<Bookmark | undefined> {
  const bookmark = await idbGet<Bookmark>(store, id);
  if (!bookmark) {
    return undefined;
  }
  return migrateBookmarkForStore(store, bookmark);
}

async function readTrashedBookmarksForCollection(collectionId: string): Promise<Bookmark[]> {
  const bookmarks = await idbGetAll<Bookmark>("trashed-bookmarks");
  return bookmarks
    .filter((bookmark) => bookmark.collectionId === collectionId)
    .map((bookmark) => migrateBookmarkForStore("trashed-bookmarks", bookmark));
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
  _archivedLoaded: boolean;
  _trashedLoaded: boolean;
  hydrate: () => Promise<void>;
  reloadActive: () => Promise<void>;
  loadArchivedBookmarks: () => Promise<void>;
  loadTrashedBookmarks: () => Promise<void>;
  pruneExpiredTrash: (graceDays: number) => void;
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
  mergeFromServer: (resp: SyncPullResponse) => Promise<void>;
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
      _archivedLoaded: false,
      _trashedLoaded: false,
      hydrate: async () => {
        const bookmarks = await readBookmarkStore("bookmarks");
        set({
          bookmarks,
          _hydrated: true,
        });
      },

      reloadActive: async () => {
        const bookmarks = await readBookmarkStore("bookmarks");
        set({ bookmarks });
      },

      loadArchivedBookmarks: async () => {
        if (get()._archivedLoaded) { return; }
        const archived = await readBookmarkStore("archived-bookmarks");
        set({ archivedBookmarks: archived, _archivedLoaded: true });
      },

      loadTrashedBookmarks: async () => {
        if (get()._trashedLoaded) { return; }
        const all = await readBookmarkStore("trashed-bookmarks");

        const graceDays = usePlanStore.getState().limits?.trash_grace_days ?? 30;
        const cutoff = Date.now() - graceDays * 86_400_000;
        const fresh = all.filter(b => !b.deletedAt || b.deletedAt > cutoff);
        const expired = all.filter(b => !!b.deletedAt && b.deletedAt <= cutoff);

        // Only purge if the sync engine is live — deleting from IDB without
        // enqueuing the isTrashed:2 tombstone would let the server push items back.
        if (syncEngine && expired.length > 0) {
          for (const b of expired) {
            void idbDelete("trashed-bookmarks", b.id);
            syncEngine.enqueue({ bookmarks: [toServerBookmark(b, { isTrashed: 2 })] });
          }
        }

        set({ trashedBookmarks: fresh, _trashedLoaded: true });
      },

      pruneExpiredTrash: (graceDays: number) => {
        if (!syncEngine) { return; }
        const cutoff = Date.now() - graceDays * 86_400_000;
        const { trashedBookmarks } = get();
        const expired = trashedBookmarks.filter(b => !!b.deletedAt && b.deletedAt <= cutoff);
        if (expired.length === 0) { return; }
        for (const b of expired) {
          void idbDelete("trashed-bookmarks", b.id);
          syncEngine.enqueue({ bookmarks: [toServerBookmark(b, { isTrashed: 2 })] });
        }
        set(s => ({
          trashedBookmarks: s.trashedBookmarks.filter(
            b => !b.deletedAt || b.deletedAt > cutoff,
          ),
        }));
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
          _archivedLoaded: false,
          _trashedLoaded: false,
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

      addBookmark: (input) => {
        const fallback: Bookmark = { id: "", createdAt: "", isFavorite: false, ...input };
        return guardQuota("bookmark", get().bookmarks.length, fallback, () => {
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
        });
      },

      addBookmarks: (newBookmarks) =>
        guardQuota("bookmark", get().bookmarks.length + newBookmarks.length - 1, undefined, () => {
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
        const state = get();
        const activeBookmark = state.bookmarks.find((bookmark) => bookmark.id === id);
        if (activeBookmark) {
          const updated = { ...activeBookmark, ...patch };
          set((current) => ({
            bookmarks: current.bookmarks.map((bookmark) => (bookmark.id === id ? updated : bookmark)),
          }));
          idbPut("bookmarks", updated);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated)] });
          return;
        }

        const archivedBookmark = state._archivedLoaded
          ? state.archivedBookmarks.find((bookmark) => bookmark.id === id)
          : undefined;
        if (archivedBookmark) {
          const updated = { ...archivedBookmark, ...patch };
          set((current) => ({
            archivedBookmarks: current.archivedBookmarks.map((bookmark) => (bookmark.id === id ? updated : bookmark)),
          }));
          idbPut("archived-bookmarks", updated);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated, { isArchived: true })] });
          return;
        }

        const trashedBookmark = state._trashedLoaded
          ? state.trashedBookmarks.find((bookmark) => bookmark.id === id)
          : undefined;
        if (trashedBookmark) {
          const updated = { ...trashedBookmark, ...patch };
          set((current) => ({
            trashedBookmarks: current.trashedBookmarks.map((bookmark) => (bookmark.id === id ? updated : bookmark)),
          }));
          idbPut("trashed-bookmarks", updated);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated, { isTrashed: 1 })] });
          return;
        }

        void (async () => {
          const archived = state._archivedLoaded ? undefined : await readBookmarkById("archived-bookmarks", id);
          if (archived) {
            const updated = { ...archived, ...patch };
            await idbPut("archived-bookmarks", updated);
            syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated, { isArchived: true })] });
            set((current) => ({
              archivedBookmarks: current._archivedLoaded
                ? current.archivedBookmarks.map((bookmark) => (bookmark.id === id ? updated : bookmark))
                : current.archivedBookmarks,
            }));
            return;
          }

          const trashed = state._trashedLoaded ? undefined : await readBookmarkById("trashed-bookmarks", id);
          if (!trashed) {
            return;
          }
          const updated = { ...trashed, ...patch };
          await idbPut("trashed-bookmarks", updated);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated, { isTrashed: 1 })] });
          set((current) => ({
            trashedBookmarks: current._trashedLoaded
              ? current.trashedBookmarks.map((bookmark) => (bookmark.id === id ? updated : bookmark))
              : current.trashedBookmarks,
          }));
        })();
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
        if (!bookmark) { return; }
        idbDelete("bookmarks", bookmarkId);
        idbPut("archived-bookmarks", bookmark);
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isArchived: true })] });
        set((state) => ({
          bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
          archivedBookmarks: state._archivedLoaded ? [...state.archivedBookmarks, bookmark] : state.archivedBookmarks,
        }));
      },

      restoreFromArchive: (bookmarkId) => {
        const state = get();
        const bookmark = state._archivedLoaded
          ? state.archivedBookmarks.find((candidate) => candidate.id === bookmarkId)
          : undefined;
        if (bookmark) {
          idbDelete("archived-bookmarks", bookmarkId);
          idbPut("bookmarks", bookmark);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
          set((current) => ({
            archivedBookmarks: current.archivedBookmarks.filter((candidate) => candidate.id !== bookmarkId),
            bookmarks: [...current.bookmarks, bookmark],
          }));
          return;
        }

        void (async () => {
          const archived = state._archivedLoaded ? undefined : await readBookmarkById("archived-bookmarks", bookmarkId);
          if (!archived) {
            return;
          }
          await idbDelete("archived-bookmarks", bookmarkId);
          await idbPut("bookmarks", archived);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(archived)] });
          set((current) => ({
            archivedBookmarks: current._archivedLoaded
              ? current.archivedBookmarks.filter((candidate) => candidate.id !== bookmarkId)
              : current.archivedBookmarks,
            bookmarks: [...current.bookmarks, archived],
          }));
        })();
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
          trashedBookmarks: state._trashedLoaded ? [...state.trashedBookmarks, trashed] : state.trashedBookmarks,
        }));
      },

      restoreFromTrash: (bookmarkId, collectionIdOverride) => {
        const state = get();
        const bookmark = state._trashedLoaded
          ? state.trashedBookmarks.find((candidate) => candidate.id === bookmarkId)
          : undefined;
        if (bookmark) {
          const restored = collectionIdOverride !== undefined
            ? { ...bookmark, collectionId: collectionIdOverride, deletedAt: undefined }
            : { ...bookmark, deletedAt: undefined };
          idbDelete("trashed-bookmarks", bookmarkId);
          idbPut("bookmarks", restored);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(restored)] });
          set((current) => ({
            trashedBookmarks: current.trashedBookmarks.filter((candidate) => candidate.id !== bookmarkId),
            bookmarks: [...current.bookmarks, restored],
          }));
          return;
        }

        void (async () => {
          const trashed = state._trashedLoaded ? undefined : await readBookmarkById("trashed-bookmarks", bookmarkId);
          if (!trashed) {
            return;
          }
          const restored = collectionIdOverride !== undefined
            ? { ...trashed, collectionId: collectionIdOverride, deletedAt: undefined }
            : { ...trashed, deletedAt: undefined };
          await idbDelete("trashed-bookmarks", bookmarkId);
          await idbPut("bookmarks", restored);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(restored)] });
          set((current) => ({
            trashedBookmarks: current._trashedLoaded
              ? current.trashedBookmarks.filter((candidate) => candidate.id !== bookmarkId)
              : current.trashedBookmarks,
            bookmarks: [...current.bookmarks, restored],
          }));
        })();
      },

      permanentlyDelete: (bookmarkId) => {
        const state = get();
        const bookmark = state._trashedLoaded
          ? state.trashedBookmarks.find((candidate) => candidate.id === bookmarkId)
          : undefined;
        if (bookmark) {
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isTrashed: 2 })] });
          idbDelete("trashed-bookmarks", bookmarkId);
          set((current) => ({
            trashedBookmarks: current.trashedBookmarks.filter((candidate) => candidate.id !== bookmarkId),
          }));
          return;
        }

        void (async () => {
          const trashed = state._trashedLoaded ? undefined : await readBookmarkById("trashed-bookmarks", bookmarkId);
          if (!trashed) {
            return;
          }
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(trashed, { isTrashed: 2 })] });
          await idbDelete("trashed-bookmarks", bookmarkId);
          set((current) => ({
            trashedBookmarks: current._trashedLoaded
              ? current.trashedBookmarks.filter((candidate) => candidate.id !== bookmarkId)
              : current.trashedBookmarks,
          }));
        })();
      },

      enqueueAllToSync: () => {
        void (async () => {
          const state = get();
          const [archivedBookmarks, trashedBookmarks] = await Promise.all([
            state._archivedLoaded ? state.archivedBookmarks : readBookmarkStore("archived-bookmarks"),
            state._trashedLoaded ? state.trashedBookmarks : readBookmarkStore("trashed-bookmarks"),
          ]);
          syncEngine?.enqueue({
            bookmarks: [
              ...state.bookmarks.map((bookmark) => toServerBookmark(bookmark)),
              ...archivedBookmarks.map((bookmark) => toServerBookmark(bookmark, { isArchived: true })),
              ...trashedBookmarks.map((bookmark) => toServerBookmark(bookmark, { isTrashed: 1 })),
            ],
          });
        })();
      },

      mergeFromServer: async (resp) => {
        if (resp.entities.bookmarks.length === 0) { return; }

        const touchedIds = new Set(resp.entities.bookmarks.map((bookmark) => bookmark.id));
        const state = get();
        const [archivedSource, trashedSource] = await Promise.all([
          state._archivedLoaded ? state.archivedBookmarks : readBookmarkStore("archived-bookmarks"),
          state._trashedLoaded ? state.trashedBookmarks : readBookmarkStore("trashed-bookmarks"),
        ]);

        const existingById = new Map<string, Bookmark>();
        const pendingLocalTrashIds = new Set<string>();
        for (const bookmark of state.bookmarks) {
          if (touchedIds.has(bookmark.id)) {
            existingById.set(bookmark.id, bookmark);
          }
        }
        for (const bookmark of archivedSource) {
          if (touchedIds.has(bookmark.id)) {
            existingById.set(bookmark.id, bookmark);
          }
        }
        for (const bookmark of trashedSource) {
          if (touchedIds.has(bookmark.id)) {
            existingById.set(bookmark.id, bookmark);
            if (bookmark.seq === 0) {
              pendingLocalTrashIds.add(bookmark.id);
            }
          }
        }

        const toActive: Bookmark[] = [];
        const toArchived: Bookmark[] = [];
        const toTrashed: Bookmark[] = [];
        const permanentlyDeletedIds = new Set<string>();

        for (const serverBookmark of resp.entities.bookmarks) {
          if (serverBookmark.is_trashed === 2 || serverBookmark.deleted_at) {
            permanentlyDeletedIds.add(serverBookmark.id);
            continue;
          }
          const existing = existingById.get(serverBookmark.id);
          const keepLocallyTrashed = pendingLocalTrashIds.has(serverBookmark.id) && !serverBookmark.is_trashed;
          const localDeletedAt = serverBookmark.is_trashed || keepLocallyTrashed
            ? existing?.deletedAt ?? Date.now()
            : undefined;
          const merged: Bookmark = {
            id: serverBookmark.id,
            title: serverBookmark.title,
            url: serverBookmark.url,
            description: serverBookmark.description ?? existing?.description ?? "",
            favicon: serverBookmark.favicon_url ?? existing?.favicon ?? "",
            collectionId: serverBookmark.collection_id ?? existing?.collectionId ?? "",
            tags: serverBookmark.tag_ids ?? existing?.tags ?? [],
            createdAt: existing?.createdAt ?? String(serverBookmark.created_at),
            isFavorite: serverBookmark.is_favorite,
            seq: keepLocallyTrashed ? (existing?.seq ?? 0) : serverBookmark.seq,
            deletedAt: localDeletedAt,
          };
          if (serverBookmark.is_trashed || keepLocallyTrashed) {
            toTrashed.push(merged);
          } else if (serverBookmark.is_archived) {
            toArchived.push(merged);
          } else {
            toActive.push(merged);
          }
        }

        const ops: BulkWriteOp[] = [
          ...Array.from(permanentlyDeletedIds).flatMap((id) => [
            { type: "delete" as const, store: "bookmarks" as const, key: id },
            { type: "delete" as const, store: "archived-bookmarks" as const, key: id },
            { type: "delete" as const, store: "trashed-bookmarks" as const, key: id },
          ]),
          ...toActive.flatMap((bookmark) => [
            { type: "put" as const, store: "bookmarks" as const, value: bookmark },
            { type: "delete" as const, store: "archived-bookmarks" as const, key: bookmark.id },
            { type: "delete" as const, store: "trashed-bookmarks" as const, key: bookmark.id },
          ]),
          ...toArchived.flatMap((bookmark) => [
            { type: "delete" as const, store: "bookmarks" as const, key: bookmark.id },
            { type: "put" as const, store: "archived-bookmarks" as const, value: bookmark },
            { type: "delete" as const, store: "trashed-bookmarks" as const, key: bookmark.id },
          ]),
          ...toTrashed.flatMap((bookmark) => [
            { type: "delete" as const, store: "bookmarks" as const, key: bookmark.id },
            { type: "delete" as const, store: "archived-bookmarks" as const, key: bookmark.id },
            { type: "put" as const, store: "trashed-bookmarks" as const, value: bookmark },
          ]),
        ];
        await idbBulkWrite(ops);

        set((current) => {
          const newActive = [
            ...current.bookmarks.filter((bookmark) => !touchedIds.has(bookmark.id)),
            ...toActive,
          ];
          const activeChanged =
            newActive.length !== current.bookmarks.length ||
            newActive.some((bookmark, index) => bookmark !== current.bookmarks[index]);

          const newArchived = [
            ...current.archivedBookmarks.filter((bookmark) => !touchedIds.has(bookmark.id)),
            ...toArchived,
          ];
          const archivedChanged =
            newArchived.length !== current.archivedBookmarks.length ||
            newArchived.some((bookmark, index) => bookmark !== current.archivedBookmarks[index]);

          const newTrashed = [
            ...current.trashedBookmarks.filter((bookmark) => !touchedIds.has(bookmark.id)),
            ...toTrashed,
          ];
          const trashedChanged =
            newTrashed.length !== current.trashedBookmarks.length ||
            newTrashed.some((bookmark, index) => bookmark !== current.trashedBookmarks[index]);

          return {
            bookmarks: activeChanged ? newActive : current.bookmarks,
            archivedBookmarks: current._archivedLoaded
              ? (archivedChanged ? newArchived : current.archivedBookmarks)
              : current.archivedBookmarks,
            trashedBookmarks: current._trashedLoaded
              ? (trashedChanged ? newTrashed : current.trashedBookmarks)
              : current.trashedBookmarks,
          };
        });
      },

      sweepUnsynced: () => {
        void (async () => {
          const state = get();
          const [archivedBookmarks, trashedBookmarks] = await Promise.all([
            state._archivedLoaded ? state.archivedBookmarks : readBookmarkStore("archived-bookmarks"),
            state._trashedLoaded ? state.trashedBookmarks : readBookmarkStore("trashed-bookmarks"),
          ]);
          const unsynced = [
            ...state.bookmarks.filter((bookmark) => bookmark.seq === 0).map((bookmark) => toServerBookmark(bookmark)),
            ...archivedBookmarks
              .filter((bookmark) => bookmark.seq === 0)
              .map((bookmark) => toServerBookmark(bookmark, { isArchived: true })),
            ...trashedBookmarks
              .filter((bookmark) => bookmark.seq === 0)
              .map((bookmark) => toServerBookmark(bookmark, { isTrashed: 1 })),
          ];
          if (unsynced.length > 0) {
            syncEngine?.enqueue({ bookmarks: unsynced });
          }
        })();
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
          archivedBookmarks: s._archivedLoaded ? [...s.archivedBookmarks, ...affected] : s.archivedBookmarks,
        }));
      },

      trashCollectionBookmarks: (collectionId) => {
        void (async () => {
          const state = get();
          const active = state.bookmarks.filter((bookmark) => bookmark.collectionId === collectionId);
          const archived = state._archivedLoaded
            ? state.archivedBookmarks.filter((bookmark) => bookmark.collectionId === collectionId)
            : await readArchivedBookmarksForCollection(collectionId);
          const all = [...active, ...archived];
          if (all.length === 0) { return; }
          const now = Date.now();
          const trashed = all.map((bookmark) => ({ ...bookmark, deletedAt: now }));
          const ops: BulkWriteOp[] = [
            ...active.map((bookmark) => ({ type: "delete" as const, store: "bookmarks" as const, key: bookmark.id })),
            ...archived.map((bookmark) => ({ type: "delete" as const, store: "archived-bookmarks" as const, key: bookmark.id })),
            ...trashed.map((bookmark) => ({ type: "put" as const, store: "trashed-bookmarks" as const, value: bookmark })),
          ];
          await idbBulkWrite(ops);
          syncEngine?.enqueue({ bookmarks: trashed.map((bookmark) => toServerBookmark(bookmark, { isTrashed: 1 })) });
          set((current) => ({
            bookmarks: current.bookmarks.filter((bookmark) => bookmark.collectionId !== collectionId),
            archivedBookmarks: current._archivedLoaded
              ? current.archivedBookmarks.filter((bookmark) => bookmark.collectionId !== collectionId)
              : current.archivedBookmarks,
            trashedBookmarks: current._trashedLoaded
              ? [...current.trashedBookmarks.filter((bookmark) => bookmark.collectionId !== collectionId), ...trashed]
              : current.trashedBookmarks,
          }));
          usePlanStore.getState().decrementUsage("bookmark", all.length);
        })();
      },

      restoreCollectionBookmarks: (collectionId) => {
        void (async () => {
          const state = get();
          const fromArchive = state._archivedLoaded
            ? state.archivedBookmarks.filter((b) => b.collectionId === collectionId)
            : await readArchivedBookmarksForCollection(collectionId);
          const fromTrash = state._trashedLoaded
            ? state.trashedBookmarks.filter((b) => b.collectionId === collectionId)
            : await readTrashedBookmarksForCollection(collectionId);
          const restoredFromTrash = fromTrash.map((b) => ({ ...b, deletedAt: undefined }));
          const all = [...fromArchive, ...restoredFromTrash];
          if (all.length === 0) { return; }
          const ops: BulkWriteOp[] = [
            ...fromArchive.map((b) => ({ type: "delete" as const, store: "archived-bookmarks" as const, key: b.id })),
            ...fromTrash.map((b) => ({ type: "delete" as const, store: "trashed-bookmarks" as const, key: b.id })),
            ...all.map((b) => ({ type: "put" as const, store: "bookmarks" as const, value: b })),
          ];
          await idbBulkWrite(ops);
          syncEngine?.enqueue({ bookmarks: all.map((b) => toServerBookmark(b)) });
          set((current) => ({
            archivedBookmarks: current._archivedLoaded
              ? current.archivedBookmarks.filter((b) => b.collectionId !== collectionId)
              : current.archivedBookmarks,
            trashedBookmarks: current._trashedLoaded
              ? current.trashedBookmarks.filter((b) => b.collectionId !== collectionId)
              : current.trashedBookmarks,
            bookmarks: [...current.bookmarks, ...all],
          }));
          usePlanStore.getState().incrementUsage("bookmark", all.length);
        })();
      },

      permanentlyDeleteCollectionBookmarks: (collectionId) => {
        void (async () => {
          const state = get();
          const trashed = state._trashedLoaded
            ? state.trashedBookmarks.filter((bookmark) => bookmark.collectionId === collectionId)
            : await readTrashedBookmarksForCollection(collectionId);
          const archived = state._archivedLoaded
            ? state.archivedBookmarks.filter((bookmark) => bookmark.collectionId === collectionId)
            : await readArchivedBookmarksForCollection(collectionId);
          const all = [...trashed, ...archived];
          if (all.length === 0) { return; }
          syncEngine?.enqueue({ bookmarks: all.map((bookmark) => toServerBookmark(bookmark, { isTrashed: 2 })) });
          const ops: BulkWriteOp[] = [
            ...trashed.map((bookmark) => ({ type: "delete" as const, store: "trashed-bookmarks" as const, key: bookmark.id })),
            ...archived.map((bookmark) => ({ type: "delete" as const, store: "archived-bookmarks" as const, key: bookmark.id })),
          ];
          await idbBulkWrite(ops);
          set((current) => ({
            trashedBookmarks: current._trashedLoaded
              ? current.trashedBookmarks.filter((bookmark) => bookmark.collectionId !== collectionId)
              : current.trashedBookmarks,
            archivedBookmarks: current._archivedLoaded
              ? current.archivedBookmarks.filter((bookmark) => bookmark.collectionId !== collectionId)
              : current.archivedBookmarks,
          }));
        })();
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
