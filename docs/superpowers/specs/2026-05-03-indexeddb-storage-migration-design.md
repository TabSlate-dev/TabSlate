# IndexedDB Storage Migration Design

**Date:** 2026-05-03
**Status:** Approved

## Problem

TabSlate currently uses `chrome.storage.local` for all persistence, which has a hard **10MB quota**. Two specific issues:

1. **Write amplification**: Every mutation to any bookmark serializes the entire `{bookmarks[], archivedBookmarks[], trashedBookmarks[]}` blob into one JSON string and rewrites it to storage. A single title edit on one active bookmark rewrites thousands of archived/trashed entries.
2. **Unbounded growth**: `archivedBookmarks` and `trashedBookmarks` grow indefinitely (no bulk clear). On first sync from a new device, the server pushes all historical data into these arrays. A power user with thousands of archived/trashed bookmarks can realistically approach the 10MB cap.

Secondary issues:
- `tabslate-full-titles` (tab group title map) leaks stale entries when groups are dissolved — no cleanup on `dissolveGroup`.
- `tryClaimLeader` in `SSEClient` has a non-atomic read-check-write, causing a race condition when multiple tabs simultaneously try to claim SSE leadership.

## Solution

Replace `chrome.storage.local` (except for `tabslate-auth`) with **IndexedDB**, using record-level storage. Each entity is stored as an individual record rather than a serialized blob. This eliminates the size cap and write amplification in one change.

`chrome.storage.onChanged` (currently used as a cross-context message bus) is replaced with `chrome.runtime.sendMessage`.

## Architecture

```
Before:
  Zustand store → persist middleware → chromeStorageAdapter → chrome.storage.local (10MB cap)
                  entire state as one JSON string

After:
  Zustand store → manual CRUD actions → idb.ts → IndexedDB (no size limit)
                  one record per entity, incremental writes
```

**`chrome.storage.local` is kept only for `tabslate-auth`** (small, fixed-size, reliable cross-context access needed by background service worker).

**New files:**
- `lib/idb.ts` — sole IndexedDB access layer
- `lib/messages.ts` — cross-context message type definitions

## Database Schema

Database name: `tabslate-db`, version: `1`

| Object Store | keyPath | Indexes | Replaces |
|---|---|---|---|
| `bookmarks` | `id` | `collectionId`, `isFavorite` | `tabslate-bookmarks → bookmarks[]` |
| `archived-bookmarks` | `id` | `collectionId` | `tabslate-bookmarks → archivedBookmarks[]` |
| `trashed-bookmarks` | `id` | — | `tabslate-bookmarks → trashedBookmarks[]` |
| `workspaces` | `id` | `position` | `tabslate-workspace → workspaces[]` |
| `collections` | `id` | `workspaceId`, `position` | `tabslate-workspace → collections[]` |
| `tags` | `id` | — | `tabslate-workspace → tags[]` |
| `groups` | `id` | — | `tabslate-groups → groups[]` |
| `group-tabs` | `id` | `groupId` | `tabslate-groups → groupTabs[]` |
| `tab-group-titles` | `groupId` | — | `tabslate-full-titles` |
| `kv` | `key` | — | scalar values (see below) |

**`kv` store entries:**

| key | type | replaces |
|---|---|---|
| `localSeq` | `number` | `tabslate-workspace → localSeq` |
| `activeWorkspaceId` | `string` | `tabslate-workspace → activeWorkspaceId` |
| `compactGroupTitles` | `boolean` | `tabslate-workspace → compactGroupTitles` |
| `sync-leader` | `{ ts: number }` | `tabslate-sync-leader` |

UI state (`viewMode`, `sortBy`, `filterType`) remains ephemeral — not persisted.

## `idb.ts` Public API

```ts
export async function getDB(): Promise<IDBDatabase>   // lazy singleton, auto-reconnects on SW restart

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined>
export async function idbPut<T>(store: StoreName, value: T): Promise<void>
export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void>
export async function idbGetAll<T>(store: StoreName): Promise<T[]>
export async function idbCount(store: StoreName): Promise<number>
export async function idbGetByIndex<T>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]>
export async function idbTransaction(
  stores: StoreName[],
  mode: 'readonly' | 'readwrite',
  fn: (tx: IDBTransaction) => void
): Promise<void>

export async function migrateFromChromeStorage(): Promise<void>  // one-time migration on first run
```

## Store Layer Changes

All stores except `auth-store` have their Zustand `persist` middleware removed. Each store gains a `hydrate()` action.

### Write Pattern

IDB writes are **fire-and-forget** for UI operations (Zustand state updates synchronously for instant UI response; IDB write is async persistence). `mergeFromServer` is the exception — it uses `idbTransaction` for atomicity across multiple object stores.

```ts
// Normal action — fire-and-forget
set((s) => ({ bookmarks: [...s.bookmarks, bookmark] }));
idbPut('bookmarks', bookmark);  // no await

// mergeFromServer — transactional
await idbTransaction(['bookmarks', 'archived-bookmarks', 'trashed-bookmarks'], 'readwrite', tx => {
  // bulk puts and deletes
});
set((state) => { /* sync Zustand */ });
```

### bookmarks-store

| Action | IDB Operation |
|---|---|
| `addBookmark` | `idbPut('bookmarks', bookmark)` |
| `updateBookmark` | `idbPut('bookmarks', updated)` |
| `archiveBookmark` | `idbDelete('bookmarks', id)` + `idbPut('archived-bookmarks', bookmark)` |
| `trashBookmark` | `idbDelete('bookmarks', id)` + `idbPut('trashed-bookmarks', bookmark)` |
| `restoreFromArchive` | `idbDelete('archived-bookmarks', id)` + `idbPut('bookmarks', bookmark)` |
| `restoreFromTrash` | `idbDelete('trashed-bookmarks', id)` + `idbPut('bookmarks', bookmark)` |
| `permanentlyDelete` | `idbDelete('trashed-bookmarks', id)` |
| `mergeFromServer` | `idbTransaction` across all three bookmark stores |
| `hydrate()` | `idbGetAll` × 3 → `set({ bookmarks, archivedBookmarks, trashedBookmarks, _hydrated: true })` |

### workspace-store

- Entity CRUD maps directly to `idbPut` / `idbDelete` on `workspaces`, `collections`, `tags`.
- `setLocalSeq`: `idbPut('kv', { key: 'localSeq', value: seq })`
- `setActiveWorkspaceId`: `idbPut('kv', { key: 'activeWorkspaceId', value: id })`
- `mergeFromServer`: `idbTransaction(['workspaces', 'collections', 'tags'], ...)`
- Removes the `chrome.storage.onChanged` listener entirely.
- `hydrate()`: parallel `idbGetAll` × 3 + kv reads → single `set({ ..., _hydrated: true })`

### groups-store

- Entity CRUD maps to `idbPut` / `idbDelete` on `groups` and `group-tabs`.
- `deleteGroup`: uses `idbGetByIndex('group-tabs', 'groupId', id)` to find and bulk-delete member tabs.
- `hydrate()`: `idbGetAll('groups')` + `idbGetAll('group-tabs')` → `set({ groups, groupTabs, _hydrated: true })`

### tabs-store (full-titles only)

- `createGroup` / `updateGroup` (with title): `idbPut('tab-group-titles', { groupId: number, title: string })`
- `dissolveGroup`: adds `idbDelete('tab-group-titles', groupId)` — **fixes the stale entry leak**
- Hydration in `loadTabs()`: `idbGetAll<{ groupId: number; title: string }>('tab-group-titles')` → reduce into `Record<number, string>` → `set({ fullTitles })`

### auth-store

No changes. Continues using `chrome.storage.local` via `chromeStorageAdapter`.

## Hydration

`StoreGate` gains a `useEffect` that triggers all store hydrations in parallel before rendering:

```ts
function StoreGate({ children }) {
  useEffect(() => {
    Promise.all([
      useBookmarksStore.getState().hydrate(),
      useWorkspaceStore.getState().hydrate(),
      useGroupsStore.getState().hydrate(),
    ]);
  }, []);

  const hydrated = bookmarksHydrated && workspaceHydrated && authHydrated && groupsHydrated;
  if (!hydrated) return <Spinner />;
  return <>{children}</>;
}
```

`auth-store` continues to set `_hydrated` via Zustand persist `onRehydrateStorage` — no change needed.

## Cross-Context Communication

`chrome.storage.onChanged` is replaced with `chrome.runtime.sendMessage`.

### Message Types (`lib/messages.ts`)

```ts
type ExtensionMessage =
  | { type: "BOOKMARK_ADDED";    data: Omit<Bookmark, "id" | "createdAt" | "isFavorite"> }
  | { type: "BOOKMARKS_CHANGED" }
  | { type: "WORKSPACE_CHANGED" }
  | { type: "TABS_CHANGED" }
```

### Replacement Map

| Before | After |
|---|---|
| popup writes `tabslate-bookmarks` → newtab `onChanged` | popup → `runtime.sendMessage(BOOKMARK_ADDED)` → background → `tabs.sendMessage(newtab, BOOKMARK_ADDED)` |
| workspace mutation → `onChanged("tabslate-workspace")` | newtab → `runtime.sendMessage(WORKSPACE_CHANGED)` → background broadcasts to all newtab tabs via `tabs.sendMessage`; recipients call `hydrate()` |
| background writes `tabslate-tabs-changed` | background calls `tabs.sendMessage(newtabTabId, TABS_CHANGED)` |

### `App.tsx` message listener extension

The existing `chrome.runtime.onMessage` listener (currently handles `ADD_BOOKMARK`) is extended:

```ts
if (message.type === "BOOKMARKS_CHANGED")  useBookmarksStore.getState().hydrate();
if (message.type === "WORKSPACE_CHANGED")  useWorkspaceStore.getState().hydrate();
if (message.type === "TABS_CHANGED")       useTabsStore.getState().loadTabs();
```

## SSE Leader Election Fix

`tryClaimLeader` in `sse-client.ts` is rewritten to use an IDB `readwrite` transaction, making the read-check-write atomic and eliminating the race condition that caused simultaneous multi-tab claim floods:

```ts
private tryClaimLeader(): Promise<boolean> {
  return new Promise((resolve) => {
    idbTransaction(['kv'], 'readwrite', (tx) => {
      const store = tx.objectStore('kv');
      const req = store.get('sync-leader');
      req.onsuccess = () => {
        const entry = req.result?.value as { ts: number } | undefined;
        const now = Date.now();
        if (entry && now - entry.ts < LEADER_TTL_MS) {
          resolve(false);
          return;
        }
        store.put({ key: 'sync-leader', value: { ts: now } });
        resolve(true);
      };
    });
  });
}
```

## Migration Strategy

On first run with the new code, `hydrate()` detects an empty IDB and attempts a one-time migration from `chrome.storage.local`:

1. Read old blobs from `chrome.storage.local`
2. Distribute records into the appropriate IDB object stores via a transaction
3. Remove old chrome.storage keys
4. If migration fails for any reason, proceed with empty IDB — `SyncEngine` will repopulate via server pull

No old-format reading code is kept after migration completes.

## Files Changed

| File | Change |
|---|---|
| `lib/idb.ts` | **New** — IndexedDB access layer |
| `lib/messages.ts` | **New** — cross-context message types |
| `lib/sse-client.ts` | `tryClaimLeader` rewritten to use IDB transaction |
| `lib/chrome-storage-adapter.ts` | Unchanged; only `auth-store` continues to use it |
| `store/bookmarks-store.ts` | Remove persist; add IDB writes per action; add `hydrate()` |
| `store/workspace-store.ts` | Remove persist; add IDB writes; add `hydrate()`; remove `onChanged` listener |
| `store/groups-store.ts` | Remove persist; add IDB writes; add `hydrate()` |
| `store/tabs-store.ts` | full-titles reads/writes → IDB; `dissolveGroup` deletes title entry |
| `store/auth-store.ts` | No change |
| `entrypoints/newtab/App.tsx` | `StoreGate` gains hydration effect; message listener extended |
| `entrypoints/background.ts` | Bookmark reads/writes → IDB; tabs-changed → `tabs.sendMessage` |

## Out of Scope (Deferred)

- Stopping persistence of `archivedBookmarks` and `trashedBookmarks` entirely (fetch from server on demand) — marked TODO
- Quota monitoring via `chrome.storage.getBytesInUse()`
