import { create } from "zustand";
import type { Workspace, Collection, Tag } from "@/lib/types";
import type { ImportPlan } from "@/lib/import-types";
import { generateId } from "@/lib/id";
import { idbGetAll, idbGet, idbPut, idbDelete, idbBulkWrite, type BulkWriteOp } from "@/lib/idb";
import { syncEngine } from "@/lib/sync-engine";
import type { SyncPullResponse } from "@/lib/api";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useGroupsStore } from "@/store/groups-store";
import { usePlanStore, guardQuota } from "@/store/plan-store";
import { analytics } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WORKSPACE_COLORS = [
  "blue",
  "emerald",
  "orange",
  "violet",
  "rose",
  "amber",
] as const;
export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

export const WORKSPACE_GRADIENTS: Record<WorkspaceColor, string> = {
  blue: "from-blue-400 to-indigo-500",
  emerald: "from-emerald-400 to-cyan-500",
  orange: "from-orange-400 to-rose-500",
  violet: "from-violet-400 to-purple-500",
  rose: "from-rose-400 to-pink-500",
  amber: "from-amber-400 to-orange-500",
};

export const COLLECTION_ICONS = [
  "folder",
  "bookmark",
  "code",
  "palette",
  "wrench",
  "book-open",
  "sparkles",
  "star",
  "heart",
  "globe",
] as const;
export type CollectionIcon = (typeof COLLECTION_ICONS)[number];

export const TAG_COLORS = [
  "bg-blue-500/10 text-blue-500",
  "bg-emerald-500/10 text-emerald-500",
  "bg-violet-500/10 text-violet-500",
  "bg-amber-500/10 text-amber-500",
  "bg-rose-500/10 text-rose-500",
  "bg-cyan-500/10 text-cyan-500",
  "bg-orange-500/10 text-orange-500",
  "bg-pink-500/10 text-pink-500",
] as const;

// Exported just to guarantee Tailwind v4 scanner picks up these solid colors
export const SOLID_TAG_COLORS = [
  "bg-blue-500", "bg-emerald-500", "bg-violet-500", "bg-amber-500",
  "bg-rose-500", "bg-cyan-500", "bg-orange-500", "bg-pink-500"
];



// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------
function toServerCollection(c: Collection, opts?: { isDeleted?: number }): object {
  return {
    id: c.id,
    workspace_id: c.workspaceId !== "" ? c.workspaceId : null,
    name: c.name,
    icon: c.icon,
    position: c.position,
    seq: c.seq,
    deleted_at: c.deletedAt ?? null,
    archived_at: c.archivedAt ?? null,
    updated_at: Date.now(),
    is_deleted: opts?.isDeleted ?? (c.deletedAt ? 1 : 0),
  };
}

function toServerWorkspace(w: Workspace): object {
  return {
    id: w.id,
    name: w.name,
    color: w.color,
    position: w.position,
    seq: w.seq,
    deleted_at: w.deletedAt ?? null,
    updated_at: Date.now(),
  };
}

function toServerTag(t: Tag): object {
  return {
    id: t.id,
    name: t.name,
    color: t.color,
    seq: t.seq,
    deleted_at: t.deletedAt ?? null,
    updated_at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface WorkspaceState {
  workspaces: Workspace[];
  collections: Collection[];
  tags: Tag[];
  activeWorkspaceId: string;
  compactGroupTitles: boolean;
  localSeq: number;

  _hydrated: boolean;
  hydrate: () => Promise<void>;
  reset: () => void;

  highlightedCollectionIds: string[];
  setHighlightedCollectionIds: (ids: string[], durationMs?: number) => void;

  setActiveWorkspaceId: (id: string) => void;
  setCompactGroupTitles: (val: boolean) => void;

  // Sync actions
  setLocalSeq: (seq: number) => void;
  mergeFromServer: (resp: SyncPullResponse) => void;
  enqueueAllToSync: () => void;
  sweepUnsynced: () => void;

  // Workspace CRUD
  createWorkspace: (name: string, color: string) => Workspace;
  updateWorkspace: (id: string, patch: Partial<Pick<Workspace, "name" | "color">>) => void;
  deleteWorkspace: (id: string) => void;

  // Collection CRUD
  createCollection: (workspaceId: string, name: string, icon: string) => Collection;
  updateCollection: (id: string, patch: Partial<Pick<Collection, "name" | "icon">>) => void;
  deleteCollection: (id: string) => void;
  archiveCollection: (id: string) => void;
  restoreCollection: (id: string) => void;
  permanentlyDeleteCollection: (id: string) => void;

  // Tag CRUD
  createTag: (name: string, color: string) => Tag;
  updateTag: (id: string, patch: Partial<Pick<Tag, "name" | "color">>) => void;
  deleteTag: (id: string) => void;
  importFromPlan: (plan: ImportPlan) => boolean;

  // Computed
  getWorkspaceCollections: (workspaceId?: string) => Collection[];
  getArchivedCollections: () => Collection[];
  getTrashedCollections: () => Collection[];
}

// Module-level timer to avoid referential equality issues with array comparison
let _collectionHighlightTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  workspaces: [],
  collections: [],
  tags: [],
  activeWorkspaceId: "",
  compactGroupTitles: true,
  localSeq: 0,

  _hydrated: false,
  hydrate: async () => {
    const [workspaces, collections, tags] = await Promise.all([
      idbGetAll<Workspace>("workspaces"),
      idbGetAll<Collection>("collections"),
      idbGetAll<Tag>("tags"),
    ]);
    const [activeWsKv, compactKv, localSeqKv] = await Promise.all([
      idbGet<{ key: string; value: string }>("kv", "activeWorkspaceId"),
      idbGet<{ key: string; value: boolean }>("kv", "compactGroupTitles"),
      idbGet<{ key: string; value: number }>("kv", "localSeq"),
    ]);

    // Offline fallback: if a workspace has no isDefault collection in local IDB data,
    // flag the lowest-position active one temporarily. This is overwritten on the next
    // pull once the server confirms the real is_default value.
    for (const ws of workspaces) {
      const wsCols = collections.filter(
        c => c.workspaceId === ws.id && !c.deletedAt && !c.archivedAt,
      );
      if (!wsCols.some(c => c.isDefault) && wsCols.length > 0) {
        const first = [...wsCols].sort((a, b) => a.position - b.position)[0];
        const idx = collections.findIndex(c => c.id === first.id);
        if (idx !== -1) { collections[idx] = { ...collections[idx], isDefault: true }; }
      }
    }

    let activeWorkspaceId = activeWsKv?.value ?? "";
    if (!activeWorkspaceId && workspaces.length > 0) {
      const first = [...workspaces].sort((a, b) => a.position - b.position)[0];
      if (first) {
        activeWorkspaceId = first.id;
        idbPut("kv", { key: "activeWorkspaceId", value: activeWorkspaceId });
      }
    }

    set({
      workspaces,
      collections,
      tags,
      activeWorkspaceId,
      compactGroupTitles: compactKv?.value ?? true,
      localSeq: localSeqKv?.value ?? 0,
      _hydrated: true,
    });
  },

  reset: () => {
    set({
      workspaces: [],
      collections: [],
      tags: [],
      activeWorkspaceId: "",
      compactGroupTitles: true,
      localSeq: 0,
      _hydrated: true,
    });
  },

  highlightedCollectionIds: [],
  setHighlightedCollectionIds: (ids, durationMs = 3000) => {
    if (_collectionHighlightTimer) { clearTimeout(_collectionHighlightTimer); }
    set({ highlightedCollectionIds: ids });
    if (ids.length > 0) {
      _collectionHighlightTimer = setTimeout(() => {
        set({ highlightedCollectionIds: [] });
        _collectionHighlightTimer = null;
      }, durationMs);
    }
  },

  setActiveWorkspaceId: (id) => {
    set({ activeWorkspaceId: id });
    idbPut("kv", { key: "activeWorkspaceId", value: id });
  },
  setCompactGroupTitles: (val) => {
    set({ compactGroupTitles: val });
    idbPut("kv", { key: "compactGroupTitles", value: val });
  },

  // ── Sync ──────────────────────────────────────────────────────────────
  setLocalSeq: (seq) => {
    set({ localSeq: seq });
    idbPut("kv", { key: "localSeq", value: seq });
  },

  enqueueAllToSync: () => {
    const { workspaces, collections, tags } = get();
    syncEngine?.enqueue({
      workspaces: workspaces.map(toServerWorkspace),
      collections: collections.map(c => toServerCollection(c)),
      tags: tags.map(toServerTag),
    });
  },

  mergeFromServer: (resp) => {
    const { workspaces: sw, collections: sc, tags: st } = resp.entities;
    if (sw.length === 0 && sc.length === 0 && st.length === 0) {
      const s = get();
      if (!s.activeWorkspaceId && s.workspaces.length > 0) {
        const first = [...s.workspaces].sort((a, b) => a.position - b.position)[0];
        set({ activeWorkspaceId: first.id });
        idbPut("kv", { key: "activeWorkspaceId", value: first.id });
      }
      return;
    }

    // Collect permanently-deleted collection IDs before set() to keep the updater pure.
    const permDeletedCollectionIds = new Set(
      resp.entities.collections.filter(c => c.is_deleted === 2).map(c => c.id)
    );
    const existingWorkspaces = get().workspaces;
    const existingCollections = get().collections;
    const existingTags = get().tags;
    const wsIdx = new Map<string, number>(existingWorkspaces.map((w, i) => [w.id, i]));
    const colIdx = new Map<string, number>(existingCollections.map((c, i) => [c.id, i]));
    const tagIdx = new Map<string, number>(existingTags.map((t, i) => [t.id, i]));

    set((state) => {
      let workspaces = [...existingWorkspaces];
      let collections = [...existingCollections];
      let tags = [...existingTags];
      const deletedWorkspaceIds = new Set<string>();
      const deletedCollectionIds = new Set<string>();
      const deletedTagIds = new Set<string>();

      for (const sw of resp.entities.workspaces) {
        const idx = wsIdx.get(sw.id);
        if (sw.deleted_at) {
          if (idx !== undefined) {
            deletedWorkspaceIds.add(sw.id);
          }
        } else {
          if (idx === undefined) {
            wsIdx.set(sw.id, workspaces.length);
            workspaces.push({ id: sw.id, name: sw.name, color: sw.color ?? "", position: sw.position, seq: sw.seq });
          } else {
            workspaces[idx] = { ...workspaces[idx], name: sw.name, color: sw.color ?? workspaces[idx].color, position: sw.position, seq: sw.seq };
          }
        }
      }
      if (deletedWorkspaceIds.size > 0) {
        workspaces = workspaces.filter(w => !deletedWorkspaceIds.has(w.id));
      }

      for (const sc of resp.entities.collections) {
        const idx = colIdx.get(sc.id);
        if (permDeletedCollectionIds.has(sc.id)) {
          // Permanently deleted on server — skip; IDB deletion happens after set() returns.
          if (idx !== undefined) {
            deletedCollectionIds.add(sc.id);
          }
          continue;
        }
        if (sc.deleted_at) {
          // Server confirmed soft-delete — keep in collections with deletedAt so
          // TrashContent can still find and display the collection card.
          if (idx === undefined) {
            colIdx.set(sc.id, collections.length);
            collections.push({
              id: sc.id,
              workspaceId: sc.workspace_id ?? "",
              name: sc.name,
              icon: sc.icon ?? "folder",
              position: sc.position,
              seq: sc.seq,
              isDefault: false,   // trashed collections are never the default
              deletedAt: sc.deleted_at,
            });
          } else {
            collections[idx] = { ...collections[idx], seq: sc.seq, deletedAt: sc.deleted_at };
          }
        } else {
          if (idx === undefined) {
            colIdx.set(sc.id, collections.length);
            collections.push({
              id: sc.id,
              workspaceId: sc.workspace_id ?? "",
              name: sc.name,
              icon: sc.icon ?? "folder",
              position: sc.position,
              seq: sc.seq,
              isDefault: sc.is_default ?? false,
              archivedAt: sc.archived_at ?? undefined,
            });
          } else {
            // Local pending archive (seq=0) wins over server alive state, but not over a
            // server-confirmed archive — that ack must land so sweepUnsynced stops re-queuing.
            const local = collections[idx];
            if ((local.deletedAt || local.archivedAt) && local.seq === 0 && !sc.archived_at) {
              continue;
            }
            collections[idx] = {
              ...local,
              name: sc.name,
              icon: sc.icon ?? local.icon,
              position: sc.position,
              seq: sc.seq,
              workspaceId: sc.workspace_id ?? local.workspaceId,
              isDefault: sc.is_default ?? local.isDefault,
              archivedAt: sc.archived_at ?? undefined,
            };
          }
        }
      }
      if (deletedCollectionIds.size > 0) {
        collections = collections.filter(c => !deletedCollectionIds.has(c.id));
      }

      for (const st of resp.entities.tags) {
        const idx = tagIdx.get(st.id);
        if (st.deleted_at) {
          if (idx !== undefined) {
            deletedTagIds.add(st.id);
          }
        } else {
          if (idx === undefined) {
            tagIdx.set(st.id, tags.length);
            tags.push({ id: st.id, name: st.name, color: st.color ?? "", seq: st.seq });
          } else {
            tags[idx] = { ...tags[idx], name: st.name, color: st.color ?? tags[idx].color, seq: st.seq };
          }
        }
      }
      if (deletedTagIds.size > 0) {
        tags = tags.filter(t => !deletedTagIds.has(t.id));
      }

      const sortedWs = [...workspaces].sort((a, b) => a.position - b.position);
      const activeWorkspaceId =
        workspaces.some(w => w.id === state.activeWorkspaceId)
          ? state.activeWorkspaceId
          : sortedWs[0]?.id ?? "";
      return { workspaces, collections, tags, activeWorkspaceId };
    });

    const afterState = get();
    const wsByIdAfter = new Map(afterState.workspaces.map(w => [w.id, w]));
    const colByIdAfter = new Map(afterState.collections.map(c => [c.id, c]));
    const tagByIdAfter = new Map(afterState.tags.map(t => [t.id, t]));

    const idbOps: BulkWriteOp[] = [
      { type: "put", store: "kv", value: { key: "activeWorkspaceId", value: afterState.activeWorkspaceId } },
    ];
    for (const sw of resp.entities.workspaces) {
      if (sw.deleted_at) {
        idbOps.push({ type: "delete", store: "workspaces", key: sw.id });
      } else {
        const w = wsByIdAfter.get(sw.id);
        if (w) {
          idbOps.push({ type: "put", store: "workspaces", value: w });
        }
      }
    }
    for (const sc of resp.entities.collections) {
      if (permDeletedCollectionIds.has(sc.id)) {
        idbOps.push({ type: "delete", store: "collections", key: sc.id });
      } else {
        const c = colByIdAfter.get(sc.id);
        if (c) {
          idbOps.push({ type: "put", store: "collections", value: c });
        }
      }
    }
    for (const st of resp.entities.tags) {
      if (st.deleted_at) {
        idbOps.push({ type: "delete", store: "tags", key: st.id });
      } else {
        const t = tagByIdAfter.get(st.id);
        if (t) {
          idbOps.push({ type: "put", store: "tags", value: t });
        }
      }
    }
    void idbBulkWrite(idbOps);
  },

  // ── Workspaces ────────────────────────────────────────────────────────
  createWorkspace: (name, color) =>
    // Quota-blocked creation returns an empty-id sentinel rather than using
    // an unsafe assertion. Current callers ignore the return value.
    guardQuota("workspace", get().workspaces.length, { id: "", name, color, position: get().workspaces.length, seq: 0 }, () => {
      const state = get();
      const ws: Workspace = {
        id: generateId(),
        name,
        color,
        position: state.workspaces.length,
        seq: 0,
      };
      const defaultCol: Collection = {
        id: generateId(),
        workspaceId: ws.id,
        name: "Default",
        icon: "inbox",
        position: 0,
        isDefault: true,
        seq: 0,
      };
      const nextActiveId = state.workspaces.length === 0 ? ws.id : state.activeWorkspaceId;
      set({
        workspaces: [...state.workspaces, ws],
        collections: [...state.collections, defaultCol],
        activeWorkspaceId: nextActiveId,
      });
      idbPut("workspaces", ws);
      idbPut("collections", defaultCol);
      if (state.workspaces.length === 0) {
        idbPut("kv", { key: "activeWorkspaceId", value: ws.id });
      }
      syncEngine?.enqueue({ workspaces: [toServerWorkspace(ws)], collections: [toServerCollection(defaultCol)] });
      usePlanStore.getState().incrementUsage("workspace");
      usePlanStore.getState().incrementUsage("collection");
      analytics.track("workspace_created");
      return ws;
    }),

  updateWorkspace: (id, patch) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, ...patch } : w
      ),
    }));
    const updated = get().workspaces.find(w => w.id === id);
    if (updated) {
      idbPut("workspaces", updated);
      syncEngine?.enqueue({ workspaces: [toServerWorkspace(updated)] });
    }
  },

  deleteWorkspace: (id) => {
    void (async () => {
      // Soft-delete all active groups in this workspace so they get tombstoned
      // on the server with a valid workspace_id (avoids ON DELETE SET NULL).
      const { groups, deleteGroup } = useGroupsStore.getState();
      for (const g of groups) {
        if (g.workspaceId === id && !g.deletedAt) {
          deleteGroup(g.id);
        }
      }

      const { workspaces, collections, activeWorkspaceId } = get();
      const ws = workspaces.find(w => w.id === id);
      const allWorkspaceCols = collections.filter(c => c.workspaceId === id);
      // Only non-tombstoned collections need a new deletedAt + bookmark move;
      // already-deleted collections keep their original tombstone intact.
      const deletedAt = Date.now();
      const colsToTombstone = allWorkspaceCols
        .filter(c => !c.deletedAt)
        .map((c) => ({ ...c, deletedAt }));
      if (ws) {
        syncEngine?.enqueue({
          workspaces: [toServerWorkspace({ ...ws, deletedAt })],
          collections: colsToTombstone.map(c => toServerCollection(c)),
        });
      }
      const tombstonedCollections = new Map(colsToTombstone.map(c => [c.id, c]));
      void idbBulkWrite(colsToTombstone.map(c => ({ type: "put" as const, store: "collections" as const, value: c })));
      for (const c of colsToTombstone) {
        await useBookmarksStore.getState().trashCollectionBookmarks(c.id);
      }
      idbDelete("workspaces", id);
      const remaining = workspaces.filter(w => w.id !== id);
      const newActiveId = activeWorkspaceId === id ? (remaining[0]?.id ?? "") : activeWorkspaceId;
      if (activeWorkspaceId === id) {
        idbPut("kv", { key: "activeWorkspaceId", value: newActiveId });
      }
      set({
        workspaces: remaining,
        collections: collections.map(c => tombstonedCollections.get(c.id) ?? c),
        activeWorkspaceId: newActiveId,
      });
      usePlanStore.getState().decrementUsage("workspace");
    })();
  },

  // ── Collections ───────────────────────────────────────────────────────
  createCollection: (workspaceId, name, icon) =>
    guardQuota(
      "collection",
      // Backend counts all collections where is_deleted < 2, so active, archived,
      // and trashed entries all count toward quota. Permanently deleted entries
      // are removed from the local array entirely, so collections.length always
      // matches the backend's count.
      get().collections.length,
      { id: "", workspaceId, name: name ?? "", icon: icon ?? "", position: 0, seq: 0 } as Collection,
      () => {
        const existingInWs = get().collections.filter((c) => c.workspaceId === workspaceId);
        const col: Collection = {
          id: generateId(),
          workspaceId,
          name,
          icon,
          position: existingInWs.length,
          seq: 0,
        };
        set((s) => ({ collections: [...s.collections, col] }));
        idbPut("collections", col);
        syncEngine?.enqueue({ collections: [toServerCollection(col)] });
        usePlanStore.getState().incrementUsage("collection");
        analytics.track("collection_created");
        return col;
      },
    ),

  updateCollection: (id, patch) => {
    set((s) => ({
      collections: s.collections.map((c) =>
        c.id === id ? { ...c, ...patch } : c
      ),
    }));
    const updated = get().collections.find(c => c.id === id);
    if (updated) {
      idbPut("collections", updated);
      syncEngine?.enqueue({ collections: [toServerCollection(updated)] });
    }
  },

  deleteCollection: (id) => {
    const col = get().collections.find(c => c.id === id && !c.isDefault);
    if (!col) { return; }
    const trashed = { ...col, deletedAt: Date.now() };
    idbPut("collections", trashed);
    syncEngine?.enqueue({ collections: [toServerCollection(trashed)] });
    set((s) => ({ collections: s.collections.map(c => c.id === id ? trashed : c) }));
    useBookmarksStore.getState().trashCollectionBookmarks(id);
  },

  archiveCollection: (id) => {
    const col = get().collections.find(c => c.id === id && !c.isDefault);
    if (!col) { return; }
    const archived = { ...col, archivedAt: Date.now() };
    idbPut("collections", archived);
    syncEngine?.enqueue({ collections: [toServerCollection(archived)] });
    set((s) => ({ collections: s.collections.map(c => c.id === id ? archived : c) }));
    useBookmarksStore.getState().archiveCollectionBookmarks(id);
  },

  restoreCollection: (id) => {
    const col = get().collections.find(c => c.id === id);
    if (!col) { return; }
    const { workspaces, activeWorkspaceId } = get();
    const workspaceExists = workspaces.some(w => w.id === col.workspaceId);
    const restoredWorkspaceId = workspaceExists
      ? col.workspaceId
      : (activeWorkspaceId || workspaces[0]?.id || col.workspaceId);
    const restored = {
      ...col,
      workspaceId: restoredWorkspaceId,
      deletedAt: undefined,
      archivedAt: undefined,
    };
    idbPut("collections", restored);
    syncEngine?.enqueue({ collections: [toServerCollection(restored)] });
    set((s) => ({ collections: s.collections.map(c => c.id === id ? restored : c) }));
  },

  permanentlyDeleteCollection: (id) => {
    void (async () => {
      const col = get().collections.find(c => c.id === id && !!c.deletedAt);
      if (!col) { return; }
      // Optimistic UI — remove from state immediately; IDB cleanup waits for server.
      set((s) => ({ collections: s.collections.filter(c => c.id !== id) }));
      if (syncEngine) {
        try {
          await syncEngine.forcePush({ collections: [toServerCollection(col, { isDeleted: 2 })] });
        } catch {
          // Push failed — roll back so the collection reappears in trash.
          set((s) => ({ collections: [...s.collections, col] }));
          return;
        }
      }
      // Server confirmed — safe to delete from IDB.
      idbDelete("collections", id);
      usePlanStore.getState().decrementUsage("collection");
      // Push bookmarks tombstones (is_trashed:2) and clean up locally.
      useBookmarksStore.getState().permanentlyDeleteCollectionBookmarks(id);
    })();
  },

  // ── Tags ──────────────────────────────────────────────────────────────
  createTag: (name, color) =>
    guardQuota("tag", get().tags.length, { id: "", name, color, seq: 0 } as Tag, () => {
      const tag: Tag = { id: generateId(), name, color, seq: 0 };
      set((s) => ({ tags: [...s.tags, tag] }));
      idbPut("tags", tag);
      syncEngine?.enqueue({ tags: [toServerTag(tag)] });
      usePlanStore.getState().incrementUsage("tag");
      return tag;
    }),

  updateTag: (id, patch) => {
    set((s) => ({
      tags: s.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
    const updated = get().tags.find(t => t.id === id);
    if (updated) {
      idbPut("tags", updated);
      syncEngine?.enqueue({ tags: [toServerTag(updated)] });
    }
  },

  deleteTag: (id) => {
    const tag = get().tags.find(t => t.id === id);
    if (tag) { syncEngine?.enqueue({ tags: [toServerTag({ ...tag, deletedAt: Date.now() })] }); }
    idbDelete("tags", id);
    set((s) => ({ tags: s.tags.filter((t) => t.id !== id) }));
    usePlanStore.getState().decrementUsage("tag");
  },

  importFromPlan: (plan) => {
    const planStore = usePlanStore.getState();
    planStore.ensureFresh();

    const bookmarkCount = useBookmarksStore.getState().bookmarks.size;
    // Backend counts collections where is_deleted < 2, so active, archived,
    // and trashed entries all count. Only permanentlyDeleteCollection sends
    // is_deleted:2 and removes the entry from the local array, so
    // collections.length mirrors the server count.
    const activeCollectionCount = get().collections.length;

    if (
      plan.bookmarks.length > 0 &&
      !planStore.checkQuota("bookmark", bookmarkCount + plan.bookmarks.length - 1)
    ) {
      planStore.showQuotaAlert("bookmark");
      return false;
    }

    if (
      plan.collections.length > 0 &&
      !planStore.checkQuota("collection", activeCollectionCount + plan.collections.length - 1)
    ) {
      planStore.showQuotaAlert("collection");
      return false;
    }

    const newTags: Tag[] = plan.tags.map((t) => ({ ...t, seq: 0 as const }));
    if (newTags.length > 0) {
      set((s) => ({ tags: [...s.tags, ...newTags] }));
      for (const tag of newTags) { idbPut("tags", tag); }
      syncEngine?.enqueue({ tags: newTags.map(toServerTag) });
      planStore.incrementUsage("tag", newTags.length);
    }

    const newCollections: Collection[] = plan.collections.map((c) => ({ ...c, seq: 0 as const }));
    if (newCollections.length > 0) {
      set((s) => ({ collections: [...s.collections, ...newCollections] }));
      for (const collection of newCollections) { idbPut("collections", collection); }
      syncEngine?.enqueue({ collections: newCollections.map((c) => toServerCollection(c)) });
      planStore.incrementUsage("collection", newCollections.length);
    }

    const newBookmarks = plan.bookmarks.map((b) => ({ ...b, seq: 0 as const }));
    if (newBookmarks.length > 0) {
      useBookmarksStore.getState()._bulkAddBookmarks(newBookmarks);
      planStore.incrementUsage("bookmark", newBookmarks.length);
    }

    return true;
  },

  sweepUnsynced: () => {
    const { workspaces, collections, tags } = get();
    const ws = workspaces.filter(w => w.seq === 0);
    const cols = collections.filter(c => c.seq === 0);
    const ts = tags.filter(t => t.seq === 0);
    if (ws.length > 0 || cols.length > 0 || ts.length > 0) {
      syncEngine?.enqueue({
        workspaces: ws.map(toServerWorkspace),
        collections: cols.map(c => toServerCollection(c)),
        tags: ts.map(toServerTag),
      });
    }
  },

  // ── Computed ──────────────────────────────────────────────────────────
  getWorkspaceCollections: (workspaceId) => {
    const state = get();
    const wsId = workspaceId ?? state.activeWorkspaceId;
    return state.collections
      .filter((c) => c.workspaceId === wsId && !c.deletedAt && !c.archivedAt)
      .sort((a, b) => {
        if (a.isDefault) return -1;
        if (b.isDefault) return 1;
        return b.position - a.position;
      });
  },

  getArchivedCollections: () =>
    get().collections.filter(c => !!c.archivedAt && !c.deletedAt),

  getTrashedCollections: () =>
    get().collections.filter(c => !!c.deletedAt),
}));
