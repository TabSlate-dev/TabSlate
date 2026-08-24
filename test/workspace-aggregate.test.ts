// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkspaceAggregateIds } from "../lib/workspace-aggregate";
import { spawnSync } from "node:child_process";

interface FakeRecord {
  id?: string;
  key?: string;
  workspaceId?: string;
  collectionId?: string;
  groupId?: string;
  position?: number;
  deletedAt?: number;
  value?: unknown;
  [property: string]: unknown;
}

type RequestOperation = "delete" | "get" | "getAll" | "put";

interface FailureSelector {
  store: string;
  operation: RequestOperation;
  key?: string;
}

class FakeRequest {
  result: unknown;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

function cloneRecord(record: FakeRecord): FakeRecord {
  return structuredClone(record);
}

function cloneStores(
  stores: ReadonlyMap<string, ReadonlyMap<string, FakeRecord>>,
): Map<string, Map<string, FakeRecord>> {
  return new Map([...stores.entries()].map(([name, records]) => [
    name,
    new Map([...records.entries()].map(([key, record]) => [key, cloneRecord(record)])),
  ]));
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  private readonly workingStores: Map<string, Map<string, FakeRecord>>;
  private pendingRequests = 0;
  private aborted = false;
  private completionQueued = false;

  constructor(
    private readonly database: FakeDatabase,
    readonly storeNames: string[],
    private readonly mode: "readonly" | "readwrite",
  ) {
    this.workingStores = cloneStores(database.stores);
  }

  objectStore(name: string): FakeObjectStore {
    const records = this.workingStores.get(name);
    if (!records || !this.storeNames.includes(name)) {
      throw new Error(`Store ${name} is not part of this transaction`);
    }
    return new FakeObjectStore(this, name, records);
  }

  schedule(
    store: string,
    operation: RequestOperation,
    key: string | undefined,
    run: () => unknown,
  ): FakeRequest {
    const request = new FakeRequest();
    this.pendingRequests += 1;
    queueMicrotask(() => {
      if (this.aborted) {
        return;
      }
      try {
        if (this.database.consumeFailure({ store, operation, key })) {
          throw new Error(`Injected ${store}.${operation} failure`);
        }
        request.result = run();
        request.onsuccess?.();
        this.pendingRequests -= 1;
        this.queueCompletion();
      } catch (error) {
        this.error = error instanceof Error ? error : new Error("IndexedDB request failed");
        request.error = this.error;
        request.onerror?.();
        this.abort();
      }
    });
    return request;
  }

  abort(): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    this.onerror?.();
    this.onabort?.();
  }

  private queueCompletion(): void {
    if (this.pendingRequests !== 0 || this.completionQueued || this.aborted) {
      return;
    }
    this.completionQueued = true;
    queueMicrotask(() => {
      this.completionQueued = false;
      if (this.pendingRequests !== 0 || this.aborted) {
        return;
      }
      if (this.mode === "readwrite") {
        this.database.replaceStores(this.workingStores, this.storeNames);
      }
      this.database.notifyTransactionCommitted(this.storeNames);
      this.oncomplete?.();
    });
  }
}

const INDEX_FIELDS: Record<string, Record<string, keyof FakeRecord>> = {
  bookmarks: { collectionId: "collectionId" },
  "archived-bookmarks": { collectionId: "collectionId" },
  "trashed-bookmarks": { collectionId: "collectionId" },
  collections: { workspaceId: "workspaceId", position: "position" },
  groups: { workspaceId: "workspaceId" },
  "group-tabs": { groupId: "groupId" },
  workspaces: { position: "position" },
};

class FakeIndex {
  constructor(
    private readonly transaction: FakeTransaction,
    private readonly storeName: string,
    private readonly records: ReadonlyMap<string, FakeRecord>,
    private readonly field: keyof FakeRecord,
  ) {}

  getAll(value: string): FakeRequest {
    return this.transaction.schedule(this.storeName, "getAll", value, () =>
      [...this.records.values()]
        .filter((record) => record[this.field] === value)
        .map(cloneRecord));
  }
}

class FakeObjectStore {
  constructor(
    private readonly transaction: FakeTransaction,
    private readonly name: string,
    private readonly records: Map<string, FakeRecord>,
  ) {}

  index(name: string): FakeIndex {
    const field = INDEX_FIELDS[this.name]?.[name];
    if (!field) {
      throw new Error(`Unknown index ${this.name}.${name}`);
    }
    return new FakeIndex(this.transaction, this.name, this.records, field);
  }

  get(key: string): FakeRequest {
    return this.transaction.schedule(this.name, "get", key, () => {
      const record = this.records.get(key);
      return record ? cloneRecord(record) : undefined;
    });
  }

  getAll(): FakeRequest {
    return this.transaction.schedule(this.name, "getAll", undefined, () =>
      [...this.records.values()].map(cloneRecord));
  }

  put(record: FakeRecord): FakeRequest {
    const key = typeof record.key === "string" ? record.key : record.id;
    return this.transaction.schedule(this.name, "put", key, () => {
      if (!key) {
        throw new Error(`Missing key for ${this.name}`);
      }
      this.records.set(key, cloneRecord(record));
      return key;
    });
  }

  delete(key: string): FakeRequest {
    return this.transaction.schedule(this.name, "delete", key, () => {
      this.records.delete(key);
      return undefined;
    });
  }

  count(): FakeRequest {
    return this.transaction.schedule(this.name, "getAll", undefined, () => this.records.size);
  }
}

const STORE_NAMES = [
  "bookmarks",
  "archived-bookmarks",
  "trashed-bookmarks",
  "workspaces",
  "collections",
  "tags",
  "groups",
  "group-tabs",
  "tab-group-titles",
  "kv",
];

class FakeDatabase {
  stores = new Map<string, Map<string, FakeRecord>>(
    STORE_NAMES.map((name) => [name, new Map()]),
  );
  onversionchange: (() => void) | null = null;
  private failure: FailureSelector | null = null;
  private commitObserver: ((storeNames: string[]) => void) | null = null;

  transaction(
    stores: string | string[],
    mode: "readonly" | "readwrite" = "readonly",
  ): FakeTransaction {
    return new FakeTransaction(this, typeof stores === "string" ? [stores] : stores, mode);
  }

  close(): void {}

  failNextRequest(failure: FailureSelector): void {
    this.failure = failure;
  }

  consumeFailure(request: FailureSelector): boolean {
    if (!this.failure || this.failure.store !== request.store ||
      this.failure.operation !== request.operation ||
      (this.failure.key !== undefined && this.failure.key !== request.key)) {
      return false;
    }
    this.failure = null;
    return true;
  }

  observeNextAggregateCommit(observer: () => void): void {
    this.commitObserver = (storeNames) => {
      if (storeNames.includes("workspaces") && storeNames.includes("group-tabs") &&
        storeNames.includes("kv")) {
        this.commitObserver = null;
        observer();
      }
    };
  }

  notifyTransactionCommitted(storeNames: string[]): void {
    this.commitObserver?.(storeNames);
  }

  replaceStores(
    nextStores: ReadonlyMap<string, ReadonlyMap<string, FakeRecord>>,
    names: string[],
  ): void {
    for (const name of names) {
      const records = nextStores.get(name);
      if (records) {
        this.stores.set(name, new Map([...records.entries()].map(([key, record]) => [
          key,
          cloneRecord(record),
        ])));
      }
    }
  }

  clear(): void {
    this.stores = new Map(STORE_NAMES.map((name) => [name, new Map()]));
    this.failure = null;
    this.commitObserver = null;
  }
}

class FakeOpenRequest {
  result: FakeDatabase;
  error: Error | null = null;
  transaction: null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: ((event: { target: FakeOpenRequest; oldVersion: number }) => void) | null = null;

  constructor(database: FakeDatabase) {
    this.result = database;
  }
}

class FakeDeleteRequest {
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

class FakeIndexedDBFactory {
  readonly database = new FakeDatabase();

  open(): FakeOpenRequest {
    const request = new FakeOpenRequest(this.database);
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }

  deleteDatabase(): FakeDeleteRequest {
    const request = new FakeDeleteRequest();
    queueMicrotask(() => {
      this.database.clear();
      request.onsuccess?.();
    });
    return request;
  }
}

const fakeIndexedDB = new FakeIndexedDBFactory();
Object.defineProperty(globalThis, "indexedDB", {
  configurable: true,
  value: fakeIndexedDB,
});
const canonicalIdb = await import("../lib/idb.ts");
const canonicalIdbModule: unknown = canonicalIdb;
let idbMockedByAnotherTest = true;
if (typeof canonicalIdbModule === "object" && canonicalIdbModule !== null &&
  "getDB" in canonicalIdbModule && typeof canonicalIdbModule.getDB === "function") {
  const canonicalDatabase: unknown = await canonicalIdbModule.getDB();
  idbMockedByAnotherTest = typeof canonicalDatabase !== "object" ||
    canonicalDatabase === null || !("transaction" in canonicalDatabase) ||
    typeof canonicalDatabase.transaction !== "function";
}

if (idbMockedByAnotherTest && process.env.TABSLATE_AGGREGATE_ISOLATED !== "1") {
  test("runs Workspace aggregate persistence tests isolated from process-global module mocks", () => {
    const result = spawnSync(
      "bun",
      ["test", "test/workspace-aggregate.test.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          TABSLATE_AGGREGATE_ISOLATED: "1",
        },
      },
    );
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.status).toBe(0);
  });
} else {
  const idb = await import(`../lib/idb.ts?workspace-aggregate=${Date.now()}`);
  const aggregate = await import(`../lib/workspace-aggregate.ts?test=${Date.now()}`);
  const conflicts = await import("../lib/sync-conflicts.ts");

  const { clearDB, idbGet, idbPut } = idb;
  const {
    clearWorkspaceAggregate,
    loadWorkspaceAggregateIds,
    permanentlyDeleteWorkspaceAggregate,
    toSyncEntityReferences,
  } = aggregate;
  const { syncConflictRegistry } = conflicts;

function emptyPayload(workspaceId: string) {
  return {
    entities: {
      workspaces: [{ id: workspaceId }],
      collections: [],
      bookmarks: [],
      tags: [],
      groups: [],
    },
  };
}

async function seedAggregate(): Promise<void> {
  const records: Array<[Parameters<typeof idbPut>[0], FakeRecord]> = [
    ["workspaces", {
      id: "workspace-target", name: "Target", color: "blue", position: 10,
      seq: 4, deletedAt: 100,
    }],
    ["workspaces", {
      id: "workspace-nearest", name: "Nearest", color: "red", position: 12, seq: 5,
    }],
    ["workspaces", {
      id: "workspace-unrelated", name: "Unrelated", color: "green", position: 30, seq: 6,
    }],
    ["workspaces", {
      id: "workspace-deleted", name: "Deleted", color: "gray", position: 11,
      seq: 7, deletedAt: 90,
    }],
    ["collections", {
      id: "collection-a", workspaceId: "workspace-target", name: "A", icon: "a",
      position: 1, seq: 0,
    }],
    ["collections", {
      id: "collection-b", workspaceId: "workspace-target", name: "B", icon: "b",
      position: 2, seq: 0, archivedAt: 20,
    }],
    ["collections", {
      id: "collection-unrelated", workspaceId: "workspace-unrelated", name: "Other",
      icon: "o", position: 1, seq: 1,
    }],
    ["bookmarks", {
      id: "bookmark-active", collectionId: "collection-a", title: "Active",
    }],
    ["archived-bookmarks", {
      id: "bookmark-archived", collectionId: "collection-b", title: "Archived",
    }],
    ["trashed-bookmarks", {
      id: "bookmark-trashed", collectionId: "collection-a", title: "Trashed",
    }],
    ["bookmarks", {
      id: "bookmark-unrelated", collectionId: "collection-unrelated", title: "Other",
    }],
    ["groups", {
      id: "group-target", workspaceId: "workspace-target", name: "Target group",
    }],
    ["groups", {
      id: "group-unrelated", workspaceId: "workspace-unrelated", name: "Other group",
    }],
    ["group-tabs", {
      id: "group-tab-a", groupId: "group-target", title: "A",
    }],
    ["group-tabs", {
      id: "group-tab-b", groupId: "group-target", title: "B",
    }],
    ["group-tabs", {
      id: "group-tab-unrelated", groupId: "group-unrelated", title: "Other",
    }],
  ];
  for (const [store, record] of records) {
    await idbPut(store, record);
  }
}

async function seedMetadata(): Promise<void> {
  const records: FakeRecord[] = [
    { key: "activeWorkspaceId", value: "workspace-target" },
    {
      key: "workspace-lifecycle-intents-v1",
      value: {
        version: 1,
        intents: [
          {
            workspaceId: "workspace-target", action: "delete", baseSeq: 4,
            previousActiveWorkspaceId: "workspace-nearest", createdAt: 100,
          },
          {
            workspaceId: "workspace-unrelated", action: "restore", baseSeq: 6,
            previousActiveWorkspaceId: "workspace-unrelated", createdAt: 200,
          },
        ],
      },
    },
    {
      key: "workspace-lifecycle-deferred-sync-v1",
      value: {
        version: 1,
        payloadsByWorkspaceId: {
          "workspace-target": emptyPayload("workspace-target"),
          "workspace-unrelated": emptyPayload("workspace-unrelated"),
        },
      },
    },
    {
      key: "guest-workspace-provenance-v1",
      value: { workspaceId: "workspace-target", defaultCollectionId: "collection-a" },
    },
    {
      key: "guest-workspace-orphan-recovery-v1",
      value: [
        {
          workspaceId: "workspace-target", collectionIds: ["collection-a", "collection-b"],
          groupIds: ["group-target"], recoveredAt: 100,
        },
        {
          workspaceId: "workspace-unrelated", collectionIds: ["collection-unrelated"],
          groupIds: ["group-unrelated"], recoveredAt: 200,
        },
      ],
    },
    {
      key: "workspace-parent-tombstone-capability-v1:server:user",
      value: { version: 1, supported: true },
    },
    {
      key: "workspace-parent-tombstone-full-pull-v1:server:user",
      value: { version: 1, serverSeq: 42 },
    },
  ];
  for (const record of records) {
    await idbPut("kv", record);
  }
}

beforeEach(async () => {
  await clearDB();
  await syncConflictRegistry.ready();
  await syncConflictRegistry.clearAllForManualRetry();
});

describe("Workspace aggregate persistence", () => {
  test("discovers every descendant from IndexedDB without hydrating lazy Bookmark buckets", async () => {
    await seedAggregate();

    expect(await loadWorkspaceAggregateIds("workspace-target")).toEqual({
      workspaceId: "workspace-target",
      collectionIds: ["collection-a", "collection-b"],
      bookmarkIds: ["bookmark-active", "bookmark-archived", "bookmark-trashed"],
      groupIds: ["group-target"],
      groupTabIds: ["group-tab-a", "group-tab-b"],
    });
  });

  test("atomically deletes the terminal aggregate and only its exact metadata", async () => {
    await seedAggregate();
    await seedMetadata();
    await syncConflictRegistry.recordRejections([
      { id: "workspace-target", type: "workspace", reason: "quota_exceeded" },
      {
        id: "collection-a", type: "collection", reason: "parent_rejected",
        parent_id: "workspace-target", parent_type: "workspace",
      },
      {
        id: "collection-b", type: "collection", reason: "parent_rejected",
        parent_id: "workspace-target", parent_type: "workspace",
      },
      {
        id: "bookmark-active", type: "bookmark", reason: "parent_rejected",
        parent_id: "collection-a", parent_type: "collection",
      },
      {
        id: "bookmark-archived", type: "bookmark", reason: "parent_rejected",
        parent_id: "collection-b", parent_type: "collection",
      },
      {
        id: "bookmark-trashed", type: "bookmark", reason: "parent_rejected",
        parent_id: "collection-a", parent_type: "collection",
      },
      {
        id: "group-target", type: "saved_group", reason: "parent_rejected",
        parent_id: "workspace-target", parent_type: "workspace",
      },
      { id: "workspace-unrelated", type: "workspace", reason: "quota_exceeded" },
    ]);
    let committedIds: WorkspaceAggregateIds | undefined;

    const result = await clearWorkspaceAggregate("workspace-target", (ids: WorkspaceAggregateIds) => {
      committedIds = ids;
    });

    const expectedIds = {
      workspaceId: "workspace-target",
      collectionIds: ["collection-a", "collection-b"],
      bookmarkIds: ["bookmark-active", "bookmark-archived", "bookmark-trashed"],
      groupIds: ["group-target"],
      groupTabIds: ["group-tab-a", "group-tab-b"],
    };
    expect(result).toEqual(expectedIds);
    expect(committedIds).toEqual(expectedIds);
    expect(toSyncEntityReferences(expectedIds)).toEqual([
      { entityType: "workspace", entityId: "workspace-target" },
      { entityType: "collection", entityId: "collection-a" },
      { entityType: "collection", entityId: "collection-b" },
      { entityType: "bookmark", entityId: "bookmark-active" },
      { entityType: "bookmark", entityId: "bookmark-archived" },
      { entityType: "bookmark", entityId: "bookmark-trashed" },
      { entityType: "saved_group", entityId: "group-target" },
    ]);

    const deletedRecords: Array<[Parameters<typeof idbGet>[0], string[]]> = [
      ["workspaces", ["workspace-target"]],
      ["collections", ["collection-a", "collection-b"]],
      ["bookmarks", ["bookmark-active"]],
      ["archived-bookmarks", ["bookmark-archived"]],
      ["trashed-bookmarks", ["bookmark-trashed"]],
      ["groups", ["group-target"]],
      ["group-tabs", ["group-tab-a", "group-tab-b"]],
    ];
    for (const [store, ids] of deletedRecords) {
      for (const id of ids) {
        expect(await idbGet(store, id)).toBeUndefined();
      }
    }
    expect(await idbGet("workspaces", "workspace-unrelated")).toBeDefined();
    expect(await idbGet("collections", "collection-unrelated")).toBeDefined();
    expect(await idbGet("bookmarks", "bookmark-unrelated")).toBeDefined();
    expect(await idbGet("groups", "group-unrelated")).toBeDefined();
    expect(await idbGet("group-tabs", "group-tab-unrelated")).toBeDefined();

    expect(await idbGet("kv", "activeWorkspaceId")).toEqual({
      key: "activeWorkspaceId",
      value: "workspace-nearest",
    });
    expect(await idbGet("kv", "workspace-lifecycle-intents-v1")).toEqual({
      key: "workspace-lifecycle-intents-v1",
      value: {
        version: 1,
        intents: [{
          workspaceId: "workspace-unrelated", action: "restore", baseSeq: 6,
          previousActiveWorkspaceId: "workspace-unrelated", createdAt: 200,
        }],
      },
    });
    expect(await idbGet("kv", "workspace-lifecycle-deferred-sync-v1")).toEqual({
      key: "workspace-lifecycle-deferred-sync-v1",
      value: {
        version: 1,
        payloadsByWorkspaceId: {
          "workspace-unrelated": emptyPayload("workspace-unrelated"),
        },
      },
    });
    expect(await idbGet("kv", "guest-workspace-provenance-v1")).toBeUndefined();
    expect(await idbGet("kv", "guest-workspace-orphan-recovery-v1")).toEqual({
      key: "guest-workspace-orphan-recovery-v1",
      value: [{
        workspaceId: "workspace-unrelated", collectionIds: ["collection-unrelated"],
        groupIds: ["group-unrelated"], recoveredAt: 200,
      }],
    });
    expect(await idbGet("kv", "workspace-parent-tombstone-capability-v1:server:user"))
      .toEqual({
        key: "workspace-parent-tombstone-capability-v1:server:user",
        value: { version: 1, supported: true },
      });
    expect(await idbGet("kv", "workspace-parent-tombstone-full-pull-v1:server:user"))
      .toEqual({
        key: "workspace-parent-tombstone-full-pull-v1:server:user",
        value: { version: 1, serverSeq: 42 },
      });
    expect(syncConflictRegistry.list()).toEqual([
      expect.objectContaining({ entityType: "workspace", entityId: "workspace-unrelated" }),
    ]);
  });

  test("rolls back every store when a descendant delete request fails", async () => {
    await seedAggregate();
    await seedMetadata();
    const before = cloneStores(fakeIndexedDB.database.stores);
    fakeIndexedDB.database.failNextRequest({
      store: "group-tabs",
      operation: "delete",
      key: "group-tab-a",
    });

    await expect(permanentlyDeleteWorkspaceAggregate("workspace-target", {
      type: "put",
      store: "kv",
      value: { key: "sync-conflicts-v1", value: { version: 1, entries: [] } },
    })).rejects.toThrow("Injected group-tabs.delete failure");

    expect(fakeIndexedDB.database.stores).toEqual(before);
  });

  test("is idempotent when terminal cleanup runs twice", async () => {
    await seedAggregate();
    await seedMetadata();

    const first = await clearWorkspaceAggregate("workspace-target", () => {});
    const second = await clearWorkspaceAggregate("workspace-target", () => {});

    expect(first?.bookmarkIds).toEqual([
      "bookmark-active",
      "bookmark-archived",
      "bookmark-trashed",
    ]);
    expect(second).toEqual({
      workspaceId: "workspace-target",
      collectionIds: [],
      bookmarkIds: [],
      groupIds: [],
      groupTabIds: [],
    });
    expect(await idbGet("workspaces", "workspace-target")).toBeUndefined();
    expect(await idbGet("workspaces", "workspace-unrelated")).toBeDefined();
  });

  test("breaks equally near active Workspace positions by stable ID", async () => {
    await seedAggregate();
    await idbPut("workspaces", {
      id: "workspace-z-before", name: "Before", color: "purple", position: 8, seq: 1,
    });
    await idbPut("kv", { key: "activeWorkspaceId", value: "workspace-target" });

    await permanentlyDeleteWorkspaceAggregate("workspace-target", {
      type: "put",
      store: "kv",
      value: { key: "sync-conflicts-v1", value: { version: 1, entries: [] } },
    });

    expect(await idbGet("kv", "activeWorkspaceId")).toEqual({
      key: "activeWorkspaceId",
      value: "workspace-nearest",
    });
  });

  test("returns committed IDs as canonical success when the conflict registry resets after commit", async () => {
    await seedAggregate();
    await seedMetadata();
    await syncConflictRegistry.recordRejections([
      { id: "workspace-target", type: "workspace", reason: "quota_exceeded" },
    ]);
    let postCommitCalled = false;
    let optimisticCardVisible = false;
    fakeIndexedDB.database.observeNextAggregateCommit(() => syncConflictRegistry.reset());

    const result = await clearWorkspaceAggregate("workspace-target", () => {
      postCommitCalled = true;
    });
    if (!result) {
      optimisticCardVisible = true;
    }

    expect(result?.workspaceId).toBe("workspace-target");
    expect(postCommitCalled).toBe(false);
    expect(optimisticCardVisible).toBe(false);
    expect(await idbGet("workspaces", "workspace-target")).toBeUndefined();
  });
});
}
