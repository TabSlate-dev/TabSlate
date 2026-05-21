# Collections Quota — Design Spec

**Date:** 2026-05-21  
**Repos affected:** TabSlate (frontend), TabSlate-server (backend), TabSlate-Cloud (billing)

---

## Background

Meteroid Free plan already has a `"Collections"` CAPACITY component (`included_amount: 30`). However, three separate issues prevent the limit from taking effect:

1. **Cloud `parsePlanCapacity` missing case** — no `"collections"` switch arm, so `MaxCollections` stays `-1` (unlimited) for all Cloud users.
2. **Wrong `is_deleted` value sent by frontend** — `toServerCollection` always sends `is_deleted = 0` for trashed collections (those with `deletedAt` set). The server model defines `is_deleted = 1` as trashed, so the cleanup goroutine's `WHERE is_deleted = 1` never matches any collections — the trash grace-period auto-expiry is broken for collections.
3. **Frontend `currentCount` too narrow** — `createCollection` passes only active (non-archived, non-trashed) collections to `guardQuota`, while the server counts `is_deleted = 0` (active + archived + historically-trashed).

---

## State Model (clarification)

`is_deleted` and `archived_at` are **orthogonal dimensions**:

| `is_deleted` | `archived_at` | State |
|---|---|---|
| 0 | NULL | Active |
| 0 | SET | Archived |
| 1 | NULL | Trashed (soft-deleted) |
| 2 | — | Permanently deleted |

`is_deleted = 0` correctly means "not in the deletion lifecycle." Archived collections are genuinely not deleted, so they belong in `is_deleted = 0`. No `is_archived` column is needed — `archived_at IS NOT NULL` expresses archival state precisely.

---

## Quota Semantics

Everything **except permanently deleted** counts toward the quota:

| State | Counts toward quota |
|---|---|
| Active | ✅ |
| Archived | ✅ |
| Trashed (`is_deleted = 1`) | ✅ |
| Permanently deleted (`is_deleted = 2`) | ❌ |

SQL condition: `is_deleted < 2`

---

## Changes

### 1. TabSlate-Cloud — `internal/meteroid/capacity.go`

**A. `parsePlanCapacity` — add `"collections"` case**

```go
case "collections":
    l.MaxCollections = amount
```

**B. `defaultCapacity` — set Free plan fallback**

```go
"free": {MaxWorkspaces: 1, MaxBookmarks: 3000, MaxCollections: 30, MaxTags: 1000, MaxSavedGroups: 10, TrashGraceDays: 7},
```

### 2. TabSlate-server — `db/schema.pg.sql`

**Backfill existing trashed collections** so cleanup goroutine can process historical data:

```sql
UPDATE collections
SET is_deleted = 1
WHERE is_deleted = 0 AND deleted_at IS NOT NULL AND archived_at IS NULL;
```

Add as idempotent migration step (re-running is safe: already-migrated rows have `is_deleted = 1` and won't match `is_deleted = 0`).

### 3. TabSlate-server — quota SQL: `is_deleted = 0` → `is_deleted < 2`

Four query sites:

| File | Location | Change |
|---|---|---|
| `internal/handler/collections.go` | `Create` — quota COUNT | `is_deleted = 0` → `is_deleted < 2` |
| `internal/handler/sync.go` | `Push` — `existsInQuota` SELECT | `is_deleted = 0` → `is_deleted < 2` |
| `internal/handler/sync.go` | `Push` — quota COUNT | `is_deleted = 0` → `is_deleted < 2` |
| `internal/handler/billing.go` | `GetPlan` — usage COUNT | `is_deleted = 0` → `is_deleted < 2` |

**Pull query — no change.** The `is_default` annotation and `min_pos` CTE use `deleted_at IS NULL AND archived_at IS NULL AND is_deleted = 0` to identify active collections, which remains correct under the new semantics (trashed collections have `is_deleted = 1`, not 0).

### 4. TabSlate — `store/workspace-store.ts`

**A. Fix `toServerCollection` — send correct `is_deleted` for trashed**

```ts
// Before
is_deleted: opts?.isDeleted ?? 0,

// After
is_deleted: opts?.isDeleted ?? (c.deletedAt ? 1 : 0),
```

Archived collections (`archivedAt` set, no `deletedAt`) continue to send `is_deleted = 0`. Only collections with `deletedAt` set send `is_deleted = 1`. Permanent delete continues to send `is_deleted = 2` via `opts`.

**B. Fix `createCollection` `currentCount`**

```ts
// Before — only active, mismatches server count
get().collections.filter(c => !c.deletedAt && !c.archivedAt).length

// After — all non-permanently-deleted (permanently deleted are removed from state by mergeFromServer)
get().collections.length
```

`decrementUsage("collection")` placement is already correct — only called in `permanentlyDeleteCollection`. No change needed there.

---

## What does NOT change

- `mergeFromServer` — already handles `is_deleted === 2` (remove) and `sc.deleted_at` (keep as trashed). The `is_deleted = 1` path from the pull response is correctly surfaced via `sc.deleted_at`.
- `cleanup.go` — already written correctly for `is_deleted = 1 → 2` promotion. Only the frontend bug and backfill migration were missing.
- Pull query `is_default` / `min_pos` CTE — still correct, no change.
- `decrementUsage("collection")` — already only on `permanentlyDeleteCollection`. No change.

---

## Migration Safety

The backfill `UPDATE` is idempotent. It only touches rows where `is_deleted = 0 AND deleted_at IS NOT NULL AND archived_at IS NULL` — rows that are definitively trashed (not active, not archived). Re-running produces zero rows affected after the first pass.

After backfill, existing trashed collections become visible to the cleanup goroutine's phase 1 and will be auto-expired per the configured `TRASH_GRACE_DAYS`.
