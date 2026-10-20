// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ServerBookmark, SyncEntity } from "@/lib/api";
import type { Bookmark } from "@/lib/types";
import { createModuleReplacer } from "./helpers/module-replacer";
import { setupDom, teardownDom } from "./helpers/dom-environment";
import { installBookmarksStoreHarness, type BookmarksStoreHarness } from "./helpers/bookmarks-store-harness";
import { bookmarkMap, countsByCollection, makeBookmark } from "./helpers/library-fixtures";

const NOW = 50_000;
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

function seed(bookmarks: Bookmark[], buckets: { archived?: Bookmark[]; trashed?: Bookmark[] } = {}): void {
  harness.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    archivedBookmarks: buckets.archived ?? [],
    trashedBookmarks: buckets.trashed ?? [],
  });
}

function pushedBookmarks(): SyncEntity[] {
  return harness.enqueued.flatMap((entities) => entities.bookmarks ?? []);
}

function serverBookmark(id: string, overrides: Partial<ServerBookmark> = {}): ServerBookmark {
  return {
    id,
    user_id: "user",
    collection_id: "reading",
    title: id,
    url: `https://example.com/${id}`,
    is_favorite: false,
    is_archived: false,
    is_trashed: 0,
    tag_ids: [],
    position: 0,
    seq: 7,
    created_at: 1_000,
    updated_at: 9_000,
    ...overrides,
  };
}

async function merge(bookmarks: ServerBookmark[]): Promise<void> {
  await store().mergeFromServer({
    entities: { workspaces: [], collections: [], bookmarks, tags: [], groups: [] },
    server_seq: 10,
  });
}

describe("edit time", () => {
  test("adding a bookmark stamps it and pushes its notes and edit time", () => {
    const added = store().addBookmark({
      title: "Docs", url: "https://docs.example.com", description: "", notes: "Read later",
      favicon: "", collectionId: "reading", tags: [], seq: 0,
    });
    expect(added.updatedAt).toBe(NOW);
    const [entity] = pushedBookmarks();
    expect(entity?.notes).toBe("Read later");
    expect(entity?.edited_at).toBe(NOW);
  });

  test("bulk adds and imports stamp every bookmark", () => {
    store().addBookmarks([makeBookmark("dropped", { collectionId: "reading" })]);
    store()._bulkAddBookmarks([makeBookmark("imported", { collectionId: "reading" })]);
    expect(store().bookmarks.get("dropped")?.updatedAt).toBe(NOW);
    expect(store().bookmarks.get("imported")?.updatedAt).toBe(NOW);
  });

  test("editing, favoriting, archiving, trashing and restoring stamp the edit time", () => {
    const stale = { collectionId: "reading", updatedAt: 1 };
    seed(
      [makeBookmark("edit", stale), makeBookmark("favorite", stale), makeBookmark("archive", stale), makeBookmark("trash", stale)],
      {
        archived: [makeBookmark("unarchive", stale), makeBookmark("archive-edit", stale)],
        trashed: [makeBookmark("untrash", { ...stale, deletedAt: 5 }), makeBookmark("trash-edit", stale)],
      },
    );

    store().updateBookmark("edit", { title: "Edited", updatedAt: 99 });
    store().updateBookmark("archive-edit", { notes: "Archived note" });
    store().updateBookmark("trash-edit", { notes: "Trashed note" });
    store().toggleFavorite("favorite");
    store().archiveBookmark("archive");
    store().trashBookmark("trash");
    store().restoreFromArchive("unarchive");
    store().restoreFromTrash("untrash");

    const state = store();
    expect(state.bookmarks.get("edit")?.updatedAt).toBe(NOW);
    expect(state.archivedBookmarks.find((bookmark) => bookmark.id === "archive-edit")?.updatedAt).toBe(NOW);
    expect(state.trashedBookmarks.find((bookmark) => bookmark.id === "trash-edit")?.updatedAt).toBe(NOW);
    expect(state.bookmarks.get("favorite")?.updatedAt).toBe(NOW);
    expect(state.archivedBookmarks.find((bookmark) => bookmark.id === "archive")?.updatedAt).toBe(NOW);
    expect(state.trashedBookmarks.find((bookmark) => bookmark.id === "trash")?.updatedAt).toBe(NOW);
    expect(state.bookmarks.get("unarchive")?.updatedAt).toBe(NOW);
    expect(state.bookmarks.get("untrash")?.updatedAt).toBe(NOW);
    expect(pushedBookmarks().every((entity) => entity.edited_at === NOW)).toBe(true);
  });

  test("editing and restoring unloaded archive and trash records stamps the edit time", async () => {
    harness.records.set("archived-bookmarks", new Map([
      ["archive-edit", makeBookmark("archive-edit", { updatedAt: 1 })],
      ["unarchive", makeBookmark("unarchive", { updatedAt: 1 })],
    ]));
    harness.records.set("trashed-bookmarks", new Map([
      ["trash-edit", makeBookmark("trash-edit", { updatedAt: 1 })],
      ["untrash", makeBookmark("untrash", { updatedAt: 1, deletedAt: 5 })],
    ]));
    harness.useBookmarksStore.setState({ _archivedLoaded: false, _trashedLoaded: false });

    store().updateBookmark("archive-edit", { notes: "Archived note" });
    store().updateBookmark("trash-edit", { notes: "Trashed note" });
    store().restoreFromArchive("unarchive");
    store().restoreFromTrash("untrash", "reading");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(store().bookmarks.get("unarchive")?.updatedAt).toBe(NOW);
    expect(store().bookmarks.get("untrash")?.updatedAt).toBe(NOW);
    expect(store().bookmarks.get("untrash")?.collectionId).toBe("reading");
    expect(pushedBookmarks()).toHaveLength(4);
    expect(pushedBookmarks().every((entity) => entity.edited_at === NOW)).toBe(true);
    expect(pushedBookmarks().find((entity) => entity.id === "archive-edit")?.notes).toBe("Archived note");
    expect(pushedBookmarks().find((entity) => entity.id === "trash-edit")?.notes).toBe("Trashed note");
  });

  test("collection cascades and reassignment preserve the bookmark edit time", async () => {
    seed([makeBookmark("b1", { collectionId: "reading", notes: "Keep", updatedAt: 123 })]);
    store().archiveCollectionBookmarks("reading");
    expect(store().archivedBookmarks[0]?.updatedAt).toBe(123);
    await store().trashCollectionBookmarks("reading");
    expect(store().trashedBookmarks[0]?.updatedAt).toBe(123);
    store().restoreCollectionBookmarks("reading");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    store().reassignCollection("reading", "moved");
    expect(store().bookmarks.get("b1")?.updatedAt).toBe(123);
    expect(store().bookmarks.get("b1")?.notes).toBe("Keep");
    expect(pushedBookmarks()).toHaveLength(4);
    expect(pushedBookmarks().every((entity) => entity.edited_at === 123)).toBe(true);
  });

  test("a sweep pushes legacy bookmarks with their creation time and empty notes, without stamping them", async () => {
    seed([
      makeBookmark("legacy", { collectionId: "reading", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeBookmark("epoch", { collectionId: "reading", createdAt: "1748390400000" }),
    ]);

    await store().sweepUnsynced();

    expect(pushedBookmarks().map((entity) => [entity.id, entity.notes, entity.edited_at])).toEqual([
      ["legacy", "", Date.parse("2026-01-01T00:00:00.000Z")],
      ["epoch", "", 1748390400000],
    ]);
    expect(store().bookmarks.get("legacy")?.updatedAt).toBeUndefined();
  });
});

describe("mergeFromServer", () => {
  test("takes notes and the edit time from a server that sends them", async () => {
    seed([makeBookmark("b1", { collectionId: "reading", notes: "local", updatedAt: 3 })]);
    await merge([serverBookmark("b1", { notes: "remote", edited_at: 4_000 })]);
    expect(store().bookmarks.get("b1")?.notes).toBe("remote");
    expect(store().bookmarks.get("b1")?.updatedAt).toBe(4_000);
  });

  test("keeps local notes when the server sends none and falls back to its updated_at", async () => {
    seed([makeBookmark("b1", { collectionId: "reading", notes: "local", updatedAt: 3 })]);
    await merge([serverBookmark("b1")]);
    expect(store().bookmarks.get("b1")?.notes).toBe("local");
    expect(store().bookmarks.get("b1")?.updatedAt).toBe(9_000);
  });

  test("zero server timestamps are retained and a missing server timestamp keeps the local one", async () => {
    seed([
      makeBookmark("edited-zero", { updatedAt: 3 }),
      makeBookmark("updated-zero", { updatedAt: 3 }),
      makeBookmark("missing", { updatedAt: 3 }),
    ]);
    const missingTimestamp = serverBookmark("missing");
    Reflect.deleteProperty(missingTimestamp, "updated_at");
    await merge([
      serverBookmark("edited-zero", { edited_at: 0 }),
      serverBookmark("updated-zero", { updated_at: 0 }),
      missingTimestamp,
    ]);
    expect(store().bookmarks.get("edited-zero")?.updatedAt).toBe(0);
    expect(store().bookmarks.get("updated-zero")?.updatedAt).toBe(0);
    expect(store().bookmarks.get("missing")?.updatedAt).toBe(3);
  });

  test("an empty note from the server clears the local one", async () => {
    seed([makeBookmark("b1", { collectionId: "reading", notes: "local" })]);
    await merge([serverBookmark("b1", { notes: "" })]);
    expect(store().bookmarks.get("b1")?.notes).toBe("");
  });
});

describe("push confirmation", () => {
  function entityFor(bookmark: Bookmark): SyncEntity {
    return {
      id: bookmark.id,
      collection_id: bookmark.collectionId || null,
      title: bookmark.title,
      url: bookmark.url,
      favicon_url: bookmark.favicon,
      description: bookmark.description,
      notes: bookmark.notes ?? "",
      is_favorite: bookmark.isFavorite,
      is_archived: false,
      is_trashed: 0,
      tag_ids: bookmark.tags,
      position: 0,
      seq: bookmark.seq,
      deleted_at: null,
      updated_at: 1,
      edited_at: bookmark.updatedAt ?? 0,
    };
  }

  test("a push of older notes or an older edit time does not confirm the newer local bookmark", () => {
    const current = makeBookmark("b1", { collectionId: "reading", notes: "new", updatedAt: 200 });
    seed([current]);

    store().confirmBookmarkEntitySeqs([entityFor({ ...current, notes: "old" })], 42);
    expect(store().bookmarks.get("b1")?.seq).toBe(0);
    store().confirmBookmarkEntitySeqs([entityFor({ ...current, updatedAt: 100 })], 42);
    expect(store().bookmarks.get("b1")?.seq).toBe(0);
    store().confirmBookmarkEntitySeqs([entityFor(current)], 42);
    expect(store().bookmarks.get("b1")?.seq).toBe(42);
  });
});

test("search also matches notes", () => {
  seed([
    makeBookmark("noted", { collectionId: "reading", notes: "Kubernetes deep dive" }),
    makeBookmark("plain", { collectionId: "reading" }),
  ]);
  harness.useBookmarksStore.setState({ searchQuery: "kubernetes" });
  expect(store().getFilteredBookmarks(new Set(["reading"])).map((bookmark) => bookmark.id)).toEqual(["noted"]);
});
