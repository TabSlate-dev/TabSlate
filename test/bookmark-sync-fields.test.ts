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

  test("a sweep pushes legacy bookmarks with their creation time and no notes, without stamping them", async () => {
    seed([
      makeBookmark("legacy", { collectionId: "reading", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeBookmark("epoch", { collectionId: "reading", createdAt: "1748390400000" }),
    ]);

    await store().sweepUnsynced();

    expect(pushedBookmarks().map((entity) => [entity.id, wireJson(entity).notes, entity.edited_at])).toEqual([
      ["legacy", undefined, Date.parse("2026-01-01T00:00:00.000Z")],
      ["epoch", undefined, 1748390400000],
    ]);
    expect(store().bookmarks.get("legacy")?.updatedAt).toBeUndefined();
  });
});

/** The entity as the push request carries it. */
function wireJson(entity: SyncEntity | undefined): Record<string, unknown> {
  return JSON.parse(JSON.stringify(entity ?? {}));
}

describe("notes in pushes", () => {
  // An older extension stores pulled bookmarks without their notes. Pushing ""
  // for them after an upgrade would clear notes another device wrote.
  test("bookmarks stored without notes push no notes, so the server keeps the stored ones", () => {
    seed([
      makeBookmark("pulled-by-older", { collectionId: "reading" }),
      makeBookmark("noted", { collectionId: "reading", notes: "Keep" }),
    ]);

    store().updateBookmarks([
      { id: "pulled-by-older", patch: { collectionId: "inbox" } },
      { id: "noted", patch: { collectionId: "inbox" } },
    ]);

    const pushed = new Map(pushedBookmarks().map((entity) => [entity.id, wireJson(entity)]));
    expect(pushed.get("pulled-by-older")).not.toHaveProperty("notes");
    expect(pushed.get("noted")).toHaveProperty("notes", "Keep");
  });

  test("a cleared note pushes an empty note", () => {
    seed([makeBookmark("cleared", { collectionId: "reading", notes: "Old note" })]);

    store().updateBookmark("cleared", { notes: "" });

    expect(wireJson(pushedBookmarks()[0])).toHaveProperty("notes", "");
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
      image_url: bookmark.imageUrl,
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

  test("an omitted cover push cannot confirm a later explicit clear in any loaded bucket", () => {
    const current = makeBookmark("b1", { collectionId: "reading", imageUrl: "", updatedAt: 200 });
    for (const bucket of ["active", "archived", "trashed"]) {
      seed(bucket === "active" ? [current] : [], {
        archived: bucket === "archived" ? [current] : [],
        trashed: bucket === "trashed" ? [current] : [],
      });
      const omitted = {
        ...entityFor({ ...current, imageUrl: undefined }),
        is_archived: bucket === "archived",
        is_trashed: bucket === "trashed" ? 1 : 0,
      };
      const stored = () => bucket === "active" ? store().bookmarks.get("b1")
        : bucket === "archived" ? store().archivedBookmarks[0] : store().trashedBookmarks[0];
      store().confirmBookmarkEntitySeqs([omitted], 42);
      expect(stored()?.seq).toBe(0);
      store().confirmBookmarkEntitySeqs([{ ...omitted, image_url: "" }], 42);
      expect(stored()?.seq).toBe(42);
    }
  });

  test("a push of an older cover does not confirm the newer local bookmark", () => {
    const current = makeBookmark("b1", { collectionId: "reading", imageUrl: "https://cdn.example.com/new.png", updatedAt: 200 });
    seed([current]);

    store().confirmBookmarkEntitySeqs([entityFor({ ...current, imageUrl: "https://cdn.example.com/old.png" })], 42);
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

describe("covers", () => {
  test("adding pushes a known cover and omits an unknown one", () => {
    store().addBookmark({
      title: "Docs", url: "https://docs.example.com", description: "", favicon: "",
      collectionId: "reading", tags: [], seq: 0, imageUrl: "https://cdn.example.com/docs.png",
    });
    store().addBookmark({
      title: "Plain", url: "https://plain.example.com", description: "", favicon: "",
      collectionId: "reading", tags: [], seq: 0,
    });
    expect(pushedBookmarks().map((entity) => entity.image_url)).toEqual(["https://cdn.example.com/docs.png", undefined]);
    expect(wireJson(pushedBookmarks()[1])).not.toHaveProperty("image_url");
  });

  test("an upgraded profile with a nonzero cursor omits an unknown cover after an unrelated edit", async () => {
    // An older client discarded the cover when it persisted this already-synced record.
    harness.records.set("bookmarks", new Map([["legacy", makeBookmark("legacy", { collectionId: "reading", seq: 7 })]]));
    harness.records.set("kv", new Map([["localSeq", { key: "localSeq", value: 10 }]]));
    await store().hydrate();
    const cursor = harness.records.get("kv")?.get("localSeq");
    const { SyncEngine } = await import("@/lib/sync-engine");
    const pullCursors: number[] = [];
    const engine = new SyncEngine(
      () => ({ baseUrl: "https://sync.example.com", accessToken: "token" }),
      () => Number(Reflect.get(cursor ?? {}, "value")),
      async (response) => { await store().mergeFromServer(response); return { errorMessage: null }; },
      async () => null,
      () => {},
      async () => false,
      {
        createQueue: () => ({
          enqueue: () => {}, flush: async () => {}, isEmpty: () => true, ready: async () => {},
          extractEntities: () => ({ entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] } }),
          copyEntities: () => ({ entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] } }),
          blockEntities: () => {}, pruneEntities: async () => {}, destroy: () => {},
        }),
        createSseClient: () => ({ failureCount: 0, start: () => {}, destroy: () => {} }),
        syncPull: async (_baseUrl, _accessToken, afterSeq) => {
          pullCursors.push(afterSeq);
          // No bookmark changed after the persisted cursor, so there is no cover to relearn.
          return { entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] }, server_seq: 10 };
        },
      },
    );
    try {
      await engine.forceSync();
      expect(pullCursors).toEqual([10]);
      expect(store().bookmarks.get("legacy")?.seq).toBe(7);
      store().toggleFavorite("legacy");
      const pushed = wireJson(pushedBookmarks().at(-1));
      expect(pushed).toHaveProperty("is_favorite", true);
      expect(pushed).not.toHaveProperty("image_url");
      expect(pushed).not.toHaveProperty("notes");
    } finally {
      engine.destroy();
    }
  });

  test("an explicit empty batch patch makes an unknown cover known and pushes the clear", () => {
    seed([makeBookmark("legacy", { collectionId: "reading", seq: 7, updatedAt: 3 })]);
    store().updateBookmarks([{ id: "legacy", patch: { imageUrl: "" } }]);
    expect(store().bookmarks.get("legacy")?.imageUrl).toBe("");
    expect(store().bookmarks.get("legacy")?.updatedAt).toBe(NOW);
    expect(wireJson(pushedBookmarks().at(-1))).toHaveProperty("image_url", "");
  });

  test("an old-server merge preserves unknown covers on existing and newly pulled records", async () => {
    seed([makeBookmark("legacy", { collectionId: "reading", seq: 7 })]);
    await merge([serverBookmark("legacy"), serverBookmark("new")]);
    expect(store().bookmarks.get("legacy")?.imageUrl).toBeUndefined();
    expect(store().bookmarks.get("new")?.imageUrl).toBeUndefined();
    store().updateBookmarks([
      { id: "legacy", patch: { title: "Renamed legacy" } },
      { id: "new", patch: { title: "Renamed new" } },
    ]);
    expect(pushedBookmarks()).toHaveLength(2);
    for (const entity of pushedBookmarks()) {
      expect(wireJson(entity)).not.toHaveProperty("image_url");
    }
  });

  test("an edit that clears the cover stores and pushes an empty string", () => {
    seed([makeBookmark("b1", { collectionId: "reading", imageUrl: "https://cdn.example.com/old.png" })]);
    store().updateBookmark("b1", { imageUrl: "" });
    expect(store().bookmarks.get("b1")?.imageUrl).toBe("");
    expect(pushedBookmarks().at(-1)?.image_url).toBe("");
  });

  test("a batch patch changes the cover only when it differs", () => {
    seed([makeBookmark("b1", { collectionId: "reading", imageUrl: "https://cdn.example.com/a.png", updatedAt: 3 })]);
    store().updateBookmarks([{ id: "b1", patch: { imageUrl: "https://cdn.example.com/a.png" } }]);
    expect(pushedBookmarks()).toEqual([]);
    expect(store().bookmarks.get("b1")?.updatedAt).toBe(3);

    store().updateBookmarks([{ id: "b1", patch: { imageUrl: "https://cdn.example.com/b.png" } }]);
    expect(store().bookmarks.get("b1")?.imageUrl).toBe("https://cdn.example.com/b.png");
    expect(pushedBookmarks().at(-1)?.image_url).toBe("https://cdn.example.com/b.png");
  });

  test("merging takes the server's cover, and an empty one clears the local cover", async () => {
    seed([
      makeBookmark("b1", { collectionId: "reading", imageUrl: "https://cdn.example.com/local.png" }),
      makeBookmark("b2", { collectionId: "reading", imageUrl: "https://cdn.example.com/local.png" }),
    ]);
    await merge([
      serverBookmark("b1", { image_url: "https://cdn.example.com/remote.png" }),
      serverBookmark("b2", { image_url: "" }),
    ]);
    expect(store().bookmarks.get("b1")?.imageUrl).toBe("https://cdn.example.com/remote.png");
    expect(store().bookmarks.get("b2")?.imageUrl).toBe("");
  });

  test("merging keeps the local cover when the server predates covers", async () => {
    seed([makeBookmark("b1", { collectionId: "reading", imageUrl: "https://cdn.example.com/local.png" })]);
    await merge([serverBookmark("b1")]);
    expect(store().bookmarks.get("b1")?.imageUrl).toBe("https://cdn.example.com/local.png");
  });
});
