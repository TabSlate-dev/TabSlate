import { create } from "zustand";
import type { Workspace, Collection, Tag } from "@/lib/types";
import { generateId } from "@/lib/id";
import { idbGetAll, idbGet, idbPut, idbDelete } from "@/lib/idb";
import { syncEngine } from "@/lib/sync-engine";
import type { SyncPullResponse } from "@/lib/api";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useGroupsStore } from "@/store/groups-store";
import { usePlanStore } from "@/store/plan-store";

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
    is_deleted: opts?.isDeleted ?? 0,
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

    // Ensure every workspace has a default collection (preserved from onRehydrateStorage)
    const missingDefaults = workspaces.filter(
      (ws) => !collections.some((c) => c.workspaceId === ws.id && c.isDefault),
    );
    if (missingDefaults.length > 0) {
      const newCols: Collection[] = missingDefaults.map((ws) => ({
        id: generateId(),
        workspaceId: ws.id,
        name: "Default",
        icon: "inbox",
        position: 0,
        isDefault: true,
        seq: 0,
      }));
      for (const col of newCols) { idbPut("collections", col); }
      collections.push(...newCols);
    }

    set({
      workspaces,
      collections,
      tags,
      activeWorkspaceId: activeWsKv?.value ?? "",
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
      }
      return;
    }
    set((state) => {
      let workspaces = [...state.workspaces];
      let collections = [...state.collections];
      let tags = [...state.tags];

      for (const sw of resp.entities.workspaces) {
        if (sw.deleted_at) {
          workspaces = workspaces.filter(w => w.id !== sw.id);
        } else {
          const idx = workspaces.findIndex(w => w.id === sw.id);
          if (idx === -1) {
            workspaces.push({ id: sw.id, name: sw.name, color: sw.color ?? "", position: sw.position, seq: sw.seq });
          } else {
            workspaces[idx] = { ...workspaces[idx], name: sw.name, color: sw.color ?? workspaces[idx].color, position: sw.position, seq: sw.seq };
          }
        }
      }

      for (const sc of resp.entities.collections) {
        if (sc.is_deleted === 2) {
          // Permanently deleted on server — remove from IDB and skip adding to state
          idbDelete("collections", sc.id);
          collections = collections.filter(c => c.id !== sc.id);
          continue;
        }
        if (sc.deleted_at) {
          // Server confirmed soft-delete — keep in collections with deletedAt so
          // TrashContent can still find and display the collection card.
          const idx = collections.findIndex(c => c.id === sc.id);
          if (idx === -1) {
            collections.push({
              id: sc.id,
              workspaceId: sc.workspace_id ?? "",
              name: sc.name,
              icon: sc.icon ?? "folder",
              position: sc.position,
              seq: sc.seq,
              deletedAt: sc.deleted_at,
            });
          } else {
            collections[idx] = { ...collections[idx], seq: sc.seq, deletedAt: sc.deleted_at };
          }
        } else {
          const idx = collections.findIndex(c => c.id === sc.id);
          if (idx === -1) {
            collections.push({
              id: sc.id,
              workspaceId: sc.workspace_id ?? "",
              name: sc.name,
              icon: sc.icon ?? "folder",
              position: sc.position,
              seq: sc.seq,
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
              archivedAt: sc.archived_at ?? undefined,
            };
          }
        }
      }

      // Restore isDefault: for each workspace that has no default collection,
      // mark the lowest-position collection as default (mirrors createWorkspace logic).
      // Exclude archived and trashed collections from candidacy.
      const workspaceIds = new Set(workspaces.map(w => w.id));
      workspaceIds.forEach(wsId => {
        const wsCols = collections.filter(c => c.workspaceId === wsId && !c.deletedAt && !c.archivedAt);
        const hasDefault = wsCols.some(c => c.isDefault);
        if (!hasDefault && wsCols.length > 0) {
          const firstCol = [...wsCols].sort((a, b) => a.position - b.position)[0];
          const idx = collections.findIndex(c => c.id === firstCol.id);
          if (idx !== -1) { collections[idx] = { ...collections[idx], isDefault: true }; }
        }
      });

      for (const st of resp.entities.tags) {
        if (st.deleted_at) {
          tags = tags.filter(t => t.id !== st.id);
        } else {
          const idx = tags.findIndex(t => t.id === st.id);
          if (idx === -1) {
            tags.push({ id: st.id, name: st.name, color: st.color ?? "", seq: st.seq });
          } else {
            tags[idx] = { ...tags[idx], name: st.name, color: st.color ?? tags[idx].color, seq: st.seq };
          }
        }
      }

      const sortedWs = [...workspaces].sort((a, b) => a.position - b.position);
      const activeWorkspaceId =
        workspaces.some(w => w.id === state.activeWorkspaceId)
          ? state.activeWorkspaceId
          : sortedWs[0]?.id ?? "";
      return { workspaces, collections, tags, activeWorkspaceId };
    });

    // Sync IDB after Zustand state update (fire-and-forget)
    const state = get();
    for (const w of state.workspaces) { idbPut("workspaces", w); }
    for (const c of state.collections) { idbPut("collections", c); }
    for (const t of state.tags) { idbPut("tags", t); }
    for (const sw of resp.entities.workspaces) {
      if (sw.deleted_at) { idbDelete("workspaces", sw.id); }
    }
    // Note: deleted collections are kept in IDB with deletedAt set (not hard-deleted)
    // so TrashContent can display them after a page reload. permanentlyDeleteCollection
    // is the only path that calls idbDelete("collections", id).
    for (const st of resp.entities.tags) {
      if (st.deleted_at) { idbDelete("tags", st.id); }
    }
  },

  // ── Workspaces ────────────────────────────────────────────────────────
  createWorkspace: (name, color) => {
    const planStore = usePlanStore.getState();
    planStore.ensureFresh();
    if (!planStore.checkQuota("workspace", get().workspaces.length)) {
      planStore.showQuotaAlert("workspace");
      return undefined as unknown as Workspace;
    }
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
    planStore.incrementUsage("workspace");
    planStore.incrementUsage("collection"); // default collection created alongside
    return ws;
  },

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
    const colsToDelete = collections.filter(c => c.workspaceId === id);
    if (ws) {
      syncEngine?.enqueue({
        workspaces: [toServerWorkspace({ ...ws, deletedAt: Date.now() })],
        collections: colsToDelete.map(c => toServerCollection({ ...c, deletedAt: Date.now() })),
      });
    }
    for (const c of colsToDelete) { useBookmarksStore.getState().trashCollectionBookmarks(c.id); }
    idbDelete("workspaces", id);
    for (const c of colsToDelete) { idbDelete("collections", c.id); }
    const remaining = workspaces.filter(w => w.id !== id);
    const newActiveId = activeWorkspaceId === id ? (remaining[0]?.id ?? "") : activeWorkspaceId;
    if (activeWorkspaceId === id) {
      idbPut("kv", { key: "activeWorkspaceId", value: newActiveId });
    }
    set({
      workspaces: remaining,
      collections: collections.filter(c => c.workspaceId !== id),
      activeWorkspaceId: newActiveId,
    });
    usePlanStore.getState().decrementUsage("workspace");
  },

  // ── Collections ───────────────────────────────────────────────────────
  createCollection: (workspaceId, name, icon) => {
    const planStore = usePlanStore.getState();
    planStore.ensureFresh();
    const activeCollections = get().collections.filter(c => !c.deletedAt && !c.archivedAt).length;
    if (!planStore.checkQuota("collection", activeCollections)) {
      planStore.showQuotaAlert("collection");
      return { id: "", workspaceId, name: name ?? "", icon: icon ?? "", position: 0, seq: 0 } as Collection;
    }
    const existingInWs = get().collections.filter(c => c.workspaceId === workspaceId);
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
    planStore.incrementUsage("collection");
    return col;
  },

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
    const restored = { ...col, deletedAt: undefined, archivedAt: undefined };
    idbPut("collections", restored);
    syncEngine?.enqueue({ collections: [toServerCollection(restored)] });
    set((s) => ({ collections: s.collections.map(c => c.id === id ? restored : c) }));
  },

  permanentlyDeleteCollection: (id) => {
    const col = get().collections.find(c => c.id === id && !!c.deletedAt);
    if (!col) { return; }
    syncEngine?.enqueue({ collections: [toServerCollection(col, { isDeleted: 2 })] });
    idbDelete("collections", id);
    set((s) => ({ collections: s.collections.filter(c => c.id !== id) }));
    useBookmarksStore.getState().permanentlyDeleteCollectionBookmarks(id);
    usePlanStore.getState().decrementUsage("collection");
  },

  // ── Tags ──────────────────────────────────────────────────────────────
  createTag: (name, color) => {
    const planStore = usePlanStore.getState();
    planStore.ensureFresh();
    if (!planStore.checkQuota("tag", get().tags.length)) {
      planStore.showQuotaAlert("tag");
      return { id: "", name, color, seq: 0 } as Tag;
    }
    const tag: Tag = { id: generateId(), name, color, seq: 0 };
    set((s) => ({ tags: [...s.tags, tag] }));
    idbPut("tags", tag);
    syncEngine?.enqueue({ tags: [toServerTag(tag)] });
    planStore.incrementUsage("tag");
    return tag;
  },

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
      .sort((a, b) => a.position - b.position);
  },

  getArchivedCollections: () =>
    get().collections.filter(c => !!c.archivedAt && !c.deletedAt),

  getTrashedCollections: () =>
    get().collections.filter(c => !!c.deletedAt),
}));
