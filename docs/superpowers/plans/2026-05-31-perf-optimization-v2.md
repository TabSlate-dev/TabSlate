# Performance Optimization v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate seven measurable CPU/I/O hot spots across the bookmarks store, workspace sync, routing, and background messaging layers.

**Architecture:** Eight sequential tasks. Tasks 1–2 are narrow IDB/store improvements. Task 3 is the largest change (bookmarks `Map` refactor); it must fully compile before subsequent tasks begin. Tasks 4–8 are narrow and independent once Task 3 is done. No test framework exists — every task ends with `bun run compile` + a manual smoke check in a dev build.

**Tech Stack:** TypeScript strict, React 19, Zustand 5, IndexedDB via `lib/idb.ts` helpers (`idbBulkWrite`, `idbGetAll`, `idbPut`, `idbGet`), React Router v7, WXT (Chrome extension framework), Bun.

---

## File Map

| File | Tasks |
|---|---|
| `store/workspace-store.ts` | 1, 2 |
| `store/bookmarks-store.ts` | 2, 3, 4, 8 |
| `store/groups-store.ts` | 8 |
| `store/tabs-store.ts` | 3 (consumer), 7 |
| `entrypoints/newtab/App.tsx` | 5, 8 |
| `entrypoints/background.ts` | 7 |
| `components/dashboard/sidebar/index.tsx` | 3 (consumer), 4 |
| `components/dashboard/content.tsx` | 3 (consumer), 6 |
| `components/dashboard/favorites-content.tsx` | 3 (consumer) |
| `components/dashboard/bookmark-card.tsx` | 6 |

---

## Task 1: workspace-store `mergeFromServer` — Map index + touched-set IDB writes

**Spec:** Section 1a + 1b  
**Files:**
- Modify: `store/workspace-store.ts`

### What to change

`mergeFromServer` currently uses `findIndex` inside loops (O(n×m)) and rewrites every local entity to IDB after every pull (N transactions). Replace both.

- [ ] **Step 1: Add `idbBulkWrite` import at top of `store/workspace-store.ts`**

Open `store/workspace-store.ts`. The existing import line 5 is:
```ts
import { idbGetAll, idbGet, idbPut, idbDelete } from "@/lib/idb";
```
Change it to:
```ts
import { idbGetAll, idbGet, idbPut, idbDelete, idbBulkWrite, type BulkWriteOp } from "@/lib/idb";
```

- [ ] **Step 2: Build Map indices before the `set()` call in `mergeFromServer`**

Inside `mergeFromServer`, just before the `set((state) => {` call (around line 288), add three Map builds:

```ts
// Build O(1) lookup maps for the existing arrays before the set() updater.
// These are captured from state *before* the mutation begins.
const existingWorkspaces = get().workspaces;
const existingCollections = get().collections;
const existingTags = get().tags;
const wsIdx = new Map<string, number>(existingWorkspaces.map((w, i) => [w.id, i]));
const colIdx = new Map<string, number>(existingCollections.map((c, i) => [c.id, i]));
const tagIdx = new Map<string, number>(existingTags.map((t, i) => [t.id, i]));
```

- [ ] **Step 3: Replace `findIndex` with `Map.get()` inside the `set()` updater**

Inside the `set((state) => {` updater, replace the three entity loops. The updater currently reads `state.workspaces` etc. as its starting arrays. Change it to use the pre-built Maps (captured above, outside the updater) for lookups:

```ts
set((_state) => {
  let workspaces = [...existingWorkspaces];
  let collections = [...existingCollections];
  let tags = [...existingTags];

  for (const sw of resp.entities.workspaces) {
    if (sw.deleted_at) {
      workspaces = workspaces.filter(w => w.id !== sw.id);
    } else {
      const idx = wsIdx.get(sw.id);
      if (idx === undefined) {
        workspaces.push({ id: sw.id, name: sw.name, color: sw.color ?? "", position: sw.position, seq: sw.seq });
        wsIdx.set(sw.id, workspaces.length - 1);
      } else {
        workspaces[idx] = { ...workspaces[idx], name: sw.name, color: sw.color ?? workspaces[idx].color, position: sw.position, seq: sw.seq };
      }
    }
  }

  for (const sc of resp.entities.collections) {
    if (permDeletedCollectionIds.has(sc.id)) {
      collections = collections.filter(c => c.id !== sc.id);
      continue;
    }
    if (sc.deleted_at) {
      const idx = colIdx.get(sc.id);
      if (idx === undefined) {
        collections.push({
          id: sc.id,
          workspaceId: sc.workspace_id ?? "",
          name: sc.name,
          icon: sc.icon ?? "folder",
          position: sc.position,
          seq: sc.seq,
          isDefault: false,
          deletedAt: sc.deleted_at,
        });
        colIdx.set(sc.id, collections.length - 1);
      } else {
        collections[idx] = { ...collections[idx], seq: sc.seq, deletedAt: sc.deleted_at };
      }
    } else {
      const idx = colIdx.get(sc.id);
      if (idx === undefined) {
        collections.push({
          id: sc.id,
          workspaceId: sc.workspace_id ?? "",
          name: sc.name,
          icon: sc.icon ?? "folder",
          position: sc.position,
          seq: sc.seq,
          isDefault: sc.is_default ?? false,
          archivedAt: sc.archived_at ?? undefined,
        });
        colIdx.set(sc.id, collections.length - 1);
      } else {
        const local = collections[idx];
        if ((local.deletedAt || local.archivedAt) && local.seq === 0 && !sc.archived_at) {
          continue;
        }
        collections[idx] = {
          ...local,
          name: sc.name,
          icon: sc.icon ?? local.icon,
          position: sc.position,
          seq: sc.seq,
          workspaceId: sc.workspace_id ?? local.workspaceId,
          isDefault: sc.is_default ?? local.isDefault,
          archivedAt: sc.archived_at ?? undefined,
        };
      }
    }
  }

  for (const st of resp.entities.tags) {
    if (st.deleted_at) {
      tags = tags.filter(t => t.id !== st.id);
    } else {
      const idx = tagIdx.get(st.id);
      if (idx === undefined) {
        tags.push({ id: st.id, name: st.name, color: st.color ?? "", seq: st.seq });
        tagIdx.set(st.id, tags.length - 1);
      } else {
        tags[idx] = { ...tags[idx], name: st.name, color: st.color ?? tags[idx].color, seq: st.seq };
      }
    }
  }

  const sortedWs = [...workspaces].sort((a, b) => a.position - b.position);
  const activeWorkspaceId =
    workspaces.some(w => w.id === existingWorkspaces.find(ew => ew.id === (_state as typeof _state & { activeWorkspaceId: string }).activeWorkspaceId)?.id)
      ? (_state as typeof _state & { activeWorkspaceId: string }).activeWorkspaceId
      : sortedWs[0]?.id ?? "";
  return { workspaces, collections, tags, activeWorkspaceId };
});
```

Wait — the updater needs `state.activeWorkspaceId`. Keep the original parameter name `state`:

```ts
set((state) => {
  let workspaces = [...existingWorkspaces];
  let collections = [...existingCollections];
  let tags = [...existingTags];
  // ... (same loops as above)
  const sortedWs = [...workspaces].sort((a, b) => a.position - b.position);
  const activeWorkspaceId =
    workspaces.some(w => w.id === state.activeWorkspaceId)
      ? state.activeWorkspaceId
      : sortedWs[0]?.id ?? "";
  return { workspaces, collections, tags, activeWorkspaceId };
});
```

- [ ] **Step 4: Replace full-table IDB writes with touched-set `idbBulkWrite`**

Remove the current block after `set()` (lines ~386–400):
```ts
// DELETE THIS BLOCK:
const state = get();
idbPut("kv", { key: "activeWorkspaceId", value: state.activeWorkspaceId });
for (const w of state.workspaces) { idbPut("workspaces", w); }
for (const c of state.collections) { idbPut("collections", c); }
for (const t of state.tags) { idbPut("tags", t); }
for (const sw of resp.entities.workspaces) {
  if (sw.deleted_at) { idbDelete("workspaces", sw.id); }
}
for (const id of permDeletedCollectionIds) { idbDelete("collections", id); }
for (const st of resp.entities.tags) {
  if (st.deleted_at) { idbDelete("tags", st.id); }
}
```

Replace with:
```ts
const afterState = get();
const wsByIdAfter = new Map(afterState.workspaces.map(w => [w.id, w]));
const colByIdAfter = new Map(afterState.collections.map(c => [c.id, c]));
const tagByIdAfter = new Map(afterState.tags.map(t => [t.id, t]));

const idbOps: BulkWriteOp[] = [
  { type: "put", store: "kv", value: { key: "activeWorkspaceId", value: afterState.activeWorkspaceId } },
];
for (const sw of resp.entities.workspaces) {
  if (sw.deleted_at) {
    idbOps.push({ type: "delete", store: "workspaces", key: sw.id });
  } else {
    const w = wsByIdAfter.get(sw.id);
    if (w) idbOps.push({ type: "put", store: "workspaces", value: w });
  }
}
for (const sc of resp.entities.collections) {
  if (permDeletedCollectionIds.has(sc.id)) {
    idbOps.push({ type: "delete", store: "collections", key: sc.id });
  } else {
    const c = colByIdAfter.get(sc.id);
    if (c) idbOps.push({ type: "put", store: "collections", value: c });
  }
}
for (const st of resp.entities.tags) {
  if (st.deleted_at) {
    idbOps.push({ type: "delete", store: "tags", key: st.id });
  } else {
    const t = tagByIdAfter.get(st.id);
    if (t) idbOps.push({ type: "put", store: "tags", value: t });
  }
}
void idbBulkWrite(idbOps);
```

- [ ] **Step 5: Verify compile**

```bash
bun run compile
```

Expected: zero errors. If TypeScript complains about `existingWorkspaces` / `existingCollections` / `existingTags` being captured outside `set()`, confirm you placed them before the `set()` call in the function body, not inside the updater lambda.

- [ ] **Step 6: Commit**

```bash
git add store/workspace-store.ts
git commit -m "perf: workspace mergeFromServer O(1) Map index + touched-set IDB writes"
```

---

## Task 2: Replace remaining `idbPut`-in-loop sites

**Spec:** Section 1c  
**Files:**
- Modify: `store/bookmarks-store.ts`
- Modify: `store/workspace-store.ts`

- [ ] **Step 1: Fix `addBookmarks` in `store/bookmarks-store.ts`**

Find `addBookmarks` (~line 300). Change:
```ts
for (const b of normalized) { idbPut("bookmarks", b); }
```
to:
```ts
void idbBulkWrite(normalized.map(b => ({ type: "put" as const, store: "bookmarks" as const, value: b })));
```

- [ ] **Step 2: Fix `_bulkAddBookmarks` in `store/bookmarks-store.ts`**

Find `_bulkAddBookmarks` (~line 311). Change:
```ts
for (const b of normalized) { idbPut("bookmarks", b); }
```
to:
```ts
void idbBulkWrite(normalized.map(b => ({ type: "put" as const, store: "bookmarks" as const, value: b })));
```

- [ ] **Step 3: Fix `reassignCollection` in `store/bookmarks-store.ts`**

Find `reassignCollection` (~line 910). Change:
```ts
for (const b of updated) { idbPut("bookmarks", b); }
```
to:
```ts
void idbBulkWrite(updated.map(b => ({ type: "put" as const, store: "bookmarks" as const, value: b })));
```

- [ ] **Step 4: Fix `deleteWorkspace` in `store/workspace-store.ts`**

Find `deleteWorkspace` (~line 456). The collection tombstone loop currently is:
```ts
for (const c of colsToTombstone) {
  idbPut("collections", c);
  await useBookmarksStore.getState().trashCollectionBookmarks(c.id);
}
```
The `await` inside means we can't batch these with the `trashCollectionBookmarks` calls. Split into two: IDB write (batch), then async bookmark trash (sequential):

```ts
// Batch-write all collection tombstones to IDB
void idbBulkWrite(colsToTombstone.map(c => ({ type: "put" as const, store: "collections" as const, value: c })));
// Then async-trash each collection's bookmarks sequentially
for (const c of colsToTombstone) {
  await useBookmarksStore.getState().trashCollectionBookmarks(c.id);
}
```

- [ ] **Step 5: Verify compile**

```bash
bun run compile
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add store/bookmarks-store.ts store/workspace-store.ts
git commit -m "perf: replace idbPut-in-loop with idbBulkWrite in addBookmarks, reassignCollection, deleteWorkspace"
```

---

## Task 3: `bookmarks` store — `Map<id, Bookmark>` internal representation

**Spec:** Section 1.5  
**Files:**
- Modify: `store/bookmarks-store.ts` (core change)
- Modify: `components/dashboard/content.tsx` (consumer)
- Modify: `components/dashboard/favorites-content.tsx` (consumer)
- Modify: `components/dashboard/sidebar/index.tsx` (consumer — temporary, will be cleaned up in Task 4)
- Modify: `store/tabs-store.ts` (consumer)
- Modify: `store/workspace-store.ts` (consumer — `.bookmarks.length` → `.bookmarks.size`)

This task changes the TypeScript type of `BookmarksState.bookmarks`. All consumers must be updated in the same task or `bun run compile` will fail.

### Part A — Store internal changes

- [ ] **Step 1: Add module-level cache vars and export `bookmarksAsArray`**

Near the top of `store/bookmarks-store.ts`, after the existing module-level helpers (after `readTrashedBookmarksForCollection`), add:

```ts
// ---------------------------------------------------------------------------
// bookmarksAsArray — stable reference cache for Map→Array materialisation.
// Invalidated by bumping _bookmarksRev before any mutation.
// ---------------------------------------------------------------------------
let _bookmarksArrayCache: Bookmark[] | null = null;
let _bookmarksArrayRevSeen = -1;
let _bookmarksRev = 0;

export function bookmarksAsArray(map: Map<string, Bookmark>): Bookmark[] {
  if (_bookmarksArrayRevSeen === _bookmarksRev && _bookmarksArrayCache !== null) {
    return _bookmarksArrayCache;
  }
  _bookmarksArrayCache = Array.from(map.values());
  _bookmarksArrayRevSeen = _bookmarksRev;
  return _bookmarksArrayCache;
}
```

- [ ] **Step 2: Change `BookmarksState.bookmarks` type**

In the `BookmarksState` interface, change:
```ts
bookmarks: Bookmark[];
```
to:
```ts
bookmarks: Map<string, Bookmark>;
```

- [ ] **Step 3: Update `hydrate`**

```ts
hydrate: async () => {
  const raw = await readBookmarkStore("bookmarks");
  const map = new Map<string, Bookmark>();
  for (const b of raw) map.set(b.id, b);
  set({ bookmarks: map, _hydrated: true });
},
```

- [ ] **Step 4: Update `reloadActive`**

```ts
reloadActive: async () => {
  const raw = await readBookmarkStore("bookmarks");
  const map = new Map<string, Bookmark>();
  for (const b of raw) map.set(b.id, b);
  _bookmarksRev++;
  set({ bookmarks: map });
},
```

- [ ] **Step 5: Update `reset`**

```ts
reset: () => {
  _bookmarksRev++;
  set({
    bookmarks: new Map(),
    archivedBookmarks: [],
    trashedBookmarks: [],
    selectedCollection: "all",
    selectedTags: [],
    searchQuery: "",
    _hydrated: true,
    _archivedLoaded: false,
    _trashedLoaded: false,
  });
},
```

- [ ] **Step 6: Update `addBookmark`**

```ts
addBookmark: (input) => {
  const fallback: Bookmark = { id: "", createdAt: "", isFavorite: false, ...input };
  return guardQuota("bookmark", undefined, fallback, () => {
    const bookmark: Bookmark = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      isFavorite: false,
      ...input,
      favicon: normalizeFavicon(input.favicon, input.url),
    };
    _bookmarksRev++;
    set(s => {
      const next = new Map(s.bookmarks);
      next.set(bookmark.id, bookmark);
      return { bookmarks: next };
    });
    idbPut("bookmarks", bookmark);
    syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
    usePlanStore.getState().incrementUsage("bookmark");
    analytics.track("bookmark_added");
    return bookmark;
  });
},
```

- [ ] **Step 7: Update `addBookmarks`**

```ts
addBookmarks: (newBookmarks) =>
  guardQuota("bookmark", undefined, undefined, () => {
    const normalized = newBookmarks.map(b => ({ ...b, favicon: normalizeFavicon(b.favicon, b.url) }));
    _bookmarksRev++;
    set(s => {
      const next = new Map(s.bookmarks);
      for (const b of normalized) next.set(b.id, b);
      return { bookmarks: next };
    });
    void idbBulkWrite(normalized.map(b => ({ type: "put" as const, store: "bookmarks" as const, value: b })));
    if (normalized.length > 0) {
      syncEngine?.enqueue({ bookmarks: normalized.map(b => toServerBookmark(b)) });
    }
    usePlanStore.getState().incrementUsage("bookmark", normalized.length);
  }),
```

- [ ] **Step 8: Update `_bulkAddBookmarks`**

```ts
_bulkAddBookmarks: (newBookmarks) => {
  if (newBookmarks.length === 0) return;
  const normalized = newBookmarks.map(b => ({ ...b, favicon: normalizeFavicon(b.favicon, b.url) }));
  _bookmarksRev++;
  set(s => {
    const next = new Map(s.bookmarks);
    for (const b of normalized) next.set(b.id, b);
    return { bookmarks: next };
  });
  void idbBulkWrite(normalized.map(b => ({ type: "put" as const, store: "bookmarks" as const, value: b })));
  syncEngine?.enqueue({ bookmarks: normalized.map(b => toServerBookmark(b)) });
  analytics.track("bookmark_imported", { count: normalized.length });
},
```

- [ ] **Step 9: Update `updateBookmark`**

Replace the first (active-bookmark) branch — the part that does `state.bookmarks.find(...)` and `state.bookmarks.map(...)`:

```ts
updateBookmark: (id, patch) => {
  const state = get();
  const activeBookmark = state.bookmarks.get(id);
  if (activeBookmark) {
    const updated = { ...activeBookmark, ...patch };
    _bookmarksRev++;
    set(s => {
      const next = new Map(s.bookmarks);
      next.set(id, updated);
      return { bookmarks: next };
    });
    idbPut("bookmarks", updated);
    syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated)] });
    return;
  }
  // ... rest of the function (archived/trashed paths) unchanged
},
```

- [ ] **Step 10: Update `toggleFavorite`**

```ts
toggleFavorite: (bookmarkId) => {
  const b = get().bookmarks.get(bookmarkId);
  if (!b) return;
  const updated = { ...b, isFavorite: !b.isFavorite };
  _bookmarksRev++;
  set(s => {
    const next = new Map(s.bookmarks);
    next.set(bookmarkId, updated);
    return { bookmarks: next };
  });
  idbPut("bookmarks", updated);
  syncEngine?.enqueue({ bookmarks: [toServerBookmark(updated)] });
},
```

- [ ] **Step 11: Update `archiveBookmark`**

```ts
archiveBookmark: (bookmarkId) => {
  const bookmark = get().bookmarks.get(bookmarkId);
  if (!bookmark) return;
  idbDelete("bookmarks", bookmarkId);
  idbPut("archived-bookmarks", bookmark);
  syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isArchived: true })] });
  _bookmarksRev++;
  set(s => {
    const next = new Map(s.bookmarks);
    next.delete(bookmarkId);
    return {
      bookmarks: next,
      archivedBookmarks: s._archivedLoaded ? [...s.archivedBookmarks, bookmark] : s.archivedBookmarks,
    };
  });
},
```

- [ ] **Step 12: Update `trashBookmark`**

```ts
trashBookmark: (bookmarkId) => {
  const bookmark = get().bookmarks.get(bookmarkId);
  if (!bookmark) return;
  const trashed = { ...bookmark, deletedAt: Date.now() };
  idbDelete("bookmarks", bookmarkId);
  idbPut("trashed-bookmarks", trashed);
  syncEngine?.enqueue({ bookmarks: [toServerBookmark(trashed, { isTrashed: 1 })] });
  _bookmarksRev++;
  set(s => {
    const next = new Map(s.bookmarks);
    next.delete(bookmarkId);
    return {
      bookmarks: next,
      trashedBookmarks: s._trashedLoaded ? [...s.trashedBookmarks, trashed] : s.trashedBookmarks,
    };
  });
},
```

- [ ] **Step 13: Update `restoreFromArchive`**

The archived → active path (when _archivedLoaded, synchronous):
```ts
restoreFromArchive: (bookmarkId) => {
  const state = get();
  const bookmark = state._archivedLoaded
    ? state.archivedBookmarks.find(c => c.id === bookmarkId)
    : undefined;
  if (bookmark) {
    idbDelete("archived-bookmarks", bookmarkId);
    idbPut("bookmarks", bookmark);
    syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
    _bookmarksRev++;
    set(s => {
      const next = new Map(s.bookmarks);
      next.set(bookmarkId, bookmark);
      return {
        bookmarks: next,
        archivedBookmarks: s.archivedBookmarks.filter(c => c.id !== bookmarkId),
      };
    });
    return;
  }
  // async fallback path (archived not loaded):
  void (async () => {
    const archived = state._archivedLoaded ? undefined : await readBookmarkById("archived-bookmarks", bookmarkId);
    if (!archived) return;
    await idbDelete("archived-bookmarks", bookmarkId);
    await idbPut("bookmarks", archived);
    syncEngine?.enqueue({ bookmarks: [toServerBookmark(archived)] });
    _bookmarksRev++;
    set(s => {
      const next = new Map(s.bookmarks);
      next.set(bookmarkId, archived);
      return {
        bookmarks: next,
        archivedBookmarks: s._archivedLoaded
          ? s.archivedBookmarks.filter(c => c.id !== bookmarkId)
          : s.archivedBookmarks,
      };
    });
  })();
},
```

- [ ] **Step 14: Update `restoreFromTrash`**

Synchronous path:
```ts
if (bookmark) {
  const restored = collectionIdOverride !== undefined
    ? { ...bookmark, collectionId: collectionIdOverride, deletedAt: undefined }
    : { ...bookmark, deletedAt: undefined };
  idbDelete("trashed-bookmarks", bookmarkId);
  idbPut("bookmarks", restored);
  syncEngine?.enqueue({ bookmarks: [toServerBookmark(restored)] });
  _bookmarksRev++;
  set(s => {
    const next = new Map(s.bookmarks);
    next.set(bookmarkId, restored);
    return {
      bookmarks: next,
      trashedBookmarks: s.trashedBookmarks.filter(c => c.id !== bookmarkId),
    };
  });
  return;
}
// async fallback: same pattern — set Map instead of spread
```

The async fallback mirrors the sync path — use `next.set(bookmarkId, restored)` instead of `[...current.bookmarks, restored]`.

- [ ] **Step 15: Update `archiveCollectionBookmarks`**

```ts
archiveCollectionBookmarks: (collectionId) => {
  const affected = Array.from(get().bookmarks.values()).filter(b => b.collectionId === collectionId);
  if (affected.length === 0) return;
  const ops: BulkWriteOp[] = [
    ...affected.map(b => ({ type: "delete" as const, store: "bookmarks" as const, key: b.id })),
    ...affected.map(b => ({ type: "put" as const, store: "archived-bookmarks" as const, value: b })),
  ];
  void idbBulkWrite(ops);
  syncEngine?.enqueue({ bookmarks: affected.map(b => toServerBookmark(b, { isArchived: true })) });
  _bookmarksRev++;
  set(s => {
    const next = new Map(s.bookmarks);
    for (const b of affected) next.delete(b.id);
    return {
      bookmarks: next,
      archivedBookmarks: s._archivedLoaded ? [...s.archivedBookmarks, ...affected] : s.archivedBookmarks,
    };
  });
},
```

- [ ] **Step 16: Update `trashCollectionBookmarks`**

```ts
trashCollectionBookmarks: (collectionId) => {
  return (async () => {
    const state = get();
    const active = Array.from(state.bookmarks.values()).filter(b => b.collectionId === collectionId);
    // ... rest unchanged (archived + bulk IDB write)
    _bookmarksRev++;
    set(current => {
      const next = new Map(current.bookmarks);
      for (const b of active) next.delete(b.id);
      return {
        bookmarks: next,
        archivedBookmarks: current._archivedLoaded
          ? current.archivedBookmarks.filter(b => b.collectionId !== collectionId)
          : current.archivedBookmarks,
        trashedBookmarks: current._trashedLoaded
          ? [...current.trashedBookmarks.filter(b => b.collectionId !== collectionId), ...trashed]
          : current.trashedBookmarks,
      };
    });
  })();
},
```

- [ ] **Step 17: Update `restoreCollectionBookmarks`**

```ts
set(current => {
  const next = new Map(current.bookmarks);
  for (const b of all) next.set(b.id, b);
  return {
    bookmarks: next,
    archivedBookmarks: current._archivedLoaded
      ? current.archivedBookmarks.filter(b => b.collectionId !== collectionId)
      : current.archivedBookmarks,
    trashedBookmarks: current._trashedLoaded
      ? current.trashedBookmarks.filter(b => b.collectionId !== collectionId)
      : current.trashedBookmarks,
  };
});
```

- [ ] **Step 18: Update `reassignCollection`**

```ts
reassignCollection: (fromId, toId) => {
  const affected = Array.from(get().bookmarks.values()).filter(b => b.collectionId === fromId);
  if (affected.length === 0) return;
  const updated = affected.map(b => ({ ...b, collectionId: toId }));
  void idbBulkWrite(updated.map(b => ({ type: "put" as const, store: "bookmarks" as const, value: b })));
  syncEngine?.enqueue({ bookmarks: updated.map(b => toServerBookmark(b)) });
  _bookmarksRev++;
  set(s => {
    const next = new Map(s.bookmarks);
    for (const b of updated) next.set(b.id, b);
    return { bookmarks: next };
  });
},
```

- [ ] **Step 19: Update `enqueueAllToSync`**

```ts
enqueueAllToSync: () => {
  void (async () => {
    const state = get();
    await Promise.all([
      state._archivedLoaded ? Promise.resolve() : get().loadArchivedBookmarks(),
      state._trashedLoaded ? Promise.resolve() : get().loadTrashedBookmarks(),
    ]);
    const current = get();
    syncEngine?.enqueue({
      bookmarks: [
        ...Array.from(current.bookmarks.values()).map(b => toServerBookmark(b)),
        ...current.archivedBookmarks.map(b => toServerBookmark(b, { isArchived: true })),
        ...current.trashedBookmarks.map(b => {
          const rec = b as TrashedBookmarkRecord;
          return toServerBookmark(b, { isTrashed: rec.isTrashed === 2 ? 2 : 1 });
        }),
      ],
    });
  })();
},
```

- [ ] **Step 20: Update `sweepUnsynced`**

```ts
const unsynced = [
  ...Array.from(current.bookmarks.values())
    .filter(b => b.seq === 0)
    .map(b => toServerBookmark(b)),
  // archived + trashed paths unchanged
];
```

- [ ] **Step 21: Update `mergeFromServer` state update inside `set()`**

Replace the `newActive` computation:

```ts
set(current => {
  const nextBookmarks = new Map(current.bookmarks);
  for (const id of touchedIds) nextBookmarks.delete(id);
  for (const id of permanentlyDeletedIds) nextBookmarks.delete(id);
  for (const b of toActive) nextBookmarks.set(b.id, b);

  // Reference stability: only emit new Map if something changed.
  const activeChanged = nextBookmarks.size !== current.bookmarks.size ||
    toActive.some(b => current.bookmarks.get(b.id) !== b) ||
    Array.from(permanentlyDeletedIds).some(id => current.bookmarks.has(id)) ||
    Array.from(touchedIds).some(id => current.bookmarks.has(id) && !toActive.find(b => b.id === id));

  if (activeChanged) _bookmarksRev++;

  const newArchived = [ /* existing logic */ ];
  const newTrashed  = [ /* existing logic */ ];
  // ...reference stability checks for archived and trashed remain the same...

  return {
    bookmarks: activeChanged ? nextBookmarks : current.bookmarks,
    archivedBookmarks: /* same as before */,
    trashedBookmarks:  /* same as before */,
  };
});
```

- [ ] **Step 22: Update `getFilteredBookmarks`**

```ts
getFilteredBookmarks: (workspaceCollectionIds) => {
  const state = get();
  let filtered = Array.from(state.bookmarks.values()).filter(
    b => b.collectionId === "" || workspaceCollectionIds.has(b.collectionId)
  );
  // rest unchanged
},
```

- [ ] **Step 23: Update `getFavoriteBookmarks`**

```ts
getFavoriteBookmarks: () => {
  const state = get();
  const filtered = Array.from(state.bookmarks.values()).filter(b => b.isFavorite);
  return applySort(applySearch(filtered, state.searchQuery), state.sortBy);
},
```

### Part B — Consumer updates

- [ ] **Step 24: Update `components/dashboard/content.tsx`**

Add import at top:
```ts
import { bookmarksAsArray } from "@/store/bookmarks-store";
```

Change line ~205:
```ts
// Before:
const bookmarks = useBookmarksStore(s => s.bookmarks);
// After:
const bookmarks = useBookmarksStore(s => bookmarksAsArray(s.bookmarks));
```

- [ ] **Step 25: Update `components/dashboard/favorites-content.tsx`**

Add import:
```ts
import { bookmarksAsArray } from "@/store/bookmarks-store";
```

Change line ~11:
```ts
// Before:
const bookmarks = useBookmarksStore(s => s.bookmarks);
// After:
const bookmarks = useBookmarksStore(s => bookmarksAsArray(s.bookmarks));
```

Update the `favoriteBookmarks` useMemo — `bookmarks` is now a `Bookmark[]` from `bookmarksAsArray`, so `.filter(...)` works unchanged.

- [ ] **Step 26: Update `components/dashboard/sidebar/index.tsx` (temporary)**

Add import:
```ts
import { bookmarksAsArray } from "@/store/bookmarks-store";
```

Change line ~190:
```ts
// Before:
const bookmarks = useBookmarksStore(s => s.bookmarks);
// After:
const bookmarks = useBookmarksStore(s => bookmarksAsArray(s.bookmarks));
```

(Task 4 will replace this with `countsByCollection` and remove the `bookmarks` subscription entirely.)

- [ ] **Step 27: Update `store/tabs-store.ts`**

In `_saveTabsToCollectionHelper` (~line 84), change:
```ts
// Before:
const { bookmarks, addBookmarks } = useBookmarksStore.getState();
// ...
const wsBookmarks = bookmarks.filter(...)
// After:
const { bookmarks: bookmarksMap, addBookmarks } = useBookmarksStore.getState();
const bookmarks = Array.from(bookmarksMap.values());
```

Lines ~342 and ~371 use `const { bookmarks } = useBookmarksStore.getState()` then `bookmarks.filter(...)`. Apply the same pattern: get the Map, call `Array.from(bookmarksMap.values())`.

- [ ] **Step 28: Update `store/workspace-store.ts`**

Line ~640: change:
```ts
// Before:
const bookmarkCount = useBookmarksStore.getState().bookmarks.length;
// After:
const bookmarkCount = useBookmarksStore.getState().bookmarks.size;
```

- [ ] **Step 29: Verify compile**

```bash
bun run compile
```

Expected: zero errors. Common failure points: any remaining `.filter(` / `.map(` / `.find(` / `.length` / `.includes(` calls on the `Map` type. Grep for them:

```bash
grep -n "bookmarks\.(filter\|map\|find\|length\|includes\|some\|reduce)" store/bookmarks-store.ts
```

Fix any remaining instances the steps above missed.

- [ ] **Step 30: Commit**

```bash
git add store/bookmarks-store.ts components/dashboard/content.tsx components/dashboard/favorites-content.tsx components/dashboard/sidebar/index.tsx store/tabs-store.ts store/workspace-store.ts
git commit -m "perf: bookmarks store — Map<id, Bookmark> + bookmarksAsArray stable-ref cache"
```

---

## Task 4: `countsByCollection` — incremental maintenance + dev invariant

**Spec:** Section 2b  
**Files:**
- Modify: `store/bookmarks-store.ts`
- Modify: `components/dashboard/sidebar/index.tsx`

### Part A — Add `countsByCollection` to store

- [ ] **Step 1: Add `recomputeCounts` helper and `assertCountsInvariant`**

In `store/bookmarks-store.ts`, add after `bookmarksAsArray`:

```ts
function recomputeCounts(map: Map<string, Bookmark>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const b of map.values()) {
    counts[b.collectionId] = (counts[b.collectionId] ?? 0) + 1;
  }
  return counts;
}

function assertCountsInvariant(state: { bookmarks: Map<string, Bookmark>; countsByCollection: Record<string, number> }) {
  if (!import.meta.env.DEV) return;
  const sum = Object.values(state.countsByCollection).reduce((a, b) => a + b, 0);
  if (sum !== state.bookmarks.size) {
    throw new Error(`countsByCollection drift: sum=${sum}, bookmarks.size=${state.bookmarks.size}`);
  }
}
```

- [ ] **Step 2: Add `countsByCollection` to `BookmarksState` interface**

```ts
countsByCollection: Record<string, number>;
```

- [ ] **Step 3: Initialise in store definition**

In the store's initial state literal:
```ts
countsByCollection: {},
```

- [ ] **Step 4: Populate in `hydrate`**

After building the Map, add:
```ts
set({ bookmarks: map, _hydrated: true, countsByCollection: recomputeCounts(map) });
```

- [ ] **Step 5: Reset in `reset`**

```ts
set({ bookmarks: new Map(), ..., countsByCollection: {} });
```

- [ ] **Step 6: Add `+1` to `addBookmark`**

After the `set(...)` call inside `addBookmark`:
```ts
set(s => {
  const next = new Map(s.bookmarks);
  next.set(bookmark.id, bookmark);
  const colId = bookmark.collectionId;
  const counts = { ...s.countsByCollection, [colId]: (s.countsByCollection[colId] ?? 0) + 1 };
  return { bookmarks: next, countsByCollection: counts };
});
assertCountsInvariant(get());
```

- [ ] **Step 7: Add `+N` to `addBookmarks` and `_bulkAddBookmarks`**

In each, after the `set(...)`:
```ts
set(s => {
  const next = new Map(s.bookmarks);
  for (const b of normalized) next.set(b.id, b);
  const counts = { ...s.countsByCollection };
  for (const b of normalized) counts[b.collectionId] = (counts[b.collectionId] ?? 0) + 1;
  return { bookmarks: next, countsByCollection: counts };
});
assertCountsInvariant(get());
```

- [ ] **Step 8: Add `-1` to `archiveBookmark` and `trashBookmark`**

In each, inside the `set(...)`:
```ts
set(s => {
  const next = new Map(s.bookmarks);
  next.delete(bookmarkId);
  const colId = bookmark.collectionId;
  const counts = { ...s.countsByCollection, [colId]: Math.max(0, (s.countsByCollection[colId] ?? 1) - 1) };
  return { bookmarks: next, countsByCollection: counts, /* ...archivedBookmarks/trashedBookmarks */ };
});
assertCountsInvariant(get());
```

- [ ] **Step 9: Add `+1` to `restoreFromArchive` and `restoreFromTrash`**

In each synchronous path:
```ts
set(s => {
  const next = new Map(s.bookmarks);
  next.set(bookmarkId, restored); // or `archived`
  const colId = restored.collectionId; // or `archived.collectionId`
  const counts = { ...s.countsByCollection, [colId]: (s.countsByCollection[colId] ?? 0) + 1 };
  return { bookmarks: next, countsByCollection: counts, /* ...archivedBookmarks/trashedBookmarks */ };
});
assertCountsInvariant(get());
```

Also add to the async fallback paths in both functions.

- [ ] **Step 10: Add `-N` and `+N` to `reassignCollection`**

```ts
set(s => {
  const next = new Map(s.bookmarks);
  for (const b of updated) next.set(b.id, b);
  const counts = { ...s.countsByCollection };
  counts[fromId] = Math.max(0, (counts[fromId] ?? 0) - updated.length);
  counts[toId] = (counts[toId] ?? 0) + updated.length;
  return { bookmarks: next, countsByCollection: counts };
});
assertCountsInvariant(get());
```

- [ ] **Step 11: Set `[collectionId] = 0` in `archiveCollectionBookmarks` and `trashCollectionBookmarks`**

In `archiveCollectionBookmarks`:
```ts
set(s => {
  // ...
  const counts = { ...s.countsByCollection, [collectionId]: 0 };
  return { bookmarks: next, countsByCollection: counts, /* archivedBookmarks */ };
});
```

In `trashCollectionBookmarks` (inside the async `set(current => {...})`):
```ts
const counts = { ...current.countsByCollection, [collectionId]: 0 };
return { bookmarks: next, countsByCollection: counts, /* ... */ };
```

- [ ] **Step 12: Add `+N` to `restoreCollectionBookmarks`**

```ts
set(current => {
  const next = new Map(current.bookmarks);
  for (const b of all) next.set(b.id, b);
  const counts = { ...current.countsByCollection, [collectionId]: (current.countsByCollection[collectionId] ?? 0) + all.length };
  return { bookmarks: next, countsByCollection: counts, /* ... */ };
});
```

- [ ] **Step 13: Full recompute in `mergeFromServer`**

After the `set(current => {...})` call that updates `bookmarks`, add:
```ts
const afterMerge = get();
const recomputed = recomputeCounts(afterMerge.bookmarks);
set({ countsByCollection: recomputed });
```

- [ ] **Step 14: Update `updateBookmark` for collectionId patch**

When `patch.collectionId` is defined, update counts:
```ts
if (activeBookmark) {
  const updated = { ...activeBookmark, ...patch };
  _bookmarksRev++;
  set(s => {
    const next = new Map(s.bookmarks);
    next.set(id, updated);
    let counts = s.countsByCollection;
    if (patch.collectionId !== undefined && patch.collectionId !== activeBookmark.collectionId) {
      counts = { ...counts };
      counts[activeBookmark.collectionId] = Math.max(0, (counts[activeBookmark.collectionId] ?? 1) - 1);
      counts[patch.collectionId] = (counts[patch.collectionId] ?? 0) + 1;
    }
    return { bookmarks: next, countsByCollection: counts };
  });
  assertCountsInvariant(get());
  // ...
}
```

### Part B — Sidebar update

- [ ] **Step 15: Update `components/dashboard/sidebar/index.tsx`**

Remove the `bookmarks` subscription and `bookmarkCounts` useMemo. Add `countsByCollection`:

```ts
// Remove:
// const bookmarks = useBookmarksStore(s => bookmarksAsArray(s.bookmarks));
// Remove the bookmarkCounts useMemo

// Add:
const countsByCollection = useBookmarksStore(s => s.countsByCollection);
```

Replace the `bookmarkCounts` useMemo with:
```ts
const bookmarkCounts = React.useMemo(() => {
  const wsIds = new Set(workspaceCollections.map(c => c.id));
  let total = 0;
  for (const [colId, n] of Object.entries(countsByCollection)) {
    if (wsIds.has(colId) || colId === "") total += n;
  }
  const perCol: Record<string, number> = { all: total };
  for (const c of workspaceCollections) {
    perCol[c.id] = countsByCollection[c.id] ?? 0;
  }
  return perCol;
}, [countsByCollection, workspaceCollections]);
```

Remove the `bookmarksAsArray` import if no longer used in this file.

- [ ] **Step 16: Verify compile**

```bash
bun run compile
```

- [ ] **Step 17: Commit**

```bash
git add store/bookmarks-store.ts components/dashboard/sidebar/index.tsx
git commit -m "perf: countsByCollection incremental maintenance + dev invariant assertion"
```

---

## Task 5: Layout route with `<Outlet/>`

**Spec:** Section 2a  
**Files:**
- Modify: `entrypoints/newtab/App.tsx`

- [ ] **Step 1: Add title derivation map and update `Layout`**

In `entrypoints/newtab/App.tsx`, add a `ROUTE_TITLES` map and update `Layout` to derive its title from location:

```ts
import { HashRouter, Route, Routes, useLocation, Outlet } from "react-router-dom";
```

Add above the `Layout` component:
```ts
const ROUTE_TITLES: Record<string, string> = {
  "/favorites": "Favorites",
  "/archive": "Archive",
  "/trash": "Trash",
  "/tabs": "Open Tabs",
  "/groups": "Groups",
};

function useRouteTitle(): string | undefined {
  const { pathname } = useLocation();
  if (pathname.startsWith("/groups/")) return "Groups";
  return ROUTE_TITLES[pathname];
}
```

Remove the `title` prop from `Layout`'s props interface and derive it internally:
```ts
function Layout({
  syncStatus,
  syncErrorMessage,
  onForceSync,
}: {
  syncStatus: SyncStatus;
  syncErrorMessage?: string | null;
  onForceSync: () => void;
}) {
  const title = useRouteTitle();
  return (
    <div className="flex h-svh overflow-hidden bg-sidebar">
      <WorkspaceRail />
      <div className="flex flex-1 min-w-0 overflow-hidden">
        <SidebarProvider style={{ "--sidebar-offset": "3.25rem" } as React.CSSProperties}>
          <BookmarksSidebar syncStatus={syncStatus} syncErrorMessage={syncErrorMessage} onForceSync={onForceSync} />
          <div className="flex flex-1 h-svh overflow-hidden lg:p-2 lg:gap-2 min-w-0">
            <div className="flex-1 flex flex-col lg:border lg:rounded-lg bg-background overflow-hidden min-w-0">
              <BookmarksHeader title={title} />
              <Outlet />
            </div>
            <div className="hidden lg:flex lg:rounded-lg lg:border overflow-hidden shrink-0">
              <TabsRail />
            </div>
          </div>
        </SidebarProvider>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Restructure `<Routes>` in `App`**

Inside `SyncProvider`'s render prop, replace the `<Routes>` block:

```tsx
<HashRouter>
  <PageTracker />
  <TabsDndProvider>
    <Routes>
      <Route
        element={
          <Layout
            syncStatus={syncStatus}
            syncErrorMessage={syncErrorMessage}
            onForceSync={onForceSync}
          />
        }
      >
        <Route index element={<BookmarksContent />} />
        <Route path="favorites" element={<FavoritesContent />} />
        <Route path="archive" element={<ArchiveContent />} />
        <Route path="trash" element={<TrashContent />} />
        <Route path="tabs" element={<TabsPanel />} />
        <Route path="groups/:groupId" element={<GroupDetail />} />
      </Route>
    </Routes>
  </TabsDndProvider>
</HashRouter>
```

Note: React Router v7 layout routes require the parent route to render `<Outlet/>` — which our updated `Layout` now does.

- [ ] **Step 3: Verify compile**

```bash
bun run compile
```

- [ ] **Step 4: Smoke test**

```bash
bun run dev
```

Open the extension's new tab page. Navigate between bookmarks, favorites, archive, trash, tabs, and a group detail. Confirm the Sidebar does **not** flash/remount (bookmark count numbers and collapse state persist across navigation).

- [ ] **Step 5: Commit**

```bash
git add entrypoints/newtab/App.tsx
git commit -m "perf: Layout as layout route with Outlet — prevents Sidebar remount on navigation"
```

---

## Task 6: `BookmarkCard` EMPTY_TAGS + virtualizer key

**Spec:** Sections 2c + 2d  
**Files:**
- Modify: `components/dashboard/bookmark-card.tsx`
- Modify: `components/dashboard/content.tsx`

- [ ] **Step 1: Add `EMPTY_TAGS` constant to `bookmark-card.tsx`**

Add near the top of `components/dashboard/bookmark-card.tsx`, after the imports:

```ts
const EMPTY_TAGS: ReturnType<typeof import("@/lib/types")["Tag"]>[] = [];
```

Actually, import the `Tag` type and use it directly:
```ts
import type { Bookmark, Tag } from "@/lib/types";
// ...
const EMPTY_TAGS: Tag[] = [];
```

- [ ] **Step 2: Update `bookmarkTags` useMemo in `BookmarkCard`**

```ts
const bookmarkTags = React.useMemo(
  () => bookmark.tags.length === 0
    ? EMPTY_TAGS
    : tags.filter(tag => bookmark.tags.includes(tag.id)),
  [tags, bookmark.tags],
);
```

- [ ] **Step 3: Simplify `getItemKey` in `content.tsx`**

Find the `getItemKey` callback in the `useVirtualizer` call (~line 395). Change:

```ts
// Before:
const ids = row.bookmarks.map((b) => b.id).join("_");
return `bookmarks-row-${viewMode}-${row.collectionId}-${row.rowIndex}-${ids}`;

// After:
return `bookmarks-row-${viewMode}-${row.collectionId}-${row.rowIndex}`;
```

- [ ] **Step 4: Verify compile**

```bash
bun run compile
```

- [ ] **Step 5: Commit**

```bash
git add components/dashboard/bookmark-card.tsx components/dashboard/content.tsx
git commit -m "perf: EMPTY_TAGS short-circuit in BookmarkCard, drop ID-join from virtualizer key"
```

---

## Task 7: `broadcastTabChange` debounce + `focusTab` optimistic update

**Spec:** Sections 3a + 3b  
**Files:**
- Modify: `entrypoints/background.ts`
- Modify: `store/tabs-store.ts`

- [ ] **Step 1: Add 100ms trailing debounce to `broadcastTabChange`**

In `entrypoints/background.ts`, replace the existing `broadcastTabChange` function:

```ts
// Before:
async function broadcastTabChange() {
  chrome.runtime.sendMessage({ type: "TABS_CHANGED" } as ExtensionMessage).catch(() => {});
}

// After:
let _broadcastTabChangeTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastTabChange() {
  if (_broadcastTabChangeTimer) return;
  _broadcastTabChangeTimer = setTimeout(() => {
    _broadcastTabChangeTimer = null;
    chrome.runtime.sendMessage({ type: "TABS_CHANGED" } as ExtensionMessage).catch(() => {});
  }, 100);
}
```

Note: `broadcastTabChange` is no longer `async` — remove the `async` keyword and the `await` if present in the original.

- [ ] **Step 2: Update `focusTab` in `store/tabs-store.ts`**

```ts
focusTab: async (tabId, windowId) => {
  await focusTab(tabId, windowId);
  set(state => ({
    openTabs: state.openTabs.map(t => ({
      ...t,
      active: t.id === tabId && t.windowId === windowId,
    })),
  }));
},
```

The background's debounced `TABS_CHANGED` will arrive within ~100ms and do a full reload if needed. The optimistic update ensures the UI feels instant.

- [ ] **Step 3: Verify compile**

```bash
bun run compile
```

- [ ] **Step 4: Smoke test**

```bash
bun run dev
```

Open several tabs. Click between them in the TabsRail. Verify the active indicator moves instantly without a visible reload delay.

- [ ] **Step 5: Commit**

```bash
git add entrypoints/background.ts store/tabs-store.ts
git commit -m "perf: broadcastTabChange 100ms debounce + focusTab optimistic local update"
```

---

## Task 8: `PageTracker` coalesce + favicon migration flag

**Spec:** Sections 3c + 4a  
**Files:**
- Modify: `entrypoints/newtab/App.tsx`
- Modify: `store/bookmarks-store.ts`
- Modify: `store/groups-store.ts`

### Part A — PageTracker 200ms dedup

- [ ] **Step 1: Update `PageTracker` in `entrypoints/newtab/App.tsx`**

```ts
function PageTracker() {
  const location = useLocation();
  const lastPathRef = React.useRef<string | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const path = location.pathname;
    timerRef.current = setTimeout(() => {
      if (lastPathRef.current === path) return;
      lastPathRef.current = path;
      analytics.track("page_view", { path });
    }, 200);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [location.pathname]);

  return null;
}
```

### Part B — Favicon migration flag

- [ ] **Step 2: Update `hydrate` in `store/bookmarks-store.ts`**

Add the fast-path check. The function currently calls `readBookmarkStore("bookmarks")` which runs `migrateBookmarkForStore` on every record. Change it to:

```ts
hydrate: async () => {
  const flagRecord = await idbGet<{ key: string; value: boolean }>("kv", "favicon-migrated-bookmarks-v1");
  let raw: Bookmark[];
  if (flagRecord?.value) {
    raw = await idbGetAll<Bookmark>("bookmarks");
  } else {
    raw = await readBookmarkStore("bookmarks");  // runs migration
    void idbPut("kv", { key: "favicon-migrated-bookmarks-v1", value: true });
  }
  const map = new Map<string, Bookmark>();
  for (const b of raw) map.set(b.id, b);
  set({ bookmarks: map, _hydrated: true, countsByCollection: recomputeCounts(map) });
},
```

Ensure `idbGet` is imported at the top of `bookmarks-store.ts` (it should already be).

- [ ] **Step 3: Update `hydrate` in `store/groups-store.ts`**

Add the same fast-path check for group-tab favicons:

```ts
hydrate: async () => {
  const [allGroups, groupTabs] = await Promise.all([
    idbGetAll<SavedGroup>("groups"),
    idbGetAll<GroupTab>("group-tabs"),
  ]);
  const groups = allGroups.filter(g => {
    if (!g.workspaceId) {
      idbDelete("groups", g.id);
      return false;
    }
    return true;
  });

  const flagRecord = await idbGet<{ key: string; value: boolean }>("kv", "favicon-migrated-groups-v1");
  let migratedTabs: GroupTab[];
  if (flagRecord?.value) {
    migratedTabs = groupTabs;
  } else {
    migratedTabs = groupTabs.map((t): GroupTab => {
      if (!t.favicon.startsWith("data:")) return t;
      const fixed = { ...t, favicon: normalizeFavicon(t.favicon, t.url) };
      idbPut("group-tabs", fixed);
      return fixed;
    });
    void idbPut("kv", { key: "favicon-migrated-groups-v1", value: true });
  }

  set({ groups, groupTabs: migratedTabs, _hydrated: true });
},
```

Ensure `idbGet` is imported in `groups-store.ts`. Add it to the import line:
```ts
import { idbGetAll, idbGet, idbPut, idbDelete } from "@/lib/idb";
```

- [ ] **Step 4: Verify compile**

```bash
bun run compile
```

- [ ] **Step 5: Commit**

```bash
git add entrypoints/newtab/App.tsx store/bookmarks-store.ts store/groups-store.ts
git commit -m "perf: PageTracker 200ms dedup + favicon migration one-shot flag in hydrate"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Task | Status |
|---|---|---|
| 1a — touched-set IDB writes in workspace mergeFromServer | Task 1 | ✓ |
| 1b — O(n+m) Map index in workspace mergeFromServer | Task 1 | ✓ |
| 1c — idbPut-in-loop → idbBulkWrite (addBookmarks, reassignCollection, deleteWorkspace) | Task 2 | ✓ |
| 1.5 — bookmarks as Map<id, Bookmark> + bookmarksAsArray | Task 3 | ✓ |
| 2a — Layout Outlet | Task 5 | ✓ |
| 2b — countsByCollection incremental + dev invariant | Task 4 | ✓ |
| 2c — EMPTY_TAGS short-circuit in BookmarkCard | Task 6 | ✓ |
| 2d — drop ID-join from virtualizer getItemKey | Task 6 | ✓ |
| 3a — broadcastTabChange 100ms debounce | Task 7 | ✓ |
| 3b — focusTab optimistic local update | Task 7 | ✓ |
| 3c — PageTracker 200ms dedup | Task 8 | ✓ |
| 4a — favicon migration flag | Task 8 | ✓ |

**Consumers of `bookmarks` (Map) not yet listed explicitly in tasks:**
- `store/workspace-store.ts:640` — `.bookmarks.length` → `.bookmarks.size` — covered in Task 3 Step 28. ✓
- `store/tabs-store.ts:342,371` — `bookmarks.filter(b => ...)` for `openCollectionAsGroup` / `openCollection` — covered in Task 3 Step 27. ✓

**Type consistency check:**
- `bookmarksAsArray` is defined in Task 3 Step 1, imported in Tasks 3, 4. ✓
- `recomputeCounts` is defined in Task 4 Step 1, used in Tasks 4 and 8. ✓
- `assertCountsInvariant` is defined in Task 4 Step 1, called throughout Task 4. ✓
- `countsByCollection` initialised as `{}` in store literal (Task 4 Step 3), populated in hydrate (Task 4 Step 4). ✓
- `_bookmarksRev` incremented before each `set()` in Task 3, read in `bookmarksAsArray` from Task 3. ✓
