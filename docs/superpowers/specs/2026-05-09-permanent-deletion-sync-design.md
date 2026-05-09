# Permanent Deletion Sync Design

## Problem

When a client permanently deletes a collection or group, the server retains the soft-deleted tombstone (`deleted_at IS NOT NULL`). On a new device login, the delta pull returns this tombstone and the client restores the item to the trash — the permanent deletion is lost across devices.

Bookmarks have a partial workaround (`permanentlyDelete` pushes `deleted_at = now`) but it relies on a semantically ambiguous signal (`is_trashed = false + deleted_at != null`) and accumulates stale records on the server forever. It also has a LWW race: if another device pushes a stale `is_trashed = true` version before pulling the permanent-delete tombstone, the server can accept it and resurrect the bookmark.

## Goals

- Permanently deleted items never reappear on any device after sync.
- Other devices that already have the item in their local trash have it auto-removed on next sync.
- Server storage is reclaimed periodically (goroutine cleanup).
- Design is plan-aware for future grace-period tiers; uses a fixed default now.

## Data Model

### Server Schema

Add an integer status field to three tables. Semantics: `0 = active`, `1 = soft-deleted (in trash)`, `2 = permanently deleted`.

**`bookmarks`** — change `is_trashed` from `BOOLEAN` to `INT` (cast-safe migration):
```sql
-- Idempotent via DO block
ALTER TABLE bookmarks ALTER COLUMN is_trashed TYPE INT USING (is_trashed::int);

-- Migrate old "permanently deleted" records (deleted_at set, is_trashed=0) to state=2
UPDATE bookmarks SET is_trashed = 2
WHERE deleted_at IS NOT NULL AND is_trashed = 0;
```

**`collections`** — add new column:
```sql
ALTER TABLE collections ADD COLUMN IF NOT EXISTS is_deleted INT NOT NULL DEFAULT 0;

-- Migrate existing soft-deleted records to state=1
UPDATE collections SET is_deleted = 1
WHERE deleted_at IS NOT NULL AND is_deleted = 0;
```

**`groups`** — add new column:
```sql
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_deleted INT NOT NULL DEFAULT 0;

-- Migrate existing soft-deleted records to state=1
UPDATE groups SET is_deleted = 1
WHERE deleted_at IS NOT NULL AND is_deleted = 0;
```

### `deleted_at` Role

`deleted_at` is retained as the timestamp of when the item entered the trash (state=1). The goroutine uses `deleted_at` as the reference for the grace-period calculation. It is not set or changed during the state=1→2 transition.

### Client TypeScript Models

`Bookmark`, `Collection`, and `SavedGroup` interfaces **do not gain new fields**. State=2 records are never held in local Zustand state or IDB — they are immediately discarded on receipt. The `is_deleted`/`is_trashed` integer exists only in the `toServer*` conversion layer and in server response types.

## Sync Protocol

### Push

Each `permanentlyDelete*` action pushes state=2 to the server before removing the record locally:

| Action | Push payload |
|---|---|
| `permanentlyDelete(bookmarkId)` | `is_trashed: 2` |
| `permanentlyDeleteCollectionBookmarks(collectionId)` | `is_trashed: 2` for each bookmark |
| `permanentlyDeleteCollection(id)` | `is_deleted: 2` ← previously no push at all |
| `permanentlyDeleteGroup(id)` | `is_deleted: 2` ← previously no push at all |

Server push handler upserts normally. LWW (`WHERE updated_at < $now`) applies as usual.

### Pull

State=2 records **are included in delta pull** (`WHERE user_id=$1 AND seq>$2`). The pull query is not filtered. This is intentional: Device B needs to receive the state=2 tombstone to auto-remove the item from its own local trash on next sync.

After the server goroutine hard-deletes a state=2 record, it disappears from future pulls. Any device that was offline longer than the tombstone window misses the signal — this is the standard tombstone-expiry trade-off; a 7-day tombstone window is sufficient for typical usage.

### Client `mergeFromServer`

All three stores add a state=2 guard **before** any other merge logic:

```
if entity.is_trashed === 2  (bookmarks)
or entity.is_deleted === 2  (collections / groups):
  → remove from all relevant Zustand state arrays
  → idbDelete from all relevant IDB stores
  → skip all further merge logic for this record
```

**IDB removal scope per entity type:**
- Bookmark: `bookmarks`, `archived-bookmarks`, `trashed-bookmarks`
- Collection: `collections` (bookmarks handle their own state=2 via cascade push)
- Group: `groups` + all `group-tabs` where `groupId === sg.id`

**Legacy fallback:** The existing `if (sb.deleted_at)` guard in bookmarks `mergeFromServer` is retained to handle any old server records with `is_trashed=0 + deleted_at != null` that predate this migration.

## Server Implementation

### Model (`internal/model/model.go`)

```go
// Bookmark
IsTrashed    int     `json:"is_trashed"`    // 0=active 1=trashed 2=permanently deleted

// Collection — new field
IsDeleted    int     `json:"is_deleted"`    // 0=active 1=trashed 2=permanently deleted

// Group — new field
IsDeleted    int     `json:"is_deleted"`    // 0=active 1=trashed 2=permanently deleted
```

### Push Handler (`internal/handler/sync.go`)

- **Bookmarks**: `is_trashed` Go type changes from `bool` to `int`; SQL unchanged.
- **Collections**: append `is_deleted` to INSERT column list, ON CONFLICT SET, and args. Quota check condition changes from `deleted_at IS NULL` to `is_deleted = 0`.
- **Groups**: append `is_deleted` to INSERT column list, ON CONFLICT SET, and args.

### Pull Handler (`internal/handler/sync.go`)

Append `is_deleted` to SELECT and Scan for collections and groups. Change `IsTrashed` scan target from `bool` to `int` for bookmarks. No filter added — pull returns all states including state=2.

### Goroutine (`internal/handler/cleanup.go`)

New `CleanupHandler` struct, started in `app/server.go` as a background goroutine tied to server context.

**Runs every 24 hours. Two phases execute sequentially in the same run, but are not in the same DB transaction** — Phase 2's time condition (`grace + tombstone_window`) ensures it only acts on records that Phase 1 promoted on a previous run.

**Two phases per run:**

**Phase 1 — Auto-expire trash to permanently deleted:**
```sql
-- For each entity type (bookmarks, collections, groups):
UPDATE <table>
SET is_trashed/is_deleted = 2, seq = <incremented_user_seq>
WHERE (is_trashed = 1 OR is_deleted = 1)
  AND deleted_at < (now_ms - grace_ms)
  AND user_id = $user_id
```
Processes users in batches. For each affected user, increments `user_sync_seq` once and assigns the new seq to all updated rows. This ensures the tombstones appear in subsequent delta pulls.

**Phase 2 — Hard-delete permanently deleted records past tombstone window:**
```sql
-- Deletion order: bookmarks first, then collections, then groups
-- (avoids FK issues: bookmarks.collection_id ON DELETE SET NULL,
--  group_tabs.group_id ON DELETE CASCADE)
DELETE FROM bookmarks   WHERE is_trashed = 2  AND deleted_at < (now_ms - grace_ms - tombstone_ms);
DELETE FROM collections WHERE is_deleted = 2  AND deleted_at < (now_ms - grace_ms - tombstone_ms);
DELETE FROM groups      WHERE is_deleted = 2  AND deleted_at < (now_ms - grace_ms - tombstone_ms);
```

**Configuration:**
- `TRASH_GRACE_DAYS` env var (default: `7`) — grace period before auto-expiry. Plan-aware lookup replaces this once billing tiers are implemented.
- `tombstone_window` — fixed constant of 7 days, not externally configurable. Represents the maximum expected delta-sync lag across devices.

## Client Implementation

### `lib/api.ts`

```ts
// ServerBookmark
is_trashed: number          // was boolean

// ServerCollection — new
is_deleted: number

// ServerGroup — new
is_deleted: number
```

### `store/bookmarks-store.ts`

**`toServerBookmark`** opts type: `isTrashed?: number` (was `boolean`).

Call-site changes:

| Location | Before | After |
|---|---|---|
| `trashBookmark` | `{ isTrashed: true }` | `{ isTrashed: 1 }` |
| `permanentlyDelete` | `toServerBookmark({ ...bookmark, deletedAt: Date.now() })` | `toServerBookmark(bookmark, { isTrashed: 2 })` |
| `permanentlyDeleteCollectionBookmarks` | `toServerBookmark({ ...b, deletedAt: Date.now() })` | `toServerBookmark(b, { isTrashed: 2 })` |
| `sweepUnsynced` trashed items | `{ isTrashed: true }` | `{ isTrashed: 1 }` |
| `enqueueAllToSync` trashed items | `{ isTrashed: true }` | `{ isTrashed: 1 }` |

`mergeFromServer`: add `is_trashed === 2` guard before existing `if (sb.deleted_at)` block. Both paths remove from all stores + IDB.

### `store/workspace-store.ts`

**`toServerCollection`** gains optional `opts?: { isDeleted?: number }` parameter, appends `is_deleted: opts?.isDeleted ?? 0` to the returned object.

**`permanentlyDeleteCollection`**: call `syncEngine?.enqueue({ collections: [toServerCollection(col, { isDeleted: 2 })] })` before local cleanup.

**`mergeFromServer` collections**: add `sc.is_deleted === 2` guard → remove from state + `idbDelete("collections", sc.id)`.

### `store/groups-store.ts`

**`toServerGroup`** gains optional `opts?: { isDeleted?: number }` parameter, appends `is_deleted: opts?.isDeleted ?? 0`.

**`permanentlyDeleteGroup`**: call `syncEngine?.enqueue({ groups: [toServerGroup(group, [], { isDeleted: 2 })] })` before local cleanup.

**`mergeFromServer` groups**: add `sg.is_deleted === 2` guard (after the null-workspace check) → collect into a `permDeletedGroupIds` set, skip adding to state; after `set()`, `idbDelete("groups", id)` and `idbDelete("group-tabs", tabId)` for each affected tab.

## Invariants

- State=2 records are **never written to IDB** — neither on push nor on pull.
- A state=2 record can only be created by an explicit `permanentlyDelete*` action or by the goroutine auto-expiry. It cannot be reverted to state=1 or state=0.
- LWW still applies: if two devices push conflicting states, `updated_at` determines the winner. A state=2 push from Device A wins over a stale state=1 push from Device B if A's push is more recent — which it always is, since A's push happens at `now`.
- The goroutine's Phase 1 seq-bump ensures auto-expired tombstones appear in delta pulls. Devices offline longer than `TRASH_GRACE_DAYS + tombstone_window` may miss tombstones — this is an accepted trade-off.
