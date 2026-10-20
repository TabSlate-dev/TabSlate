// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { BulkWriteOp } from "@/lib/idb";
import type { Bookmark } from "@/lib/types";
import { createModuleReplacer } from "./helpers/module-replacer";
import { setupDom, teardownDom } from "./helpers/dom-environment";
import { installBookmarksStoreHarness, type BookmarksStoreHarness } from "./helpers/bookmarks-store-harness";
import { bookmarkMap, countsByCollection, makeBookmark } from "./helpers/library-fixtures";

const NOW = 60_000;
const replacer = createModuleReplacer();
let harness: BookmarksStoreHarness;

beforeAll(async () => {
  setupDom();
  harness = await installBookmarksStoreHarness(replacer);
});
afterAll(async () => {
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  harness.reset();
  setSystemTime(new Date(NOW));
});
afterEach(() => {
  setSystemTime();
});

function store() {
  return harness.useBookmarksStore.getState();
}

function seed(bookmarks: Bookmark[]): void {
  harness.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks) });
}

function countNotifications(action: () => void): number {
  let notifications = 0;
  const unsubscribe = harness.useBookmarksStore.subscribe(() => { notifications += 1; });
  try {
    action();
  } finally {
    unsubscribe();
  }
  return notifications;
}

function describeOps(ops: BulkWriteOp[]): string[] {
  return ops.map((op) => (op.type === "put" ? `put ${op.store} ${String(Reflect.get(op.value, "id"))}` : `delete ${op.store} ${String(op.key)}`));
}

const reading = { collectionId: "reading", updatedAt: 1 };

describe("updateBookmarks", () => {
  test("applies every change in one state update, one transaction and one enqueue", () => {
    seed([
      makeBookmark("a", reading),
      makeBookmark("b", reading),
      makeBookmark("c", { collectionId: "projects", updatedAt: 1 }),
    ]);
    const before = store().bookmarks;

    const notifications = countNotifications(() => store().updateBookmarks([
      { id: "a", patch: { collectionId: "projects" } },
      { id: "b", patch: { collectionId: "reading" } },
      { id: "c", patch: { tags: ["t1"], isFavorite: false } },
      { id: "missing", patch: { title: "Missing" } },
    ]));

    expect(notifications).toBe(1);
    expect(harness.writes).toEqual([]);
    const state = store();
    expect(state.bookmarks).not.toBe(before);
    expect(state.bookmarks.get("a")?.collectionId).toBe("projects");
    expect(state.bookmarks.get("a")?.updatedAt).toBe(NOW);
    expect(state.bookmarks.get("b")?.updatedAt).toBe(1);
    expect(state.bookmarks.get("c")?.tags).toEqual(["t1"]);
    expect(state.bookmarks.get("c")?.updatedAt).toBe(NOW);
    expect(state.countsByCollection).toEqual({ reading: 1, projects: 2 });
    expect(harness.bulkWrites.map(describeOps)).toEqual([["put bookmarks a", "put bookmarks c"]]);
    expect(harness.enqueued.map((entities) => entities.bookmarks?.map((entity) => entity.id))).toEqual([["a", "c"]]);
    expect(harness.enqueued[0]?.bookmarks?.every((entity) => entity.edited_at === NOW)).toBe(true);
  });

  test("a batch that changes nothing writes nothing", () => {
    seed([makeBookmark("a", reading)]);
    const before = store().bookmarks;

    const notifications = countNotifications(() => store().updateBookmarks([{ id: "a", patch: { title: "a", notes: "", tags: [] } }]));
    expect(notifications).toBe(0);

    expect(store().bookmarks).toBe(before);
    expect(harness.bulkWrites).toEqual([]);
    expect(harness.enqueued).toEqual([]);
  });
});

describe("archiveBookmarks", () => {
  test("moves active bookmarks to the loaded archive in one transaction and pushes them as archived", () => {
    seed([makeBookmark("a", reading), makeBookmark("b", reading), makeBookmark("c", reading)]);

    const notifications = countNotifications(() => store().archiveBookmarks(["a", "b", "a", "missing"]));
    expect(notifications).toBe(1);
    expect(harness.writes).toEqual([]);

    const state = store();
    expect([...state.bookmarks.keys()]).toEqual(["c"]);
    expect(state.countsByCollection).toEqual({ reading: 1 });
    expect(state.archivedBookmarks.map((bookmark) => [bookmark.id, bookmark.updatedAt])).toEqual([["a", NOW], ["b", NOW]]);
    expect(harness.bulkWrites.map(describeOps)).toEqual([[
      "delete bookmarks a", "put archived-bookmarks a",
      "delete bookmarks b", "put archived-bookmarks b",
    ]]);
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]?.bookmarks?.map((entity) => [entity.id, entity.is_archived])).toEqual([["a", true], ["b", true]]);
  });

  test("leaves an archive that is not loaded alone and writes IndexedDB only", () => {
    seed([makeBookmark("a", reading)]);
    const unloaded: Bookmark[] = [];
    harness.useBookmarksStore.setState({ _archivedLoaded: false, archivedBookmarks: unloaded });

    store().archiveBookmarks(["a"]);

    expect(store().archivedBookmarks).toBe(unloaded);
    expect(harness.bulkWrites.map(describeOps)).toEqual([["delete bookmarks a", "put archived-bookmarks a"]]);
  });
});

describe("trashBookmarks", () => {
  test("trashes active bookmarks in one transaction, pushes them as trashed and moves usage once", () => {
    seed([makeBookmark("a", reading), makeBookmark("b", reading)]);
    const moves: Array<[string, number | undefined]> = [];
    const originalMove = harness.usePlanStore.getState().moveUsageToTrash;
    harness.usePlanStore.setState({ moveUsageToTrash: (resource, by) => { moves.push([resource, by]); } });
    try {
      const notifications = countNotifications(() => store().trashBookmarks(["a", "b", "a", "missing"]));
      expect(notifications).toBe(1);
      expect(harness.writes).toEqual([]);
    } finally {
      harness.usePlanStore.setState({ moveUsageToTrash: originalMove });
    }

    const state = store();
    expect(state.bookmarks.size).toBe(0);
    expect(state.countsByCollection).toEqual({});
    expect(state.trashedBookmarks.map((bookmark) => [bookmark.id, bookmark.deletedAt, bookmark.updatedAt])).toEqual([
      ["a", NOW, NOW],
      ["b", NOW, NOW],
    ]);
    expect(harness.bulkWrites.map(describeOps)).toEqual([[
      "delete bookmarks a", "put trashed-bookmarks a",
      "delete bookmarks b", "put trashed-bookmarks b",
    ]]);
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]?.bookmarks?.map((entity) => [entity.id, entity.is_trashed, entity.deleted_at])).toEqual([
      ["a", 1, null],
      ["b", 1, null],
    ]);
    expect(moves).toEqual([["bookmark", 2]]);
  });

  test("leaves a trash that is not loaded alone", () => {
    seed([makeBookmark("a", reading)]);
    const unloaded: Bookmark[] = [];
    harness.useBookmarksStore.setState({ _trashedLoaded: false, trashedBookmarks: unloaded });

    store().trashBookmarks(["a"]);

    expect(store().trashedBookmarks).toBe(unloaded);
    expect(harness.bulkWrites.map(describeOps)).toEqual([["delete bookmarks a", "put trashed-bookmarks a"]]);
  });

  test("does nothing when none of the IDs are active", () => {
    store().trashBookmarks(["missing"]);
    expect(harness.bulkWrites).toEqual([]);
    expect(harness.enqueued).toEqual([]);
  });
});

describe("duplicate patches", () => {
  test("a change followed by a revert preserves the original state without notifications, writes or enqueue", () => {
    const original = makeBookmark("a", { ...reading, tags: ["t1"] });
    seed([original]);
    const before = store();

    const notifications = countNotifications(() => store().updateBookmarks([
      { id: "a", patch: { title: "Changed", collectionId: "projects", notes: "Added", tags: ["t2"], isFavorite: true } },
      { id: "a", patch: { title: "a", collectionId: "reading", notes: "", tags: ["t1"], isFavorite: false } },
    ]));

    expect(notifications).toBe(0);
    expect(store()).toBe(before);
    expect(store().bookmarks.get("a")).toBe(original);
    expect(store().bookmarks.get("a")?.updatedAt).toBe(1);
    expect(harness.bulkWrites).toEqual([]);
    expect(harness.writes).toEqual([]);
    expect(harness.enqueued).toEqual([]);
  });

  test("folds entries in input order, stamps only final changes, and counts only final collection moves", () => {
    const unchanged = makeBookmark("b", reading);
    seed([makeBookmark("a", reading), unchanged]);

    const notifications = countNotifications(() => store().updateBookmarks([
      { id: "a", patch: { title: "First", collectionId: "temporary", notes: "Keep", isFavorite: true } },
      { id: "b", patch: { title: "Temporary" } },
      { id: "a", patch: { title: "Last", collectionId: "projects", url: "https://updated.example.com", description: "Description", tags: ["t1"] } },
      { id: "b", patch: { title: "b" } },
    ]));

    expect(notifications).toBe(1);
    expect(store().bookmarks.get("a")).toMatchObject({
      title: "Last", collectionId: "projects", notes: "Keep", isFavorite: true,
      url: "https://updated.example.com", description: "Description", tags: ["t1"], updatedAt: NOW,
    });
    expect(store().bookmarks.get("b")).toBe(unchanged);
    expect(store().countsByCollection).toEqual({ reading: 1, projects: 1 });
    expect(harness.bulkWrites.map(describeOps)).toEqual([["put bookmarks a"]]);
    expect(harness.enqueued.map((entities) => entities.bookmarks?.map((entity) => entity.id))).toEqual([["a"]]);
  });
});

describe("active-only batches", () => {
  test("all actions skip archived, trashed and missing IDs, including empty batches", () => {
    const archived = [makeBookmark("archived", reading)];
    const trashed = [makeBookmark("trashed", { ...reading, deletedAt: 5 })];
    harness.useBookmarksStore.setState({ archivedBookmarks: archived, trashedBookmarks: trashed });
    const before = store();
    const inactive = ["archived", "trashed", "missing"];
    const notifications = countNotifications(() => {
      store().updateBookmarks(inactive.map((id) => ({ id, patch: { title: "Ignored" } })));
      store().archiveBookmarks(inactive);
      store().trashBookmarks(inactive);
      store().updateBookmarks([]);
      store().archiveBookmarks([]);
      store().trashBookmarks([]);
    });

    expect(notifications).toBe(0);
    expect(store()).toBe(before);
    expect(harness.bulkWrites).toEqual([]);
    expect(harness.writes).toEqual([]);
    expect(harness.enqueued).toEqual([]);
  });

  test("archiving does not move usage and trashing only moves active distinct IDs", () => {
    seed([makeBookmark("a", reading), makeBookmark("b", { collectionId: "projects" })]);
    const moves: Array<[string, number | undefined]> = [];
    const originalMove = harness.usePlanStore.getState().moveUsageToTrash;
    harness.usePlanStore.setState({ moveUsageToTrash: (resource, by) => { moves.push([resource, by]); } });
    try {
      store().archiveBookmarks(["a"]);
      expect(moves).toEqual([]);
      store().trashBookmarks(["a", "b", "b", "missing"]);
      store().trashBookmarks(["a", "b"]);
      expect(moves).toEqual([["bookmark", 1]]);
      expect(store().countsByCollection).toEqual({});
    } finally {
      harness.usePlanStore.setState({ moveUsageToTrash: originalMove });
    }
  });
});

