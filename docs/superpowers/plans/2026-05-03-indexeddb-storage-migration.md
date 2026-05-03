# IndexedDB Storage Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `chrome.storage.local` with IndexedDB record-level storage to eliminate the 10 MB cap and write amplification, fix the SSE leader election race condition, and replace `chrome.storage.onChanged` with `chrome.runtime.sendMessage` for cross-context communication.

**Architecture:** A new `lib/idb.ts` provides the sole IDB access layer (lazy singleton, auto-reconnects on SW restart). All stores drop Zustand `persist` middleware and gain manual `hydrate()` actions that read from IDB on mount. Every mutating action performs a fire-and-forget IDB write after updating Zustand. A one-time migration at startup copies existing chrome.storage blobs into IDB and removes the old keys.

**Tech Stack:** IndexedDB (native), Zustand (no persist middleware), `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`, WXT / MV3

---

## File Map

| File | Change |
|---|---|
| `lib/idb.ts` | **New** — IndexedDB access layer + one-time migration |
| `lib/messages.ts` | **New** — `ExtensionMessage` union type |
| `store/bookmarks-store.ts` | Remove `persist`; add `hydrate()`; IDB write per action; remove `onChanged` listener |
| `store/workspace-store.ts` | Remove `persist`; add `hydrate()`; IDB write per action; remove `onChanged` listener |
| `store/groups-store.ts` | Remove `persist`; add `hydrate()`; IDB write per action; remove `onChanged` listener |
| `store/tabs-store.ts` | Replace all `chrome.storage.local` full-title reads/writes with IDB; fix `dissolveGroup` leak |
| `entrypoints/newtab/App.tsx` | `StoreGate` gains migration + parallel hydration `useEffect`; message listener extended |
| `entrypoints/background.ts` | Fallback `ADD_BOOKMARK` → `idbPut`; `broadcastTabChange` → `tabs.sendMessage` |
| `lib/sse-client.ts` | `tryClaimLeader` rewritten as atomic IDB `readwrite` transaction |

---

## Task 1: Create `lib/idb.ts`

**Files:**
- Create: `lib/idb.ts`

- [ ] **Step 1: Create the file**

```ts
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
```

- [ ] **Step 2: Type-check**

Run: `bun run compile`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add lib/idb.ts
git commit -m "feat: add IndexedDB access layer with one-time chrome.storage migration"
```

---

## Task 2: Create `lib/messages.ts`

**Files:**
- Create: `lib/messages.ts`

- [ ] **Step 1: Create the file**

```ts
import type { Bookmark } from "@/lib/types";

export type ExtensionMessage =
  | { type: "ADD_BOOKMARK"; data: Omit<Bookmark, "id" | "createdAt" | "isFavorite"> }
  | { type: "BOOKMARKS_CHANGED" }
  | { type: "WORKSPACE_CHANGED" }
  | { type: "TABS_CHANGED" };
```

- [ ] **Step 2: Type-check**

Run: `bun run compile`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add lib/messages.ts
git commit -m "feat: add ExtensionMessage cross-context type definitions"
```

---

## Task 3: Migrate `store/bookmarks-store.ts`

**Files:**
- Modify: `store/bookmarks-store.ts`

Three changes: (a) remove `persist` wrapper + related imports; (b) replace every mutating action with an IDB write; (c) delete the `chrome.storage.onChanged` block at the bottom of the file.

- [ ] **Step 1: Replace imports at the top of the file**

Remove:
```ts
import { persist, createJSONStorage } from "zustand/middleware";
import { chromeStorageAdapter } from "@/lib/chrome-storage-adapter";
```

Add:
```ts
import { idbGetAll, idbPut, idbDelete } from "@/lib/idb";
```

- [ ] **Step 2: Update the `BookmarksState` interface**

Replace:
```ts
  _hydrated: boolean;
  setHydrated: () => void;
```

With:
```ts
  _hydrated: boolean;
  hydrate: () => Promise<void>;
```

- [ ] **Step 3: Remove the `persist()` wrapper — change store creation**

Replace the opening:
```ts
export const useBookmarksStore = create<BookmarksState>()(
  persist(
    (set, get) => ({
```

With:
```ts
export const useBookmarksStore = create<BookmarksState>()(
  (set, get) => ({
```

Replace `_hydrated: false, setHydrated: () => set({ _hydrated: true }),` with:

```ts
      _hydrated: false,
      hydrate: async () => {
        const [bookmarks, archivedBookmarks, trashedBookmarks] = await Promise.all([
          idbGetAll<Bookmark>("bookmarks"),
          idbGetAll<Bookmark>("archived-bookmarks"),
          idbGetAll<Bookmark>("trashed-bookmarks"),
        ]);
        set({ bookmarks, archivedBookmarks, trashedBookmarks, _hydrated: true });
      },
```

Remove the persist config object at the end of the `create()` call (the block starting with `{`, containing `name: "tabslate-bookmarks"`, `storage:`, `partialize:`, `onRehydrateStorage:` — and the closing `}` and `)` of `persist(`).

The store creation should end as:
```ts
    }),
);
```

- [ ] **Step 4: Add IDB writes to `addBookmark`**

Replace:
```ts
      addBookmark: (input) => {
        const bookmark: Bookmark = {
          id: generateId(),
          createdAt: new Date().toISOString(),
          isFavorite: false,
          ...input,
        };
        set((s) => ({ bookmarks: [bookmark, ...s.bookmarks] }));
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
        return bookmark;
      },
```

With:
```ts
      addBookmark: (input) => {
        const bookmark: Bookmark = {
          id: generateId(),
          createdAt: new Date().toISOString(),
          isFavorite: false,
          ...input,
        };
        set((s) => ({ bookmarks: [bookmark, ...s.bookmarks] }));
        idbPut("bookmarks", bookmark);
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
        return bookmark;
      },
```

- [ ] **Step 5: Add IDB writes to `addBookmarks`**

Replace:
```ts
      addBookmarks: (newBookmarks) => {
        set((s) => ({ bookmarks: [...newBookmarks, ...s.bookmarks] }));
        if (newBookmarks.length > 0) {
          syncEngine?.enqueue({ bookmarks: newBookmarks.map(b => toServerBookmark(b)) });
        }
      },
```

With:
```ts
      addBookmarks: (newBookmarks) => {
        set((s) => ({ bookmarks: [...newBookmarks, ...s.bookmarks] }));
        for (const b of newBookmarks) { idbPut("bookmarks", b); }
        if (newBookmarks.length > 0) {
          syncEngine?.enqueue({ bookmarks: newBookmarks.map(b => toServerBookmark(b)) });
        }
      },
```

- [ ] **Step 6: Add IDB writes to `updateBookmark`**

Replace:
```ts
      updateBookmark: (id, patch) => {
        set((s) => ({
          bookmarks: s.bookmarks.map((b) =>
            b.id === id ? { ...b, ...patch } : b
          ),
        }));
        const updated = get().bookmarks.find(b => b.id === id);
        if (updated) { syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated)] }); }
      },
```

With:
```ts
      updateBookmark: (id, patch) => {
        set((s) => ({
          bookmarks: s.bookmarks.map((b) =>
            b.id === id ? { ...b, ...patch } : b
          ),
        }));
        const updated = get().bookmarks.find(b => b.id === id);
        if (updated) {
          idbPut("bookmarks", updated);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated)] });
        }
      },
```

- [ ] **Step 7: Add IDB writes to `toggleFavorite`**

Replace:
```ts
      toggleFavorite: (bookmarkId) => {
        set((state) => ({
          bookmarks: state.bookmarks.map((b) =>
            b.id === bookmarkId ? { ...b, isFavorite: !b.isFavorite } : b
          ),
        }));
        const updated = get().bookmarks.find(b => b.id === bookmarkId);
        if (updated) { syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated)] }); }
      },
```

With:
```ts
      toggleFavorite: (bookmarkId) => {
        set((state) => ({
          bookmarks: state.bookmarks.map((b) =>
            b.id === bookmarkId ? { ...b, isFavorite: !b.isFavorite } : b
          ),
        }));
        const updated = get().bookmarks.find(b => b.id === bookmarkId);
        if (updated) {
          idbPut("bookmarks", updated);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated)] });
        }
      },
```

- [ ] **Step 8: Add IDB writes to archive/trash/restore/delete actions**

Replace `archiveBookmark`:
```ts
      archiveBookmark: (bookmarkId) => {
        const bookmark = get().bookmarks.find((b) => b.id === bookmarkId);
        if (!bookmark) return;
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isArchived: true })] });
        idbDelete("bookmarks", bookmarkId);
        idbPut("archived-bookmarks", bookmark);
        set((state) => ({
          bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
          archivedBookmarks: [...state.archivedBookmarks, bookmark],
        }));
      },
```

Replace `restoreFromArchive`:
```ts
      restoreFromArchive: (bookmarkId) => {
        const bookmark = get().archivedBookmarks.find(b => b.id === bookmarkId);
        if (!bookmark) { return; }
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
        idbDelete("archived-bookmarks", bookmarkId);
        idbPut("bookmarks", bookmark);
        set((state) => ({
          archivedBookmarks: state.archivedBookmarks.filter(b => b.id !== bookmarkId),
          bookmarks: [...state.bookmarks, bookmark],
        }));
      },
```

Replace `trashBookmark`:
```ts
      trashBookmark: (bookmarkId) => {
        const bookmark = get().bookmarks.find((b) => b.id === bookmarkId);
        if (!bookmark) return;
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isTrashed: true })] });
        idbDelete("bookmarks", bookmarkId);
        idbPut("trashed-bookmarks", bookmark);
        set((state) => ({
          bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
          trashedBookmarks: [...state.trashedBookmarks, bookmark],
        }));
      },
```

Replace `restoreFromTrash`:
```ts
      restoreFromTrash: (bookmarkId) => {
        const bookmark = get().trashedBookmarks.find(b => b.id === bookmarkId);
        if (!bookmark) { return; }
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
        idbDelete("trashed-bookmarks", bookmarkId);
        idbPut("bookmarks", bookmark);
        set((state) => ({
          trashedBookmarks: state.trashedBookmarks.filter(b => b.id !== bookmarkId),
          bookmarks: [...state.bookmarks, bookmark],
        }));
      },
```

Replace `permanentlyDelete`:
```ts
      permanentlyDelete: (bookmarkId) => {
        const bookmark = get().trashedBookmarks.find(b => b.id === bookmarkId);
        if (bookmark) {
          syncEngine?.enqueue({ bookmarks: [toServerBookmark({ ...bookmark, deletedAt: Date.now() })] });
        }
        idbDelete("trashed-bookmarks", bookmarkId);
        set((state) => ({
          trashedBookmarks: state.trashedBookmarks.filter(b => b.id !== bookmarkId),
        }));
      },
```

- [ ] **Step 9: Add IDB sync to `mergeFromServer`**

After the closing `});` of the `set((state) => { ... })` call inside `mergeFromServer`, add:

```ts
        // Sync IDB after Zustand state update (fire-and-forget)
        const { bookmarks, archivedBookmarks, trashedBookmarks } = get();
        for (const b of bookmarks) { idbPut("bookmarks", b); }
        for (const b of archivedBookmarks) { idbPut("archived-bookmarks", b); }
        for (const b of trashedBookmarks) { idbPut("trashed-bookmarks", b); }
        for (const sb of resp.entities.bookmarks) {
          if (sb.deleted_at) {
            idbDelete("bookmarks", sb.id);
            idbDelete("archived-bookmarks", sb.id);
            idbDelete("trashed-bookmarks", sb.id);
          }
        }
```

- [ ] **Step 10: Add IDB writes to `reassignCollection`**

Replace:
```ts
      reassignCollection: (fromId, toId) => {
        const affected = get().bookmarks.filter(b => b.collectionId === fromId);
        if (affected.length > 0) {
          const updated = affected.map(b => ({ ...b, collectionId: toId }));
          syncEngine?.enqueue({ bookmarks: updated.map(b => toServerBookmark(b)) });
          set((s) => ({
            bookmarks: s.bookmarks.map(b => b.collectionId === fromId ? { ...b, collectionId: toId } : b),
          }));
        }
      },
```

With:
```ts
      reassignCollection: (fromId, toId) => {
        const affected = get().bookmarks.filter(b => b.collectionId === fromId);
        if (affected.length > 0) {
          const updated = affected.map(b => ({ ...b, collectionId: toId }));
          syncEngine?.enqueue({ bookmarks: updated.map(b => toServerBookmark(b)) });
          for (const b of updated) { idbPut("bookmarks", b); }
          set((s) => ({
            bookmarks: s.bookmarks.map(b => b.collectionId === fromId ? { ...b, collectionId: toId } : b),
          }));
        }
      },
```

- [ ] **Step 11: Delete the `chrome.storage.onChanged` block**

Delete the entire block at the bottom of the file (lines 399–424):

```ts
// ---------------------------------------------------------------------------
// Listen for external changes (e.g. popup saved a bookmark)
// ---------------------------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  ...
});
```

- [ ] **Step 12: Type-check**

Run: `bun run compile`
Expected: no errors

- [ ] **Step 13: Commit**

```bash
git add store/bookmarks-store.ts
git commit -m "feat(bookmarks-store): replace chrome.storage persist with IndexedDB record writes"
```

---

## Task 4: Migrate `store/workspace-store.ts`

**Files:**
- Modify: `store/workspace-store.ts`

- [ ] **Step 1: Replace imports**

Remove:
```ts
import { persist, createJSONStorage } from "zustand/middleware";
import { chromeStorageAdapter } from "@/lib/chrome-storage-adapter";
```

Add:
```ts
import { idbGetAll, idbGet, idbPut, idbDelete } from "@/lib/idb";
```

- [ ] **Step 2: Update the `WorkspaceState` interface**

Replace:
```ts
  _hydrated: boolean;
  setHydrated: () => void;
```

With:
```ts
  _hydrated: boolean;
  hydrate: () => Promise<void>;
```

- [ ] **Step 3: Remove `persist()` wrapper and add `hydrate()`**

Change the store creation from `create<WorkspaceState>()(persist((set, get) => ({` to `create<WorkspaceState>()((set, get) => ({`.

Replace `_hydrated: false, setHydrated: () => set({ _hydrated: true }),` with:

```ts
      _hydrated: false,
      hydrate: async () => {
        const [workspaces, collections, tags] = await Promise.all([
          idbGetAll<Workspace>("workspaces"),
          idbGetAll<Collection>("collections"),
          idbGetAll<Tag>("tags"),
        ]);
        const [activeWsKv, compactKv, localSeqKv] = await Promise.all([
          idbGet<{ key: string; value: string }>("kv", "activeWorkspaceId"),
          idbGet<{ key: string; value: boolean }>("kv", "compactGroupTitles"),
          idbGet<{ key: string; value: number }>("kv", "localSeq"),
        ]);

        // Ensure every workspace has a default collection (mirrors onRehydrateStorage logic)
        const missingDefaults = workspaces.filter(
          (ws) => !collections.some((c) => c.workspaceId === ws.id && c.isDefault),
        );
        if (missingDefaults.length > 0) {
          const newCols: Collection[] = missingDefaults.map((ws) => ({
            id: generateId(),
            workspaceId: ws.id,
            name: "Default",
            icon: "inbox",
            position: 0,
            isDefault: true,
            seq: 0,
          }));
          for (const col of newCols) { idbPut("collections", col); }
          collections.push(...newCols);
        }

        set({
          workspaces,
          collections,
          tags,
          activeWorkspaceId: activeWsKv?.value ?? "",
          compactGroupTitles: compactKv?.value ?? true,
          localSeq: localSeqKv?.value ?? 0,
          _hydrated: true,
        });
      },
```

Remove the persist config object (starting at `{`, containing `name: "tabslate-workspace"`, `storage:`, `partialize:`, `onRehydrateStorage:`) and the closing brackets of `persist()`.

- [ ] **Step 4: Add IDB writes to scalar setters**

Replace `setActiveWorkspaceId`:
```ts
      setActiveWorkspaceId: (id) => {
        set({ activeWorkspaceId: id });
        idbPut("kv", { key: "activeWorkspaceId", value: id });
      },
```

Replace `setCompactGroupTitles`:
```ts
      setCompactGroupTitles: (val) => {
        set({ compactGroupTitles: val });
        idbPut("kv", { key: "compactGroupTitles", value: val });
      },
```

Replace `setLocalSeq`:
```ts
      setLocalSeq: (seq) => {
        set({ localSeq: seq });
        idbPut("kv", { key: "localSeq", value: seq });
      },
```

- [ ] **Step 5: Add IDB writes to workspace CRUD**

Replace `createWorkspace`:
```ts
      createWorkspace: (name, color) => {
        const state = get();
        const ws: Workspace = {
          id: generateId(),
          name,
          color,
          position: state.workspaces.length,
          seq: 0,
        };
        const defaultCol: Collection = {
          id: generateId(),
          workspaceId: ws.id,
          name: "Default",
          icon: "inbox",
          position: 0,
          isDefault: true,
          seq: 0,
        };
        const nextActiveId = state.workspaces.length === 0 ? ws.id : state.activeWorkspaceId;
        set({
          workspaces: [...state.workspaces, ws],
          collections: [...state.collections, defaultCol],
          activeWorkspaceId: nextActiveId,
        });
        idbPut("workspaces", ws);
        idbPut("collections", defaultCol);
        if (state.workspaces.length === 0) {
          idbPut("kv", { key: "activeWorkspaceId", value: ws.id });
        }
        syncEngine?.enqueue({ workspaces: [toServerWorkspace(ws)], collections: [toServerCollection(defaultCol)] });
        return ws;
      },
```

Replace `updateWorkspace`:
```ts
      updateWorkspace: (id, patch) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, ...patch } : w
          ),
        }));
        const updated = get().workspaces.find(w => w.id === id);
        if (updated) {
          idbPut("workspaces", updated);
          syncEngine?.enqueue({ workspaces: [toServerWorkspace(updated)] });
        }
      },
```

Replace `deleteWorkspace`:
```ts
      deleteWorkspace: (id) => {
        const { workspaces, collections, activeWorkspaceId } = get();
        const ws = workspaces.find(w => w.id === id);
        const colsToDelete = collections.filter(c => c.workspaceId === id);
        if (ws) {
          syncEngine?.enqueue({
            workspaces: [toServerWorkspace({ ...ws, deletedAt: Date.now() })],
            collections: colsToDelete.map(c => toServerCollection({ ...c, deletedAt: Date.now() })),
          });
        }
        idbDelete("workspaces", id);
        for (const c of colsToDelete) { idbDelete("collections", c.id); }
        const remaining = workspaces.filter(w => w.id !== id);
        const newActiveId = activeWorkspaceId === id ? (remaining[0]?.id ?? "") : activeWorkspaceId;
        if (activeWorkspaceId === id) {
          idbPut("kv", { key: "activeWorkspaceId", value: newActiveId });
        }
        set({
          workspaces: remaining,
          collections: collections.filter(c => c.workspaceId !== id),
          activeWorkspaceId: newActiveId,
        });
      },
```

- [ ] **Step 6: Add IDB writes to collection CRUD**

Replace `createCollection`:
```ts
      createCollection: (workspaceId, name, icon) => {
        const existingInWs = get().collections.filter(c => c.workspaceId === workspaceId);
        const col: Collection = {
          id: generateId(),
          workspaceId,
          name,
          icon,
          position: existingInWs.length,
          seq: 0,
        };
        set((s) => ({ collections: [...s.collections, col] }));
        idbPut("collections", col);
        syncEngine?.enqueue({ collections: [toServerCollection(col)] });
        return col;
      },
```

Replace `updateCollection`:
```ts
      updateCollection: (id, patch) => {
        set((s) => ({
          collections: s.collections.map((c) =>
            c.id === id ? { ...c, ...patch } : c
          ),
        }));
        const updated = get().collections.find(c => c.id === id);
        if (updated) {
          idbPut("collections", updated);
          syncEngine?.enqueue({ collections: [toServerCollection(updated)] });
        }
      },
```

Replace `deleteCollection`:
```ts
      deleteCollection: (id) => {
        const col = get().collections.find(c => c.id === id && !c.isDefault);
        if (!col) { return; }
        const defaultCol = get().collections.find(c => c.workspaceId === col.workspaceId && !!c.isDefault);
        const targetId = defaultCol?.id ?? "";
        syncEngine?.enqueue({ collections: [toServerCollection({ ...col, deletedAt: Date.now() })] });
        useBookmarksStore.getState().reassignCollection(id, targetId);
        idbDelete("collections", id);
        set((s) => ({
          collections: s.collections.filter(c => c.id !== id || !!c.isDefault),
        }));
      },
```

- [ ] **Step 7: Add IDB writes to tag CRUD**

Replace `createTag`:
```ts
      createTag: (name, color) => {
        const tag: Tag = { id: generateId(), name, color, seq: 0 };
        set((s) => ({ tags: [...s.tags, tag] }));
        idbPut("tags", tag);
        syncEngine?.enqueue({ tags: [toServerTag(tag)] });
        return tag;
      },
```

Replace `updateTag`:
```ts
      updateTag: (id, patch) => {
        set((s) => ({
          tags: s.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        }));
        const updated = get().tags.find(t => t.id === id);
        if (updated) {
          idbPut("tags", updated);
          syncEngine?.enqueue({ tags: [toServerTag(updated)] });
        }
      },
```

Replace `deleteTag`:
```ts
      deleteTag: (id) => {
        const tag = get().tags.find(t => t.id === id);
        if (tag) { syncEngine?.enqueue({ tags: [toServerTag({ ...tag, deletedAt: Date.now() })] }); }
        idbDelete("tags", id);
        set((s) => ({ tags: s.tags.filter((t) => t.id !== id) }));
      },
```

- [ ] **Step 8: Add IDB sync to `mergeFromServer`**

After the final `return { workspaces, collections, tags, activeWorkspaceId };` and the closing `});` of the `set()` call inside `mergeFromServer`, add:

```ts
        // Sync IDB after Zustand state update (fire-and-forget)
        const state = get();
        for (const w of state.workspaces) { idbPut("workspaces", w); }
        for (const c of state.collections) { idbPut("collections", c); }
        for (const t of state.tags) { idbPut("tags", t); }
        for (const sw of resp.entities.workspaces) {
          if (sw.deleted_at) { idbDelete("workspaces", sw.id); }
        }
        for (const sc of resp.entities.collections) {
          if (sc.deleted_at) { idbDelete("collections", sc.id); }
        }
        for (const st of resp.entities.tags) {
          if (st.deleted_at) { idbDelete("tags", st.id); }
        }
```

Note: the early-return branch (`if (sw.length === 0 && sc.length === 0 && st.length === 0)`) returns before this block, so it only runs when there are actual entity changes.

- [ ] **Step 9: Delete the `chrome.storage.onChanged` block**

Delete the entire block at the bottom of the file (lines 451–479):

```ts
// ---------------------------------------------------------------------------
// Keep popup in sync with workspace changes
// ---------------------------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  ...
});
```

- [ ] **Step 10: Type-check**

Run: `bun run compile`
Expected: no errors

- [ ] **Step 11: Commit**

```bash
git add store/workspace-store.ts
git commit -m "feat(workspace-store): replace chrome.storage persist with IndexedDB record writes"
```

---

## Task 5: Migrate `store/groups-store.ts`

**Files:**
- Modify: `store/groups-store.ts`

- [ ] **Step 1: Replace imports**

Remove:
```ts
import { persist, createJSONStorage } from "zustand/middleware";
import { chromeStorageAdapter } from "@/lib/chrome-storage-adapter";
```

Add:
```ts
import { idbGetAll, idbPut, idbDelete, idbGetByIndex } from "@/lib/idb";
```

- [ ] **Step 2: Update the `GroupsState` interface**

Add `hydrate` action (the interface already has `_hydrated: boolean`):

```ts
  _hydrated: boolean;
  hydrate: () => Promise<void>;
```

- [ ] **Step 3: Remove `persist()` wrapper and add `hydrate()`**

Change `create<GroupsState>()(persist((set, get) => ({` to `create<GroupsState>()((set, get) => ({`.

Replace `_hydrated: false,` with:

```ts
      _hydrated: false,
      hydrate: async () => {
        const [groups, groupTabs] = await Promise.all([
          idbGetAll<SavedGroup>("groups"),
          idbGetAll<GroupTab>("group-tabs"),
        ]);
        set({ groups, groupTabs, _hydrated: true });
      },
```

Remove the persist config object (containing `name: "tabslate-groups"`, `storage:`, `partialize:`, `onRehydrateStorage:`) and the closing brackets of `persist()`.

- [ ] **Step 4: Add IDB writes to `createGroup`**

Replace:
```ts
      createGroup: (name, color, isCompact) => {
        const id = generateId();
        set((state) => ({
          groups: [
            ...state.groups,
            { id, name, color, isCompact, createdAt: new Date().toISOString() },
          ],
        }));
        return id;
      },
```

With:
```ts
      createGroup: (name, color, isCompact) => {
        const id = generateId();
        const group: SavedGroup = { id, name, color, isCompact, createdAt: new Date().toISOString() };
        set((state) => ({ groups: [...state.groups, group] }));
        idbPut("groups", group);
        return id;
      },
```

- [ ] **Step 5: Add IDB writes to `updateGroup`**

Replace:
```ts
      updateGroup: (id, patch) => {
        set((state) => ({
          groups: state.groups.map((g) =>
            g.id === id ? { ...g, ...patch } : g
          ),
        }));
      },
```

With:
```ts
      updateGroup: (id, patch) => {
        set((state) => ({
          groups: state.groups.map((g) =>
            g.id === id ? { ...g, ...patch } : g
          ),
        }));
        const updated = get().groups.find(g => g.id === id);
        if (updated) { idbPut("groups", updated); }
      },
```

- [ ] **Step 6: Add IDB writes to `deleteGroup`**

Replace:
```ts
      deleteGroup: (id) => {
        set((state) => ({
          groups: state.groups.filter((g) => g.id !== id),
          groupTabs: state.groupTabs.filter((t) => t.groupId !== id),
        }));
      },
```

With:
```ts
      deleteGroup: async (id) => {
        const tabsToDelete = await idbGetByIndex<GroupTab>("group-tabs", "groupId", id);
        idbDelete("groups", id);
        for (const t of tabsToDelete) { idbDelete("group-tabs", t.id); }
        set((state) => ({
          groups: state.groups.filter((g) => g.id !== id),
          groupTabs: state.groupTabs.filter((t) => t.groupId !== id),
        }));
      },
```

Note: `deleteGroup` becomes async. Update its signature in the `GroupsState` interface:
```ts
  deleteGroup: (id: string) => Promise<void>;
```

- [ ] **Step 7: Add IDB writes to tab management actions**

Replace `addTabToGroup`:
```ts
      addTabToGroup: (groupId, tab) => {
        const { groupTabs } = get();
        const existing = groupTabs.find(
          (t) => t.groupId === groupId && t.url === tab.url
        );
        if (existing) { return; }
        const position = groupTabs.filter((t) => t.groupId === groupId).length;
        const newTab: GroupTab = { id: generateId(), groupId, ...tab, position };
        set((state) => ({
          groupTabs: [...state.groupTabs, newTab],
        }));
        idbPut("group-tabs", newTab);
      },
```

Replace `removeTabFromGroup`:
```ts
      removeTabFromGroup: (tabId) => {
        idbDelete("group-tabs", tabId);
        set((state) => ({
          groupTabs: state.groupTabs.filter((t) => t.id !== tabId),
        }));
      },
```

Replace `moveTab`:
```ts
      moveTab: (tabId, toGroupId) => {
        set((state) => {
          const tab = state.groupTabs.find((t) => t.id === tabId);
          if (!tab) { return {}; }
          const position = state.groupTabs.filter(
            (t) => t.groupId === toGroupId
          ).length;
          return {
            groupTabs: state.groupTabs.map((t) =>
              t.id === tabId ? { ...t, groupId: toGroupId, position } : t
            ),
          };
        });
        const moved = get().groupTabs.find(t => t.id === tabId);
        if (moved) { idbPut("group-tabs", moved); }
      },
```

- [ ] **Step 8: Delete the `chrome.storage.onChanged` block**

Delete the entire block at the bottom of the file (lines 143–166):

```ts
// ---------------------------------------------------------------------------
// Keep UI in sync across different windows/tabs
// ---------------------------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  ...
});
```

- [ ] **Step 9: Type-check**

Run: `bun run compile`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add store/groups-store.ts
git commit -m "feat(groups-store): replace chrome.storage persist with IndexedDB record writes"
```

---

## Task 6: Migrate `store/tabs-store.ts`

**Files:**
- Modify: `store/tabs-store.ts`

Replace all `chrome.storage.local` reads/writes for `tabslate-full-titles` with IDB calls, and fix the `dissolveGroup` stale-entry leak.

- [ ] **Step 1: Add IDB import**

Add at the top of the file (after the existing imports):
```ts
import { idbGetAll, idbPut, idbDelete } from "@/lib/idb";
```

- [ ] **Step 2: Replace `loadTabs`**

Replace:
```ts
  loadTabs: async (silent = false) => {
    if (!silent) { set({ isLoading: true }); }
    const [tabs, groups, storage] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
      chrome.storage.local.get("tabslate-full-titles"),
    ]);
    const fullTitles = (storage["tabslate-full-titles"] || {}) as Record<number, string>;
    set({ openTabs: tabs, tabGroups: groups, fullTitles, isLoading: false });
  },
```

With:
```ts
  loadTabs: async (silent = false) => {
    if (!silent) { set({ isLoading: true }); }
    const [tabs, groups, titleEntries] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
      idbGetAll<{ groupId: number; title: string }>("tab-group-titles"),
    ]);
    const fullTitles = titleEntries.reduce<Record<number, string>>(
      (acc, e) => { acc[e.groupId] = e.title; return acc; },
      {},
    );
    set({ openTabs: tabs, tabGroups: groups, fullTitles, isLoading: false });
  },
```

- [ ] **Step 3: Replace `createGroup` full-title storage**

Find the line:
```ts
    await chrome.storage.local.set({ "tabslate-full-titles": currentTitles });
```
inside `createGroup` and replace it with:
```ts
    idbPut("tab-group-titles", { groupId, title: fullTitle });
```

- [ ] **Step 4: Replace `updateGroup` full-title storage**

Find inside `updateGroup`:
```ts
      const nextFullTitles = { ...fullTitles, [groupId]: patch.title };
      await chrome.storage.local.set({ "tabslate-full-titles": nextFullTitles });
```

Replace with:
```ts
      const nextFullTitles = { ...fullTitles, [groupId]: patch.title };
      idbPut("tab-group-titles", { groupId, title: patch.title });
```

- [ ] **Step 5: Fix `dissolveGroup` — add IDB cleanup (bug fix)**

Replace:
```ts
  dissolveGroup: async (groupId) => {
    const { openTabs } = get();
    const tabIds = openTabs.filter((t) => t.groupId === groupId).map((t) => t.id);
    if (tabIds.length) { await ungroupTabs(tabIds); }
    // Reload
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups });
  },
```

With:
```ts
  dissolveGroup: async (groupId) => {
    const { openTabs } = get();
    const tabIds = openTabs.filter((t) => t.groupId === groupId).map((t) => t.id);
    if (tabIds.length) { await ungroupTabs(tabIds); }
    idbDelete("tab-group-titles", groupId);
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups, fullTitles: { ...get().fullTitles, [groupId]: undefined } as Record<number, string> });
  },
```

Actually, use a cleaner deletion from the in-memory map:

```ts
  dissolveGroup: async (groupId) => {
    const { openTabs, fullTitles } = get();
    const tabIds = openTabs.filter((t) => t.groupId === groupId).map((t) => t.id);
    if (tabIds.length) { await ungroupTabs(tabIds); }
    idbDelete("tab-group-titles", groupId);
    const updatedTitles = { ...fullTitles };
    delete updatedTitles[groupId];
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups, fullTitles: updatedTitles });
  },
```

- [ ] **Step 6: Replace `openCollectionAsGroup` full-title storage**

Find inside `openCollectionAsGroup`:
```ts
    const currentTitles = { ...get().fullTitles, [groupId]: fullTitle };
    await chrome.storage.local.set({ "tabslate-full-titles": currentTitles });
```

Replace with:
```ts
    const currentTitles = { ...get().fullTitles, [groupId]: fullTitle };
    idbPut("tab-group-titles", { groupId, title: fullTitle });
```

- [ ] **Step 7: Replace `toggleGroupCompact` full-title storage**

Replace the entire `toggleGroupCompact` action:
```ts
  toggleGroupCompact: async (groupId: number) => {
    const { tabGroups, fullTitles } = get();
    const group = tabGroups.find((g) => g.id === groupId);
    if (!group) { return; }

    let storedFullTitle = fullTitles[groupId];
    if (!storedFullTitle && group.title.length > 1) {
      storedFullTitle = group.title;
    }

    const currentFullTitle = storedFullTitle || group.title;
    const isCurrentlyCompact = group.title.length === 1 && currentFullTitle.length > 1;
    const nextTitle = isCurrentlyCompact ? currentFullTitle : (currentFullTitle[0] || "");

    await updateGroup(groupId, { title: nextTitle });

    const updatedTitles = { ...fullTitles };
    if (!updatedTitles[groupId]) { updatedTitles[groupId] = currentFullTitle; }
    idbPut("tab-group-titles", { groupId, title: updatedTitles[groupId] });

    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups, fullTitles: updatedTitles });
  },
```

- [ ] **Step 8: Type-check**

Run: `bun run compile`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add store/tabs-store.ts
git commit -m "feat(tabs-store): replace chrome.storage full-titles with IndexedDB; fix dissolveGroup leak"
```

---

## Task 7: Update `entrypoints/newtab/App.tsx`

**Files:**
- Modify: `entrypoints/newtab/App.tsx`

Two changes: (a) `StoreGate` runs migration then parallel hydrations before rendering; (b) the message listener in `App` handles `BOOKMARKS_CHANGED`, `WORKSPACE_CHANGED`, `TABS_CHANGED`.

- [ ] **Step 1: Add new imports**

Add to the existing imports at the top:
```ts
import { useGroupsStore } from "@/store/groups-store";
import { useTabsStore } from "@/store/tabs-store";
import { migrateFromChromeStorage } from "@/lib/idb";
import type { ExtensionMessage } from "@/lib/messages";
```

- [ ] **Step 2: Replace `StoreGate`**

Replace the entire `StoreGate` function:

```ts
/** Runs one-time storage migration then hydrates all stores from IndexedDB before rendering */
function StoreGate({ children }: { children: React.ReactNode }) {
  const bookmarksHydrated = useBookmarksStore((s) => s._hydrated);
  const workspaceHydrated = useWorkspaceStore((s) => s._hydrated);
  const authHydrated = useAuthStore((s) => s._hydrated);
  const groupsHydrated = useGroupsStore((s) => s._hydrated);

  useEffect(() => {
    migrateFromChromeStorage().then(() =>
      Promise.all([
        useBookmarksStore.getState().hydrate(),
        useWorkspaceStore.getState().hydrate(),
        useGroupsStore.getState().hydrate(),
      ]),
    );
  }, []);

  const hydrated = bookmarksHydrated && workspaceHydrated && authHydrated && groupsHydrated;

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center h-svh bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
```

- [ ] **Step 3: Extend the message listener in `App`**

Replace the `useEffect` in `App` that registers the message listener:

```ts
  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      if (message.type === "ADD_BOOKMARK") {
        useBookmarksStore.getState().addBookmark(message.data);
      }
      if (message.type === "BOOKMARKS_CHANGED") {
        useBookmarksStore.getState().hydrate();
      }
      if (message.type === "WORKSPACE_CHANGED") {
        useWorkspaceStore.getState().hydrate();
      }
      if (message.type === "TABS_CHANGED") {
        useTabsStore.getState().loadTabs();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
```

- [ ] **Step 4: Remove the old `type` annotation on the listener parameter**

The old listener had:
```ts
const listener = (message: { type: string; data: Omit<Bookmark, "id" | "createdAt" | "isFavorite"> }) => {
```

The new version above uses `ExtensionMessage`. Also remove the `import type { Bookmark }` import if it is now unused (check — it may still be used elsewhere; if not, remove it).

- [ ] **Step 5: Type-check**

Run: `bun run compile`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add entrypoints/newtab/App.tsx
git commit -m "feat(App): StoreGate runs IDB hydration; message listener handles BOOKMARKS/WORKSPACE/TABS_CHANGED"
```

---

## Task 8: Update `entrypoints/background.ts`

**Files:**
- Modify: `entrypoints/background.ts`

Two changes: (a) the `ADD_BOOKMARK` fallback writes to IDB instead of `chrome.storage`; (b) `broadcastTabChange` sends `TABS_CHANGED` via `tabs.sendMessage` instead of writing to `chrome.storage`.

- [ ] **Step 1: Add imports**

Add at the top of the file:
```ts
import { idbPut } from "@/lib/idb";
import type { ExtensionMessage } from "@/lib/messages";
```

- [ ] **Step 2: Replace the fallback `ADD_BOOKMARK` path**

Replace the fallback block (currently reads/parses/writes `tabslate-bookmarks` in chrome.storage):

```ts
    // Fallback: write directly to storage (seq=0 sweep will sync on next newtab open)
    const fullBookmark = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      isFavorite: false,
      ...bookmarkData,
    };

    const raw = await new Promise<string | null>((resolve) =>
      chrome.storage.local.get("tabslate-bookmarks", (res) =>
        resolve((res["tabslate-bookmarks"] as string) ?? null)
      )
    );

    let state: { bookmarks?: typeof fullBookmark[] } = {};
    if (raw) {
      try { state = JSON.parse(raw)?.state ?? {}; } catch { /* ignore */ }
    }

    const updated = [fullBookmark, ...(state.bookmarks ?? [])];
    const newRaw = JSON.stringify({ state: { ...state, bookmarks: updated } });
    await new Promise<void>((r) =>
      chrome.storage.local.set({ "tabslate-bookmarks": newRaw }, r)
    );
```

With:

```ts
    // Fallback: write directly to IDB (hydrate() will pick it up on next newtab open)
    const fullBookmark = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      isFavorite: false,
      ...bookmarkData,
    };
    await idbPut("bookmarks", fullBookmark);
    // If newtab is open but wasn't ready for ADD_BOOKMARK, notify it now
    if (newtabTab?.id) {
      chrome.tabs.sendMessage(newtabTab.id, { type: "BOOKMARKS_CHANGED" } as ExtensionMessage).catch(() => {});
    }
```

- [ ] **Step 3: Replace `broadcastTabChange`**

Replace:
```ts
  function broadcastTabChange() {
    chrome.storage.local.set({ "tabslate-tabs-changed": Date.now() });
  }
```

With:
```ts
  async function broadcastTabChange() {
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("newtab.html") });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "TABS_CHANGED" } as ExtensionMessage).catch(() => {});
      }
    }
  }
```

- [ ] **Step 4: Type-check**

Run: `bun run compile`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat(background): IDB fallback for ADD_BOOKMARK; broadcastTabChange via tabs.sendMessage"
```

---

## Task 9: Fix `lib/sse-client.ts` — atomic IDB leader election

**Files:**
- Modify: `lib/sse-client.ts`

Replace the non-atomic `chrome.storage.local` read-check-write in `tryClaimLeader` with an atomic IDB `readwrite` transaction. Update `startHeartbeat` and `destroy` to use IDB.

- [ ] **Step 1: Replace imports and remove `LEADER_KEY` constant**

Remove:
```ts
const LEADER_KEY = "tabslate-sync-leader";
```

Add at the top of the file:
```ts
import { getDB, idbPut, idbDelete } from "@/lib/idb";
```

- [ ] **Step 2: Replace `tryClaimLeader`**

Replace:
```ts
  private tryClaimLeader(): Promise<boolean> {
    return new Promise(resolve => {
      chrome.storage.local.get(LEADER_KEY, result => {
        const entry = result[LEADER_KEY] as { ts: number } | undefined;
        const now = Date.now();
        if (entry && now - entry.ts < LEADER_TTL_MS) {
          resolve(false);
          return;
        }
        chrome.storage.local.set({ [LEADER_KEY]: { ts: now } }, () => resolve(true));
      });
    });
  }
```

With:
```ts
  private tryClaimLeader(): Promise<boolean> {
    return getDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(["kv"], "readwrite");
          const store = tx.objectStore("kv");
          const req = store.get("sync-leader");
          req.onsuccess = () => {
            const entry = (
              req.result as { key: string; value: { ts: number } } | undefined
            )?.value;
            const now = Date.now();
            if (entry && now - entry.ts < LEADER_TTL_MS) {
              resolve(false);
              return;
            }
            store.put({ key: "sync-leader", value: { ts: now } });
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        }),
    );
  }
```

- [ ] **Step 3: Replace `startHeartbeat`**

Replace:
```ts
  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      chrome.storage.local.set({ [LEADER_KEY]: { ts: Date.now() } });
    }, HEARTBEAT_INTERVAL_MS);
  }
```

With:
```ts
  private startHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); }
    this.heartbeatTimer = setInterval(() => {
      idbPut("kv", { key: "sync-leader", value: { ts: Date.now() } });
    }, HEARTBEAT_INTERVAL_MS);
  }
```

- [ ] **Step 4: Replace leader cleanup in `destroy`**

Replace:
```ts
    if (this.isLeader) {
      chrome.storage.local.remove(LEADER_KEY);
    }
```

With:
```ts
    if (this.isLeader) {
      idbDelete("kv", "sync-leader");
    }
```

- [ ] **Step 5: Type-check**

Run: `bun run compile`
Expected: no errors

- [ ] **Step 6: Full build**

Run: `bun run build`
Expected: build completes with no errors

- [ ] **Step 7: Commit**

```bash
git add lib/sse-client.ts
git commit -m "feat(sse-client): atomic IDB transaction for leader election, replaces chrome.storage race"
```

---

## Manual Verification Checklist

After all tasks complete, load the unpacked extension in Chrome (`chrome://extensions` → Load unpacked → select `dist/`):

- [ ] Open a new tab — dashboard loads without spinner staying indefinitely
- [ ] Add a bookmark — appears immediately; reload the page and verify it persists
- [ ] Archive/trash/restore a bookmark — verify correct IDB store via DevTools → Application → IndexedDB → `tabslate-db`
- [ ] Create a workspace and collection — verify in IDB `workspaces` / `collections` stores
- [ ] Open the extension in two tabs simultaneously — verify sync propagation via `WORKSPACE_CHANGED` / `BOOKMARKS_CHANGED` messages
- [ ] Right-click a page → "Save to TabSlate" with the new tab closed — open new tab, verify bookmark appears (fallback IDB write + hydrate)
- [ ] Create a tab group, add a title — verify `tab-group-titles` store; dissolve group — verify entry removed
- [ ] Verify `chrome.storage.local` in DevTools shows only `tabslate-auth` remains after first load (old keys cleaned up by migration)
