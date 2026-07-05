// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const getPlanMock = mock(async () => ({
  subscription: { plan: "free", status: "active", expires_at: null },
  limits: {
    max_bookmarks: 3000,
    max_collections: 30,
    max_tags: 100,
    max_workspaces: 1,
    max_saved_groups: 15,
    trash_grace_days: 30,
  },
  usage: {
    bookmarks: 3,
    collections: 2,
    tags: 0,
    workspaces: 1,
    saved_groups: 0,
  },
}));

mock.module("@/lib/api", () => ({
  api: {
    getPlan: getPlanMock,
  },
  searchBookmarks: mock(async () => []),
}));

mock.module("@/store/auth-store", () => ({
  useAuthStore: {
    getState: () => ({
      serverUrl: "https://sync.tabslate.com",
      accessToken: "token",
    }),
  },
}));

mock.module("@/store/bookmarks-store", () => ({
  useBookmarksStore: {
    getState: () => ({
      _trashedLoaded: false,
      pruneExpiredTrash: mock(() => {}),
    }),
  },
}));

mock.module("@/lib/chrome-storage-adapter", () => ({
  chromeStorageAdapter: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

async function importPlanStore() {
  return import(`../store/plan-store.ts?test=${Date.now()}-${Math.random()}`);
}

describe("plan store refresh policy", () => {
  beforeEach(async () => {
    getPlanMock.mockClear();
    const { usePlanStore } = await importPlanStore();
    usePlanStore.setState({
      subscription: null,
      limits: null,
      usage: null,
      fetchedAt: null,
      isFetching: false,
      quotaAlert: null,
    });
  });

  test("force refreshes the plan even when the cached value is still fresh", async () => {
    const { usePlanStore } = await importPlanStore();
    usePlanStore.setState({
      fetchedAt: Date.now(),
      isFetching: false,
    });

    usePlanStore.getState().ensureFresh(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(getPlanMock).toHaveBeenCalledTimes(1);
  });
});
