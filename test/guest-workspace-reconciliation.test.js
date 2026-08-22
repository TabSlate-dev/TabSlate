import { beforeEach, describe, expect, mock, test } from "bun:test";

const stores = new Map();
let transactionOperations = [];

mock.module("@/lib/idb", () => ({
  idbGet: async (store, key) => stores.get(`${store}:${key}`),
  idbGetAll: async (store) => stores.get(`${store}:all`) ?? [],
  idbPut: async (store, value) => stores.set(`${store}:${value.key}`, value),
  idbDelete: async (store, key) => stores.delete(`${store}:${key}`),
  idbBulkWrite: async (operations) => { transactionOperations = operations; },
  idbGetByIndex: async () => [],
  idbGetMany: async () => [],
  idbCount: async () => 0,
  idbTransaction: async () => {},
  clearDB: async () => {},
  getDB: async () => ({}),
}));

const {
  prepareGuestWorkspaceForPull,
  resolveGuestPushRejections,
} = await import("../lib/guest-workspace-reconciliation");
const { createGuestWorkspaceSeed } = await import("../lib/guest-workspace");
const { syncConflictRegistry } = await import("../lib/sync-conflicts");
const { useWorkspaceStore } = await import("../store/workspace-store");

describe("guest workspace reconciliation", () => {
  beforeEach(async () => {
    stores.clear();
    transactionOperations = [];
    await syncConflictRegistry.clearAllForManualRetry();
    useWorkspaceStore.setState({ workspaces: [], collections: [], activeWorkspaceId: "" });
  });

  test("retains the local guest workspace until a coordinator is available", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    stores.set("kv:guest-workspace-provenance-v1", seed.provenance);
    stores.set("workspaces:all", [seed.workspace]);
    stores.set("collections:all", [seed.collection]);
    const result = await prepareGuestWorkspaceForPull({
      entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] },
      server_seq: 0,
    });
    expect(result).toMatchObject({ kind: "retained" });
  });

  test("discards an untouched seed when the pull contains another confirmed workspace", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    stores.set("kv:guest-workspace-provenance-v1", seed.provenance);
    stores.set("workspaces:all", [seed.workspace]);
    stores.set("collections:all", [seed.collection]);

    const result = await prepareGuestWorkspaceForPull({
      entities: {
        workspaces: [{
          id: "account-workspace", user_id: "user", name: "Account", position: 0, seq: 3,
          created_at: 1, updated_at: 1,
        }],
        collections: [], bookmarks: [], tags: [], groups: [],
      },
      server_seq: 3,
    });
    expect(result).toMatchObject({ kind: "discarded" });
    expect(new Set(transactionOperations.map((operation) => operation.store))).toEqual(
      new Set(["workspaces", "collections", "kv"]),
    );
    expect(transactionOperations.some((operation) => operation.store === "tags")).toBe(false);
  });

  test("migrates every bookmark lifecycle bucket and groups without rewriting group tabs", async () => {
    const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
    const active = {
      id: "active", title: "Active", url: "https://active.example", description: "", favicon: "",
      collectionId: seed.collection.id, tags: [], createdAt: "1", isFavorite: false, seq: 0,
    };
    const archived = { ...active, id: "archived" };
    const trashed = { ...active, id: "trashed", deletedAt: 1 };
    const group = {
      id: "group", name: "Group", color: "blue", isCompact: false, createdAt: "1", seq: 0,
      workspaceId: seed.workspace.id,
    };
    stores.set("kv:guest-workspace-provenance-v1", seed.provenance);
    stores.set("workspaces:all", [seed.workspace]);
    stores.set("collections:all", [seed.collection]);
    stores.set("bookmarks:all", [active]);
    stores.set("archived-bookmarks:all", [archived]);
    stores.set("trashed-bookmarks:all", [trashed]);
    stores.set("groups:all", [group]);
    stores.set("group-tabs:all", [{ id: "tab", groupId: group.id, title: "Tab", url: "https://tab.example", favicon: "", position: 0 }]);
    useWorkspaceStore.setState({
      workspaces: [{ id: "account", name: "Account", color: "blue", position: 1, seq: 4 }],
      collections: [{
        id: "account-default", workspaceId: "account", name: "Default", icon: "inbox", position: 0,
        isDefault: true, seq: 4,
      }],
      activeWorkspaceId: "account",
    });

    const result = await resolveGuestPushRejections({
      server_seq: 4,
      rejected: [{ id: seed.workspace.id, type: "workspace", reason: "quota_exceeded" }],
    });
    expect(result).toMatchObject({ kind: "migrated", needsResweep: true, targetWorkspaceName: "Account" });

    expect(new Set(transactionOperations.map((operation) => operation.store))).toEqual(new Set([
      "workspaces", "collections", "bookmarks", "archived-bookmarks", "trashed-bookmarks", "groups", "kv",
    ]));
    expect(transactionOperations.some((operation) => operation.store === "group-tabs")).toBe(false);
  });
});
