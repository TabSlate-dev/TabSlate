import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Workspace, Collection, Tag } from "@/lib/types";
import { generateId } from "@/lib/id";
import { chromeStorageAdapter } from "@/lib/chrome-storage-adapter";

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
// Types
// ---------------------------------------------------------------------------
interface WorkspaceState {
  workspaces: Workspace[];
  collections: Collection[];
  tags: Tag[];
  activeWorkspaceId: string;

  _hydrated: boolean;
  setHydrated: () => void;

  setActiveWorkspaceId: (id: string) => void;

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

      _hydrated: false,
      setHydrated: () => set({ _hydrated: true }),

      setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),

      // ── Workspaces ────────────────────────────────────────────────────────
      createWorkspace: (name, color) => {
        const state = get();
        const ws: Workspace = {
          id: generateId(),
          name,
          color,
          position: state.workspaces.length,
        };
        const defaultCol: Collection = {
          id: generateId(),
          workspaceId: ws.id,
          name: "Default",
          icon: "inbox",
          position: 0,
          isDefault: true,
        };
        set((s) => ({
          workspaces: [...s.workspaces, ws],
          collections: [...s.collections, defaultCol],
        }));
        // Auto-select if first workspace
        if (state.workspaces.length === 0) {
          set({ activeWorkspaceId: ws.id });
        }
        return ws;
      },

      updateWorkspace: (id, patch) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, ...patch } : w
          ),
        })),

      deleteWorkspace: (id) =>
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
        }),

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
        };
        set((s) => ({ collections: [...s.collections, col] }));
        return col;
      },

      updateCollection: (id, patch) =>
        set((s) => ({
          collections: s.collections.map((c) =>
            c.id === id ? { ...c, ...patch } : c
          ),
        })),

      deleteCollection: (id) =>
        set((s) => ({
          collections: s.collections.filter(
            (c) => c.id !== id || !!c.isDefault
          ),
        })),

      // ── Tags ──────────────────────────────────────────────────────────────
      createTag: (name, color) => {
        const tag: Tag = { id: generateId(), name, color };
        set((s) => ({ tags: [...s.tags, tag] }));
        return tag;
      },

      updateTag: (id, patch) =>
        set((s) => ({
          tags: s.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),

      deleteTag: (id) =>
        set((s) => ({ tags: s.tags.filter((t) => t.id !== id) })),

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
      name: "tabmaster-workspace",
      storage: createJSONStorage(() => chromeStorageAdapter),
      partialize: (state) =>
        ({
          workspaces: state.workspaces,
          collections: state.collections,
          tags: state.tags,
          activeWorkspaceId: state.activeWorkspaceId,
        } as WorkspaceState),
      // Seed a default workspace on first run
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setHydrated();
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
              }));
              useWorkspaceStore.setState((s) => ({
                collections: [...s.collections, ...newCols],
              }));
            }
          }
        }
      },
    }
  )
);

// ---------------------------------------------------------------------------
// Keep popup in sync with workspace changes
// ---------------------------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes["tabmaster-workspace"]) return;
  const newValue = changes["tabmaster-workspace"].newValue;
  if (!newValue) return;
  try {
    const parsed = typeof newValue === "string" ? JSON.parse(newValue) : newValue;
    const data = parsed?.state;
    if (data) {
      useWorkspaceStore.setState({
        workspaces: data.workspaces ?? [],
        collections: data.collections ?? [],
        tags: data.tags ?? [],
        activeWorkspaceId: data.activeWorkspaceId ?? "",
      });
    }
  } catch {
    // ignore malformed data
  }
});
