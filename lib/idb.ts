const DB_NAME = "tabslate-db";
const DB_VERSION = 1;

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
          db.createObjectStore("trashed-bookmarks", { keyPath: "id" });
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

