import { create } from "zustand";
import type { Workspace, Collection, Tag } from "@/lib/types";
import { generateId } from "@/lib/id";
import { idbGetAll, idbGet, idbPut, idbDelete } from "@/lib/idb";
import { syncEngine } from "@/lib/sync-engine";
import type { SyncPullResponse } from "@/lib/api";
import { useBookmarksStore } from "@/store/bookmarks-store";

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


// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------
function toServerCollection(c: Collection): object {
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

  // Tag CRUD
  createTag: (name: string, color: string) => Tag;
  updateTag: (id: string, patch: Partial<Pick<Tag, "name" | "color">>) => void;
  deleteTag: (id: string) => void;

  // Computed
  getWorkspaceCollections: (workspaceId?: string) => Collection[];
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
      collections: collections.map(toServerCollection),
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
        if (sc.deleted_at) {
          collections = collections.filter(c => c.id !== sc.id);
        } else {
          const idx = collections.findIndex(c => c.id === sc.id);
          if (idx === -1) {
            collections.push({ id: sc.id, workspaceId: sc.workspace_id ?? "", name: sc.name, icon: sc.icon ?? "folder", position: sc.position, seq: sc.seq });
          } else {
            collections[idx] = { ...collections[idx], name: sc.name, icon: sc.icon ?? collections[idx].icon, position: sc.position, seq: sc.seq, workspaceId: sc.workspace_id ?? collections[idx].workspaceId };
          }
        }
      }

      // Restore isDefault: for each workspace that has no default collection,
      // mark the lowest-position collection as default (mirrors createWorkspace logic).
      const workspaceIds = new Set(workspaces.map(w => w.id));
      workspaceIds.forEach(wsId => {
        const wsCols = collections.filter(c => c.workspaceId === wsId);
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
    for (const sc of resp.entities.collections) {
      if (sc.deleted_at) { idbDelete("collections", sc.id); }
    }
    for (const st of resp.entities.tags) {
      if (st.deleted_at) { idbDelete("tags", st.id); }
    }
  },

  // ── Workspaces ────────────────────────────────────────────────────────
  createWorkspace: (name, color) => {
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
    const { workspaces, collections, activeWorkspaceId } = get();
    const ws = workspaces.find(w => w.id === id);
    const colsToDelete = collections.filter(c => c.workspaceId === id);
    if (ws) {
      syncEngine?.enqueue({
        workspaces: [toServerWorkspace({ ...ws, deletedAt: Date.now() })],
        collections: colsToDelete.map(c => toServerCollection({ ...c, deletedAt: Date.now() })),
      });
    }
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
  },

  // ── Collections ───────────────────────────────────────────────────────
  createCollection: (workspaceId, name, icon) => {
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
    const defaultCol = get().collections.find(c => c.workspaceId === col.workspaceId && !!c.isDefault);
    const targetId = defaultCol?.id ?? "";
    syncEngine?.enqueue({ collections: [toServerCollection({ ...col, deletedAt: Date.now() })] });
    useBookmarksStore.getState().reassignCollection(id, targetId);
    idbDelete("collections", id);
    set((s) => ({
      collections: s.collections.filter(c => c.id !== id),
    }));
  },

  // ── Tags ──────────────────────────────────────────────────────────────
  createTag: (name, color) => {
    const tag: Tag = { id: generateId(), name, color, seq: 0 };
    set((s) => ({ tags: [...s.tags, tag] }));
    idbPut("tags", tag);
    syncEngine?.enqueue({ tags: [toServerTag(tag)] });
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
  },

  sweepUnsynced: () => {
    const { workspaces, collections, tags } = get();
    const ws = workspaces.filter(w => w.seq === 0);
    const cols = collections.filter(c => c.seq === 0);
    const ts = tags.filter(t => t.seq === 0);
    if (ws.length > 0 || cols.length > 0 || ts.length > 0) {
      syncEngine?.enqueue({
        workspaces: ws.map(toServerWorkspace),
        collections: cols.map(toServerCollection),
        tags: ts.map(toServerTag),
      });
    }
  },

  // ── Computed ──────────────────────────────────────────────────────────
  getWorkspaceCollections: (workspaceId) => {
    const state = get();
    const wsId = workspaceId ?? state.activeWorkspaceId;
    return state.collections
      .filter((c) => c.workspaceId === wsId)
      .sort((a, b) => a.position - b.position);
  },
}));
