// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, describe, expect, test } from "bun:test";
import type { StoreName } from "../lib/idb";
import { spawnSync } from "node:child_process";

interface StoredRecord {
  id?: string;
  key?: string;
  workspaceId?: string;
  collectionId?: string;
  groupId?: string;
  deletedAt?: number;
  [property: string]: unknown;
}

class FakeRequest {
  result: unknown;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private readonly working: Map<string, Map<string, StoredRecord>>;
  private pending = 0;
  private aborted = false;
  private completionQueued = false;

  constructor(
    private readonly database: FakeDatabase,
    readonly storeNames: string[],
    private readonly mode: "readonly" | "readwrite",
  ) {
    this.working = cloneStores(database.stores);
  }

  objectStore(name: string): FakeObjectStore {
    const records = this.working.get(name);
    if (!records || !this.storeNames.includes(name)) {
      throw new Error(`Store ${name} is not part of this transaction`);
    }
    return new FakeObjectStore(this, name, records);
  }

  schedule(run: () => unknown): FakeRequest {
    const request = new FakeRequest();
    this.pending += 1;
    queueMicrotask(() => {
      if (this.aborted) {
        return;
      }
      try {
        request.result = run();
        request.onsuccess?.();
        this.pending -= 1;
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
    this.onabort?.();
  }

  private queueCompletion(): void {
    if (this.pending !== 0 || this.completionQueued || this.aborted) {
      return;
    }
    this.completionQueued = true;
    queueMicrotask(() => {
      if (this.pending !== 0 || this.aborted) {
        this.completionQueued = false;
        return;
      }
      if (this.mode === "readwrite") {
        if (this.storeNames.includes("workspaces") && this.storeNames.includes("group-tabs") &&
          this.storeNames.includes("kv")) {
          this.database.recoveryMarkerVisibleBeforeCommit =
            this.database.stores.get("kv")?.has("guest-workspace-orphan-recovery-v1") ?? false;
        }
        this.database.replaceStores(this.working, this.storeNames);
      }
      this.database.committed = true;
      this.oncomplete?.();
    });
  }
}

const INDEX_FIELDS: Record<string, Record<string, keyof StoredRecord>> = {
  collections: { workspaceId: "workspaceId" },
  bookmarks: { collectionId: "collectionId" },
  "archived-bookmarks": { collectionId: "collectionId" },
  "trashed-bookmarks": { collectionId: "collectionId" },
  groups: { workspaceId: "workspaceId" },
  "group-tabs": { groupId: "groupId" },
};

class FakeIndex {
  constructor(
    private readonly transaction: FakeTransaction,
    private readonly records: ReadonlyMap<string, StoredRecord>,
    private readonly field: keyof StoredRecord,
  ) {}

  getAll(value: string): FakeRequest {
    return this.transaction.schedule(() => [...this.records.values()]
      .filter((record) => record[this.field] === value)
      .map((record) => structuredClone(record)));
  }
}

class FakeObjectStore {
  constructor(
    private readonly transaction: FakeTransaction,
    private readonly name: string,
    private readonly records: Map<string, StoredRecord>,
  ) {}

  index(name: string): FakeIndex {
    const field = INDEX_FIELDS[this.name]?.[name];
    if (!field) {
      throw new Error(`Unknown index ${this.name}.${name}`);
    }
    return new FakeIndex(this.transaction, this.records, field);
  }

  get(key: string): FakeRequest {
    return this.transaction.schedule(() => {
      const record = this.records.get(key);
      return record ? structuredClone(record) : undefined;
    });
  }

  getAll(): FakeRequest {
    return this.transaction.schedule(() => [...this.records.values()]
      .map((record) => structuredClone(record)));
  }

  put(record: StoredRecord): FakeRequest {
    const key = typeof record.key === "string" ? record.key : record.id;
    return this.transaction.schedule(() => {
      if (!key) {
        throw new Error(`Missing key for ${this.name}`);
      }
      this.records.set(key, structuredClone(record));
      return key;
    });
  }

  delete(key: string): FakeRequest {
    return this.transaction.schedule(() => {
      this.records.delete(key);
      return undefined;
    });
  }
}

function cloneStores(
  stores: ReadonlyMap<string, ReadonlyMap<string, StoredRecord>>,
): Map<string, Map<string, StoredRecord>> {
  return new Map([...stores.entries()].map(([name, records]) => [
    name,
    new Map([...records.entries()].map(([key, record]) => [key, structuredClone(record)])),
  ]));
}

const STORE_NAMES: StoreName[] = [
  "bookmarks", "archived-bookmarks", "trashed-bookmarks", "workspaces",
  "collections", "tags", "groups", "group-tabs", "tab-group-titles", "kv",
];

class FakeDatabase {
  stores = new Map<string, Map<string, StoredRecord>>(
    STORE_NAMES.map((name) => [name, new Map()]),
  );
  committed = false;
  recoveryMarkerVisibleBeforeCommit: boolean | null = null;
  onversionchange: (() => void) | null = null;

  transaction(stores: string | string[], mode: "readonly" | "readwrite" = "readonly"): FakeTransaction {
    this.committed = false;
    return new FakeTransaction(this, typeof stores === "string" ? [stores] : stores, mode);
  }

  replaceStores(next: ReadonlyMap<string, ReadonlyMap<string, StoredRecord>>, names: string[]): void {
    for (const name of names) {
      const records = next.get(name);
      if (records) {
        this.stores.set(name, new Map([...records.entries()].map(([key, record]) => [
          key,
          structuredClone(record),
        ])));
      }
    }
  }

  close(): void {}
}

class FakeOpenRequest {
  result: FakeDatabase;
  error: Error | null = null;
  transaction: null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;

  constructor(database: FakeDatabase) {
    this.result = database;
  }
}

class FakeIndexedDBFactory {
  readonly database = new FakeDatabase();

  open(): FakeOpenRequest {
    const request = new FakeOpenRequest(this.database);
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }
}

const fakeIndexedDB = new FakeIndexedDBFactory();
if (process.env.TABSLATE_GUEST_ORPHANS_ISOLATED !== "1") {
  test("runs legacy Guest orphan recovery tests isolated from process-global module mocks", () => {
    const result = spawnSync(
      "bun",
      ["test", "test/guest-workspace-orphan-recovery.test.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, TABSLATE_GUEST_ORPHANS_ISOLATED: "1" },
      },
    );
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.status).toBe(0);
  });
} else {
Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB });
const idb = await import(`../lib/idb.ts?guest-orphans=${Date.now()}`);
const {
  GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY,
  recoverLegacyGuestWorkspaceOrphans,
  restoreRecoveredGuestAggregate,
} = await import(`../lib/guest-workspace-orphan-recovery.ts?test=${Date.now()}`);

async function put(store: StoreName, record: StoredRecord): Promise<void> {
  await idb.idbPut(store, record);
}

function bookmark(id: string, collectionId: string, deletedAt: number): StoredRecord {
  return {
    id, collectionId, title: id, url: `https://${id}.example`, description: "", favicon: "",
    tags: [], createdAt: "1", isFavorite: false, seq: 0, deletedAt,
  };
}

describe("legacy Guest orphan recovery", () => {
  beforeEach(() => {
    fakeIndexedDB.database.stores = new Map(STORE_NAMES.map((name) => [name, new Map()]));
    fakeIndexedDB.database.recoveryMarkerVisibleBeforeCommit = null;
  });

  test("creates one retained synthetic root and commits its marker after every descendant", async () => {
    await put("collections", {
      id: "collection-active", workspaceId: "missing-workspace", name: "Active", icon: "folder",
      position: 1, seq: 0, deletedAt: 300,
    });
    await put("collections", {
      id: "collection-archived", workspaceId: "missing-workspace", name: "Archived", icon: "archive",
      position: 2, seq: 0, archivedAt: 50, deletedAt: 250,
    });
    await put("bookmarks", bookmark("active-bookmark", "collection-active", 225));
    await put("archived-bookmarks", bookmark("archived-bookmark", "collection-archived", 210));
    await put("trashed-bookmarks", bookmark("trashed-bookmark", "collection-active", 200));
    await put("groups", {
      id: "saved-group", workspaceId: "missing-workspace", name: "Saved", color: "blue",
      isCompact: false, createdAt: "1", seq: 0, deletedAt: 275,
    });
    await put("group-tabs", {
      id: "group-tab", groupId: "saved-group", title: "Tab", url: "https://tab.example",
      favicon: "", position: 0,
    });
    await put("collections", {
      id: "empty-parent", workspaceId: "", name: "Unrecoverable", icon: "folder",
      position: 3, seq: 0, deletedAt: 100,
    });

    const records = await recoverLegacyGuestWorkspaceOrphans();

    expect(fakeIndexedDB.database.committed).toBe(true);
    expect(fakeIndexedDB.database.recoveryMarkerVisibleBeforeCommit).toBe(false);
    expect(records).toEqual([{
      workspaceId: "missing-workspace",
      collectionIds: ["collection-active", "collection-archived"],
      groupIds: ["saved-group"],
      recoveredAt: expect.any(Number),
    }]);
    expect(await idb.idbGet("workspaces", "missing-workspace")).toEqual({
      id: "missing-workspace",
      name: "Recovered Workspace",
      color: "gray",
      position: 0,
      seq: 0,
      deletedAt: 200,
      deletionModel: 0,
    });
    expect(await idb.idbGet("collections", "collection-active")).toMatchObject({ id: "collection-active" });
    expect(await idb.idbGet("bookmarks", "active-bookmark")).toMatchObject({ id: "active-bookmark" });
    expect(await idb.idbGet("archived-bookmarks", "archived-bookmark")).toMatchObject({ id: "archived-bookmark" });
    expect(await idb.idbGet("trashed-bookmarks", "trashed-bookmark")).toMatchObject({ id: "trashed-bookmark" });
    expect(await idb.idbGet("groups", "saved-group")).toMatchObject({ id: "saved-group" });
    expect(await idb.idbGet("group-tabs", "group-tab")).toMatchObject({ id: "group-tab" });
    expect(await idb.idbGet("kv", "workspace-lifecycle-intents-v1")).toMatchObject({
      value: { intents: [{ workspaceId: "missing-workspace", action: "delete", baseSeq: 0, createdAt: 200 }] },
    });
    expect(await idb.idbGet("kv", GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY)).toEqual({
      key: GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY,
      value: records,
    });
    expect(await idb.idbGet("kv", "guest-workspace-provenance-v1")).toBeUndefined();
  });

  test("is idempotent and ignores unresolved parents without recoverable deletion evidence", async () => {
    await put("collections", {
      id: "collection", workspaceId: "missing", name: "Collection", icon: "folder",
      position: 0, seq: 0, deletedAt: 100,
    });
    await put("groups", {
      id: "unrecoverable-group", workspaceId: "no-deletion-evidence", name: "Group", color: "blue",
      isCompact: false, createdAt: "1", seq: 0,
    });

    const first = await recoverLegacyGuestWorkspaceOrphans();
    const second = await recoverLegacyGuestWorkspaceOrphans();

    expect(second).toEqual(first);
    expect(await idb.idbGet("workspaces", "no-deletion-evidence")).toBeUndefined();
    expect(await idb.idbGet("kv", "workspace-lifecycle-intents-v1")).toMatchObject({
      value: { intents: [expect.objectContaining({ workspaceId: "missing" })] },
    });
  });

  test("restores recorded descendants while retaining Collection archive metadata", async () => {
    await put("collections", {
      id: "collection", workspaceId: "missing", name: "Collection", icon: "archive",
      position: 0, seq: 0, deletedAt: 100, archivedAt: 50,
    });
    await put("trashed-bookmarks", bookmark("bookmark", "collection", 100));
    await put("groups", {
      id: "group", workspaceId: "missing", name: "Group", color: "blue",
      isCompact: false, createdAt: "1", seq: 0, deletedAt: 100,
    });
    await recoverLegacyGuestWorkspaceOrphans();

    await restoreRecoveredGuestAggregate("missing");

    expect(await idb.idbGet("workspaces", "missing")).toEqual({
      id: "missing", name: "Recovered Workspace", color: "gray", position: 0,
      seq: 0, deletionModel: 1,
    });
    expect(await idb.idbGet("collections", "collection")).toMatchObject({
      id: "collection", archivedAt: 50, seq: 0,
    });
    expect(await idb.idbGet("collections", "collection")).not.toHaveProperty("deletedAt");
    expect(await idb.idbGet("groups", "group")).not.toHaveProperty("deletedAt");
    expect(await idb.idbGet("trashed-bookmarks", "bookmark")).toBeUndefined();
    expect(await idb.idbGet("bookmarks", "bookmark")).not.toHaveProperty("deletedAt");
    expect(await idb.idbGet("kv", "activeWorkspaceId")).toEqual({ key: "activeWorkspaceId", value: "missing" });
    expect(await idb.idbGet("kv", "workspace-lifecycle-intents-v1")).toBeUndefined();
    expect(await idb.idbGet("kv", GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY)).toEqual({
      key: GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY,
      value: [],
    });
  });
});
}
