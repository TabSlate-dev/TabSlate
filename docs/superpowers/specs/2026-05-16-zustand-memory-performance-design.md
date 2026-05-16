# Zustand Memory & Performance Optimization — Design Spec

Date: 2026-05-16
Status: Approved

## Background

TabSlate loads all bookmark data (active + archived + trashed) into memory at startup and keeps it there indefinitely. Users with large libraries experience two symptoms: high memory usage that grows over time, and slow bulk operations (archive/delete collection). This spec covers four groups of improvements that together reduce memory by 50–70% and make bulk IDB operations 5–10× faster.

---

## Section 1 — Memory: Lazy Loading + Trash Expiry

### 1a. Split `hydrate()` into eager and lazy buckets

**Problem:** `bookmarks-store.hydrate()` loads all three IDB stores simultaneously — `bookmarks`, `archived-bookmarks`, `trashed-bookmarks`. Archived and trashed data is only needed when the user navigates to `/archive` or `/trash`, but it is always loaded at startup and kept in memory indefinitely.

Additionally, the `BOOKMARKS_CHANGED` message handler in `App.tsx` calls `hydrate()`, which reloads all three buckets even when only the active bookmarks store changed (the background context-menu fallback path only writes to `bookmarks`).

**Design:**

`bookmarks-store` gains two new lazy loaders and two new flags:

```ts
// New state fields
_archivedLoaded: boolean   // false until loadArchivedBookmarks() is called
_trashedLoaded: boolean    // false until loadTrashedBookmarks() is called

// New actions
loadArchivedBookmarks(): Promise<void>   // reads archived-bookmarks IDB store
loadTrashedBookmarks(): Promise<void>    // reads trashed-bookmarks IDB store, applies grace-period filter
```

`hydrate()` is narrowed to load only `bookmarks` (active), setting `_hydrated: true`. The two new loaders each set their own flag and are idempotent (no-op if already loaded).

`ArchiveContent` calls `loadArchivedBookmarks()` on mount (inside a `useEffect`). `TrashContent` calls `loadTrashedBookmarks()` on mount.

`BOOKMARKS_CHANGED` handler in `App.tsx` is changed to call a new internal action `_reloadActive()` that reads only the `bookmarks` IDB store and replaces `state.bookmarks` — it does not touch `archivedBookmarks` or `trashedBookmarks`.

`mergeFromServer` in `bookmarks-store` is updated to skip in-memory updates for archived/trashed buckets when the corresponding flag is false:

```ts
archivedBookmarks: _archivedLoaded
  ? [...state.archivedBookmarks.filter(b => !touchedIds.has(b.id)), ...toArchived]
  : state.archivedBookmarks,   // return same ref — do NOT append toArchived to empty []
```

It still writes to IDB (fire-and-forget), so the data is fresh when the view is eventually opened. Returning the original reference (rather than appending to the empty initial array) prevents the Archive view from showing only the sync-arrived subset instead of the full IDB contents.

### 1b. Auto-clean expired trash entries (B4)

**Problem:** `PlanLimits.trash_grace_days` is fetched but never used. Trashed bookmarks accumulate in memory and IDB indefinitely.

**Problem (secondary):** `trashBookmark` and `trashCollectionBookmarks` do not set `deletedAt` on the bookmark before writing it to `trashed-bookmarks`, so there is no timestamp available for expiry calculations.

**Design:**

Fix the data gap first: `trashBookmark` and `trashCollectionBookmarks` set `deletedAt = Date.now()` on the bookmark object before calling `idbPut("trashed-bookmarks", ...)` and enqueueing to sync.

`loadTrashedBookmarks()` applies an expiry filter before updating state:

```ts
const graceDays = usePlanStore.getState().limits?.trash_grace_days ?? 30;
const cutoff = Date.now() - graceDays * 86_400_000;
const fresh = all.filter(b => !b.deletedAt || b.deletedAt > cutoff);
const expired = all.filter(b => b.deletedAt && b.deletedAt <= cutoff);
// For expired entries: idbDelete + syncEngine.enqueue({ is_trashed: 2 }) — fire-and-forget
```

After `fetchPlan()` resolves successfully, if `_trashedLoaded === true`, a pruning pass runs on the in-memory `trashedBookmarks` array using the same cutoff logic.

---

## Section 2 — Performance: Batch IDB Writes

### 2a. New `idbBulkTransfer` helper (P1)

**Problem:** The four collection-level bookmark operations (`trashCollectionBookmarks`, `archiveCollectionBookmarks`, `restoreCollectionBookmarks`, `permanentlyDeleteCollectionBookmarks`) loop over individual `idbPut`/`idbDelete` calls. Each call opens a new IDB transaction. Archiving a collection with 200 bookmarks creates 400 transactions.

`idb.ts` already has `idbTransaction` but it only targets a single store. A new helper is needed for multi-store atomic operations:

```ts
export function idbBulkTransfer(
  stores: StoreName[],
  ops: (tx: IDBTransaction) => void,
): Promise<void>
```

This wraps `idbTransaction` for multi-store readwrite access. All four collection-level methods are rewritten to issue all their `delete` and `put` requests inside a single `idbBulkTransfer` call.

### 2b. Merge enqueue calls in bulk operations (P2)

**Problem:** `permanentlyDeleteCollectionBookmarks` calls `syncEngine.enqueue()` once per bookmark inside a loop, resetting the SyncQueue debounce timer N times.

**Fix:** Replace the loop with a single `syncEngine.enqueue({ bookmarks: all.map(...) })` call. The other three collection-level methods already enqueue in one call and are unchanged.

### 2c. O(n×m) → O(n+m) in groups sync helpers (C5)

**Problem:** `sweepUnsynced` and `enqueueAllToSync` in `groups-store` call `groupTabs.filter(t => t.groupId === g.id)` inside a `map` over groups — O(n×m) with n groups and m total tabs.

**Fix:** Extract a private `buildTabsByGroup()` helper used by both methods:

```ts
function buildTabsByGroup(groupTabs: GroupTab[]): Map<string, GroupTab[]> {
  const map = new Map<string, GroupTab[]>();
  for (const t of groupTabs) {
    const bucket = map.get(t.groupId) ?? [];
    bucket.push(t);
    map.set(t.groupId, bucket);
  }
  return map;
}
```

Both `sweepUnsynced` and `enqueueAllToSync` call `buildTabsByGroup(get().groupTabs)` once and do O(1) lookups.

---

## Section 3 — Backend: `isDefault` Invariant

### Problem

`workspace-store` has two copies of logic that ensure every workspace has a default collection:

1. `hydrate()` lines 188–203: creates missing default collections in IDB if none found locally
2. `mergeFromServer` lines 362–371: scans all collections after every pull and promotes the lowest-position active collection to `isDefault: true` if none is already marked

This is repairing a server-side invariant on the client, in two places.

### Backend change (TabSlate-server)

Add `is_default: bool` as a computed field on `ServerCollection` in the pull response. The server calculates it at query time: for each workspace, the active collection (`deleted_at IS NULL AND archived_at IS NULL`) with the lowest `position` value receives `is_default: true`. No new database column is required.

### Frontend changes

`ServerCollection` in `lib/api.ts` gains `is_default?: boolean`.

In `mergeFromServer`, when upserting a collection:
```ts
collections[idx] = { ...local, ..., isDefault: sc.is_default ?? false };
```

The repair block in `mergeFromServer` (lines 362–371) is deleted.

The `hydrate()` repair block (lines 188–203) is replaced with a lightweight local fallback for offline cold-start: if after loading IDB data a workspace has no `isDefault: true` collection, the collection with the lowest `position` is flagged temporarily. This flag is overwritten on the next pull.

---

## Section 4 — Code Quality

### 4a. `guardQuota` helper (C2)

**Problem:** Six `create*` actions across three stores repeat the same three-line quota pattern.

**Design:** Export a pure helper from `plan-store.ts`:

```ts
export function guardQuota<T>(
  resource: QuotaResource,
  currentCount: number,
  fallback: T,
  action: () => T,
): T {
  const store = usePlanStore.getState();
  store.ensureFresh();
  if (!store.checkQuota(resource, currentCount)) {
    store.showQuotaAlert(resource);
    return fallback;
  }
  return action();
}
```

Applied at: `addBookmark`, `addBookmarks`, `createWorkspace`, `createCollection`, `createTag`, `createGroup`. No behavior changes.

### 4b. Stable array references in `mergeFromServer` (P3)

**Problem:** Every `mergeFromServer` call returns new array references even when no bookmarks changed, causing `filteredBookmarks` useMemo in `content.tsx` to recompute.

**Design:** After building `newActive`, compare it to `state.bookmarks` by reference equality before returning:

```ts
const changed = newActive.length !== state.bookmarks.length ||
  newActive.some((b, i) => b !== state.bookmarks[i]);
return {
  bookmarks: changed ? newActive : state.bookmarks,
  // same pattern for archivedBookmarks and trashedBookmarks
};
```

Reference comparison is O(n) pointer checks with no allocation. When a pull response touches only other entities (workspaces, tags), the bookmark arrays are returned unchanged and downstream useMemos do not re-run.

---

## File Change Summary

| File | Changes |
|---|---|
| `store/bookmarks-store.ts` | Split `hydrate`, add `loadArchivedBookmarks`/`loadTrashedBookmarks`, fix `deletedAt` on trash, lazy merge, stable refs, `guardQuota`, batch enqueue |
| `store/workspace-store.ts` | Remove two `isDefault` repair blocks, read `sc.is_default`, lightweight offline fallback in `hydrate`, `guardQuota` |
| `store/groups-store.ts` | `buildTabsByGroup` helper, `guardQuota` |
| `store/plan-store.ts` | Export `guardQuota` function |
| `lib/idb.ts` | Add `idbBulkTransfer` |
| `lib/api.ts` | `ServerCollection.is_default?: boolean` |
| `entrypoints/newtab/App.tsx` | `BOOKMARKS_CHANGED` handler calls `_reloadActive` |
| `components/dashboard/archive-content.tsx` | Mount effect calls `loadArchivedBookmarks()` |
| `components/dashboard/trash-content.tsx` | Mount effect calls `loadTrashedBookmarks()` |
| `TabSlate-server` | `is_default` computed field on collection pull response |

## Non-Goals

- Bookmark pagination / server-side search (reserved for a future spec)
- Removing soft-deleted collections from the `collections` array (collections are few in number; impact is low)
- IDB `collectionId` index usage (only valuable alongside pagination)
