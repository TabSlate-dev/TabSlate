import { beforeEach, describe, expect, mock, test } from "bun:test";

const decrementUsageCalls = [];
const idbPutCalls = [];
const enqueueCalls = [];

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
  idbGetAll: async () => [],
  idbPut: async (store, value) => {
    idbPutCalls.push({ store, value });
  },
  idbDelete: async () => {},
}));

mock.module("@/lib/sync-engine", () => ({
  syncEngine: {
    enqueue: (payload) => {
      enqueueCalls.push(payload);
    },
    forcePush: async () => {},
  },
}));

mock.module("@/store/plan-store", () => ({
  usePlanStore: {
    getState: () => ({
      decrementUsage: (resource) => {
        decrementUsageCalls.push(resource);
      },
      incrementUsage: () => {},
    }),
  },
  guardQuota: (_resource, _currentCount, fallback, fn) => {
    const value = fn();
    return value ?? fallback;
  },
}));

const { useGroupsStore } = await import("../store/groups-store");

describe("groups-store deleteGroup", () => {
  beforeEach(() => {
    decrementUsageCalls.length = 0;
    idbPutCalls.length = 0;
    enqueueCalls.length = 0;
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
