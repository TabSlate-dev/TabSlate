// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, expect, mock, test } from "bun:test";
import { runsInIsolatedProcess } from "./helpers/isolated-run";
import { installTagIdb } from "./helpers/tag-idb";
import type { SyncEntity, SyncPullResponse, ServerTag } from "@/lib/api";
import { makeBookmark } from "./helpers/library-fixtures";
import type { Bookmark, Tag } from "@/lib/types";

if (runsInIsolatedProcess(import.meta.filename)) {
  const db = installTagIdb();
  const enqueued: object[] = [];
  let limit = 100;
  let alerts = 0;
  let usage = 0;
  const bookmarks = new Map<string, Bookmark>();
  mock.module("@/lib/sync-engine", () => ({ syncEngine: { enqueue: (payload: object) => enqueued.push(payload) } }));
  mock.module("@/store/plan-store", () => ({
    usePlanStore: { getState: () => ({
      ensureFresh: () => {}, checkQuota: (_resource: string, count: number) => count < limit,
      showQuotaAlert: () => { alerts += 1; }, incrementUsage: (_resource: string, by = 1) => { usage += by; },
      decrementUsage: (_resource: string, by = 1) => { usage -= by; },
    }) }, guardQuota: () => { throw new Error("unexpected old quota gate"); },
  }));
  mock.module("@/store/auth-store", () => ({ useAuthStore: { getState: () => ({ user: null, serverUrl: "" }) } }));
  mock.module("@/store/bookmarks-store", () => ({ useBookmarksStore: { getState: () => ({ bookmarks, confirmBookmarkEntitySeqs: () => {} }) } }));
  mock.module("@/store/groups-store", () => ({ useGroupsStore: { getState: () => ({ confirmGroupEntitySeqs: () => {} }) } }));
  mock.module("@/lib/analytics", () => ({ analytics: { track: () => {} } }));
  const { useWorkspaceStore: store } = await import("@/store/workspace-store");
  const tag = (id: string, parentId?: string, name = id): Tag => ({ id, parentId, name, color: "blue", seq: 2 });
  const seed = (tags: Tag[]) => { db.seed(tags); store.setState({ tags }); };
  const pull = (tags: ServerTag[]): SyncPullResponse => ({ entities: { workspaces: [], collections: [], bookmarks: [], groups: [], tags }, server_seq: 10 });

  beforeEach(() => {
    store.getState().reset(); db.tables.clear(); db.state.transactions = 0; db.state.fail = false; db.state.failReads = false; db.state.beforeRead = undefined;
    enqueued.length = 0; bookmarks.clear(); limit = 100; alerts = 0; usage = 0;
  });

  test("path_quota_is_atomic", async () => {
    limit = 2;
    expect(await store.getState().createTagPath("编程/后端/Go", "blue")).toEqual({ ok: false, error: "quota" });
    expect(store.getState().tags).toEqual([]); expect(db.read("tags")).toEqual([]);
    expect(enqueued).toEqual([]); expect(alerts).toBe(1);
  });
  test("all_existing_path_returns_leaf_without_writes", async () => {
    seed([tag("a", undefined, "编程"), tag("b", "a", "后端")]);
    expect(await store.getState().createTagPath("编程/后端", "red")).toEqual({ ok: true, tagId: "b" });
    expect(db.state.transactions).toBe(0); expect(enqueued).toEqual([]);
  });
  test("promotion_is_one_durable_change_and_keeps_ids_and_bookmark_tags", async () => {
    seed([tag("a"), tag("b", "a"), tag("c", "b")]);
    const bookmarkTags = ["b", "c"];
    bookmarks.set("bookmark", makeBookmark("bookmark", { tags: bookmarkTags }));
    let publications = 0;
    const unsubscribe = store.subscribe(() => { publications += 1; });
    expect(await store.getState().deleteTag("a")).toEqual({ ok: true }); unsubscribe();
    expect(store.getState().tags).toEqual([tag("b", undefined), tag("c", "b")].map(t => t.id === "b" ? { ...t, seq: 0 } : t));
    expect(bookmarks.get("bookmark")?.tags).toBe(bookmarkTags);
    expect(bookmarkTags).toEqual(["b", "c"]); expect(db.state.transactions).toBe(1);
    expect(publications).toBe(1); expect(enqueued).toHaveLength(1); expect(usage).toBe(-1);
    expect(db.read<Tag>("tags").find(t => t.id === "a")?.deletedAt).toBeNumber();
  });
  test("legacy_slash_color_edit_and_orphan_parent_are_normalized", async () => {
    seed([tag("a", "missing", "old/name")]);
    expect(await store.getState().updateTag("a", { color: "red" })).toEqual({ ok: true });
    expect(store.getState().tags).toEqual([{ id: "a", name: "old/name", parentId: undefined, color: "red", seq: 0 }]);
  });
  test("failed_write_publishes_nothing", async () => {
    seed([tag("a")]); db.state.fail = true;
    expect(await store.getState().updateTag("a", { color: "red" })).toEqual({ ok: false, error: "storage" });
    expect(store.getState().tags).toEqual([tag("a")]); expect(enqueued).toEqual([]);
  });
  test("cross_context_mismatch_refreshes_tags_and_next_retry_succeeds", async () => {
    seed([tag("a")]); db.seed([tag("a"), tag("b")]);
    expect(await store.getState().updateTag("a", { color: "red" })).toEqual({ ok: false, error: "stale" });
    expect(store.getState().tags).toEqual([tag("a"), tag("b")]);
    expect(await store.getState().updateTag("a", { color: "red" })).toEqual({ ok: true });
  });
  test("queued_mutations_validate_latest_sibling_names_and_targets", async () => {
    seed([tag("a"), tag("b")]);
    const first = store.getState().updateTag("a", { name: "same" });
    const second = store.getState().updateTag("b", { name: "same" });
    expect(await first).toEqual({ ok: true }); expect(await second).toEqual({ ok: false, error: "duplicate" });
    const deletion = store.getState().deleteTag("a");
    const move = store.getState().moveTag("b", "a");
    await deletion; expect(await move).toEqual({ ok: false, error: "invalid_parent" });
  });
  test("offline_delete_survives_hydrate", async () => {
    seed([tag("a")]); await store.getState().deleteTag("a"); await store.getState().hydrate();
    expect(store.getState().tags).toEqual([]); expect(db.read<Tag>("tags")[0]?.seq).toBe(0);
    expect(db.read<Tag>("tags")[0]?.deletedAt).toBeNumber();
    enqueued.length = 0;
    await store.getState().sweepUnsynced();
    expect(enqueued).toEqual([expect.objectContaining({ tags: [expect.objectContaining({ id: "a", deleted_at: expect.any(Number) })] })]);
    expect(usage).toBe(-1);
  });
  test("older_pull_does_not_resurrect", async () => {
    seed([tag("a")]); await store.getState().deleteTag("a");
    await store.getState().mergeFromServer(pull([{ id: "a", user_id: "u", name: "a", color: "blue", seq: 3, updated_at: 1 }]));
    expect(store.getState().tags).toEqual([]); expect(db.read<Tag>("tags")[0]?.deletedAt).toBeNumber();
  });
  test("reset_aborts_inflight_and_queued_tag_writes", async () => {
    seed([tag("a")]); db.state.beforeRead = () => { store.getState().reset(); db.seed([]); };
    const edit = store.getState().updateTag("a", { color: "red" });
    const queued = store.getState().createTagPath("b", "blue");
    expect(await edit).toEqual({ ok: false, error: "stale" }); expect(await queued).toEqual({ ok: false, error: "stale" });
    expect(store.getState().tags).toEqual([]); expect(db.read("tags")).toEqual([]); expect(enqueued).toEqual([]);
  });
  const pushed = (record: Tag): SyncEntity => ({ id: record.id, name: record.name, color: record.color, parent_id: record.parentId ?? "", deleted_at: record.deletedAt ?? null });
  test("missing_authoritative_parent_preserves_child_and_clears_only_edge", async () => {
    const child = { ...tag("child", "rejected-parent"), seq: 0 };
    seed([child]);
    await store.getState().restoreRejectedTagParent(child.id, pushed(child), undefined);
    expect(store.getState().tags).toEqual([{ ...child, parentId: undefined }]);
    expect(db.read("tags")).toEqual([{ ...child, parentId: undefined }]);
  });
  test("rejection_parent_restore_keeps_newer_color_but_not_newer_parent", async () => {
    const child = { ...tag("child", "bad"), seq: 0 };
    seed([{ ...child, color: "red" }]);
    await store.getState().restoreRejectedTagParent(child.id, pushed(child), tag("child", "good"));
    expect(store.getState().tags).toEqual([{ ...child, parentId: "good", color: "red" }]);
    await store.getState().restoreRejectedTagParent(child.id, pushed(child), tag("child", "old"));
    expect(store.getState().tags[0]?.parentId).toBe("good");
  });
  test("absence_settlement_is_snapshot_and_session_guarded", async () => {
    const deleted = { ...tag("a"), seq: 0, deletedAt: 5 };
    db.seed([deleted]);
    await store.getState().settleRejectedTagDeletion("a", pushed(deleted), () => false);
    expect(db.read("tags")).toEqual([deleted]);
    db.seed([{ ...deleted, name: "newer" }]);
    await store.getState().settleRejectedTagDeletion("a", pushed(deleted));
    expect(db.read<Tag>("tags")[0]?.name).toBe("newer");
    db.seed([deleted]);
    await store.getState().settleRejectedTagDeletion("a", pushed(deleted));
    expect(db.read("tags")).toEqual([]);
  });
  test("authoritative_tombstone_deletes_only_unchanged_rejected_tag", async () => {
    const child = { ...tag("child", "bad"), seq: 0 };
    seed([child]);
    await store.getState().restoreRejectedTagParent(child.id, pushed(child), { ...tag("child"), deletedAt: 10 });
    expect(store.getState().tags).toEqual([]); expect(db.read("tags")).toEqual([]);
    seed([{ ...child, color: "newer" }]);
    await store.getState().restoreRejectedTagParent(child.id, pushed(child), { ...tag("child"), deletedAt: 10 });
    expect(store.getState().tags[0]?.color).toBe("newer");
  });
  test("late_ack_keeps_newer_parent", async () => {
    const child = { ...tag("child", "new"), seq: 0 };
    seed([child]);
    store.getState().confirmWorkspaceStoreEntitySeqs({ workspaces: [], collections: [], tags: [pushed({ ...child, parentId: "old" })] }, 9);
    expect(store.getState().tags[0]?.seq).toBe(0);
  });
  test("create_delete_race_settles_only_on_matching_tombstone_ack", async () => {
    const confirmation = await import("@/lib/sync-confirmation");
    const created = { ...tag("a"), seq: 0 };
    seed([created]); await store.getState().deleteTag("a");
    const payload = (entity: SyncEntity) => ({ entities: { workspaces: [], collections: [], tags: [entity], bookmarks: [], groups: [] } });
    // An acknowledgement of the in-flight create must not erase a later deletion.
    await confirmation.confirmSyncPayload(payload(pushed(created)), 8);
    const tombstone = db.read<Tag>("tags")[0];
    expect(tombstone?.deletedAt).toBeNumber(); expect(tombstone?.seq).toBe(0);
    if (!tombstone) { throw new Error("pending deletion missing"); }
    await confirmation.confirmSyncPayload(payload(pushed(tombstone)), 9);
    expect(db.read("tags")).toEqual([]); expect(store.getState().tags).toEqual([]);
  });

  test("moving_to_root_sends_explicit_empty_parent", async () => {
    seed([tag("a"), tag("b", "a")]);
    expect(await store.getState().moveTag("b", undefined)).toEqual({ ok: true });
    expect(enqueued).toEqual([{ tags: [expect.objectContaining({ id: "b", parent_id: "" })] }]);
  });

  test("quota_is_rechecked_when_transaction_reads_the_current_graph", async () => {
    db.state.beforeRead = () => { limit = 0; };
    expect(await store.getState().createTagPath("new", "blue")).toEqual({ ok: false, error: "quota" });
    expect(db.read("tags")).toEqual([]); expect(enqueued).toEqual([]); expect(alerts).toBe(1);
  });

  test("old_server_omission_preserves_parent_and_explicit_root_clears_it", async () => {
    seed([tag("a"), tag("b", "a")]);
    const server = { id: "b", user_id: "u", name: "b", color: "red", seq: 7, updated_at: 1 };
    await store.getState().mergeFromServer(pull([server]));
    expect(store.getState().tags.find(t => t.id === "b")?.parentId).toBe("a");
    await store.getState().mergeFromServer(pull([{ ...server, parent_id: "" }]));
    expect(store.getState().tags.find(t => t.id === "b")?.parentId).toBeUndefined();
    expect(db.read<Tag>("tags").find(t => t.id === "b")?.parentId).toBeUndefined();
  });

  test("stale_snapshot_refresh_failure_returns_storage_and_preserves_state", async () => {
    seed([tag("a")]); db.seed([tag("a"), tag("external")]); db.state.failReads = true;
    expect(await store.getState().updateTag("a", { color: "red" })).toEqual({ ok: false, error: "storage" });
    expect(store.getState().tags).toEqual([tag("a")]);
    expect(db.read("tags")).toEqual([tag("a"), tag("external")]); expect(enqueued).toEqual([]);
  });

}
