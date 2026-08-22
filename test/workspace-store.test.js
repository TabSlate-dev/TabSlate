import { beforeEach, describe, expect, mock, test } from "bun:test";

const idbDeleteCalls = [];
const idbPutCalls = [];
const idbBulkWriteCalls = [];
const trashedCollections = [];
const deletedGroups = [];

let trashCollectionBookmarksImpl;
let idbBulkWriteImpl;
let generatedIds;

mock.module("@/lib/idb", () => ({
  idbGetAll: async () => [],
  idbGet: async () => undefined,
  idbGetByIndex: async () => [],
  idbGetMany: async () => [],
  idbPut: async (store, value) => {
    idbPutCalls.push({ store, value });
  },
  idbDelete: async (store, key) => {
    idbDeleteCalls.push({ store, key });
  },
  idbBulkWrite: async (ops) => {
    idbBulkWriteCalls.push(ops);
    return idbBulkWriteImpl(ops);
  },
}));

mock.module("@/lib/sync-engine", () => ({
  syncEngine: null,
}));

mock.module("@/store/bookmarks-store", () => ({
  useBookmarksStore: {
    getState: () => ({
      trashCollectionBookmarks: (collectionId) => {
        trashedCollections.push(collectionId);
        return trashCollectionBookmarksImpl(collectionId);
      },
    }),
  },
}));

mock.module("@/store/groups-store", () => ({
  useGroupsStore: {
    getState: () => ({
      groups: [],
      deleteGroup: (groupId) => {
        deletedGroups.push(groupId);
      },
    }),
  },
}));

mock.module("@/store/plan-store", () => ({
  usePlanStore: {
    getState: () => ({
      decrementUsage: () => {},
      incrementUsage: () => {},
      ensureFresh: async () => {},
      showQuotaAlert: () => {},
      fetchPlan: async () => {},
      usage: { bookmarks: 0 },
      limits: null,
    }),
  },
  guardQuota: (_resource, _currentCount, fallback, fn) => {
    const value = fn();
    return value ?? fallback;
  },
}));

mock.module("@/lib/id", () => ({
  generateId: () => generatedIds.shift(),
}));

const { useWorkspaceStore } = await import("../store/workspace-store");

describe("workspace deletion", () => {
  beforeEach(() => {
    idbDeleteCalls.length = 0;
    idbPutCalls.length = 0;
    idbBulkWriteCalls.length = 0;
    trashedCollections.length = 0;
    deletedGroups.length = 0;
    trashCollectionBookmarksImpl = async () => {};
    idbBulkWriteImpl = async () => {};
    generatedIds = ["generated-id", "generated-collection-id"];
    useWorkspaceStore.setState({
      workspaces: [],
      collections: [],
      tags: [],
      activeWorkspaceId: "",
    });
  });

  test("initializes one guest workspace atomically when called concurrently", async () => {
    let resolveBulkWrite;
    idbBulkWriteImpl = () => new Promise((resolve) => {
      resolveBulkWrite = resolve;
    });
    generatedIds = ["guest-workspace-id", "guest-collection-id"];

    const first = useWorkspaceStore.getState().initializeGuestWorkspace();
    const second = useWorkspaceStore.getState().initializeGuestWorkspace();
    await Promise.resolve();

    expect(idbBulkWriteCalls).toHaveLength(1);
    expect(idbBulkWriteCalls[0]).toEqual([
      {
        type: "put",
        store: "workspaces",
        value: {
          id: "guest-workspace-id",
          name: "My Workspace",
          color: "blue",
          position: 0,
          seq: 0,
        },
      },
      {
        type: "put",
        store: "collections",
        value: {
          id: "guest-collection-id",
          workspaceId: "guest-workspace-id",
          name: "Default",
          icon: "inbox",
          position: 0,
          isDefault: true,
          seq: 0,
        },
      },
      {
        type: "put",
        store: "kv",
        value: { key: "activeWorkspaceId", value: "guest-workspace-id" },
      },
      {
        type: "put",
        store: "kv",
        value: {
          key: "guest-workspace-provenance-v1",
          value: {
            version: 1,
            state: "pending-server-confirmation",
            workspaceId: "guest-workspace-id",
            defaultCollectionId: "guest-collection-id",
            fingerprint: {
              workspaceName: "My Workspace",
              workspaceColor: "blue",
              workspacePosition: 0,
              collectionName: "Default",
              collectionIcon: "inbox",
              collectionPosition: 0,
            },
          },
        },
      },
    ]);
    expect(useWorkspaceStore.getState().workspaces).toEqual([]);
    expect(useWorkspaceStore.getState().collections).toEqual([]);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("");

    if (!resolveBulkWrite) {
      throw new Error("idbBulkWrite was not called");
    }
    resolveBulkWrite();
    await Promise.all([first, second]);

    expect(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id)).toEqual([
      "guest-workspace-id",
    ]);
    expect(useWorkspaceStore.getState().collections.map((collection) => collection.id)).toEqual([
      "guest-collection-id",
    ]);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("guest-workspace-id");
  });

  test("deleteWorkspace waits for trashCollectionBookmarks before deleting the workspace from IDB", async () => {
    let resolveTrash = null;
    trashCollectionBookmarksImpl = () =>
      new Promise((resolve) => {
        resolveTrash = resolve;
      });

    const workspace = {
      id: "workspace-1",
      name: "Workspace 1",
      color: "blue",
      position: 0,
      seq: 3,
    };

    const otherWorkspace = {
      id: "workspace-2",
      name: "Workspace 2",
      color: "emerald",
      position: 1,
      seq: 4,
    };

    const collection = {
      id: "collection-1",
      workspaceId: "workspace-1",
      name: "Collection 1",
      icon: "folder",
      position: 0,
      seq: 2,
    };

    useWorkspaceStore.setState({
      workspaces: [workspace, otherWorkspace],
      collections: [collection],
      tags: [],
      activeWorkspaceId: "workspace-1",
    });

    const deletion = Promise.resolve(useWorkspaceStore.getState().deleteWorkspace("workspace-1"));
    await Promise.resolve();

    expect(trashedCollections).toEqual(["collection-1"]);
    expect(idbDeleteCalls).toHaveLength(0);
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);

    if (!resolveTrash) {
      throw new Error("trashCollectionBookmarks was not awaited");
    }
    resolveTrash();
    await deletion;
    await Promise.resolve();

    expect(idbDeleteCalls).toContainEqual({ store: "workspaces", key: "workspace-1" });
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
    expect(useWorkspaceStore.getState().workspaces[0]?.id).toBe("workspace-2");
  });
});
