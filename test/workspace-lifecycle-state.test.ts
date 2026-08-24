// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, describe, expect, test } from "bun:test";
import type { SyncPushPayload } from "@/lib/api";
import type {
  WorkspaceLifecycleStateStorage,
  WorkspaceLifecycleStoredRecord,
} from "@/lib/workspace-lifecycle-state";

const records = new Map<string, WorkspaceLifecycleStoredRecord>();
const storage: WorkspaceLifecycleStateStorage = {
  async read(key) {
    return records.get(key);
  },
  async write(key, value) {
    records.set(key, structuredClone(value));
  },
  async remove(key) {
    records.delete(key);
  },
};

const {
  invalidateWorkspaceFullPull,
  invalidateWorkspaceLifecycleCapability,
  invalidateWorkspaceLifecycleDeferredSync,
  invalidateWorkspaceLifecycleIntents,
  mergeWorkspaceFullPull,
  mergeWorkspaceLifecycleCapability,
  mergeWorkspaceLifecycleDeferredPayload,
  mergeWorkspaceLifecycleIntent,
  readWorkspaceFullPull,
  readWorkspaceLifecycleCapability,
  readWorkspaceLifecycleDeferredSync,
  readWorkspaceLifecycleIntents,
  removeWorkspaceLifecycleDeferredPayload,
  removeWorkspaceLifecycleIntent,
} = await import(`../lib/workspace-lifecycle-state.ts?test=${Date.now()}-${Math.random()}`);

function payload(bookmarkId: string): SyncPushPayload {
  return {
    entities: {
      workspaces: [],
      collections: [],
      bookmarks: [{ id: bookmarkId }],
      tags: [],
      groups: [],
    },
  };
}

describe("workspace lifecycle state persistence", () => {
  beforeEach(async () => {
    records.clear();
    await invalidateWorkspaceLifecycleIntents(storage);
    await invalidateWorkspaceLifecycleDeferredSync(storage);
  });

  test("scopes a confirmed capability to the normalized server origin and user", async () => {
    await mergeWorkspaceLifecycleCapability(
      "https://server-a.example.test/api/",
      "user-a",
      true,
      1000,
      storage,
    );

    expect(await readWorkspaceLifecycleCapability(
      "https://server-a.example.test/another/path",
      "user-a",
      storage,
    )).toEqual({
      version: 1,
      userId: "user-a",
      serverOrigin: "https://server-a.example.test",
      supported: true,
      observedAt: 1000,
    });
    expect(await readWorkspaceLifecycleCapability(
      "https://server-a.example.test",
      "user-b",
      storage,
    )).toBeUndefined();
    expect(await readWorkspaceLifecycleCapability(
      "https://server-b.example.test",
      "user-a",
      storage,
    )).toBeUndefined();
  });

  test("an omitted or false later capability invalidates the scoped confirmation", async () => {
    await mergeWorkspaceLifecycleCapability("https://server.example.test", "user-a", true, 1000, storage);
    await mergeWorkspaceLifecycleCapability("https://server.example.test", "user-a", undefined, 2000, storage);
    expect(await readWorkspaceLifecycleCapability(
      "https://server.example.test",
      "user-a",
      storage,
    )).toBeUndefined();

    await mergeWorkspaceLifecycleCapability("https://server.example.test", "user-a", true, 3000, storage);
    await mergeWorkspaceLifecycleCapability("https://server.example.test", "user-a", false, 4000, storage);
    expect(await readWorkspaceLifecycleCapability(
      "https://server.example.test",
      "user-a",
      storage,
    )).toBeUndefined();

    await invalidateWorkspaceLifecycleCapability("https://server.example.test", "user-a", storage);
  });

  test("round-trips and removes a delete intent with all five fields", async () => {
    const intent = {
      workspaceId: "workspace-a",
      action: "delete" as const,
      baseSeq: 42,
      previousActiveWorkspaceId: "workspace-b",
      createdAt: 123456,
    };

    await mergeWorkspaceLifecycleIntent(intent, storage);
    expect(await readWorkspaceLifecycleIntents(storage)).toEqual([intent]);

    await removeWorkspaceLifecycleIntent("workspace-a", storage);
    expect(await readWorkspaceLifecycleIntents(storage)).toEqual([]);
  });

  test("merges and removes deferred payloads without changing another Workspace", async () => {
    await mergeWorkspaceLifecycleDeferredPayload("workspace-a", payload("bookmark-a-old"), storage);
    await mergeWorkspaceLifecycleDeferredPayload("workspace-b", payload("bookmark-b"), storage);
    await mergeWorkspaceLifecycleDeferredPayload("workspace-a", payload("bookmark-a-new"), storage);

    expect(await readWorkspaceLifecycleDeferredSync(storage)).toEqual({
      version: 1,
      payloadsByWorkspaceId: {
        "workspace-a": {
          entities: {
            workspaces: [],
            collections: [],
            bookmarks: [{ id: "bookmark-a-old" }, { id: "bookmark-a-new" }],
            tags: [],
            groups: [],
          },
        },
        "workspace-b": payload("bookmark-b"),
      },
    });

    await removeWorkspaceLifecycleDeferredPayload("workspace-a", storage);
    expect(await readWorkspaceLifecycleDeferredSync(storage)).toEqual({
      version: 1,
      payloadsByWorkspaceId: { "workspace-b": payload("bookmark-b") },
    });
  });

  test("scopes and invalidates full-pull completion records", async () => {
    await mergeWorkspaceFullPull(
      "https://server-a.example.test/path",
      "user-a",
      88,
      9000,
      storage,
    );

    expect(await readWorkspaceFullPull("https://server-a.example.test", "user-a", storage)).toEqual({
      version: 1,
      userId: "user-a",
      serverOrigin: "https://server-a.example.test",
      serverSeq: 88,
      completedAt: 9000,
    });
    expect(await readWorkspaceFullPull("https://server-a.example.test", "user-b", storage)).toBeUndefined();
    expect(await readWorkspaceFullPull("https://server-b.example.test", "user-a", storage)).toBeUndefined();

    await invalidateWorkspaceFullPull("https://server-a.example.test", "user-a", storage);
    expect(await readWorkspaceFullPull("https://server-a.example.test", "user-a", storage)).toBeUndefined();
  });
});
