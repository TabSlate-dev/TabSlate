# Collection Soft-Delete & Archive Design

**Date:** 2026-05-03
**Status:** Approved

## Problem

Two issues with the current collection delete flow:

1. **Reappear bug**: `deleteCollection` calls `idbDelete("collections", id)` immediately, discarding the local tombstone. If the sync push hasn't reached the server before the user re-logs in (offline, page closed, token expired), the next full pull restores the collection from server.

2. **Bad UX on delete**: All bookmarks in the deleted collection are moved to the default collection (`reassignCollection`). Users cannot recover the collection with its original structure. Two separate pushes (tombstone + bookmark updates) are not atomic, causing further inconsistency.

## Solution

Implement soft-delete and archive for collections, mirroring how bookmarks already work (`is_archived`, `is_trashed`). Both states:
- Persist the collection in IDB (not hard-deleted) until server confirms
- Batch-move all active bookmarks into the matching state (preserving `collectionId`)
- Display archived/trashed collection cards in the Archive/Trash pages with one-click full restore

## Repos Affected

| Repo | Changes |
|---|---|
| `TabSlate-server` | Schema: add `archived_at` to collections; model + sync handler update |
| `TabSlate` | Types, stores, sync merge logic, UI |

---

## Data Layer

### Server — `schema.sql`

```sql
ALTER TABLE collections ADD COLUMN archived_at INTEGER;
```

### Server — `model.go`

```go
type Collection struct {
    // ... existing fields ...
    ArchivedAt *int64 `json:"archived_at,omitempty"`
}
```

### Server — `sync.go` (push handler)

Collection upsert SQL gains `archived_at` in both INSERT columns and UPDATE SET:

```sql
INSERT INTO collections (id, user_id, workspace_id, name, icon, position, seq, deleted_at, archived_at, created_at, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
ON CONFLICT (id) DO UPDATE
  SET workspace_id=$3, name=$4, icon=$5, position=$6, seq=$7, deleted_at=$8, archived_at=$9, updated_at=$10
WHERE collections.user_id = $2 AND collections.updated_at < $10
```

Pull query already returns all columns via the existing SELECT; no change needed there.

### Client — `lib/types.ts`

```ts
export interface Collection {
  id: string;
  workspaceId: string;
  name: string;
  icon: string;
  position: number;
  isDefault?: boolean;
  seq: number;
  deletedAt?: number;   // unix ms — trashed; undefined = not trashed
  archivedAt?: number;  // unix ms — archived; undefined = not archived
}
```

**Three states:**

| `deletedAt` | `archivedAt` | Meaning |
|---|---|---|
| undefined | undefined | Active — shown in Sidebar |
| undefined | set | Archived — shown in Archive page |
| set | any | Trashed — shown in Trash page |

### Client — `toServerCollection`

```ts
function toServerCollection(c: Collection): object {
  return {
    id: c.id,
    workspace_id: c.workspaceId !== "" ? c.workspaceId : null,
    name: c.name,
    icon: c.icon,
    position: c.position,
    seq: c.seq,
    deleted_at: c.deletedAt ?? null,
    archived_at: c.archivedAt ?? null,
    updated_at: Date.now(),
  };
}
```

---

## Store Layer

### `workspace-store.ts`

#### `archiveCollection(id)`

```ts
archiveCollection: (id) => {
  const col = get().collections.find(c => c.id === id && !c.isDefault);
  if (!col) return;
  const archived = { ...col, archivedAt: Date.now() };
  idbPut("collections", archived);
  syncEngine?.enqueue({ collections: [toServerCollection(archived)] });
  set(s => ({ collections: s.collections.map(c => c.id === id ? archived : c) }));
  useBookmarksStore.getState().archiveCollectionBookmarks(id);
},
```

#### `deleteCollection(id)` — rewritten

```ts
deleteCollection: (id) => {
  const col = get().collections.find(c => c.id === id && !c.isDefault);
  if (!col) return;
  const trashed = { ...col, deletedAt: Date.now() };
  idbPut("collections", trashed);          // soft-delete: stays in IDB
  syncEngine?.enqueue({ collections: [toServerCollection(trashed)] });
  set(s => ({ collections: s.collections.map(c => c.id === id ? trashed : c) }));
  useBookmarksStore.getState().trashCollectionBookmarks(id);
},
```

#### `restoreCollection(id)`

```ts
restoreCollection: (id) => {
  const col = get().collections.find(c => c.id === id);
  if (!col) return;
  const restored = { ...col, deletedAt: undefined, archivedAt: undefined };
  idbPut("collections", restored);
  syncEngine?.enqueue({ collections: [toServerCollection(restored)] });
  set(s => ({ collections: s.collections.map(c => c.id === id ? restored : c) }));
  useBookmarksStore.getState().restoreCollectionBookmarks(id);
},
```

#### `permanentlyDeleteCollection(id)`

Only callable from Trash page. Hard-deletes collection and all its trashed bookmarks.

```ts
permanentlyDeleteCollection: (id) => {
  const col = get().collections.find(c => c.id === id && !!c.deletedAt);
  if (!col) return;
  // tombstone with deletedAt already set — just remove from IDB
  idbDelete("collections", id);
  set(s => ({ collections: s.collections.filter(c => c.id !== id) }));
  useBookmarksStore.getState().permanentlyDeleteCollectionBookmarks(id);
},
```

#### `getWorkspaceCollections` — filter update

```ts
getWorkspaceCollections: (workspaceId) => {
  const state = get();
  const wsId = workspaceId ?? state.activeWorkspaceId;
  return state.collections
    .filter(c => c.workspaceId === wsId && !c.deletedAt && !c.archivedAt)
    .sort((a, b) => a.position - b.position);
},
```

#### Interface additions

```ts
archiveCollection: (id: string) => void;
restoreCollection: (id: string) => void;
permanentlyDeleteCollection: (id: string) => void;
getArchivedCollections: () => Collection[];
getTrashedCollections: () => Collection[];
```

#### `getArchivedCollections` / `getTrashedCollections`

```ts
getArchivedCollections: () =>
  get().collections.filter(c => !!c.archivedAt && !c.deletedAt),

getTrashedCollections: () =>
  get().collections.filter(c => !!c.deletedAt),
```

### `bookmarks-store.ts`

Remove `reassignCollection`. Add four batch operations:

#### `archiveCollectionBookmarks(collectionId)`

```ts
archiveCollectionBookmarks: (collectionId) => {
  const affected = get().bookmarks.filter(b => b.collectionId === collectionId);
  if (affected.length === 0) return;
  for (const b of affected) {
    idbDelete("bookmarks", b.id);
    idbPut("archived-bookmarks", b);  // preserves collectionId
  }
  syncEngine?.enqueue({ bookmarks: affected.map(b => toServerBookmark(b, { isArchived: true })) });
  set(s => ({
    bookmarks: s.bookmarks.filter(b => b.collectionId !== collectionId),
    archivedBookmarks: [...s.archivedBookmarks, ...affected],
  }));
},
```

#### `trashCollectionBookmarks(collectionId)`

Same pattern but targets `trashed-bookmarks`.

```ts
trashCollectionBookmarks: (collectionId) => {
  const affected = get().bookmarks.filter(b => b.collectionId === collectionId);
  if (affected.length === 0) return;
  for (const b of affected) {
    idbDelete("bookmarks", b.id);
    idbPut("trashed-bookmarks", b);
  }
  syncEngine?.enqueue({ bookmarks: affected.map(b => toServerBookmark(b, { isTrashed: true })) });
  set(s => ({
    bookmarks: s.bookmarks.filter(b => b.collectionId !== collectionId),
    trashedBookmarks: [...s.trashedBookmarks, ...affected],
  }));
},
```

#### `restoreCollectionBookmarks(collectionId)`

Restores all archived **and** trashed bookmarks matching `collectionId` back to active. This intentionally restores everything in the collection regardless of whether individual bookmarks were archived/trashed before the collection was.

```ts
restoreCollectionBookmarks: (collectionId) => {
  const fromArchive = get().archivedBookmarks.filter(b => b.collectionId === collectionId);
  const fromTrash = get().trashedBookmarks.filter(b => b.collectionId === collectionId);
  const all = [...fromArchive, ...fromTrash];
  if (all.length === 0) return;
  for (const b of all) {
    idbDelete("archived-bookmarks", b.id);
    idbDelete("trashed-bookmarks", b.id);
    idbPut("bookmarks", b);
  }
  syncEngine?.enqueue({ bookmarks: all.map(b => toServerBookmark(b)) });
  set(s => ({
    archivedBookmarks: s.archivedBookmarks.filter(b => b.collectionId !== collectionId),
    trashedBookmarks: s.trashedBookmarks.filter(b => b.collectionId !== collectionId),
    bookmarks: [...s.bookmarks, ...all],
  }));
},
```

#### `permanentlyDeleteCollectionBookmarks(collectionId)`

Hard-deletes all trashed bookmarks in the collection.

```ts
permanentlyDeleteCollectionBookmarks: (collectionId) => {
  const affected = get().trashedBookmarks.filter(b => b.collectionId === collectionId);
  for (const b of affected) {
    syncEngine?.enqueue({ bookmarks: [toServerBookmark({ ...b, deletedAt: Date.now() })] });
    idbDelete("trashed-bookmarks", b.id);
  }
  set(s => ({
    trashedBookmarks: s.trashedBookmarks.filter(b => b.collectionId !== collectionId),
  }));
},
```

---

## Sync Layer

### `mergeFromServer` — collection processing (workspace-store)

**Rule: local pending tombstone wins over server alive state.**

A collection is "pending" when `seq === 0` (not yet acknowledged by server) and `deletedAt` or `archivedAt` is set.

```ts
for (const sc of resp.entities.collections) {
  if (sc.deleted_at) {
    // Server confirmed delete — clean up IDB and state
    collections = collections.filter(c => c.id !== sc.id);
    idbDelete("collections", sc.id);
  } else {
    const idx = collections.findIndex(c => c.id === sc.id);
    if (idx === -1) {
      collections.push({
        id: sc.id, name: sc.name, icon: sc.icon ?? "folder",
        workspaceId: sc.workspace_id ?? "", position: sc.position, seq: sc.seq,
        archivedAt: sc.archived_at ?? undefined,
      });
      idbPut("collections", collections[collections.length - 1]);
    } else {
      // Local pending soft-delete/archive takes priority
      const local = collections[idx];
      if ((local.deletedAt || local.archivedAt) && local.seq === 0) {
        continue;
      }
      collections[idx] = {
        ...local,
        name: sc.name, icon: sc.icon ?? local.icon,
        position: sc.position, seq: sc.seq,
        archivedAt: sc.archived_at ?? undefined,
      };
      idbPut("collections", collections[idx]);
    }
  }
}
```

### `sweepUnsynced` — no change needed

Soft-deleted/archived collections remain in `get().collections` with `seq === 0`, so they are swept automatically by the existing `collections.filter(c => c.seq === 0)` check.

---

## UI Layer

### `sidebar/index.tsx` — collection menu

Replace the inline trash icon button with a `DropdownMenu` triggered by a `⋯` icon on hover:

```
┌──────────────────────────────┐
│ 📁 Collection name       12 ⋯ │
└──────────────────────────────┘
         ↓ ⋯ opens:
  ┌──────────────────┐
  │ Archive          │
  │ ──────────────── │
  │ Delete           │  ← destructive color
  └──────────────────┘
```

- **Archive** → `archiveCollection(col.id)`
- **Delete** → `deleteCollection(col.id)` (now soft-trash)
- Default collection: menu not shown (already guarded by `!col.isDefault`)

### `archive-content.tsx`

Add `ArchivedCollectionCard` component. Render all archived collections above individual archived bookmarks.

```
[ArchivedCollectionCard for each getArchivedCollections()]
  - Collection icon + name
  - "{n} bookmarks" subtitle
  - [Restore] button → restoreCollection(id)

[Existing ArchivedBookmarkCard list — filtered to exclude bookmarks
 whose collectionId belongs to an archived collection]
```

Individual bookmark filter: exclude bookmarks where their `collectionId` belongs to an archived collection (they will be shown as part of the collection card instead).

### `trash-content.tsx`

Same pattern with `TrashedCollectionCard`:

```
[TrashedCollectionCard for each getTrashedCollections()]
  - Collection icon + name
  - "{n} bookmarks" subtitle
  - [Restore] button → restoreCollection(id)
  - [Delete Permanently] (destructive) → permanentlyDeleteCollection(id)

[Existing TrashedBookmarkCard list — filtered to exclude bookmarks
 whose collectionId belongs to a trashed collection]
```

---

## Files Changed

### `TabSlate-server`

| File | Change |
|---|---|
| `schema.sql` | Add `archived_at INTEGER` to `collections` |
| `db/schema.pg.sql` | Same for PostgreSQL variant |
| `internal/model/model.go` | Add `ArchivedAt *int64` to `Collection` struct |
| `internal/handler/sync.go` | Update collection upsert SQL to include `archived_at` |

### `TabSlate`

| File | Change |
|---|---|
| `lib/types.ts` | Add `archivedAt?: number` to `Collection` |
| `store/workspace-store.ts` | Add `archiveCollection`, `restoreCollection`, `permanentlyDeleteCollection`, `getArchivedCollections`, `getTrashedCollections`; rewrite `deleteCollection`; update `getWorkspaceCollections`, `toServerCollection`, `mergeFromServer` |
| `store/bookmarks-store.ts` | Add `archiveCollectionBookmarks`, `trashCollectionBookmarks`, `restoreCollectionBookmarks`, `permanentlyDeleteCollectionBookmarks`; remove `reassignCollection` |
| `components/dashboard/sidebar/index.tsx` | Replace inline trash button with `⋯` dropdown menu |
| `components/dashboard/archive-content.tsx` | Add `ArchivedCollectionCard`; filter individual bookmarks |
| `components/dashboard/trash-content.tsx` | Add `TrashedCollectionCard`; filter individual bookmarks |

## Out of Scope

- Archiving/trashing individual bookmarks that belong to an archived/trashed collection from the main view (they are already hidden because their collection is hidden)
- Quota count logic on the server for archived collections (currently only counts `deleted_at IS NULL`)
- Bulk restore/delete of multiple collections at once
