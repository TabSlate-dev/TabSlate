import { beforeEach, describe, expect, mock, test } from "bun:test";

const idbDeleteCalls = [];
const idbPutCalls = [];
const idbBulkWriteCalls = [];
const lifecycleCommitCalls = [];
const wakeCalls = [];
const guestRollbackCalls = [];
const syncEnqueueCalls = [];
const planCalls = [];
const lifecycleConcurrencyEvents = [];

let idbBulkWriteImpl;
let generatedIds;
let guestSeedCreated = false;
let persistedGuestSeed = false;
let guestSeedHasAdditionalCollection = false;
let storedWorkspaces = [];
let storedCollections = [];
let storedTags = [];
let storedKv = new Map();
let lifecycleIntents = [];
let authState;
let capabilitySupported = true;
let capabilityReadImpl;
let intentReadImpl;
let purgeImpl;
let aggregateCleanupIds;
let deleteTransactionTail = Promise.resolve();
let heldLifecycleLocks = new Map();
let releaseLockImpl;

mock.module("@/lib/idb", () => ({
  idbGetAll: async (store) => {
    if (store === "workspaces") { return structuredClone(storedWorkspaces); }
    if (store === "collections") { return structuredClone(storedCollections); }
    if (store === "tags") { return structuredClone(storedTags); }
    return [];
  },
  idbGet: async (store, key) => {
    if (store !== "kv") { return undefined; }
    if (key === "workspace-lifecycle-intents-v1") {
      if (intentReadImpl) {
        return intentReadImpl(key);
      }
      return {
        key,
        value: { version: 1, intents: structuredClone(lifecycleIntents) },
      };
    }
    if (key.startsWith("workspace-parent-tombstone-capability-v1:")) {
      if (capabilityReadImpl) {
        return capabilityReadImpl(key);
      }
      return capabilitySupported
        ? {
            key,
            value: {
              version: 1,
              userId: authState.user?.id ?? "",
              serverOrigin: "https://server.test",
              supported: true,
              observedAt: 1,
            },
          }
        : undefined;
    }
    const value = storedKv.get(key);
    return value === undefined ? undefined : structuredClone(value);
  },
  idbGetByIndex: async () => [],
  idbGetMany: async () => [],
  idbPut: async (store, value) => {
    idbPutCalls.push({ store, value: structuredClone(value) });
  },
  idbDelete: async (store, key) => {
    idbDeleteCalls.push({ store, key });
  },
  idbBulkWrite: async (ops) => {
    idbBulkWriteCalls.push(structuredClone(ops));
    return idbBulkWriteImpl(ops);
  },
  idbCommitWorkspaceLifecycleIntent: async (input) => {
    lifecycleCommitCalls.push(structuredClone(input));
    if (input.intent.action === "delete") {
      lifecycleConcurrencyEvents.push(`delete-commit:${input.workspace.id}`);
    }
    const index = storedWorkspaces.findIndex((item) => item.id === input.workspace.id);
    if (index === -1) {
      storedWorkspaces.push(structuredClone(input.workspace));
    } else {
      storedWorkspaces[index] = structuredClone(input.workspace);
    }
    if (input.activeWorkspaceId !== undefined) {
      storedKv.set("activeWorkspaceId", {
        key: "activeWorkspaceId",
        value: input.activeWorkspaceId,
      });
    }
    lifecycleIntents = [
      ...lifecycleIntents.filter((intent) => intent.workspaceId !== input.intent.workspaceId),
      structuredClone(input.intent),
    ];
  },
  idbCommitWorkspaceDeleteLifecycleIntent: (input) => {
    const commit = deleteTransactionTail.then(() => {
      const target = storedWorkspaces.find((item) => item.id === input.workspaceId);
      const activeWorkspaces = storedWorkspaces.filter((item) => item.deletedAt === undefined);
      const persistedActiveId = storedKv.get("activeWorkspaceId")?.value ?? "";
      const persistedActive = activeWorkspaces.find((item) => item.id === persistedActiveId);
      const currentActive = persistedActive ?? activeWorkspaces
        .slice()
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))[0];
      const currentActiveId = currentActive?.id ?? "";
      const snapshot = (status) => ({
        status,
        workspaces: structuredClone(storedWorkspaces),
        activeWorkspaceId: currentActiveId,
      });
      if (!target) {
        return snapshot("missing");
      }
      if (target.deletedAt !== undefined) {
        return snapshot("already_deleted");
      }
      if (activeWorkspaces.length <= 1) {
        return snapshot("last_active_workspace");
      }
      const replacement = currentActive?.id !== target.id
        ? currentActive
        : activeWorkspaces
          .filter((item) => item.id !== target.id)
          .sort((a, b) =>
            Math.abs(a.position - target.position) - Math.abs(b.position - target.position) ||
            a.position - b.position ||
            a.id.localeCompare(b.id)
          )[0];
      if (!replacement) {
        return snapshot("last_active_workspace");
      }
      const workspace = { ...target, deletedAt: input.createdAt, seq: 0 };
      const intent = {
        workspaceId: target.id,
        action: "delete",
        baseSeq: target.seq,
        previousActiveWorkspaceId: currentActiveId,
        createdAt: input.createdAt,
      };
      storedWorkspaces = storedWorkspaces.map((item) => item.id === target.id ? workspace : item);
      storedKv.set("activeWorkspaceId", { key: "activeWorkspaceId", value: replacement.id });
      lifecycleIntents = [
        ...lifecycleIntents.filter((candidate) => candidate.workspaceId !== target.id),
        intent,
      ];
      lifecycleCommitCalls.push(structuredClone({
        workspace,
        intent,
        activeWorkspaceId: replacement.id,
      }));
      lifecycleConcurrencyEvents.push(`delete-commit:${target.id}`);
      return {
        status: "committed",
        workspaces: structuredClone(storedWorkspaces),
        activeWorkspaceId: replacement.id,
      };
    });
    deleteTransactionTail = commit.then(() => undefined, () => undefined);
    return commit;
  },
  idbTryAcquireLock: async (key, owner, expiresAt) => {
    const current = heldLifecycleLocks.get(key);
    if (current && current.owner !== owner && current.expiresAt > Date.now()) {
      return false;
    }
    heldLifecycleLocks.set(key, { owner, expiresAt });
    return true;
  },
  idbRenewLock: async (key, owner, expiresAt) => {
    const current = heldLifecycleLocks.get(key);
    if (!current || current.owner !== owner || current.expiresAt <= Date.now()) {
      return false;
    }
    heldLifecycleLocks.set(key, { owner, expiresAt });
    return true;
  },
  idbReleaseLock: async (key, owner) => {
    if (heldLifecycleLocks.get(key)?.owner === owner) {
      heldLifecycleLocks.delete(key);
    }
    return releaseLockImpl();
  },
  idbCreateGuestWorkspaceIfEmpty: async (workspace, collection, activeWorkspace, provenance) => {
    if (guestSeedCreated) {
      return false;
    }
    const ops = [
      { type: "put", store: "workspaces", value: workspace },
      { type: "put", store: "collections", value: collection },
      { type: "put", store: "kv", value: activeWorkspace },
      { type: "put", store: "kv", value: provenance },
    ];
    idbBulkWriteCalls.push(structuredClone(ops));
    await idbBulkWriteImpl(ops);
    guestSeedCreated = true;
    persistedGuestSeed = true;
    return true;
  },
  idbRollbackGuestWorkspaceIfUnchanged: async (workspace, collection, provenance) => {
    guestRollbackCalls.push({ workspace, collection, provenance });
    if (guestSeedHasAdditionalCollection) {
      return false;
    }
    persistedGuestSeed = false;
    return true;
  },
}));

mock.module("@/lib/sync-engine", () => ({
  syncEngine: {
    enqueue: (...args) => {
      syncEnqueueCalls.push(structuredClone(args));
      const workspaceIds = args[0].workspaces?.map((workspace) => workspace.id) ?? [];
      lifecycleConcurrencyEvents.push(`enqueue:${workspaceIds.join(",")}`);
    },
  },
}));

mock.module("@/lib/workspace-aggregate", () => ({
  clearWorkspaceAggregate: async (_workspaceId, onCommitted) => {
    if (aggregateCleanupIds) {
      onCommitted(structuredClone(aggregateCleanupIds));
    }
    return structuredClone(aggregateCleanupIds);
  },
}));

mock.module("@/store/auth-store", () => ({
  useAuthStore: { getState: () => authState },
}));

mock.module("@/store/plan-store", () => ({
  usePlanStore: {
    getState: () => ({
      decrementUsage: (resource, count) => { planCalls.push(["decrement", resource, count]); },
      incrementUsage: (resource, count) => { planCalls.push(["increment", resource, count]); },
      moveUsageToTrash: (resource, count) => { planCalls.push(["moveToTrash", resource, count]); },
      restoreUsageFromTrash: (resource, count) => { planCalls.push(["restoreFromTrash", resource, count]); },
      ensureFresh: async () => {},
      showQuotaAlert: () => {},
      fetchPlan: async () => { planCalls.push(["fetch"]); },
      usage: { bookmarks: 0 },
      limits: null,
    }),
  },
  guardQuota: (_resource, _currentCount, fallback, fn) => fn() ?? fallback,
}));

mock.module("@/lib/id", () => ({
  generateId: () => generatedIds.shift(),
}));

const { useWorkspaceStore } = await import("../store/workspace-store");
const { useWorkspaceStore: useFirstContextWorkspaceStore } = await import(
  "../store/workspace-store.ts?test-context=first"
);
const { useWorkspaceStore: useSecondContextWorkspaceStore } = await import(
  "../store/workspace-store.ts?test-context=second"
);
const { useBookmarksStore } = await import("../store/bookmarks-store");
const { useGroupsStore } = await import("../store/groups-store");
const { registerSyncLifecycle, unregisterSyncLifecycle } = await import("../lib/sync-lifecycle");
const lifecycleRuntime = {
  async retire() {},
  async wakeWorkspaceLifecycle(workspaceId) {
    wakeCalls.push(workspaceId);
  },
  async purgeWorkspace(workspaceId) {
    return purgeImpl(workspaceId);
  },
};

function workspace(id, position, overrides = {}) {
  return { id, name: id, color: "blue", position, seq: 7, ...overrides };
}

function collection(id, workspaceId, overrides = {}) {
  return { id, workspaceId, name: id, icon: "folder", position: 0, seq: 5, ...overrides };
}

function bookmark(id, collectionId, overrides = {}) {
  return {
    id,
    title: id,
    url: `https://${id}.test`,
    description: "description",
    favicon: "favicon",
    collectionId,
    tags: ["tag-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    isFavorite: false,
    seq: 0,
    ...overrides,
  };
}

function savedGroup(id, workspaceId, overrides = {}) {
  return {
    id,
    name: id,
    color: "blue",
    isCompact: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 0,
    workspaceId,
    ...overrides,
  };
}

function serverWorkspace(id, position, state, overrides = {}) {
  return {
    id,
    user_id: "user-1",
    name: id,
    color: "blue",
    position,
    seq: 50 + position,
    is_deleted: state,
    deletion_model: 1,
    created_at: 1,
    updated_at: 2,
    ...(state === 1 ? { deleted_at: 9000 + position } : {}),
    ...overrides,
  };
}

function pullResponse(workspaces) {
  return {
    entities: { workspaces, collections: [], bookmarks: [], tags: [], groups: [] },
    server_seq: 80,
  };
}

describe("workspace lifecycle store", () => {
  beforeEach(() => {
    unregisterSyncLifecycle(lifecycleRuntime);
    registerSyncLifecycle(lifecycleRuntime);
    idbDeleteCalls.length = 0;
    idbPutCalls.length = 0;
    idbBulkWriteCalls.length = 0;
    lifecycleCommitCalls.length = 0;
    wakeCalls.length = 0;
    guestRollbackCalls.length = 0;
    syncEnqueueCalls.length = 0;
    planCalls.length = 0;
    lifecycleConcurrencyEvents.length = 0;
    idbBulkWriteImpl = async () => {};
    generatedIds = ["generated-id", "generated-collection-id"];
    guestSeedCreated = false;
    persistedGuestSeed = false;
    guestSeedHasAdditionalCollection = false;
    storedWorkspaces = [];
    storedCollections = [];
    storedTags = [];
    storedKv = new Map();
    lifecycleIntents = [];
    authState = { user: null, accessToken: null, serverUrl: "https://server.test" };
    capabilitySupported = true;
    capabilityReadImpl = undefined;
    intentReadImpl = undefined;
    purgeImpl = async () => ({ status: "completed" });
    aggregateCleanupIds = undefined;
    deleteTransactionTail = Promise.resolve();
    heldLifecycleLocks = new Map();
    releaseLockImpl = async () => {};
    useWorkspaceStore.setState({
      workspaces: [],
      collections: [],
      tags: [],
      activeWorkspaceId: "",
      _hydrated: false,
    });
    useFirstContextWorkspaceStore.setState({
      workspaces: [],
      collections: [],
      tags: [],
      activeWorkspaceId: "",
      _hydrated: false,
    });
    useSecondContextWorkspaceStore.setState({
      workspaces: [],
      collections: [],
      tags: [],
      activeWorkspaceId: "",
      _hydrated: false,
    });
    useBookmarksStore.setState({
      bookmarks: new Map(),
      countsByCollection: {},
      archivedBookmarks: [],
      trashedBookmarks: [],
      _archivedLoaded: true,
      _trashedLoaded: true,
    });
    useGroupsStore.setState({ groups: [], groupTabs: [] });
  });

  test("initializes one guest workspace atomically when called concurrently", async () => {
    let resolveBulkWrite;
    idbBulkWriteImpl = () => new Promise((resolve) => { resolveBulkWrite = resolve; });
    generatedIds = ["guest-workspace-id", "guest-collection-id"];
    const first = useWorkspaceStore.getState().initializeGuestWorkspace();
    const second = useWorkspaceStore.getState().initializeGuestWorkspace();
    await Promise.resolve();
    expect(idbBulkWriteCalls).toHaveLength(1);
    expect(useWorkspaceStore.getState().workspaces).toEqual([]);
    if (!resolveBulkWrite) { throw new Error("idbBulkWrite was not called"); }
    resolveBulkWrite();
    await Promise.all([first, second]);
    expect(useWorkspaceStore.getState().workspaces.map((item) => item.id)).toEqual(["guest-workspace-id"]);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("guest-workspace-id");
  });

  test("does not apply a delayed guest seed after its session is no longer current", async () => {
    let resolveBulkWrite;
    idbBulkWriteImpl = () => new Promise((resolve) => { resolveBulkWrite = resolve; });
    generatedIds = ["guest-workspace-id", "guest-collection-id"];
    let sessionCurrent = true;
    const initialization = useWorkspaceStore.getState().initializeGuestWorkspace({
      isSessionCurrent: () => sessionCurrent,
    });
    await Promise.resolve();
    sessionCurrent = false;
    useWorkspaceStore.setState({
      workspaces: [workspace("account-workspace", 0)],
      collections: [collection("account-default", "account-workspace", { isDefault: true })],
      activeWorkspaceId: "account-workspace",
    });
    if (!resolveBulkWrite) { throw new Error("idbBulkWrite was not called"); }
    resolveBulkWrite();
    await initialization;
    expect(useWorkspaceStore.getState().workspaces.map((item) => item.id)).toEqual(["account-workspace"]);
    expect(guestRollbackCalls).toHaveLength(1);
    expect(persistedGuestSeed).toBe(false);
  });

  test("does not roll back a stale seed after another collection was created in its workspace", async () => {
    let resolveBulkWrite;
    idbBulkWriteImpl = () => new Promise((resolve) => { resolveBulkWrite = resolve; });
    generatedIds = ["guest-workspace-id", "guest-collection-id"];
    let sessionCurrent = true;
    const initialization = useWorkspaceStore.getState().initializeGuestWorkspace({
      isSessionCurrent: () => sessionCurrent,
    });
    await Promise.resolve();
    sessionCurrent = false;
    guestSeedHasAdditionalCollection = true;
    if (!resolveBulkWrite) { throw new Error("idbBulkWrite was not called"); }
    resolveBulkWrite();
    await initialization;
    expect(guestRollbackCalls).toHaveLength(1);
    expect(persistedGuestSeed).toBe(true);
  });

  test("delete commits only the root tombstone, intent, and nearest active replacement", async () => {
    const target = workspace("workspace-target", 5);
    const lower = workspace("workspace-lower", 3);
    const upper = workspace("workspace-upper", 7);
    const targetCollection = collection("collection-target", target.id, { archivedAt: 1234 });
    const activeBookmark = { id: "bookmark-active", collectionId: targetCollection.id, seq: 0 };
    const archivedBookmark = { id: "bookmark-archived", collectionId: targetCollection.id, seq: 4 };
    const trashedBookmark = { id: "bookmark-trashed", collectionId: targetCollection.id, seq: 5, deletedAt: 333 };
    const savedGroup = { id: "group-target", workspaceId: target.id, seq: 2, deletedAt: 444 };
    const groupTab = { id: "tab-target", groupId: savedGroup.id, title: "Tab" };
    useBookmarksStore.setState({
      bookmarks: new Map([[activeBookmark.id, activeBookmark]]),
      archivedBookmarks: [archivedBookmark],
      trashedBookmarks: [trashedBookmark],
    });
    useGroupsStore.setState({ groups: [savedGroup], groupTabs: [groupTab] });
    useWorkspaceStore.setState({
      workspaces: [target, upper, lower],
      collections: [targetCollection],
      activeWorkspaceId: target.id,
    });
    storedWorkspaces = structuredClone([target, upper, lower]);
    storedKv.set("activeWorkspaceId", { key: "activeWorkspaceId", value: target.id });
    const childSnapshot = structuredClone({
      collections: useWorkspaceStore.getState().collections,
      bookmarks: useBookmarksStore.getState().bookmarks,
      archivedBookmarks: useBookmarksStore.getState().archivedBookmarks,
      trashedBookmarks: useBookmarksStore.getState().trashedBookmarks,
      groups: useGroupsStore.getState().groups,
      groupTabs: useGroupsStore.getState().groupTabs,
    });

    const result = await useWorkspaceStore.getState().deleteWorkspace(target.id);

    expect(result).toEqual({ status: "queued" });
    expect(lifecycleCommitCalls).toHaveLength(1);
    expect(lifecycleCommitCalls[0]).toEqual({
      workspace: { ...target, deletedAt: expect.any(Number), seq: 0 },
      intent: {
        workspaceId: target.id,
        action: "delete",
        baseSeq: 7,
        previousActiveWorkspaceId: target.id,
        createdAt: expect.any(Number),
      },
      activeWorkspaceId: lower.id,
    });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(lower.id);
    expect(useWorkspaceStore.getState().getDeletedWorkspaces().map((item) => item.id)).toEqual([target.id]);
    expect({
      collections: useWorkspaceStore.getState().collections,
      bookmarks: useBookmarksStore.getState().bookmarks,
      archivedBookmarks: useBookmarksStore.getState().archivedBookmarks,
      trashedBookmarks: useBookmarksStore.getState().trashedBookmarks,
      groups: useGroupsStore.getState().groups,
      groupTabs: useGroupsStore.getState().groupTabs,
    }).toEqual(childSnapshot);
    expect(idbDeleteCalls).toEqual([]);
    expect(syncEnqueueCalls).toEqual([]);
    expect(wakeCalls).toEqual([target.id]);
    // Soft delete never releases quota; it moves the root into the trash
    // bucket of the retained/in-use split shown in the quota UI.
    expect(planCalls).toEqual([["moveToTrash", "workspace", undefined]]);
  });

  test("delete blocks the final active workspace without writing anything", async () => {
    const only = workspace("workspace-only", 0);
    useWorkspaceStore.setState({ workspaces: [only], activeWorkspaceId: only.id });
    storedWorkspaces = structuredClone([only]);
    storedKv.set("activeWorkspaceId", { key: "activeWorkspaceId", value: only.id });
    const result = await useWorkspaceStore.getState().deleteWorkspace(only.id);
    expect(result).toEqual({ status: "blocked", reason: "last_active_workspace" });
    expect(lifecycleCommitCalls).toEqual([]);
    expect(wakeCalls).toEqual([]);
    expect(useWorkspaceStore.getState().workspaces).toEqual([only]);
  });

  test("concurrent deletes serialize the active-count decision and leave one durable active root", async () => {
    const first = workspace("workspace-first", 0);
    const second = workspace("workspace-second", 1);
    storedWorkspaces = structuredClone([first, second]);
    storedKv.set("activeWorkspaceId", { key: "activeWorkspaceId", value: first.id });
    authState = {
      user: { id: "user-1" },
      accessToken: null,
      serverUrl: "https://server.test",
    };
    useFirstContextWorkspaceStore.setState({ workspaces: [first, second], activeWorkspaceId: first.id });
    useSecondContextWorkspaceStore.setState({ workspaces: [first, second], activeWorkspaceId: first.id });
    let releaseCapability;
    const capabilityGate = new Promise((resolve) => { releaseCapability = resolve; });
    let capabilityReads = 0;
    let observeFirstRead;
    const firstRead = new Promise((resolve) => { observeFirstRead = resolve; });
    capabilityReadImpl = async (key) => {
      capabilityReads += 1;
      observeFirstRead();
      await capabilityGate;
      return {
        key,
        value: {
          version: 1,
          userId: "user-1",
          serverOrigin: "https://server.test",
          supported: true,
          observedAt: 1,
        },
      };
    };

    const deletingFirst = useFirstContextWorkspaceStore.getState().deleteWorkspace(first.id);
    const deletingSecond = useSecondContextWorkspaceStore.getState().deleteWorkspace(second.id);
    await firstRead;
    await Promise.resolve();
    await Promise.resolve();

    expect(capabilityReads).toBe(2);
    if (!releaseCapability) { throw new Error("capability read was not blocked"); }
    releaseCapability();
    const results = await Promise.all([deletingFirst, deletingSecond]);

    expect(results.map((result) => result.status).sort()).toEqual(["blocked", "queued"]);
    expect(lifecycleCommitCalls).toHaveLength(1);
    const firstContextActiveRoots = useFirstContextWorkspaceStore.getState().getActiveWorkspaces();
    const secondContextActiveRoots = useSecondContextWorkspaceStore.getState().getActiveWorkspaces();
    expect(firstContextActiveRoots).toHaveLength(1);
    expect(secondContextActiveRoots).toHaveLength(1);
    expect(useFirstContextWorkspaceStore.getState().activeWorkspaceId).toBe(firstContextActiveRoots[0]?.id);
    expect(useSecondContextWorkspaceStore.getState().activeWorkspaceId).toBe(secondContextActiveRoots[0]?.id);
    const activeDurableRoots = storedWorkspaces.filter((item) => item.deletedAt === undefined);
    expect(activeDurableRoots).toHaveLength(1);
    expect(storedKv.get("activeWorkspaceId")?.value).toBe(activeDurableRoots[0]?.id);
  });

  test("hydrate retains deleted roots but replaces a deleted active selection", async () => {
    storedWorkspaces = [
      workspace("workspace-deleted", 0, { deletedAt: 5000 }),
      workspace("workspace-active", 1),
    ];
    storedCollections = [
      collection("deleted-default", "workspace-deleted", { isDefault: true }),
      collection("active-default", "workspace-active"),
    ];
    storedKv.set("activeWorkspaceId", { key: "activeWorkspaceId", value: "workspace-deleted" });
    await useWorkspaceStore.getState().hydrate();
    expect(useWorkspaceStore.getState().workspaces).toEqual(storedWorkspaces);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("workspace-active");
    expect(useWorkspaceStore.getState().collections.find((item) => item.id === "active-default")?.isDefault).toBe(true);
    expect(idbPutCalls).toContainEqual({
      store: "kv",
      value: { key: "activeWorkspaceId", value: "workspace-active" },
    });
  });

  test("pending local delete wins over an older active server root", async () => {
    const local = workspace("workspace-target", 0, { seq: 0, deletedAt: 1234 });
    lifecycleIntents = [{ workspaceId: local.id, action: "delete", baseSeq: 7, previousActiveWorkspaceId: "workspace-other", createdAt: 1234 }];
    useWorkspaceStore.setState({
      workspaces: [local, workspace("workspace-other", 1)],
      activeWorkspaceId: "workspace-other",
    });
    await useWorkspaceStore.getState().mergeFromServer(
      pullResponse([serverWorkspace(local.id, 0, 0, { name: "older-server-name", seq: 12 })]),
    );
    expect(useWorkspaceStore.getState().workspaces.find((item) => item.id === local.id)).toEqual(local);
  });

  test("pending local restore wins over an older retained server root", async () => {
    const local = workspace("workspace-target", 0, { seq: 0 });
    lifecycleIntents = [{ workspaceId: local.id, action: "restore", baseSeq: 7, previousActiveWorkspaceId: "workspace-other", createdAt: 1234 }];
    useWorkspaceStore.setState({
      workspaces: [local, workspace("workspace-other", 1)],
      activeWorkspaceId: "workspace-other",
    });
    await useWorkspaceStore.getState().mergeFromServer(
      pullResponse([serverWorkspace(local.id, 0, 1, { seq: 12, deleted_at: 4444 })]),
    );
    expect(useWorkspaceStore.getState().workspaces.find((item) => item.id === local.id)).toEqual(local);
  });

  test("matching server lifecycle states acknowledge pending local roots", async () => {
    const pendingDelete = workspace("workspace-delete", 0, { seq: 0, deletedAt: 1234 });
    const pendingRestore = workspace("workspace-restore", 1, { seq: 0 });
    lifecycleIntents = [
      { workspaceId: pendingDelete.id, action: "delete", baseSeq: 7, previousActiveWorkspaceId: "workspace-other", createdAt: 1234 },
      { workspaceId: pendingRestore.id, action: "restore", baseSeq: 8, previousActiveWorkspaceId: "workspace-other", createdAt: 1235 },
    ];
    useWorkspaceStore.setState({
      workspaces: [pendingDelete, pendingRestore, workspace("workspace-other", 2)],
      activeWorkspaceId: "workspace-other",
    });
    const result = await useWorkspaceStore.getState().mergeFromServer(pullResponse([
      serverWorkspace(pendingDelete.id, 0, 1, { name: "delete-confirmed", seq: 31, deleted_at: 5000 }),
      serverWorkspace(pendingRestore.id, 1, 0, { name: "restore-confirmed", seq: 32 }),
    ]));
    expect(useWorkspaceStore.getState().workspaces.find((item) => item.id === pendingDelete.id)).toEqual({
      id: pendingDelete.id,
      name: "delete-confirmed",
      color: "blue",
      position: 0,
      seq: 31,
      deletedAt: 5000,
      deletionModel: 1,
    });
    expect(useWorkspaceStore.getState().workspaces.find((item) => item.id === pendingRestore.id)).toEqual({
      id: pendingRestore.id,
      name: "restore-confirmed",
      color: "blue",
      position: 1,
      seq: 32,
      deletionModel: 1,
    });
    expect(result).toEqual({ terminalWorkspaceIds: [], restoredWorkspaceIds: [pendingRestore.id] });
  });

  test("remote retention switches the active workspace and persists the retained root", async () => {
    const target = workspace("workspace-target", 0);
    const replacement = workspace("workspace-replacement", 1);
    useWorkspaceStore.setState({ workspaces: [target, replacement], activeWorkspaceId: target.id });
    await useWorkspaceStore.getState().mergeFromServer(
      pullResponse([serverWorkspace(target.id, 0, 1, { deleted_at: 6000, seq: 44 })]),
    );
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(replacement.id);
    expect(useWorkspaceStore.getState().workspaces.find((item) => item.id === target.id)?.deletedAt).toBe(6000);
    expect(idbBulkWriteCalls.flat()).toContainEqual({
      type: "put",
      store: "workspaces",
      value: { id: target.id, name: target.id, color: "blue", position: 0, seq: 44, deletedAt: 6000, deletionModel: 1 },
    });
  });

  test("terminal server roots are returned without persisting or selecting a usable root", async () => {
    const target = workspace("workspace-target", 0);
    const replacement = workspace("workspace-replacement", 1);
    useWorkspaceStore.setState({ workspaces: [target, replacement], activeWorkspaceId: target.id });
    const result = await useWorkspaceStore.getState().mergeFromServer(
      pullResponse([serverWorkspace(target.id, 0, 2, { name: "", color: null, seq: 70 })]),
    );
    expect(result).toEqual({ terminalWorkspaceIds: [target.id], restoredWorkspaceIds: [] });
    expect(useWorkspaceStore.getState().workspaces.map((item) => item.id)).toEqual([replacement.id]);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(replacement.id);
    expect(idbBulkWriteCalls.flat().filter((operation) =>
      operation.store === "workspaces" && operation.value?.id === target.id
    )).toEqual([]);
  });

  test("authenticated soft actions require the scoped cached capability but remain available offline", async () => {
    const target = workspace("workspace-target", 0);
    const replacement = workspace("workspace-replacement", 1);
    authState = {
      user: { id: "user-1" },
      accessToken: null,
      serverUrl: "https://server.test",
    };
    useWorkspaceStore.setState({ workspaces: [target, replacement], activeWorkspaceId: target.id });
    storedWorkspaces = structuredClone([target, replacement]);
    storedKv.set("activeWorkspaceId", { key: "activeWorkspaceId", value: target.id });
    capabilitySupported = false;

    expect(await useWorkspaceStore.getState().deleteWorkspace(target.id)).toEqual({
      status: "unsupported",
      reason: "server_capability",
    });
    expect(lifecycleCommitCalls).toEqual([]);

    capabilitySupported = true;
    expect(await useWorkspaceStore.getState().deleteWorkspace(target.id)).toEqual({ status: "queued" });
    expect(lifecycleCommitCalls).toHaveLength(1);
  });

  test("restore commits only the root and intent while preserving position and descendants", async () => {
    const target = workspace("workspace-target", 8, { seq: 19, deletedAt: 7777, deletionModel: 0 });
    const targetCollection = collection("collection-target", target.id, { deletedAt: 3333 });
    const targetBookmark = bookmark("bookmark-target", targetCollection.id, { deletedAt: 4444 });
    const targetGroup = savedGroup("group-target", target.id, { deletedAt: 5555 });
    useWorkspaceStore.setState({
      workspaces: [workspace("workspace-active", 0), target],
      collections: [targetCollection],
      activeWorkspaceId: "workspace-active",
    });
    useBookmarksStore.setState({ trashedBookmarks: [targetBookmark] });
    useGroupsStore.setState({ groups: [targetGroup] });
    const childSnapshot = structuredClone({
      collections: useWorkspaceStore.getState().collections,
      trashedBookmarks: useBookmarksStore.getState().trashedBookmarks,
      groups: useGroupsStore.getState().groups,
    });

    expect(await useWorkspaceStore.getState().restoreWorkspace(target.id)).toEqual({ status: "queued" });
    expect(lifecycleCommitCalls).toEqual([{
      workspace: { ...target, deletedAt: undefined, seq: 0 },
      intent: {
        workspaceId: target.id,
        action: "restore",
        baseSeq: 19,
        previousActiveWorkspaceId: "workspace-active",
        createdAt: expect.any(Number),
      },
    }]);
    expect({
      collections: useWorkspaceStore.getState().collections,
      trashedBookmarks: useBookmarksStore.getState().trashedBookmarks,
      groups: useGroupsStore.getState().groups,
    }).toEqual(childSnapshot);
    expect(wakeCalls).toEqual([target.id]);
    expect(planCalls).toEqual([["restoreFromTrash", "workspace", undefined]]);
  });

  test("active setter refuses deleted roots and new positions follow every retained root", () => {
    useWorkspaceStore.setState({
      workspaces: [
        workspace("workspace-active", 2),
        workspace("workspace-deleted", 11, { deletedAt: 9999 }),
      ],
      activeWorkspaceId: "workspace-active",
    });
    useWorkspaceStore.getState().setActiveWorkspaceId("workspace-deleted");
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("workspace-active");

    generatedIds = ["workspace-new", "collection-new"];
    const created = useWorkspaceStore.getState().createWorkspace("New", "blue");
    expect(created.position).toBe(12);
  });

  test("ordinary sweep excludes roots with lifecycle intents", async () => {
    const pending = workspace("workspace-pending", 0, { seq: 0, deletedAt: 1234 });
    const ordinary = workspace("workspace-ordinary", 1, { seq: 0 });
    lifecycleIntents = [{
      workspaceId: pending.id,
      action: "delete",
      baseSeq: 4,
      previousActiveWorkspaceId: ordinary.id,
      createdAt: 1234,
    }];
    useWorkspaceStore.setState({ workspaces: [pending, ordinary], activeWorkspaceId: ordinary.id });
    syncEnqueueCalls.length = 0;

    await useWorkspaceStore.getState().sweepUnsynced();

    expect(syncEnqueueCalls).toHaveLength(1);
    expect(syncEnqueueCalls[0][0].workspaces.map((entity) => entity.id)).toEqual([ordinary.id]);
  });

  test("delete cannot commit between sweep intent and Workspace snapshots", async () => {
    const target = workspace("workspace-target", 0, { seq: 0 });
    const replacement = workspace("workspace-replacement", 1);
    storedWorkspaces = structuredClone([target, replacement]);
    storedKv.set("activeWorkspaceId", { key: "activeWorkspaceId", value: target.id });
    useFirstContextWorkspaceStore.setState({
      workspaces: [target, replacement],
      activeWorkspaceId: target.id,
    });
    useSecondContextWorkspaceStore.setState({
      workspaces: [target, replacement],
      activeWorkspaceId: target.id,
    });
    let resolveIntentRead;
    let observeIntentRead;
    const intentReadStarted = new Promise((resolve) => { observeIntentRead = resolve; });
    intentReadImpl = (key) => {
      observeIntentRead();
      return new Promise((resolve) => {
        resolveIntentRead = () => resolve({ key, value: { version: 1, intents: [] } });
      });
    };
    syncEnqueueCalls.length = 0;

    const sweeping = useFirstContextWorkspaceStore.getState().sweepUnsynced();
    await intentReadStarted;
    const deleting = useSecondContextWorkspaceStore.getState().deleteWorkspace(target.id);
    await Promise.resolve();
    await Promise.resolve();
    if (!resolveIntentRead) { throw new Error("intent read was not blocked"); }
    resolveIntentRead();
    const [, deleteResult] = await Promise.all([sweeping, deleting]);

    expect(deleteResult).toEqual({ status: "queued" });
    const deleteCommitIndex = lifecycleConcurrencyEvents.indexOf(`delete-commit:${target.id}`);
    const targetEnqueueIndex = lifecycleConcurrencyEvents.findIndex((event) =>
      event.startsWith("enqueue:") && event.split(":")[1]?.split(",").includes(target.id)
    );
    expect(deleteCommitIndex).toBeGreaterThanOrEqual(0);
    expect(targetEnqueueIndex === -1 || targetEnqueueIndex < deleteCommitIndex).toBe(true);
  });

  test("an expired fallback sweep holder cannot enqueue after another context deletes", async () => {
    const target = workspace("workspace-target", 0, { seq: 0 });
    const replacement = workspace("workspace-replacement", 1);
    storedWorkspaces = structuredClone([target, replacement]);
    storedKv.set("activeWorkspaceId", { key: "activeWorkspaceId", value: target.id });
    useFirstContextWorkspaceStore.setState({
      workspaces: [target, replacement],
      activeWorkspaceId: target.id,
    });
    useSecondContextWorkspaceStore.setState({
      workspaces: [target, replacement],
      activeWorkspaceId: target.id,
    });
    let resolveIntentRead;
    let observeIntentRead;
    const intentReadStarted = new Promise((resolve) => { observeIntentRead = resolve; });
    intentReadImpl = (key) => {
      observeIntentRead();
      return new Promise((resolve) => {
        resolveIntentRead = () => resolve({ key, value: { version: 1, intents: [] } });
      });
    };

    const staleSweep = useFirstContextWorkspaceStore.getState().sweepUnsynced();
    await intentReadStarted;
    for (const [key, lock] of heldLifecycleLocks) {
      heldLifecycleLocks.set(key, { ...lock, expiresAt: 0 });
    }
    expect(await useSecondContextWorkspaceStore.getState().deleteWorkspace(target.id)).toEqual({
      status: "queued",
    });
    if (!resolveIntentRead) { throw new Error("intent read was not blocked"); }
    resolveIntentRead();
    await staleSweep;

    const targetWasEnqueued = syncEnqueueCalls.some((call) =>
      call[0].workspaces?.some((entity) => entity.id === target.id)
    );
    expect(targetWasEnqueued).toBe(false);
    expect(storedWorkspaces.find((item) => item.id === target.id)?.deletedAt).toBeNumber();
  });

  test("fallback release failure preserves a committed delete result and runtime wake", async () => {
    const target = workspace("workspace-target", 0);
    const replacement = workspace("workspace-replacement", 1);
    storedWorkspaces = structuredClone([target, replacement]);
    storedKv.set("activeWorkspaceId", { key: "activeWorkspaceId", value: target.id });
    useWorkspaceStore.setState({
      workspaces: [target, replacement],
      activeWorkspaceId: target.id,
    });
    releaseLockImpl = async () => { throw new Error("release failed"); };

    expect(await useWorkspaceStore.getState().deleteWorkspace(target.id)).toEqual({ status: "queued" });
    expect(wakeCalls).toEqual([target.id]);
    expect(storedWorkspaces.find((item) => item.id === target.id)?.deletedAt).toBeNumber();
  });

  test("authenticated purge is offline-safe and rolls back the optimistic card on failure", async () => {
    const target = workspace("workspace-target", 0, { deletedAt: 1234 });
    authState = { user: { id: "user-1" }, accessToken: null, serverUrl: "https://server.test" };
    useWorkspaceStore.setState({ workspaces: [target] });

    expect(await useWorkspaceStore.getState().permanentlyDeleteWorkspace(target.id)).toEqual({
      status: "blocked",
      reason: "offline",
    });
    expect(useWorkspaceStore.getState().workspaces).toEqual([target]);

    authState.accessToken = "token";
    purgeImpl = async () => { throw new Error("network down"); };
    expect(await useWorkspaceStore.getState().permanentlyDeleteWorkspace(target.id)).toEqual({
      status: "blocked",
      reason: "offline",
    });
    expect(useWorkspaceStore.getState().workspaces).toEqual([target]);
    expect(idbDeleteCalls).toEqual([]);
    expect(planCalls).toEqual([]);
  });

  test("authenticated purge removes only the card until runtime confirmation then refreshes plan", async () => {
    const target = workspace("workspace-target", 0, { deletedAt: 1234 });
    const targetCollection = collection("collection-target", target.id);
    authState = { user: { id: "user-1" }, accessToken: "token", serverUrl: "https://server.test" };
    useWorkspaceStore.setState({ workspaces: [target], collections: [targetCollection] });
    let resolvePurge;
    purgeImpl = () => new Promise((resolve) => { resolvePurge = resolve; });

    const purging = useWorkspaceStore.getState().permanentlyDeleteWorkspace(target.id);
    await Promise.resolve();

    expect(useWorkspaceStore.getState().workspaces).toEqual([]);
    expect(useWorkspaceStore.getState().collections).toEqual([targetCollection]);
    expect(idbDeleteCalls).toEqual([]);
    expect(planCalls).toEqual([]);
    if (!resolvePurge) { throw new Error("purge runtime was not called"); }
    resolvePurge({ status: "completed" });
    expect(await purging).toEqual({ status: "completed" });
    expect(planCalls).toEqual([["fetch"]]);
  });

  test("guest purge removes the committed aggregate from loaded state and decrements exact usage", async () => {
    const target = workspace("workspace-target", 0, { deletedAt: 1234 });
    const targetCollection = collection("collection-target", target.id);
    const targetBookmark = bookmark("bookmark-target", targetCollection.id);
    const targetGroup = savedGroup("group-target", target.id);
    const targetTab = { id: "tab-target", groupId: targetGroup.id, title: "Tab", url: "https://tab.test", favicon: "", position: 0 };
    aggregateCleanupIds = {
      workspaceId: target.id,
      collectionIds: [targetCollection.id],
      bookmarkIds: [targetBookmark.id],
      groupIds: [targetGroup.id],
      groupTabIds: [targetTab.id],
    };
    useWorkspaceStore.setState({ workspaces: [target], collections: [targetCollection] });
    useBookmarksStore.setState({
      bookmarks: new Map([[targetBookmark.id, targetBookmark]]),
      countsByCollection: { [targetCollection.id]: 1 },
    });
    useGroupsStore.setState({ groups: [targetGroup], groupTabs: [targetTab] });

    expect(await useWorkspaceStore.getState().permanentlyDeleteWorkspace(target.id)).toEqual({
      status: "completed",
    });
    expect(useWorkspaceStore.getState().workspaces).toEqual([]);
    expect(useWorkspaceStore.getState().collections).toEqual([]);
    expect(useBookmarksStore.getState().bookmarks.size).toBe(0);
    expect(useGroupsStore.getState().groups).toEqual([]);
    expect(planCalls).toEqual([
      ["decrement", "workspace", undefined],
      ["decrement", "collection", 1],
      ["decrement", "bookmark", 1],
      ["decrement", "saved_group", 1],
    ]);
  });

  test("aggregate state removal leaves unloaded bookmark buckets byte-identical", () => {
    const ids = {
      workspaceId: "workspace-target",
      collectionIds: ["collection-target"],
      bookmarkIds: ["bookmark-target"],
      groupIds: ["group-target"],
      groupTabIds: ["tab-target"],
    };
    const unloadedArchived = [bookmark("bookmark-target", "collection-target")];
    const unloadedTrashed = [bookmark("bookmark-target", "collection-target", { deletedAt: 1234 })];
    useBookmarksStore.setState({
      bookmarks: new Map([["bookmark-target", bookmark("bookmark-target", "collection-target")]]),
      archivedBookmarks: unloadedArchived,
      trashedBookmarks: unloadedTrashed,
      _archivedLoaded: false,
      _trashedLoaded: false,
    });

    useBookmarksStore.getState().removeWorkspaceAggregateFromState(ids);

    expect(useBookmarksStore.getState().bookmarks.size).toBe(0);
    expect(useBookmarksStore.getState().archivedBookmarks).toBe(unloadedArchived);
    expect(useBookmarksStore.getState().trashedBookmarks).toBe(unloadedTrashed);
  });

  test("sequence confirmation changes only matching loaded canonical snapshots", () => {
    const root = workspace("workspace-target", 0, { seq: 0 });
    const rootCollection = collection("collection-target", root.id, { seq: 0 });
    const rootTag = { id: "tag-target", name: "Tag", color: "blue", seq: 0 };
    useWorkspaceStore.setState({ workspaces: [root], collections: [rootCollection], tags: [rootTag] });
    useWorkspaceStore.getState().confirmWorkspaceStoreEntitySeqs({
      workspaces: [{ id: root.id, name: root.name, color: root.color, position: root.position, deleted_at: null }],
      collections: [{
        id: rootCollection.id,
        workspace_id: root.id,
        name: rootCollection.name,
        icon: rootCollection.icon,
        position: rootCollection.position,
        deleted_at: null,
        archived_at: null,
      }],
      tags: [{ id: rootTag.id, name: "concurrent rename", color: rootTag.color, deleted_at: null }],
    }, 90);
    expect(useWorkspaceStore.getState().workspaces[0]).toEqual({ ...root, seq: 90 });
    expect(useWorkspaceStore.getState().collections[0]).toEqual({ ...rootCollection, seq: 90 });
    expect(useWorkspaceStore.getState().tags[0]).toEqual(rootTag);

    const active = bookmark("bookmark-active", rootCollection.id);
    const archived = bookmark("bookmark-archived", rootCollection.id);
    const trashed = bookmark("bookmark-trashed", rootCollection.id, { deletedAt: 1234, isTrashed: 1 });
    useBookmarksStore.setState({
      bookmarks: new Map([[active.id, active]]),
      archivedBookmarks: [archived],
      trashedBookmarks: [trashed],
      _archivedLoaded: true,
      _trashedLoaded: true,
    });
    const bookmarkEntity = (item, isArchived, isTrashed) => ({
      id: item.id,
      collection_id: item.collectionId,
      title: item.title,
      url: item.url,
      favicon_url: item.favicon,
      description: item.description,
      is_favorite: item.isFavorite,
      is_archived: isArchived,
      is_trashed: isTrashed,
      tag_ids: item.tags,
      position: 0,
      deleted_at: null,
    });
    useBookmarksStore.getState().confirmBookmarkEntitySeqs([
      bookmarkEntity(active, false, 0),
      bookmarkEntity(archived, true, 0),
      bookmarkEntity(trashed, false, 1),
    ], 91);
    expect(useBookmarksStore.getState().bookmarks.get(active.id)?.seq).toBe(91);
    expect(useBookmarksStore.getState().archivedBookmarks[0]?.seq).toBe(91);
    expect(useBookmarksStore.getState().trashedBookmarks[0]?.seq).toBe(91);

    const group = savedGroup("group-target", root.id);
    const tab = { id: "tab-target", groupId: group.id, title: "Tab", url: "https://tab.test", favicon: "", position: 0 };
    useGroupsStore.setState({ groups: [group], groupTabs: [tab] });
    useGroupsStore.getState().confirmGroupEntitySeqs([{
      id: group.id,
      name: group.name,
      color: group.color,
      is_compact: group.isCompact,
      workspace_id: group.workspaceId,
      created_at: new Date(group.createdAt).getTime(),
      deleted_at: null,
      tabs: [{ id: tab.id, group_id: tab.groupId, title: tab.title, url: tab.url, favicon: tab.favicon, position: tab.position }],
    }], 92);
    expect(useGroupsStore.getState().groups[0]).toEqual({ ...group, seq: 92 });
    expect(idbPutCalls).toEqual([]);
    expect(idbBulkWriteCalls).toEqual([]);
  });

  test("applyGuestWorkspaceChanges recomputes an empty activeWorkspaceId instead of assigning it verbatim", () => {
    const account = workspace("account-workspace", 0);
    useWorkspaceStore.setState({ workspaces: [account], collections: [], activeWorkspaceId: "guest-workspace" });

    // The discard sentinel: an untouched guest seed being dropped in favor
    // of a confirmed account workspace. Assigning "" verbatim would strand
    // activeWorkspaceId pointing at nothing while an active workspace exists.
    useWorkspaceStore.getState().applyGuestWorkspaceChanges({
      workspaceDeletes: ["guest-workspace"],
      collectionPuts: [],
      collectionDeletes: [],
      activeWorkspaceId: "",
    });

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(account.id);
    expect(useWorkspaceStore.getState().workspaces.map((item) => item.id)).toEqual(["account-workspace"]);
  });

  test("applyGuestWorkspaceChanges passes a non-empty target through even when not yet in local state", () => {
    // A legacy-migration target: not yet merged locally, but the immediately
    // following mergeFromServer will materialize it — this is a legitimate
    // forward reference, not the bug the "" case guards against.
    useWorkspaceStore.setState({
      workspaces: [workspace("guest-workspace", 0)],
      collections: [],
      activeWorkspaceId: "guest-workspace",
    });

    useWorkspaceStore.getState().applyGuestWorkspaceChanges({
      workspaceDeletes: ["guest-workspace"],
      collectionPuts: [],
      collectionDeletes: [],
      activeWorkspaceId: "not-yet-local-account-workspace",
    });

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("not-yet-local-account-workspace");
  });

  test("applyGuestWorkspaceChanges leaves activeWorkspaceId untouched when the field is omitted", () => {
    useWorkspaceStore.setState({
      workspaces: [workspace("guest-workspace", 0)],
      collections: [],
      activeWorkspaceId: "guest-workspace",
    });

    useWorkspaceStore.getState().applyGuestWorkspaceChanges({
      workspaceDeletes: [],
      collectionPuts: [],
      collectionDeletes: [],
    });

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("guest-workspace");
  });

  test("deleteCollection moves collection quota to trash but archiveCollection does not", () => {
    const active = workspace("workspace-active", 0);
    const trashTarget = collection("collection-trash-target", active.id);
    const archiveTarget = collection("collection-archive-target", active.id);
    useWorkspaceStore.setState({
      workspaces: [active],
      collections: [trashTarget, archiveTarget],
      activeWorkspaceId: active.id,
    });

    useWorkspaceStore.getState().deleteCollection(trashTarget.id);
    expect(planCalls).toEqual([["moveToTrash", "collection", undefined]]);

    planCalls.length = 0;
    // Archived counts as in-use, not trash — must not touch the split.
    useWorkspaceStore.getState().archiveCollection(archiveTarget.id);
    expect(planCalls).toEqual([]);
  });

  test("restoreCollection restores trash quota for a trashed collection but not for a merely archived one", () => {
    const active = workspace("workspace-active", 0);
    const trashed = collection("collection-was-trashed", active.id, { deletedAt: 1000 });
    const archived = collection("collection-was-archived", active.id, { archivedAt: 2000 });
    useWorkspaceStore.setState({
      workspaces: [active],
      collections: [trashed, archived],
      activeWorkspaceId: active.id,
    });

    useWorkspaceStore.getState().restoreCollection(trashed.id);
    expect(planCalls).toEqual([["restoreFromTrash", "collection", undefined]]);

    planCalls.length = 0;
    useWorkspaceStore.getState().restoreCollection(archived.id);
    expect(planCalls).toEqual([]);
  });
});
