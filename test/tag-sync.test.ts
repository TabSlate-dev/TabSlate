// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, expect, mock, test } from "bun:test";
import { runsInIsolatedProcess } from "./helpers/isolated-run";
import { installTagIdb } from "./helpers/tag-idb";
import type { SyncPullResponse, ServerTag, SyncPushPayload, SyncPushResponse, SyncPushEntities } from "@/lib/api";
import type { Bookmark, Tag } from "@/lib/types";

if (runsInIsolatedProcess(import.meta.filename)) {
  const db = installTagIdb();
  const enqueued: Partial<SyncPushEntities>[] = [];
  const bookmarks = new Map<string, Bookmark>();
  mock.module("@/lib/sync-engine", () => ({ syncEngine: { enqueue: (payload: Partial<SyncPushEntities>) => enqueued.push(payload) } }));
  mock.module("@/store/plan-store", () => ({
    usePlanStore: { getState: () => ({
      ensureFresh: () => {}, checkQuota: () => true,
      showQuotaAlert: () => {}, incrementUsage: () => {}, decrementUsage: () => {},
    }) }, guardQuota: () => { throw new Error("unexpected old quota gate"); },
  }));
  mock.module("@/store/auth-store", () => ({ useAuthStore: { getState: () => ({ user: null, serverUrl: "" }) } }));
  mock.module("@/store/bookmarks-store", () => ({
    useBookmarksStore: { getState: () => ({ bookmarks, confirmBookmarkEntitySeqs: () => {} }) },
    toServerBookmark: (b: unknown) => b,
  }));
  mock.module("@/store/groups-store", () => ({ useGroupsStore: { getState: () => ({ confirmGroupEntitySeqs: () => {} }) } }));
  mock.module("@/lib/analytics", () => ({ analytics: { track: () => {} } }));
  const { useWorkspaceStore: store } = await import("@/store/workspace-store");
  const tag = (id: string, parentId?: string, name = id): Tag => ({ id, parentId, name, color: "blue", seq: 2 });
  const seed = (tags: Tag[]) => { db.seed(tags); store.setState({ tags }); };
  const pull = (tags: ServerTag[]): SyncPullResponse => ({ entities: { workspaces: [], collections: [], bookmarks: [], groups: [], tags }, server_seq: 10 });

  beforeEach(() => {
    store.getState().reset(); db.tables.clear(); db.state.transactions = 0; db.state.fail = false; db.state.failReads = false; db.state.beforeRead = undefined;
    enqueued.length = 0; bookmarks.clear();
  });

  const recovery = await import("@/lib/tag-sync-recovery");
  const attempted = (record: Tag): SyncPushPayload => ({ entities: { workspaces: [], collections: [], bookmarks: [], groups: [], tags: [{ id: record.id, name: record.name, color: record.color, parent_id: record.parentId ?? "", deleted_at: record.deletedAt ?? null }] } });
  const rejection = (reason = "invalid_field", field = "parent_id"): SyncPushResponse => ({ server_seq: 10, rejected: [{ id: "moving", type: "tag", reason, field }] });
  const serverTag = (parent_id?: string | null): ServerTag => ({ id: "moving", name: "moving", color: "blue", parent_id, user_id: "u", seq: 8, updated_at: 1 });

  test("omission_preserves_local_parent", async () => {
    seed([tag("moving", "p")]); await store.getState().mergeFromServer(pull([serverTag()]));
    expect(store.getState().tags[0]?.parentId).toBe("p");
  });
  test("empty_parent_clears_it", async () => {
    seed([tag("moving", "p")]); await store.getState().mergeFromServer(pull([serverTag("")]));
    expect(store.getState().tags[0]?.parentId).toBeUndefined();
  });
  test("late_ack_cannot_confirm_new_move", async () => {
    const current = { ...tag("moving", "new-parent"), seq: 0 }; seed([current]);
    const { confirmSyncPayload } = await import("@/lib/sync-confirmation");
    await confirmSyncPayload(attempted({ ...current, parentId: "old-parent" }), 12);
    expect(store.getState().tags.find(tag => tag.id === "moving")?.parentId).toBe("new-parent");
    expect(store.getState().tags.find(tag => tag.id === "moving")?.seq).toBe(0);
    expect(db.read<Tag>("tags")[0]?.seq).toBe(0);
  });
  test("rejected_move_restores_only_attempt", async () => {
    const sent = { ...tag("moving", "bad"), seq: 0 };
    seed([{ ...sent, name: "new name", color: "red" }]);
    await recovery.reconcileRejectedTagParents(rejection(), attempted(sent), pull([serverTag("old-parent")]), () => true);
    expect(store.getState().tags).toEqual([{ ...sent, name: "new name", color: "red", parentId: "old-parent" }]);
    expect(db.read<Tag>("tags")).toEqual(store.getState().tags);
    expect(enqueued).toEqual([{ tags: [expect.objectContaining({ id: "moving", name: "new name", color: "red", parent_id: "old-parent" })] }]);
    seed([{ ...sent, parentId: "new-parent" }]);
    await recovery.reconcileRejectedTagParents(rejection(), attempted(sent), pull([serverTag("old-parent")]), () => true);
    expect(store.getState().tags[0]?.parentId).toBe("new-parent");
  });
  test("parent_recovery_requires_parent_field_and_current_session", async () => {
    const sent = { ...tag("moving", "bad"), seq: 0 }; seed([sent]);
    await recovery.reconcileRejectedTagParents(rejection("invalid_field", "name"), attempted(sent), pull([serverTag("old")]), () => true);
    await recovery.reconcileRejectedTagParents(rejection(), attempted(sent), pull([serverTag("old")]), () => false);
    expect(db.read("tags")).toEqual([sent]); expect(enqueued).toEqual([]);
  });
  test("invalid_state_settles_only_authoritative_absence_or_tombstone", async () => {
    const sent = { ...tag("moving"), seq: 0, deletedAt: 5 };
    db.seed([sent]); store.setState({ tags: [] });
    await recovery.reconcileRejectedTagParents(rejection("invalid_state"), attempted(sent), pull([serverTag("")]), () => true);
    expect(db.read("tags")).toEqual([sent]);
    await recovery.reconcileRejectedTagParents(rejection("invalid_state"), attempted(sent), pull([]), () => true);
    expect(db.read("tags")).toEqual([]);
    db.seed([sent]);
    await recovery.reconcileRejectedTagParents(rejection("invalid_state"), attempted(sent), pull([{ ...serverTag(""), deleted_at: 7 }]), () => true);
    expect(db.read("tags")).toEqual([]);
  });
  test("deletion_settlement_requires_a_still_dirty_record", async () => {
    const sent = { ...tag("moving"), seq: 0, deletedAt: 5 };
    db.seed([{ ...sent, seq: 20 }]); store.setState({ tags: [] });
    await recovery.reconcileRejectedTagParents(rejection("invalid_state"), attempted(sent), pull([]), () => true);
    expect(db.read("tags")).toEqual([{ ...sent, seq: 20 }]);
  });
  test("only_parent_field_rejections_are_exempt_from_persistent_conflicts", async () => {
    const { SyncConflictRegistry } = await import("@/lib/sync-conflicts");
    const conflicts = new SyncConflictRegistry();
    await conflicts.ready();
    await conflicts.recordRejections([
      { id: "moving", type: "tag", reason: "invalid_field", field: "parent_id" },
      { id: "bad-name", type: "tag", reason: "invalid_field", field: "name" },
      { id: "other", type: "collection", reason: "invalid_field", field: "parent_id" },
    ]);
    expect(conflicts.list().map(item => item.entityId).sort()).toEqual(["bad-name", "other"]);
  });
  for (const boundary of ["entities", "bytes"]) {
    test(`merge_restarts_between_chunks_${boundary}`, async () => {
      const { buildTagTree } = await import("@/lib/tag-tree");
      const { planTagMerge } = await import("@/lib/tag-mutations");
      const { commitTagMutation } = await import("@/lib/tag-persistence");
      const { splitSyncPushPayload } = await import("@/lib/sync-recovery");
      const { confirmSyncPayload } = await import("@/lib/sync-confirmation");
      const original = [tag("z-source"), tag("target")];
      for (let i = 0; i < 451; i += 1) {
        original.push(tag(`source-${i}`, "z-source", `branch-${i}`), tag(`target-${i}`, "target", `branch-${i}`), tag(`leaf-${i}`, `source-${i}`, `leaf-${i}`));
      }
      if (boundary === "bytes") { for (const record of original) { record.color = "x".repeat(2_000); } }
      seed(original);
      const planned = planTagMerge(buildTagTree(original, "en"), "z-source", "target", 50);
      if (!planned.ok) { throw new Error(planned.error); }
      await commitTagMutation(planned.plan, original);
      await store.getState().hydrate();
      await store.getState().sweepUnsynced();
      const pending: SyncPushPayload = { entities: { workspaces: [], collections: [], bookmarks: [], groups: [], tags: enqueued.flatMap(payload => payload.tags ?? []) } };
      const server = new Map(original.map(record => [record.id, record]));
      const authoritative = () => [...server.values()].filter(record => record.deletedAt === undefined).map(record => ({ id: record.id, name: record.name, parent_id: record.parentId ?? "" }));
      const chunks = splitSyncPushPayload(pending, authoritative());
      expect(chunks.length).toBeGreaterThan(1);
      const applyChunk = async (chunk: SyncPushPayload) => {
        for (const record of chunk.entities.tags) {
          if (typeof record.name !== "string" || typeof record.color !== "string" || typeof record.parent_id !== "string") { throw new Error("incomplete tag write"); }
          server.set(record.id, { id: record.id, name: record.name, color: record.color, parentId: record.parent_id || undefined, deletedAt: typeof record.deleted_at === "number" ? record.deleted_at : undefined, seq: 10 });
        }
        await confirmSyncPayload(chunk, 10);
      };
      const first = chunks[0];
      if (!first) { throw new Error("missing first chunk"); }
      await applyChunk(first);
      const stillDirty = db.read<Tag>("tags").filter(record => record.seq === 0).map(record => record.id).sort();
      const expectedRemaining = chunks.slice(1).flatMap(chunk => chunk.entities.tags.map(record => record.id)).sort();
      expect(stillDirty).toEqual(expectedRemaining);
      // A restart drops memory and raw chunks; hydration/sweep reconstruct the pending records.
      store.getState().reset(); enqueued.length = 0;
      await store.getState().hydrate(); await store.getState().sweepUnsynced();
      const replay: SyncPushPayload = { entities: { workspaces: [], collections: [], bookmarks: [], groups: [], tags: enqueued.flatMap(payload => payload.tags ?? []) } };
      expect(replay.entities.tags.map(record => record.id).sort()).toEqual(expectedRemaining);
      for (const chunk of splitSyncPushPayload(replay, authoritative())) { await applyChunk(chunk); }
      expect(db.read<Tag>("tags").some(record => record.seq === 0 || record.deletedAt !== undefined)).toBe(false);
      expect(store.getState().tags).toHaveLength(903);
      expect(store.getState().tags.some(record => record.id === "z-source" || record.id.startsWith("source-"))).toBe(false);
      for (let i = 0; i < 451; i += 1) {
        expect(server.get(`leaf-${i}`)?.parentId).toBe(`target-${i}`);
        expect(store.getState().tags.find(record => record.id === `leaf-${i}`)?.parentId).toBe(`target-${i}`);
      }
    });
  }

  test("missing_server_tag_keeps_id_and_retries_as_root", async () => {
    const sent = { ...tag("moving", "bad"), seq: 0 }; seed([sent]);
    await recovery.reconcileRejectedTagParents(rejection(), attempted(sent), pull([]), () => true);
    expect(db.read("tags")).toEqual([{ ...sent, parentId: undefined }]);
  });
}
