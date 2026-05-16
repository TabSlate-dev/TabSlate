# Zustand Memory & Performance Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce memory usage 50–70%, make bulk IDB operations 5–10× faster, and remove client-side repair logic for the `isDefault` collection invariant.

**Architecture:** Split `bookmarks-store.hydrate()` into an eager active-only load and two lazy loaders (archived/trashed) called on route mount; add grace-period expiry to the trash loader; replace per-item IDB transactions with a single-transaction bulk helper; migrate `isDefault` computation to the server pull response; add `guardQuota` to eliminate six copies of identical quota boilerplate.

**Tech Stack:** TypeScript, Zustand (no middleware), IndexedDB via `lib/idb.ts`, Go + PostgreSQL for the server task.

---

## File Map

| File | What changes |
|---|---|
| `lib/idb.ts` | Add `idbBulkWrite` |
| `store/plan-store.ts` | Export `guardQuota` helper |
| `store/bookmarks-store.ts` | `guardQuota`; fix `deletedAt` on trash; fix `toServerBookmark` deleted_at; batch IDB collection ops + merged enqueue; stable refs in `mergeFromServer`; split `hydrate` + lazy loaders; `reloadActive`; `pruneExpiredTrash` |
| `store/workspace-store.ts` | `guardQuota`; lightweight `isDefault` fallback in `hydrate`; read `sc.is_default` in `mergeFromServer`; remove two repair blocks |
| `store/groups-store.ts` | `guardQuota`; `buildTabsByGroup` for `sweepUnsynced` + `enqueueAllToSync` |
| `entrypoints/newtab/App.tsx` | `BOOKMARKS_CHANGED` → `reloadActive()` |
| `components/dashboard/archive-content.tsx` | Mount effect → `loadArchivedBookmarks()` |
| `components/dashboard/trash-content.tsx` | Mount effect → `loadTrashedBookmarks()` |
| `TabSlate-server/internal/model/model.go` | `Collection.IsDefault bool` |
| `TabSlate-server/internal/handler/sync.go` | Pull query computes `is_default` via CTE |
| `lib/api.ts` | `ServerCollection.is_default?: boolean` |

---

## Task 1: `idbBulkWrite` utility

**Files:**
- Modify: `lib/idb.ts`

- [ ] **Step 1: Add the `BulkWriteOp` type and `idbBulkWrite` function** immediately after the `idbTransaction` function (after line 162):

```ts
export type BulkWriteOp =
  | { type: "delete"; store: StoreName; key: IDBValidKey }
  | { type: "put"; store: StoreName; value: object };

/**
 * Executes multiple delete/put operations across one or more stores in a
 * single IDB transaction. All ops are issued synchronously inside the
 * transaction callback — no awaits permitted inside fn.
 */
export function idbBulkWrite(ops: BulkWriteOp[]): Promise<void> {
  if (ops.length === 0) return Promise.resolve();
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
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/idb.ts
git commit -m "feat: add idbBulkWrite for atomic multi-store batch operations"
```

---

## Task 2: `guardQuota` helper

**Files:**
- Modify: `store/plan-store.ts`

- [ ] **Step 1: Add `guardQuota` export** immediately after the closing `);` of `usePlanStore = create(...)` (after line 150):

```ts
/**
 * Standard quota gate for create actions. Calls ensureFresh, checks quota,
 * shows alert on breach, and returns fallback. Returns action() otherwise.
 * Pure helper — does not touch store internals.
 */
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

- [ ] **Step 2: Type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add store/plan-store.ts
git commit -m "feat: add guardQuota helper to eliminate quota boilerplate"
```

---

## Task 3: Apply `guardQuota` across all stores

**Files:**
- Modify: `store/bookmarks-store.ts` (lines 195–213, 216–230)
- Modify: `store/workspace-store.ts` (lines 412–451, 502–524, 579–592)
- Modify: `store/groups-store.ts` (lines 112–127)

- [ ] **Step 1: Update `bookmarks-store.ts` — add import and rewrite `addBookmark`**

Add to the existing imports at the top of `store/bookmarks-store.ts`:
```ts
import { usePlanStore, guardQuota } from "@/store/plan-store";
```
(Replace the existing `import { usePlanStore } from "@/store/plan-store";` line.)

Replace `addBookmark` (lines 195–213):
```ts
addBookmark: (input) =>
  guardQuota("bookmark", get().bookmarks.length, { id: "", createdAt: "", isFavorite: false, ...input } as Bookmark, () => {
    const bookmark: Bookmark = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      isFavorite: false,
      ...input,
      favicon: normalizeFavicon(input.favicon, input.url),
    };
    set((s) => ({ bookmarks: [bookmark, ...s.bookmarks] }));
    idbPut("bookmarks", bookmark);
    syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
    usePlanStore.getState().incrementUsage("bookmark");
    return bookmark;
  }),
```

Replace `addBookmarks` (lines 216–230):
```ts
addBookmarks: (newBookmarks) =>
  guardQuota("bookmark", get().bookmarks.length, undefined, () => {
    const normalized = newBookmarks.map((b) => ({ ...b, favicon: normalizeFavicon(b.favicon, b.url) }));
    set((s) => ({ bookmarks: [...normalized, ...s.bookmarks] }));
    for (const b of normalized) { idbPut("bookmarks", b); }
    if (normalized.length > 0) {
      syncEngine?.enqueue({ bookmarks: normalized.map(b => toServerBookmark(b)) });
    }
    usePlanStore.getState().incrementUsage("bookmark", normalized.length);
  }),
```

- [ ] **Step 2: Update `workspace-store.ts` — rewrite `createWorkspace`, `createCollection`, `createTag`**

Add `guardQuota` to the import:
```ts
import { usePlanStore, guardQuota } from "@/store/plan-store";
```

Replace `createWorkspace` (lines 412–451):
```ts
createWorkspace: (name, color) =>
  guardQuota("workspace", get().workspaces.length, undefined as unknown as Workspace, () => {
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
    usePlanStore.getState().incrementUsage("workspace");
    usePlanStore.getState().incrementUsage("collection");
    return ws;
  }),
```

Replace `createCollection` (lines 502–524):
```ts
createCollection: (workspaceId, name, icon) =>
  guardQuota(
    "collection",
    get().collections.filter(c => !c.deletedAt && !c.archivedAt).length,
    { id: "", workspaceId, name: name ?? "", icon: icon ?? "", position: 0, seq: 0 } as Collection,
    () => {
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
      usePlanStore.getState().incrementUsage("collection");
      return col;
    },
  ),
```

Replace `createTag` (lines 579–592):
```ts
createTag: (name, color) =>
  guardQuota("tag", get().tags.length, { id: "", name, color, seq: 0 } as Tag, () => {
    const tag: Tag = { id: generateId(), name, color, seq: 0 };
    set((s) => ({ tags: [...s.tags, tag] }));
    idbPut("tags", tag);
    syncEngine?.enqueue({ tags: [toServerTag(tag)] });
    usePlanStore.getState().incrementUsage("tag");
    return tag;
  }),
```

- [ ] **Step 3: Update `groups-store.ts` — rewrite `createGroup`**

Add `guardQuota` to the import:
```ts
import { usePlanStore, guardQuota } from "@/store/plan-store";
```

Replace `createGroup` (lines 112–127):
```ts
createGroup: (name, color, isCompact, workspaceId) =>
  guardQuota("saved_group", get().groups.filter(g => !g.deletedAt).length, "", () => {
    const id = generateId();
    const group: SavedGroup = { id, name, color, isCompact, createdAt: new Date().toISOString(), seq: 0, workspaceId };
    syncEngine?.enqueue({ groups: [toServerGroup(group, [])] });
    set((state) => ({ groups: [...state.groups, group] }));
    idbPut("groups", group);
    usePlanStore.getState().incrementUsage("saved_group");
    return id;
  }),
```

- [ ] **Step 4: Type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 5: Build verify**

```bash
bun run build
```

Expected: successful build, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add store/bookmarks-store.ts store/workspace-store.ts store/groups-store.ts
git commit -m "refactor: replace quota boilerplate with guardQuota helper"
```

---

## Task 4: Fix `deletedAt` on trash + fix `toServerBookmark` + batch IDB collection ops

**Files:**
- Modify: `store/bookmarks-store.ts`

This task has three sub-concerns that must land together:
1. `toServerBookmark` must not send `deleted_at` for soft-trashed (isTrashed=1) bookmarks — if we set `deletedAt` locally and it leaks to the server, `mergeFromServer` will misread it as a permanent deletion signal.
2. `trashBookmark` and `trashCollectionBookmarks` must set `deletedAt = Date.now()` so the grace-period expiry in Task 8 has a timestamp to work with.
3. The four collection-level operations must use `idbBulkWrite`.

- [ ] **Step 1: Fix `toServerBookmark` to not leak `deletedAt` for soft-trashed bookmarks**

Replace the `toServerBookmark` function (lines 19–36) with:
```ts
function toServerBookmark(b: Bookmark, opts: { isArchived?: boolean; isTrashed?: number } = {}): object {
  return {
    id: b.id,
    collection_id: b.collectionId || null,
    title: b.title,
    url: b.url,
    favicon_url: b.favicon,
    description: b.description,
    is_favorite: b.isFavorite,
    is_archived: opts.isArchived ?? false,
    is_trashed: opts.isTrashed ?? 0,
    tag_ids: b.tags,
    position: 0,
    seq: b.seq,
    // Only send deleted_at for permanent deletes (isTrashed: 2).
    // For soft-trashed (1) we use deletedAt locally for grace-period expiry only
    // and must NOT send it to the server — the server reads deleted_at as a
    // permanent-deletion tombstone in mergeFromServer.
    deleted_at: opts.isTrashed === 2 ? (b.deletedAt ?? Date.now()) : null,
    updated_at: Date.now(),
  };
}
```

- [ ] **Step 2: Set `deletedAt` in `trashBookmark`**

Replace `trashBookmark` (lines 303–313):
```ts
trashBookmark: (bookmarkId) => {
  const bookmark = get().bookmarks.find((b) => b.id === bookmarkId);
  if (!bookmark) return;
  const trashed = { ...bookmark, deletedAt: Date.now() };
  idbDelete("bookmarks", bookmarkId);
  idbPut("trashed-bookmarks", trashed);
  syncEngine?.enqueue({ bookmarks: [toServerBookmark(trashed, { isTrashed: 1 })] });
  set((state) => ({
    bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
    trashedBookmarks: [...state.trashedBookmarks, trashed],
  }));
},
```

- [ ] **Step 3: Add `idbBulkWrite` import and rewrite four collection ops**

Add `idbBulkWrite` to the import from `@/lib/idb`:
```ts
import { idbGetAll, idbPut, idbDelete, idbBulkWrite, type BulkWriteOp } from "@/lib/idb";
```

Replace `archiveCollectionBookmarks` (lines 448–460):
```ts
archiveCollectionBookmarks: (collectionId) => {
  const affected = get().bookmarks.filter(b => b.collectionId === collectionId);
  if (affected.length === 0) { return; }
  const ops: BulkWriteOp[] = [
    ...affected.map(b => ({ type: "delete" as const, store: "bookmarks" as const, key: b.id })),
    ...affected.map(b => ({ type: "put" as const, store: "archived-bookmarks" as const, value: b })),
  ];
  void idbBulkWrite(ops);
  syncEngine?.enqueue({ bookmarks: affected.map(b => toServerBookmark(b, { isArchived: true })) });
  set((s) => ({
    bookmarks: s.bookmarks.filter(b => b.collectionId !== collectionId),
    archivedBookmarks: [...s.archivedBookmarks, ...affected],
  }));
},
```

Replace `trashCollectionBookmarks` (lines 462–476):
```ts
trashCollectionBookmarks: (collectionId) => {
  const active = get().bookmarks.filter(b => b.collectionId === collectionId);
  const archived = get().archivedBookmarks.filter(b => b.collectionId === collectionId);
  const all = [...active, ...archived];
  if (all.length === 0) { return; }
  const now = Date.now();
  const trashed = all.map(b => ({ ...b, deletedAt: now }));
  const ops: BulkWriteOp[] = [
    ...active.map(b => ({ type: "delete" as const, store: "bookmarks" as const, key: b.id })),
    ...archived.map(b => ({ type: "delete" as const, store: "archived-bookmarks" as const, key: b.id })),
    ...trashed.map(b => ({ type: "put" as const, store: "trashed-bookmarks" as const, value: b })),
  ];
  void idbBulkWrite(ops);
  syncEngine?.enqueue({ bookmarks: trashed.map(b => toServerBookmark(b, { isTrashed: 1 })) });
  set((s) => ({
    bookmarks: s.bookmarks.filter(b => b.collectionId !== collectionId),
    archivedBookmarks: s.archivedBookmarks.filter(b => b.collectionId !== collectionId),
    trashedBookmarks: [...s.trashedBookmarks, ...trashed],
  }));
  usePlanStore.getState().decrementUsage("bookmark", all.length);
},
```

Replace `restoreCollectionBookmarks` (lines 478–494):
```ts
restoreCollectionBookmarks: (collectionId) => {
  const fromArchive = get().archivedBookmarks.filter(b => b.collectionId === collectionId);
  const fromTrash = get().trashedBookmarks.filter(b => b.collectionId === collectionId);
  const all = [...fromArchive, ...fromTrash];
  if (all.length === 0) { return; }
  const ops: BulkWriteOp[] = [
    ...fromArchive.map(b => ({ type: "delete" as const, store: "archived-bookmarks" as const, key: b.id })),
    ...fromTrash.map(b => ({ type: "delete" as const, store: "trashed-bookmarks" as const, key: b.id })),
    ...all.map(b => ({ type: "put" as const, store: "bookmarks" as const, value: b })),
  ];
  void idbBulkWrite(ops);
  syncEngine?.enqueue({ bookmarks: all.map(b => toServerBookmark(b)) });
  set((s) => ({
    archivedBookmarks: s.archivedBookmarks.filter(b => b.collectionId !== collectionId),
    trashedBookmarks: s.trashedBookmarks.filter(b => b.collectionId !== collectionId),
    bookmarks: [...s.bookmarks, ...all],
  }));
},
```

Replace `permanentlyDeleteCollectionBookmarks` (lines 496–510):
```ts
permanentlyDeleteCollectionBookmarks: (collectionId) => {
  const trashed = get().trashedBookmarks.filter(b => b.collectionId === collectionId);
  const archived = get().archivedBookmarks.filter(b => b.collectionId === collectionId);
  const all = [...trashed, ...archived];
  if (all.length === 0) { return; }
  // Single batch enqueue (not per-item loop)
  syncEngine?.enqueue({ bookmarks: all.map(b => toServerBookmark(b, { isTrashed: 2 })) });
  const ops: BulkWriteOp[] = [
    ...trashed.map(b => ({ type: "delete" as const, store: "trashed-bookmarks" as const, key: b.id })),
    ...archived.map(b => ({ type: "delete" as const, store: "archived-bookmarks" as const, key: b.id })),
  ];
  void idbBulkWrite(ops);
  set((s) => ({
    trashedBookmarks: s.trashedBookmarks.filter(b => b.collectionId !== collectionId),
    archivedBookmarks: s.archivedBookmarks.filter(b => b.collectionId !== collectionId),
  }));
},
```

- [ ] **Step 4: Type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 5: Build verify**

```bash
bun run build
```

Expected: successful build.

- [ ] **Step 6: Commit**

```bash
git add store/bookmarks-store.ts lib/idb.ts
git commit -m "perf: batch IDB collection ops, fix deletedAt on trash, fix toServerBookmark"
```

---

## Task 5: O(n×m) → O(n+m) in groups-store sync helpers

**Files:**
- Modify: `store/groups-store.ts`

- [ ] **Step 1: Add `buildTabsByGroup` module-level function** immediately before `export const useGroupsStore`:

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

- [ ] **Step 2: Update `sweepUnsynced`** (lines 417–424):

```ts
sweepUnsynced: () => {
  const { groups, groupTabs } = get();
  const unsynced = groups.filter(g => g.seq === 0);
  if (unsynced.length === 0) { return; }
  const tabsByGroup = buildTabsByGroup(groupTabs);
  syncEngine?.enqueue({
    groups: unsynced.map(g => toServerGroup(g, tabsByGroup.get(g.id) ?? [])),
  });
},
```

- [ ] **Step 3: Update `enqueueAllToSync`** (lines 426–432):

```ts
enqueueAllToSync: () => {
  const { groups, groupTabs } = get();
  if (groups.length === 0) { return; }
  const tabsByGroup = buildTabsByGroup(groupTabs);
  syncEngine?.enqueue({
    groups: groups.map(g => toServerGroup(g, tabsByGroup.get(g.id) ?? [])),
  });
},
```

- [ ] **Step 4: Type-check and commit**

```bash
bun run compile && git add store/groups-store.ts && git commit -m "perf: O(n+m) group tab lookup in sweepUnsynced and enqueueAllToSync"
```

---

## Task 6: Stable array references in `bookmarks-store.mergeFromServer`

**Files:**
- Modify: `store/bookmarks-store.ts`

When a pull response touches only non-bookmark entities (tags, workspaces), the current code still creates new `bookmarks` array references, causing `filteredBookmarks` useMemo in `content.tsx` to recompute. This task fixes that.

- [ ] **Step 1: Replace the `return` block inside the `set()` call in `mergeFromServer`** (lines 408–422):

Find this section inside `mergeFromServer`'s `set((state) => { ... })`:
```ts
          // Single filter pass per bucket (O(n) total) then append new items
          return {
            bookmarks: [
              ...state.bookmarks.filter((b) => !touchedIds.has(b.id)),
              ...toActive,
            ],
            archivedBookmarks: [
              ...state.archivedBookmarks.filter((b) => !touchedIds.has(b.id)),
              ...toArchived,
            ],
            trashedBookmarks: [
              ...state.trashedBookmarks.filter((b) => !touchedIds.has(b.id)),
              ...toTrashed,
            ],
          };
```

Replace with:
```ts
          // Build candidate arrays then return the original reference if nothing changed.
          // This prevents useMemo recomputation in components when the pull only touched
          // other entity types (workspaces, tags, etc).
          const newActive = [
            ...state.bookmarks.filter((b) => !touchedIds.has(b.id)),
            ...toActive,
          ];
          const activeChanged =
            newActive.length !== state.bookmarks.length ||
            newActive.some((b, i) => b !== state.bookmarks[i]);

          const newArchived = [
            ...state.archivedBookmarks.filter((b) => !touchedIds.has(b.id)),
            ...toArchived,
          ];
          const archivedChanged =
            newArchived.length !== state.archivedBookmarks.length ||
            newArchived.some((b, i) => b !== state.archivedBookmarks[i]);

          const newTrashed = [
            ...state.trashedBookmarks.filter((b) => !touchedIds.has(b.id)),
            ...toTrashed,
          ];
          const trashedChanged =
            newTrashed.length !== state.trashedBookmarks.length ||
            newTrashed.some((b, i) => b !== state.trashedBookmarks[i]);

          return {
            bookmarks: activeChanged ? newActive : state.bookmarks,
            archivedBookmarks: archivedChanged ? newArchived : state.archivedBookmarks,
            trashedBookmarks: trashedChanged ? newTrashed : state.trashedBookmarks,
          };
```

- [ ] **Step 2: Type-check and commit**

```bash
bun run compile && git add store/bookmarks-store.ts && git commit -m "perf: stable array refs in mergeFromServer to avoid unnecessary useMemo recomputation"
```

---

## Task 7: Split `hydrate()` — lazy bookmark loading

**Files:**
- Modify: `store/bookmarks-store.ts`

This is the largest single task. It introduces `_archivedLoaded`, `_trashedLoaded`, `reloadActive()`, `loadArchivedBookmarks()`, and `loadTrashedBookmarks()`, and updates `mergeFromServer` and `reset()`.

- [ ] **Step 1: Extend `BookmarksState` interface** — add new fields and actions after `_hydrated: boolean;` (around line 87):

```ts
  _hydrated: boolean;
  _archivedLoaded: boolean;
  _trashedLoaded: boolean;
  hydrate: () => Promise<void>;
  reloadActive: () => Promise<void>;
  loadArchivedBookmarks: () => Promise<void>;
  loadTrashedBookmarks: () => Promise<void>;
  pruneExpiredTrash: (graceDays: number) => void;
  reset: () => void;
```

(Remove the existing `hydrate: () => Promise<void>;` and `reset: () => void;` lines since they are re-listed above.)

- [ ] **Step 2: Add initial state values** in the `create()` call (after `_hydrated: false,`):

```ts
      _hydrated: false,
      _archivedLoaded: false,
      _trashedLoaded: false,
```

- [ ] **Step 3: Replace `hydrate()` to only load active bookmarks**

Replace the entire `hydrate` action (lines 143–165):
```ts
      hydrate: async () => {
        const bookmarks = await idbGetAll<Bookmark>("bookmarks");
        const migrate = (b: Bookmark): Bookmark => {
          if (!b.favicon.startsWith("data:")) { return b; }
          const fixed = { ...b, favicon: normalizeFavicon(b.favicon, b.url) };
          idbPut("bookmarks", fixed);
          return fixed;
        };
        set({
          bookmarks: bookmarks.map(migrate),
          _hydrated: true,
        });
      },
```

- [ ] **Step 4: Add `reloadActive`, `loadArchivedBookmarks`, `loadTrashedBookmarks`** immediately after `hydrate`:

```ts
      reloadActive: async () => {
        const bookmarks = await idbGetAll<Bookmark>("bookmarks");
        set({ bookmarks });
      },

      loadArchivedBookmarks: async () => {
        if (get()._archivedLoaded) { return; }
        const archived = await idbGetAll<Bookmark>("archived-bookmarks");
        const migrate = (b: Bookmark): Bookmark => {
          if (!b.favicon.startsWith("data:")) { return b; }
          const fixed = { ...b, favicon: normalizeFavicon(b.favicon, b.url) };
          idbPut("archived-bookmarks", fixed);
          return fixed;
        };
        set({ archivedBookmarks: archived.map(migrate), _archivedLoaded: true });
      },

      loadTrashedBookmarks: async () => {
        if (get()._trashedLoaded) { return; }
        const all = await idbGetAll<Bookmark>("trashed-bookmarks");
        const migrate = (b: Bookmark): Bookmark => {
          if (!b.favicon.startsWith("data:")) { return b; }
          const fixed = { ...b, favicon: normalizeFavicon(b.favicon, b.url) };
          idbPut("trashed-bookmarks", fixed);
          return fixed;
        };
        const migrated = all.map(migrate);
        // Grace-period expiry runs here (see Task 8 for the body).
        // For now just set state — Task 8 adds pruning.
        set({ trashedBookmarks: migrated, _trashedLoaded: true });
      },

      pruneExpiredTrash: (_graceDays: number) => {
        // Body filled in Task 8.
      },
```

- [ ] **Step 5: Update `reset()` to clear lazy-load flags** (lines 167–177):

```ts
      reset: () => {
        set({
          bookmarks: [],
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

- [ ] **Step 6: Update `mergeFromServer` to skip in-memory updates for unloaded buckets**

Inside `mergeFromServer`'s `set((state) => { ... })` return block, find the section added in Task 6 and wrap the archived/trashed builds with the loaded-flag guard:

```ts
          return {
            bookmarks: activeChanged ? newActive : state.bookmarks,
            // Only update in-memory if that bucket has been loaded by the
            // lazy loader. Otherwise return the same empty ref — the IDB write
            // below keeps data fresh for when the view eventually opens.
            archivedBookmarks: state._archivedLoaded
              ? (archivedChanged ? newArchived : state.archivedBookmarks)
              : state.archivedBookmarks,
            trashedBookmarks: state._trashedLoaded
              ? (trashedChanged ? newTrashed : state.trashedBookmarks)
              : state.trashedBookmarks,
          };
```

- [ ] **Step 7: Type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 8: Build verify**

```bash
bun run build
```

Expected: successful build.

- [ ] **Step 9: Commit**

```bash
git add store/bookmarks-store.ts
git commit -m "feat: lazy-load archived/trashed bookmarks, split hydrate into eager+lazy"
```

---

## Task 8: Trash grace-period expiry

**Files:**
- Modify: `store/bookmarks-store.ts`
- Modify: `store/plan-store.ts`

- [ ] **Step 1: Fill in `loadTrashedBookmarks` with grace-period pruning**

Replace the `loadTrashedBookmarks` stub body added in Task 7 with:
```ts
      loadTrashedBookmarks: async () => {
        if (get()._trashedLoaded) { return; }
        const all = await idbGetAll<Bookmark>("trashed-bookmarks");
        const migrate = (b: Bookmark): Bookmark => {
          if (!b.favicon.startsWith("data:")) { return b; }
          const fixed = { ...b, favicon: normalizeFavicon(b.favicon, b.url) };
          idbPut("trashed-bookmarks", fixed);
          return fixed;
        };
        const migrated = all.map(migrate);

        const graceDays = usePlanStore.getState().limits?.trash_grace_days ?? 30;
        const cutoff = Date.now() - graceDays * 86_400_000;
        const fresh = migrated.filter(b => !b.deletedAt || b.deletedAt > cutoff);
        const expired = migrated.filter(b => !!b.deletedAt && b.deletedAt <= cutoff);

        for (const b of expired) {
          void idbDelete("trashed-bookmarks", b.id);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(b, { isTrashed: 2 })] });
        }

        set({ trashedBookmarks: fresh, _trashedLoaded: true });
      },
```

- [ ] **Step 2: Fill in `pruneExpiredTrash`**

Replace the `pruneExpiredTrash` stub:
```ts
      pruneExpiredTrash: (graceDays: number) => {
        const cutoff = Date.now() - graceDays * 86_400_000;
        const { trashedBookmarks } = get();
        const expired = trashedBookmarks.filter(b => !!b.deletedAt && b.deletedAt <= cutoff);
        if (expired.length === 0) { return; }
        for (const b of expired) {
          void idbDelete("trashed-bookmarks", b.id);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(b, { isTrashed: 2 })] });
        }
        set(s => ({
          trashedBookmarks: s.trashedBookmarks.filter(
            b => !b.deletedAt || b.deletedAt > cutoff,
          ),
        }));
      },
```

- [ ] **Step 3: Call `pruneExpiredTrash` from `plan-store.ts` after a successful `fetchPlan`**

In `store/plan-store.ts`, add the bookmarks-store import at the top:
```ts
import { useBookmarksStore } from "@/store/bookmarks-store";
```

In `fetchPlan`, after the `set({ subscription, limits, usage, fetchedAt, isFetching: false })` call, add:
```ts
          // Prune expired trash entries now that we have an authoritative grace period.
          const bmStore = useBookmarksStore.getState();
          if (bmStore._trashedLoaded && data.limits.trash_grace_days > 0) {
            bmStore.pruneExpiredTrash(data.limits.trash_grace_days);
          }
```

- [ ] **Step 4: Type-check and commit**

```bash
bun run compile && git add store/bookmarks-store.ts store/plan-store.ts && git commit -m "feat: auto-prune expired trash entries using trash_grace_days plan limit"
```

---

## Task 9: Wire up components and fix BOOKMARKS_CHANGED

**Files:**
- Modify: `entrypoints/newtab/App.tsx`
- Modify: `components/dashboard/archive-content.tsx`
- Modify: `components/dashboard/trash-content.tsx`

- [ ] **Step 1: Update `BOOKMARKS_CHANGED` handler in `App.tsx`** (lines 273–275):

```ts
      if (message.type === "BOOKMARKS_CHANGED") {
        void useBookmarksStore.getState().reloadActive();
      }
```

- [ ] **Step 2: Add lazy load on mount in `ArchiveContent`**

In `components/dashboard/archive-content.tsx`, add a `useEffect` at the top of the `ArchiveContent` function body, before any existing effects. Add the import at the top if `useEffect` is not already imported:

```ts
  React.useEffect(() => {
    void useBookmarksStore.getState().loadArchivedBookmarks();
  }, []);
```

- [ ] **Step 3: Add lazy load on mount in `TrashContent`**

In `components/dashboard/trash-content.tsx`, add a `useEffect` at the top of the `TrashContent` function body:

```ts
  React.useEffect(() => {
    void useBookmarksStore.getState().loadTrashedBookmarks();
  }, []);
```

- [ ] **Step 4: Type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 5: Manual integration test**

Load the extension in Chrome (Developer mode → Load unpacked → `dist/` after `bun run build`):
1. Open a new tab (newtab). Open DevTools → Memory → Take heap snapshot.
2. Navigate to `/archive` — verify archived bookmarks appear.
3. Navigate to `/trash` — verify trashed bookmarks appear.
4. Use the context menu "Save to TabSlate" on any page while newtab is open — verify the bookmark appears without a page reload.
5. Take a second heap snapshot. For a library with archived/trashed bookmarks, confirmed memory from the first snapshot should be lower than before this change.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/newtab/App.tsx components/dashboard/archive-content.tsx components/dashboard/trash-content.tsx
git commit -m "feat: wire lazy bookmark loading on route mount, fix BOOKMARKS_CHANGED to not reload archived/trashed"
```

---

## Task 10: Backend `is_default` field + frontend types + workspace-store

**Files (TabSlate-server):**
- Modify: `TabSlate-server/internal/model/model.go`
- Modify: `TabSlate-server/internal/handler/sync.go`

**Files (TabSlate):**
- Modify: `lib/api.ts`
- Modify: `store/workspace-store.ts`

### 10a — Server changes

- [ ] **Step 1: Add `IsDefault` to `model.Collection`** in `internal/model/model.go` after `IsDeleted`:

```go
// Collection is a folder of bookmarks inside a workspace.
type Collection struct {
	ID          string  `json:"id"`
	UserID      string  `json:"user_id"`
	WorkspaceID *string `json:"workspace_id"`
	Name        string  `json:"name"`
	Icon        string  `json:"icon,omitempty"`
	Position    int     `json:"position"`
	CreatedAt   int64   `json:"created_at"`
	UpdatedAt   int64   `json:"updated_at"`
	Seq         int64   `json:"seq"`
	DeletedAt   *int64  `json:"deleted_at,omitempty"`
	ArchivedAt  *int64  `json:"archived_at,omitempty"`
	IsDeleted   int     `json:"is_deleted"`
	IsDefault   bool    `json:"is_default"`
}
```

- [ ] **Step 2: Replace the collections query in the `Pull` handler** (`internal/handler/sync.go`, lines 323–345):

```go
	// Collections — is_default is computed via CTE: among active (non-deleted,
	// non-archived) collections per workspace, the one with the lowest position
	// is flagged as the default. This is a response-time annotation; no DB column.
	colRows, err := h.db.Query(ctx,
		h.db.Rebind(`
			WITH min_pos AS (
				SELECT workspace_id, MIN(position) AS min_position
				FROM collections
				WHERE user_id = ? AND workspace_id IS NOT NULL
				  AND deleted_at IS NULL AND archived_at IS NULL AND is_deleted = 0
				GROUP BY workspace_id
			)
			SELECT c.id, c.user_id, c.workspace_id, c.name, c.icon, c.position,
			       c.seq, c.deleted_at, c.archived_at, c.is_deleted, c.created_at, c.updated_at,
			       (c.deleted_at IS NULL AND c.archived_at IS NULL AND c.is_deleted = 0
			        AND m.min_position IS NOT NULL AND c.position = m.min_position) AS is_default
			FROM collections c
			LEFT JOIN min_pos m ON m.workspace_id = c.workspace_id
			WHERE c.user_id = ? AND c.seq > ?
			ORDER BY c.seq ASC`),
		userID, userID, afterSeq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "collections query failed"})
		return
	}
	defer colRows.Close()
	for colRows.Next() {
		var col model.Collection
		if err := colRows.Scan(&col.ID, &col.UserID, &col.WorkspaceID, &col.Name, &col.Icon, &col.Position,
			&col.Seq, &col.DeletedAt, &col.ArchivedAt, &col.IsDeleted, &col.CreatedAt, &col.UpdatedAt,
			&col.IsDefault); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "collection scan failed"})
			return
		}
		resp.Entities.Collections = append(resp.Entities.Collections, col)
	}
	if err := colRows.Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "collections iteration failed"})
		return
	}
```

- [ ] **Step 3: Build and test the server**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
go vet ./...
go test ./...
```

Expected: all pass with no compilation errors.

- [ ] **Step 4: Commit server changes**

```bash
git add internal/model/model.go internal/handler/sync.go
git commit -m "feat: add is_default computed field to collection pull response"
```

### 10b — Frontend changes

- [ ] **Step 5: Add `is_default` to `ServerCollection`** in `lib/api.ts` (after the existing `is_deleted` line):

```ts
export interface ServerCollection {
  id: string;
  user_id: string;
  workspace_id?: string;
  name: string;
  icon?: string;
  position: number;
  seq: number;
  is_deleted: number;
  is_default?: boolean;    // computed by server: true for the lowest-position active collection per workspace
  deleted_at?: number;
  archived_at?: number;
  created_at: number;
  updated_at: number;
}
```

- [ ] **Step 6: Replace `hydrate()` repair block in `workspace-store.ts`** (lines 188–203):

Remove the `missingDefaults` block entirely. Replace it with the lightweight offline fallback that does not create new collections or write to IDB:

```ts
    // Offline fallback: if a workspace has no isDefault collection in local IDB data,
    // flag the lowest-position active one temporarily. This is overwritten on the next
    // pull once the server confirms the real is_default value.
    for (const ws of workspaces) {
      const wsCols = collections.filter(
        c => c.workspaceId === ws.id && !c.deletedAt && !c.archivedAt,
      );
      if (!wsCols.some(c => c.isDefault) && wsCols.length > 0) {
        const first = [...wsCols].sort((a, b) => a.position - b.position)[0];
        const idx = collections.findIndex(c => c.id === first.id);
        if (idx !== -1) { collections[idx] = { ...collections[idx], isDefault: true }; }
      }
    }
```

- [ ] **Step 7: Update `mergeFromServer` in `workspace-store.ts` to read `sc.is_default`**

In the active collection upsert path (insert branch, after line 329):
```ts
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
```

In the active collection upsert path (update branch, `collections[idx] = ...` around line 346):
```ts
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
```

In the `deleted_at` (soft-deleted) collection branch (insert path, around line 316):
```ts
            collections.push({
              id: sc.id,
              workspaceId: sc.workspace_id ?? "",
              name: sc.name,
              icon: sc.icon ?? "folder",
              position: sc.position,
              seq: sc.seq,
              isDefault: false,   // trashed collections are never the default
              deletedAt: sc.deleted_at,
            });
```

- [ ] **Step 8: Remove the `isDefault` repair block from `mergeFromServer`** (lines 362–371):

Delete this entire block:
```ts
      // Restore isDefault: for each workspace that has no default collection,
      // mark the lowest-position collection as default (mirrors createWorkspace logic).
      // Exclude archived and trashed collections from candidacy.
      const workspaceIds = new Set(workspaces.map(w => w.id));
      workspaceIds.forEach(wsId => {
        const wsCols = collections.filter(c => c.workspaceId === wsId && !c.deletedAt && !c.archivedAt);
        const hasDefault = wsCols.some(c => c.isDefault);
        if (!hasDefault && wsCols.length > 0) {
          const firstCol = [...wsCols].sort((a, b) => a.position - b.position)[0];
          const idx = collections.findIndex(c => c.id === firstCol.id);
          if (idx !== -1) { collections[idx] = { ...collections[idx], isDefault: true }; }
        }
      });
```

- [ ] **Step 9: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no errors.

- [ ] **Step 10: Build verify**

```bash
bun run build
```

Expected: successful build.

- [ ] **Step 11: Manual integration test**

With both server and extension running:
1. Open a new tab. Confirm the default collection in the sidebar is selected.
2. Create a new workspace. Confirm it gets a default "Default" collection.
3. Delete all non-default collections from a workspace. Confirm the remaining one is still shown as default in the sidebar.
4. Sync from a second browser profile — confirm `is_default` from the server is applied correctly.

- [ ] **Step 12: Commit frontend changes**

```bash
git add lib/api.ts store/workspace-store.ts
git commit -m "feat: read is_default from server pull response, remove client-side isDefault repair logic"
```

---

## Self-Review Checklist

- [x] **Task 1** covers `idbBulkWrite` (spec Section 2a foundation)
- [x] **Task 2–3** covers `guardQuota` (spec Section 4a)
- [x] **Task 4** covers `deletedAt` fix + `toServerBookmark` fix + batch IDB + merged enqueue (spec Sections 1b prereq, 2a, 2b)
- [x] **Task 5** covers `buildTabsByGroup` (spec Section 2c)
- [x] **Task 6** covers stable refs (spec Section 4b)
- [x] **Task 7** covers `hydrate()` split + lazy loaders + lazy `mergeFromServer` + `_archivedLoaded`/`_trashedLoaded` (spec Section 1a)
- [x] **Task 8** covers grace-period expiry in `loadTrashedBookmarks` + `pruneExpiredTrash` + plan-store hook (spec Section 1b)
- [x] **Task 9** covers component mount effects + `BOOKMARKS_CHANGED` fix (spec Section 1a wiring)
- [x] **Task 10** covers server `is_default` + `ServerCollection` type + `workspace-store` cleanup (spec Section 3)
- [x] No "TBD" or incomplete stubs remain — Task 7 stubs are filled in Task 8
- [x] `idbBulkWrite` used in Task 4; `BulkWriteOp` type exported from `lib/idb.ts` in Task 1
- [x] `guardQuota` defined in Task 2, imported in Task 3; import line shown explicitly
- [x] `reloadActive` defined in Task 7, consumed in Task 9
- [x] `loadArchivedBookmarks` / `loadTrashedBookmarks` defined in Task 7, wired in Task 9
- [x] `pruneExpiredTrash` stub in Task 7, filled in Task 8, called from plan-store in Task 8
- [x] Server `is_default` boolean added in Task 10a; frontend type and usage in Task 10b
