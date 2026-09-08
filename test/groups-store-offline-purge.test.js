import { beforeEach, describe, expect, mock, test } from "bun:test";

const idbBulkWriteCalls = [];
const decrementUsageCalls = [];
const authSession = {
  user: {
    id: "user-1",
    name: "User",
    email: "user@example.com",
    is_verified: true,
    created_at: 0,
    updated_at: 0,
  },
  accessToken: null,
  refreshToken: "refresh-token",
};

mock.module("@/lib/chrome/tab-groups", () => ({
  openAsTabGroup: async () => {},
}));

mock.module("@/lib/id", () => ({
  generateId: () => "generated-id",
}));

const bookmarkUtils = await import("../lib/bookmark-utils.ts");
mock.module("@/lib/bookmark-utils", () => ({
  ...bookmarkUtils,
  normalizeFavicon: (favicon) => favicon,
}));

mock.module("@/lib/idb", () => ({
  idbGet: async () => undefined,
  idbGetAll: async () => [],
  idbPut: async () => {},
  idbDelete: async () => {},
  idbBulkWrite: async (operations) => {
    idbBulkWriteCalls.push(operations);
  },
}));

mock.module("@/lib/sync-engine", () => ({
  syncEngine: null,
}));

mock.module("@/store/auth-store", () => ({
  useAuthStore: {
    getState: () => authSession,
  },
}));

mock.module("@/store/plan-store", () => ({
  usePlanStore: {
    getState: () => ({
      decrementUsage: (resource) => {
        decrementUsageCalls.push(resource);
      },
      incrementUsage: () => {},
      moveUsageToTrash: () => {},
      restoreUsageFromTrash: () => {},
    }),
  },
  guardQuota: (_resource, _currentCount, fallback, fn) => fn() ?? fallback,
}));

const { useGroupsStore } = await import(`../store/groups-store.ts?offline=${Date.now()}-${Math.random()}`);

function group() {
  return {
    id: "group-1",
    name: "Group",
    color: "blue",
    isCompact: false,
    createdAt: new Date(0).toISOString(),
    seq: 2,
    deletedAt: 100,
    workspaceId: "workspace-1",
  };
}

function tab() {
  return {
    id: "tab-1",
    groupId: "group-1",
    title: "Tab",
    url: "https://example.com",
    favicon: "",
    position: 0,
  };
}

describe("groups-store offline permanent deletion", () => {
  beforeEach(() => {
    idbBulkWriteCalls.length = 0;
    decrementUsageCalls.length = 0;
    authSession.user = {
      id: "user-1",
      name: "User",
      email: "user@example.com",
      is_verified: true,
      created_at: 0,
      updated_at: 0,
    };
    authSession.accessToken = null;
    authSession.refreshToken = "refresh-token";
    useGroupsStore.setState({ groups: [group()], groupTabs: [tab()], _hydrated: true });
  });

  test("refresh-token-only session retains group, tabs, and quota for authenticated retry", async () => {
    authSession.user = null;
    const result = await useGroupsStore.getState().permanentlyDeleteGroup("group-1");

    expect(result).toEqual({ status: "blocked", reason: "offline" });
    expect(useGroupsStore.getState().groups).toEqual([group()]);
    expect(useGroupsStore.getState().groupTabs).toEqual([tab()]);
    expect(idbBulkWriteCalls).toEqual([]);
    expect(decrementUsageCalls).toEqual([]);
  });

  test("guest session permanently deletes group and tabs through one transaction", async () => {
    authSession.user = null;
    authSession.accessToken = null;
    authSession.refreshToken = null;

    const result = await useGroupsStore.getState().permanentlyDeleteGroup("group-1");

    expect(result).toEqual({ status: "completed" });
    expect(idbBulkWriteCalls).toEqual([[{
      type: "delete",
      store: "group-tabs",
      key: "tab-1",
    }, {
      type: "delete",
      store: "groups",
      key: "group-1",
    }]]);
    expect(useGroupsStore.getState().groups).toEqual([]);
    expect(useGroupsStore.getState().groupTabs).toEqual([]);
    expect(decrementUsageCalls).toEqual(["saved_group"]);
  });
});
