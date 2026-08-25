import { beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";

if (process.env.TABSLATE_GUEST_RECONCILIATION_ISOLATED !== "1") {
  test("runs Guest reconciliation tests isolated from process-global module mocks", () => {
    const result = spawnSync(
      "bun",
      ["test", "test/guest-workspace-reconciliation.test.js"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, TABSLATE_GUEST_RECONCILIATION_ISOLATED: "1" },
      },
    );
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.status).toBe(0);
  });
} else {

const stores = new Map();
let transactionOperations = [];
let bulkWriteFailure = null;
let bulkWriteStarted = null;
let deferBulkWrite = false;
let releasePendingBulkWrite = null;

function records(store) {
  return stores.get(`${store}:all`) ?? [];
}

function replaceRecord(store, value) {
  const items = records(store).filter((item) => item.id !== value.id);
  stores.set(`${store}:all`, [...items, value]);
}

function deleteRecord(store, key) {
  stores.set(`${store}:all`, records(store).filter((item) => item.id !== key));
}

function applyOperations(operations) {
  for (const operation of operations) {
    if (operation.store === "kv") {
      if (operation.type === "delete") {
        stores.delete(`kv:${operation.key}`);
      } else {
        stores.set(`kv:${operation.value.key}`, operation.value);
      }
      continue;
    }
    if (operation.type === "delete") {
      deleteRecord(operation.store, operation.key);
    } else {
      replaceRecord(operation.store, operation.value);
    }
  }
}

mock.module("@/lib/idb", () => ({
  idbGet: async (store, key) => stores.get(`${store}:${key}`),
  idbGetAll: async (store) => stores.get(`${store}:all`) ?? [],
  idbCreateGuestWorkspaceIfEmpty: async () => false,
  idbPut: async (store, value) => stores.set(`${store}:${value.key}`, value),
  idbDelete: async (store, key) => stores.delete(`${store}:${key}`),
  idbBulkWrite: async (operations) => {
    transactionOperations = operations;
    bulkWriteStarted?.();
    if (deferBulkWrite) {
      await new Promise((resolve) => {
        releasePendingBulkWrite = resolve;
      });
    }
    if (bulkWriteFailure) {
      const failure = bulkWriteFailure;
      bulkWriteFailure = null;
      throw failure;
    }
    applyOperations(operations);
  },
  idbGetByIndex: async () => [],
  idbGetMany: async () => [],
  idbCount: async () => 0,
  idbTransaction: async () => {},
  idbUpdateKV: async (key, _decode, update) => {
    const current = stores.get(`kv:${key}`)?.value;
    const next = update(current);
    if (next === undefined) {
      stores.delete(`kv:${key}`);
      return;
    }
    stores.set(`kv:${key}`, { key, value: next });
  },
  clearDB: async () => {},
  getDB: async () => ({}),
}));

const {
  clearCapacityResolvedConflicts,
  confirmGuestWorkspaceFromPull,
  getPersistentSyncErrorKey,
  prepareGuestWorkspaceForPull,
  resolveLegacyGuestWorkspaceFailure,
  resolveGuestPushRejections,
} = await import("../lib/guest-workspace-reconciliation");
const { createGuestWorkspaceSeed } = await import("../lib/guest-workspace");
const { syncConflictRegistry } = await import("../lib/sync-conflicts");
const { useWorkspaceStore } = await import("../store/workspace-store");
const { registerSyncLifecycle, unregisterSyncLifecycle } = await import("../lib/sync-lifecycle");

function seedSnapshot(seed, extras = {}) {
  stores.set("kv:guest-workspace-provenance-v1", seed.provenance);
  stores.set("workspaces:all", [seed.workspace]);
  stores.set("collections:all", [seed.collection]);
  stores.set("bookmarks:all", extras.activeBookmarks ?? []);
  stores.set("archived-bookmarks:all", extras.archivedBookmarks ?? []);
  stores.set("trashed-bookmarks:all", extras.trashedBookmarks ?? []);
  stores.set("groups:all", extras.groups ?? []);
  stores.set("group-tabs:all", extras.groupTabs ?? []);
}

function remoteResponse(workspaces, collections = []) {
  return {
    entities: { workspaces, collections, bookmarks: [], tags: [], groups: [] },
    server_seq: 8,
  };
}

const accountWorkspace = {
  id: "account-workspace", user_id: "user", name: "Account", color: "blue", position: 0, seq: 3,
  created_at: 1, updated_at: 1,
};
const accountDefault = {
  id: "account-default", workspace_id: "account-workspace", name: "Default", icon: "inbox",
  position: 0, seq: 3, is_default: true, created_at: 1, updated_at: 1,
};

describe("guest workspace reconciliation", () => {
  beforeEach(async () => {
    stores.clear();
    transactionOperations = [];
    bulkWriteFailure = null;
    bulkWriteStarted = null;
    deferBulkWrite = false;
    releasePendingBulkWrite = null;
    await syncConflictRegistry.clearAllForManualRetry();
    useWorkspaceStore.setState({ workspaces: [], collections: [], activeWorkspaceId: "" });
  });

  test("retains the local guest workspace until a coordinator is available", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    seedSnapshot(seed);
    const result = await prepareGuestWorkspaceForPull({
      entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] },
      server_seq: 0,
    });
    expect(result).toMatchObject({ kind: "retained" });
  });

  test("discards an untouched seed when the pull contains another confirmed workspace", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    seedSnapshot(seed);

    const result = await prepareGuestWorkspaceForPull({
      entities: {
        workspaces: [accountWorkspace],
        collections: [accountDefault], bookmarks: [], tags: [], groups: [],
      },
      server_seq: 3,
    });
    expect(result).toMatchObject({ kind: "discarded" });
    expect(new Set(transactionOperations.map((operation) => operation.store))).toEqual(
      new Set(["workspaces", "collections", "kv"]),
    );
    expect(transactionOperations.some((operation) => operation.store === "tags")).toBe(false);
    expect(transactionOperations).toContainEqual({
      type: "delete", store: "kv", key: "activeWorkspaceId",
    });
    expect(stores.get("kv:guest-workspace-provenance-v1")).toBeUndefined();

    expect((await prepareGuestWorkspaceForPull(remoteResponse([accountWorkspace], [accountDefault]))).kind).toBe("none");
  });

  test("migrates every bookmark lifecycle bucket and groups without rewriting group tabs", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    const active = {
      id: "active", title: "Active", url: "https://active.example", description: "", favicon: "",
      collectionId: seed.collection.id, tags: [], createdAt: "1", isFavorite: false, seq: 0,
    };
    const archived = { ...active, id: "archived" };
    const trashed = { ...active, id: "trashed", deletedAt: 1 };
    const group = {
      id: "group", name: "Group", color: "blue", isCompact: false, createdAt: "1", seq: 0,
      workspaceId: seed.workspace.id,
    };
    seedSnapshot(seed, {
      activeBookmarks: [active], archivedBookmarks: [archived], trashedBookmarks: [trashed], groups: [group],
      groupTabs: [{ id: "tab", groupId: group.id, title: "Tab", url: "https://tab.example", favicon: "", position: 0 }],
    });
    useWorkspaceStore.setState({
      workspaces: [{ id: "account", name: "Account", color: "blue", position: 1, seq: 4 }],
      collections: [{
        id: "account-default", workspaceId: "account", name: "Default", icon: "inbox", position: 0,
        isDefault: true, seq: 4,
      }],
      activeWorkspaceId: "account",
    });

    const result = await resolveGuestPushRejections({
      server_seq: 4,
      rejected: [{ id: seed.workspace.id, type: "workspace", reason: "quota_exceeded" }],
    });
    expect(result).toMatchObject({ kind: "migrated", needsResweep: true, targetWorkspaceName: "Account" });

    expect(new Set(transactionOperations.map((operation) => operation.store))).toEqual(new Set([
      "workspaces", "collections", "bookmarks", "archived-bookmarks", "trashed-bookmarks", "groups", "kv",
    ]));
    expect(transactionOperations.some((operation) => operation.store === "group-tabs")).toBe(false);
  });

  test("does not apply guest store changes before its atomic transaction commits", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    seedSnapshot(seed);
    useWorkspaceStore.setState({ workspaces: [seed.workspace], collections: [seed.collection], activeWorkspaceId: seed.workspace.id });
    const started = new Promise((resolve) => { bulkWriteStarted = resolve; });
    deferBulkWrite = true;

    const reconciliation = prepareGuestWorkspaceForPull(remoteResponse([accountWorkspace], [accountDefault]));
    await started;
    expect(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id)).toContain(seed.workspace.id);

    releasePendingBulkWrite?.();
    await reconciliation;
    expect(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id)).not.toContain(seed.workspace.id);
  });

  test("leaves memory untouched when its atomic transaction rejects", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    seedSnapshot(seed);
    useWorkspaceStore.setState({ workspaces: [seed.workspace], collections: [seed.collection], activeWorkspaceId: seed.workspace.id });
    bulkWriteFailure = new Error("disk failed");

    await expect(prepareGuestWorkspaceForPull(remoteResponse([accountWorkspace], [accountDefault]))).rejects.toThrow("disk failed");
    expect(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id)).toContain(seed.workspace.id);
  });

  test("cancels its post-commit store apply after a registry reset", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    seedSnapshot(seed);
    useWorkspaceStore.setState({ workspaces: [seed.workspace], collections: [seed.collection], activeWorkspaceId: seed.workspace.id });
    const started = new Promise((resolve) => { bulkWriteStarted = resolve; });
    deferBulkWrite = true;

    const reconciliation = prepareGuestWorkspaceForPull(remoteResponse([accountWorkspace], [accountDefault]));
    await started;
    syncConflictRegistry.reset();
    releasePendingBulkWrite?.();

    expect((await reconciliation).kind).toBe("none");
    expect(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id)).toContain(seed.workspace.id);
  });

  test("retains meaningful guest data even when the account has a workspace", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    seedSnapshot(seed, { activeBookmarks: [{
      id: "bookmark", title: "Saved", url: "https://example.com", description: "", favicon: "",
      collectionId: seed.collection.id, tags: [], createdAt: "1", isFavorite: false, seq: 0,
    }] });

    expect((await prepareGuestWorkspaceForPull(remoteResponse([accountWorkspace], [accountDefault]))).kind).toBe("retained");
  });

  test("keeps a marked workspace when this pull already confirms it", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    seedSnapshot(seed);
    const confirmedSource = { ...accountWorkspace, id: seed.workspace.id, name: seed.workspace.name, seq: 4 };
    const response = remoteResponse([accountWorkspace, confirmedSource], [accountDefault]);

    expect((await prepareGuestWorkspaceForPull(response)).kind).toBe("retained");
    expect(stores.get("kv:guest-workspace-provenance-v1")).toEqual(seed.provenance);
    await confirmGuestWorkspaceFromPull(response);
    expect(stores.get("kv:guest-workspace-provenance-v1")).toBeUndefined();
  });

  test("deletes provenance only after its marked workspace is confirmed", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    seedSnapshot(seed);
    await confirmGuestWorkspaceFromPull(remoteResponse([accountWorkspace], [accountDefault]));
    expect(stores.get("kv:guest-workspace-provenance-v1")).toEqual(seed.provenance);

    await confirmGuestWorkspaceFromPull(remoteResponse([
      { ...accountWorkspace, id: seed.workspace.id, name: seed.workspace.name, seq: 4 },
    ], [accountDefault]));
    expect(stores.get("kv:guest-workspace-provenance-v1")).toBeUndefined();
  });

  test("records a conflict when only one provenance entity remains", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    seedSnapshot(seed);
    stores.set("collections:all", []);

    expect((await prepareGuestWorkspaceForPull(remoteResponse([accountWorkspace], [accountDefault]))).kind).toBe("conflict");
    expect(await getPersistentSyncErrorKey()).toBe("sync_invalidParentConflict");
  });

  test("blocks all local descendants when workspace quota has no migration target", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    const bookmark = {
      id: "bookmark", title: "Saved", url: "https://example.com", description: "", favicon: "",
      collectionId: seed.collection.id, tags: [], createdAt: "1", isFavorite: false, seq: 0,
    };
    const group = { id: "group", name: "Group", color: "blue", isCompact: false, createdAt: "1", seq: 0, workspaceId: seed.workspace.id };
    seedSnapshot(seed, { activeBookmarks: [bookmark], groups: [group] });

    const result = await resolveGuestPushRejections({
      server_seq: 3,
      rejected: [{ id: seed.workspace.id, type: "workspace", reason: "quota_exceeded" }],
    });

    expect(result.errorKey).toBe("sync_noMigrationTarget");
    expect(syncConflictRegistry.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "workspace", entityId: seed.workspace.id }),
      expect.objectContaining({ entityType: "collection", entityId: seed.collection.id, parentId: seed.workspace.id }),
      expect.objectContaining({ entityType: "bookmark", entityId: bookmark.id, parentId: seed.collection.id }),
      expect.objectContaining({ entityType: "saved_group", entityId: group.id, parentId: seed.workspace.id }),
    ]));
  });

  test("clears quota roots only for finite, zero, and unlimited capacity", async () => {
    await syncConflictRegistry.recordRejections([
      { id: "collection-a", type: "collection", reason: "quota_exceeded" },
      { id: "collection-b", type: "collection", reason: "quota_exceeded" },
      { id: "workspace-a", type: "workspace", reason: "quota_exceeded" },
      { id: "tag-a", type: "tag", reason: "quota_exceeded" },
      { id: "tag-b", type: "tag", reason: "quota_exceeded" },
    ]);
    const basePlan = {
      usage: { workspaces: 0, collections: 1, bookmarks: 0, tags: 0, saved_groups: 0 },
      limits: { max_workspaces: 0, max_collections: 2, max_bookmarks: 0, max_tags: -1, max_saved_groups: 0 },
    };

    expect(await clearCapacityResolvedConflicts(basePlan)).toBe(true);
    expect(syncConflictRegistry.isBlocked("collection", "collection-a")).toBe(false);
    expect(syncConflictRegistry.isBlocked("collection", "collection-b")).toBe(true);
    expect(syncConflictRegistry.isBlocked("workspace", "workspace-a")).toBe(true);
    expect(syncConflictRegistry.isBlocked("tag", "tag-a")).toBe(false);
    expect(syncConflictRegistry.isBlocked("tag", "tag-b")).toBe(false);
  });

  test("wakes a quarantined Workspace lifecycle when plan refresh observes capacity", async () => {
    stores.set("kv:workspace-lifecycle-intents-v1", {
      key: "workspace-lifecycle-intents-v1",
      value: {
        version: 1,
        intents: [{
          workspaceId: "guest-workspace",
          action: "delete",
          baseSeq: 0,
          previousActiveWorkspaceId: "account-workspace",
          createdAt: 100,
        }],
      },
    });
    await syncConflictRegistry.recordRejections([{
      id: "guest-workspace",
      type: "workspace",
      reason: "quota_exceeded",
    }]);
    const wakes = [];
    const lifecycle = {
      async retire() {},
      async wakeWorkspaceLifecycle(workspaceId) {
        wakes.push(workspaceId);
      },
    };
    registerSyncLifecycle(lifecycle);
    try {
      await clearCapacityResolvedConflicts({
        usage: { workspaces: 0, collections: 0, bookmarks: 0, tags: 0, saved_groups: 0 },
        limits: { max_workspaces: 1, max_collections: 0, max_bookmarks: 0, max_tags: 0, max_saved_groups: 0 },
      });
      await Promise.resolve();
    } finally {
      unregisterSyncLifecycle(lifecycle);
    }

    expect(wakes).toEqual(["guest-workspace"]);
  });

  test("prioritizes invalid parent conflicts over unrelated quota roots", async () => {
    await syncConflictRegistry.recordRejections([
      { id: "workspace", type: "workspace", reason: "quota_exceeded" },
      { id: "collection", type: "collection", reason: "invalid_parent" },
    ]);
    expect(await getPersistentSyncErrorKey()).toBe("sync_invalidParentConflict");
  });

  test("legacy recovery requires every evidence condition and converts untouched discard into migration", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    const fullPlan = {
      usage: { workspaces: 1, collections: 0, bookmarks: 0, tags: 0, saved_groups: 0 },
      limits: { max_workspaces: 1, max_collections: 0, max_bookmarks: 0, max_tags: 0, max_saved_groups: 0 },
    };
    const remote = remoteResponse([accountWorkspace], [accountDefault]);
    const cases = [
      { plan: fullPlan, remote: remoteResponse([{ ...accountWorkspace, id: seed.workspace.id }], [accountDefault]) },
      { plan: fullPlan, remote: remoteResponse([], []) },
      { plan: { ...fullPlan, limits: { ...fullPlan.limits, max_workspaces: -1 } }, remote },
      { plan: { ...fullPlan, usage: { ...fullPlan.usage, workspaces: 0 } }, remote },
    ];
    for (const evidence of cases) {
      seedSnapshot(seed);
      expect((await resolveLegacyGuestWorkspaceFailure(evidence.plan, evidence.remote)).kind).toBe("none");
    }

    seedSnapshot(seed);
    useWorkspaceStore.setState({ workspaces: [seed.workspace], collections: [seed.collection], activeWorkspaceId: seed.workspace.id });
    const result = await resolveLegacyGuestWorkspaceFailure(fullPlan, remote);
    expect(result).toMatchObject({ kind: "migrated", needsResweep: true, targetWorkspaceName: "Account" });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(accountWorkspace.id);
    expect(stores.get("kv:activeWorkspaceId")).toEqual({ key: "activeWorkspaceId", value: accountWorkspace.id });
    expect(stores.get("kv:guest-workspace-provenance-v1")).toBeUndefined();
  });

  test("quarantines a deleted automatic Guest seed intact when Workspace capacity is unavailable", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    seed.workspace.deletedAt = 1200;
    seed.workspace.deletionModel = 0;
    const bookmark = {
      id: "bookmark", title: "Saved", url: "https://example.com", description: "", favicon: "",
      collectionId: seed.collection.id, tags: [], createdAt: "1", isFavorite: false, seq: 0,
      deletedAt: 1200,
    };
    const group = {
      id: "group", name: "Group", color: "blue", isCompact: false, createdAt: "1", seq: 0,
      workspaceId: seed.workspace.id, deletedAt: 1200,
    };
    seedSnapshot(seed, { trashedBookmarks: [bookmark], groups: [group] });
    stores.set("kv:workspace-lifecycle-intents-v1", {
      key: "workspace-lifecycle-intents-v1",
      value: {
        version: 1,
        intents: [{
          workspaceId: seed.workspace.id,
          action: "delete",
          baseSeq: 0,
          previousActiveWorkspaceId: "account-workspace",
          createdAt: 1200,
        }],
      },
    });
    useWorkspaceStore.setState({
      workspaces: [seed.workspace, {
        id: "account-workspace", name: "Account", color: "blue", position: 1, seq: 3,
      }],
      collections: [seed.collection, {
        id: "account-default", workspaceId: "account-workspace", name: "Default", icon: "inbox",
        position: 0, isDefault: true, seq: 3,
      }],
      activeWorkspaceId: "account-workspace",
    });
    const fullPlan = {
      usage: { workspaces: 1, collections: 0, bookmarks: 0, tags: 0, saved_groups: 0 },
      limits: { max_workspaces: 1, max_collections: 0, max_bookmarks: 0, max_tags: 0, max_saved_groups: 0 },
    };

    const result = await resolveLegacyGuestWorkspaceFailure(
      fullPlan,
      remoteResponse([accountWorkspace], [accountDefault]),
    );

    expect(result).toMatchObject({ kind: "conflict", needsResweep: false, errorKey: "sync_noMigrationTarget" });
    expect(stores.get("workspaces:all")).toContainEqual(seed.workspace);
    expect(stores.get("collections:all")).toContainEqual(seed.collection);
    expect(stores.get("trashed-bookmarks:all")).toContainEqual(bookmark);
    expect(stores.get("groups:all")).toContainEqual(group);
    expect(stores.get("kv:guest-workspace-provenance-v1")).toEqual(seed.provenance);
    expect(stores.get("kv:workspace-lifecycle-intents-v1").value.intents).toHaveLength(1);
    expect(stores.get("kv:workspace-lifecycle-deferred-sync-v1").value.payloadsByWorkspaceId)
      .toHaveProperty(seed.workspace.id);
    expect(syncConflictRegistry.list()).toContainEqual(expect.objectContaining({
      entityType: "workspace",
      entityId: seed.workspace.id,
      reason: "quota_exceeded",
    }));
    expect(transactionOperations.some((operation) =>
      operation.type === "delete" &&
      (operation.store === "workspaces" || operation.store === "collections"),
    )).toBe(false);
  });
});
}
