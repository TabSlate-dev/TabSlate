import { create } from "zustand";
import type { Workspace, Collection, Tag } from "@/lib/types";
import type { ImportPlan } from "@/lib/import-types";
import { generateId } from "@/lib/id";
import { idbGetAll, idbGet, idbPut, idbDelete, idbBulkWrite, type BulkWriteOp } from "@/lib/idb";
import * as idb from "@/lib/idb";
import { syncEngine } from "@/lib/sync-engine";
import { compareActiveCollections } from "@/lib/collection-utils";
import type { SyncEntity, SyncPullResponse, SyncPushEntities } from "@/lib/api";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useGroupsStore } from "@/store/groups-store";
import { usePlanStore, guardQuota } from "@/store/plan-store";
import { useAuthStore } from "@/store/auth-store";
import { analytics } from "@/lib/analytics";
import { createGuestWorkspaceSeed, type GuestWorkspaceChanges } from "@/lib/guest-workspace";
import { syncConflictRegistry } from "@/lib/sync-conflicts";
import {
  readWorkspaceLifecycleCapability,
  readWorkspaceLifecycleIntents,
  type WorkspaceLifecycleIntent,
  withWorkspaceLifecycleLock,
} from "@/lib/workspace-lifecycle-state";
import {
  purgeWorkspaceThroughActiveLifecycle,
  wakeActiveWorkspaceLifecycle,
} from "@/lib/sync-lifecycle";
import {
  clearWorkspaceAggregate,
  type WorkspaceAggregateIds,
} from "@/lib/workspace-aggregate";

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
function toServerCollection(c: Collection, opts?: { isDeleted?: number }): SyncEntity {
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

function toServerWorkspace(w: Workspace): SyncEntity {
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

function toServerTag(t: Tag): SyncEntity {
  return {
    id: t.id,
    name: t.name,
    color: t.color,
    seq: t.seq,
    deleted_at: t.deletedAt ?? null,
    updated_at: Date.now(),
  };
}

function isActiveWorkspace(workspace: Workspace): boolean {
  return workspace.deletedAt === undefined;
}

function compareWorkspacePosition(a: Workspace, b: Workspace): number {
  return a.position - b.position || a.id.localeCompare(b.id);
}

function chooseActiveWorkspace(workspaces: readonly Workspace[]): Workspace | undefined {
  return workspaces.filter(isActiveWorkspace).sort(compareWorkspacePosition)[0];
}

function workspaceMatchesSyncEntity(workspace: Workspace, entity: SyncEntity): boolean {
  const lifecycleAction = entity.lifecycle_action;
  const lifecycleMatches = lifecycleAction === "delete"
    ? workspace.deletedAt !== undefined
    : lifecycleAction === "restore"
      ? workspace.deletedAt === undefined
      : (entity.deleted_at ?? null) === (workspace.deletedAt ?? null);
  return lifecycleMatches &&
    entity.id === workspace.id &&
    entity.name === workspace.name &&
    entity.color === workspace.color &&
    entity.position === workspace.position;
}

function collectionMatchesSyncEntity(collection: Collection, entity: SyncEntity): boolean {
  return entity.id === collection.id &&
    entity.workspace_id === (collection.workspaceId || null) &&
    entity.name === collection.name &&
    entity.icon === collection.icon &&
    entity.position === collection.position &&
    (entity.deleted_at ?? null) === (collection.deletedAt ?? null) &&
    (entity.archived_at ?? null) === (collection.archivedAt ?? null);
}

function tagMatchesSyncEntity(tag: Tag, entity: SyncEntity): boolean {
  return entity.id === tag.id &&
    entity.name === tag.name &&
    entity.color === tag.color &&
    (entity.deleted_at ?? null) === (tag.deletedAt ?? null);
}

async function workspaceLifecycleSupported(): Promise<boolean> {
  const { user, serverUrl } = useAuthStore.getState();
  if (!user) {
    return true;
  }
  if (!serverUrl) {
    return false;
  }
  return Boolean(await readWorkspaceLifecycleCapability(serverUrl, user.id));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface WorkspaceActionResult {
  status: "queued" | "completed" | "blocked" | "unsupported";
  reason?: "last_active_workspace" | "server_capability" | "offline";
}

export interface WorkspaceMergeResult {
  terminalWorkspaceIds: string[];
  restoredWorkspaceIds: string[];
}

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
  initializeGuestWorkspace: (options?: { isSessionCurrent?: () => boolean }) => Promise<void>;

  highlightedCollectionIds: string[];
  setHighlightedCollectionIds: (ids: string[], durationMs?: number) => void;

  setActiveWorkspaceId: (id: string) => void;
  setCompactGroupTitles: (val: boolean) => void;

  // Sync actions
  setLocalSeq: (seq: number) => Promise<void>;
  mergeFromServer: (resp: SyncPullResponse) => Promise<WorkspaceMergeResult>;
  applyGuestWorkspaceChanges: (changes: GuestWorkspaceChanges) => void;
  enqueueAllToSync: () => void;
  sweepUnsynced: () => Promise<void>;
  confirmWorkspaceStoreEntitySeqs: (
    entities: Pick<SyncPushEntities, "workspaces" | "collections" | "tags">,
    serverSeq: number,
  ) => void;
  removeWorkspaceAggregateFromState: (ids: WorkspaceAggregateIds) => void;

  // Workspace CRUD
  createWorkspace: (name: string, color: string) => Workspace;
  updateWorkspace: (id: string, patch: Partial<Pick<Workspace, "name" | "color">>) => void;
  deleteWorkspace: (id: string) => Promise<WorkspaceActionResult>;
  restoreWorkspace: (id: string) => Promise<WorkspaceActionResult>;
  permanentlyDeleteWorkspace: (id: string) => Promise<WorkspaceActionResult>;

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
  getActiveWorkspaces: () => Workspace[];
  getDeletedWorkspaces: () => Workspace[];
  getWorkspaceCollections: (workspaceId?: string) => Collection[];
  getArchivedCollections: () => Collection[];
  getTrashedCollections: () => Collection[];
}

// Module-level timer to avoid referential equality issues with array comparison
let _collectionHighlightTimer: ReturnType<typeof setTimeout> | null = null;
let _guestWorkspaceInitialization: Promise<void> | null = null;

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
    for (const ws of workspaces.filter(isActiveWorkspace)) {
      const wsCols = collections.filter(
        c => c.workspaceId === ws.id && !c.deletedAt && !c.archivedAt,
      );
      if (!wsCols.some(c => c.isDefault) && wsCols.length > 0) {
        const first = [...wsCols].sort((a, b) => a.position - b.position)[0];
        const idx = collections.findIndex(c => c.id === first.id);
        if (idx !== -1) { collections[idx] = { ...collections[idx], isDefault: true }; }
      }
    }

    const persistedActiveId = activeWsKv?.value ?? "";
    const persistedActive = workspaces.find(
      (workspace) => workspace.id === persistedActiveId && isActiveWorkspace(workspace),
    );
    const activeWorkspaceId = persistedActive?.id ?? chooseActiveWorkspace(workspaces)?.id ?? "";
    if (activeWorkspaceId !== persistedActiveId) {
      await idbPut("kv", { key: "activeWorkspaceId", value: activeWorkspaceId });
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

  initializeGuestWorkspace: (options = {}) => {
    if (_guestWorkspaceInitialization) {
      return _guestWorkspaceInitialization;
    }

    let initialization: Promise<void>;
    initialization = Promise.resolve().then(async () => {
      try {
        if (options.isSessionCurrent && !options.isSessionCurrent()) {
          return;
        }
        const state = get();
        if (state.workspaces.length > 0) {
          return;
        }

        const seed = createGuestWorkspaceSeed(
          generateId(),
          generateId(),
          state.workspaces.length,
        );
        const created = await idb.idbCreateGuestWorkspaceIfEmpty(
          seed.workspace,
          seed.collection,
          { key: "activeWorkspaceId", value: seed.workspace.id },
          seed.provenance,
        );
        if (options.isSessionCurrent && !options.isSessionCurrent()) {
          if (created) {
            await idb.idbRollbackGuestWorkspaceIfUnchanged(
              seed.workspace,
              seed.collection,
              seed.provenance,
            );
          }
          return;
        }
        const current = get();
        if (current.workspaces.length > 0) {
          return;
        }
        if (!created) {
          const [workspaces, collections, activeWorkspace] = await Promise.all([
            idbGetAll<Workspace>("workspaces"),
            idbGetAll<Collection>("collections"),
            idbGet<{ key: string; value: string }>("kv", "activeWorkspaceId"),
          ]);
          if (options.isSessionCurrent && !options.isSessionCurrent()) {
            return;
          }
          if (get().workspaces.length === 0 && workspaces.length > 0) {
            const persistedActive = workspaces.find(
              (workspace) => workspace.id === activeWorkspace?.value && isActiveWorkspace(workspace),
            );
            set({
              workspaces,
              collections,
              activeWorkspaceId: persistedActive?.id ?? chooseActiveWorkspace(workspaces)?.id ?? "",
            });
          }
          return;
        }
        set({
          workspaces: [seed.workspace],
          collections: [seed.collection],
          activeWorkspaceId: seed.workspace.id,
        });
        if (options.isSessionCurrent && !options.isSessionCurrent()) {
          return;
        }
        if (get().workspaces.some((workspace) => workspace.id === seed.workspace.id)) {
          syncEngine?.enqueue({
            workspaces: [toServerWorkspace(seed.workspace)],
            collections: [toServerCollection(seed.collection)],
          });
        }
      } finally {
        if (_guestWorkspaceInitialization === initialization) {
          _guestWorkspaceInitialization = null;
        }
      }
    });
    _guestWorkspaceInitialization = initialization;
    return initialization;
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
    if (!get().workspaces.some((workspace) => workspace.id === id && isActiveWorkspace(workspace))) {
      return;
    }
    set({ activeWorkspaceId: id });
    idbPut("kv", { key: "activeWorkspaceId", value: id });
  },
  setCompactGroupTitles: (val) => {
    set({ compactGroupTitles: val });
    idbPut("kv", { key: "compactGroupTitles", value: val });
  },

  // ── Sync ──────────────────────────────────────────────────────────────
  setLocalSeq: async (seq) => {
    await idbPut("kv", { key: "localSeq", value: seq });
    set({ localSeq: seq });
  },

  enqueueAllToSync: () => {
    const { workspaces, collections, tags } = get();
    syncEngine?.enqueue({
      workspaces: workspaces.map(toServerWorkspace),
      collections: collections.map(c => toServerCollection(c)),
      tags: tags.map(toServerTag),
    });
  },

  mergeFromServer: async (resp) => {
    const terminalWorkspaceIds = resp.entities.workspaces
      .filter((workspace) => workspace.is_deleted === 2)
      .map((workspace) => workspace.id);
    const terminalIds = new Set(terminalWorkspaceIds);
    const pendingIntents = new Map(
      (await readWorkspaceLifecycleIntents()).map((intent) => [intent.workspaceId, intent]),
    );
    const current = get();
    let workspaces = [...current.workspaces];
    let collections = [...current.collections];
    let tags = [...current.tags];
    const restoredWorkspaceIds = new Set<string>();

    for (const serverWorkspace of resp.entities.workspaces) {
      const index = workspaces.findIndex((workspace) => workspace.id === serverWorkspace.id);
      const local = index === -1 ? undefined : workspaces[index];
      if (serverWorkspace.is_deleted === 2) {
        if (index !== -1) {
          workspaces.splice(index, 1);
        }
        continue;
      }

      const intent = pendingIntents.get(serverWorkspace.id);
      const serverDeleted = serverWorkspace.is_deleted === 1;
      const pendingDeleteWins = intent?.action === "delete" && !serverDeleted;
      const pendingRestoreWins = intent?.action === "restore" && serverDeleted;
      if (local && (pendingDeleteWins || pendingRestoreWins)) {
        continue;
      }

      if (!serverDeleted && (local?.deletedAt !== undefined || intent?.action === "restore")) {
        restoredWorkspaceIds.add(serverWorkspace.id);
      }
      const merged: Workspace = {
        id: serverWorkspace.id,
        name: serverWorkspace.name,
        color: serverWorkspace.color ?? local?.color ?? "",
        position: serverWorkspace.position,
        seq: serverWorkspace.seq,
        deletionModel: serverWorkspace.deletion_model,
        ...(serverDeleted
          ? { deletedAt: serverWorkspace.deleted_at ?? local?.deletedAt ?? Date.now() }
          : {}),
      };
      if (index === -1) {
        workspaces.push(merged);
      } else {
        workspaces[index] = merged;
      }
    }

    const permanentlyDeletedCollectionIds = new Set(
      resp.entities.collections.filter((collection) => collection.is_deleted === 2).map((collection) => collection.id),
    );
    for (const serverCollection of resp.entities.collections) {
      const index = collections.findIndex((collection) => collection.id === serverCollection.id);
      if (permanentlyDeletedCollectionIds.has(serverCollection.id)) {
        if (index !== -1) {
          collections.splice(index, 1);
        }
        continue;
      }
      const local = index === -1 ? undefined : collections[index];
      if (
        local &&
        local.seq === 0 &&
        (local.deletedAt !== undefined || local.archivedAt !== undefined) &&
        !serverCollection.deleted_at &&
        !serverCollection.archived_at
      ) {
        continue;
      }
      const merged: Collection = {
        id: serverCollection.id,
        workspaceId: serverCollection.workspace_id ?? local?.workspaceId ?? "",
        name: serverCollection.name,
        icon: serverCollection.icon ?? local?.icon ?? "folder",
        position: serverCollection.position,
        seq: serverCollection.seq,
        isDefault: serverCollection.deleted_at ? false : serverCollection.is_default ?? local?.isDefault,
        ...(serverCollection.deleted_at ? { deletedAt: serverCollection.deleted_at } : {}),
        ...(serverCollection.archived_at ? { archivedAt: serverCollection.archived_at } : {}),
      };
      if (index === -1) {
        collections.push(merged);
      } else {
        collections[index] = merged;
      }
    }

    for (const serverTag of resp.entities.tags) {
      const index = tags.findIndex((tag) => tag.id === serverTag.id);
      if (serverTag.deleted_at) {
        if (index !== -1) {
          tags.splice(index, 1);
        }
        continue;
      }
      const merged: Tag = {
        id: serverTag.id,
        name: serverTag.name,
        color: serverTag.color ?? (index === -1 ? "" : tags[index].color),
        seq: serverTag.seq,
      };
      if (index === -1) {
        tags.push(merged);
      } else {
        tags[index] = merged;
      }
    }

    const currentActive = workspaces.find(
      (workspace) => workspace.id === current.activeWorkspaceId && isActiveWorkspace(workspace),
    );
    const activeWorkspaceId = currentActive?.id ?? chooseActiveWorkspace(workspaces)?.id ?? "";
    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
    const tagById = new Map(tags.map((tag) => [tag.id, tag]));
    const operations: BulkWriteOp[] = [
      { type: "put", store: "kv", value: { key: "activeWorkspaceId", value: activeWorkspaceId } },
    ];
    for (const serverWorkspace of resp.entities.workspaces) {
      if (terminalIds.has(serverWorkspace.id)) {
        continue;
      }
      const workspace = workspaceById.get(serverWorkspace.id);
      if (workspace) {
        operations.push({ type: "put", store: "workspaces", value: workspace });
      }
    }
    for (const serverCollection of resp.entities.collections) {
      if (permanentlyDeletedCollectionIds.has(serverCollection.id)) {
        operations.push({ type: "delete", store: "collections", key: serverCollection.id });
        continue;
      }
      const collection = collectionById.get(serverCollection.id);
      if (collection) {
        operations.push({ type: "put", store: "collections", value: collection });
      }
    }
    for (const serverTag of resp.entities.tags) {
      if (serverTag.deleted_at) {
        operations.push({ type: "delete", store: "tags", key: serverTag.id });
        continue;
      }
      const tag = tagById.get(serverTag.id);
      if (tag) {
        operations.push({ type: "put", store: "tags", value: tag });
      }
    }
    await idbBulkWrite(operations);
    set({ workspaces, collections, tags, activeWorkspaceId });
    return {
      terminalWorkspaceIds,
      restoredWorkspaceIds: [...restoredWorkspaceIds],
    };
  },

  applyGuestWorkspaceChanges: (changes) => {
    const workspaceDeletes = new Set(changes.workspaceDeletes);
    const collectionDeletes = new Set(changes.collectionDeletes);
    set((state) => {
      const collectionPuts = new Map(changes.collectionPuts.map((collection) => [collection.id, collection]));
      const collections = state.collections
        .filter((collection) => !collectionDeletes.has(collection.id))
        .map((collection) => collectionPuts.get(collection.id) ?? collection);
      for (const collection of changes.collectionPuts) {
        if (!collections.some((current) => current.id === collection.id)) {
          collections.push(collection);
        }
      }
      return {
        workspaces: state.workspaces.filter((workspace) => !workspaceDeletes.has(workspace.id)),
        collections,
        ...(changes.activeWorkspaceId === undefined ? {} : { activeWorkspaceId: changes.activeWorkspaceId }),
      };
    });
  },

  // ── Workspaces ────────────────────────────────────────────────────────
  createWorkspace: (name, color) =>
    // Quota-blocked creation returns an empty-id sentinel rather than using
    // an unsafe assertion. Current callers ignore the return value.
    guardQuota("workspace", get().workspaces.length, { id: "", name, color, position: get().workspaces.length, seq: 0 }, () => {
      const state = get();
      const nextPosition = state.workspaces.reduce(
        (maximum, workspace) => Math.max(maximum, workspace.position),
        -1,
      ) + 1;
      const ws: Workspace = {
        id: generateId(),
        name,
        color,
        position: nextPosition,
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
      const hasActiveWorkspace = state.workspaces.some(isActiveWorkspace);
      const nextActiveId = hasActiveWorkspace ? state.activeWorkspaceId : ws.id;
      set({
        workspaces: [...state.workspaces, ws],
        collections: [...state.collections, defaultCol],
        activeWorkspaceId: nextActiveId,
      });
      idbPut("workspaces", ws);
      idbPut("collections", defaultCol);
      if (!hasActiveWorkspace) {
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

  deleteWorkspace: async (id) => {
    const workspace = get().workspaces.find((candidate) => candidate.id === id);
    if (!workspace || !isActiveWorkspace(workspace)) {
      return { status: "completed" };
    }
    if (!await workspaceLifecycleSupported()) {
      return { status: "unsupported", reason: "server_capability" };
    }
    const result = await withWorkspaceLifecycleLock(
      async (): Promise<WorkspaceActionResult> => {
        const committed = await idb.idbCommitWorkspaceDeleteLifecycleIntent({
          workspaceId: id,
          createdAt: Date.now(),
        });
        set({
          workspaces: committed.workspaces,
          activeWorkspaceId: committed.activeWorkspaceId,
        });
        if (committed.status === "committed") {
          return { status: "queued" };
        }
        if (committed.status === "last_active_workspace") {
          return { status: "blocked", reason: "last_active_workspace" };
        }
        return { status: "completed" };
      },
    );
    if (result.status === "queued") {
      await wakeActiveWorkspaceLifecycle(id).catch(() => false);
    }
    return result;
  },

  restoreWorkspace: async (id) => {
    const result = await withWorkspaceLifecycleLock(
      async (): Promise<WorkspaceActionResult> => {
        const state = get();
        const workspace = state.workspaces.find((candidate) => candidate.id === id);
        if (!workspace || isActiveWorkspace(workspace)) {
          return { status: "completed" };
        }
        if (!await workspaceLifecycleSupported()) {
          return { status: "unsupported", reason: "server_capability" };
        }

        const restoredWorkspace: Workspace = { ...workspace, deletedAt: undefined, seq: 0 };
        const intent: WorkspaceLifecycleIntent = {
          workspaceId: id,
          action: "restore",
          baseSeq: workspace.seq,
          previousActiveWorkspaceId: state.activeWorkspaceId,
          createdAt: Date.now(),
        };
        await idb.idbCommitWorkspaceLifecycleIntent({ workspace: restoredWorkspace, intent });
        set((current) => ({
          workspaces: current.workspaces.map((candidate) =>
            candidate.id === id ? restoredWorkspace : candidate,
          ),
        }));
        return { status: "queued" };
      },
    );
    if (result.status === "queued") {
      await wakeActiveWorkspaceLifecycle(id).catch(() => false);
    }
    return result;
  },

  permanentlyDeleteWorkspace: async (id) => {
    const workspace = get().workspaces.find((candidate) => candidate.id === id);
    if (!workspace) {
      return { status: "completed" };
    }
    if (isActiveWorkspace(workspace)) {
      return { status: "blocked" };
    }
    const { user, accessToken } = useAuthStore.getState();
    if (!user) {
      const committedIds = await clearWorkspaceAggregate(id, (ids) => {
        get().removeWorkspaceAggregateFromState(ids);
        useBookmarksStore.getState().removeWorkspaceAggregateFromState(ids);
        useGroupsStore.getState().removeWorkspaceAggregateFromState(ids);
      });
      if (!committedIds) {
        return { status: "blocked" };
      }
      const plan = usePlanStore.getState();
      plan.decrementUsage("workspace");
      plan.decrementUsage("collection", committedIds.collectionIds.length);
      plan.decrementUsage("bookmark", committedIds.bookmarkIds.length);
      plan.decrementUsage("saved_group", committedIds.groupIds.length);
      return { status: "completed" };
    }
    if (!accessToken) {
      return { status: "blocked", reason: "offline" };
    }

    const purge = purgeWorkspaceThroughActiveLifecycle(id);
    if (!purge) {
      return { status: "blocked", reason: "offline" };
    }
    set((state) => ({
      workspaces: state.workspaces.filter((candidate) => candidate.id !== id),
    }));
    try {
      const result = await purge;
      if (result.status === "completed") {
        await usePlanStore.getState().fetchPlan();
        return { status: "completed" };
      }
      set((state) => ({
        workspaces: state.workspaces.some((candidate) => candidate.id === id)
          ? state.workspaces
          : [...state.workspaces, workspace].sort(compareWorkspacePosition),
      }));
      return result.reason === "last_active_workspace"
        ? { status: "blocked", reason: "last_active_workspace" }
        : { status: "blocked" };
    } catch {
      set((state) => ({
        workspaces: state.workspaces.some((candidate) => candidate.id === id)
          ? state.workspaces
          : [...state.workspaces, workspace].sort(compareWorkspacePosition),
      }));
      return { status: "blocked", reason: "offline" };
    }
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
    const workspaceExists = workspaces.some(
      (workspace) => workspace.id === col.workspaceId && isActiveWorkspace(workspace),
    );
    const restoredWorkspaceId = workspaceExists
      ? col.workspaceId
      : (activeWorkspaceId || chooseActiveWorkspace(workspaces)?.id || col.workspaceId);
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

  sweepUnsynced: async () => {
    await syncConflictRegistry.ready();
    await withWorkspaceLifecycleLock(async (lock) => {
      const pendingWorkspaceIds = new Set(
        (await readWorkspaceLifecycleIntents()).map((intent) => intent.workspaceId),
      );
      const { workspaces, collections, tags } = get();
      const ws = workspaces.filter(
        (workspace) => workspace.seq === 0 && !pendingWorkspaceIds.has(workspace.id),
      );
      const cols = collections.filter(c => c.seq === 0);
      const ts = tags.filter(t => t.seq === 0);
      const payload = syncConflictRegistry.filterPayload({
        entities: {
          workspaces: ws.map(toServerWorkspace),
          collections: cols.map(c => toServerCollection(c)),
          tags: ts.map(toServerTag),
          bookmarks: [],
          groups: [],
        },
      });
      if (
        payload.entities.workspaces.length > 0 ||
        payload.entities.collections.length > 0 ||
        payload.entities.tags.length > 0
      ) {
        if (!await lock.renew()) {
          return;
        }
        syncEngine?.enqueue(payload.entities, "respect");
      }
    });
  },

  confirmWorkspaceStoreEntitySeqs: (entities, serverSeq) => {
    const workspacesById = new Map(entities.workspaces.map((entity) => [entity.id, entity]));
    const collectionsById = new Map(entities.collections.map((entity) => [entity.id, entity]));
    const tagsById = new Map(entities.tags.map((entity) => [entity.id, entity]));
    set((state) => ({
      workspaces: state.workspaces.map((workspace) => {
        const entity = workspacesById.get(workspace.id);
        return entity && workspaceMatchesSyncEntity(workspace, entity)
          ? { ...workspace, seq: serverSeq }
          : workspace;
      }),
      collections: state.collections.map((collection) => {
        const entity = collectionsById.get(collection.id);
        return entity && collectionMatchesSyncEntity(collection, entity)
          ? { ...collection, seq: serverSeq }
          : collection;
      }),
      tags: state.tags.map((tag) => {
        const entity = tagsById.get(tag.id);
        return entity && tagMatchesSyncEntity(tag, entity)
          ? { ...tag, seq: serverSeq }
          : tag;
      }),
    }));
  },

  removeWorkspaceAggregateFromState: (ids) => {
    const collectionIds = new Set(ids.collectionIds);
    set((state) => {
      const workspaces = state.workspaces.filter((workspace) => workspace.id !== ids.workspaceId);
      const activeWorkspace = workspaces.find(
        (workspace) => workspace.id === state.activeWorkspaceId && isActiveWorkspace(workspace),
      );
      return {
        workspaces,
        collections: state.collections.filter((collection) => !collectionIds.has(collection.id)),
        activeWorkspaceId: activeWorkspace?.id ?? chooseActiveWorkspace(workspaces)?.id ?? "",
      };
    });
  },

  // ── Computed ──────────────────────────────────────────────────────────
  getActiveWorkspaces: () =>
    get().workspaces.filter(isActiveWorkspace).sort(compareWorkspacePosition),

  getDeletedWorkspaces: () =>
    get().workspaces.filter((workspace) => !isActiveWorkspace(workspace)).sort(compareWorkspacePosition),

  getWorkspaceCollections: (workspaceId) => {
    const state = get();
    const wsId = workspaceId ?? state.activeWorkspaceId;
    return state.collections
      .filter((c) => c.workspaceId === wsId && !c.deletedAt && !c.archivedAt)
      .sort(compareActiveCollections);
  },

  getArchivedCollections: () =>
    get().collections.filter(c => !!c.archivedAt && !c.deletedAt),

  getTrashedCollections: () =>
    get().collections.filter(c => !!c.deletedAt),
}));
