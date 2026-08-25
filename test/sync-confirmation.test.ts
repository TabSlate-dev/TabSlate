// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import type { SyncEntity, SyncPushPayload } from "../lib/api";
import {
  confirmSyncPayload,
  matchesPersistedSyncEntity,
} from "../lib/sync-confirmation";

const cases: Array<{
  name: string;
  store: "workspaces" | "collections" | "tags" | "bookmarks" | "archived-bookmarks" | "trashed-bookmarks" | "groups";
  persisted: Record<string, unknown>;
  pushed: SyncEntity;
  tabs?: Record<string, unknown>[];
}> = [
  {
    name: "Workspace",
    store: "workspaces",
    persisted: { id: "w", name: "One", color: "blue", position: 1, seq: 0 },
    pushed: { id: "w", name: "One", color: "blue", position: 1, seq: 0, updated_at: 99, deleted_at: null },
  },
  {
    name: "Collection",
    store: "collections",
    persisted: { id: "c", workspaceId: "w", name: "Inbox", icon: "folder", position: 2, seq: 0 },
    pushed: { id: "c", workspace_id: "w", name: "Inbox", icon: "folder", position: 2, seq: 0, updated_at: 99, deleted_at: null, archived_at: null },
  },
  {
    name: "Tag",
    store: "tags",
    persisted: { id: "t", name: "Read", color: "green", seq: 0 },
    pushed: { id: "t", name: "Read", color: "green", seq: 0, updated_at: 99, deleted_at: null },
  },
  ...(["bookmarks", "archived-bookmarks", "trashed-bookmarks"] as const).map((store) => ({
    name: store,
    store,
    persisted: { id: store, collectionId: "c", title: "Page", url: "https://example.test", favicon: "icon", description: "d", isFavorite: true, tags: ["t"], createdAt: "2026-01-01", seq: 0 },
    pushed: { id: store, collection_id: "c", title: "Page", url: "https://example.test", favicon_url: "icon", description: "d", is_favorite: true, is_archived: store === "archived-bookmarks", is_trashed: store === "trashed-bookmarks" ? 1 : 0, tag_ids: ["t"], position: 0, seq: 0, updated_at: 99, deleted_at: null },
  })),
  {
    name: "Saved Group including tabs",
    store: "groups",
    persisted: { id: "g", name: "Work", color: "blue", isCompact: false, workspaceId: "w", createdAt: "2026-01-01T00:00:00.000Z", seq: 0 },
    pushed: { id: "g", name: "Work", color: "blue", is_compact: false, workspace_id: "w", created_at: 1767225600000, deleted_at: null, tabs: [{ id: "gt", group_id: "g", title: "Tab", url: "https://example.test", favicon: "icon", position: 0 }] },
    tabs: [{ id: "gt", groupId: "g", title: "Tab", url: "https://example.test", favicon: "icon", position: 0 }],
  },
];

describe("sync confirmation", () => {
  for (const confirmationCase of cases) {
    test(`matches canonical ${confirmationCase.name} fields while ignoring seq and updated_at`, () => {
      const { store, persisted, pushed, tabs } = confirmationCase;
      expect(matchesPersistedSyncEntity(store, persisted, pushed, tabs ?? [], [])).toBe(true);
      expect(matchesPersistedSyncEntity(store, persisted, { ...pushed, seq: 456, updated_at: 123 }, tabs ?? [], [])).toBe(true);
    });
  }

  test("a concurrent rename, move, or group-tab edit remains unsynced", () => {
    const workspace = cases[0];
    const collection = cases[1];
    const group = cases.at(-1);
    if (!workspace || !collection || !group) {
      throw new Error("confirmation fixtures are missing");
    }
    expect(matchesPersistedSyncEntity(workspace.store, { ...workspace.persisted, name: "Renamed" }, workspace.pushed, [], [])).toBe(false);
    expect(matchesPersistedSyncEntity(collection.store, { ...collection.persisted, workspaceId: "other" }, collection.pushed, [], [])).toBe(false);
    expect(matchesPersistedSyncEntity(group.store, group.persisted, group.pushed, [{ ...group.tabs?.[0], title: "Edited" }], [])).toBe(false);
  });

  test("updates loaded state only after the confirmation transaction commits", async () => {
    let commitResolved = false;
    const events: string[] = [];
    const releaseCommit = (() => {
      let resolve = () => {};
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    })();
    const payload: SyncPushPayload = {
      entities: { workspaces: [{ id: "w", name: "One" }], collections: [], bookmarks: [], tags: [], groups: [] },
    };
    const confirming = confirmSyncPayload(payload, 17, {
      async commit() {
        events.push("transaction-start");
        await releaseCommit.promise;
        commitResolved = true;
        events.push("transaction-commit");
        return payload;
      },
      apply(confirmed, serverSeq) {
        expect(commitResolved).toBe(true);
        expect(confirmed).toEqual(payload);
        expect(serverSeq).toBe(17);
        events.push("zustand");
      },
    });

    await Promise.resolve();
    expect(events).toEqual(["transaction-start"]);
    releaseCommit.resolve();
    await confirming;
    expect(events).toEqual(["transaction-start", "transaction-commit", "zustand"]);
  });
});
