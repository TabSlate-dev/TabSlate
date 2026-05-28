import { beforeEach, describe, expect, mock, test } from "bun:test";

const bulkWriteCalls = [];
const decrementCalls = [];
const trashedStore = new Map();

const syncEngine = {
  enqueue: () => {},
  forcePush: async () => {},
};

mock.module("@/lib/idb", () => ({
  idbGet: async () => undefined,
  idbGetAll: async () => [],
  idbGetByIndex: async () => [],
  idbGetMany: async (_store, keys) => keys.map((key) => trashedStore.get(key)),
  idbPut: async () => {},
  idbDelete: async () => {},
  idbBulkWrite: async (ops) => {
    bulkWriteCalls.push(ops);
    for (const op of ops) {
      if (op.type === "delete" && op.store === "trashed-bookmarks") {
        trashedStore.delete(op.key);
      }
    }
  },
}));

mock.module("@/lib/sync-engine", () => ({
  syncEngine,
}));

mock.module("@/store/plan-store", () => ({
  usePlanStore: {
    getState: () => ({
      decrementUsage: (resource, count) => {
        decrementCalls.push({ resource, count });
      },
      incrementUsage: () => {},
      ensureFresh: async () => {},
      limits: null,
      showQuotaAlert: () => {},
      fetchPlan: async () => {},
      usage: { bookmarks: 0 },
    }),
  },
  guardQuota: (_resource, _currentCount, fallback, fn) => {
    const value = fn();
    return value ?? fallback;
  },
}));

mock.module("@/lib/id", () => ({
  generateId: () => "generated-id",
}));

mock.module("@/lib/bookmark-utils", () => ({
  normalizeFavicon: (favicon) => favicon,
}));

const { useBookmarksStore } = await import("../store/bookmarks-store");

function createBookmark(id, overrides = {}) {
  return {
    id,
    title: `Bookmark ${id}`,
    url: `https://example.com/${id}`,
    description: "",
    favicon: "",
    collectionId: "collection-1",
    tags: [],
    createdAt: "2026-05-28T00:00:00.000Z",
    isFavorite: false,
    seq: 5,
    deletedAt: 1,
    ...overrides,
  };
}

describe("bookmarks store batch permanent delete", () => {
  beforeEach(() => {
    bulkWriteCalls.length = 0;
    decrementCalls.length = 0;
    trashedStore.clear();
    syncEngine.forcePush = async () => {};
    useBookmarksStore.setState({
      bookmarks: [],
      archivedBookmarks: [],
      trashedBookmarks: [],
      _archivedLoaded: true,
      _trashedLoaded: true,
    });
  });

  test("only removes a chunk after that chunk push succeeds", async () => {
    const bookmarks = Array.from({ length: 901 }, (_, index) => createBookmark(`bookmark-${index}`));
    for (const bookmark of bookmarks) {
      trashedStore.set(bookmark.id, bookmark);
    }

    let pushCount = 0;
    syncEngine.forcePush = async () => {
      pushCount += 1;
      if (pushCount === 1) {
        return;
      }
      throw new Error("second chunk failed");
    };

    useBookmarksStore.setState({
      trashedBookmarks: bookmarks,
      _trashedLoaded: true,
    });

    useBookmarksStore.getState().permanentlyDeleteBatch(bookmarks.map((bookmark) => bookmark.id));

    expect(useBookmarksStore.getState().trashedBookmarks).toHaveLength(901);
    expect(bulkWriteCalls).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bulkWriteCalls).toHaveLength(1);
    expect(bulkWriteCalls[0]).toHaveLength(900);
    expect(useBookmarksStore.getState().trashedBookmarks).toHaveLength(1);
    expect(useBookmarksStore.getState().trashedBookmarks[0]?.id).toBe("bookmark-900");
    expect(decrementCalls).toEqual([{ resource: "bookmark", count: 900 }]);
    expect(trashedStore.size).toBe(1);
  });
});
