import { beforeEach, describe, expect, mock, test } from "bun:test";

const kv = new Map();
let failNextBulkWrite = false;
let delayNextBulkWrite = false;
let resolveBulkWriteStarted = null;
let releaseBulkWrite = null;

function applyOperations(operations) {
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
}

mock.module("@/lib/idb", () => ({
  idbGet: async (store, key) => (store === "kv" ? kv.get(key) : undefined),
  idbBulkWrite: async (operations) => {
    if (delayNextBulkWrite) {
      delayNextBulkWrite = false;
      resolveBulkWriteStarted?.();
      await new Promise((resolve) => {
        releaseBulkWrite = resolve;
      });
    }
    if (failNextBulkWrite) {
      failNextBulkWrite = false;
      throw new Error("indexeddb write failed");
    }
    applyOperations(operations);
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
    failNextBulkWrite = false;
    delayNextBulkWrite = false;
    resolveBulkWriteStarted = null;
    releaseBulkWrite = null;
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

  test("does not apply an in-flight record after reset", async () => {
    const registry = new SyncConflictRegistry();
    await registry.ready();
    delayNextBulkWrite = true;
    const writeStarted = new Promise((resolve) => {
      resolveBulkWriteStarted = resolve;
    });

    const recording = registry.recordRejections([
      { id: "old-account", type: "workspace", reason: "quota_exceeded" },
    ]);
    await writeStarted;
    registry.reset();
    releaseBulkWrite?.();
    await recording;

    expect(registry.list()).toEqual([]);
  });

  test("does not apply an externally prepared mutation after reset", async () => {
    const registry = new SyncConflictRegistry();
    await registry.ready();
    await registry.recordRejections([
      { id: "old-account", type: "workspace", reason: "quota_exceeded" },
      { id: "old-tag", type: "tag", reason: "quota_exceeded" },
    ]);
    const mutation = registry.prepareClearRootMutation("tag", "old-tag");

    registry.reset();
    registry.applyMutation(mutation);

    expect(registry.list()).toEqual([]);
  });

  test("keeps memory unchanged when recording a payload cannot persist", async () => {
    const registry = new SyncConflictRegistry();
    await registry.ready();
    failNextBulkWrite = true;

    await expect(registry.recordPayload({
      entities: {
        workspaces: [{ id: "failed-workspace" }],
        collections: [],
        bookmarks: [],
        tags: [],
        groups: [],
      },
    }, 422)).rejects.toThrow("indexeddb write failed");

    expect(registry.list()).toEqual([]);
    expect(kv.get("sync-conflicts-v1")).toBeUndefined();
  });

  test("keeps memory unchanged when recording rejections cannot persist", async () => {
    const registry = new SyncConflictRegistry();
    await registry.ready();
    failNextBulkWrite = true;

    await expect(registry.recordRejections([
      { id: "failed-workspace", type: "workspace", reason: "quota_exceeded" },
    ])).rejects.toThrow("indexeddb write failed");

    expect(registry.list()).toEqual([]);
    expect(kv.get("sync-conflicts-v1")).toBeUndefined();
  });

  test("records every payload entity type with its parent provenance", async () => {
    const registry = new SyncConflictRegistry();
    await registry.ready();

    await registry.recordPayload({
      entities: {
        workspaces: [{ id: "workspace-1" }],
        collections: [{ id: "collection-1", workspace_id: "workspace-1" }],
        bookmarks: [{ id: "bookmark-1", collection_id: "collection-1" }],
        tags: [{ id: "tag-1" }],
        groups: [{ id: "group-1", workspace_id: "workspace-1" }],
      },
    }, 422);

    expect(registry.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "workspace", entityId: "workspace-1", reason: "http_422" }),
      expect.objectContaining({
        entityType: "collection", entityId: "collection-1", parentType: "workspace", parentId: "workspace-1",
      }),
      expect.objectContaining({
        entityType: "bookmark", entityId: "bookmark-1", parentType: "collection", parentId: "collection-1",
      }),
      expect.objectContaining({ entityType: "tag", entityId: "tag-1" }),
      expect.objectContaining({
        entityType: "saved_group", entityId: "group-1", parentType: "workspace", parentId: "workspace-1",
      }),
    ]));
  });

  test("ignores stale and structurally invalid rejection records", async () => {
    const registry = new SyncConflictRegistry();
    await registry.ready();

    await registry.recordRejections([
      { id: "stale-workspace", type: "workspace", reason: "stale" },
      { id: "unknown", type: "not-an-entity", reason: "quota_exceeded" },
      { id: "", type: "workspace", reason: "quota_exceeded" },
      {
        id: "child", type: "collection", reason: "parent_rejected",
        parent_id: "workspace-1", parent_type: "workspace",
      },
    ]);

    expect(registry.list()).toEqual([
      expect.objectContaining({
        entityType: "collection", entityId: "child", parentType: "workspace", parentId: "workspace-1",
      }),
    ]);
  });

  test("clears only exact references and defers root mutation changes until apply", async () => {
    const registry = new SyncConflictRegistry();
    await registry.ready();
    await registry.recordRejections([
      { id: "workspace-1", type: "workspace", reason: "quota_exceeded" },
      { id: "tag-1", type: "tag", reason: "quota_exceeded" },
    ]);

    await registry.clearEntity("tag", "tag-1");
    expect(registry.list()).toEqual([
      expect.objectContaining({ entityType: "workspace", entityId: "workspace-1" }),
    ]);

    const mutation = registry.prepareClearRootMutation("workspace", "workspace-1");
    expect(registry.list()).toEqual([
      expect.objectContaining({ entityType: "workspace", entityId: "workspace-1" }),
    ]);
    expect(mutation.operation).toEqual({
      type: "put",
      store: "kv",
      value: { key: "sync-conflicts-v1", value: { version: 1, entries: [] } },
    });

    registry.applyMutation(mutation);
    expect(registry.list()).toEqual([]);
  });

  test("does not let an old prepared mutation overwrite a later committed record", async () => {
    const registry = new SyncConflictRegistry();
    await registry.ready();
    await registry.recordRejections([
      { id: "workspace-1", type: "workspace", reason: "quota_exceeded" },
    ]);
    const mutation = registry.prepareClearRootMutation("workspace", "workspace-1");

    await registry.recordPayload({
      entities: {
        workspaces: [],
        collections: [],
        bookmarks: [],
        tags: [{ id: "new-tag" }],
        groups: [],
      },
    }, 500);
    registry.applyMutation(mutation);

    expect(registry.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "workspace", entityId: "workspace-1" }),
      expect.objectContaining({ entityType: "tag", entityId: "new-tag" }),
    ]));
  });
});
