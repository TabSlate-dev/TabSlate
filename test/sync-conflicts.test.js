import { beforeEach, describe, expect, mock, test } from "bun:test";

const kv = new Map();

mock.module("@/lib/idb", () => ({
  idbGet: async (store, key) => (store === "kv" ? kv.get(key) : undefined),
  idbBulkWrite: async (operations) => {
    for (const operation of operations) {
      if (operation.store !== "kv") {
        continue;
      }
      if (operation.type === "delete") {
        kv.delete(operation.key);
      } else {
        kv.set(operation.value.key, operation.value);
      }
    }
  },
  idbDelete: async (store, key) => {
    if (store === "kv") {
      kv.delete(key);
    }
  },
  idbPut: async (store, value) => {
    if (store === "kv") {
      kv.set(value.key, value);
    }
  },
}));

const { SyncConflictRegistry } = await import("../lib/sync-conflicts");

describe("sync conflict registry", () => {
  beforeEach(() => {
    kv.clear();
  });

  test("persists and clears a blocked rejection tree", async () => {
    const registry = new SyncConflictRegistry();
    await registry.ready();

    await registry.recordRejections([
      { id: "guest-ws", type: "workspace", reason: "quota_exceeded" },
      {
        id: "guest-col", type: "collection", reason: "parent_rejected",
        parent_id: "guest-ws", parent_type: "workspace",
      },
      {
        id: "guest-bookmark", type: "bookmark", reason: "parent_rejected",
        parent_id: "guest-col", parent_type: "collection",
      },
    ]);

    expect(registry.isBlocked("workspace", "guest-ws")).toBe(true);
    expect(registry.isBlocked("collection", "guest-col")).toBe(true);
    expect(registry.isBlocked("bookmark", "guest-bookmark")).toBe(true);
    expect(registry.filterPayload({
      entities: {
        workspaces: [{ id: "guest-ws" }],
        collections: [{ id: "guest-col" }],
        bookmarks: [{ id: "guest-bookmark" }],
        tags: [{ id: "tag-1" }],
        groups: [],
      },
    }).entities).toEqual({
      workspaces: [],
      collections: [],
      bookmarks: [],
      tags: [{ id: "tag-1" }],
      groups: [],
    });

    const rehydrated = new SyncConflictRegistry();
    await rehydrated.ready();
    expect(rehydrated.list()).toEqual([
      expect.objectContaining({ entityType: "workspace", entityId: "guest-ws" }),
      expect.objectContaining({ entityType: "collection", entityId: "guest-col" }),
      expect.objectContaining({ entityType: "bookmark", entityId: "guest-bookmark" }),
    ]);

    await registry.clearRoot("workspace", "guest-ws");
    expect(registry.list()).toEqual([]);
    expect(registry.isBlocked("collection", "guest-col")).toBe(false);
    expect(registry.isBlocked("bookmark", "guest-bookmark")).toBe(false);
  });

  test("does not restore hydrated conflicts after reset", async () => {
    kv.set("sync-conflicts-v1", {
      key: "sync-conflicts-v1",
      value: {
        version: 1,
        entries: [{
          entityType: "workspace",
          entityId: "stale-workspace",
          reason: "quota_exceeded",
          createdAt: 1,
        }],
      },
    });
    const registry = new SyncConflictRegistry();

    registry.reset();
    await registry.ready();

    expect(registry.list()).toEqual([]);
  });
});
