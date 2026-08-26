// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, describe, expect, test } from "bun:test";
import type { SyncPushPayload } from "@/lib/api";
import type {
  WorkspaceLifecycleDeferredSyncRecord,
  WorkspaceLifecycleIntent,
  WorkspaceLifecycleIntentRecord,
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
  async update(key, mutate) {
    const next = mutate(records.get(key));
    if (next) {
      records.set(key, structuredClone(next));
      return;
    }
    records.delete(key);
  },
};

interface BarrierStorageResult {
  storage: WorkspaceLifecycleStateStorage;
  snapshot(key: string): WorkspaceLifecycleStoredRecord | undefined;
}

function createBarrierStorage(
  initialRecords: ReadonlyMap<string, WorkspaceLifecycleStoredRecord> = new Map(),
): BarrierStorageResult {
  const concurrentRecords = new Map(initialRecords);
  let readCount = 0;
  let releaseReads: (() => void) | undefined;
  const readsReady = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  let updateQueue = Promise.resolve();
  const concurrentStorage = {
    async read(key: string) {
      readCount += 1;
      if (readCount === 2) {
        releaseReads?.();
      }
      await readsReady;
      return concurrentRecords.get(key);
    },
    async write(key: string, value: WorkspaceLifecycleStoredRecord) {
      concurrentRecords.set(key, structuredClone(value));
    },
    async remove(key: string) {
      concurrentRecords.delete(key);
    },
    update(
      key: string,
      mutate: (
        current: WorkspaceLifecycleStoredRecord | undefined,
      ) => WorkspaceLifecycleStoredRecord | undefined,
    ): Promise<void> {
      const operation = updateQueue.then(() => {
        const next = mutate(concurrentRecords.get(key));
        if (next) {
          concurrentRecords.set(key, structuredClone(next));
          return;
        }
        concurrentRecords.delete(key);
      });
      updateQueue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
  return {
    storage: concurrentStorage,
    snapshot: (key) => concurrentRecords.get(key),
  };
}

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

  test("never throws on a malformed serverUrl and keeps distinct malformed inputs scoped separately", async () => {
    // A scheme-less self-hosted server (or any URL that fails to parse) must
    // not throw — that would propagate out of deleteWorkspace/restoreWorkspace
    // — and two different malformed inputs must not collide on the same
    // scoped record, which `new URL(x).origin === "null"` for every invalid
    // input would otherwise cause.
    await expect(mergeWorkspaceLifecycleCapability(
      "myserver.example.test:8080", "user-a", true, 1000, storage,
    )).resolves.toBeUndefined();
    await expect(mergeWorkspaceLifecycleCapability(
      "othercorp.example.test:9090", "user-a", true, 2000, storage,
    )).resolves.toBeUndefined();

    const first = await readWorkspaceLifecycleCapability("myserver.example.test:8080", "user-a", storage);
    const second = await readWorkspaceLifecycleCapability("othercorp.example.test:9090", "user-a", storage);
    expect(first?.supported).toBe(true);
    expect(second?.supported).toBe(true);
    expect(first?.serverOrigin).not.toBe(second?.serverOrigin);

    // A different malformed input must not read back the first server's
    // confirmation.
    expect(await readWorkspaceLifecycleCapability(
      "yet-another.example.test", "user-a", storage,
    )).toBeUndefined();

    for (const malformed of ["", "not a url", "://missing-scheme"]) {
      // Must resolve, not reject/throw — a naturally-failing await is enough
      // to fail this test if the fix regresses.
      await readWorkspaceLifecycleCapability(malformed, "user-a", storage);
    }
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

  test("concurrent intent merges preserve both Workspaces", async () => {
    const concurrent = createBarrierStorage();
    const first: WorkspaceLifecycleIntent = {
      workspaceId: "workspace-a",
      action: "delete",
      baseSeq: 10,
      previousActiveWorkspaceId: "workspace-b",
      createdAt: 100,
    };
    const second: WorkspaceLifecycleIntent = {
      workspaceId: "workspace-b",
      action: "restore",
      baseSeq: 20,
      previousActiveWorkspaceId: "workspace-a",
      createdAt: 200,
    };

    await Promise.all([
      mergeWorkspaceLifecycleIntent(first, concurrent.storage),
      mergeWorkspaceLifecycleIntent(second, concurrent.storage),
    ]);

    expect(concurrent.snapshot("workspace-lifecycle-intents-v1")).toEqual({
      version: 1,
      intents: [first, second],
    });
  });

  test("concurrent intent removals do not restore another removed Workspace", async () => {
    const remaining: WorkspaceLifecycleIntent = {
      workspaceId: "workspace-c",
      action: "delete",
      baseSeq: 30,
      previousActiveWorkspaceId: "workspace-c",
      createdAt: 300,
    };
    const initial: WorkspaceLifecycleIntentRecord = {
      version: 1,
      intents: [
        {
          workspaceId: "workspace-a",
          action: "delete",
          baseSeq: 10,
          previousActiveWorkspaceId: "workspace-c",
          createdAt: 100,
        },
        {
          workspaceId: "workspace-b",
          action: "restore",
          baseSeq: 20,
          previousActiveWorkspaceId: "workspace-c",
          createdAt: 200,
        },
        remaining,
      ],
    };
    const concurrent = createBarrierStorage(new Map([
      ["workspace-lifecycle-intents-v1", initial],
    ]));

    await Promise.all([
      removeWorkspaceLifecycleIntent("workspace-a", concurrent.storage),
      removeWorkspaceLifecycleIntent("workspace-b", concurrent.storage),
    ]);

    expect(concurrent.snapshot("workspace-lifecycle-intents-v1")).toEqual({
      version: 1,
      intents: [remaining],
    });
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

  test("keeps the newest deferred snapshot for a repeated entity ID", async () => {
    const older = payload("bookmark-repeated");
    older.entities.bookmarks[0].title = "older";
    const newer = payload("bookmark-repeated");
    newer.entities.bookmarks[0].title = "newer";

    await mergeWorkspaceLifecycleDeferredPayload("workspace-a", older, storage);
    await mergeWorkspaceLifecycleDeferredPayload("workspace-b", payload("bookmark-b"), storage);
    await mergeWorkspaceLifecycleDeferredPayload("workspace-a", newer, storage);

    expect(await readWorkspaceLifecycleDeferredSync(storage)).toEqual({
      version: 1,
      payloadsByWorkspaceId: {
        "workspace-a": newer,
        "workspace-b": payload("bookmark-b"),
      },
    });
  });

  test("concurrent deferred merges preserve both Workspace payloads", async () => {
    const concurrent = createBarrierStorage();

    await Promise.all([
      mergeWorkspaceLifecycleDeferredPayload(
        "workspace-a",
        payload("bookmark-a"),
        concurrent.storage,
      ),
      mergeWorkspaceLifecycleDeferredPayload(
        "workspace-b",
        payload("bookmark-b"),
        concurrent.storage,
      ),
    ]);

    expect(concurrent.snapshot("workspace-lifecycle-deferred-sync-v1")).toEqual({
      version: 1,
      payloadsByWorkspaceId: {
        "workspace-a": payload("bookmark-a"),
        "workspace-b": payload("bookmark-b"),
      },
    });
  });

  test("concurrent deferred removals preserve only the unrelated Workspace payload", async () => {
    const retainedPayload = payload("bookmark-c");
    const initial: WorkspaceLifecycleDeferredSyncRecord = {
      version: 1,
      payloadsByWorkspaceId: {
        "workspace-a": payload("bookmark-a"),
        "workspace-b": payload("bookmark-b"),
        "workspace-c": retainedPayload,
      },
    };
    const concurrent = createBarrierStorage(new Map([
      ["workspace-lifecycle-deferred-sync-v1", initial],
    ]));

    await Promise.all([
      removeWorkspaceLifecycleDeferredPayload("workspace-a", concurrent.storage),
      removeWorkspaceLifecycleDeferredPayload("workspace-b", concurrent.storage),
    ]);

    expect(concurrent.snapshot("workspace-lifecycle-deferred-sync-v1")).toEqual({
      version: 1,
      payloadsByWorkspaceId: {
        "workspace-c": retainedPayload,
      },
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
