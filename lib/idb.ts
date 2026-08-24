import type { Workspace } from "@/lib/types";
import type {
  WorkspaceLifecycleIntent,
  WorkspaceLifecycleIntentRecord,
} from "@/lib/workspace-lifecycle-state";

const DB_NAME = "tabslate-db";
const DB_VERSION = 3;
const WORKSPACE_LIFECYCLE_INTENTS_KEY = "workspace-lifecycle-intents-v1";

export type StoreName =
  | "bookmarks"
  | "archived-bookmarks"
  | "trashed-bookmarks"
  | "workspaces"
  | "collections"
  | "tags"
  | "groups"
  | "group-tabs"
  | "tab-group-titles"
  | "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

export async function clearDB(): Promise<void> {
  // Close the open connection first so the delete request isn't blocked.
  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {
      // already closed or never opened
    }
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // another tab has it open; our close above covers our tab
  });
}

export function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (event.oldVersion < 1) {
          const bs = db.createObjectStore("bookmarks", { keyPath: "id" });
          bs.createIndex("collectionId", "collectionId");
          bs.createIndex("isFavorite", "isFavorite");
          const abs = db.createObjectStore("archived-bookmarks", { keyPath: "id" });
          abs.createIndex("collectionId", "collectionId");
          const tbs = db.createObjectStore("trashed-bookmarks", { keyPath: "id" });
          tbs.createIndex("collectionId", "collectionId");
          const ws = db.createObjectStore("workspaces", { keyPath: "id" });
          ws.createIndex("position", "position");
          const cs = db.createObjectStore("collections", { keyPath: "id" });
          cs.createIndex("workspaceId", "workspaceId");
          cs.createIndex("position", "position");
          db.createObjectStore("tags", { keyPath: "id" });
          db.createObjectStore("groups", { keyPath: "id" });
          const gt = db.createObjectStore("group-tabs", { keyPath: "id" });
          gt.createIndex("groupId", "groupId");
          db.createObjectStore("tab-group-titles", { keyPath: "groupId" });
          db.createObjectStore("kv", { keyPath: "key" });
        }
        if (event.oldVersion >= 1 && event.oldVersion < 2) {
          // Add collectionId index to trashed-bookmarks (enables indexed queries, avoids full-store scans).
          // Fresh installs (oldVersion < 1) already have this index from the block above.
          const tbs = (event.target as IDBOpenDBRequest).transaction!.objectStore("trashed-bookmarks");
          tbs.createIndex("collectionId", "collectionId");
        }
        if (event.oldVersion < 3) {
          const transaction = req.transaction;
          if (!transaction) {
            throw new Error("IndexedDB upgrade transaction is unavailable");
          }
          const groupsStore = transaction.objectStore("groups");
          if (!groupsStore.indexNames.contains("workspaceId")) {
            groupsStore.createIndex("workspaceId", "workspaceId", { unique: false });
          }
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut<T>(store: StoreName, value: T): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readwrite").objectStore(store).put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

interface KVRecordValue {
  value: unknown;
}

function isKVRecordValue(value: unknown): value is KVRecordValue {
  return typeof value === "object" && value !== null && "value" in value;
}

/**
 * Atomically updates one versioned kv value. The decoder keeps untrusted IDB
 * data outside the updater, and every read/write remains in one transaction.
 */
export function idbUpdateKV<T extends object>(
  key: string,
  decode: (value: unknown) => T | undefined,
  update: (current: T | undefined) => T | undefined,
): Promise<void> {
  return getDB().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction("kv", "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);

    const request = transaction.objectStore("kv").get(key);
    request.onerror = () => transaction.abort();
    request.onsuccess = () => {
      try {
        const persisted: unknown = request.result;
        const current = isKVRecordValue(persisted)
          ? decode(persisted.value)
          : undefined;
        const next = update(current);
        if (next) {
          transaction.objectStore("kv").put({ key, value: next });
          return;
        }
        transaction.objectStore("kv").delete(key);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
  }));
}

export interface CommitWorkspaceLifecycleIntentInput {
  workspace: Workspace;
  intent: WorkspaceLifecycleIntent;
  activeWorkspaceId?: string;
}

interface WorkspaceLifecycleIntentKVRecord {
  key: string;
  value: WorkspaceLifecycleIntentRecord;
}

function isWorkspaceLifecycleIntent(value: unknown): value is WorkspaceLifecycleIntent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return "workspaceId" in value && typeof value.workspaceId === "string" &&
    "action" in value && (value.action === "delete" || value.action === "restore") &&
    "baseSeq" in value && typeof value.baseSeq === "number" &&
    "previousActiveWorkspaceId" in value && typeof value.previousActiveWorkspaceId === "string" &&
    "createdAt" in value && typeof value.createdAt === "number";
}

function isWorkspaceLifecycleIntentKVRecord(
  value: unknown,
): value is WorkspaceLifecycleIntentKVRecord {
  if (typeof value !== "object" || value === null || !("value" in value)) {
    return false;
  }
  const record = value.value;
  if (
    typeof record !== "object" ||
    record === null ||
    !("version" in record) ||
    record.version !== 1 ||
    !("intents" in record) ||
    !Array.isArray(record.intents)
  ) {
    return false;
  }
  return record.intents.every(isWorkspaceLifecycleIntent);
}

export function idbCommitWorkspaceLifecycleIntent(
  input: CommitWorkspaceLifecycleIntentInput,
): Promise<void> {
  return getDB().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(["workspaces", "kv"], "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);

    transaction.objectStore("workspaces").put(input.workspace);
    const intentsRequest = transaction.objectStore("kv").get(
      WORKSPACE_LIFECYCLE_INTENTS_KEY,
    );
    intentsRequest.onerror = () => transaction.abort();
    intentsRequest.onsuccess = () => {
      const persisted: unknown = intentsRequest.result;
      const current = isWorkspaceLifecycleIntentKVRecord(persisted)
        ? persisted.value.intents
        : [];
      const remaining = current.filter(
        (candidate) => candidate.workspaceId !== input.intent.workspaceId,
      );
      const value: WorkspaceLifecycleIntentRecord = {
        version: 1,
        intents: [...remaining, input.intent],
      };
      transaction.objectStore("kv").put({
        key: WORKSPACE_LIFECYCLE_INTENTS_KEY,
        value,
      });
      if (input.activeWorkspaceId !== undefined) {
        transaction.objectStore("kv").put({
          key: "activeWorkspaceId",
          value: input.activeWorkspaceId,
        });
      }
    };
  }));
}

/**
 * Conditionally creates the first local guest seed.  The read and writes share
 * one IndexedDB transaction, so separate new-tab JS contexts cannot both seed
 * an empty database.
 */
export function idbCreateGuestWorkspaceIfEmpty(
  workspace: object,
  collection: object,
  activeWorkspace: object,
  provenance: object,
): Promise<boolean> {
  return getDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(["workspaces", "collections", "kv"], "readwrite");
    let created = false;
    tx.oncomplete = () => resolve(created);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);

    const workspacesRequest = tx.objectStore("workspaces").getAll();
    const provenanceRequest = tx.objectStore("kv").get("guest-workspace-provenance-v1");
    workspacesRequest.onerror = () => tx.abort();
    provenanceRequest.onerror = () => tx.abort();
    let workspaces: object[] | null = null;
    let provenanceExists: boolean | null = null;
    const createIfEmpty = () => {
      if (workspaces === null || provenanceExists === null || workspaces.length > 0 || provenanceExists) {
        return;
      }
      tx.objectStore("workspaces").put(workspace);
      tx.objectStore("collections").put(collection);
      tx.objectStore("kv").put(activeWorkspace);
      tx.objectStore("kv").put(provenance);
      created = true;
    };
    workspacesRequest.onsuccess = () => {
      workspaces = workspacesRequest.result as object[];
      createIfEmpty();
    };
    provenanceRequest.onsuccess = () => {
      provenanceExists = provenanceRequest.result !== undefined;
      createIfEmpty();
    };
  }));
}

interface LockRecord {
  key: string;
  value: { owner: string; expiresAt: number };
}

interface GuestSeedWorkspaceRecord {
  id: string;
  name: string;
  color: string;
  position: number;
  seq: number;
  deletedAt?: number;
}

interface GuestSeedCollectionRecord {
  id: string;
  workspaceId: string;
  name: string;
  icon: string;
  position: number;
  isDefault?: boolean;
  seq: number;
  deletedAt?: number;
  archivedAt?: number;
}

interface GuestSeedProvenanceRecord {
  key: string;
  value: { workspaceId: string; defaultCollectionId: string };
}

interface GuestSeedChildRecord {
  collectionId?: string;
  workspaceId?: string;
}

/**
 * Removes a just-created seed only when it is still byte-for-byte the original
 * untouched guest seed.  This makes a stale initializer cancellable without
 * deleting data that login/reconciliation or a user has since changed.
 */
export function idbRollbackGuestWorkspaceIfUnchanged(
  workspace: GuestSeedWorkspaceRecord,
  collection: GuestSeedCollectionRecord,
  provenance: GuestSeedProvenanceRecord,
): Promise<boolean> {
  const stores: StoreName[] = [
    "workspaces", "collections", "bookmarks", "archived-bookmarks",
    "trashed-bookmarks", "groups", "kv",
  ];
  return getDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    let rolledBack = false;
    tx.oncomplete = () => resolve(rolledBack);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    const workspaceRequest = tx.objectStore("workspaces").get(workspace.id);
    const collectionRequest = tx.objectStore("collections").get(collection.id);
    const workspaceCollectionsRequest = tx.objectStore("collections").getAll();
    const provenanceRequest = tx.objectStore("kv").get(provenance.key);
    const activeRequest = tx.objectStore("kv").get("activeWorkspaceId");
    const activeBookmarksRequest = tx.objectStore("bookmarks").getAll();
    const archivedBookmarksRequest = tx.objectStore("archived-bookmarks").getAll();
    const trashedBookmarksRequest = tx.objectStore("trashed-bookmarks").getAll();
    const groupsRequest = tx.objectStore("groups").getAll();
    const requests = [
      workspaceRequest, collectionRequest, workspaceCollectionsRequest, provenanceRequest, activeRequest,
      activeBookmarksRequest, archivedBookmarksRequest, trashedBookmarksRequest, groupsRequest,
    ];
    for (const request of requests) {
      request.onerror = () => tx.abort();
    }
    let completed = 0;
    const decide = () => {
      completed += 1;
      if (completed !== requests.length) {
        return;
      }
      const persistedWorkspace = workspaceRequest.result as GuestSeedWorkspaceRecord | undefined;
      const persistedCollection = collectionRequest.result as GuestSeedCollectionRecord | undefined;
      const workspaceCollections = workspaceCollectionsRequest.result as GuestSeedCollectionRecord[];
      const persistedProvenance = provenanceRequest.result as GuestSeedProvenanceRecord | undefined;
      const active = activeRequest.result as { key: string; value: string } | undefined;
      const bookmarks = [
        ...(activeBookmarksRequest.result as GuestSeedChildRecord[]),
        ...(archivedBookmarksRequest.result as GuestSeedChildRecord[]),
        ...(trashedBookmarksRequest.result as GuestSeedChildRecord[]),
      ];
      const groups = groupsRequest.result as GuestSeedChildRecord[];
      const workspaceMatches = JSON.stringify(persistedWorkspace) === JSON.stringify(workspace);
      const collectionMatches = JSON.stringify(persistedCollection) === JSON.stringify(collection);
      const provenanceMatches = persistedProvenance?.value.workspaceId === workspace.id &&
        persistedProvenance.value.defaultCollectionId === collection.id;
      const hasChildren = bookmarks.some((bookmark) => bookmark.collectionId === collection.id) ||
        groups.some((group) => group.workspaceId === workspace.id) ||
        workspaceCollections.some((candidate) =>
          candidate.workspaceId === workspace.id && candidate.id !== collection.id,
        );
      if (!workspaceMatches || !collectionMatches || !provenanceMatches || hasChildren) {
        return;
      }
      tx.objectStore("workspaces").delete(workspace.id);
      tx.objectStore("collections").delete(collection.id);
      tx.objectStore("kv").delete(provenance.key);
      if (active?.value === workspace.id) {
        tx.objectStore("kv").delete("activeWorkspaceId");
      }
      rolledBack = true;
    };
    for (const request of requests) {
      request.onsuccess = decide;
    }
  }));
}

/** A lease mutex for browser contexts that do not expose the Web Locks API. */
export function idbTryAcquireLock(key: string, owner: string, expiresAt: number): Promise<boolean> {
  return getDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    let acquired = false;
    tx.oncomplete = () => resolve(acquired);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    const request = tx.objectStore("kv").get(key);
    request.onerror = () => tx.abort();
    request.onsuccess = () => {
      const record = request.result as LockRecord | undefined;
      const expired = !record || record.value.expiresAt <= Date.now();
      if (!expired && record.value.owner !== owner) {
        return;
      }
      tx.objectStore("kv").put({ key, value: { owner, expiresAt } });
      acquired = true;
    };
  }));
}

export function idbReleaseLock(key: string, owner: string): Promise<void> {
  return getDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    const request = tx.objectStore("kv").get(key);
    request.onerror = () => tx.abort();
    request.onsuccess = () => {
      const record = request.result as LockRecord | undefined;
      if (record?.value.owner === owner) {
        tx.objectStore("kv").delete(key);
      }
    };
  }));
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readwrite").objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function idbCount(store: StoreName): Promise<number> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Fetches multiple keys from the same store in a single IDB transaction.
 * Dramatically more efficient than Promise.all(keys.map(idbGet)) which creates
 * one transaction per key — this creates exactly one transaction with N requests.
 */
export async function idbGetMany<T>(store: StoreName, keys: IDBValidKey[]): Promise<(T | undefined)[]> {
  if (keys.length === 0) return [];
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const os = tx.objectStore(store);
    const results: (T | undefined)[] = new Array(keys.length).fill(undefined);
    tx.oncomplete = () => resolve(results);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    for (let i = 0; i < keys.length; i++) {
      const req = os.get(keys[i]);
      const idx = i;
      req.onsuccess = () => { results[idx] = req.result as T | undefined; };
    }
  });
}

export async function idbGetByIndex<T>(
  store: StoreName,
  index: string,
  value: IDBValidKey,
): Promise<T[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(store, "readonly")
      .objectStore(store)
      .index(index)
      .getAll(value);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

/**
 * fn must issue all IDB requests synchronously — the transaction auto-commits
 * on the microtask boundary, so any await inside fn will silently drop writes.
 */
export function idbTransaction<Result>(
  stores: StoreName[],
  mode: "readonly" | "readwrite",
  fn: (tx: IDBTransaction) => Result,
): Promise<Result> {
  return getDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let result: { value: Result } | undefined;
        tx.oncomplete = () => {
          if (!result) {
            reject(new Error("IndexedDB transaction result is unavailable"));
            return;
          }
          resolve(result.value);
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        try {
          result = { value: fn(tx) };
        } catch (error) {
          reject(error);
          tx.abort();
        }
      }),
  );
}

export type BulkWriteOp =
  | { type: "delete"; store: StoreName; key: IDBValidKey }
  | { type: "put"; store: StoreName; value: object };

/**
 * Executes multiple delete/put operations across one or more stores in a
 * single IDB transaction. All ops are issued synchronously inside the
 * transaction callback — no awaits permitted inside the callback.
 */
export function idbBulkWrite(ops: BulkWriteOp[]): Promise<void> {
  if (ops.length === 0) {
    return Promise.resolve();
  }
  const stores = [...new Set(ops.map(op => op.store))] as StoreName[];
  return idbTransaction(stores, "readwrite", (tx) => {
    for (const op of ops) {
      if (op.type === "delete") {
        tx.objectStore(op.store).delete(op.key);
      } else {
        tx.objectStore(op.store).put(op.value);
      }
    }
  });
}
