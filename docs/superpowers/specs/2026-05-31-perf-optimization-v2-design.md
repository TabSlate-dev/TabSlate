# Performance Optimization v2 — Design Spec

Date: 2026-05-31
Status: Draft

## Background

The 2026-05-16 spec (`zustand-memory-performance-design.md`) addressed lazy loading, trash expiry, bulk IDB writes, and a few code-quality issues. That work shipped. This v2 spec covers the remaining hot spots discovered in a follow-up audit:

- `workspace-store.mergeFromServer` rewrites the entire local collections / workspaces / tags arrays to IDB on every sync delta, in N separate transactions, and uses O(n×m) `findIndex` loops.
- Active `bookmarks` is stored as an array; every `find by id` / `filter by id` is O(n) and these operations are pervasive across mutations and the sync merge.
- Sidebar `bookmarkCounts` recomputes O(n) on every `toggleFavorite` because it depends on the full `bookmarks` array reference.
- The `<Layout>` subtree (`WorkspaceRail`, `Sidebar`, `TabsRail`, `TabsDndProvider`) remounts on every route change because each `<Route>` wraps its own `<Layout>`.
- `background.ts` broadcasts `TABS_CHANGED` on every `chrome.tabs.onUpdated` / `onActivated` / `onMoved` event with no coalescing; `newtab` answers each with a full reload of tabs + groups + IDB titles.
- `tabs-store.focusTab` triggers a full `loadTabs` after every focus.
- `bookmarks-store.hydrate` runs the favicon `data:` migration on every cold start, even after migration is complete.
- `BookmarkCard.bookmarkTags` allocates a new array even when `bookmark.tags` is empty.
- `content.tsx` virtualizer `getItemKey` builds `bookmarks.map(b => b.id).join("_")` per row per measurement.
- `PageTracker` fires a `fetch` to OpenPanel on every route change without dedup.

Target scale: 1k–10k bookmarks, dozens of collections. The product has not launched yet — no backwards-compatibility shims are needed. We may bump IDB schema or change Zustand state shape freely.

---

## Section 1 — I/O Reduction

### 1a. `workspace-store.mergeFromServer` writes only touched entities, in one transaction

**Problem:** Lines 386–400 of `store/workspace-store.ts`:

```ts
for (const w of state.workspaces) { idbPut("workspaces", w); }
for (const c of state.collections) { idbPut("collections", c); }
for (const t of state.tags) { idbPut("tags", t); }
```

After every pull, the entire local arrays are rewritten to IDB, one transaction per record. With 50 collections + 200 tags + 5 workspaces this is 255 transactions even when the server delta touched a single tag.

**Design:** Build the op list from `resp.entities.*` (the touched set), and submit it as a single `idbBulkWrite`:

```ts
const wsByIdAfter = new Map(state.workspaces.map(w => [w.id, w]));
const colByIdAfter = new Map(state.collections.map(c => [c.id, c]));
const tagByIdAfter = new Map(state.tags.map(t => [t.id, t]));

const ops: BulkWriteOp[] = [];
for (const sw of resp.entities.workspaces) {
  if (sw.deleted_at) {
    ops.push({ type: "delete", store: "workspaces", key: sw.id });
  } else {
    ops.push({ type: "put", store: "workspaces", value: wsByIdAfter.get(sw.id)! });
  }
}
for (const sc of resp.entities.collections) {
  if (permDeletedCollectionIds.has(sc.id)) {
    ops.push({ type: "delete", store: "collections", key: sc.id });
  } else {
    ops.push({ type: "put", store: "collections", value: colByIdAfter.get(sc.id)! });
  }
}
for (const st of resp.entities.tags) {
  if (st.deleted_at) {
    ops.push({ type: "delete", store: "tags", key: st.id });
  } else {
    ops.push({ type: "put", store: "tags", value: tagByIdAfter.get(st.id)! });
  }
}
ops.push({ type: "put", store: "kv", value: { key: "activeWorkspaceId", value: state.activeWorkspaceId } });
await idbBulkWrite(ops);
```

### 1b. Replace `findIndex` with `Map<id, index>`

**Problem:** Inside `mergeFromServer`, each entity in the server delta does `collections.findIndex(c => c.id === sc.id)`. With 100 server entities × 100 local entities this is 10k array scans.

**Design:** Before entering the merge loop, build `Map<id, index>` for each entity type, mutate the array via index, keep the map in sync as new ids are pushed:

```ts
const colIdx = new Map<string, number>();
for (let i = 0; i < collections.length; i++) colIdx.set(collections[i].id, i);

for (const sc of resp.entities.collections) {
  const idx = colIdx.get(sc.id);
  if (idx === undefined) {
    collections.push({ /* new */ });
    colIdx.set(sc.id, collections.length - 1);
  } else {
    collections[idx] = { ...collections[idx], /* patch */ };
  }
}
```

### 1c. Convert remaining `idbPut`-in-loop sites to `idbBulkWrite`

Files / functions affected (all in `store/`):
- `bookmarks-store.ts` — `addBookmarks` (line 304), `_bulkAddBookmarks` (line 315), `reassignCollection` (line 914).
- `workspace-store.ts` — `deleteWorkspace` collection tombstone loop (line 483).

Each becomes a single `idbBulkWrite` of put-ops.

---

## Section 1.5 — Active bookmarks as `Map<id, Bookmark>`

### Problem

Active `bookmarks` is an array. The following O(n) patterns are used throughout `bookmarks-store`:

- `bookmarks.find(b => b.id === id)` — every `updateBookmark`, `toggleFavorite`, `archiveBookmark`, `trashBookmark`, etc.
- `bookmarks.filter(b => b.id !== id)` — every removal.
- `bookmarks.map(b => b.id === id ? {...b, ...patch} : b)` — every update.
- `bookmarks.filter(b => touchedIds.has(b.id))` — `mergeFromServer`.

At 10k bookmarks these become measurable on every interaction.

### Design

Store the active bucket as `Map<string, Bookmark>` internally. Archived and trashed buckets stay as arrays (they only matter inside their own routes and don't take this kind of hot-path traffic).

```ts
interface BookmarksState {
  bookmarks: Map<string, Bookmark>;   // ← changed
  archivedBookmarks: Bookmark[];
  trashedBookmarks: Bookmark[];
  // ...
}
```

Consumers that need an array (`BookmarksContent`, `getFilteredBookmarks`, `enqueueAllToSync`, `sweepUnsynced`) call `Array.from(state.bookmarks.values())` — but only inside selectors / actions where they iterate anyway.

Sidebar / cards that need a single bookmark by id get a new selector:
```ts
useBookmarksStore(s => s.bookmarks.get(bookmarkId))
```

### Reference stability for downstream `useMemo`

`Array.from(map.values())` allocates a new array each call. That destroys the reference-stability optimization from the previous spec (`filteredBookmarks` would always re-run).

Resolution: cache the materialized array inside the store, invalidate it on every mutation. Tag the materialized array with the map's revision number:

```ts
let _bookmarksArrayCache: Bookmark[] | null = null;
let _bookmarksArrayRev = -1;
let _bookmarksRev = 0;

// every mutation that changes the map:
_bookmarksRev++;

// selector helper:
function bookmarksAsArray(map: Map<string, Bookmark>): Bookmark[] {
  if (_bookmarksArrayRev === _bookmarksRev && _bookmarksArrayCache) {
    return _bookmarksArrayCache;
  }
  _bookmarksArrayCache = Array.from(map.values());
  _bookmarksArrayRev = _bookmarksRev;
  return _bookmarksArrayCache;
}
```

Components subscribe via `useBookmarksStore(s => bookmarksAsArray(s.bookmarks))` — reference-stable across renders where no mutation occurred.

### Iteration order

Insertion order is preserved by JS `Map`. For the `getFilteredBookmarks` sort path this is irrelevant (always sorted by `sortBy`). For the unordered "All Bookmarks" view (`sortBy: "date-newest"`), the sort still controls order.

### Migration

Backwards compatibility is not a constraint — `reset()` flushes to empty `Map`, `hydrate()` builds from `idbGetAll` into a `Map`. No data migration in IDB.

---

## Section 2 — Re-render Reduction

### 2a. Lift `Layout` to a layout route with `<Outlet/>`

**Problem:** `entrypoints/newtab/App.tsx` lines 330–378 — every `<Route element={<Layout>...</Layout>}>` instantiates a new `Layout` subtree on route change. `WorkspaceRail`, `BookmarksSidebar`, `TabsRail`, `TabsDndProvider` unmount and remount. Sidebar's collapse state, DnD context, scroll positions are all lost.

**Design:** Use a layout route:

```tsx
<Routes>
  <Route element={<LayoutRoute syncStatus={syncStatus} ... />}>
    <Route index element={<BookmarksContent />} />
    <Route path="favorites" element={<FavoritesContent />} />
    <Route path="archive" element={<ArchiveContent />} />
    <Route path="trash" element={<TrashContent />} />
    <Route path="tabs" element={<TabsPanel />} />
    <Route path="groups/:groupId" element={<GroupDetail />} />
  </Route>
</Routes>
```

`LayoutRoute` renders the chrome once and embeds `<Outlet />` where `{children}` used to be. The `title` prop becomes derivable from `useLocation()` inside the route components or via the `<Outlet context>` channel — concretely, each leaf component already knows its title, so push title rendering into the leaf header or a thin context.

### 2b. `countsByCollection` as derived state in `bookmarks-store`

**Problem:** Sidebar's `bookmarkCounts` useMemo iterates the full `bookmarks` array on every render of `BookmarksSidebar`. Every `toggleFavorite` invalidates the memo even though counts didn't change.

**Design:** Add to `bookmarks-store`:

```ts
countsByCollection: Record<string, number>;   // key "" = uncategorized
```

Initialized in `hydrate()` by one full scan. Maintained incrementally at every action entry that changes a bookmark's location in the active bucket:

- `addBookmark` / `addBookmarks` / `_bulkAddBookmarks` — `+1` per inserted bookmark's `collectionId`.
- `updateBookmark` — if patch contains `collectionId`, `-1` old, `+1` new; otherwise no change.
- `archiveBookmark` / `trashBookmark` — `-1` for that `collectionId`.
- `restoreFromArchive` / `restoreFromTrash` — `+1` for the bookmark's `collectionId` (or the restore override).
- `reassignCollection(fromId, toId)` — `-N` on `fromId`, `+N` on `toId`.
- `archiveCollectionBookmarks(id)` / `trashCollectionBookmarks(id)` — set `[id] = 0`. (Note: `trashCollectionBookmarks` also moves the collection's archived bookmarks to trash; those don't appear in `countsByCollection` to begin with, so no further adjustment.)
- `restoreCollectionBookmarks(id)` — set `[id] = restoredCount`.
- `permanentlyDelete*` — no change (those bookmarks were already not in the active bucket).
- `reset` — `{}`.

**`mergeFromServer` uses full recompute, not incremental:** the merge handles cross-bucket transitions (active ↔ archived ↔ trashed ↔ perm-deleted) for an arbitrary subset of ids; incremental bookkeeping there is error-prone. After the `set()` returns, run one `recomputeCounts(state.bookmarks)` and assign. This is `O(n_active)` but only on sync delta arrival.

```ts
function recomputeCounts(map: Map<string, Bookmark>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const b of map.values()) {
    counts[b.collectionId] = (counts[b.collectionId] ?? 0) + 1;
  }
  return counts;
}
```

**Dev-mode invariant assertion:** in development builds only, after each mutation, assert:

```ts
function assertCountsInvariant(state: BookmarksState) {
  if (!import.meta.env.DEV) return;
  let total = 0;
  for (const n of Object.values(state.countsByCollection)) total += n;
  if (total !== state.bookmarks.size) {
    throw new Error(
      `countsByCollection drift: sum=${total}, bookmarks.size=${state.bookmarks.size}`
    );
  }
}
```

Called at the end of each mutating action. Stripped from production builds by Vite tree-shaking on `import.meta.env.DEV`.

**Sidebar consumes via fine-grained selector:**

```ts
const counts = useBookmarksStore(s => s.countsByCollection);
const totalCount = useMemo(
  () => workspaceCollectionIds.reduce((sum, id) => sum + (counts[id] ?? 0), 0)
       + (counts[""] ?? 0),
  [counts, workspaceCollectionIds],
);
```

Sidebar no longer subscribes to `bookmarks` at all — `toggleFavorite` does not cause Sidebar re-renders.

### 2c. `BookmarkCard.bookmarkTags` empty-array short-circuit

**Problem:** `bookmarks-store/components/dashboard/bookmark-card.tsx:57-60` runs `tags.filter(...)` even when `bookmark.tags.length === 0`. Every card in a virtualized list allocates a new empty array.

**Design:** Module-level constant for the empty case:

```ts
const EMPTY_TAGS: Tag[] = [];

const bookmarkTags = React.useMemo(
  () => bookmark.tags.length === 0
    ? EMPTY_TAGS
    : tags.filter(tag => bookmark.tags.includes(tag.id)),
  [tags, bookmark.tags],
);
```

`React.memo` on `BookmarkCard` then catches the no-tags case via reference equality.

### 2d. virtualizer `getItemKey` — drop ID join

**Problem:** `components/dashboard/content.tsx:406-407`:

```ts
const ids = row.bookmarks.map((b) => b.id).join("_");
return `bookmarks-row-${viewMode}-${row.collectionId}-${row.rowIndex}-${ids}`;
```

String allocation and join per row per measurement.

**Design:**

```ts
return `bookmarks-row-${viewMode}-${row.collectionId}-${row.rowIndex}`;
```

The inner `<DraggableBookmarkCard key={bookmark.id} ... />` already provides identity for the React reconciler inside the row.

---

## Section 3 — Event Throttling

### 3a. `background.ts` `broadcastTabChange` — 100ms trailing debounce

**Problem:** `entrypoints/background.ts:119-136` fires `TABS_CHANGED` on every `tab.onUpdated` / `onActivated` / `onMoved`. Loading a multi-tab page floods newtab with messages, each handled by a full `loadTabs()`.

**Design:**

```ts
let _broadcastTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastTabChange() {
  if (_broadcastTimer) return;
  _broadcastTimer = setTimeout(() => {
    _broadcastTimer = null;
    chrome.runtime.sendMessage({ type: "TABS_CHANGED" }).catch(() => {});
  }, 100);
}
```

Trailing edge (not leading) to coalesce bursts and still deliver the final state.

### 3b. `tabs-store.focusTab` — optimistic local update

**Problem:** `store/tabs-store.ts:208-212`:

```ts
focusTab: async (tabId, windowId) => {
  await focusTab(tabId, windowId);
  await get().loadTabs(true);   // full reload of tabs + groups + IDB titles
},
```

Every tab click reloads everything.

**Design:** Flip the `active` flag locally; the debounced `TABS_CHANGED` from background will arrive shortly and resync if needed.

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

### 3c. `PageTracker` — coalesce rapid `page_view` events

**Problem:** `entrypoints/newtab/App.tsx:32-40` fires a network request on every `location.pathname` change. Rapid navigation (back/forward) creates a small storm.

**Design:** Inside `PageTracker`, defer the track call by 200ms and drop earlier pending calls for the same path:

```ts
function PageTracker() {
  const location = useLocation();
  const lastPathRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const path = location.pathname;
    timerRef.current = setTimeout(() => {
      if (lastPathRef.current === path) return;
      lastPathRef.current = path;
      analytics.track("page_view", { path });
    }, 200);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [location.pathname]);

  return null;
}
```

---

## Section 4 — Startup Cost

### 4a. Favicon migration flag

**Problem:** `bookmarks-store.hydrate` runs `migrateBookmarkForStore` on every record at every cold start, even after migration completed. Each `data:` check is cheap, but on 5k records it adds measurable time and `idbPut` write traffic for any record that still needs fixing.

**Design:** Use the `kv` store with key `"favicon-migrated-v1"`:

```ts
hydrate: async () => {
  const migrated = await idbGet<{ value: boolean }>("kv", "favicon-migrated-v1");
  if (migrated?.value) {
    const raw = await idbGetAll<Bookmark>("bookmarks");
    const map = new Map<string, Bookmark>();
    for (const b of raw) map.set(b.id, b);
    set({ bookmarks: map, _hydrated: true, countsByCollection: recomputeCounts(map) });
    return;
  }
  // Slow path: migrate, then write the flag
  const raw = await idbGetAll<Bookmark>("bookmarks");
  const ops: BulkWriteOp[] = [];
  const map = new Map<string, Bookmark>();
  for (const b of raw) {
    if (b.favicon.startsWith("data:")) {
      const fixed = { ...b, favicon: normalizeFavicon(b.favicon, b.url) };
      ops.push({ type: "put", store: "bookmarks", value: fixed });
      map.set(fixed.id, fixed);
    } else {
      map.set(b.id, b);
    }
  }
  ops.push({ type: "put", store: "kv", value: { key: "favicon-migrated-v1", value: true } });
  await idbBulkWrite(ops);
  set({ bookmarks: map, _hydrated: true, countsByCollection: recomputeCounts(map) });
},
```

`groups-store.hydrate` does the same migration on `group-tabs` and shares the same flag (flag covers all favicon stores at once — set after both pass).

---

## File Change Summary

| File | Changes |
|---|---|
| `store/bookmarks-store.ts` | `bookmarks` → `Map<id, Bookmark>`; cached array materialization with revision counter; `countsByCollection` field + incremental maintenance + dev invariant; favicon migration gated on flag; idbPut loops → idbBulkWrite |
| `store/workspace-store.ts` | `mergeFromServer` writes only touched entities via `idbBulkWrite`; `findIndex` loops → `Map<id, index>`; `deleteWorkspace` collection tombstones via `idbBulkWrite` |
| `store/groups-store.ts` | Favicon migration gated on shared flag |
| `store/tabs-store.ts` | `focusTab` — local optimistic active flip, no `loadTabs` |
| `entrypoints/background.ts` | `broadcastTabChange` — 100ms trailing debounce |
| `entrypoints/newtab/App.tsx` | Routes restructured via layout `<Outlet/>`; `PageTracker` 200ms dedupe |
| `components/dashboard/sidebar/index.tsx` | Sidebar reads `countsByCollection` instead of iterating `bookmarks`; no `bookmarks` subscription |
| `components/dashboard/content.tsx` | `getItemKey` simplified — drop ID join; all `bookmarks` consumers go through the new `bookmarksAsArray` selector |
| `components/dashboard/bookmark-card.tsx` | `EMPTY_TAGS` module-level constant; `bookmarkTags` short-circuit on empty `bookmark.tags` |
| Other callers of `useBookmarksStore(s => s.bookmarks)` | Migrated to `bookmarksAsArray` selector or `s.bookmarks.get(id)` |

## Non-Goals

- No server-side changes (sync protocol unchanged).
- No code-splitting / `React.lazy` for route components (bundle size is not the bottleneck at this scale).
- No bookmark pagination / server-side search (reserved for future spec).
- No re-architecture of archived / trashed buckets (still arrays).
- No change to `SyncEngine` lifecycle or `SyncQueue` debounce.

## Expected Gains (5k bookmarks / 50 collections estimate)

| Hot spot | Before | After |
|---|---|---|
| 1a IDB writes per sync delta | ~250 transactions | 1 transaction |
| 1b `mergeFromServer` index ops | O(n×m) ≈ 10k scans | O(n+m) ≈ 200 ops |
| 1.5 `find by id` calls | O(n) ≈ 5000 ops | O(1) |
| 2a Layout subtree on route change | unmount + remount | persistent |
| 2b Sidebar re-render on `toggleFavorite` | O(n) memo recompute + re-render | no re-render |
| 2c Empty-tags card render | new `[]` per card | shared constant |
| 2d Virtualizer row keying | per-measurement string alloc | static key |
| 3a `TABS_CHANGED` during page load | dozens of messages | 1 per 100ms |
| 3b `focusTab` cost | chrome APIs + IDB read | local mutation |
| 3c `page_view` requests during back/forward storm | N requests | 1 |
| 4a Favicon migration cold-start cost | O(n) scan every load | O(1) flag check |

## Risks & Mitigations

- **`countsByCollection` drift if a mutation entry is missed.** Mitigated by the dev-mode invariant assertion and the `mergeFromServer` full recompute (the most error-prone code path doesn't rely on incremental bookkeeping).
- **`bookmarks` `Map` iteration order ≠ original array order.** `Map` preserves insertion order, and all consumers either sort by `sortBy` or don't care about order. No regression expected.
- **Cached `bookmarksAsArray` array can be mutated by a caller.** Caller convention: treat as read-only. We don't freeze (perf cost in hot paths). Dev-mode optional `Object.freeze` if drift suspected.
- **Optimistic `focusTab` local update could disagree with Chrome briefly.** Resolved by the next debounced `TABS_CHANGED` broadcast (≤100ms).
- **`<Outlet/>` migration changes `title` plumbing.** Each leaf component already knows its title; move title responsibility into the leaf or expose via context.
