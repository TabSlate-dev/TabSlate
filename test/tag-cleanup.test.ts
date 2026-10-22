// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, expect, mock, test } from "bun:test";
import { runsInIsolatedProcess } from "./helpers/isolated-run";
import { installTagIdb } from "./helpers/tag-idb";
import { makeBookmark } from "./helpers/library-fixtures";
import type { Bookmark, Tag } from "@/lib/types";
import type { SyncPushEntities } from "@/lib/api";

if (runsInIsolatedProcess(import.meta.filename)) {
  const db = installTagIdb();
  const idbModule = { ...db.module,
    idbGetByIndex: async <T>(bucket: string, field: string, value: string): Promise<T[]> => db.read<T>(bucket).filter(record => Reflect.get(Object(record), field) === value),
    idbGetMany: async <T>(bucket: string, ids: string[]): Promise<T[]> => db.read<T & { id: string }>(bucket).filter(record => ids.includes(record.id)),
  };
  mock.module("@/lib/idb", () => idbModule);
  const enqueued: Partial<SyncPushEntities>[] = [];
  let usage = 0;
  let prepare: (() => Promise<void>) | undefined;
  mock.module("@/lib/sync-engine", () => ({ syncEngine: { enqueue: (payload: Partial<SyncPushEntities>) => enqueued.push(payload) } }));
  mock.module("@/store/plan-store", () => ({
    usePlanStore: { getState: () => ({ ensureFresh: () => prepare?.(), checkQuota: () => true,
      incrementUsage: (_resource: string, by = 1) => { usage += by; }, decrementUsage: (_resource: string, by = 1) => { usage -= by; } }) }, guardQuota: () => true,
  }));
  mock.module("@/store/auth-store", () => ({ useAuthStore: { getState: () => ({ user: null, serverUrl: "" }) } }));
  mock.module("@/store/groups-store", () => ({ useGroupsStore: { getState: () => ({}) } }));
  mock.module("@/lib/analytics", () => ({ analytics: { track: () => {} } }));
  const { useBookmarksStore: bookmarks } = await import("@/store/bookmarks-store");
  const { useWorkspaceStore: workspace } = await import("@/store/workspace-store");
  const tag = (id: string, parentId?: string, name = id): Tag => ({ id, parentId, name, color: "blue", seq: 2 });
  const seedTags = (tags: Tag[]) => { db.seed(tags); workspace.setState({ tags }); };
  const seedBookmark = async (bucket: "bookmarks" | "archived-bookmarks" | "trashed-bookmarks", bookmark: Bookmark) => { await db.module.idbPut(bucket, bookmark); };
  beforeEach(() => {
    workspace.getState().reset(); bookmarks.getState().reset(); db.tables.clear(); db.state.transactions = 0; db.state.fail = false; db.state.beforeRead = undefined;
    enqueued.length = 0; usage = 0; prepare = undefined;
  });

  test("recursive_merge_updates_all_buckets_and_filters_in_one_transaction_and_enqueue", async () => {
    seedTags([tag("A"), tag("AD", "A", "Docs"), tag("B"), tag("BD", "B", "Docs"), tag("other")]);
    const active = makeBookmark("active", { tags: ["other", "AD", "BD", "A", "B"], notes: "keep", imageUrl: "", collectionId: "workspace-one" });
    const archived = makeBookmark("archived", { tags: ["A", "AD"], collectionId: "workspace-two" });
    const trashed = makeBookmark("trashed", { tags: ["AD"], notes: "", deletedAt: Date.now(), collectionId: "workspace-two" });
    await seedBookmark("bookmarks", active); await seedBookmark("archived-bookmarks", archived); await seedBookmark("trashed-bookmarks", trashed);
    bookmarks.setState({ bookmarks: new Map([[active.id, active]]), archivedBookmarks: [archived], trashedBookmarks: [trashed], _archivedLoaded: true, _trashedLoaded: true, selectedTags: ["AD", "BD", "other"] });
    expect(await workspace.getState().mergeTag("A", "B")).toEqual({ ok: true });
    expect(bookmarks.getState().bookmarks.get("active")?.tags).toEqual(["other", "BD", "B"]);
    expect(bookmarks.getState().archivedBookmarks[0]?.tags).toEqual(["B", "BD"]);
    expect(bookmarks.getState().trashedBookmarks[0]?.tags).toEqual(["BD"]);
    expect(bookmarks.getState().selectedTags).toEqual(["BD", "other"]);
    expect(db.read<Bookmark>("archived-bookmarks")[0]?.tags).toEqual(["B", "BD"]);
    expect(workspace.getState().tags.map(t => t.id)).toEqual(["B", "BD", "other"]);
    expect(db.state.transactions).toBe(1); expect(enqueued).toHaveLength(1); expect(usage).toBe(-2);
    expect(enqueued[0]?.bookmarks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "active", notes: "keep", image_url: "", is_archived: false, is_trashed: 0, edited_at: expect.any(Number) }),
      expect.objectContaining({ id: "archived", is_archived: true, is_trashed: 0 }),
      expect.objectContaining({ id: "trashed", notes: "", is_trashed: 1, deleted_at: null }),
    ]));
  });

  for (const archivedLoaded of [false, true]) {
    for (const trashedLoaded of [false, true]) {
      test(`merge_preserves_loader_flags_${archivedLoaded}_${trashedLoaded}`, async () => {
        seedTags([tag("A"), tag("B")]);
        const archived = makeBookmark("archived-b", { tags: ["A"] });
        const trashed = makeBookmark("trashed-b", { tags: ["A"], deletedAt: Date.now() });
        await seedBookmark("archived-bookmarks", archived); await seedBookmark("trashed-bookmarks", trashed);
        bookmarks.setState({ _archivedLoaded: archivedLoaded, _trashedLoaded: trashedLoaded, archivedBookmarks: archivedLoaded ? [archived] : [], trashedBookmarks: trashedLoaded ? [trashed] : [] });
        expect(await workspace.getState().mergeTag("A", "B")).toEqual({ ok: true });
        expect(db.read<Bookmark>("archived-bookmarks")[0]?.tags).toEqual(["B"]);
        expect(db.read<Bookmark>("trashed-bookmarks")[0]?.tags).toEqual(["B"]);
        expect(bookmarks.getState()._archivedLoaded).toBe(archivedLoaded); expect(bookmarks.getState()._trashedLoaded).toBe(trashedLoaded);
        expect(bookmarks.getState().archivedBookmarks.map(b => b.tags)).toEqual(archivedLoaded ? [["B"]] : []);
        expect(bookmarks.getState().trashedBookmarks.map(b => b.tags)).toEqual(trashedLoaded ? [["B"]] : []);
        expect(enqueued).toHaveLength(1);
      });
    }
  }

  test("merge_does_not_edit_bookmarks_without_a_replaced_id", async () => {
    seedTags([tag("A"), tag("B"), tag("other")]);
    const untouched = makeBookmark("untouched", { tags: ["other", "other"], updatedAt: 17, seq: 7 });
    await seedBookmark("bookmarks", untouched); bookmarks.setState({ bookmarks: new Map([[untouched.id, untouched]]) });
    await workspace.getState().mergeTag("A", "B");
    expect(db.read<Bookmark>("bookmarks")).toEqual([untouched]);
    expect(bookmarks.getState().bookmarks.get("untouched")).toBe(untouched);
    expect(enqueued[0]?.bookmarks).toBeUndefined();
  });

  test("merge_preserves_bookmark_edit_during_preparation", async () => {
    seedTags([tag("A"), tag("B")]);
    const original = makeBookmark("active", { tags: ["A"], title: "old", updatedAt: 10 });
    await seedBookmark("bookmarks", original); bookmarks.setState({ bookmarks: new Map([[original.id, original]]) });
    prepare = async () => {
      const edited = { ...original, title: "new", notes: "new notes", imageUrl: "cover", updatedAt: 20 };
      await seedBookmark("bookmarks", edited); bookmarks.setState({ bookmarks: new Map([[edited.id, edited]]) });
    };
    await workspace.getState().mergeTag("A", "B");
    expect(db.read<Bookmark>("bookmarks")[0]).toEqual(expect.objectContaining({ title: "new", notes: "new notes", imageUrl: "cover", tags: ["B"] }));
    expect(bookmarks.getState().bookmarks.get("active")?.title).toBe("new");
  });

  test("stale_graph_and_storage_failure_leave_bookmarks_unchanged", async () => {
    seedTags([tag("A"), tag("B")]); const bookmark = makeBookmark("active", { tags: ["A"] });
    await seedBookmark("bookmarks", bookmark); bookmarks.setState({ bookmarks: new Map([[bookmark.id, bookmark]]) });
    db.state.beforeRead = () => db.seed([tag("A"), tag("B", "A")]);
    expect(await workspace.getState().mergeTag("A", "B")).toEqual({ ok: false, error: "stale" });
    expect(db.read<Bookmark>("bookmarks")).toEqual([bookmark]); expect(enqueued).toEqual([]);
    db.state.fail = true;
    expect(await workspace.getState().mergeTag("B", "A")).toEqual({ ok: false, error: "storage" });
    expect(bookmarks.getState().bookmarks.get("active")).toEqual(bookmark); expect(usage).toBe(0);
  });

  test("merge_accepts_ancestor_and_rejects_descendant", async () => {
    seedTags([tag("A"), tag("child", "A")]);
    expect(await workspace.getState().mergeTag("A", "child")).toEqual({ ok: false, error: "cycle" });
    expect(await workspace.getState().mergeTag("child", "A")).toEqual({ ok: true });
  });

  test("recursive_coalescing_validates_final_depth", async () => {
    seedTags([tag("A"), tag("AD", "A", "Docs"), tag("leaf", "AD"), tag("r"), tag("r2", "r"), tag("r3", "r2"), tag("B", "r3"), tag("BD", "B", "Docs")]);
    expect(await workspace.getState().mergeTag("A", "B")).toEqual({ ok: false, error: "depth" });
    expect(enqueued).toEqual([]); expect(db.state.transactions).toBe(0);
    seedTags([tag("A"), tag("AD", "A", "Docs"), tag("r"), tag("r2", "r"), tag("r3", "r2"), tag("B", "r3"), tag("BD", "B", "Docs")]);
    expect(await workspace.getState().mergeTag("A", "B")).toEqual({ ok: true });
    expect(workspace.getState().tags.map(t => t.id)).toEqual(["r", "r2", "r3", "B", "BD"]);
  });

  test("failure_after_bookmark_put_rolls_back_every_bucket_and_tag", async () => {
    seedTags([tag("A"), tag("B")]);
    const original = makeBookmark("one", { tags: ["A"] });
    await seedBookmark("bookmarks", original); bookmarks.setState({ bookmarks: new Map([[original.id, original]]) });
    mock.module("@/lib/idb", () => ({ ...idbModule, idbTransaction: <T>(stores: string[], mode: string, callback: (transaction: IDBTransaction) => T) =>
      db.module.idbTransaction(stores, mode, transaction => callback(new Proxy(transaction, {
        get(target, property) {
          if (property !== "objectStore") { return Reflect.get(target, property); }
          return (name: string) => new Proxy(target.objectStore(name), {
            get(store, key) {
              if (name === "tags" && key === "put") { return () => { throw new Error("tag write failed"); }; }
              return Reflect.get(store, key);
            },
          });
        },
      }))),
    }));
    expect(await workspace.getState().mergeTag("A", "B")).toEqual({ ok: false, error: "storage" });
    expect(db.read<Bookmark>("bookmarks")).toEqual([original]); expect(db.read<Tag>("tags")).toEqual([tag("A"), tag("B")]);
    expect(bookmarks.getState().bookmarks.get("one")).toEqual(original); expect(enqueued).toEqual([]); expect(usage).toBe(0);
    mock.module("@/lib/idb", () => idbModule);
  });

  test("unused_cleanup_loads_buckets_and_retains_trashed_descendant_in_other_workspace", async () => {
    seedTags([tag("parent"), tag("child", "parent"), tag("unused"), tag("unused-child", "unused")]);
    const trashed = makeBookmark("trash", { tags: ["child"], collectionId: "other-workspace", deletedAt: Date.now() });
    await seedBookmark("trashed-bookmarks", trashed);
    bookmarks.setState({ selectedTags: ["unused", "child"] });
    expect(await workspace.getState().deleteUnusedTags()).toEqual({ ok: true });
    expect(workspace.getState().tags.map(t => t.id)).toEqual(["parent", "child"]);
    expect(bookmarks.getState().selectedTags).toEqual(["child"]);
    expect(bookmarks.getState()._archivedLoaded).toBe(true); expect(bookmarks.getState()._trashedLoaded).toBe(true);
    expect(usage).toBe(-2); expect(enqueued).toHaveLength(1); expect(db.state.transactions).toBe(1);
  });

  test("unused_cleanup_revalidates_new_durable_usage_inside_transaction", async () => {
    seedTags([tag("parent"), tag("child", "parent"), tag("unused")]);
    db.state.beforeRead = () => { void seedBookmark("archived-bookmarks", makeBookmark("new", { tags: ["child"] })); };
    expect(await workspace.getState().deleteUnusedTags()).toEqual({ ok: true });
    expect(workspace.getState().tags.map(t => t.id)).toEqual(["parent", "child"]); expect(usage).toBe(-1);
    expect(enqueued[0]?.tags?.map(t => t.id)).toEqual(["unused"]);
  });

  test("unused_cleanup_keeps_references_in_retained_expired_trash", async () => {
    seedTags([tag("used"), tag("unused")]);
    // Loaded trash deliberately excludes grace-expired rows retained in durable storage.
    await seedBookmark("trashed-bookmarks", makeBookmark("old", { tags: ["used"], deletedAt: 1 }));
    bookmarks.setState({ _archivedLoaded: true, _trashedLoaded: true });
    expect(await workspace.getState().deleteUnusedTags()).toEqual({ ok: true });
    expect(workspace.getState().tags.map(t => t.id)).toEqual(["used"]); expect(usage).toBe(-1);
  });
}
