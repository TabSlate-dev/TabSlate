import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Workspace, Collection, Tag } from "@/lib/types";
import { generateId } from "@/lib/id";
import { chromeStorageAdapter } from "@/lib/chrome-storage-adapter";
import { syncEngine } from "@/lib/sync-engine";
import type { SyncPullResponse } from "@/lib/api";

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
    workspace_id: c.workspaceId || null,
    name: c.name,
    icon: c.icon,
    position: c.position,
    seq: c.seq,
    deleted_at: c.deletedAt ?? null,
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
  setHydrated: () => void;

  highlightedCollectionIds: string[];
  setHighlightedCollectionIds: (ids: string[], durationMs?: number) => void;

  setActiveWorkspaceId: (id: string) => void;
  setCompactGroupTitles: (val: boolean) => void;

  // Sync actions
  setLocalSeq: (seq: number) => void;
  loadLocalSeq: () => void;
  mergeFromServer: (resp: SyncPullResponse) => void;

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
export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      collections: [],
      tags: [],
      activeWorkspaceId: "",
      compactGroupTitles: true,
      localSeq: 0,

      _hydrated: false,
      setHydrated: () => set({ _hydrated: true }),

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

      setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),
      setCompactGroupTitles: (val) => set({ compactGroupTitles: val }),

      // ── Sync ──────────────────────────────────────────────────────────────
      setLocalSeq: (seq) => {
        set({ localSeq: seq });
        chrome.storage.local.set({ "tabslate-sync": JSON.stringify({ localSeq: seq }) });
      },

      loadLocalSeq: () => {
        chrome.storage.local.get("tabslate-sync", (result) => {
          const raw = result["tabslate-sync"] as string | undefined;
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as { localSeq?: number };
              set({ localSeq: parsed.localSeq ?? 0 });
            } catch { /* ignore */ }
          }
        });
      },

      mergeFromServer: (resp) => {
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

          return { workspaces, collections, tags };
        });
        get().setLocalSeq(resp.server_seq);
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
        const updatedWorkspaces = [...state.workspaces, ws];
        const updatedCollections = [...state.collections, defaultCol];
        const nextActiveId = state.workspaces.length === 0 ? ws.id : state.activeWorkspaceId;

        set({
          workspaces: updatedWorkspaces,
          collections: updatedCollections,
          activeWorkspaceId: nextActiveId,
        });
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
        if (updated) { syncEngine?.enqueue({ workspaces: [toServerWorkspace(updated)] }); }
      },

      deleteWorkspace: (id) => {
        const ws = get().workspaces.find(w => w.id === id);
        const collectionsToDelete = get().collections.filter(c => c.workspaceId === id);
        if (ws) { syncEngine?.enqueue({ workspaces: [toServerWorkspace({ ...ws, deletedAt: Date.now() })], collections: collectionsToDelete.map(c => toServerCollection({ ...c, deletedAt: Date.now() })) }); }
        set((s) => {
          const remaining = s.workspaces.filter((w) => w.id !== id);
          const newActiveId =
            s.activeWorkspaceId === id
              ? (remaining[0]?.id ?? "")
              : s.activeWorkspaceId;
          return {
            workspaces: remaining,
            collections: s.collections.filter((c) => c.workspaceId !== id),
            activeWorkspaceId: newActiveId,
          };
        });
      },

      // ── Collections ───────────────────────────────────────────────────────
      createCollection: (workspaceId, name, icon) => {
        const state = get();
        const existingInWs = state.collections.filter(
          (c) => c.workspaceId === workspaceId
        );
        const col: Collection = {
          id: generateId(),
          workspaceId,
          name,
          icon,
          position: existingInWs.length,
          seq: 0,
        };
        set((s) => ({ collections: [...s.collections, col] }));
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
        if (updated) { syncEngine?.enqueue({ collections: [toServerCollection(updated)] }); }
      },

      deleteCollection: (id) => {
        const col = get().collections.find(c => c.id === id && !c.isDefault);
        if (col) { syncEngine?.enqueue({ collections: [toServerCollection({ ...col, deletedAt: Date.now() })] }); }
        set((s) => ({
          collections: s.collections.filter(
            (c) => c.id !== id || !!c.isDefault
          ),
        }));
      },

      // ── Tags ──────────────────────────────────────────────────────────────
      createTag: (name, color) => {
        const tag: Tag = { id: generateId(), name, color, seq: 0 };
        set((s) => ({ tags: [...s.tags, tag] }));
        syncEngine?.enqueue({ tags: [toServerTag(tag)] });
        return tag;
      },

      updateTag: (id, patch) => {
        set((s) => ({
          tags: s.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        }));
        const updated = get().tags.find(t => t.id === id);
        if (updated) { syncEngine?.enqueue({ tags: [toServerTag(updated)] }); }
      },

      deleteTag: (id) => {
        const tag = get().tags.find(t => t.id === id);
        if (tag) { syncEngine?.enqueue({ tags: [toServerTag({ ...tag, deletedAt: Date.now() })] }); }
        set((s) => ({ tags: s.tags.filter((t) => t.id !== id) }));
      },

      // ── Computed ──────────────────────────────────────────────────────────
      getWorkspaceCollections: (workspaceId) => {
        const state = get();
        const wsId = workspaceId ?? state.activeWorkspaceId;
        return state.collections
          .filter((c) => c.workspaceId === wsId)
          .sort((a, b) => a.position - b.position);
      },
    }),
    {
      name: "tabslate-workspace",
      storage: createJSONStorage(() => chromeStorageAdapter),
      partialize: (state) =>
        ({
          workspaces: state.workspaces,
          collections: state.collections,
          tags: state.tags,
          activeWorkspaceId: state.activeWorkspaceId,
          compactGroupTitles: state.compactGroupTitles,
        } as WorkspaceState),
      // Seed a default workspace on first run
      onRehydrateStorage: () => (state) => {
        if (state) {
          if (state.workspaces.length === 0) {
            state.createWorkspace("My Workspace", "blue");
          } else {
            // Migration: ensure every workspace has a default collection
            const missingDefaults = state.workspaces.filter(
              (ws) => !state.collections.some((c) => c.workspaceId === ws.id && c.isDefault)
            );
            if (missingDefaults.length > 0) {
              const newCols = missingDefaults.map((ws) => ({
                id: generateId(),
                workspaceId: ws.id,
                name: "Default",
                icon: "inbox",
                position: 0,
                isDefault: true as const,
                seq: 0,
              }));
              useWorkspaceStore.setState((s) => ({
                collections: [...s.collections, ...newCols],
              }));
            }
          }
          state.setHydrated();
          state.loadLocalSeq();
        }
      },
    }
  )
);

// ---------------------------------------------------------------------------
// Keep popup in sync with workspace changes
// ---------------------------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes["tabslate-workspace"]) { return; }
  const newValue = changes["tabslate-workspace"].newValue;
  if (!newValue) { return; }
  try {
    const parsed = typeof newValue === "string" ? JSON.parse(newValue) : newValue;
    const data = parsed?.state;
    if (data) {
      const current = useWorkspaceStore.getState();
      const needsUpdate =
        JSON.stringify(data.workspaces) !== JSON.stringify(current.workspaces) ||
        JSON.stringify(data.collections) !== JSON.stringify(current.collections) ||
        JSON.stringify(data.tags) !== JSON.stringify(current.tags) ||
        data.activeWorkspaceId !== current.activeWorkspaceId;

      if (needsUpdate) {
        useWorkspaceStore.setState({
          workspaces: data.workspaces ?? [],
          collections: data.collections ?? [],
          tags: data.tags ?? [],
          activeWorkspaceId: data.activeWorkspaceId ?? "",
          compactGroupTitles: data.compactGroupTitles ?? true,
        });
      }
    }
  } catch {
    // ignore malformed data
  }
});
