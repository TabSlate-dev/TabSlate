# Collection Soft-Delete & Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the collection reappear-after-login bug and add archive/trash semantics for collections with one-click full restore in Archive/Trash pages.

**Architecture:** Server gains `archived_at` on collections (mirrors `deleted_at`). Collections are soft-deleted/archived in local state and IDB (never hard-deleted until server confirms). `mergeFromServer` lets local pending tombstones win over server alive state. Archive and Trash pages render collection cards with batch bookmark restore/delete.

**Tech Stack:** Go (TabSlate-server), TypeScript + React + Zustand + IndexedDB (TabSlate)

---

## File Map

### TabSlate-server
| File | Change |
|---|---|
| `schema.sql` | Add `archived_at INTEGER` column to `collections` |
| `db/schema.pg.sql` | Add `archived_at BIGINT` column to `collections` |
| `internal/model/model.go` | Add `ArchivedAt *int64` to `Collection` struct |
| `internal/handler/sync.go` | Update push upsert SQL + pull SELECT + Scan for `archived_at` |

### TabSlate
| File | Change |
|---|---|
| `lib/types.ts` | Add `archivedAt?: number` to `Collection` interface |
| `lib/api.ts` | Add `archived_at?: number` to `ServerCollection` interface |
| `store/workspace-store.ts` | `toServerCollection` + new actions + updated merge + computed |
| `store/bookmarks-store.ts` | Remove `reassignCollection`, add 4 batch collection ops |
| `components/dashboard/sidebar/index.tsx` | Replace trash icon button with Archive/Delete dropdown |
| `components/dashboard/archive-content.tsx` | Add `ArchivedCollectionCard` component |
| `components/dashboard/trash-content.tsx` | Add `TrashedCollectionCard` component |

---

## Task 1: Server — Schema + Model

**Files:**
- Modify: `TabSlate-server/schema.sql`
- Modify: `TabSlate-server/db/schema.pg.sql`
- Modify: `TabSlate-server/internal/model/model.go`

- [ ] **Step 1: Add `archived_at` to SQLite schema**

In `TabSlate-server/schema.sql`, find the `CREATE TABLE IF NOT EXISTS collections` block and add `archived_at INTEGER` after `deleted_at`:

```sql
CREATE TABLE IF NOT EXISTS collections (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,
    icon         TEXT,
    position     INTEGER NOT NULL DEFAULT 0,
    seq          INTEGER NOT NULL DEFAULT 0,
    deleted_at   INTEGER,
    archived_at  INTEGER,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
```

> Note: the existing schema may not have `seq` and `deleted_at` in the `CREATE TABLE` block (they were added via ALTER TABLE in a migration). The schema file is for fresh installs. Add `archived_at INTEGER` after whatever the last column is before `created_at`. Check the exact current content and insert accordingly.

- [ ] **Step 2: Add `archived_at` to PostgreSQL schema**

In `TabSlate-server/db/schema.pg.sql`, same position in the collections table:

```sql
    archived_at  BIGINT,
```

- [ ] **Step 3: Add `ArchivedAt` to Collection model**

In `TabSlate-server/internal/model/model.go`, find the `Collection` struct and add the field after `DeletedAt`:

```go
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
}
```

- [ ] **Step 4: Build to verify**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
```

Expected: no output (success). Fix any compile errors before proceeding.

- [ ] **Step 5: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add schema.sql db/schema.pg.sql internal/model/model.go
git commit -m "feat: add archived_at to collections schema and model"
```

---

## Task 2: Server — Sync Push + Pull

**Files:**
- Modify: `TabSlate-server/internal/handler/sync.go`

- [ ] **Step 1: Update collection push upsert SQL**

Find the collection upsert block in `Push()` (search for `INSERT INTO collections`). Replace it:

```go
tag, err := tx.Exec(ctx, `
    INSERT INTO collections (id, user_id, workspace_id, name, icon, position, seq, deleted_at, archived_at, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
    ON CONFLICT (id) DO UPDATE
      SET workspace_id=$3, name=$4, icon=$5, position=$6, seq=$7, deleted_at=$8, archived_at=$9, updated_at=$10
    WHERE collections.user_id = $2 AND collections.updated_at < $10`,
    col.ID, userID, col.WorkspaceID, col.Name, col.Icon, col.Position, seq, col.DeletedAt, col.ArchivedAt, now)
```

Note: parameter count increases by one (`$9` = `archived_at`, `$10` = `now`). The old `$9` (now) becomes `$10`.

Also update the quota check condition — archived collections should not count toward the quota (only `deleted_at IS NULL AND archived_at IS NULL`):

```go
if err := tx.QueryRow(ctx,
    `SELECT COUNT(*) FROM collections WHERE user_id = $1 AND deleted_at IS NULL AND archived_at IS NULL`,
    userID,
).Scan(&count); err != nil {
```

- [ ] **Step 2: Update collection pull SELECT + Scan**

Find the collection pull block in `Pull()` (search for `SELECT id, user_id, workspace_id`). Replace the query and scan:

```go
colRows, err := h.db.Query(ctx,
    `SELECT id, user_id, workspace_id, name, icon, position, seq, deleted_at, archived_at, created_at, updated_at
     FROM collections WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC`,
    userID, afterSeq)
```

And the scan inside the loop:

```go
var col model.Collection
if err := colRows.Scan(&col.ID, &col.UserID, &col.WorkspaceID, &col.Name, &col.Icon, &col.Position,
    &col.Seq, &col.DeletedAt, &col.ArchivedAt, &col.CreatedAt, &col.UpdatedAt); err != nil {
    c.JSON(http.StatusInternalServerError, gin.H{"error": "collection scan failed"})
    return
}
```

- [ ] **Step 3: Build to verify**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add internal/handler/sync.go
git commit -m "feat: sync push/pull handles archived_at on collections"
```

---

## Task 3: Client — Types

**Files:**
- Modify: `TabSlate/lib/types.ts`
- Modify: `TabSlate/lib/api.ts`

- [ ] **Step 1: Add `archivedAt` to Collection type**

In `lib/types.ts`, find the `Collection` interface and add `archivedAt` after `deletedAt`:

```ts
export interface Collection {
  id: string;
  workspaceId: string;
  name: string;
  icon: string;
  position: number;
  isDefault?: boolean;
  seq: number;
  deletedAt?: number;
  archivedAt?: number;  // unix ms; undefined = active, set = archived
}
```

- [ ] **Step 2: Add `archived_at` to ServerCollection**

In `lib/api.ts`, find `ServerCollection` and add `archived_at` after `deleted_at`:

```ts
export interface ServerCollection {
  id: string;
  user_id: string;
  workspace_id?: string;
  name: string;
  icon?: string;
  position: number;
  seq: number;
  deleted_at?: number;
  archived_at?: number;
  created_at: number;
  updated_at: number;
}
```

- [ ] **Step 3: Update `toServerCollection` in workspace-store**

In `store/workspace-store.ts`, find `toServerCollection` (line ~61) and add `archived_at`:

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

- [ ] **Step 4: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add lib/types.ts lib/api.ts store/workspace-store.ts
git commit -m "feat: add archivedAt to Collection type and ServerCollection API type"
```

---

## Task 4: Client — workspace-store New Actions

**Files:**
- Modify: `store/workspace-store.ts`

This task adds the new collection actions and updates existing logic. Edit the `WorkspaceState` interface and the store implementation.

- [ ] **Step 1: Extend `WorkspaceState` interface**

Find the `interface WorkspaceState` block. Add after `deleteCollection`:

```ts
archiveCollection: (id: string) => void;
restoreCollection: (id: string) => void;
permanentlyDeleteCollection: (id: string) => void;
getArchivedCollections: () => Collection[];
getTrashedCollections: () => Collection[];
```

- [ ] **Step 2: Rewrite `deleteCollection` (soft-trash)**

Find the existing `deleteCollection` implementation and replace it entirely:

```ts
deleteCollection: (id) => {
  const col = get().collections.find(c => c.id === id && !c.isDefault);
  if (!col) { return; }
  const trashed = { ...col, deletedAt: Date.now() };
  idbPut("collections", trashed);
  syncEngine?.enqueue({ collections: [toServerCollection(trashed)] });
  set((s) => ({ collections: s.collections.map(c => c.id === id ? trashed : c) }));
  useBookmarksStore.getState().trashCollectionBookmarks(id);
},
```

- [ ] **Step 3: Add `archiveCollection`**

Add after `deleteCollection`:

```ts
archiveCollection: (id) => {
  const col = get().collections.find(c => c.id === id && !c.isDefault);
  if (!col) { return; }
  const archived = { ...col, archivedAt: Date.now() };
  idbPut("collections", archived);
  syncEngine?.enqueue({ collections: [toServerCollection(archived)] });
  set((s) => ({ collections: s.collections.map(c => c.id === id ? archived : c) }));
  useBookmarksStore.getState().archiveCollectionBookmarks(id);
},
```

- [ ] **Step 4: Add `restoreCollection`**

Add after `archiveCollection`:

```ts
restoreCollection: (id) => {
  const col = get().collections.find(c => c.id === id);
  if (!col) { return; }
  const restored = { ...col, deletedAt: undefined, archivedAt: undefined };
  idbPut("collections", restored);
  syncEngine?.enqueue({ collections: [toServerCollection(restored)] });
  set((s) => ({ collections: s.collections.map(c => c.id === id ? restored : c) }));
  useBookmarksStore.getState().restoreCollectionBookmarks(id);
},
```

- [ ] **Step 5: Add `permanentlyDeleteCollection`**

Add after `restoreCollection`:

```ts
permanentlyDeleteCollection: (id) => {
  const col = get().collections.find(c => c.id === id && !!c.deletedAt);
  if (!col) { return; }
  idbDelete("collections", id);
  set((s) => ({ collections: s.collections.filter(c => c.id !== id) }));
  useBookmarksStore.getState().permanentlyDeleteCollectionBookmarks(id);
},
```

- [ ] **Step 6: Update `getWorkspaceCollections` to exclude archived/trashed**

Find `getWorkspaceCollections` and update the filter:

```ts
getWorkspaceCollections: (workspaceId) => {
  const state = get();
  const wsId = workspaceId ?? state.activeWorkspaceId;
  return state.collections
    .filter((c) => c.workspaceId === wsId && !c.deletedAt && !c.archivedAt)
    .sort((a, b) => a.position - b.position);
},
```

- [ ] **Step 7: Add `getArchivedCollections` and `getTrashedCollections`**

Add after `getWorkspaceCollections`:

```ts
getArchivedCollections: () =>
  get().collections.filter(c => !!c.archivedAt && !c.deletedAt),

getTrashedCollections: () =>
  get().collections.filter(c => !!c.deletedAt),
```

- [ ] **Step 8: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add store/workspace-store.ts
git commit -m "feat(workspace-store): add archiveCollection, restoreCollection, soft-delete, computed getters"
```

---

## Task 5: Client — bookmarks-store Batch Operations

**Files:**
- Modify: `store/bookmarks-store.ts`

- [ ] **Step 1: Remove `reassignCollection` from interface**

Find `reassignCollection: (fromId: string, toId: string) => void;` in the `BookmarksState` interface and delete it.

- [ ] **Step 2: Add new batch action signatures to interface**

In the same interface, add after the existing individual bookmark actions:

```ts
archiveCollectionBookmarks: (collectionId: string) => void;
trashCollectionBookmarks: (collectionId: string) => void;
restoreCollectionBookmarks: (collectionId: string) => void;
permanentlyDeleteCollectionBookmarks: (collectionId: string) => void;
```

- [ ] **Step 3: Remove `reassignCollection` implementation**

Find and delete the `reassignCollection` implementation (the one that calls `syncEngine?.enqueue` for bookmarks with updated `collectionId`).

- [ ] **Step 4: Add `archiveCollectionBookmarks`**

Add after the existing `archiveBookmark` implementation:

```ts
archiveCollectionBookmarks: (collectionId) => {
  const affected = get().bookmarks.filter(b => b.collectionId === collectionId);
  if (affected.length === 0) { return; }
  for (const b of affected) {
    idbDelete("bookmarks", b.id);
    idbPut("archived-bookmarks", b);
  }
  syncEngine?.enqueue({ bookmarks: affected.map(b => toServerBookmark(b, { isArchived: true })) });
  set((s) => ({
    bookmarks: s.bookmarks.filter(b => b.collectionId !== collectionId),
    archivedBookmarks: [...s.archivedBookmarks, ...affected],
  }));
},
```

- [ ] **Step 5: Add `trashCollectionBookmarks`**

Add after `archiveCollectionBookmarks`:

```ts
trashCollectionBookmarks: (collectionId) => {
  const affected = get().bookmarks.filter(b => b.collectionId === collectionId);
  if (affected.length === 0) { return; }
  for (const b of affected) {
    idbDelete("bookmarks", b.id);
    idbPut("trashed-bookmarks", b);
  }
  syncEngine?.enqueue({ bookmarks: affected.map(b => toServerBookmark(b, { isTrashed: true })) });
  set((s) => ({
    bookmarks: s.bookmarks.filter(b => b.collectionId !== collectionId),
    trashedBookmarks: [...s.trashedBookmarks, ...affected],
  }));
},
```

- [ ] **Step 6: Add `restoreCollectionBookmarks`**

Add after `trashCollectionBookmarks`:

```ts
restoreCollectionBookmarks: (collectionId) => {
  const fromArchive = get().archivedBookmarks.filter(b => b.collectionId === collectionId);
  const fromTrash = get().trashedBookmarks.filter(b => b.collectionId === collectionId);
  const all = [...fromArchive, ...fromTrash];
  if (all.length === 0) { return; }
  for (const b of all) {
    idbDelete("archived-bookmarks", b.id);
    idbDelete("trashed-bookmarks", b.id);
    idbPut("bookmarks", b);
  }
  syncEngine?.enqueue({ bookmarks: all.map(b => toServerBookmark(b)) });
  set((s) => ({
    archivedBookmarks: s.archivedBookmarks.filter(b => b.collectionId !== collectionId),
    trashedBookmarks: s.trashedBookmarks.filter(b => b.collectionId !== collectionId),
    bookmarks: [...s.bookmarks, ...all],
  }));
},
```

- [ ] **Step 7: Add `permanentlyDeleteCollectionBookmarks`**

Add after `restoreCollectionBookmarks`:

```ts
permanentlyDeleteCollectionBookmarks: (collectionId) => {
  const affected = get().trashedBookmarks.filter(b => b.collectionId === collectionId);
  if (affected.length === 0) { return; }
  for (const b of affected) {
    syncEngine?.enqueue({ bookmarks: [toServerBookmark({ ...b, deletedAt: Date.now() })] });
    idbDelete("trashed-bookmarks", b.id);
  }
  set((s) => ({
    trashedBookmarks: s.trashedBookmarks.filter(b => b.collectionId !== collectionId),
  }));
},
```

- [ ] **Step 8: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: clean. If there are errors about `reassignCollection` being called somewhere, search for callers:

```bash
grep -rn "reassignCollection" /Users/lieutenant/Documents/github/TabSlate/
```

The only remaining caller should have been in `workspace-store.ts → deleteCollection` which was already replaced in Task 4.

- [ ] **Step 9: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add store/bookmarks-store.ts
git commit -m "feat(bookmarks-store): add collection batch ops, remove reassignCollection"
```

---

## Task 6: Client — mergeFromServer Fix (Reappear Bug)

**Files:**
- Modify: `store/workspace-store.ts`

This task fixes the core reappear bug: local pending soft-delete/archive wins over server alive state.

- [ ] **Step 1: Replace the collection loop inside `mergeFromServer`'s `set()` updater**

Find `mergeFromServer` in `workspace-store.ts`. Inside the `set((state) => { ... })` call, find the collection processing loop:

```ts
for (const sc of resp.entities.collections) {
  if (sc.deleted_at) {
    collections = collections.filter(c => c.id !== sc.id);
  } else {
    const idx = collections.findIndex(c => c.id === sc.id);
    if (idx === -1) {
      collections.push({ id: sc.id, workspaceId: sc.workspace_id ?? "", name: sc.name, icon: sc.icon ?? "folder", position: sc.position, seq: sc.seq });
    } else {
      collections[idx] = { ...collections[idx], name: sc.name, icon: sc.icon ?? collections[idx].icon, position: sc.position, seq: sc.seq, workspaceId: sc.workspace_id ?? collections[idx].workspaceId };
    }
  }
}
```

Replace it with:

```ts
for (const sc of resp.entities.collections) {
  if (sc.deleted_at) {
    // Server confirmed delete — remove from state (IDB cleanup happens below)
    collections = collections.filter(c => c.id !== sc.id);
  } else {
    const idx = collections.findIndex(c => c.id === sc.id);
    if (idx === -1) {
      collections.push({
        id: sc.id,
        workspaceId: sc.workspace_id ?? "",
        name: sc.name,
        icon: sc.icon ?? "folder",
        position: sc.position,
        seq: sc.seq,
        archivedAt: sc.archived_at ?? undefined,
      });
    } else {
      // Local pending soft-delete or archive (seq=0) wins over server alive state.
      // The tombstone will be re-pushed by sweepUnsynced on next sync cycle.
      const local = collections[idx];
      if ((local.deletedAt || local.archivedAt) && local.seq === 0) {
        continue;
      }
      collections[idx] = {
        ...local,
        name: sc.name,
        icon: sc.icon ?? local.icon,
        position: sc.position,
        seq: sc.seq,
        workspaceId: sc.workspace_id ?? local.workspaceId,
        archivedAt: sc.archived_at ?? undefined,
      };
    }
  }
}
```

- [ ] **Step 2: Update `isDefault` restoration to skip archived/trashed collections**

Still inside `mergeFromServer`'s `set()` updater, find the `isDefault` restoration block:

```ts
const workspaceIds = new Set(workspaces.map(w => w.id));
workspaceIds.forEach(wsId => {
  const wsCols = collections.filter(c => c.workspaceId === wsId);
  ...
```

Update the `wsCols` filter to only consider active collections:

```ts
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

- [ ] **Step 3: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add store/workspace-store.ts
git commit -m "fix(workspace-store): local pending tombstone wins in mergeFromServer, fixes reappear bug"
```

---

## Task 7: Client — Sidebar Archive/Delete Dropdown

**Files:**
- Modify: `components/dashboard/sidebar/index.tsx`

- [ ] **Step 1: Add missing imports**

In the `import` section at the top of `sidebar/index.tsx`, find the existing `lucide-react` import block and add `MoreHorizontal`:

```ts
import {
  // ... existing icons ...
  MoreHorizontal,
} from "lucide-react";
```

Add the `DropdownMenu` imports (after the existing UI component imports):

```ts
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```

- [ ] **Step 2: Pull `archiveCollection` from workspace-store**

Find the line:

```ts
const deleteCollection = useWorkspaceStore(s => s.deleteCollection);
```

Add below it:

```ts
const archiveCollection = useWorkspaceStore(s => s.archiveCollection);
```

- [ ] **Step 3: Update `workspaceCollections` memo to filter archived/trashed**

Find the `workspaceCollections` memo in the component:

```ts
const workspaceCollections = React.useMemo(
  () =>
    collections
      .filter((c) => c.workspaceId === activeWorkspaceId)
      .sort((a, b) => a.position - b.position),
  [collections, activeWorkspaceId]
);
```

Replace with:

```ts
const workspaceCollections = React.useMemo(
  () =>
    collections
      .filter((c) => c.workspaceId === activeWorkspaceId && !c.deletedAt && !c.archivedAt)
      .sort((a, b) => a.position - b.position),
  [collections, activeWorkspaceId]
);
```

- [ ] **Step 4: Replace inline trash button with dropdown**

Find the `{!col.isDefault && (` block that renders the inline trash `<button>`:

```tsx
{!col.isDefault && (
  <button
    onClick={(e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteCollection(col.id);
    }}
    className="flex items-center justify-center overflow-hidden opacity-0 -translate-x-2 w-0 group-hover/col:w-4 group-hover/col:mr-1 group-hover/col:opacity-100 group-hover/col:translate-x-0 text-muted-foreground hover:text-destructive transition-all duration-300 ease-out"
  >
    <Trash className="size-3 shrink-0" />
  </button>
)}
```

Replace it with:

```tsx
{!col.isDefault && (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
        className="flex items-center justify-center overflow-hidden opacity-0 -translate-x-2 w-0 group-hover/col:w-4 group-hover/col:mr-1 group-hover/col:opacity-100 group-hover/col:translate-x-0 text-muted-foreground hover:text-foreground transition-all duration-300 ease-out"
      >
        <MoreHorizontal className="size-3 shrink-0" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" side="right">
      <DropdownMenuItem
        onClick={(e) => { e.preventDefault(); archiveCollection(col.id); }}
      >
        <Archive className="size-4 mr-2" />
        Archive
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="text-destructive focus:text-destructive"
        onClick={(e) => { e.preventDefault(); deleteCollection(col.id); }}
      >
        <Trash2 className="size-4 mr-2" />
        Delete
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
)}
```

- [ ] **Step 5: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add components/dashboard/sidebar/index.tsx
git commit -m "feat(sidebar): replace trash icon with Archive/Delete dropdown on collection hover"
```

---

## Task 8: Client — Archive Page Collection Cards

**Files:**
- Modify: `components/dashboard/archive-content.tsx`

- [ ] **Step 1: Add new imports**

At the top of `archive-content.tsx`, add imports:

```ts
import { useWorkspaceStore } from "@/store/workspace-store";
import { CollectionIcon } from "@/components/dashboard/sidebar/collection-icon";
import type { Collection } from "@/lib/types";
```

> Check that `CollectionIcon` exists at that path. If it lives somewhere else, find it with `grep -rn "export.*CollectionIcon" /Users/lieutenant/Documents/github/TabSlate/components/`.

- [ ] **Step 2: Add `ArchivedCollectionCard` component**

Add this new component before the existing `ArchivedBookmarkCard`:

```tsx
function ArchivedCollectionCard({ collection, bookmarkCount }: { collection: Collection; bookmarkCount: number }) {
  const restoreCollection = useWorkspaceStore(s => s.restoreCollection);

  return (
    <div className="flex items-center gap-4 p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
      <div className="size-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <CollectionIcon icon={collection.icon} className="size-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-medium truncate">{collection.name}</h3>
        <p className="text-sm text-muted-foreground">
          {bookmarkCount} bookmark{bookmarkCount !== 1 ? "s" : ""}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => restoreCollection(collection.id)}>
        <RotateCcw className="size-4 mr-1" />
        Restore
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Update `ArchiveContent` to show collection cards and filter individual bookmarks**

Replace the `ArchiveContent` function body:

```tsx
export function ArchiveContent() {
  const { archivedBookmarks } = useBookmarksStore();
  const getArchivedCollections = useWorkspaceStore(s => s.getArchivedCollections);

  const archivedCollections = getArchivedCollections();
  const archivedCollectionIds = React.useMemo(
    () => new Set(archivedCollections.map(c => c.id)),
    [archivedCollections]
  );

  // Bookmark counts per archived collection
  const collectionBookmarkCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of archivedBookmarks) {
      if (archivedCollectionIds.has(b.collectionId)) {
        counts[b.collectionId] = (counts[b.collectionId] ?? 0) + 1;
      }
    }
    return counts;
  }, [archivedBookmarks, archivedCollectionIds]);

  // Individual archived bookmarks not belonging to an archived collection
  const individualArchivedBookmarks = React.useMemo(
    () => archivedBookmarks.filter(b => !archivedCollectionIds.has(b.collectionId)),
    [archivedBookmarks, archivedCollectionIds]
  );

  const totalCount = archivedCollections.length + individualArchivedBookmarks.length;

  return (
    <div className="flex-1 w-full overflow-auto">
      <div className="p-4 md:p-6 space-y-6">
        <div className="flex items-center gap-3 p-4 rounded-xl border bg-card">
          <div className="size-10 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center">
            <Archive className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Archived</h2>
            <p className="text-sm text-muted-foreground">
              {archivedCollections.length > 0 && `${archivedCollections.length} collection${archivedCollections.length !== 1 ? "s" : ""}, `}
              {individualArchivedBookmarks.length} bookmark{individualArchivedBookmarks.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>

        {archivedCollections.length > 0 && (
          <div className="flex flex-col gap-2">
            {archivedCollections.map(col => (
              <ArchivedCollectionCard
                key={col.id}
                collection={col}
                bookmarkCount={collectionBookmarkCounts[col.id] ?? 0}
              />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {individualArchivedBookmarks.map((bookmark) => (
            <ArchivedBookmarkCard key={bookmark.id} bookmark={bookmark} />
          ))}
        </div>

        {totalCount === 0 && (
          <EmptyState
            icon={Archive}
            title="Archive is empty"
            description="Archived bookmarks and collections will appear here."
          />
        )}
      </div>
    </div>
  );
}
```

Also add `import * as React from "react";` if not already present at top of file.

- [ ] **Step 4: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

If `CollectionIcon` import path is wrong, find the correct path:

```bash
grep -rn "export.*function CollectionIcon\|export.*CollectionIcon" /Users/lieutenant/Documents/github/TabSlate/components/
```

Fix the import and re-run `bun run compile`.

- [ ] **Step 5: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add components/dashboard/archive-content.tsx
git commit -m "feat(archive): show archived collection cards with one-click restore"
```

---

## Task 9: Client — Trash Page Collection Cards

**Files:**
- Modify: `components/dashboard/trash-content.tsx`

- [ ] **Step 1: Add new imports**

At the top of `trash-content.tsx`, add:

```ts
import * as React from "react";
import { useWorkspaceStore } from "@/store/workspace-store";
import { CollectionIcon } from "@/components/dashboard/sidebar/collection-icon";
import type { Collection } from "@/lib/types";
```

> Use the same `CollectionIcon` import path verified in Task 8.

- [ ] **Step 2: Add `TrashedCollectionCard` component**

Add before the existing `TrashedBookmarkCard`:

```tsx
function TrashedCollectionCard({ collection, bookmarkCount }: { collection: Collection; bookmarkCount: number }) {
  const restoreCollection = useWorkspaceStore(s => s.restoreCollection);
  const permanentlyDeleteCollection = useWorkspaceStore(s => s.permanentlyDeleteCollection);

  return (
    <div className="flex items-center gap-4 p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors opacity-75 hover:opacity-100">
      <div className="size-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <CollectionIcon icon={collection.icon} className="size-5 text-muted-foreground grayscale" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-medium truncate">{collection.name}</h3>
        <p className="text-sm text-muted-foreground">
          {bookmarkCount} bookmark{bookmarkCount !== 1 ? "s" : ""}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={() => restoreCollection(collection.id)}>
          <RotateCcw className="size-4 mr-1" />
          Restore
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => permanentlyDeleteCollection(collection.id)}
            >
              <XCircle className="size-4 mr-2" />
              Delete Permanently
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add missing imports for new components**

In the import block, add `MoreHorizontal` to the `lucide-react` import and add the `DropdownMenu` imports:

```ts
import { Trash2, MoreHorizontal, RotateCcw, XCircle, ExternalLink } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```

- [ ] **Step 4: Update `TrashContent` to show collection cards and filter individual bookmarks**

Replace the `TrashContent` function body:

```tsx
export function TrashContent() {
  const { trashedBookmarks } = useBookmarksStore();
  const getTrashedCollections = useWorkspaceStore(s => s.getTrashedCollections);

  const trashedCollections = getTrashedCollections();
  const trashedCollectionIds = React.useMemo(
    () => new Set(trashedCollections.map(c => c.id)),
    [trashedCollections]
  );

  // Bookmark counts per trashed collection
  const collectionBookmarkCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of trashedBookmarks) {
      if (trashedCollectionIds.has(b.collectionId)) {
        counts[b.collectionId] = (counts[b.collectionId] ?? 0) + 1;
      }
    }
    return counts;
  }, [trashedBookmarks, trashedCollectionIds]);

  // Individual trashed bookmarks not belonging to a trashed collection
  const individualTrashedBookmarks = React.useMemo(
    () => trashedBookmarks.filter(b => !trashedCollectionIds.has(b.collectionId)),
    [trashedBookmarks, trashedCollectionIds]
  );

  const totalCount = trashedCollections.length + individualTrashedBookmarks.length;

  return (
    <div className="flex-1 w-full overflow-auto">
      <div className="p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between gap-4 p-4 rounded-xl border bg-card">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-lg bg-destructive/10 text-destructive flex items-center justify-center">
              <Trash2 className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Trash</h2>
              <p className="text-sm text-muted-foreground">
                {trashedCollections.length > 0 && `${trashedCollections.length} collection${trashedCollections.length !== 1 ? "s" : ""}, `}
                {individualTrashedBookmarks.length} bookmark{individualTrashedBookmarks.length !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
          {totalCount > 0 && (
            <p className="text-xs text-muted-foreground hidden sm:block">
              Items in trash will be permanently deleted after 30 days
            </p>
          )}
        </div>

        {trashedCollections.length > 0 && (
          <div className="flex flex-col gap-2">
            {trashedCollections.map(col => (
              <TrashedCollectionCard
                key={col.id}
                collection={col}
                bookmarkCount={collectionBookmarkCounts[col.id] ?? 0}
              />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {individualTrashedBookmarks.map((bookmark) => (
            <TrashedBookmarkCard key={bookmark.id} bookmark={bookmark} />
          ))}
        </div>

        {totalCount === 0 && (
          <EmptyState
            icon={Trash2}
            title="Trash is empty"
            description="Deleted bookmarks and collections will appear here."
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Type-check and build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile && bun run build
```

Expected: clean compile, successful build with no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add components/dashboard/trash-content.tsx
git commit -m "feat(trash): show trashed collection cards with restore and permanent delete"
```

---

## Self-Review Notes

- `CollectionIcon` path must be verified in Task 8 Step 1 before using in Task 9.
- Server tasks (1–2) can be done in `TabSlate-server` independently; client tasks (3–9) are in `TabSlate`.
- Tasks 4 and 5 both touch stores; they must be done in order (Task 4 calls `useBookmarksStore.getState().trashCollectionBookmarks(id)` which is defined in Task 5 — type-check will pass because TypeScript only checks the interface, which is updated in Task 5 Step 2).
- The `enqueueAllToSync` function in workspace-store now pushes all collections including soft-deleted/archived ones (they're still in `get().collections`). This is correct — they need to reach the server.
