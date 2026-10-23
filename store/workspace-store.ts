import { create } from "zustand";
import type { Workspace, Collection, Tag, Bookmark } from "@/lib/types";
import type { ImportCommitResult, ImportPlan } from "@/lib/import-types";
import { normalizeTagName } from "@/lib/tag-name";
import { buildTagTree, resolveTagPath } from "@/lib/tag-tree";
import { planTagEdit, planTagDeletion, planTagMerge, type TagActionResult, type TagMutationPlan } from "@/lib/tag-mutations";
import { changePersistedTags, commitTagMutation, invalidateTagMutations, serializeTagMutation, tagMutationSession, TagMutationStaleError } from "@/lib/tag-persistence";
import { unusedTagIds } from "@/lib/tag-counts";
import { generateId } from "@/lib/id";
import { idbGetAll, idbGet, idbPut, idbDelete, idbBulkWrite, type BulkWriteOp } from "@/lib/idb";
import * as idb from "@/lib/idb";
import { syncEngine } from "@/lib/sync-engine";
import { compareActiveCollections } from "@/lib/collection-utils";
import type { SyncEntity, SyncPullResponse, SyncPushEntities } from "@/lib/api";
import { useBookmarksStore, toServerBookmark } from "@/store/bookmarks-store";
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
    parent_id: t.parentId ?? "",
    seq: t.seq,
    deleted_at: t.deletedAt ?? null,
    updated_at: Date.now(),
  };
}

function isActiveWorkspace(workspace: Workspace | undefined): boolean {
  return workspace !== undefined && workspace.deletedAt === undefined;
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
    (entity.parent_id ?? "") === (tag.parentId ?? "") &&
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
  createTagPath: (input: string, color: string, parentId?: string) => Promise<TagActionResult>;
  updateTag: (id: string, patch: Partial<Pick<Tag, "name" | "color" | "parentId">>) => Promise<TagActionResult>;
  moveTag: (id: string, parentId: string | undefined) => Promise<TagActionResult>;
  deleteTag: (id: string) => Promise<TagActionResult>;
  mergeTag: (sourceId: string, targetId: string) => Promise<TagActionResult>;
  deleteUnusedTags: () => Promise<TagActionResult>;
  restoreRejectedTagParent: (id: string, attempted: SyncEntity, authoritative: Tag | undefined, isSessionCurrent?: () => boolean) => Promise<void>;
  settleRejectedTagDeletion: (id: string, attempted: SyncEntity, isSessionCurrent?: () => boolean) => Promise<void>;
  importFromPlan: (plan: ImportPlan) => Promise<ImportCommitResult>;

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

interface PlannedTagAction {
  ok: true;
  plan: TagMutationPlan;
  tagId?: string;
}

function runTagAction(
  build: (tags: readonly Tag[]) => PlannedTagAction | Extract<TagActionResult, { ok: false }>,
  options: { unusedOnly?: boolean } = {},
): Promise<TagActionResult> {
  const isCurrent = tagMutationSession();
  return serializeTagMutation(async () => {
    if (!isCurrent()) { return { ok: false, error: "stale" }; }
    const planStore = usePlanStore.getState();
    if (options.unusedOnly) {
      try {
        await Promise.all([
          useBookmarksStore.getState().loadArchivedBookmarks(),
          useBookmarksStore.getState().loadTrashedBookmarks(),
        ]);
      } catch { return { ok: false, error: "storage" }; }
    }
    await planStore.ensureFresh();
    if (!isCurrent()) { return { ok: false, error: "stale" }; }
    const snapshot = useWorkspaceStore.getState().tags;
    const result = build(snapshot);
    if (!result.ok) { return result; }
    const { plan } = result;
    if (plan.upserts.length === 0 && plan.tombstones.length === 0) {
      return { ok: true, ...(result.tagId ? { tagId: result.tagId } : {}) };
    }
    const created = plan.upserts.filter(tag => !snapshot.some(existing => existing.id === tag.id)).length;
    if (created > 0 && !planStore.checkQuota("tag", snapshot.length + created - 1)) {
      planStore.showQuotaAlert("tag");
      return { ok: false, error: "quota" };
    }
    try {
      const committed = await commitTagMutation(plan, snapshot, () => isCurrent() &&
        useWorkspaceStore.getState().tags === snapshot &&
        (created === 0 || planStore.checkQuota("tag", snapshot.length + created - 1)), options);
      if (!isCurrent()) { return { ok: false, error: "stale" }; }
      const upserts = committed.tags.filter(tag => tag.deletedAt === undefined);
      const replacements = new Map(upserts.map(tag => [tag.id, tag]));
      const removed = new Set(committed.tags.filter(tag => tag.deletedAt !== undefined).map(tag => tag.id));
      const tags = snapshot.filter(tag => !removed.has(tag.id)).map(tag => replacements.get(tag.id) ?? tag);
      tags.push(...upserts.filter(tag => !snapshot.some(existing => existing.id === tag.id)));
      useWorkspaceStore.setState({ tags });
      if (created > 0) { planStore.incrementUsage("tag", created); }
      if (removed.size > 0) { planStore.decrementUsage("tag", removed.size); }
      const bookmarkChanges = committed.bookmarks;
      if (plan.replacements.size > 0) {
        useBookmarksStore.getState().applyTagReplacementChanges(bookmarkChanges, plan.replacements);
      }
      if (removed.size > 0 && options.unusedOnly) {
        useBookmarksStore.setState(state => ({ selectedTags: state.selectedTags.filter(id => !removed.has(id)) }));
      }
      const bookmarks = [
        ...bookmarkChanges.active.map(bookmark => toServerBookmark(bookmark)),
        ...bookmarkChanges.archived.map(bookmark => toServerBookmark(bookmark, { isArchived: true })),
        ...bookmarkChanges.trashed.map(bookmark => toServerBookmark(bookmark, {
          isTrashed: "isTrashed" in bookmark && bookmark.isTrashed === 2 ? 2 : 1,
        })),
      ];
      if (committed.tags.length > 0 || bookmarks.length > 0) {
        syncEngine?.enqueue({ tags: committed.tags.map(toServerTag), ...(bookmarks.length > 0 ? { bookmarks } : {}) });
      }
      return { ok: true, ...(result.tagId ? { tagId: result.tagId } : {}) };
    } catch (error) {
      if (error instanceof TagMutationStaleError) {
        if (isCurrent() && created > 0 && !planStore.checkQuota("tag", snapshot.length + created - 1)) {
          planStore.showQuotaAlert("tag");
          return { ok: false, error: "quota" };
        }
        if (isCurrent()) {
          try {
            const tags = await idbGetAll<Tag>("tags");
            if (isCurrent()) { useWorkspaceStore.setState({ tags: tags.filter(tag => tag.deletedAt === undefined) }); }
          } catch {
            return { ok: false, error: "storage" };
          }
        }
        return { ok: false, error: "stale" };
      }
      return { ok: false, error: "storage" };
    }
  });
}

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
  hydrate: () => {
    const isCurrent = tagMutationSession();
    return serializeTagMutation(async () => {
      if (!isCurrent()) { return; }
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

      if (!isCurrent()) { return; }
      set({
        workspaces,
        collections,
        tags: tags.filter(tag => tag.deletedAt === undefined),
        activeWorkspaceId,
        compactGroupTitles: compactKv?.value ?? true,
        localSeq: localSeqKv?.value ?? 0,
        _hydrated: true,
      });
    });
  },

  reset: () => {
    invalidateTagMutations();
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

  mergeFromServer: (resp) => {
    const isCurrent = tagMutationSession();
    return serializeTagMutation(async () => {
      if (!isCurrent()) { return { terminalWorkspaceIds: [], restoredWorkspaceIds: [] }; }
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

      // Tag pulls decide against durable records, including hidden pending tombstones.
      // Keep this separate from the workspace batch so a cross-context tag edit
      // cannot be overwritten between an IDB read and a later unconditional put.
      if (resp.entities.tags.length > 0) {
        await changePersistedTags((records) => {
          const byId = new Map(records.map(tag => [tag.id, tag]));
          const puts: Tag[] = [];
          const deletes: string[] = [];
          for (const serverTag of resp.entities.tags) {
            const local = byId.get(serverTag.id);
            if (local?.seq === 0) {
              if (local.deletedAt !== undefined && serverTag.deleted_at) {
                byId.delete(serverTag.id); deletes.push(serverTag.id);
              }
              continue;
            }
            if (serverTag.deleted_at) {
              byId.delete(serverTag.id); deletes.push(serverTag.id); continue;
            }
            const merged: Tag = {
              id: serverTag.id, name: serverTag.name, color: serverTag.color ?? local?.color ?? "",
              parentId: serverTag.parent_id === undefined ? local?.parentId : serverTag.parent_id || undefined,
              seq: serverTag.seq,
            };
            byId.set(merged.id, merged); puts.push(merged);
          }
          tags = [...byId.values()].filter(tag => tag.deletedAt === undefined);
          return { puts, deletes };
        }, isCurrent);
      }

      const currentActive = workspaces.find(
        (workspace) => workspace.id === current.activeWorkspaceId && isActiveWorkspace(workspace),
      );
      const activeWorkspaceId = currentActive?.id ?? chooseActiveWorkspace(workspaces)?.id ?? "";
      const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
      const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
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
      if (!isCurrent()) { return { terminalWorkspaceIds: [], restoredWorkspaceIds: [] }; }
      await idbBulkWrite(operations);
      if (!isCurrent()) { return { terminalWorkspaceIds: [], restoredWorkspaceIds: [] }; }
      set({ workspaces, collections, tags, activeWorkspaceId });
      return {
        terminalWorkspaceIds,
        restoredWorkspaceIds: [...restoredWorkspaceIds],
      };
    });
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
      const workspaces = state.workspaces.filter((workspace) => !workspaceDeletes.has(workspace.id));
      // A non-empty activeWorkspaceId may legitimately forward-reference a
      // Workspace this call doesn't itself materialize (e.g. a legacy
      // migration target that the immediately-following mergeFromServer
      // will merge in) — pass it through as-is. Only the empty-string
      // discard sentinel needs guarding: assigning "" verbatim while an
      // active Workspace already exists in state would strand the
      // dashboard empty until the next pull, so recompute instead.
      const nextActiveWorkspaceId =
        changes.activeWorkspaceId === "" ? chooseActiveWorkspace(workspaces)?.id ?? "" : changes.activeWorkspaceId;
      return {
        workspaces,
        collections,
        ...(nextActiveWorkspaceId === undefined ? {} : { activeWorkspaceId: nextActiveWorkspaceId }),
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
        // committed.workspaces is a raw IDB getAll() snapshot, not
        // necessarily a superset of current memory: a concurrent
        // permanentlyDeleteWorkspace optimistically removes its target from
        // state before its own IDB cleanup runs, and a wholesale replace
        // here would resurrect that row into the UI until the purge
        // confirms. Patch only rows still present in memory instead. Also
        // only adopt activeWorkspaceId for statuses that actually persisted
        // it — "missing"/"already_deleted" recompute a value for the
        // snapshot but never write it to kv, so adopting it here would
        // diverge from what's durable.
        set((state) => ({
          workspaces: state.workspaces.map((workspace) =>
            committed.workspaces.find((candidate) => candidate.id === workspace.id) ?? workspace,
          ),
          ...(committed.status === "committed" || committed.status === "last_active_workspace"
            ? { activeWorkspaceId: committed.activeWorkspaceId }
            : {}),
        }));
        if (committed.status === "committed") {
          usePlanStore.getState().moveUsageToTrash("workspace");
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
        usePlanStore.getState().restoreUsageFromTrash("workspace");
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
        // A fetchPlan() already in flight (e.g. the Workspace Manager's
        // ensurePlanFresh() on open) was necessarily started before this
        // purge confirmed, so its response can't reflect the released
        // quota — invalidate it so this call issues a fresh request rather
        // than reusing that stale in-flight promise.
        const plan = usePlanStore.getState();
        plan.invalidatePendingFetch();
        await plan.fetchPlan();
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
    usePlanStore.getState().moveUsageToTrash("collection");
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
    // Archived collections were never moved to trash (archived counts as
    // in-use), so only a trashed -> restored transition adjusts the split.
    if (col.deletedAt) {
      usePlanStore.getState().restoreUsageFromTrash("collection");
    }
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
  createTagPath: (input, color, parentId) => runTagAction((tags) => {
    const resolved = resolveTagPath(buildTagTree(tags, "en"), input, parentId, color, generateId);
    if (!resolved.ok) { return resolved; }
    return { ok: true, tagId: resolved.leaf.id, plan: { upserts: resolved.created, tombstones: [], replacements: new Map() } };
  }),

  updateTag: (id, patch) => runTagAction((tags) => {
    const tree = buildTagTree(tags, "en");
    const normalized = Object.prototype.hasOwnProperty.call(patch, "parentId")
      ? patch : { ...patch, parentId: tree.parentById.get(id) };
    return planTagEdit(tree, id, normalized);
  }),

  moveTag: (id, parentId) => get().updateTag(id, { parentId }),

  deleteTag: (id) => runTagAction(tags => planTagDeletion(buildTagTree(tags, "en"), [id], Date.now())),

  mergeTag: (sourceId, targetId) => runTagAction(tags => planTagMerge(buildTagTree(tags, "en"), sourceId, targetId, Date.now())),

  deleteUnusedTags: () => runTagAction(tags => {
    const bookmarks = useBookmarksStore.getState();
    const unused = unusedTagIds(buildTagTree(tags, "en"), [
      ...bookmarks.bookmarks.values(), ...bookmarks.archivedBookmarks, ...bookmarks.trashedBookmarks,
    ]);
    return { ok: true, plan: {
      upserts: [], replacements: new Map(),
      tombstones: tags.filter(tag => unused.has(tag.id)).map(tag => ({ ...tag, seq: 0, deletedAt: Date.now() })),
    } };
  }, { unusedOnly: true }),

  restoreRejectedTagParent: (id, attempted, authoritative, isSessionCurrent = () => true) => {
    const current = tagMutationSession();
    const isCurrent = () => current() && isSessionCurrent();
    return serializeTagMutation(async () => {
      if (!isCurrent()) { return; }
      await changePersistedTags((records) => {
        const local = records.find(tag => tag.id === id);
        if (!local || (local.parentId ?? "") !== (attempted.parent_id ?? "")) { return { puts: [], deletes: [] }; }
        if (authoritative?.deletedAt !== undefined) {
          return tagMatchesSyncEntity(local, attempted) ? { puts: [], deletes: [id] } : { puts: [], deletes: [] };
        }
        // An absent rejected parent must not discard a new child or its bookmark references.
        // Restore only the rejected edge. Later names/colors are still pending edits.
        return { puts: [{ ...local, parentId: authoritative?.parentId, seq: 0 }], deletes: [] };
      }, isCurrent);
      const tags = await idbGetAll<Tag>("tags");
      if (isCurrent()) {
        set({ tags: tags.filter(tag => tag.deletedAt === undefined) });
        const restored = tags.find(tag => tag.id === id && tag.seq === 0);
        if (restored) { syncEngine?.enqueue({ tags: [toServerTag(restored)] }); }
      }
    });
  },

  settleRejectedTagDeletion: (id, attempted, isSessionCurrent = () => true) => {
    const current = tagMutationSession();
    const isCurrent = () => current() && isSessionCurrent();
    return serializeTagMutation(async () => {
      if (!isCurrent()) { return; }
      // Caller must have confirmed authoritative absence; never infer it from invalid_state.
      await changePersistedTags((records) => {
        const local = records.find(tag => tag.id === id);
        return { puts: [], deletes: local?.seq === 0 && local.deletedAt !== undefined && tagMatchesSyncEntity(local, attempted) ? [id] : [] };
      }, isCurrent);
    });
  },

  importFromPlan: async (plan) => {
    const targetWorkspaceId = plan.collections[0]?.workspaceId;
    if (targetWorkspaceId) {
      const targetWorkspace = get().workspaces.find((w) => w.id === targetWorkspaceId);
      if (!isActiveWorkspace(targetWorkspace)) {
        return { ok: false, error: "target_unavailable" };
      }
    }

    const planStore = usePlanStore.getState();
    await planStore.ensureFresh();

    const bmStore = useBookmarksStore.getState();
    try {
      await Promise.all([bmStore.loadArchivedBookmarks(), bmStore.loadTrashedBookmarks()]);
    } catch {
      return { ok: false, error: "storage" };
    }
    const currentBookmarkCount = bmStore.bookmarks.size + bmStore.archivedBookmarks.length + bmStore.trashedBookmarks.length;

    if (
      plan.bookmarks.length > 0 &&
      !planStore.checkQuota("bookmark", currentBookmarkCount + plan.bookmarks.length - 1)
    ) {
      planStore.showQuotaAlert("bookmark");
      return { ok: false, error: "quota" };
    }

    const activeCollectionCount = get().collections.length;
    if (
      plan.collections.length > 0 &&
      !planStore.checkQuota("collection", activeCollectionCount + plan.collections.length - 1)
    ) {
      planStore.showQuotaAlert("collection");
      return { ok: false, error: "quota" };
    }

    const currentTags = get().tags;

    if (plan.provenance) {
      const limits = planStore.limits;
      const availableNow =
        limits?.max_tags === undefined || limits.max_tags === -1
          ? -1
          : Math.max(0, limits.max_tags - currentTags.length);

      let currentMode: "full" | "root-only" | "none";
      if (availableNow === -1 || plan.provenance.requestedTagCount <= availableNow) {
        currentMode = "full";
      } else if (availableNow >= 1) {
        currentMode = "root-only";
      } else {
        currentMode = "none";
      }

      if (currentMode !== plan.provenance.mode) {
        return { ok: false, error: "stale_plan" };
      }
    }

    const newTagsToCreate = plan.tags.filter((t) => !currentTags.some((existing) => existing.id === t.id));
    if (
      newTagsToCreate.length > 0 &&
      !planStore.checkQuota("tag", currentTags.length + newTagsToCreate.length - 1)
    ) {
      planStore.showQuotaAlert("tag");
      return { ok: false, error: "quota" };
    }

    for (const tag of plan.tags) {
      const colliding = currentTags.some(
        (existing) =>
          existing.parentId === tag.parentId &&
          existing.id !== tag.id &&
          normalizeTagName(existing.name) === normalizeTagName(tag.name),
      );
      if (colliding) {
        return { ok: false, error: "stale_plan" };
      }
    }

    // Recheck reused label IDs: any tag ID referenced by plan.bookmarks must exist in
    // plan.tags or in current active tags (excluding tombstones).
    const validTagIds = new Set<string>();
    for (const tag of plan.tags) {
      validTagIds.add(tag.id);
    }
    for (const tag of currentTags) {
      if (tag.deletedAt === undefined) {
        validTagIds.add(tag.id);
      }
    }

    for (const bookmark of plan.bookmarks) {
      for (const tagId of bookmark.tags) {
        if (!validTagIds.has(tagId)) {
          return { ok: false, error: "stale_plan" };
        }
      }
    }

    const newTags: Tag[] = plan.tags.map((t) => ({ ...t, seq: 0 as const }));
    const newCollections: Collection[] = plan.collections.map((c) => ({ ...c, seq: 0 as const }));
    const newBookmarks: Bookmark[] = plan.bookmarks.map((b) => ({ ...b, seq: 0 as const }));

    const ops: BulkWriteOp[] = [
      ...newTags.map((tag) => ({ type: "put" as const, store: "tags" as const, value: tag })),
      ...newCollections.map((col) => ({ type: "put" as const, store: "collections" as const, value: col })),
      ...newBookmarks.map((bm) => ({ type: "put" as const, store: "bookmarks" as const, value: bm })),
    ];

    try {
      await idbBulkWrite(ops);
    } catch {
      return { ok: false, error: "storage" };
    }

    if (newTags.length > 0) {
      set((s) => ({ tags: [...s.tags, ...newTags] }));
      planStore.incrementUsage("tag", newTags.length);
    }

    if (newCollections.length > 0) {
      set((s) => ({ collections: [...s.collections, ...newCollections] }));
      planStore.incrementUsage("collection", newCollections.length);
    }

    if (newBookmarks.length > 0) {
      useBookmarksStore.getState()._bulkAddBookmarks(newBookmarks);
      planStore.incrementUsage("bookmark", newBookmarks.length);
    }

    syncEngine?.enqueue({
      ...(newTags.length > 0 ? { tags: newTags.map(toServerTag) } : {}),
      ...(newCollections.length > 0 ? { collections: newCollections.map((c) => toServerCollection(c)) } : {}),
      ...(newBookmarks.length > 0 ? { bookmarks: newBookmarks.map((b) => toServerBookmark(b)) } : {}),
    });

    return {
      ok: true,
      collectionsCreated: newCollections.length,
      bookmarksImported: newBookmarks.length,
      tagsCreated: newTags.length,
      rootTagId: plan.provenance?.rootTagId,
    };
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
      const persistedTags = await idbGetAll<Tag>("tags");
      const ts = [...new Map([...tags, ...persistedTags].filter(t => t.seq === 0).map(tag => [tag.id, tag])).values()];
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
