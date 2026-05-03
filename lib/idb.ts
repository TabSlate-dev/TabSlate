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

export function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
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

export async function migrateFromChromeStorage(): Promise<void> {
  const MIGRATION_KEYS = [
    "tabslate-bookmarks",
    "tabslate-workspace",
    "tabslate-groups",
    "tabslate-full-titles",
    "tabslate-sync-leader",
    "tabslate-sync",
    "tabslate-tabs-changed",
  ];

  const result = await new Promise<Record<string, unknown>>((resolve) =>
    chrome.storage.local.get(MIGRATION_KEYS, (r) => resolve(r)),
  );

  if (!Object.values(result).some(Boolean)) {
    return;
  }

  try {
    await idbTransaction(
      [
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
      ],
      "readwrite",
      (tx) => {
        const raw = result["tabslate-bookmarks"];
        if (raw) {
          try {
            const state =
              (typeof raw === "string"
                ? JSON.parse(raw)
                : (raw as Record<string, unknown>))?.state ?? {};
            const s = state as Record<string, unknown[]>;
            const bsStore = tx.objectStore("bookmarks");
            const absStore = tx.objectStore("archived-bookmarks");
            const tbsStore = tx.objectStore("trashed-bookmarks");
            for (const b of s.bookmarks ?? []) { bsStore.put(b); }
            for (const b of s.archivedBookmarks ?? []) { absStore.put(b); }
            for (const b of s.trashedBookmarks ?? []) { tbsStore.put(b); }
          } catch { /* ignore */ }
        }

        const wsRaw = result["tabslate-workspace"];
        if (wsRaw) {
          try {
            const state =
              (typeof wsRaw === "string"
                ? JSON.parse(wsRaw)
                : (wsRaw as Record<string, unknown>))?.state ?? {};
            const s = state as Record<string, unknown>;
            const wsStore = tx.objectStore("workspaces");
            const colStore = tx.objectStore("collections");
            const tagStore = tx.objectStore("tags");
            const kvStore = tx.objectStore("kv");
            for (const w of (s.workspaces as unknown[]) ?? []) { wsStore.put(w); }
            for (const c of (s.collections as unknown[]) ?? []) { colStore.put(c); }
            for (const t of (s.tags as unknown[]) ?? []) { tagStore.put(t); }
            if (s.activeWorkspaceId != null) {
              kvStore.put({ key: "activeWorkspaceId", value: s.activeWorkspaceId });
            }
            if (s.compactGroupTitles != null) {
              kvStore.put({ key: "compactGroupTitles", value: s.compactGroupTitles });
            }
            if (s.localSeq != null) {
              kvStore.put({ key: "localSeq", value: s.localSeq });
            }
          } catch { /* ignore */ }
        }

        const grpRaw = result["tabslate-groups"];
        if (grpRaw) {
          try {
            const state =
              (typeof grpRaw === "string"
                ? JSON.parse(grpRaw)
                : (grpRaw as Record<string, unknown>))?.state ?? {};
            const s = state as Record<string, unknown>;
            const grpStore = tx.objectStore("groups");
            const grpTabStore = tx.objectStore("group-tabs");
            for (const g of (s.groups as unknown[]) ?? []) { grpStore.put(g); }
            for (const t of (s.groupTabs as unknown[]) ?? []) { grpTabStore.put(t); }
          } catch { /* ignore */ }
        }

        const titles = result["tabslate-full-titles"];
        if (titles && typeof titles === "object") {
          const titleStore = tx.objectStore("tab-group-titles");
          for (const [groupId, title] of Object.entries(
            titles as Record<string, string>,
          )) {
            titleStore.put({ groupId: Number(groupId), title });
          }
        }

        const syncLeader = result["tabslate-sync-leader"];
        if (syncLeader) {
          tx.objectStore("kv").put({ key: "sync-leader", value: syncLeader });
        }
      },
    );

    await new Promise<void>((resolve) =>
      chrome.storage.local.remove(MIGRATION_KEYS, resolve),
    );
  } catch (err) {
    console.error("[TabSlate] Storage migration failed, starting fresh:", err);
  }
}
