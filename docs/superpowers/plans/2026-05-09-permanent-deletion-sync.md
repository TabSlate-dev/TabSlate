# Permanent Deletion Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix permanently deleted collections, groups, and bookmarks reappearing on new device login by propagating state=2 (permanently deleted) tombstones through the sync protocol.

**Architecture:** Add an integer status field to `bookmarks.is_trashed`, `collections.is_deleted`, and `groups.is_deleted` (0=active, 1=soft-deleted, 2=permanently deleted). State=2 records are included in delta pull so other devices can auto-remove them; a background goroutine hard-deletes them after a tombstone window. Client discards state=2 records immediately on receipt without writing them to IDB or Zustand.

**Tech Stack:** Go (pgx/v5, gin), TypeScript (Zustand, IDB)

---

## File Map

**Server (TabSlate-server):**
- Modify: `db/schema.pg.sql` — schema migrations
- Modify: `internal/model/model.go` — IsTrashed bool→int, add IsDeleted to Collection/Group
- Modify: `internal/handler/sync.go` — push handler (quota check, is_deleted upsert) + pull handler (SELECT/Scan)
- Create: `internal/handler/cleanup.go` — CleanupHandler goroutine
- Modify: `app/config.go` — add TrashGraceDays field
- Modify: `app/server.go` — wire CleanupHandler goroutine

**Client (TabSlate):**
- Modify: `lib/api.ts` — ServerBookmark.is_trashed: number, add is_deleted to ServerCollection/ServerGroup
- Modify: `store/bookmarks-store.ts` — toServerBookmark opts type, permanentlyDelete, permanentlyDeleteCollectionBookmarks, sweepUnsynced, enqueueAllToSync, updateBookmark, mergeFromServer
- Modify: `store/workspace-store.ts` — toServerCollection opts, permanentlyDeleteCollection push, mergeFromServer guard
- Modify: `store/groups-store.ts` — toServerGroup opts, permanentlyDeleteGroup push, mergeFromServer guard

---

### Task 1: Server Schema Migration

**Files:**
- Modify: `TabSlate-server/db/schema.pg.sql`

- [ ] **Step 1: Append schema migrations to schema.pg.sql**

At the end of `db/schema.pg.sql`, after the existing `DO $$ ... ALTER TABLE groups ADD COLUMN workspace_id` block, append:

```sql
-- ── Permanent deletion: integer status fields ─────────────────────────────
-- bookmarks.is_trashed: 0=active 1=trashed 2=permanently deleted
-- Cast BOOLEAN to INT (idempotent: ALTER TYPE is a no-op if already INT).
DO $$ BEGIN
  ALTER TABLE bookmarks ALTER COLUMN is_trashed TYPE INT USING (is_trashed::int);
EXCEPTION WHEN others THEN NULL;
END $$;

-- Migrate old "permanently deleted" bookmark records:
-- (deleted_at set, is_trashed=0) → is_trashed=2
UPDATE bookmarks SET is_trashed = 2
WHERE deleted_at IS NOT NULL AND is_trashed = 0;

-- collections.is_deleted: 0=active 1=trashed 2=permanently deleted
ALTER TABLE collections ADD COLUMN IF NOT EXISTS is_deleted INT NOT NULL DEFAULT 0;

-- Migrate existing soft-deleted collections to is_deleted=1
UPDATE collections SET is_deleted = 1
WHERE deleted_at IS NOT NULL AND is_deleted = 0;

-- groups.is_deleted: 0=active 1=trashed 2=permanently deleted
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_deleted INT NOT NULL DEFAULT 0;

-- Migrate existing soft-deleted groups to is_deleted=1
UPDATE groups SET is_deleted = 1
WHERE deleted_at IS NOT NULL AND is_deleted = 0;
```

- [ ] **Step 2: Verify the schema applies cleanly**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
```

Expected: builds without errors (schema is embedded, not executed here, but compilation verifies no syntax errors in Go).

- [ ] **Step 3: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add db/schema.pg.sql
git commit -m "feat(schema): add integer status fields for permanent deletion sync"
```

---

### Task 2: Server Model Updates

**Files:**
- Modify: `TabSlate-server/internal/model/model.go`

- [ ] **Step 1: Change IsTrashed from bool to int on Bookmark**

In `internal/model/model.go`, find the `Bookmark` struct (line 64). Change:

```go
IsTrashed    bool     `json:"is_trashed"`
```

to:

```go
IsTrashed    int      `json:"is_trashed"`    // 0=active 1=trashed 2=permanently deleted
```

- [ ] **Step 2: Add IsDeleted to Collection**

In `internal/model/model.go`, find the `Collection` struct (line 49). After `ArchivedAt  *int64  \`json:"archived_at,omitempty"\``, add:

```go
IsDeleted    int     `json:"is_deleted"`     // 0=active 1=trashed 2=permanently deleted
```

- [ ] **Step 3: Add IsDeleted to Group**

In `internal/model/model.go`, find the `Group` struct (line 94). After `DeletedAt   *int64     \`json:"deleted_at,omitempty"\``, add:

```go
IsDeleted    int        `json:"is_deleted"`    // 0=active 1=trashed 2=permanently deleted
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
```

Expected: build fails with type errors in `sync.go` because `bm.IsTrashed` was `bool` — that's expected; the push handler fix is in the next task.

- [ ] **Step 5: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add internal/model/model.go
git commit -m "feat(model): change IsTrashed to int, add IsDeleted to Collection and Group"
```

---

### Task 3: Server Push Handler Updates

**Files:**
- Modify: `TabSlate-server/internal/handler/sync.go`

This task fixes the type error introduced in Task 2 and wires up `is_deleted` for collections and groups.

- [ ] **Step 1: Fix bookmark push — is_trashed type and search check**

In `sync.go`, find the bookmarks push section (around line 121–157). The `bm.IsTrashed` was previously `bool`. There are two changes:

**Change 1** — The `INSERT` and `ON CONFLICT SET` use `bm.IsTrashed` as a value passed to `$10`. No SQL change needed (value is now int instead of bool, pgx handles it). No code change here.

**Change 2** — The search index check at line 143 used `bm.IsTrashed` as a bool condition. Change:

```go
if bm.DeletedAt != nil || bm.IsTrashed {
```

to:

```go
if bm.DeletedAt != nil || bm.IsTrashed > 0 {
```

- [ ] **Step 2: Fix collection push — add is_deleted, update quota check**

In `sync.go`, find the collections push section (around line 82–115). 

**Change 1** — Quota check condition: change `deleted_at IS NULL AND archived_at IS NULL` to `is_deleted = 0`:

```go
if err := tx.QueryRow(ctx,
    `SELECT COUNT(*) FROM collections WHERE user_id = $1 AND is_deleted = 0`,
    userID,
).Scan(&count); err != nil {
```

**Change 2** — INSERT and ON CONFLICT SET: add `is_deleted` as a new column. The current INSERT is:

```go
tag, err := tx.Exec(ctx, `
    INSERT INTO collections (id, user_id, workspace_id, name, icon, position, seq, deleted_at, archived_at, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
    ON CONFLICT (id) DO UPDATE
      SET workspace_id=$3, name=$4, icon=$5, position=$6, seq=$7, deleted_at=$8, archived_at=$9, updated_at=$10
    WHERE collections.user_id = $2 AND collections.updated_at < $10`,
    col.ID, userID, col.WorkspaceID, col.Name, col.Icon, col.Position, seq, col.DeletedAt, col.ArchivedAt, now)
```

Change it to:

```go
tag, err := tx.Exec(ctx, `
    INSERT INTO collections (id, user_id, workspace_id, name, icon, position, seq, deleted_at, archived_at, is_deleted, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
    ON CONFLICT (id) DO UPDATE
      SET workspace_id=$3, name=$4, icon=$5, position=$6, seq=$7, deleted_at=$8, archived_at=$9, is_deleted=$10, updated_at=$11
    WHERE collections.user_id = $2 AND collections.updated_at < $11`,
    col.ID, userID, col.WorkspaceID, col.Name, col.Icon, col.Position, seq, col.DeletedAt, col.ArchivedAt, col.IsDeleted, now)
```

- [ ] **Step 3: Fix group push — add is_deleted**

In `sync.go`, find the groups push section (around line 177–207). The current INSERT is:

```go
tag, err := tx.Exec(ctx, `
    INSERT INTO groups (id, user_id, name, color, is_compact, seq, deleted_at, created_at, updated_at, workspace_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)
    ON CONFLICT (id) DO UPDATE
      SET name=$3, color=$4, is_compact=$5, seq=$6, deleted_at=$7, updated_at=$8, workspace_id=$9
    WHERE groups.user_id = $2 AND groups.updated_at < $8`,
    g.ID, userID, g.Name, g.Color, g.IsCompact, seq, g.DeletedAt, now, g.WorkspaceID)
```

Change it to:

```go
tag, err := tx.Exec(ctx, `
    INSERT INTO groups (id, user_id, name, color, is_compact, seq, deleted_at, is_deleted, created_at, updated_at, workspace_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)
    ON CONFLICT (id) DO UPDATE
      SET name=$3, color=$4, is_compact=$5, seq=$6, deleted_at=$7, is_deleted=$8, updated_at=$9, workspace_id=$10
    WHERE groups.user_id = $2 AND groups.updated_at < $9`,
    g.ID, userID, g.Name, g.Color, g.IsCompact, seq, g.DeletedAt, g.IsDeleted, now, g.WorkspaceID)
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
```

Expected: builds without errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add internal/handler/sync.go
git commit -m "feat(sync): wire is_deleted into push handler for collections and groups"
```

---

### Task 4: Server Pull Handler Updates

**Files:**
- Modify: `TabSlate-server/internal/handler/sync.go`

The pull handler needs to SELECT and Scan `is_deleted` for collections and groups. For bookmarks, `IsTrashed` is now `int` — the Scan target type already changed in Task 2, so pgx will scan the int column correctly.

- [ ] **Step 1: Update collection pull SELECT and Scan**

In `sync.go`, find the collections pull section (around line 274–295). The current SELECT is:

```go
colRows, err := h.db.Query(ctx,
    `SELECT id, user_id, workspace_id, name, icon, position, seq, deleted_at, archived_at, created_at, updated_at
     FROM collections WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC`,
    userID, afterSeq)
```

Change to:

```go
colRows, err := h.db.Query(ctx,
    `SELECT id, user_id, workspace_id, name, icon, position, seq, deleted_at, archived_at, is_deleted, created_at, updated_at
     FROM collections WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC`,
    userID, afterSeq)
```

And the Scan (around line 284):

```go
if err := colRows.Scan(&col.ID, &col.UserID, &col.WorkspaceID, &col.Name, &col.Icon, &col.Position,
    &col.Seq, &col.DeletedAt, &col.ArchivedAt, &col.CreatedAt, &col.UpdatedAt); err != nil {
```

Change to:

```go
if err := colRows.Scan(&col.ID, &col.UserID, &col.WorkspaceID, &col.Name, &col.Icon, &col.Position,
    &col.Seq, &col.DeletedAt, &col.ArchivedAt, &col.IsDeleted, &col.CreatedAt, &col.UpdatedAt); err != nil {
```

- [ ] **Step 2: Update group pull SELECT and Scan**

In `sync.go`, find the groups pull section (around line 350–375). The current SELECT is:

```go
grpRows, err := h.db.Query(ctx,
    `SELECT id, user_id, name, color, is_compact, seq, deleted_at, created_at, updated_at, workspace_id
     FROM groups WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC`,
    userID, afterSeq)
```

Change to:

```go
grpRows, err := h.db.Query(ctx,
    `SELECT id, user_id, name, color, is_compact, seq, deleted_at, is_deleted, created_at, updated_at, workspace_id
     FROM groups WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC`,
    userID, afterSeq)
```

And the Scan (around line 362):

```go
if err := grpRows.Scan(&g.ID, &g.UserID, &g.Name, &g.Color, &g.IsCompact,
    &g.Seq, &g.DeletedAt, &g.CreatedAt, &g.UpdatedAt, &g.WorkspaceID); err != nil {
```

Change to:

```go
if err := grpRows.Scan(&g.ID, &g.UserID, &g.Name, &g.Color, &g.IsCompact,
    &g.Seq, &g.DeletedAt, &g.IsDeleted, &g.CreatedAt, &g.UpdatedAt, &g.WorkspaceID); err != nil {
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
go vet ./...
```

Expected: builds and vets without errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add internal/handler/sync.go
git commit -m "feat(sync): include is_deleted in pull SELECT/Scan for collections and groups"
```

---

### Task 5: Server CleanupHandler Goroutine

**Files:**
- Create: `TabSlate-server/internal/handler/cleanup.go`
- Modify: `TabSlate-server/app/config.go`
- Modify: `TabSlate-server/app/server.go`

- [ ] **Step 1: Create cleanup.go**

Create `/Users/lieutenant/Documents/github/TabSlate-server/internal/handler/cleanup.go`:

```go
package handler

import (
	"context"
	"log"
	"time"

	"github.com/tabslate/server/db"
)

const tombstoneWindowDays = 7

// CleanupHandler runs a background goroutine that:
//   Phase 1: auto-expires state=1 (soft-deleted) items to state=2 after the
//            grace period, bumping seq so tombstones appear in delta pulls.
//   Phase 2: hard-deletes state=2 items after the tombstone window.
type CleanupHandler struct {
	db             *db.DB
	trashGraceDays int
}

func NewCleanupHandler(d *db.DB, trashGraceDays int) *CleanupHandler {
	return &CleanupHandler{db: d, trashGraceDays: trashGraceDays}
}

// Run starts the cleanup loop. Call as a goroutine; exits when ctx is cancelled.
func (h *CleanupHandler) Run(ctx context.Context) {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.runOnce(ctx)
		}
	}
}

func (h *CleanupHandler) runOnce(ctx context.Context) {
	nowMs := time.Now().UnixMilli()
	graceMs := int64(h.trashGraceDays) * 24 * 60 * 60 * 1000
	tombstoneMs := int64(tombstoneWindowDays) * 24 * 60 * 60 * 1000

	h.phase1(ctx, nowMs, graceMs)
	h.phase2(ctx, nowMs, graceMs, tombstoneMs)
}

// phase1 promotes state=1 items past the grace period to state=2.
// Each affected user gets a seq bump so the tombstones appear in delta pulls.
func (h *CleanupHandler) phase1(ctx context.Context, nowMs, graceMs int64) {
	threshold := nowMs - graceMs

	// Find all users that have expired trash items.
	rows, err := h.db.Query(ctx,
		`SELECT DISTINCT user_id FROM bookmarks   WHERE is_trashed = 1 AND deleted_at < $1
		 UNION
		 SELECT DISTINCT user_id FROM collections WHERE is_deleted = 1  AND deleted_at < $1
		 UNION
		 SELECT DISTINCT user_id FROM groups      WHERE is_deleted = 1  AND deleted_at < $1`,
		threshold)
	if err != nil {
		log.Printf("cleanup phase1 users query: %v", err)
		return
	}
	defer rows.Close()

	var userIDs []string
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err != nil {
			log.Printf("cleanup phase1 users scan: %v", err)
			return
		}
		userIDs = append(userIDs, uid)
	}
	if err := rows.Err(); err != nil {
		log.Printf("cleanup phase1 rows err: %v", err)
		return
	}

	for _, uid := range userIDs {
		h.phase1ForUser(ctx, uid, threshold)
	}
}

func (h *CleanupHandler) phase1ForUser(ctx context.Context, userID string, threshold int64) {
	tx, err := h.db.Begin(ctx)
	if err != nil {
		log.Printf("cleanup phase1 begin tx for %s: %v", userID, err)
		return
	}
	defer tx.Rollback(ctx)

	newSeq, err := incrementSeq(ctx, tx, userID)
	if err != nil {
		log.Printf("cleanup phase1 incrementSeq for %s: %v", userID, err)
		return
	}

	if _, err := tx.Exec(ctx,
		`UPDATE bookmarks SET is_trashed = 2, seq = $1
		 WHERE user_id = $2 AND is_trashed = 1 AND deleted_at < $3`,
		newSeq, userID, threshold); err != nil {
		log.Printf("cleanup phase1 bookmarks for %s: %v", userID, err)
		return
	}
	if _, err := tx.Exec(ctx,
		`UPDATE collections SET is_deleted = 2, seq = $1
		 WHERE user_id = $2 AND is_deleted = 1 AND deleted_at < $3`,
		newSeq, userID, threshold); err != nil {
		log.Printf("cleanup phase1 collections for %s: %v", userID, err)
		return
	}
	if _, err := tx.Exec(ctx,
		`UPDATE groups SET is_deleted = 2, seq = $1
		 WHERE user_id = $2 AND is_deleted = 1 AND deleted_at < $3`,
		newSeq, userID, threshold); err != nil {
		log.Printf("cleanup phase1 groups for %s: %v", userID, err)
		return
	}

	if err := tx.Commit(ctx); err != nil {
		log.Printf("cleanup phase1 commit for %s: %v", userID, err)
	}
}

// phase2 hard-deletes state=2 items past the tombstone window.
// Deletion order: bookmarks first (FK collection_id ON DELETE SET NULL),
// then collections, then groups (group_tabs cascade automatically).
func (h *CleanupHandler) phase2(ctx context.Context, nowMs, graceMs, tombstoneMs int64) {
	cutoff := nowMs - graceMs - tombstoneMs

	if _, err := h.db.Exec(ctx,
		`DELETE FROM bookmarks WHERE is_trashed = 2 AND deleted_at < $1`, cutoff); err != nil {
		log.Printf("cleanup phase2 bookmarks: %v", err)
	}
	if _, err := h.db.Exec(ctx,
		`DELETE FROM collections WHERE is_deleted = 2 AND deleted_at < $1`, cutoff); err != nil {
		log.Printf("cleanup phase2 collections: %v", err)
	}
	if _, err := h.db.Exec(ctx,
		`DELETE FROM groups WHERE is_deleted = 2 AND deleted_at < $1`, cutoff); err != nil {
		log.Printf("cleanup phase2 groups: %v", err)
	}
}
```

- [ ] **Step 2: Add TrashGraceDays to Config**

In `app/config.go`, after the `RedisURL` field declaration, add:

```go
// TrashGraceDays is the number of days before a soft-deleted item is
// automatically promoted to permanently deleted (state=2). The cleanup
// goroutine uses this value. Defaults to 7.
TrashGraceDays int
```

In the `LoadConfig()` return block, after `RedisURL: os.Getenv("REDIS_URL"),`, add:

```go
TrashGraceDays: envInt("TRASH_GRACE_DAYS", 7),
```

- [ ] **Step 3: Wire CleanupHandler in server.go**

In `app/server.go`, in the `New` function, after the `s.setupCORS()` and `s.setupRoutes()` calls but before the `return s`, add:

```go
cleanupH := handler.NewCleanupHandler(database, cfg.TrashGraceDays)
go cleanupH.Run(ctx)
```

The full end of the `New` function should look like:

```go
s.setupCORS()
s.setupRoutes()
cleanupH := handler.NewCleanupHandler(database, cfg.TrashGraceDays)
go cleanupH.Run(ctx)
return s
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
go vet ./...
```

Expected: builds and vets without errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add internal/handler/cleanup.go app/config.go app/server.go
git commit -m "feat(cleanup): add goroutine to auto-expire and hard-delete permanently deleted items"
```

---

### Task 6: Client API Type Updates

**Files:**
- Modify: `TabSlate/lib/api.ts`

- [ ] **Step 1: Update ServerBookmark.is_trashed to number**

In `lib/api.ts` at line 68, change:

```ts
is_trashed: boolean;
```

to:

```ts
is_trashed: number;   // 0=active 1=trashed 2=permanently deleted
```

- [ ] **Step 2: Add is_deleted to ServerCollection**

In `lib/api.ts`, find the `ServerCollection` interface (line 44). After `archived_at?: number;`, add:

```ts
is_deleted: number;   // 0=active 1=trashed 2=permanently deleted
```

- [ ] **Step 3: Add is_deleted to ServerGroup**

In `lib/api.ts`, find the `ServerGroup` interface (line 96). After `deleted_at?: number;`, add:

```ts
is_deleted: number;   // 0=active 1=trashed 2=permanently deleted
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: Type errors in `bookmarks-store.ts` and `workspace-store.ts` because `is_trashed` and `is_deleted` types changed. These are expected; they'll be fixed in subsequent tasks.

- [ ] **Step 5: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add lib/api.ts
git commit -m "feat(api): update server types for integer deletion status fields"
```

---

### Task 7: Client bookmarks-store.ts Updates

**Files:**
- Modify: `TabSlate/store/bookmarks-store.ts`

- [ ] **Step 1: Change toServerBookmark opts — isTrashed type**

In `bookmarks-store.ts` at line 17, change the `opts` parameter type:

```ts
function toServerBookmark(b: Bookmark, opts: { isArchived?: boolean; isTrashed?: number } = {}): object {
```

And at line 27, change the default value from `false` to `0`:

```ts
is_trashed: opts.isTrashed ?? 0,
```

- [ ] **Step 2: Fix trashBookmark call site**

In `bookmarks-store.ts`, find `trashBookmark` (around line 249). Change:

```ts
syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isTrashed: true })] });
```

to:

```ts
syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isTrashed: 1 })] });
```

- [ ] **Step 3: Fix permanentlyDelete**

In `bookmarks-store.ts`, find `permanentlyDelete` (around line 276). Change:

```ts
syncEngine?.enqueue({ bookmarks: [toServerBookmark({ ...bookmark, deletedAt: Date.now() })] });
```

to:

```ts
syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark, { isTrashed: 2 })] });
```

- [ ] **Step 4: Fix permanentlyDeleteCollectionBookmarks**

In `bookmarks-store.ts`, find `permanentlyDeleteCollectionBookmarks` (around line 416). Change the loop body:

```ts
for (const b of all) {
  syncEngine?.enqueue({ bookmarks: [toServerBookmark({ ...b, deletedAt: Date.now() })] });
  idbDelete("trashed-bookmarks", b.id);
  idbDelete("archived-bookmarks", b.id);
}
```

to:

```ts
for (const b of all) {
  idbDelete("trashed-bookmarks", b.id);
  idbDelete("archived-bookmarks", b.id);
}
if (all.length > 0) {
  syncEngine?.enqueue({ bookmarks: all.map(b => toServerBookmark(b, { isTrashed: 2 })) });
}
```

(Batching the enqueue is more efficient and avoids calling enqueue in a loop.)

- [ ] **Step 5: Fix sweepUnsynced trashed items**

In `bookmarks-store.ts`, find `sweepUnsynced` (around line 359). Change:

```ts
...trashedBookmarks.filter(b => b.seq === 0).map(b => toServerBookmark(b, { isTrashed: true })),
```

to:

```ts
...trashedBookmarks.filter(b => b.seq === 0).map(b => toServerBookmark(b, { isTrashed: 1 })),
```

- [ ] **Step 6: Fix enqueueAllToSync trashed items**

In `bookmarks-store.ts`, find `enqueueAllToSync` (around line 287). Change:

```ts
...trashedBookmarks.map(b => toServerBookmark(b, { isTrashed: true })),
```

to:

```ts
...trashedBookmarks.map(b => toServerBookmark(b, { isTrashed: 1 })),
```

- [ ] **Step 7: Fix updateBookmark trashed branch**

In `bookmarks-store.ts`, find `updateBookmark` (around line 185). Change:

```ts
syncEngine?.enqueue({ bookmarks: [toServerBookmark(tb, { isTrashed: true })] });
```

to:

```ts
syncEngine?.enqueue({ bookmarks: [toServerBookmark(tb, { isTrashed: 1 })] });
```

- [ ] **Step 8: Add state=2 guard in mergeFromServer**

In `bookmarks-store.ts`, find `mergeFromServer` (around line 298). Currently it starts:

```ts
for (const sb of resp.entities.bookmarks) {
  if (sb.deleted_at) {
    bookmarks = bookmarks.filter(b => b.id !== sb.id);
    ...
```

Add the state=2 guard as the first check inside the loop, before the `deleted_at` check:

```ts
for (const sb of resp.entities.bookmarks) {
  // State=2: permanently deleted — remove from all stores, skip merge.
  if (sb.is_trashed === 2) {
    bookmarks = bookmarks.filter(b => b.id !== sb.id);
    archivedBookmarks = archivedBookmarks.filter(b => b.id !== sb.id);
    trashedBookmarks = trashedBookmarks.filter(b => b.id !== sb.id);
    continue;
  }
  if (sb.deleted_at) {
    ...
```

Also update the IDB cleanup section after `set()` returns. Currently there's a block:

```ts
for (const sb of resp.entities.bookmarks) {
  if (sb.deleted_at) {
    idbDelete("bookmarks", sb.id);
    idbDelete("archived-bookmarks", sb.id);
    idbDelete("trashed-bookmarks", sb.id);
  }
}
```

Change it to:

```ts
for (const sb of resp.entities.bookmarks) {
  if (sb.is_trashed === 2 || sb.deleted_at) {
    idbDelete("bookmarks", sb.id);
    idbDelete("archived-bookmarks", sb.id);
    idbDelete("trashed-bookmarks", sb.id);
  }
}
```

- [ ] **Step 9: Fix the is_trashed boolean check in mergeFromServer**

In `mergeFromServer`, the routing of bookmarks into the right bucket currently uses `if (sb.is_trashed)`. Since `is_trashed` is now `number`, this still works (truthy check: 0=false, 1 or 2=true), but state=2 is already handled above by `continue`. For clarity, change:

```ts
if (sb.is_trashed) {
```

to:

```ts
if (sb.is_trashed === 1) {
```

- [ ] **Step 10: Verify TypeScript compiles**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: no errors related to bookmarks-store.ts; remaining errors (if any) will be in workspace-store.ts and groups-store.ts.

- [ ] **Step 11: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add store/bookmarks-store.ts
git commit -m "feat(bookmarks): propagate is_trashed=2 on permanent delete, guard mergeFromServer"
```

---

### Task 8: Client workspace-store.ts Updates

**Files:**
- Modify: `TabSlate/store/workspace-store.ts`

- [ ] **Step 1: Add opts parameter to toServerCollection**

In `workspace-store.ts` at line 69, change:

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

to:

```ts
function toServerCollection(c: Collection, opts: { isDeleted?: number } = {}): object {
  return {
    id: c.id,
    workspace_id: c.workspaceId !== "" ? c.workspaceId : null,
    name: c.name,
    icon: c.icon,
    position: c.position,
    seq: c.seq,
    deleted_at: c.deletedAt ?? null,
    archived_at: c.archivedAt ?? null,
    is_deleted: opts.isDeleted ?? 0,
    updated_at: Date.now(),
  };
}
```

- [ ] **Step 2: Push state=2 in permanentlyDeleteCollection**

In `workspace-store.ts`, find `permanentlyDeleteCollection` (around line 517). Currently it is:

```ts
permanentlyDeleteCollection: (id) => {
  const col = get().collections.find(c => c.id === id && !!c.deletedAt);
  if (!col) { return; }
  idbDelete("collections", id);
  set((s) => ({ collections: s.collections.filter(c => c.id !== id) }));
  useBookmarksStore.getState().permanentlyDeleteCollectionBookmarks(id);
},
```

Change it to:

```ts
permanentlyDeleteCollection: (id) => {
  const col = get().collections.find(c => c.id === id && !!c.deletedAt);
  if (!col) { return; }
  syncEngine?.enqueue({ collections: [toServerCollection(col, { isDeleted: 2 })] });
  idbDelete("collections", id);
  set((s) => ({ collections: s.collections.filter(c => c.id !== id) }));
  useBookmarksStore.getState().permanentlyDeleteCollectionBookmarks(id);
},
```

- [ ] **Step 3: Add state=2 guard in mergeFromServer collections**

In `workspace-store.ts`, find the collections merge loop inside `mergeFromServer` (around line 276). The loop currently starts with `if (sc.deleted_at) {`. Add a state=2 guard before the `deleted_at` check:

```ts
for (const sc of resp.entities.collections) {
  // State=2: permanently deleted — remove from state and IDB, skip merge.
  if (sc.is_deleted === 2) {
    collections = collections.filter(c => c.id !== sc.id);
    idbDelete("collections", sc.id);
    continue;
  }
  if (sc.deleted_at) {
    ...
```

Note: the `idbDelete` call inside the `set()` updater is not allowed (updater must be pure). But `mergeFromServer` in this store already calls IDB operations after `set()`. Instead, collect the permanently-deleted IDs before `set()`, then handle IDB after. 

The cleanest approach: collect perm-deleted IDs before the `set()` call, then call `idbDelete` after `set()` returns (mirroring the existing pattern for workspace deletes).

The `set()` updater only filters the array; the IDB cleanup happens in the post-set block.

Modify the `mergeFromServer` function. Before the `set((state) => {` call, collect permanently deleted IDs:

```ts
const permDeletedCollectionIds = new Set(
  resp.entities.collections
    .filter(sc => sc.is_deleted === 2)
    .map(sc => sc.id)
);
```

Inside `set((state) => { ... })`, at the start of the collections loop, add:

```ts
for (const sc of resp.entities.collections) {
  if (permDeletedCollectionIds.has(sc.id)) {
    collections = collections.filter(c => c.id !== sc.id);
    continue;
  }
  if (sc.deleted_at) {
```

After `set()` returns (in the IDB sync block), add:

```ts
for (const id of permDeletedCollectionIds) {
  idbDelete("collections", id);
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: no errors related to workspace-store.ts.

- [ ] **Step 5: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add store/workspace-store.ts
git commit -m "feat(workspace): push is_deleted=2 on permanent delete, guard mergeFromServer"
```

---

### Task 9: Client groups-store.ts Updates

**Files:**
- Modify: `TabSlate/store/groups-store.ts`

- [ ] **Step 1: Add opts parameter to toServerGroup**

In `groups-store.ts` at line 29, change:

```ts
function toServerGroup(g: SavedGroup, tabs: GroupTab[]): object {
  return {
    id: g.id,
    name: g.name,
    color: g.color,
    is_compact: g.isCompact,
    seq: g.seq,
    deleted_at: g.deletedAt ?? null,
    created_at: new Date(g.createdAt).getTime(),
    updated_at: Date.now(),
    workspace_id: g.workspaceId,
    tabs: tabs.map(t => ({
      id: t.id,
      group_id: t.groupId,
      title: t.title,
      url: t.url,
      favicon: t.favicon,
      position: t.position,
    })),
  };
}
```

to:

```ts
function toServerGroup(g: SavedGroup, tabs: GroupTab[], opts: { isDeleted?: number } = {}): object {
  return {
    id: g.id,
    name: g.name,
    color: g.color,
    is_compact: g.isCompact,
    seq: g.seq,
    deleted_at: g.deletedAt ?? null,
    is_deleted: opts.isDeleted ?? 0,
    created_at: new Date(g.createdAt).getTime(),
    updated_at: Date.now(),
    workspace_id: g.workspaceId,
    tabs: tabs.map(t => ({
      id: t.id,
      group_id: t.groupId,
      title: t.title,
      url: t.url,
      favicon: t.favicon,
      position: t.position,
    })),
  };
}
```

- [ ] **Step 2: Push state=2 in permanentlyDeleteGroup**

In `groups-store.ts`, find `permanentlyDeleteGroup` (around line 169). Currently it is:

```ts
permanentlyDeleteGroup: (id) => {
  const tabs = get().groupTabs.filter(t => t.groupId === id);
  for (const t of tabs) { idbDelete("group-tabs", t.id); }
  idbDelete("groups", id);
  set((state) => ({
    groups: state.groups.filter(g => g.id !== id),
    groupTabs: state.groupTabs.filter(t => t.groupId !== id),
  }));
},
```

Change it to:

```ts
permanentlyDeleteGroup: (id) => {
  const group = get().groups.find(g => g.id === id);
  const tabs = get().groupTabs.filter(t => t.groupId === id);
  if (group) {
    syncEngine?.enqueue({ groups: [toServerGroup(group, [], { isDeleted: 2 })] });
  }
  for (const t of tabs) { idbDelete("group-tabs", t.id); }
  idbDelete("groups", id);
  set((state) => ({
    groups: state.groups.filter(g => g.id !== id),
    groupTabs: state.groupTabs.filter(t => t.groupId !== id),
  }));
},
```

Note: tabs are passed as `[]` to the push payload because the server's tab snapshot is irrelevant for a state=2 push; the push only needs to write `is_deleted=2` to the groups row.

- [ ] **Step 3: Add state=2 guard in mergeFromServer**

In `groups-store.ts`, find the `mergeFromServer` function (around line 246). The loop currently starts with:

```ts
for (const sg of serverGroups) {
  const idx = groups.findIndex(g => g.id === sg.id);

  if (nullWorkspaceIds.has(sg.id)) {
    groups = groups.filter(g => g.id !== sg.id);
    continue;
  }

  if (sg.deleted_at) {
    ...
```

Add the state=2 guard after the null-workspace check:

```ts
for (const sg of serverGroups) {
  const idx = groups.findIndex(g => g.id === sg.id);

  if (nullWorkspaceIds.has(sg.id)) {
    groups = groups.filter(g => g.id !== sg.id);
    continue;
  }

  // State=2: permanently deleted — remove from state.
  // IDB cleanup (groups + group-tabs) happens after set() returns.
  if (sg.is_deleted === 2) {
    groups = groups.filter(g => g.id !== sg.id);
    groupTabs = groupTabs.filter(t => t.groupId !== sg.id);
    continue;
  }

  if (sg.deleted_at) {
    ...
```

Collect the permanently-deleted group IDs before `set()` so IDB cleanup can run after. Before the `set((state) => {` call, add:

```ts
const permDeletedGroupIds = new Set(
  serverGroups
    .filter(sg => !nullWorkspaceIds.has(sg.id) && sg.is_deleted === 2)
    .map(sg => sg.id)
);
```

After `set()` returns, in the IDB persistence block, add cleanup for permanently deleted groups. Find the existing IDB block that starts with `// Purge null-workspace groups from IDB`:

```ts
// Purge null-workspace groups from IDB (fire-and-forget).
for (const id of nullWorkspaceIds) {
  idbDelete("groups", id);
}
```

After this block, add:

```ts
// Purge permanently deleted groups and their tabs from IDB.
for (const sg of serverGroups) {
  if (!permDeletedGroupIds.has(sg.id)) { continue; }
  idbDelete("groups", sg.id);
  for (const t of get().groupTabs.filter(t => t.groupId === sg.id)) {
    idbDelete("group-tabs", t.id);
  }
}
```

Wait — by the time we reach that code, `set()` has already removed the tabs from state. We need to capture the tab IDs before `set()`. Revise: collect the tab IDs before the `set()` call too:

```ts
const permDeletedGroupIds = new Set(
  serverGroups
    .filter(sg => !nullWorkspaceIds.has(sg.id) && sg.is_deleted === 2)
    .map(sg => sg.id)
);

// Capture tab IDs for perm-deleted groups BEFORE set() removes them from state.
const permDeletedTabIds: string[] = [];
if (permDeletedGroupIds.size > 0) {
  for (const t of get().groupTabs) {
    if (permDeletedGroupIds.has(t.groupId)) { permDeletedTabIds.push(t.id); }
  }
}
```

Then after `set()`, the IDB cleanup becomes:

```ts
// Purge permanently deleted groups and their tabs from IDB.
for (const id of permDeletedGroupIds) {
  idbDelete("groups", id);
}
for (const tabId of permDeletedTabIds) {
  idbDelete("group-tabs", tabId);
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: no type errors.

- [ ] **Step 5: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run build
```

Expected: clean build.

- [ ] **Step 6: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add store/groups-store.ts
git commit -m "feat(groups): push is_deleted=2 on permanent delete, guard mergeFromServer"
```

---

## Self-Review

### Spec Coverage Check

| Spec requirement | Covered by |
|---|---|
| bookmarks.is_trashed BOOLEAN→INT | Task 1 (schema), Task 2 (model), Task 3 (push), Task 4 (pull) |
| collections.is_deleted new INT column | Task 1 (schema), Task 2 (model), Task 3 (push), Task 4 (pull) |
| groups.is_deleted new INT column | Task 1 (schema), Task 2 (model), Task 3 (push), Task 4 (pull) |
| Data migration (old perm-deleted bookmarks → is_trashed=2) | Task 1 |
| Data migration (existing soft-deleted → is_deleted=1) | Task 1 |
| Push: permanentlyDelete sends is_trashed=2 | Task 7 (bookmarks), Task 8 (collections), Task 9 (groups) |
| Pull: state=2 included in delta pull | No filter added to pull query — already satisfied |
| Client mergeFromServer: state=2 discards and removes from IDB | Task 7 (bookmarks), Task 8 (collections), Task 9 (groups) |
| Goroutine Phase 1: auto-expire state=1→2 + seq bump | Task 5 |
| Goroutine Phase 2: hard-delete state=2 past tombstone window | Task 5 |
| TRASH_GRACE_DAYS env var | Task 5 |
| Quota check uses is_deleted=0 (not deleted_at IS NULL) | Task 3 |
| sweepUnsynced trashed items use isTrashed=1 | Task 7 |
| enqueueAllToSync trashed items use isTrashed=1 | Task 7 |
| Legacy fallback deleted_at guard retained | Not modified — existing code preserved |

### Type Consistency Check

- `toServerGroup(group, [], { isDeleted: 2 })` — three-arg signature defined in Task 9 Step 1 ✓
- `toServerCollection(col, { isDeleted: 2 })` — two-arg signature defined in Task 8 Step 1 ✓
- `toServerBookmark(bookmark, { isTrashed: 2 })` — `isTrashed: number` type defined in Task 7 Step 1 ✓
- `sg.is_deleted` used in groups mergeFromServer — field added to `ServerGroup` in Task 6 ✓
- `sc.is_deleted` used in workspace mergeFromServer — field added to `ServerCollection` in Task 6 ✓
- `sb.is_trashed === 2` used in bookmarks mergeFromServer — `is_trashed: number` set in Task 6 ✓

### Placeholder Check

None found.
