# Collections Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Meteroid `"Collections"` CAPACITY component into Cloud quota enforcement, fix the broken `is_deleted = 1` trashed-collection state sent by the frontend, and align quota SQL across all three repos.

**Architecture:** Five focused tasks across three repos. Server tasks 2–3 are sequential (migration before SQL change). Cloud task 1 and frontend tasks 4–5 are independent and can run in parallel with server tasks.

**Tech Stack:** Go 1.23 (TabSlate-server, TabSlate-Cloud), TypeScript + Zustand (TabSlate frontend), PostgreSQL 17

**Spec:** `docs/superpowers/specs/2026-05-21-collections-quota-design.md`

---

## File Map

| File | Repo | Change |
|---|---|---|
| `internal/meteroid/capacity.go` | TabSlate-Cloud | Add `"collections"` switch case; update `defaultCapacity` |
| `internal/meteroid/capacity_test.go` | TabSlate-Cloud | New — unit tests for `parsePlanCapacity` |
| `db/schema.pg.sql` | TabSlate-server | Add idempotent backfill UPDATE |
| `internal/handler/collections.go` | TabSlate-server | Quota COUNT `is_deleted = 0` → `is_deleted < 2` |
| `internal/handler/sync.go` | TabSlate-server | 2 quota sites: `is_deleted = 0` → `is_deleted < 2` |
| `internal/handler/billing.go` | TabSlate-server | Usage COUNT `is_deleted = 0` → `is_deleted < 2` |
| `store/workspace-store.ts` | TabSlate | Fix `toServerCollection` (`is_deleted=1` for trashed) + update stale comments |

---

## Task 1 — Cloud: wire `"Collections"` CAPACITY component

**Repo:** TabSlate-Cloud  
**Files:**
- Modify: `internal/meteroid/capacity.go`
- Create: `internal/meteroid/capacity_test.go`

- [ ] **Step 1: Write failing test for `parsePlanCapacity` — "collections" case**

Create `internal/meteroid/capacity_test.go`:

```go
package meteroid

import (
	"testing"
)

func makePlanResp(components []planPriceComponent) *planResponse {
	return &planResponse{PriceComponents: components}
}

func capacityComp(name string, amount int64) planPriceComponent {
	return planPriceComponent{
		Name: name,
		Fee: planCapacityFee{
			Type:       "CAPACITY",
			Thresholds: []capacityThreshold{{IncludedAmount: amount}},
		},
	}
}

func TestParsePlanCapacity_Collections(t *testing.T) {
	plan := makePlanResp([]planPriceComponent{
		capacityComp("Collections", 30),
	})
	l := parsePlanCapacity(plan)
	if l.MaxCollections != 30 {
		t.Errorf("MaxCollections = %d, want 30", l.MaxCollections)
	}
}

func TestParsePlanCapacity_AllKnownComponents(t *testing.T) {
	plan := makePlanResp([]planPriceComponent{
		capacityComp("Bookmarks", 3000),
		capacityComp("Tags", 1000),
		capacityComp("Workspace", 3),
		capacityComp("Saved Groups", 10),
		capacityComp("Trash Grace Days", 7),
		capacityComp("Collections", 30),
	})
	l := parsePlanCapacity(plan)

	cases := []struct {
		name string
		got  int
		want int
	}{
		{"MaxBookmarks", l.MaxBookmarks, 3000},
		{"MaxTags", l.MaxTags, 1000},
		{"MaxWorkspaces", l.MaxWorkspaces, 3},
		{"MaxSavedGroups", l.MaxSavedGroups, 10},
		{"TrashGraceDays", l.TrashGraceDays, 7},
		{"MaxCollections", l.MaxCollections, 30},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s = %d, want %d", c.name, c.got, c.want)
		}
	}
}

func TestParsePlanCapacity_UnknownComponentIgnored(t *testing.T) {
	plan := makePlanResp([]planPriceComponent{
		capacityComp("Future Feature", 99),
		capacityComp("Collections", 30),
	})
	l := parsePlanCapacity(plan)
	if l.MaxCollections != 30 {
		t.Errorf("MaxCollections = %d, want 30 (unknown component should be ignored)", l.MaxCollections)
	}
}

func TestParsePlanCapacity_DefaultsToUnlimitedForMissingComponents(t *testing.T) {
	plan := makePlanResp([]planPriceComponent{
		capacityComp("Bookmarks", 3000),
		// Collections omitted
	})
	l := parsePlanCapacity(plan)
	if l.MaxCollections != -1 {
		t.Errorf("MaxCollections = %d, want -1 (unlimited) when component absent", l.MaxCollections)
	}
}

func TestDefaultCapacity_FreePlanHasCollectionsLimit(t *testing.T) {
	free := defaultCapacity["free"]
	if free == nil {
		t.Fatal("defaultCapacity[\"free\"] is nil")
	}
	if free.MaxCollections != 30 {
		t.Errorf("defaultCapacity[\"free\"].MaxCollections = %d, want 30", free.MaxCollections)
	}
}
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-Cloud
go test ./internal/meteroid/... -run TestParsePlanCapacity -v
```

Expected output: `FAIL` — `MaxCollections = -1, want 30` (the switch case doesn't exist yet).

- [ ] **Step 3: Add `"collections"` case to `parsePlanCapacity`**

In `internal/meteroid/capacity.go`, inside the `switch strings.ToLower(comp.Name)` block, add after the `"saved groups"` case:

```go
		case "collections":
			l.MaxCollections = amount
```

The full switch after the change:

```go
		switch strings.ToLower(comp.Name) {
		case "bookmarks":
			l.MaxBookmarks = amount
		case "tags":
			l.MaxTags = amount
		case "workspace", "workspaces":
			l.MaxWorkspaces = amount
		case "saved groups":
			l.MaxSavedGroups = amount
		case "collections":
			l.MaxCollections = amount
		case "trash grace days":
			l.TrashGraceDays = amount
		}
```

- [ ] **Step 4: Update `defaultCapacity` free-plan fallback**

In `internal/meteroid/capacity.go`, change the `"free"` entry in `defaultCapacity`:

```go
// Before
"free": {MaxWorkspaces: 1, MaxBookmarks: 3000, MaxCollections: -1, MaxTags: 1000, MaxSavedGroups: 10, TrashGraceDays: 7},

// After
"free": {MaxWorkspaces: 1, MaxBookmarks: 3000, MaxCollections: 30, MaxTags: 1000, MaxSavedGroups: 10, TrashGraceDays: 7},
```

- [ ] **Step 5: Run tests — all must pass**

```bash
go test ./internal/meteroid/... -v
```

Expected: all tests PASS including the new `TestParsePlanCapacity_*` and `TestDefaultCapacity_FreePlanHasCollectionsLimit`.

Also verify the existing `TestGetLimits_FreePlan` and `TestGetLimits_CacheHit` still pass (they use `defaultCapacity["free"]`).

- [ ] **Step 6: Build check**

```bash
go build ./...
go vet ./...
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-Cloud
git add internal/meteroid/capacity.go internal/meteroid/capacity_test.go
git commit -m "feat: wire Collections CAPACITY component into parsePlanCapacity

Free plan defaultCapacity.MaxCollections updated to 30 to match
Meteroid staging config. capacity_test.go added to cover all
parsePlanCapacity branches including the new collections case."
```

---

## Task 2 — Server: backfill trashed collections to `is_deleted = 1`

**Repo:** TabSlate-server  
**Files:**
- Modify: `db/schema.pg.sql`

**Context:** The server model defines `is_deleted` as `0=active, 1=trashed, 2=permanently deleted` (see `internal/model/model.go:62`). The frontend has always sent `is_deleted = 0` for trashed collections, so historical trashed rows have `is_deleted = 0, deleted_at IS NOT NULL`. The cleanup goroutine (`internal/handler/cleanup.go`) queries `WHERE is_deleted = 1` to auto-expire trash — it currently never fires for collections because no rows have `is_deleted = 1`. This backfill fixes historical data.

- [ ] **Step 1: Add the idempotent backfill to schema.pg.sql**

In `db/schema.pg.sql`, after the last `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statement (at the end of the migration section), add:

```sql
-- Backfill: trashed collections (deleted_at set, not archived) were stored with
-- is_deleted = 0 due to a frontend bug. Promote them to is_deleted = 1 so the
-- cleanup goroutine can auto-expire them per the trash grace period.
-- Idempotent: rows already at is_deleted = 1 are unaffected.
UPDATE collections
SET is_deleted = 1
WHERE is_deleted = 0 AND deleted_at IS NOT NULL AND archived_at IS NULL;
```

- [ ] **Step 2: Build check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
```

Expected: no errors (schema.pg.sql is embedded; build confirms the embed compiles).

- [ ] **Step 3: Commit**

```bash
git add db/schema.pg.sql
git commit -m "fix: backfill collections is_deleted=0 trashed rows to is_deleted=1

Historical trashed collections were stored with is_deleted=0 because
toServerCollection always sent 0. The cleanup goroutine queries
is_deleted=1 to auto-expire trash, so those rows were never promoted
to state=2. This idempotent UPDATE fixes existing data."
```

---

## Task 3 — Server: update quota SQL to `is_deleted < 2`

**Repo:** TabSlate-server  
**Files:**
- Modify: `internal/handler/collections.go:91`
- Modify: `internal/handler/sync.go:121,134`
- Modify: `internal/handler/billing.go:111`

**Context:** After Task 2's backfill, trashed collections have `is_deleted = 1`. The quota must count active (0) + archived (0 + archived_at) + trashed (1), excluding only permanently deleted (2). Condition: `is_deleted < 2`.

- [ ] **Step 1: Fix `collections.go` — Create handler quota COUNT**

In `internal/handler/collections.go`, inside the `Create` function, change:

```go
// Before (line ~91)
if err := h.db.QueryRow(ctx, `SELECT COUNT(*) FROM collections WHERE user_id = $1 AND is_deleted = 0`, userID).Scan(&count); err != nil {

// After
if err := h.db.QueryRow(ctx, `SELECT COUNT(*) FROM collections WHERE user_id = $1 AND is_deleted < 2`, userID).Scan(&count); err != nil {
```

- [ ] **Step 2: Fix `sync.go` — Push existsInQuota SELECT**

In `internal/handler/sync.go`, inside the `Push` function's collections loop, change the `existingNonTrashed` check (rename variable to `existsInQuota` for clarity):

```go
// Before (line ~119-121)
var existingNonTrashed bool
err := tx.QueryRow(ctx,
    `SELECT true FROM collections WHERE id = $1 AND user_id = $2 AND is_deleted = 0`,
    col.ID, userID,
).Scan(&existingNonTrashed)
if err != nil && !errors.Is(err, pgx.ErrNoRows) {
    c.JSON(http.StatusInternalServerError, gin.H{"error": "quota check failed"})
    return
}
if existingNonTrashed {
    goto upsertCollection
}

// After
var existsInQuota bool
err := tx.QueryRow(ctx,
    `SELECT true FROM collections WHERE id = $1 AND user_id = $2 AND is_deleted < 2`,
    col.ID, userID,
).Scan(&existsInQuota)
if err != nil && !errors.Is(err, pgx.ErrNoRows) {
    c.JSON(http.StatusInternalServerError, gin.H{"error": "quota check failed"})
    return
}
if existsInQuota {
    goto upsertCollection
}
```

- [ ] **Step 3: Fix `sync.go` — Push quota COUNT**

In the same collections loop in `sync.go`, change the quota COUNT query:

```go
// Before (line ~133-134)
if err := tx.QueryRow(ctx,
    `SELECT COUNT(*) FROM collections WHERE user_id = $1 AND is_deleted = 0`,
    userID,
).Scan(&count); err != nil {

// After
if err := tx.QueryRow(ctx,
    `SELECT COUNT(*) FROM collections WHERE user_id = $1 AND is_deleted < 2`,
    userID,
).Scan(&count); err != nil {
```

- [ ] **Step 4: Fix `billing.go` — GetPlan usage COUNT**

In `internal/handler/billing.go`, in the `GetPlan` function, change the collections usage query:

```go
// Before (line ~111)
if err := h.db.QueryRow(ctx,
    `SELECT COUNT(*) FROM collections WHERE user_id = $1 AND is_deleted = 0`,
    userID,
).Scan(&usage.Collections); err != nil {

// After
if err := h.db.QueryRow(ctx,
    `SELECT COUNT(*) FROM collections WHERE user_id = $1 AND is_deleted < 2`,
    userID,
).Scan(&usage.Collections); err != nil {
```

- [ ] **Step 5: Build and vet**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
go vet ./...
```

Expected: no errors.

- [ ] **Step 6: Run existing tests**

```bash
go test ./...
```

Expected: all existing tests pass. (There are no handler integration tests; the change is SQL-only.)

- [ ] **Step 7: Commit**

```bash
git add internal/handler/collections.go internal/handler/sync.go internal/handler/billing.go
git commit -m "fix: quota SQL is_deleted=0 → is_deleted<2 for collections

Trashed collections (is_deleted=1) must count toward the quota —
only permanently deleted (is_deleted=2) are excluded. Updated
all four quota-check and usage-count queries consistently."
```

---

## Task 4 — Frontend: fix `toServerCollection`

**Repo:** TabSlate  
**Files:**
- Modify: `store/workspace-store.ts`

**Context:**
- `createCollection` currentCount and import quota check are **already using `get().collections.length`** (merged). No change needed there.
- `toServerCollection` still sends `is_deleted: 0` for all non-permanently-deleted collections, including trashed ones (`c.deletedAt` set). The server model expects `is_deleted = 1` for trashed — this bug prevents the cleanup goroutine (`WHERE is_deleted = 1`) from finding trashed collections to auto-expire. Fix: derive from `c.deletedAt`.
- Two comments in the file reference the old `is_deleted = 0` semantics and need updating after the fix.

- [ ] **Step 1: Fix `toServerCollection` — send `is_deleted = 1` for trashed collections**

In `store/workspace-store.ts`, `toServerCollection` function (line ~82), change the `is_deleted` line:

```ts
// Before (line 82)
    is_deleted: opts?.isDeleted ?? 0,

// After
    is_deleted: opts?.isDeleted ?? (c.deletedAt ? 1 : 0),
```

Semantics after the change:
- Active (`deletedAt` undefined): `is_deleted = 0` ✅
- Archived (`archivedAt` set, `deletedAt` undefined): `is_deleted = 0` ✅ (archived is not a deletion state)
- Trashed (`deletedAt` set): `is_deleted = 1` ✅ (fixed — cleanup goroutine now finds these)
- Permanently deleted (`opts.isDeleted = 2`): `is_deleted = 2` ✅ (opts takes precedence)

- [ ] **Step 2: Update stale comments**

The two comments that describe old `is_deleted = 0` behavior need updating.

Around line 496 (inside `createCollection`), replace the comment block:

```ts
      // Before
      // Backend counts all collections where is_deleted=0, which includes soft-deleted
      // (trashed) ones — they stay is_deleted=0 until permanently deleted (is_deleted=2).
      // Permanently deleted collections are removed from the local array entirely,
      // so collections.length always matches the backend's count.

      // After
      // Backend counts collections where is_deleted < 2 — active (0), archived (0 + archived_at),
      // and trashed (1). Only permanently deleted (is_deleted=2) are excluded.
      // mergeFromServer removes is_deleted=2 entries from the local array,
      // so collections.length matches the server count.
```

Around line 620 (inside the import/checkImportQuota block), replace:

```ts
      // Before
      // Backend counts collections where is_deleted = 0, which includes soft-deleted (trashed)
      // and archived ones. Only permanentlyDeleteCollection sends is_deleted:2 and removes
      // the entry from the local array, so collections.length mirrors the server count.

      // After
      // Backend counts collections where is_deleted < 2 — active (0), archived (0), trashed (1).
      // Only permanentlyDeleteCollection sends is_deleted=2 and removes the entry from the local
      // array, so collections.length mirrors the server count.
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 4: Build check**

```bash
bun run build
```

Expected: build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add store/workspace-store.ts
git commit -m "fix: toServerCollection sends is_deleted=1 for trashed collections

Previously always sent 0, which meant the cleanup goroutine's
WHERE is_deleted=1 query never found collections to auto-expire.
Also updates stale comments that described the old is_deleted=0
inclusive semantics — now correctly describes is_deleted<2."
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `parsePlanCapacity` "collections" case | Task 1 Step 3 |
| `defaultCapacity["free"].MaxCollections = 30` | Task 1 Step 4 |
| Backfill `is_deleted = 0` trashed → `is_deleted = 1` | Task 2 Step 1 |
| `collections.go` quota SQL `is_deleted < 2` | Task 3 Step 1 |
| `sync.go` existsInQuota SQL `is_deleted < 2` | Task 3 Step 2 |
| `sync.go` COUNT SQL `is_deleted < 2` | Task 3 Step 3 |
| `billing.go` usage COUNT `is_deleted < 2` | Task 3 Step 4 |
| `toServerCollection` `is_deleted = 1` for trashed | Task 4 Step 1 |
| `createCollection` currentCount `collections.length` | **Already done** (in recent merge) |

All spec requirements covered. Pull query `is_default` / `min_pos` CTE correctly excluded from changes (spec: "no change").

**Placeholder scan:** No TBD, TODO, or vague steps. All code blocks contain complete implementations.

**Type consistency:** `toServerCollection` signature unchanged — only the `is_deleted` value expression changes. `guardQuota` first argument type `QuotaResource = "collection"` unchanged. `get().collections.length` is `number` — matches `currentCount: number` parameter.
