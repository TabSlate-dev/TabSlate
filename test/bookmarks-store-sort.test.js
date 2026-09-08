import { describe, expect, mock, test } from "bun:test";

mock.module("@/lib/idb", () => ({
  idbGet: async () => undefined,
  idbGetAll: async () => [],
  idbGetByIndex: async () => [],
  idbGetMany: async () => [],
  idbPut: async () => {},
  idbDelete: async () => {},
  idbBulkWrite: async () => {},
}));
mock.module("@/lib/sync-engine", () => ({
  syncEngine: { enqueue: () => {}, forcePush: async () => {} },
}));
mock.module("@/store/plan-store", () => ({
  usePlanStore: {
    getState: () => ({
      decrementUsage: () => {},
      incrementUsage: () => {},
      moveUsageToTrash: () => {},
      restoreUsageFromTrash: () => {},
      ensureFresh: async () => {},
      limits: null,
      showQuotaAlert: () => {},
      fetchPlan: async () => {},
      usage: { bookmarks: 0 },
    }),
  },
  guardQuota: (_resource, _currentCount, fallback, fn) => fn() ?? fallback,
}));
mock.module("@/lib/id", () => ({ generateId: () => "generated-id" }));
const bookmarkUtils = await import("../lib/bookmark-utils.ts");
mock.module("@/lib/bookmark-utils", () => ({
  ...bookmarkUtils,
  normalizeFavicon: (favicon) => favicon,
}));

const { useBookmarksStore } = await import(
  `../store/bookmarks-store.ts?test=${Date.now()}-${Math.random()}`
);

function bookmark(id, createdAt) {
  return {
    id,
    title: `Bookmark ${id}`,
    url: `https://example.com/${id}`,
    description: "",
    favicon: "",
    collectionId: "collection-1",
    tags: [],
    createdAt,
    isFavorite: false,
    seq: 1,
  };
}

function sortedIds(entries) {
  useBookmarksStore.setState({
    bookmarks: new Map(entries.map((b) => [b.id, b])),
    selectedCollection: "all",
    selectedTags: [],
    searchQuery: "",
    filterType: "all",
    sortBy: "date-newest",
  });
  return useBookmarksStore
    .getState()
    .getFilteredBookmarks(new Set(["collection-1"]))
    .map((b) => b.id);
}

describe("bookmark sort order", () => {
  // The server sends created_at as epoch ms; those records used to be stored as
  // a numeric string, which new Date() cannot parse.
  const epochStyle = [
    bookmark("a", "1748390400000"), // 2025-05-28
    bookmark("b", "1779926400000"), // 2026-05-28
    bookmark("c", "1716854400000"), // 2024-05-28
  ];

  test("epoch-string createdAt sorts newest first", () => {
    expect(sortedIds(epochStyle)).toEqual(["b", "a", "c"]);
  });

  test("order does not depend on the map's insertion order", () => {
    const forward = sortedIds(epochStyle);
    const reversed = sortedIds([...epochStyle].reverse());
    expect(reversed).toEqual(forward);
  });

  test("iso and epoch-string createdAt sort against each other", () => {
    expect(
      sortedIds([
        bookmark("iso-old", "2024-05-28T00:00:00.000Z"),
        bookmark("epoch-new", "1779926400000"),
        bookmark("iso-mid", "2025-05-28T00:00:00.000Z"),
      ])
    ).toEqual(["epoch-new", "iso-mid", "iso-old"]);
  });

  test("bookmarks saved in one batch keep a stable order", () => {
    const sameInstant = "2026-05-28T00:00:00.000Z";
    const batch = [bookmark("z", sameInstant), bookmark("m", sameInstant), bookmark("a", sameInstant)];
    expect(sortedIds(batch)).toEqual(["a", "m", "z"]);
    expect(sortedIds([...batch].reverse())).toEqual(["a", "m", "z"]);
  });

  test("archived bookmarks come back newest first", () => {
    useBookmarksStore.setState({
      archivedBookmarks: [
        bookmark("a", "1748390400000"),
        bookmark("b", "1779926400000"),
        bookmark("c", "1716854400000"),
      ],
      searchQuery: "",
    });
    expect(useBookmarksStore.getState().getArchivedBookmarks().map((b) => b.id))
      .toEqual(["b", "a", "c"]);
  });

  test("trashed bookmarks come back most recently trashed first", () => {
    const trashed = (id, deletedAt) => ({ ...bookmark(id, "2026-05-28T00:00:00.000Z"), deletedAt });
    useBookmarksStore.setState({
      trashedBookmarks: [trashed("old", 1000), trashed("new", 3000), trashed("mid", 2000)],
      searchQuery: "",
    });
    expect(useBookmarksStore.getState().getTrashedBookmarks().map((b) => b.id))
      .toEqual(["new", "mid", "old"]);
  });
});
