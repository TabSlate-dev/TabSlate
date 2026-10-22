// @ts-expect-error Bun provides this test module at runtime.
import { expect, mock, test } from "bun:test";
import { runsInIsolatedProcess } from "./helpers/isolated-run";
import { installTagIdb } from "./helpers/tag-idb";
import { makeBookmark } from "./helpers/library-fixtures";
import type { Bookmark } from "@/lib/types";

if (runsInIsolatedProcess(import.meta.filename)) {
  const db = installTagIdb();
  const idbModule = { ...db.module,
    idbGetByIndex: async <T>(bucket: string, field: string, value: string): Promise<T[]> => db.read<T>(bucket).filter(record => Reflect.get(Object(record), field) === value),
    idbGetMany: async <T>(bucket: string, ids: string[]): Promise<T[]> => db.read<T & { id: string }>(bucket).filter(record => ids.includes(record.id)),
  };
  mock.module("@/lib/idb", () => idbModule);
  mock.module("@/lib/sync-engine", () => ({ syncEngine: null }));
  mock.module("@/store/plan-store", () => ({ usePlanStore: { getState: () => ({}) }, guardQuota: () => true }));
  mock.module("@/lib/analytics", () => ({ analytics: { track: () => {} } }));
  const { useBookmarksStore: store } = await import("@/store/bookmarks-store");
  test("replacement_publication_preserves_newer_fields_and_unrelated_state_without_writes", () => {
    store.getState().reset();
    const current = makeBookmark("one", { tags: ["A", "other"], title: "newer", updatedAt: 999 });
    const unrelated = makeBookmark("two", { tags: ["other"] });
    store.setState({ bookmarks: new Map([[current.id, current], [unrelated.id, unrelated]]), selectedTags: ["A", "B"], searchQuery: "keep" });
    let publications = 0; const unsubscribe = store.subscribe(() => { publications += 1; });
    store.getState().applyTagReplacementChanges({ active: [{ ...current, title: "old", tags: ["B", "other"], updatedAt: 100 }], archived: [], trashed: [] }, new Map([["A", "B"]]));
    unsubscribe();
    expect(store.getState().bookmarks.get("one")).toEqual({ ...current, tags: ["B", "other"], seq: 0 });
    expect(store.getState().bookmarks.get("two")).toBe(unrelated); expect(store.getState().searchQuery).toBe("keep");
    expect(store.getState().selectedTags).toEqual(["B"]); expect(publications).toBe(1); expect(db.state.transactions).toBe(0);
  });

  for (const bucket of ["archived-bookmarks", "trashed-bookmarks"] as const) {
    test(`inflight_${bucket}_loader_does_not_publish_pre_merge_tags`, async () => {
      store.getState().reset(); db.tables.clear();
      const original = makeBookmark("delayed", { tags: ["A"], deletedAt: Date.now() });
      await db.module.idbPut(bucket, original);
      let release: (() => void) | undefined;
      let started: (() => void) | undefined;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const reading = new Promise<void>(resolve => { started = resolve; });
      let first = true;
      mock.module("@/lib/idb", () => ({ ...idbModule, idbGetAll: async <T>(name: string): Promise<T[]> => {
        const result = await idbModule.idbGetAll<T>(name);
        if (name === bucket && first) { first = false; started?.(); await waiting; }
        return result;
      } }));
      const loading = bucket === "archived-bookmarks" ? store.getState().loadArchivedBookmarks() : store.getState().loadTrashedBookmarks();
      await reading;
      const changed = { ...original, tags: ["B"], updatedAt: Date.now() };
      await db.module.idbPut(bucket, changed);
      store.getState().applyTagReplacementChanges({ active: [], archived: bucket === "archived-bookmarks" ? [changed] : [], trashed: bucket === "trashed-bookmarks" ? [changed] : [] }, new Map([["A", "B"]]));
      expect(bucket === "archived-bookmarks" ? store.getState()._archivedLoaded : store.getState()._trashedLoaded).toBe(false);
      release?.(); await loading;
      expect((bucket === "archived-bookmarks" ? store.getState().archivedBookmarks : store.getState().trashedBookmarks)[0]?.tags).toEqual(["B"]);
      mock.module("@/lib/idb", () => idbModule);
    });
  }

  test("legacy_favicon_migration_patches_current_record_instead_of_replaying_stale_tags", async () => {
    store.getState().reset(); db.tables.clear();
    const legacy = makeBookmark("old", { tags: ["A"], favicon: "data:image/png;base64,old" });
    await db.module.idbPut("archived-bookmarks", legacy);
    const originalRead = db.module.idbGetAll;
    mock.module("@/lib/idb", () => ({ ...idbModule, idbGetAll: async <T>(bucket: string): Promise<T[]> => {
      const result = await originalRead<T>(bucket);
      if (bucket === "archived-bookmarks") {
        const current = { ...legacy, tags: ["B"], title: "current", notes: "current notes" };
        await db.module.idbPut(bucket, current);
      }
      return result;
    } }));
    await store.getState().loadArchivedBookmarks();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(db.read<Bookmark>("archived-bookmarks")[0]).toEqual(expect.objectContaining({ tags: ["B"], title: "current", notes: "current notes", favicon: expect.stringContaining("https://") }));
  });
}
