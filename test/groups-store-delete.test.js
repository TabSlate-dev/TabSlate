import { beforeEach, describe, expect, mock, test } from "bun:test";

const decrementUsageCalls = [];
const incrementUsageCalls = [];
const moveUsageToTrashCalls = [];
const restoreUsageFromTrashCalls = [];
const idbPutCalls = [];
const idbDeleteCalls = [];
const idbBulkWriteCalls = [];
const enqueueCalls = [];
const forcePushCalls = [];
const guardQuotaCalls = [];
let forcePushImplementation = async () => {};
let idbBulkWriteImplementation = async () => {};
const authSession = {
  user: {
    id: "user-1",
    name: "User",
    email: "user@example.com",
    is_verified: true,
    created_at: 0,
    updated_at: 0,
  },
  accessToken: "access-token",
};

mock.module("@/lib/chrome/tab-groups", () => ({
  openAsTabGroup: async () => {},
}));

mock.module("@/lib/id", () => ({
  generateId: () => "generated-id",
}));

mock.module("@/lib/bookmark-utils", () => ({
  normalizeFavicon: (favicon) => favicon,
}));

mock.module("@/lib/idb", () => ({
  idbGet: async () => undefined,
  idbGetAll: async () => [],
  idbPut: async (store, value) => {
    idbPutCalls.push({ store, value });
  },
  idbBulkWrite: (operations) => {
    idbBulkWriteCalls.push(operations);
    return idbBulkWriteImplementation(operations);
  },
  idbDelete: async (store, id) => {
    idbDeleteCalls.push({ store, id });
  },
}));

mock.module("@/lib/sync-engine", () => ({
  syncEngine: createSyncEngine(),
}));

mock.module("@/store/auth-store", () => ({
  useAuthStore: {
    getState: () => authSession,
  },
}));

function createSyncEngine() {
  return {
    enqueue: (payload) => {
      enqueueCalls.push(payload);
    },
    forcePush: (payload) => {
      forcePushCalls.push(payload);
      return forcePushImplementation(payload);
    },
  };
}

mock.module("@/store/plan-store", () => ({
  usePlanStore: {
    getState: () => ({
      decrementUsage: (resource) => {
        decrementUsageCalls.push(resource);
      },
      incrementUsage: (resource) => {
        incrementUsageCalls.push(resource);
      },
      moveUsageToTrash: (resource) => {
        moveUsageToTrashCalls.push(resource);
      },
      restoreUsageFromTrash: (resource) => {
        restoreUsageFromTrashCalls.push(resource);
      },
    }),
  },
  guardQuota: (resource, currentCount, fallback, fn) => {
    guardQuotaCalls.push({ resource, currentCount });
    const value = fn();
    return value ?? fallback;
  },
}));

const { useGroupsStore } = await import(`../store/groups-store.ts?test=${Date.now()}-${Math.random()}`);

describe("groups-store deleteGroup", () => {
  beforeEach(() => {
    decrementUsageCalls.length = 0;
    incrementUsageCalls.length = 0;
    moveUsageToTrashCalls.length = 0;
    restoreUsageFromTrashCalls.length = 0;
    idbPutCalls.length = 0;
    idbDeleteCalls.length = 0;
    idbBulkWriteCalls.length = 0;
    enqueueCalls.length = 0;
    forcePushCalls.length = 0;
    guardQuotaCalls.length = 0;
    forcePushImplementation = async () => {};
    idbBulkWriteImplementation = async () => {};
    authSession.user = {
      id: "user-1",
      name: "User",
      email: "user@example.com",
      is_verified: true,
      created_at: 0,
      updated_at: 0,
    };
    authSession.accessToken = "access-token";
    useGroupsStore.setState({ groups: [], groupTabs: [], _hydrated: true });
  });

  function group(id, deletedAt) {
    return {
      id,
      name: id,
      color: "blue",
      isCompact: false,
      createdAt: new Date(0).toISOString(),
      seq: 2,
      deletedAt,
      workspaceId: "workspace-1",
    };
  }

  function createDeferred() {
    let resolve = () => {};
    let reject = () => {};
    const promise = new Promise((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    return { promise, resolve, reject };
  }

  test("counts active and soft-deleted retained groups at the create capacity gate", () => {
    useGroupsStore.setState({
      groups: [group("active"), group("deleted", 100)],
      groupTabs: [],
      _hydrated: true,
    });

    useGroupsStore.getState().createGroup("Created", "blue", false, "workspace-1");

    expect(guardQuotaCalls).toEqual([{ resource: "saved_group", currentCount: 2 }]);
    expect(incrementUsageCalls).toEqual(["saved_group"]);
  });

  test("soft delete moves one retained group to trash without changing total usage", () => {
    useGroupsStore.setState({ groups: [group("group-1")], groupTabs: [], _hydrated: true });

    useGroupsStore.getState().deleteGroup("group-1");

    expect(useGroupsStore.getState().groups[0]?.deletedAt).toBeNumber();
    expect(moveUsageToTrashCalls).toEqual(["saved_group"]);
    expect(decrementUsageCalls).toEqual([]);
  });

  test("restore moves one retained group back to in-use without changing total usage", () => {
    useGroupsStore.setState({ groups: [group("group-1", 100)], groupTabs: [], _hydrated: true });

    useGroupsStore.getState().restoreGroup("group-1");

    expect(useGroupsStore.getState().groups[0]?.deletedAt).toBeUndefined();
    expect(restoreUsageFromTrashCalls).toEqual(["saved_group"]);
    expect(incrementUsageCalls).toEqual([]);
  });

  test("permanent delete keeps retained state and usage until server confirmation", async () => {
    const deferred = createDeferred();
    forcePushImplementation = () => deferred.promise;
    useGroupsStore.setState({
      groups: [group("group-1", 100)],
      groupTabs: [{
        id: "tab-1",
        groupId: "group-1",
        title: "Tab",
        url: "https://example.com",
        favicon: "",
        position: 0,
      }],
      _hydrated: true,
    });

    const deletion = useGroupsStore.getState().permanentlyDeleteGroup("group-1");
    await Promise.resolve();

    expect(useGroupsStore.getState().groups.map((candidate) => candidate.id)).toEqual(["group-1"]);
    expect(decrementUsageCalls).toEqual([]);

    deferred.resolve();
    const result = await deletion;

    expect(result).toEqual({ status: "completed" });
    expect(useGroupsStore.getState().groups).toEqual([]);
    expect(useGroupsStore.getState().groupTabs).toEqual([]);
    expect(decrementUsageCalls).toEqual(["saved_group"]);
    expect(idbBulkWriteCalls).toEqual([[{
      type: "delete",
      store: "group-tabs",
      key: "tab-1",
    }, {
      type: "delete",
      store: "groups",
      key: "group-1",
    }]]);
    expect(idbDeleteCalls).toEqual([]);
  });

  test("rejected permanent delete never changes retained state or quota", async () => {
    const deferred = createDeferred();
    forcePushImplementation = () => deferred.promise;
    const retained = group("group-1", 100);
    useGroupsStore.setState({ groups: [retained], groupTabs: [], _hydrated: true });

    const deletion = useGroupsStore.getState().permanentlyDeleteGroup("group-1");
    await Promise.resolve();

    expect(useGroupsStore.getState().groups).toEqual([retained]);
    deferred.reject(new Error("rejected"));
    const result = await deletion;

    expect(result).toEqual({ status: "blocked", reason: "rejected" });
    expect(useGroupsStore.getState().groups).toEqual([retained]);
    expect(decrementUsageCalls).toEqual([]);
    expect(idbDeleteCalls).toEqual([]);
  });

  test("coalesces repeated permanent-delete requests while confirmation is pending", async () => {
    const deferred = createDeferred();
    forcePushImplementation = () => deferred.promise;
    useGroupsStore.setState({ groups: [group("group-1", 100)], groupTabs: [], _hydrated: true });

    const firstDeletion = useGroupsStore.getState().permanentlyDeleteGroup("group-1");
    const secondResult = await useGroupsStore.getState().permanentlyDeleteGroup("group-1");
    await Promise.resolve();

    expect(forcePushCalls).toHaveLength(1);
    expect(secondResult).toEqual({ status: "blocked", reason: "pending" });

    deferred.resolve();
    expect(await firstDeletion).toEqual({ status: "completed" });

    expect(decrementUsageCalls).toEqual(["saved_group"]);
  });

  test("transaction failure keeps the group, tabs, and quota retryable after server confirmation", async () => {
    idbBulkWriteImplementation = async () => {
      throw new Error("transaction aborted");
    };
    const retained = group("group-1", 100);
    const retainedTab = {
      id: "tab-1",
      groupId: "group-1",
      title: "Tab",
      url: "https://example.com",
      favicon: "",
      position: 0,
    };
    useGroupsStore.setState({ groups: [retained], groupTabs: [retainedTab], _hydrated: true });

    const result = await useGroupsStore.getState().permanentlyDeleteGroup("group-1");

    expect(result).toEqual({ status: "blocked", reason: "storage" });
    expect(forcePushCalls).toHaveLength(1);
    expect(idbBulkWriteCalls).toHaveLength(1);
    expect(idbDeleteCalls).toEqual([]);
    expect(useGroupsStore.getState().groups).toEqual([retained]);
    expect(useGroupsStore.getState().groupTabs).toEqual([retainedTab]);
    expect(decrementUsageCalls).toEqual([]);

    idbBulkWriteImplementation = async () => {};
    const retryResult = await useGroupsStore.getState().permanentlyDeleteGroup("group-1");

    expect(retryResult).toEqual({ status: "completed" });
    expect(forcePushCalls).toHaveLength(2);
    expect(idbBulkWriteCalls).toHaveLength(2);
    expect(useGroupsStore.getState().groups).toEqual([]);
    expect(useGroupsStore.getState().groupTabs).toEqual([]);
    expect(decrementUsageCalls).toEqual(["saved_group"]);
  });

  test("returns early when the target group is already soft-deleted", () => {
    const deletedAt = Date.now() - 1000;
    useGroupsStore.setState({
      groups: [
        {
          id: "group-1",
          name: "Group 1",
          color: "blue",
          isCompact: false,
          createdAt: new Date(0).toISOString(),
          seq: 2,
          deletedAt,
          workspaceId: "workspace-1",
        },
      ],
      groupTabs: [
        {
          id: "tab-1",
          groupId: "group-1",
          title: "Tab 1",
          url: "https://example.com",
          favicon: "https://example.com/favicon.ico",
          position: 0,
        },
      ],
      _hydrated: true,
    });

    useGroupsStore.getState().deleteGroup("group-1");

    expect(useGroupsStore.getState().groups[0]?.deletedAt).toBe(deletedAt);
    expect(enqueueCalls).toHaveLength(0);
    expect(idbPutCalls).toHaveLength(0);
    expect(decrementUsageCalls).toHaveLength(0);
  });

  test("returns early when the target group does not exist", () => {
    useGroupsStore.setState({
      groups: [],
      groupTabs: [],
      _hydrated: true,
    });

    useGroupsStore.getState().deleteGroup("missing-id");

    expect(enqueueCalls).toHaveLength(0);
    expect(idbPutCalls).toHaveLength(0);
    expect(decrementUsageCalls).toHaveLength(0);
  });
});
