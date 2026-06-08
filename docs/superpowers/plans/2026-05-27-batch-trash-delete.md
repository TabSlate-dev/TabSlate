# Batch Trash Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the per-bookmark HTTP request storm triggered by "Empty Trash" and "Delete Selected" by batching permanent deletions into ≤900-entity pushes, and remove the redundant bookmark tombstone push that fires after a collection is permanently deleted.

**Architecture:** Two independent changes. (1) Add `permanentlyDeleteBatch(ids)` to the bookmarks store — collects Bookmark objects, chunks at 900, sends one `forcePush` per chunk, cleans IDB only after server confirms. (2) Strip the `syncEngine.forcePush` call from `permanentlyDeleteCollectionBookmarks` — the server already cascades `is_trashed=2` to every bookmark when it receives `collection.is_deleted=2`, so the client's second push is redundant; only the IDB cleanup needs to remain. Wire both changes into `handleEmptyTrash` and `handleBatchDelete` in the UI layer.

**Tech Stack:** TypeScript, Zustand (store), IndexedDB via `idb.ts` helpers, `syncEngine.forcePush` (lib/sync-engine.ts), WXT (build/type-check via `pnpm compile`)

---

## File map

| File | Change |
|---|---|
| `store/bookmarks-store.ts` | Add `permanentlyDeleteBatch` to interface + implementation; remove `forcePush` from `permanentlyDeleteCollectionBookmarks` |
| `components/dashboard/trash-content.tsx` | `handleEmptyTrash` and `handleBatchDelete`: replace per-bookmark loops with single `permanentlyDeleteBatch` call |

---

## Task 1: Add `permanentlyDeleteBatch` to bookmarks store

**Files:**
- Modify: `store/bookmarks-store.ts:109-167` (interface) and `store/bookmarks-store.ts:490-514` (implementation area)

### Background

The existing `permanentlyDelete(bookmarkId)` sends **one HTTP request per bookmark**. When "Empty Trash" calls it in a loop for N bookmarks, N concurrent requests are fired. The new `permanentlyDeleteBatch(ids)` method consolidates those into `⌈N/900⌉` requests.

Key constants/helpers already in the file:
- `toServerBookmark(b, { isTrashed: 2 })` — converts a `Bookmark` to the server payload shape
- `idbGetMany("trashed-bookmarks", keys)` — batch IDB read by key array
- `idbBulkWrite(ops)` — batch IDB delete
- `syncEngine.forcePush({ bookmarks: [...] })` — fires an immediate HTTP push (bypasses debounce queue)
- `usePlanStore.getState().decrementUsage("bookmark", n)` — updates quota counters

The chunk size is **900** — matching `MAX_PER_PUSH` in `lib/sync-queue.ts` and staying below the server's hard limit of 1000.

- [ ] **Step 1.1: Add the method signature to the `BookmarksState` interface**

In `store/bookmarks-store.ts`, find the interface block (around line 152) where `permanentlyDelete: (bookmarkId: string) => void;` is declared. Add the new signature immediately after it:

```typescript
  permanentlyDelete: (bookmarkId: string) => void;
  permanentlyDeleteBatch: (bookmarkIds: string[]) => void;   // ← add this line
  mergeFromServer: (resp: SyncPullResponse) => Promise<void>;
```

- [ ] **Step 1.2: Add the implementation inside the `create<BookmarksState>()` call**

Find the closing brace of the existing `permanentlyDelete` implementation (around line 513). Add `permanentlyDeleteBatch` immediately after it, before `enqueueAllToSync`:

```typescript
      permanentlyDeleteBatch: (bookmarkIds) => {
        void (async () => {
          if (bookmarkIds.length === 0) { return; }
          const state = get();

          // Collect Bookmark objects from state (fast path) or IDB (cold start).
          let bookmarks: Bookmark[];
          if (state._trashedLoaded) {
            const idSet = new Set(bookmarkIds);
            bookmarks = state.trashedBookmarks.filter((b) => idSet.has(b.id));
          } else {
            const results = await idbGetMany<Bookmark>("trashed-bookmarks", bookmarkIds);
            bookmarks = results.filter((b): b is Bookmark => b !== undefined);
          }
          if (bookmarks.length === 0) { return; }

          // Optimistic UI removal — items disappear immediately.
          const removedIds = new Set(bookmarks.map((b) => b.id));
          set((current) => ({
            trashedBookmarks: current.trashedBookmarks.filter((b) => !removedIds.has(b.id)),
          }));

          if (syncEngine) {
            const CHUNK = 900;
            for (let i = 0; i < bookmarks.length; i += CHUNK) {
              const chunk = bookmarks.slice(i, i + CHUNK);
              try {
                await syncEngine.forcePush({
                  bookmarks: chunk.map((b) => toServerBookmark(b, { isTrashed: 2 })),
                });
              } catch {
                // Push failed — roll back this chunk and stop; user can retry.
                set((current) => ({
                  trashedBookmarks: [...current.trashedBookmarks, ...chunk],
                }));
                return;
              }
            }
          }

          // Server confirmed all chunks — safe to remove from IDB.
          const ops: BulkWriteOp[] = bookmarks.map((b) => ({
            type: "delete" as const,
            store: "trashed-bookmarks" as const,
            key: b.id,
          }));
          await idbBulkWrite(ops);
          usePlanStore.getState().decrementUsage("bookmark", bookmarks.length);
        })();
      },
```

- [ ] **Step 1.3: Verify the type-check passes**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && pnpm compile
```

Expected: no TypeScript errors. If you see "Property 'permanentlyDeleteBatch' does not exist", verify the interface addition in Step 1.1 matches the implementation name exactly.

- [ ] **Step 1.4: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add store/bookmarks-store.ts
git commit -m "feat: add permanentlyDeleteBatch to bookmarks store (batches N→⌈N/900⌉ HTTP requests)"
```

---

## Task 2: Remove redundant bookmark tombstone push from `permanentlyDeleteCollectionBookmarks`

**Files:**
- Modify: `store/bookmarks-store.ts:785-818`

### Background

`permanentlyDeleteCollection` (workspace-store.ts) does:
1. Pushes the collection with `is_deleted: 2`
2. On success calls `permanentlyDeleteCollectionBookmarks(collectionId)`

Step 2 currently fires **another** `forcePush` with all the collection's bookmarks set to `is_trashed: 2`. This is redundant because the server already handles it: when it receives `collection.is_deleted = 2`, it runs:

```sql
UPDATE bookmarks SET is_trashed = 2, deleted_at = $1, seq = $2, updated_at = $1
WHERE user_id = $3 AND collection_id = $4 AND is_trashed < 2
```

(See `internal/handler/sync.go` lines 238–254.)

The client only needs to clean up its local IDB — no second push required.

- [ ] **Step 2.1: Remove the `syncEngine.forcePush` block from `permanentlyDeleteCollectionBookmarks`**

Replace the current implementation:

```typescript
      permanentlyDeleteCollectionBookmarks: (collectionId) => {
        void (async () => {
          const state = get();
          const trashed = state._trashedLoaded
            ? state.trashedBookmarks.filter((bookmark) => bookmark.collectionId === collectionId)
            : await readTrashedBookmarksForCollection(collectionId);
          const archived = state._archivedLoaded
            ? state.archivedBookmarks.filter((bookmark) => bookmark.collectionId === collectionId)
            : await readArchivedBookmarksForCollection(collectionId);
          const all = [...trashed, ...archived];
          if (all.length === 0) { return; }
          if (syncEngine) {
            try {
              await syncEngine.forcePush({ bookmarks: all.map((bookmark) => toServerBookmark(bookmark, { isTrashed: 2 })) });
            } catch {
              return; // Push failed — leave IDB intact; caller (permanentlyDeleteCollection) handles rollback.
            }
          }
          const ops: BulkWriteOp[] = [
            ...trashed.map((bookmark) => ({ type: "delete" as const, store: "trashed-bookmarks" as const, key: bookmark.id })),
            ...archived.map((bookmark) => ({ type: "delete" as const, store: "archived-bookmarks" as const, key: bookmark.id })),
          ];
          await idbBulkWrite(ops);
          set((current) => ({
            trashedBookmarks: current._trashedLoaded
              ? current.trashedBookmarks.filter((bookmark) => bookmark.collectionId !== collectionId)
              : current.trashedBookmarks,
            archivedBookmarks: current._archivedLoaded
              ? current.archivedBookmarks.filter((bookmark) => bookmark.collectionId !== collectionId)
              : current.archivedBookmarks,
          }));
          usePlanStore.getState().decrementUsage("bookmark", all.length);
        })();
      },
```

With the new version (push block removed, IDB cleanup retained):

```typescript
      permanentlyDeleteCollectionBookmarks: (collectionId) => {
        void (async () => {
          const state = get();
          const trashed = state._trashedLoaded
            ? state.trashedBookmarks.filter((bookmark) => bookmark.collectionId === collectionId)
            : await readTrashedBookmarksForCollection(collectionId);
          const archived = state._archivedLoaded
            ? state.archivedBookmarks.filter((bookmark) => bookmark.collectionId === collectionId)
            : await readArchivedBookmarksForCollection(collectionId);
          const all = [...trashed, ...archived];
          if (all.length === 0) { return; }
          // No forcePush here — the server already cascades is_trashed=2 to all
          // bookmarks in the collection when it processes is_deleted=2 on the
          // parent collection (see server sync.go cascade logic). We only need
          // to clean up the local IDB.
          const ops: BulkWriteOp[] = [
            ...trashed.map((bookmark) => ({ type: "delete" as const, store: "trashed-bookmarks" as const, key: bookmark.id })),
            ...archived.map((bookmark) => ({ type: "delete" as const, store: "archived-bookmarks" as const, key: bookmark.id })),
          ];
          await idbBulkWrite(ops);
          set((current) => ({
            trashedBookmarks: current._trashedLoaded
              ? current.trashedBookmarks.filter((bookmark) => bookmark.collectionId !== collectionId)
              : current.trashedBookmarks,
            archivedBookmarks: current._archivedLoaded
              ? current.archivedBookmarks.filter((bookmark) => bookmark.collectionId !== collectionId)
              : current.archivedBookmarks,
          }));
          usePlanStore.getState().decrementUsage("bookmark", all.length);
        })();
      },
```

- [ ] **Step 2.2: Verify the type-check passes**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && pnpm compile
```

Expected: no TypeScript errors.

- [ ] **Step 2.3: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add store/bookmarks-store.ts
git commit -m "perf: skip redundant bookmark tombstone push in permanentlyDeleteCollectionBookmarks (server cascades)"
```

---

## Task 3: Wire `permanentlyDeleteBatch` into the trash UI

**Files:**
- Modify: `components/dashboard/trash-content.tsx:700-738`

### Background

Both `handleEmptyTrash` (line 724) and `handleBatchDelete` (line 700) currently call `permanentlyDeleteBookmark(bmId)` in a for-loop, firing one HTTP request per bookmark. Replace both loops with a single `permanentlyDeleteBatch` call.

`permanentlyDeleteBatch` is exposed on the `useBookmarksStore` state object. The component already has:
```typescript
const permanentlyDeleteBookmark = useBookmarksStore(s => s.permanentlyDelete);
```
Add a parallel selector for the batch version. The batch function is `void`-returning (fires async internally, same as `permanentlyDelete`), so the callers don't need to `await` it.

- [ ] **Step 3.1: Add the `permanentlyDeleteBatch` selector**

Find this line near the top of `TrashContent` (around line 437):
```typescript
  const permanentlyDeleteBookmark = useBookmarksStore(s => s.permanentlyDelete);
```

Add immediately after it:
```typescript
  const permanentlyDeleteBookmarkBatch = useBookmarksStore(s => s.permanentlyDeleteBatch);
```

- [ ] **Step 3.2: Update `handleBatchDelete` to use the batch method**

Replace the existing `handleBatchDelete` function (lines 700–722):

```typescript
  const handleBatchDelete = () => {
    for (const colId of selectedColIds) {
      permanentlyDeleteCollection(colId);
    }
    // Fully-selected groups → delete entire group (including remaining tabs)
    for (const groupId of selectedGroupIds) {
      permanentlyDeleteGroup(groupId);
    }
    // Partial tab selections → delete only those individual tabs
    for (const tabId of selectedTabIds) {
      const tab = allGroupTabs.find(t => t.id === tabId);
      if (tab && !selectedGroupIds.has(tab.groupId)) {
        deleteTabFromTrash(tabId);
      }
    }
    for (const bmId of selectedBmIds) {
      permanentlyDeleteBookmark(bmId);
    }
    setSelectedColIds(new Set());
    setSelectedGroupIds(new Set());
    setSelectedTabIds(new Set());
    setSelectedBmIds(new Set());
  };
```

With:

```typescript
  const handleBatchDelete = () => {
    for (const colId of selectedColIds) {
      permanentlyDeleteCollection(colId);
    }
    // Fully-selected groups → delete entire group (including remaining tabs)
    for (const groupId of selectedGroupIds) {
      permanentlyDeleteGroup(groupId);
    }
    // Partial tab selections → delete only those individual tabs
    for (const tabId of selectedTabIds) {
      const tab = allGroupTabs.find(t => t.id === tabId);
      if (tab && !selectedGroupIds.has(tab.groupId)) {
        deleteTabFromTrash(tabId);
      }
    }
    // Batch all selected bookmarks into one push (≤900 per request) instead of N requests.
    if (selectedBmIds.size > 0) {
      permanentlyDeleteBookmarkBatch(Array.from(selectedBmIds));
    }
    setSelectedColIds(new Set());
    setSelectedGroupIds(new Set());
    setSelectedTabIds(new Set());
    setSelectedBmIds(new Set());
  };
```

- [ ] **Step 3.3: Update `handleEmptyTrash` to use the batch method**

Replace the existing `handleEmptyTrash` function (lines 724–738):

```typescript
  const handleEmptyTrash = () => {
    for (const col of trashedCollections) {
      permanentlyDeleteCollection(col.id);
    }
    for (const group of trashedGroups) {
      permanentlyDeleteGroup(group.id);
    }
    for (const bm of individualTrashedBookmarks) {
      permanentlyDeleteBookmark(bm.id);
    }
    setSelectedColIds(new Set());
    setSelectedGroupIds(new Set());
    setSelectedTabIds(new Set());
    setSelectedBmIds(new Set());
  };
```

With:

```typescript
  const handleEmptyTrash = () => {
    for (const col of trashedCollections) {
      permanentlyDeleteCollection(col.id);
    }
    for (const group of trashedGroups) {
      permanentlyDeleteGroup(group.id);
    }
    // Batch all individual bookmarks into one push (≤900 per request) instead of N requests.
    if (individualTrashedBookmarks.length > 0) {
      permanentlyDeleteBookmarkBatch(individualTrashedBookmarks.map((b) => b.id));
    }
    setSelectedColIds(new Set());
    setSelectedGroupIds(new Set());
    setSelectedTabIds(new Set());
    setSelectedBmIds(new Set());
  };
```

- [ ] **Step 3.4: Verify the type-check passes**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && pnpm compile
```

Expected: no TypeScript errors. If you see "Property 'permanentlyDeleteBatch' does not exist on type", Task 1 Step 1.1 was not applied — verify the interface addition.

- [ ] **Step 3.5: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add components/dashboard/trash-content.tsx
git commit -m "perf: batch bookmark deletes in handleEmptyTrash and handleBatchDelete (N→1 HTTP requests)"
```

---

## Self-review

**Spec coverage:**
- ✅ `permanentlyDeleteBatch` batches N bookmarks into ⌈N/900⌉ requests (Task 1)
- ✅ Redundant push removed from `permanentlyDeleteCollectionBookmarks` (Task 2)
- ✅ `handleEmptyTrash` wired to batch method (Task 3)
- ✅ `handleBatchDelete` wired to batch method (Task 3)
- ✅ Rollback on partial failure (chunk loop returns on first error)
- ✅ IDB cleanup happens after server confirmation in all paths

**Placeholder scan:** None found.

**Type consistency:**
- `permanentlyDeleteBatch: (bookmarkIds: string[]) => void` — matches interface (Task 1.1) → implementation (Task 1.2) → selector name `permanentlyDeleteBookmarkBatch` (Task 3.1) → call sites (Tasks 3.2, 3.3). ✅
- `BulkWriteOp` — already imported at top of `bookmarks-store.ts`. ✅
- `idbGetMany` — already imported at top of `bookmarks-store.ts`. ✅
