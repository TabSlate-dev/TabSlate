const DB_NAME = "tabslate-db";
const DB_VERSION = 2;

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
export function idbTransaction(
  stores: StoreName[],
  mode: "readonly" | "readwrite",
  fn: (tx: IDBTransaction) => void,
): Promise<void> {
  return getDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        fn(tx);
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
