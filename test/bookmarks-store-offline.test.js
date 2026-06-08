import { beforeEach, describe, expect, mock, test } from "bun:test";

const putCalls = [];
const deleteCalls = [];
const bulkWriteCalls = [];
const decrementCalls = [];
const trashedStore = new Map();

mock.module("@/lib/idb", () => ({
  idbGet: async () => undefined,
  idbGetAll: async () => [],
  idbGetByIndex: async () => [],
  idbGetMany: async (_store, keys) => keys.map((key) => trashedStore.get(key)),
  idbPut: async (store, value) => {
    putCalls.push({ store, value });
    if (store === "trashed-bookmarks") {
      trashedStore.set(value.id, value);
    }
  },
  idbDelete: async (store, key) => {
    deleteCalls.push({ store, key });
    if (store === "trashed-bookmarks") {
      trashedStore.delete(key);
    }
  },
  idbBulkWrite: async (ops) => {
    bulkWriteCalls.push(ops);
  },
}));

mock.module("@/lib/sync-engine", () => ({
  syncEngine: null,
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

describe("bookmarks store offline permanent delete", () => {
  beforeEach(() => {
    putCalls.length = 0;
    deleteCalls.length = 0;
    bulkWriteCalls.length = 0;
    decrementCalls.length = 0;
    trashedStore.clear();
    useBookmarksStore.setState({
      bookmarks: [],
      archivedBookmarks: [],
      trashedBookmarks: [],
      _archivedLoaded: true,
      _trashedLoaded: true,
    });
  });

  test("keeps an IDB tombstone instead of deleting it", async () => {
    const bookmark = createBookmark("bookmark-offline");
    trashedStore.set(bookmark.id, bookmark);
    useBookmarksStore.setState({
      trashedBookmarks: [bookmark],
      _trashedLoaded: true,
    });

    useBookmarksStore.getState().permanentlyDelete(bookmark.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteCalls).toHaveLength(0);
    expect(putCalls).toContainEqual(
      expect.objectContaining({
        store: "trashed-bookmarks",
        value: expect.objectContaining({
          id: "bookmark-offline",
          seq: 0,
          isTrashed: 2,
        }),
      }),
    );
    expect(decrementCalls).toHaveLength(0);
  });

  test("offline permanentlyDeleteBatch writes seq-0 permanent tombstones and keeps quota unchanged", async () => {
    const firstBookmark = createBookmark("bookmark-batch-1");
    const secondBookmark = createBookmark("bookmark-batch-2");
    trashedStore.set(firstBookmark.id, firstBookmark);
    trashedStore.set(secondBookmark.id, secondBookmark);
    useBookmarksStore.setState({
      trashedBookmarks: [firstBookmark, secondBookmark],
      _trashedLoaded: true,
    });

    useBookmarksStore.getState().permanentlyDeleteBatch([firstBookmark.id, secondBookmark.id]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteCalls).toHaveLength(0);
    expect(bulkWriteCalls).toEqual([
      [
        expect.objectContaining({
          type: "put",
          store: "trashed-bookmarks",
          value: expect.objectContaining({ id: "bookmark-batch-1", seq: 0, isTrashed: 2 }),
        }),
        expect.objectContaining({
          type: "put",
          store: "trashed-bookmarks",
          value: expect.objectContaining({ id: "bookmark-batch-2", seq: 0, isTrashed: 2 }),
        }),
      ],
    ]);
    expect(useBookmarksStore.getState().trashedBookmarks).toEqual([
      expect.objectContaining({ id: "bookmark-batch-1", seq: 0, isTrashed: 2 }),
      expect.objectContaining({ id: "bookmark-batch-2", seq: 0, isTrashed: 2 }),
    ]);
    expect(decrementCalls).toHaveLength(0);
  });

  test("trashCollectionBookmarks returns a Promise so callers can await it", async () => {
    const bookmark = createBookmark("bookmark-active");
    useBookmarksStore.setState({
      bookmarks: [bookmark],
      archivedBookmarks: [],
      trashedBookmarks: [],
      _archivedLoaded: true,
      _trashedLoaded: true,
    });

    const action = Reflect.get(useBookmarksStore.getState(), "trashCollectionBookmarks");
    const result = Reflect.apply(action, useBookmarksStore.getState(), ["collection-1"]);

    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(bulkWriteCalls).toHaveLength(1);
  });
});
