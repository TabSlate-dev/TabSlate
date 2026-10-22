import { beforeEach, describe, expect, test } from "bun:test";

const sessionStore = new Map();
const sessionSetCalls = [];
const sessionRemoveCalls = [];
const pendingStorageOps = [];
let deferStorageOps = false;

function createSessionArea() {
  return {
    async get(keys) {
      if (typeof keys === "string") {
        return { [keys]: sessionStore.get(keys) };
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, sessionStore.get(key)]));
      }
      if (keys && typeof keys === "object") {
        return Object.fromEntries(
          Object.entries(keys).map(([key, defaultValue]) => [key, sessionStore.get(key) ?? defaultValue]),
        );
      }
      return Object.fromEntries(sessionStore.entries());
    },
    async set(items) {
      sessionSetCalls.push(items);
      if (deferStorageOps) {
        await new Promise((resolve) => {
          pendingStorageOps.push(() => {
            for (const [key, value] of Object.entries(items)) {
              sessionStore.set(key, value);
            }
            resolve();
          });
        });
        return;
      }
      for (const [key, value] of Object.entries(items)) {
        sessionStore.set(key, value);
      }
    },
    async remove(keys) {
      sessionRemoveCalls.push(keys);
      const keyList = Array.isArray(keys) ? keys : [keys];
      if (deferStorageOps) {
        await new Promise((resolve) => {
          pendingStorageOps.push(() => {
            for (const key of keyList) {
              sessionStore.delete(key);
            }
            resolve();
          });
        });
        return;
      }
      for (const key of keyList) {
        sessionStore.delete(key);
      }
    },
  };
}

Reflect.set(globalThis, "chrome", {
  storage: {
    session: createSessionArea(),
  },
});

const recoveryModule = await import("../lib/sync-recovery.ts?real-sync-recovery");

async function waitForStorageWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("sync recovery persistence", () => {
  beforeEach(async () => {
    sessionStore.clear();
    sessionSetCalls.length = 0;
    sessionRemoveCalls.length = 0;
    pendingStorageOps.length = 0;
    deferStorageOps = false;
    await Promise.resolve(recoveryModule.clearSyncRecoverySnapshot());
    await waitForStorageWork();
    sessionSetCalls.length = 0;
    sessionRemoveCalls.length = 0;
  });

  test("bufferSyncRecoverySnapshot persists the snapshot to session storage", async () => {
    const snapshot = {
      entities: {
        workspaces: [],
        collections: [],
        bookmarks: [{ id: "bookmark-1", seq: 0 }],
        tags: [],
        groups: [],
      },
    };

    await Promise.resolve(recoveryModule.bufferSyncRecoverySnapshot(snapshot));
    await waitForStorageWork();

    expect(sessionSetCalls.length).toBeGreaterThan(0);
    expect(
      sessionSetCalls.some((call) =>
        Object.values(call).some((value) => typeof value === "string" && value === JSON.stringify(snapshot)),
      ),
    ).toBe(true);
  });

  test("can load a persisted recovery snapshot from session storage", async () => {
    const snapshot = {
      entities: {
        workspaces: [{ id: "workspace-1" }],
        collections: [],
        bookmarks: [{ id: "bookmark-1", seq: 0 }],
        tags: [],
        groups: [],
      },
    };

    sessionStore.set("tabslate-sync-recovery", JSON.stringify(snapshot));

    const loaded = await recoveryModule.loadSyncRecoverySnapshot();

    expect(loaded).toEqual(snapshot);
    expect(sessionStore.size).toBe(0);
  });

  test("extracts matching entities from every recovery payload map and persists the remainder", async () => {
    const snapshot = {
      entities: {
        workspaces: [{ id: "workspace-captured" }, { id: "workspace-kept" }],
        collections: [{ id: "collection-captured" }, { id: "collection-kept" }],
        bookmarks: [{ id: "bookmark-captured" }, { id: "bookmark-kept" }],
        tags: [{ id: "tag-captured" }, { id: "tag-kept" }],
        groups: [{ id: "group-captured" }, { id: "group-kept" }],
      },
    };
    recoveryModule.bufferSyncRecoverySnapshot(snapshot);
    await waitForStorageWork();

    const extracted = await recoveryModule.extractSyncRecoveryEntities([
      { entityType: "workspace", entityId: "workspace-captured" },
      { entityType: "collection", entityId: "collection-captured" },
      { entityType: "bookmark", entityId: "bookmark-captured" },
      { entityType: "tag", entityId: "tag-captured" },
      { entityType: "saved_group", entityId: "group-captured" },
    ]);

    expect(extracted).toEqual({
      entities: {
        workspaces: [{ id: "workspace-captured" }],
        collections: [{ id: "collection-captured" }],
        bookmarks: [{ id: "bookmark-captured" }],
        tags: [{ id: "tag-captured" }],
        groups: [{ id: "group-captured" }],
      },
    });
    expect(await recoveryModule.loadSyncRecoverySnapshot()).toEqual({
      entities: {
        workspaces: [{ id: "workspace-kept" }],
        collections: [{ id: "collection-kept" }],
        bookmarks: [{ id: "bookmark-kept" }],
        tags: [{ id: "tag-kept" }],
        groups: [{ id: "group-kept" }],
      },
    });
  });

  test("extracts a snapshot loaded after restart and clears an empty session record", async () => {
    const snapshot = {
      entities: {
        workspaces: [],
        collections: [{ id: "restart-collection" }],
        bookmarks: [{ id: "restart-bookmark" }],
        tags: [],
        groups: [],
      },
    };
    sessionStore.set("tabslate-sync-recovery", JSON.stringify(snapshot));

    expect(await recoveryModule.extractSyncRecoveryEntities([
      { entityType: "collection", entityId: "restart-collection" },
      { entityType: "bookmark", entityId: "restart-bookmark" },
    ])).toEqual(snapshot);
    expect(sessionStore.has("tabslate-sync-recovery")).toBe(false);
  });

  test("conditionally prunes only the recovery snapshot captured before a newer same-ID buffer", async () => {
    const references = [{ entityType: "bookmark", entityId: "bookmark-captured" }];
    recoveryModule.bufferSyncRecoverySnapshot({
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "captured" }],
        tags: [], groups: [],
      },
    });
    await waitForStorageWork();
    const captured = await recoveryModule.copySyncRecoveryEntities(references);

    recoveryModule.bufferSyncRecoverySnapshot({
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "newer" }],
        tags: [], groups: [],
      },
    });
    await recoveryModule.pruneSyncRecoveryEntities(references, captured);

    expect(await recoveryModule.loadSyncRecoverySnapshot()).toEqual({
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "newer" }],
        tags: [], groups: [],
      },
    });
  });

  test("clearSyncRecoverySnapshot clears session storage", async () => {
    const snapshot = {
      entities: {
        workspaces: [],
        collections: [],
        bookmarks: [{ id: "bookmark-2", seq: 0 }],
        tags: [],
        groups: [],
      },
    };

    await Promise.resolve(recoveryModule.bufferSyncRecoverySnapshot(snapshot));
    await waitForStorageWork();
    await Promise.resolve(recoveryModule.clearSyncRecoverySnapshot());
    await waitForStorageWork();

    expect(sessionRemoveCalls.length).toBeGreaterThan(0);
    expect(sessionStore.size).toBe(0);
  });

  test("serializes storage persistence so older writes cannot land after clear", async () => {
    deferStorageOps = true;

    recoveryModule.bufferSyncRecoverySnapshot({
      entities: {
        workspaces: [],
        collections: [],
        bookmarks: [{ id: "bookmark-stale", seq: 0 }],
        tags: [],
        groups: [],
      },
    });
    recoveryModule.clearSyncRecoverySnapshot();
    await waitForStorageWork();

    expect(sessionSetCalls).toHaveLength(1);
    expect(sessionRemoveCalls).toHaveLength(0);
    expect(pendingStorageOps).toHaveLength(1);

    const resolveSet = pendingStorageOps.shift();
    if (!resolveSet) {
      throw new Error("missing queued set op");
    }
    resolveSet();
    await waitForStorageWork();

    expect(sessionRemoveCalls).toHaveLength(1);
    expect(pendingStorageOps).toHaveLength(1);

    const resolveRemove = pendingStorageOps.shift();
    if (!resolveRemove) {
      throw new Error("missing queued remove op");
    }
    resolveRemove();
    await waitForStorageWork();

    expect(sessionStore.size).toBe(0);
  });
});

describe("tag dependency chunking", () => {
  function tagPayload(tags) {
    return { entities: { workspaces: [], collections: [], bookmarks: [], groups: [], tags } };
  }
  test("parent_precedes_child_across_900_boundary", () => {
    const tags = [
      { id: "z-child", parent_id: "z-parent" },
      ...Array.from({ length: 899 }, (_, i) => ({ id: `m-${String(i).padStart(4, "0")}`, parent_id: "" })),
      { id: "z-parent", parent_id: "" },
    ];
    const chunks = recoveryModule.splitSyncPushPayload(tagPayload(tags));
    const ids = chunks.flatMap(chunk => chunk.entities.tags.map(tag => tag.id));
    expect(chunks).toHaveLength(2);
    expect(ids.indexOf("z-parent")).toBeLessThan(ids.indexOf("z-child"));
    expect(chunks[0].entities.tags).toHaveLength(900);
    expect(chunks[0].entities.tags.at(-1).id).toBe("z-parent");
    expect(chunks[1].entities.tags[0].id).toBe("z-child");
  });
  test("parent_precedes_child_across_byte_boundary", () => {
    const chunks = recoveryModule.splitSyncPushPayload(tagPayload([
      { id: "z-child", parent_id: "z-parent", name: "c".repeat(220_000) },
      { id: "z-parent", parent_id: "", name: "p".repeat(220_000) },
    ]));
    expect(chunks.map(chunk => chunk.entities.tags.map(tag => tag.id))).toEqual([["z-parent"], ["z-child"]]);
  });
  test("orders_small_tag_payloads_and_uses_deterministic_sibling_ties", () => {
    const chunks = recoveryModule.splitSyncPushPayload(tagPayload([
      { id: "b", parent_id: "p" }, { id: "a", parent_id: "p" }, { id: "p", parent_id: "" },
    ]));
    expect(chunks[0].entities.tags.map(tag => tag.id)).toEqual(["p", "a", "b"]);
  });
});

describe("authoritative tag batch packing", () => {
  for (const destination of ["", "y", "with-invalid-neighbor"]) {
    test(`detaches_descendant_before_ancestor_deepening_${destination || "root"}`, () => {
      const stored = [
        { id: "a", name: "a", parent_id: "" }, { id: "b", name: "b", parent_id: "a" },
        { id: "c", name: "c", parent_id: "b" }, { id: "d", name: "d", parent_id: "c" },
        { id: "z", name: "z", parent_id: "d" }, { id: "x", name: "x", parent_id: "" }, { id: "y", name: "y", parent_id: "" },
        ...Array.from({ length: 899 }, (_, i) => ({ id: `m${i}`, name: `m${i}`, parent_id: "" })),
      ];
      const payload = recoveryModule.createEmptySyncPushPayload();
      payload.entities.tags = [{ id: "a", name: "a", parent_id: "x" }, ...stored.slice(7), { id: "z", name: "z", parent_id: destination === "with-invalid-neighbor" ? "" : destination }];
      if (destination === "with-invalid-neighbor") { payload.entities.tags.push({ id: "invalid", name: "invalid", parent_id: "missing" }); }
      const chunks = recoveryModule.splitSyncPushPayload(payload, stored);
      const graph = new Map(stored.map(tag => [tag.id, tag]));
      for (const chunk of chunks) {
        for (const tag of chunk.entities.tags) { graph.set(tag.id, tag); }
        let depth = 0;
        let current = graph.get("z");
        while (current) { depth += 1; current = graph.get(current.parent_id); }
        expect(depth).toBeLessThanOrEqual(5);
      }
      expect(graph.get("a").parent_id).toBe("x");
      expect(graph.get("z").parent_id).toBe(destination === "with-invalid-neighbor" ? "" : destination);
    });
  }
  test("keeps_coupled_sibling_renames_in_one_chunk", () => {
    const stored = [{ id: "a", name: "Alpha", parent_id: "" }, { id: "z", name: "Beta", parent_id: "" }];
    const payload = recoveryModule.createEmptySyncPushPayload();
    payload.entities.tags = [{ id: "a", name: "Beta", parent_id: "" },
      ...Array.from({ length: 899 }, (_, i) => ({ id: `m${i}`, name: `m${i}`, parent_id: "" })),
      { id: "z", name: "Alpha", parent_id: "" }];
    const chunks = recoveryModule.splitSyncPushPayload(payload, stored);
    expect(chunks.findIndex(chunk => chunk.entities.tags.some(tag => tag.id === "a"))).toBe(
      chunks.findIndex(chunk => chunk.entities.tags.some(tag => tag.id === "z")),
    );
  });
  test("inseparable_over_budget_changes_remain_a_recoverable_ordering_failure", () => {
    const stored = [{ id: "a", name: "Alpha", parent_id: "" }, { id: "z", name: "Beta", parent_id: "" }];
    const payload = recoveryModule.createEmptySyncPushPayload();
    payload.entities.tags = [{ id: "a", name: "Beta", parent_id: "", color: "x".repeat(220_000) },
      { id: "z", name: "Alpha", parent_id: "", color: "x".repeat(220_000) }];
    expect(() => recoveryModule.splitSyncPushPayload(payload, stored)).toThrow(recoveryModule.SyncTagOrderingError);
  });
});

describe("tag planner replay limits", () => {
  for (const destination of ["", "y"]) {
    test(`byte_limit_sends_detach_before_deepening_${destination || "root"}`, () => {
      const stored = [
        { id: "a", name: "a", parent_id: "" }, { id: "b", name: "b", parent_id: "a" },
        { id: "c", name: "c", parent_id: "b" }, { id: "d", name: "d", parent_id: "c" },
        { id: "z", name: "z", parent_id: "d" }, { id: "x", name: "x", parent_id: "" }, { id: "y", name: "y", parent_id: "" },
      ];
      const payload = recoveryModule.createEmptySyncPushPayload();
      payload.entities.tags = [{ id: "a", name: "a", parent_id: "x", color: "x".repeat(220_000) },
        { id: "z", name: "z", parent_id: destination, color: "x".repeat(220_000) }];
      expect(recoveryModule.splitSyncPushPayload(payload, stored).map(chunk => chunk.entities.tags.map(tag => tag.id))).toEqual([["z"], ["a"]]);
    });
  }
  for (const boundary of ["entities", "bytes"]) {
    test(`promotion_plan_converges_across_${boundary}_boundary`, async () => {
      const { buildTagTree } = await import("../lib/tag-tree");
      const { planTagDeletion } = await import("../lib/tag-mutations");
      const stored = [
        { id: "z-parent", name: "parent", seq: 1, color: "blue" },
        { id: "existing", name: "leaf-0", seq: 1, color: "blue" },
        ...Array.from({ length: 900 }, (_, i) => ({ id: `child-${i}`, name: `leaf-${i}`, parentId: "z-parent", color: boundary === "bytes" ? "x".repeat(2_000) : "blue", seq: 1 })),
      ];
      const result = planTagDeletion(buildTagTree(stored, "en"), ["z-parent"], 5);
      expect(result.ok).toBe(true);
      const payload = recoveryModule.createEmptySyncPushPayload();
      payload.entities.tags = [...result.plan.upserts, ...result.plan.tombstones].map(tag => ({ id: tag.id, name: tag.name, color: tag.color, parent_id: tag.parentId ?? "", deleted_at: tag.deletedAt ?? null }));
      const graph = new Map(stored.map(tag => [tag.id, { id: tag.id, name: tag.name, parent_id: tag.parentId ?? "" }]));
      const chunks = recoveryModule.splitSyncPushPayload(payload, [...graph.values()]);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].entities.tags[0].id).toBe("z-parent");
      for (const chunk of chunks) {
        for (const tag of chunk.entities.tags) { graph.set(tag.id, tag); }
        const names = new Set();
        for (const tag of graph.values()) {
          if (tag.deleted_at != null) { continue; }
          const key = `${tag.parent_id}:${tag.name.toLowerCase()}`;
          expect(names.has(key)).toBe(false); names.add(key);
        }
      }
      expect(graph.get("z-parent").deleted_at).toBe(5);
      expect(graph.get("child-0").name).toBe("leaf-0 (2)");
      expect([...graph.values()].filter(tag => tag.deleted_at == null).every(tag => tag.parent_id === "")).toBe(true);
    });
  }
});
