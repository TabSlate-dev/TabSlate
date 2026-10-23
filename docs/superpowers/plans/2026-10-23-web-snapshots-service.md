# Web Snapshots Service Implementation Plan (Sub-project C2-2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn C2-1's capture core into a working snapshot service in TabSlate-server. It adds:
- tables and a storage quota;
- a job queue, and local and S3 storage;
- automatic, backfill, and manual triggers;
- the `cmd/fetcher` worker;
- endpoints, signed file URLs, and sync rows;
- searchable snapshot text;
- the Docker setup.

**Architecture:**
- **Queue.** A public `jobqueue` package defines the job queue, and `jobqueue/redisqueue` implements it with Asynq on Redis. TabSlate Cloud (C2-3) injects Hatchet through `app.WithSnapshotQueue` and `app.RunFetcher`.
- **Storage.** `internal/blobstore` keeps files in a local directory or in S3-compatible storage.
- **Service.** `internal/snapshots` holds the API side (`Service`) and the worker side (`Worker`):
  - Postgres is the source of truth.
  - Every snapshot write takes a per-user advisory lock.
  - Each job carries a generation number.
  - Every change gets a new sync sequence number.
- **Wiring.** The handlers expose the endpoints and files and hook sync, REST, cleanup, and search. `app` wires everything when storage, a queue, and a URL secret are configured. Otherwise the server behaves exactly as before.

**Tech Stack:** Go 1.25, pgx v5, Gin, Asynq v0.26.0 (tested with the existing miniredis), meilisearch-go, Docker Compose, obscura 0.2.5, monolith v2.11.6. S3 requests are signed with AWS Signature Version 4 written in the package, as the SES mailer already does.

**Spec:** `docs/superpowers/specs/2026-10-21-web-snapshots-design.md` (in the TabSlate repository).

This plan covers these parts of the spec:
- section 1 (the server components);
- section 2;
- section 3, outside the capture itself: statuses, replacement, retries, stale jobs, limits, and the quota check;
- section 4;
- section 5, without the extension;
- section 7 (server side);
- section 8;
- section 9's README note;
- the server items of the Testing section.

It is plan 2 of 5 for C2:
1. C2-1 capture core (done before this plan).
2. C2-2 server snapshot service (this plan).
3. C2-3 Cloud: the Hatchet queue, the Flexprice storage feature, and Cloud's `cmd/fetcher`.
4. C2-4 extension.
5. C2-5 browser capture, including `POST /snapshots/:bookmarkId/upload`.

## Global Constraints

- **Repository and branch.**
  - All code is in `/Users/lieutenant/Documents/github/TabSlate-server`, on the branch `feat/web-snapshots` that C2-1 created.
  - Start only after C2-1 is complete: `internal/browser`, `internal/netguard`, and `internal/snapshots/capture` exist and their tests pass.
  - Other sessions use this checkout. Before Task 1, check `git branch --show-current` and `git status --short`. If the branch is not `feat/web-snapshots` or the tree has changes you did not make, stop and ask the user.
  - Do not push, open pull requests, or use git worktrees.
- **Commits.**
  - Stage files by path, then commit only those paths: `git add <paths>` followed by `git commit -m "…" -- <paths>`.
  - Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Go version.**
  - `go.mod` keeps `go 1.25.0` and gets no `toolchain` line. Run every Go command with `GOTOOLCHAIN=local`.
  - After `go get` or `go mod tidy`, `git diff go.mod` may show only `require` changes. If the `go` line changes or a `toolchain` line appears, run `git checkout go.mod go.sum` and report.
- **Dependencies.** Add exactly `github.com/hibiken/asynq v0.26.0`, which brings `github.com/robfig/cron/v3`, `github.com/spf13/cast`, and `golang.org/x/time` as indirect dependencies. Add no other modules.
- **Database tests.**
  - The handler tests and the new `internal/snapshots` tests need `TEST_DATABASE_URL` and skip without it. They truncate tables, so:
    - run them only against the throwaway container from Prerequisites, never against another session's database (such as the `codex-tabslate-nested-tags-tests` container) or a real one;
    - run DB-backed packages with `-p 1`, because the packages share tables.
  - Every test command below starts with `export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'`.
- **Server conventions.**
  - Use the standard `testing` package (`t.Context()`, `t.Fatalf`, `t.Errorf`).
  - CI runs `go build ./...`, `go vet ./...`, and `go test ./...` without a database; all must pass.
  - Run `gofmt -l` on the files you change. Some files that predate this plan are not gofmt-clean; leave them alone.
- **Spec values, copied exactly:**
  - A sync push or REST write enqueues at most 50 bookmarks.
  - Every 5 minutes the backfill enqueues up to 20 bookmarks per user, newest first. It only considers users who synced in the last 30 days, and only while more than 20% of the user's storage quota is free; unlimited plans have no reserve. A Postgres advisory lock lets one API instance run it.
  - A manual request carries at most 100 bookmarks. Manual updates of the same bookmark are at least 10 minutes apart.
  - "Save snapshots automatically" (`users.snapshot_auto`) is on by default and stops only the new-bookmark and backfill triggers.
  - Automatic triggers cover active bookmarks in active collections and workspaces; manual requests also accept archived bookmarks.
  - A URL change deletes the snapshot, frees its space, and enqueues the bookmark again.
  - Retryable failures are retried by the queue at most 3 times.
  - A queued snapshot without a result after 15 minutes is enqueued again; after 24 hours it fails and uses no space.
  - At most `SNAPSHOT_MAX_ATTEMPTS_PER_DAY` attempts per user per day: unlimited by default, and Cloud sets 1,000.
  - Usage is the total size of the user's snapshot files. Saving takes a per-user lock before computing usage. Manual requests answer `403 quota_exceeded` when storage is full.
  - `MaxSnapshotStorageMB`: `-1` is unlimited and `0` means the plan has no snapshots. `subscription_capacity.max_snapshot_storage_mb` defaults to `-1`.
  - Files live at `snapshots/<userId>/<assetId>`.
  - A file URL is `/snapshot-assets/<assetId>?sig=<hex>`. It does not expire and is answered with `Cache-Control: private, max-age=31536000, immutable`.
  - File responses send `X-Content-Type-Options: nosniff` and this CSP, except for PDFs, which get only `nosniff`: `sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; img-src https: data: blob:; style-src 'unsafe-inline' https: data:; font-src https: data:; media-src https: data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'`.
  - File responses support Range requests, and `download=1` serves the file as an attachment.
  - Snapshot text in the search index is at most 50,000 characters, and a match in it adds a snippet of about 30 words.
- **Reason codes.** C2-1's codes plus `storage_full` (`snapshots.ReasonStorageFull`). A job that waited 24 hours fails with `timeout`.
- **C2-1 interfaces used:**
  - `capture.New(capture.Config{Guard, Renderer, MonolithPath})`;
  - `(*capture.Capturer).Capture(ctx, rawURL) (*capture.Result, error)` and `Archive(ctx, rawURL) (*capture.ArchiveResult, error)`;
  - `capture.Result{Kind, FinalURL, HTTPStatus, Title, Excerpt, Reader, Screenshot, Cover, File}`, `capture.File{Data, ContentType}`, and `capture.ArchiveResult{FinalURL, Archive}`;
  - `capture.Failure{Reason, HTTPStatus, Retryable, Detail, Err}`, the `capture.Reason*` constants, and `capture.ErrArchivesDisabled`;
  - `netguard.New(netguard.Options{})` and `netguard.ValidateURL`;
  - `browser.Browser{URL, Token, Limits}` and `browser.DefaultLimits`.

## Notes on the Spec

1. **Public queue package.** The spec puts the queue interface in `internal/jobqueue/`. Cloud imports this module as a dependency and cannot import `internal/` packages, so:
   - the interface is a public `jobqueue` package;
   - the Asynq implementation is `jobqueue/redisqueue`.

   This mirrors `billing` and `billing/local`.
2. **One record per file.** The spec lists asset references on `bookmark_snapshots` as well as `snapshot_assets`. Here every file has exactly one `snapshot_assets` row, unique per bookmark and type (`reader`, `screenshot`, `cover`, `file`, `archive`), and the snapshot row has no asset columns. Usage and snapshot sizes are sums, and replacing a file is a delete plus an insert in one transaction.
3. **Jobs in flight.**
   - `queued_at` (or `archive_queued_at`) marks a capture (or archive) that waits for a result, and `enqueued_at` records when it last went to the queue.
   - An update keeps a ready snapshot `ready`: the spec's statuses describe the content. Pull rows add `pending` and `archive_pending`, so the extension can show progress.
   - Archives have their own generation (`archive_generation`), so updating a snapshot does not cancel an archive. Both come from one Postgres sequence, so a re-created row never reuses a number that an old job may still carry.
4. **The job carries the storage limit.** `jobqueue.Job.StorageLimit` is the user's limit in bytes when the job was queued. The worker re-checks the actual size against it, so it needs no billing provider ("The worker contains no billing logic").
5. **Attempts.**
   - Every capture or archive that the API queues counts as one attempt: new bookmarks, the backfill, and manual requests. Queue retries and the 15-minute re-enqueue do not count.
   - `SNAPSHOT_MAX_ATTEMPTS_PER_DAY=0`, the default, means unlimited.
   - When the limit is reached, bookmarks in a manual request are skipped with `daily_limit`, and an archive request answers `429`.
6. **Snapshot text has its own index.** The spec adds `content` to the bookmark document. The API rewrites that document on every edit, deletes it when a bookmark goes to the trash, and adds it again on restore. On none of these paths can it read reader versions from storage, so the text would be lost.
   - The text lives in a second MeiliSearch index, `snapshots` (`id` = bookmark ID, `userId`, `content`).
   - `GET /search` appends bookmarks that matched only in that text, after the bookmark matches, each with a `snippet`. It returns 20 results at most and never returns the text.
   - This keeps the spec's ranking, in which content comes after title, URL, description, and notes.
7. **Pull reads the sequence number first.** `GET /sync/pull` used to read `server_seq` after the entities. A change committed in between got a number at or below `server_seq` without being in the response, so clients skipped it for good. Worker results arrive at any time, so this plan reads `server_seq` first; such a change then comes back in the next pull.
8. **"Synced in the last 30 days."** `users.last_login_at` changes only on password login, so the backfill uses a new `users.last_sync_at`. `GET /sync/pull` writes it at most once a day.
9. **Turning snapshots on.**
   - Snapshots also need `SNAPSHOT_URL_SECRET` (at least 32 bytes), besides storage and a queue.
   - With no storage or no queue they stay off, and the server logs why.
   - A configuration error stops the server at startup instead of silently turning snapshots off: an unknown storage kind, incomplete S3 settings, or a short secret.
10. **Which bookmarks qualify.**
    - Automatic triggers take bookmarks that are:
      - not archived, trashed, or deleted;
      - in a collection that is neither archived nor in the trash, in an active workspace;
      - saved with an `http` or `https` URL.

      Bookmarks without a collection are left out, as REST listing and search leave them out.
    - Manual requests also accept archived bookmarks and bookmarks in archived collections. Links that are not `http` or `https` are skipped as `unsupported`.
    - Snapshots that failed or are `unsupported` are never retried automatically.
11. **Deletion paths.**
    - `RemoveGone` deletes snapshots whose bookmark changed its URL or reached `is_trashed = 2`. It runs after every sync push that contains bookmarks or collections, which covers the server-side collection cascade, after every REST create or update, and daily for every user.
    - Workspace purges, the cleanup's hard delete of old tombstones, and account deletion remove rows physically. The foreign keys then remove the snapshot rows, and the daily garbage collection removes the files.
    - REST `DELETE /bookmarks/:id` only sets `deleted_at`, so the snapshot stays, as it does for the trash.
12. **Quota details.**
    - MB means MiB (`<< 20`).
    - New-bookmark triggers need any free space.
    - The backfill needs more than 20% free.
    - A manual request answers `403 quota_exceeded` when usage is at or over the limit, or when the plan's limit is 0.
13. **Endpoint answers.** Snapshot endpoints answer `503` when snapshots are off.

    | Endpoint | Answers |
    |---|---|
    | `POST /snapshots` | `200 {"queued": [...], "skipped": [{"bookmark_id", "reason"}]}`, `400` for an empty or oversized list, `403 quota_exceeded`. Skip reasons: `not_found`, `too_soon`, `unsupported`, `daily_limit`. |
    | `POST /snapshots/:bookmarkId/archive` | `202 {"queued": true}`, `404`, `409 no_snapshot` (no ready page snapshot), `409 already_queued`, `403 quota_exceeded`, `429 daily_limit`. |
    | `DELETE /snapshots/:bookmarkId` and `DELETE /snapshots/:bookmarkId/archive` | `204` or `404`. |
    | `GET` and `PUT /snapshots/settings` | `{"auto": bool}`; `400` when `auto` is missing. |
    | `GET /snapshot-assets/:assetId` | `404` for a bad signature, an unknown asset, or a missing file. |
14. **Docker.**
    - `docker-compose.yml` starts `fetcher`, `obscura`, and `redis` only with the `snapshots` profile (`COMPOSE_PROFILES=snapshots`), so an upgraded stack runs exactly as before until someone configures snapshots.
    - obscura is pinned to `h4ckf0r0day/obscura:0.2.5`, the newest tag when this plan was written. Use the tag that C2-1's Task 3 recorded.
    - The fetcher image is Debian, because monolith's release binaries link against glibc.
    - Both images give uid 10001 ownership of `/data`, so the shared volume is writable by the non-root fetcher.
    - CI publishes `tabslate-fetcher` next to `tabslate-server`.
15. **Per-user concurrency.** The Redis queue does not limit jobs per user, which the spec accepts. Hatchet does in C2-3.
16. **Cloud.** `app.New` gains variadic options, so Cloud's call compiles unchanged. Cloud's `go.sum` needs `go mod tidy` for the new dependencies, which C2-3 does. Until C2-3, Cloud's plans report `MaxSnapshotStorageMB = 0`, so they have no snapshots.

## File Structure

`jobqueue/` (public)
- `jobqueue.go`: `Job`, `Kind`, `Queue`, `Worker`, `Handler`, `MaxRetries`, `Job.Key`.
- `redisqueue/redisqueue.go`: `Queue` (Asynq client, task ID = job key) and `Worker` (Asynq server). Its test is `redisqueue_test.go`.

`internal/blobstore/`
- `blobstore.go`: `Store`, `Object`, `ErrNotFound`, `Config`, `Open`.
- `local.go`: the `Local` store.
- `s3.go`: the `S3` store and SigV4 signing.
- `store_test.go` (a contract test shared by both stores), `local_test.go`, `s3_test.go` (AWS signing examples and a fake S3), `open_test.go`.

`internal/snapshots/`
- `snapshots.go`: statuses, asset types, lock keys, and helpers: `lockUser`, `storageUsage`, `nextSeq`, `deleteSnapshots`.
- `change.go`: the work that waits for a commit: delete files and texts, enqueue, broadcast.
- `urls.go`: `Signer`.
- `service.go`: `Service`, `Config`, the automatic setting, `NoteSync`.
- `rows.go`: sync rows.
- `keycheck.go`: `CheckURLKey`.
- `requests.go`: manual requests, archives, deletion, `RemoveGone`, attempts.
- `triggers.go`: `AfterBookmarkWrites` and automatic enqueueing.
- `text.go`: `ReaderText`.
- `worker.go`: `Worker`.
- `scheduler.go`: `Tick`, `RunScheduler`, `RemoveGoneEverywhere`, `CollectGarbage`.
- `reindex.go`: `EachReaderText`.
- `assets.go`: `OpenAsset`.
- Tests: `helpers_test.go`, `urls_test.go`, `rows_test.go`, `requests_test.go`, `triggers_test.go`, `text_test.go`, `worker_test.go`, `scheduler_test.go`, `reindex_test.go`.

`internal/handler/`
- New: `snapshots.go` and `snapshots_test.go`, `snapshot_sync_test.go`, `search_snapshot_test.go`, `snapshot_storage_test.go`.
- Modified: `billing.go`, `search.go`, `sync.go`, `bookmarks.go`, `cleanup.go`.

Other changes:
- `internal/model/model.go`, `internal/search/client.go`, `internal/search/types.go` (with the new test `internal/search/snapshot_text_test.go`).
- `billing/types.go`, `billing/local/provider.go`, `billing/local/provider_test.go`, `db/schema.pg.sql`.
- `app/snapshots.go` and `app/snapshots_test.go` (new), `app/config.go`, `app/server.go`.
- `cmd/fetcher/main.go` (new), `cmd/reindex/main.go`.
- `Dockerfile`, `docker-compose.yml`, `.github/workflows/docker-publish.yml`, `.env.example`, `README.md`, `CLAUDE.md`, `ARCHITECTURE.md`.

## Prerequisites

- C2-1 is complete on `feat/web-snapshots`.
- Network access for `go get` and Docker images.
- Docker (OrbStack on this machine; if `docker info` fails, ask the user to start it). Start a throwaway Postgres for the database tests:

```bash
docker run -d --rm --name tabslate-c22-test-pg -p 127.0.0.1:55433:5432 \
  -e POSTGRES_PASSWORD=c22test -e POSTGRES_DB=tabslate_test postgres:17-alpine
until docker exec tabslate-c22-test-pg pg_isready -U postgres -d tabslate_test; do sleep 1; done
```

If port 55433 is taken, pick another free port and use it in `TEST_DATABASE_URL` throughout. Stop the container with `docker stop tabslate-c22-test-pg` after Task 14.

---

### Task 1: Schema, storage limit, and plan usage

**Files:**
- Modify: `db/schema.pg.sql` (append), `billing/types.go`, `billing/local/provider.go`, `internal/handler/billing.go`
- Test: `billing/local/provider_test.go`, `internal/handler/snapshot_storage_test.go` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - The tables `bookmark_snapshots`, `snapshot_assets`, and `snapshot_attempts`, and the sequence `snapshot_generation_seq`.
  - The columns `users.snapshot_auto`, `users.last_sync_at`, and `subscription_capacity.max_snapshot_storage_mb`.
  - `billing.Limits.MaxSnapshotStorageMB int` (`json:"max_snapshot_storage_mb"`): `-1` unlimited, `0` no snapshots.
  - `GET /api/plan` gains `snapshot_storage_bytes`, the sum of the user's `snapshot_assets.size`.

- [ ] **Step 1: Write the failing tests**

In `billing/local/provider_test.go`, add the imports and two tests:

Replace:

```go
import (
	"context"
	"testing"

	"github.com/TabSlate-dev/TabSlate-server/billing"
)

var _ billing.Provider = (*Provider)(nil)
```

with:

```go
import (
	"context"
	"os"
	"testing"

	"github.com/TabSlate-dev/TabSlate-server/billing"
	"github.com/TabSlate-dev/TabSlate-server/db"
)

var _ billing.Provider = (*Provider)(nil)
```

Append to the end of `billing/local/provider_test.go`:

```go
func TestGetLimits_nilDB_snapshotStorageUnlimited(t *testing.T) {
	limits, err := New(nil).GetLimits(context.Background(), "any-user")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if limits.MaxSnapshotStorageMB != -1 {
		t.Errorf("MaxSnapshotStorageMB = %d, want -1 (unlimited)", limits.MaxSnapshotStorageMB)
	}
}

func TestGetLimits_readsSnapshotStorage(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	database, err := db.Open(dsn)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(database.Close)
	if err := db.Migrate(database); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := database.Exec(t.Context(), `UPDATE subscription_capacity SET max_snapshot_storage_mb = 2048 WHERE plan_code = 'unlimited'`); err != nil {
		t.Fatalf("set snapshot storage: %v", err)
	}
	t.Cleanup(func() {
		_, _ = database.Exec(context.Background(), `UPDATE subscription_capacity SET max_snapshot_storage_mb = -1 WHERE plan_code = 'unlimited'`)
	})

	limits, err := New(database).GetLimits(t.Context(), "any-user")
	if err != nil {
		t.Fatalf("GetLimits: %v", err)
	}
	if limits.MaxSnapshotStorageMB != 2048 {
		t.Fatalf("MaxSnapshotStorageMB = %d, want 2048", limits.MaxSnapshotStorageMB)
	}
}
```

Create `internal/handler/snapshot_storage_test.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TabSlate-dev/TabSlate-server/billing"
	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/middleware"
	"github.com/gin-gonic/gin"
)

func TestSnapshotSchemaMigrationRunsTwice(t *testing.T) {
	testDB := openSyncTestDB(t)
	if err := db.Migrate(testDB); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	var auto bool
	var storageMB int
	if err := testDB.QueryRow(t.Context(), `
		SELECT (SELECT column_default = 'true' FROM information_schema.columns
		         WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'snapshot_auto'),
		       (SELECT max_snapshot_storage_mb FROM subscription_capacity WHERE plan_code = 'unlimited')`,
	).Scan(&auto, &storageMB); err != nil {
		t.Fatalf("read snapshot columns: %v", err)
	}
	if !auto || storageMB != -1 {
		t.Fatalf("snapshot_auto defaults to true = %v, unlimited plan storage = %d MB; want true and -1", auto, storageMB)
	}
}

func TestPlanReportsSnapshotStorage(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "plan-snapshots@example.com", password: "password123"})
	otherID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "plan-snapshots-other@example.com", password: "password123"})
	if _, err := testDB.Exec(t.Context(), `
		INSERT INTO bookmarks (id, user_id, title, url, created_at, updated_at)
		VALUES ('plan-snapshot-bookmark', $1, 'Mine', 'https://mine.example.com', 1, 1),
		       ('plan-snapshot-other', $2, 'Theirs', 'https://theirs.example.com', 1, 1)`, userID, otherID); err != nil {
		t.Fatalf("insert bookmarks: %v", err)
	}
	if _, err := testDB.Exec(t.Context(), `
		INSERT INTO snapshot_assets (id, user_id, bookmark_id, type, content_type, size, created_at)
		VALUES ('11111111-1111-4111-8111-111111111111', $1, 'plan-snapshot-bookmark', 'reader', 'text/html; charset=utf-8', 100, 1),
		       ('22222222-2222-4222-8222-222222222222', $1, 'plan-snapshot-bookmark', 'screenshot', 'image/jpeg', 250, 1),
		       ('33333333-3333-4333-8333-333333333333', $2, 'plan-snapshot-other', 'reader', 'text/html; charset=utf-8', 999, 1)`,
		userID, otherID); err != nil {
		t.Fatalf("insert snapshot assets: %v", err)
	}
	limits := syncTestLimits()
	limits.MaxSnapshotStorageMB = 512

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	ginContext.Request = httptest.NewRequest(http.MethodGet, "/api/plan", nil)
	ginContext.Set(middleware.UserIDKey, userID)
	NewBillingHandler(fixedLimitsProvider{limits: limits}, nil, testDB).GetPlan(ginContext)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s, want 200", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Limits               billing.Limits `json:"limits"`
		SnapshotStorageBytes int64          `json:"snapshot_storage_bytes"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode plan response: %v", err)
	}
	if response.SnapshotStorageBytes != 350 || response.Limits.MaxSnapshotStorageMB != 512 {
		t.Fatalf("snapshot storage = %d bytes of %d MB, want 350 of 512", response.SnapshotStorageBytes, response.Limits.MaxSnapshotStorageMB)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./billing/local/ ./internal/handler/ -run 'Snapshot'
```

Expected: the build fails with `limits.MaxSnapshotStorageMB undefined (type *billing.Limits has no field or method MaxSnapshotStorageMB)`.

- [ ] **Step 3: Add the schema**

Append to the end of `db/schema.pg.sql`:

```sql
-- Web snapshots (C2). snapshot_auto turns the automatic captures off;
-- last_sync_at (Unix seconds, written at most daily by GET /sync/pull) limits
-- the backfill to users who synced recently.
ALTER TABLE users ADD COLUMN IF NOT EXISTS snapshot_auto BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sync_at BIGINT;
ALTER TABLE subscription_capacity ADD COLUMN IF NOT EXISTS max_snapshot_storage_mb INTEGER NOT NULL DEFAULT -1;

-- Job generations come from one sequence, so a re-created snapshot row never
-- reuses the number of a job that may still be in the queue.
CREATE SEQUENCE IF NOT EXISTS snapshot_generation_seq;

-- One row per bookmark. Times are Unix milliseconds. queued_at is set while a
-- capture job is pending and enqueued_at is when it last went to the queue;
-- the archive_* columns do the same for full-page archives. status 'deleted'
-- keeps the row so the deletion reaches other devices through sync.
CREATE TABLE IF NOT EXISTS bookmark_snapshots (
    bookmark_id         TEXT PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url                 TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('queued', 'ready', 'failed', 'unsupported', 'deleted')),
    kind                TEXT NOT NULL DEFAULT '' CHECK (kind IN ('', 'page', 'image', 'pdf')),
    captured_at         BIGINT,
    http_status         INTEGER NOT NULL DEFAULT 0,
    final_url           TEXT NOT NULL DEFAULT '',
    title               TEXT NOT NULL DEFAULT '',
    excerpt             TEXT NOT NULL DEFAULT '',
    failure_reason      TEXT NOT NULL DEFAULT '',
    failure_status      INTEGER NOT NULL DEFAULT 0,
    failed_at           BIGINT,
    archive_status      TEXT NOT NULL DEFAULT '' CHECK (archive_status IN ('', 'queued', 'ready', 'failed')),
    archive_at          BIGINT,
    archive_error       TEXT NOT NULL DEFAULT '',
    manual_requested_at BIGINT,
    generation          BIGINT NOT NULL DEFAULT 0,
    queued_at           BIGINT,
    enqueued_at         BIGINT,
    archive_generation  BIGINT NOT NULL DEFAULT 0,
    archive_queued_at   BIGINT,
    archive_enqueued_at BIGINT,
    seq                 BIGINT NOT NULL DEFAULT 0,
    updated_at          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmark_snapshots_user_seq ON bookmark_snapshots (user_id, seq);
CREATE INDEX IF NOT EXISTS idx_bookmark_snapshots_pending
    ON bookmark_snapshots (enqueued_at) WHERE queued_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookmark_snapshots_archive_pending
    ON bookmark_snapshots (archive_enqueued_at) WHERE archive_queued_at IS NOT NULL;

-- One row per stored file, at snapshots/<user_id>/<id> in snapshot storage.
-- A user's storage usage is the sum of size.
CREATE TABLE IF NOT EXISTS snapshot_assets (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bookmark_id  TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    type         TEXT NOT NULL CHECK (type IN ('reader', 'screenshot', 'cover', 'file', 'archive')),
    content_type TEXT NOT NULL,
    size         BIGINT NOT NULL,
    created_at   BIGINT NOT NULL,
    UNIQUE (bookmark_id, type)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_assets_user ON snapshot_assets (user_id);

-- Capture attempts per user per UTC day, for SNAPSHOT_MAX_ATTEMPTS_PER_DAY.
CREATE TABLE IF NOT EXISTS snapshot_attempts (
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day      DATE NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
```

- [ ] **Step 4: Add the storage limit**

In `billing/types.go`:

Replace:

```go
	MaxTags        int `json:"max_tags"`
	MaxSavedGroups int `json:"max_saved_groups"`
	TrashGraceDays int `json:"trash_grace_days"`
}

// Subscription holds the user's current subscription state.
```

with:

```go
	MaxTags        int `json:"max_tags"`
	MaxSavedGroups int `json:"max_saved_groups"`
	TrashGraceDays int `json:"trash_grace_days"`
	// MaxSnapshotStorageMB caps the total size of a user's web snapshot files,
	// in MiB. -1 means unlimited and 0 means the plan has no snapshots.
	MaxSnapshotStorageMB int `json:"max_snapshot_storage_mb"`
}

// Subscription holds the user's current subscription state.
```

In `billing/local/provider.go`, read the new column and make the fallback unlimited:

Replace:

```go
	if p.db != nil {
		var l billing.Limits
		err := p.db.QueryRow(ctx, `
			SELECT max_workspaces, max_bookmarks, max_collections, max_tags, max_saved_groups, trash_grace_days
			FROM subscription_capacity WHERE plan_code = 'unlimited'
		`).Scan(&l.MaxWorkspaces, &l.MaxBookmarks, &l.MaxCollections, &l.MaxTags, &l.MaxSavedGroups, &l.TrashGraceDays)
		if err == nil {
			return &l, nil
		}
```

with:

```go
	if p.db != nil {
		var l billing.Limits
		err := p.db.QueryRow(ctx, `
			SELECT max_workspaces, max_bookmarks, max_collections, max_tags, max_saved_groups, trash_grace_days,
			       max_snapshot_storage_mb
			FROM subscription_capacity WHERE plan_code = 'unlimited'
		`).Scan(&l.MaxWorkspaces, &l.MaxBookmarks, &l.MaxCollections, &l.MaxTags, &l.MaxSavedGroups, &l.TrashGraceDays,
			&l.MaxSnapshotStorageMB)
		if err == nil {
			return &l, nil
		}
```

Replace:

```go
func unlimitedLimits() *billing.Limits {
	return &billing.Limits{
		MaxWorkspaces:  -1,
		MaxBookmarks:   -1,
		MaxCollections: -1,
		MaxTags:        -1,
		MaxSavedGroups: -1,
		TrashGraceDays: -1,
	}
}
```

with:

```go
func unlimitedLimits() *billing.Limits {
	return &billing.Limits{
		MaxWorkspaces:        -1,
		MaxBookmarks:         -1,
		MaxCollections:       -1,
		MaxTags:              -1,
		MaxSavedGroups:       -1,
		TrashGraceDays:       -1,
		MaxSnapshotStorageMB: -1,
	}
}
```

- [ ] **Step 5: Report the usage in `GET /api/plan`**

In `internal/handler/billing.go`:

Replace:

```go
	Limits       *billing.Limits       `json:"limits"`
	Usage        planUsage             `json:"usage"`
	TrashUsage   planUsage             `json:"trash_usage"`
}

type planUsage struct {
```

with:

```go
	Limits       *billing.Limits       `json:"limits"`
	Usage        planUsage             `json:"usage"`
	TrashUsage   planUsage             `json:"trash_usage"`
	// SnapshotStorageBytes is the total size of the user's snapshot files,
	// which limits.max_snapshot_storage_mb caps.
	SnapshotStorageBytes int64 `json:"snapshot_storage_bytes"`
}

type planUsage struct {
```

Replace:

```go
	usage := planUsage{}
	trashUsage := planUsage{}
	if err := h.db.QueryRow(ctx, `
		WITH workspace_usage AS (
			SELECT
```

with:

```go
	usage := planUsage{}
	trashUsage := planUsage{}
	var snapshotStorageBytes int64
	if err := h.db.QueryRow(ctx, `
		WITH workspace_usage AS (
			SELECT
```

Replace:

```go
			FROM groups g
			LEFT JOIN workspaces w ON w.id = g.workspace_id AND w.user_id = g.user_id
			WHERE g.user_id = $1
		)
		SELECT
			workspace_usage.total,
```

with:

```go
			FROM groups g
			LEFT JOIN workspaces w ON w.id = g.workspace_id AND w.user_id = g.user_id
			WHERE g.user_id = $1
		), snapshot_usage AS (
			SELECT COALESCE(SUM(size), 0)::BIGINT AS total
			FROM snapshot_assets
			WHERE user_id = $1
		)
		SELECT
			workspace_usage.total,
```

Replace:

```go
			collection_usage.trash,
			bookmark_usage.trash,
			0,
			group_usage.trash
		FROM workspace_usage, collection_usage, bookmark_usage, tag_usage, group_usage`,
		userID,
	).Scan(
		&usage.Workspaces,
```

with:

```go
			collection_usage.trash,
			bookmark_usage.trash,
			0,
			group_usage.trash,
			snapshot_usage.total
		FROM workspace_usage, collection_usage, bookmark_usage, tag_usage, group_usage, snapshot_usage`,
		userID,
	).Scan(
		&usage.Workspaces,
```

Replace:

```go
		&trashUsage.Bookmarks,
		&trashUsage.Tags,
		&trashUsage.SavedGroups,
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch usage"})
		return
	}

	c.JSON(http.StatusOK, planResponse{
		Subscription: subscription,
		Limits:       limits,
		Usage:        usage,
		TrashUsage:   trashUsage,
	})
}
```

with:

```go
		&trashUsage.Bookmarks,
		&trashUsage.Tags,
		&trashUsage.SavedGroups,
		&snapshotStorageBytes,
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch usage"})
		return
	}

	c.JSON(http.StatusOK, planResponse{
		Subscription:         subscription,
		Limits:               limits,
		Usage:                usage,
		TrashUsage:           trashUsage,
		SnapshotStorageBytes: snapshotStorageBytes,
	})
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./billing/local/ ./internal/handler/ -run 'Snapshot|TestPlanUsage' -v
gofmt -l billing internal/handler/billing.go internal/handler/snapshot_storage_test.go
```

Expected: all five tests pass:
- `TestGetLimits_nilDB_snapshotStorageUnlimited`
- `TestGetLimits_readsSnapshotStorage`
- `TestSnapshotSchemaMigrationRunsTwice`
- `TestPlanReportsSnapshotStorage`
- `TestPlanUsage_EffectiveContainment`

`gofmt` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add db/schema.pg.sql billing/types.go billing/local/provider.go billing/local/provider_test.go \
  internal/handler/billing.go internal/handler/snapshot_storage_test.go
git commit -m "feat(snapshots): add snapshot tables and the storage limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- db/schema.pg.sql billing/types.go \
  billing/local/provider.go billing/local/provider_test.go internal/handler/billing.go \
  internal/handler/snapshot_storage_test.go
```

---

### Task 2: Job queue

**Files:**
- Create: `jobqueue/jobqueue.go`, `jobqueue/redisqueue/redisqueue.go`, `jobqueue/redisqueue/redisqueue_test.go`
- Modify: `go.mod`, `go.sum`

**Interfaces:**
- Consumes: nothing.
- Produces (public, for C2-3):
  - `jobqueue.Job{Kind Kind; UserID, BookmarkID string; Generation, StorageLimit int64}` (JSON tags `kind`, `user_id`, `bookmark_id`, `generation`, `storage_limit`), and `Job.Key() string` = `"<kind>:<bookmarkID>:<generation>"`.
  - `jobqueue.KindCapture` (`"capture"`), `jobqueue.KindArchive` (`"archive"`), `jobqueue.MaxRetries = 3`.
  - `jobqueue.Queue` (`Enqueue(ctx, Job) error`), `jobqueue.Worker` (`Run(ctx, Handler) error`), and `jobqueue.Handler` = `func(ctx context.Context, job Job, lastAttempt bool) error`.
  - `redisqueue.New(redisURL) (*redisqueue.Queue, error)` with `Enqueue` and `Close`.
  - `redisqueue.NewWorker(redisURL, concurrency) (*redisqueue.Worker, error)` with `Run`.

- [ ] **Step 1: Add Asynq**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
GOTOOLCHAIN=local go get github.com/hibiken/asynq@v0.26.0
git diff go.mod
```

Expected:
- new `require` lines for `github.com/hibiken/asynq v0.26.0` and, as indirect, `github.com/robfig/cron/v3 v3.0.1`, `github.com/spf13/cast v1.10.0`, and `golang.org/x/time v0.14.0`;
- `go 1.25.0` unchanged.

- [ ] **Step 2: Write the failing test**

The test runs a real Asynq worker against miniredis. It shortens the retry delay and the scheduler's poll interval through the unexported fields that the implementation provides for this.

Create `jobqueue/redisqueue/redisqueue_test.go`:

```go
package redisqueue

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
	"github.com/alicebob/miniredis/v2"
	"github.com/hibiken/asynq"
)

type delivery struct {
	job         jobqueue.Job
	lastAttempt bool
}

func startRedis(t *testing.T) string {
	t.Helper()
	server := miniredis.RunT(t)
	return "redis://" + server.Addr()
}

func newQueue(t *testing.T, redisURL string) *Queue {
	t.Helper()
	queue, err := New(redisURL)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = queue.Close() })
	return queue
}

// runWorker starts a worker whose retries come back quickly and stops it when the test ends.
func runWorker(t *testing.T, redisURL string, handle jobqueue.Handler) {
	t.Helper()
	worker, err := NewWorker(redisURL, 2)
	if err != nil {
		t.Fatalf("NewWorker: %v", err)
	}
	worker.retryDelay = func(int, error, *asynq.Task) time.Duration { return 10 * time.Millisecond }
	worker.pollInterval = 50 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx, handle) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("Run: %v", err)
		}
	})
}

func receive(t *testing.T, deliveries <-chan delivery) delivery {
	t.Helper()
	select {
	case d := <-deliveries:
		return d
	case <-time.After(10 * time.Second):
		t.Fatal("no job delivered")
		return delivery{}
	}
}

func TestWorkerReceivesEnqueuedJob(t *testing.T) {
	redisURL := startRedis(t)
	deliveries := make(chan delivery, 4)
	runWorker(t, redisURL, func(_ context.Context, job jobqueue.Job, lastAttempt bool) error {
		deliveries <- delivery{job, lastAttempt}
		return nil
	})
	want := jobqueue.Job{Kind: jobqueue.KindCapture, UserID: "user-1", BookmarkID: "bookmark-1", Generation: 7, StorageLimit: 1 << 20}
	if err := newQueue(t, redisURL).Enqueue(t.Context(), want); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	got := receive(t, deliveries)
	if got.job != want || got.lastAttempt {
		t.Fatalf("delivered %+v lastAttempt=%v, want %+v on a first attempt", got.job, got.lastAttempt, want)
	}
}

func TestEnqueueKeepsOneCopyPerKey(t *testing.T) {
	redisURL := startRedis(t)
	queue := newQueue(t, redisURL)
	job := jobqueue.Job{Kind: jobqueue.KindArchive, UserID: "user-1", BookmarkID: "bookmark-1", Generation: 3}
	for range 2 {
		if err := queue.Enqueue(t.Context(), job); err != nil {
			t.Fatalf("Enqueue: %v", err)
		}
	}
	job.Generation = 4
	if err := queue.Enqueue(t.Context(), job); err != nil {
		t.Fatalf("Enqueue newer generation: %v", err)
	}

	opt, err := asynq.ParseRedisURI(redisURL)
	if err != nil {
		t.Fatalf("parse redis URL: %v", err)
	}
	inspector := asynq.NewInspector(opt)
	defer inspector.Close()
	pending, err := inspector.ListPendingTasks(queueName)
	if err != nil {
		t.Fatalf("list pending: %v", err)
	}
	if len(pending) != 2 {
		t.Fatalf("pending tasks = %d, want 2 (one per generation)", len(pending))
	}
}

func TestFailedJobIsRetriedThreeTimes(t *testing.T) {
	redisURL := startRedis(t)
	deliveries := make(chan delivery, 8)
	runWorker(t, redisURL, func(_ context.Context, job jobqueue.Job, lastAttempt bool) error {
		deliveries <- delivery{job, lastAttempt}
		if lastAttempt {
			return nil
		}
		return errors.New("browser busy")
	})
	if err := newQueue(t, redisURL).Enqueue(t.Context(), jobqueue.Job{Kind: jobqueue.KindCapture, BookmarkID: "bookmark-1"}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	for attempt := range jobqueue.MaxRetries + 1 {
		got := receive(t, deliveries)
		if wantLast := attempt == jobqueue.MaxRetries; got.lastAttempt != wantLast {
			t.Fatalf("attempt %d lastAttempt = %v, want %v", attempt+1, got.lastAttempt, wantLast)
		}
	}
	select {
	case d := <-deliveries:
		t.Fatalf("unexpected fifth delivery %+v", d)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestNewRejectsBadURL(t *testing.T) {
	if _, err := New("http://not-redis"); err == nil {
		t.Fatal("New accepted a non-redis URL")
	}
	if _, err := NewWorker("http://not-redis", 1); err == nil {
		t.Fatal("NewWorker accepted a non-redis URL")
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
GOTOOLCHAIN=local go test -count=1 ./jobqueue/...
```

Expected: setup fails with `no required module provides package github.com/TabSlate-dev/TabSlate-server/jobqueue`.

- [ ] **Step 4: Write the interface**

Create `jobqueue/jobqueue.go`:

```go
// Package jobqueue defines the queue that carries web snapshot work from the
// API to the snapshot worker (cmd/fetcher). The open-source build uses
// jobqueue/redisqueue (Asynq on Redis). TabSlate Cloud passes its own
// implementation to app.WithSnapshotQueue and app.RunFetcher.
package jobqueue

import (
	"context"
	"fmt"
)

// MaxRetries is how many times a queue retries a job after its first
// attempt, when the handler asks for a retry.
const MaxRetries = 3

// Kind is the work a job asks for.
type Kind string

const (
	// KindCapture takes or updates a bookmark's snapshot.
	KindCapture Kind = "capture"
	// KindArchive saves a full-page archive of a bookmark.
	KindArchive Kind = "archive"
)

// Job is one unit of snapshot work, serialized as JSON.
type Job struct {
	Kind       Kind   `json:"kind"`
	UserID     string `json:"user_id"`
	BookmarkID string `json:"bookmark_id"`
	// Generation identifies the request. The worker discards a job whose
	// generation is no longer the snapshot's.
	Generation int64 `json:"generation"`
	// StorageLimit is the user's snapshot storage limit in bytes when the
	// job was queued; -1 means unlimited.
	StorageLimit int64 `json:"storage_limit"`
}

// Key identifies a job across deliveries. The API enqueues a job again when
// it has no result after 15 minutes; a queue should not add a second copy
// while one with the same key is still waiting.
func (j Job) Key() string {
	return fmt.Sprintf("%s:%s:%d", j.Kind, j.BookmarkID, j.Generation)
}

// Queue delivers jobs to the worker.
type Queue interface {
	Enqueue(ctx context.Context, job Job) error
}

// Handler runs one job. Returning an error asks the queue to retry it.
// lastAttempt is true when no retry will follow, so the handler records the
// failure itself.
type Handler func(ctx context.Context, job Job, lastAttempt bool) error

// Worker runs jobs until ctx is cancelled.
type Worker interface {
	Run(ctx context.Context, handle Handler) error
}
```

- [ ] **Step 5: Write the Asynq queue**

The task ID is `Job.Key()`, so the 15-minute re-enqueue cannot add a second copy of a job that is still waiting. A handler error asks Asynq to retry. `lastAttempt` is true once the retry count reaches `MaxRetries`.

Create `jobqueue/redisqueue/redisqueue.go`:

```go
// Package redisqueue implements jobqueue with Asynq on Redis, the queue for
// web snapshots on self-hosted servers.
package redisqueue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
	"github.com/hibiken/asynq"
)

const (
	taskType  = "snapshot"
	queueName = "snapshots"
	// taskTimeout bounds one delivery: a capture takes at most 30 s and a
	// full-page archive 60 s, plus the time to save the files.
	taskTimeout = 3 * time.Minute
)

var (
	_ jobqueue.Queue  = (*Queue)(nil)
	_ jobqueue.Worker = (*Worker)(nil)
)

// Queue enqueues jobs.
type Queue struct {
	client *asynq.Client
}

// New returns a Queue on redisURL (redis://...).
func New(redisURL string) (*Queue, error) {
	opt, err := asynq.ParseRedisURI(redisURL)
	if err != nil {
		return nil, fmt.Errorf("redisqueue: parse redis URL: %w", err)
	}
	return &Queue{client: asynq.NewClient(opt)}, nil
}

// Enqueue adds a job. A job whose key is still waiting is not added twice.
func (q *Queue) Enqueue(ctx context.Context, job jobqueue.Job) error {
	payload, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("redisqueue: encode job: %w", err)
	}
	_, err = q.client.EnqueueContext(ctx, asynq.NewTask(taskType, payload),
		asynq.Queue(queueName),
		asynq.MaxRetry(jobqueue.MaxRetries),
		asynq.Timeout(taskTimeout),
		asynq.TaskID(job.Key()),
	)
	if errors.Is(err, asynq.ErrTaskIDConflict) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("redisqueue: enqueue: %w", err)
	}
	return nil
}

// Close releases the Redis connection.
func (q *Queue) Close() error {
	return q.client.Close()
}

// Worker runs jobs from the queue.
type Worker struct {
	opt         asynq.RedisConnOpt
	concurrency int
	// retryDelay and pollInterval are shortened by tests.
	retryDelay   asynq.RetryDelayFunc
	pollInterval time.Duration
}

// NewWorker returns a Worker on redisURL that runs up to concurrency jobs at once.
func NewWorker(redisURL string, concurrency int) (*Worker, error) {
	opt, err := asynq.ParseRedisURI(redisURL)
	if err != nil {
		return nil, fmt.Errorf("redisqueue: parse redis URL: %w", err)
	}
	if concurrency < 1 {
		concurrency = 1
	}
	return &Worker{opt: opt, concurrency: concurrency}, nil
}

// Run processes jobs until ctx is cancelled, then waits for running jobs.
func (w *Worker) Run(ctx context.Context, handle jobqueue.Handler) error {
	srv := asynq.NewServer(w.opt, asynq.Config{
		Concurrency:              w.concurrency,
		Queues:                   map[string]int{queueName: 1},
		RetryDelayFunc:           w.retryDelay,
		DelayedTaskCheckInterval: w.pollInterval,
		ShutdownTimeout:          30 * time.Second,
		LogLevel:                 asynq.WarnLevel,
	})
	mux := asynq.NewServeMux()
	mux.HandleFunc(taskType, func(ctx context.Context, task *asynq.Task) error {
		var job jobqueue.Job
		if err := json.Unmarshal(task.Payload(), &job); err != nil {
			log.Printf("redisqueue: dropping malformed job: %v", err)
			return fmt.Errorf("decode job: %v: %w", err, asynq.SkipRetry)
		}
		retried, _ := asynq.GetRetryCount(ctx)
		maxRetry, _ := asynq.GetMaxRetry(ctx)
		return handle(ctx, job, retried >= maxRetry)
	})
	if err := srv.Start(mux); err != nil {
		return fmt.Errorf("redisqueue: start worker: %w", err)
	}
	<-ctx.Done()
	srv.Shutdown()
	return nil
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
GOTOOLCHAIN=local go mod tidy
git diff go.mod
GOTOOLCHAIN=local go test -race -count=1 ./jobqueue/... -v
```

Expected:
- `go.mod` now lists `github.com/hibiken/asynq v0.26.0` as a direct requirement, and `go 1.25.0` is unchanged.
- `TestWorkerReceivesEnqueuedJob`, `TestEnqueueKeepsOneCopyPerKey`, `TestFailedJobIsRetriedThreeTimes`, and `TestNewRejectsBadURL` pass. The retry test sees four deliveries, and only the last has `lastAttempt` set. The suite takes a few seconds.

- [ ] **Step 7: Commit**

```bash
git add go.mod go.sum jobqueue/jobqueue.go jobqueue/redisqueue/redisqueue.go jobqueue/redisqueue/redisqueue_test.go
git commit -m "feat(snapshots): add the job queue and its Asynq implementation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- go.mod go.sum jobqueue/jobqueue.go \
  jobqueue/redisqueue/redisqueue.go jobqueue/redisqueue/redisqueue_test.go
```

---

### Task 3: Local storage

**Files:**
- Create: `internal/blobstore/blobstore.go`, `internal/blobstore/local.go`, `internal/blobstore/store_test.go`, `internal/blobstore/local_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `blobstore.Store`:
    - `Put(ctx, key string, data []byte) error`;
    - `Open(ctx, key string, size int64) (io.ReadSeekCloser, error)`;
    - `Delete(ctx, key string) error`, which treats a missing key as success;
    - `List(ctx, prefix string, fn func(Object) error) error`.
  - `blobstore.Object{Key string; Size int64; ModTime time.Time}` and `blobstore.ErrNotFound`.
  - `blobstore.NewLocal(dir string) (*Local, error)`.
  - `testStore(t, store)`, the contract test that Task 4 also runs.

- [ ] **Step 1: Write the failing tests**

Create `internal/blobstore/store_test.go`:

```go
package blobstore

import (
	"bytes"
	"errors"
	"io"
	"slices"
	"testing"
)

// testStore checks the Store contract; the local and S3 tests both run it.
func testStore(t *testing.T, store Store) {
	t.Helper()
	ctx := t.Context()
	keyA := "snapshots/user-1/aaaa"
	keyB := "snapshots/user-2/bbbb"
	data := []byte("0123456789abcdef")

	if err := store.Put(ctx, keyA, data); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := store.Put(ctx, keyB, []byte("second")); err != nil {
		t.Fatalf("Put second: %v", err)
	}
	if err := store.Put(ctx, "other/cccc", []byte("not a snapshot")); err != nil {
		t.Fatalf("Put outside the prefix: %v", err)
	}

	reader, err := store.Open(ctx, keyA, int64(len(data)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := reader.Seek(10, io.SeekStart); err != nil {
		t.Fatalf("Seek: %v", err)
	}
	tail, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read after seek: %v", err)
	}
	if end, err := reader.Seek(0, io.SeekEnd); err != nil || end != int64(len(data)) {
		t.Fatalf("Seek to end = %d, %v; want %d", end, err, len(data))
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		t.Fatalf("Seek to start: %v", err)
	}
	all, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read all: %v", err)
	}
	_ = reader.Close()
	if string(tail) != "abcdef" || !bytes.Equal(all, data) {
		t.Fatalf("read %q after seeking to 10 and %q from the start, want %q and %q", tail, all, "abcdef", data)
	}

	var keys []string
	if err := store.List(ctx, "snapshots/", func(object Object) error {
		keys = append(keys, object.Key)
		if object.Key == keyA && object.Size != int64(len(data)) {
			t.Errorf("listed size of %s = %d, want %d", keyA, object.Size, len(data))
		}
		if object.ModTime.IsZero() {
			t.Errorf("listed %s without a modification time", object.Key)
		}
		return nil
	}); err != nil {
		t.Fatalf("List: %v", err)
	}
	slices.Sort(keys)
	if !slices.Equal(keys, []string{keyA, keyB}) {
		t.Fatalf("listed %v, want %v", keys, []string{keyA, keyB})
	}

	if err := store.Delete(ctx, keyA); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := store.Delete(ctx, keyA); err != nil {
		t.Fatalf("Delete of a missing file: %v", err)
	}
	if _, err := store.Open(ctx, keyA, int64(len(data))); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Open after Delete = %v, want ErrNotFound", err)
	}
}
```

Create `internal/blobstore/local_test.go`:

```go
package blobstore

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalStore(t *testing.T) {
	store, err := NewLocal(filepath.Join(t.TempDir(), "files"))
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	testStore(t, store)
}

func TestLocalRejectsKeysOutsideItsDirectory(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLocal(filepath.Join(dir, "files"))
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	for _, key := range []string{"../escape", "/etc/passwd", "snapshots/../../escape", "", `snapshots\..\escape`} {
		if err := store.Put(t.Context(), key, []byte("x")); err == nil {
			t.Errorf("Put(%q) succeeded", key)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "escape")); !os.IsNotExist(err) {
		t.Fatalf("a file was written outside the store: %v", err)
	}
}

func TestLocalPutReplacesFile(t *testing.T) {
	store, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	for _, content := range []string{"first", "second"} {
		if err := store.Put(t.Context(), "snapshots/u/a", []byte(content)); err != nil {
			t.Fatalf("Put %s: %v", content, err)
		}
	}
	reader, err := store.Open(t.Context(), "snapshots/u/a", 6)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reader.Close()
	buf := make([]byte, 16)
	n, _ := reader.Read(buf)
	if string(buf[:n]) != "second" {
		t.Fatalf("read %q, want %q", buf[:n], "second")
	}
}

func TestNewLocalNeedsDirectory(t *testing.T) {
	if _, err := NewLocal(""); err == nil {
		t.Fatal("NewLocal accepted an empty directory")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
GOTOOLCHAIN=local go test -count=1 ./internal/blobstore/
```

Expected: the build fails with `undefined: Store`, `undefined: Object`, and `undefined: ErrNotFound`.

- [ ] **Step 3: Write the interface**

Create `internal/blobstore/blobstore.go`:

```go
// Package blobstore keeps web snapshot files in a local directory or in
// S3-compatible storage. Keys are slash-separated paths such as
// snapshots/<userId>/<assetId>.
package blobstore

import (
	"context"
	"errors"
	"io"
	"time"
)

// ErrNotFound reports a key with no file.
var ErrNotFound = errors.New("blobstore: not found")

// Object describes a stored file.
type Object struct {
	Key     string
	Size    int64
	ModTime time.Time
}

// Store holds files. Implementations are safe for concurrent use.
type Store interface {
	// Put writes data at key, replacing any file there.
	Put(ctx context.Context, key string, data []byte) error
	// Open returns the file at key, which the caller knows to be size bytes
	// long. The reader seeks, so it can answer range requests.
	Open(ctx context.Context, key string, size int64) (io.ReadSeekCloser, error)
	// Delete removes the file at key. A missing file is not an error.
	Delete(ctx context.Context, key string) error
	// List calls fn for every file whose key starts with prefix.
	List(ctx context.Context, prefix string, fn func(Object) error) error
}
```

- [ ] **Step 4: Write the local store**

`Put` writes a temporary file and renames it, so readers never see a partial file. `List` also reports temporary files that an interrupted `Put` left behind, so the garbage collection in Task 9 removes them.

Create `internal/blobstore/local.go`:

```go
package blobstore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

var _ Store = (*Local)(nil)

// Local keeps files under a directory.
type Local struct {
	dir string
}

// NewLocal returns a Local store rooted at dir, creating dir if needed.
func NewLocal(dir string) (*Local, error) {
	if dir == "" {
		return nil, errors.New("blobstore: local directory is not set")
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("blobstore: create %s: %w", dir, err)
	}
	return &Local{dir: dir}, nil
}

func (l *Local) path(key string) (string, error) {
	if !fs.ValidPath(key) || key == "." || strings.Contains(key, `\`) {
		return "", fmt.Errorf("blobstore: invalid key %q", key)
	}
	return filepath.Join(l.dir, filepath.FromSlash(key)), nil
}

// Put writes to a temporary file and renames it, so readers never see a partial file.
func (l *Local) Put(_ context.Context, key string, data []byte) error {
	path, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("blobstore: create directory for %s: %w", key, err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return fmt.Errorf("blobstore: create %s: %w", key, err)
	}
	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("blobstore: write %s: %w", key, err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("blobstore: write %s: %w", key, err)
	}
	return nil
}

func (l *Local) Open(_ context.Context, key string, _ int64) (io.ReadSeekCloser, error) {
	path, err := l.path(key)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("blobstore: open %s: %w", key, err)
	}
	return file, nil
}

func (l *Local) Delete(_ context.Context, key string) error {
	path, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("blobstore: delete %s: %w", key, err)
	}
	return nil
}

// List also reports temporary files left by an interrupted Put, so the
// cleanup job can remove them.
func (l *Local) List(ctx context.Context, prefix string, fn func(Object) error) error {
	return filepath.WalkDir(l.dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(l.dir, path)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if !strings.HasPrefix(key, prefix) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		return fn(Object{Key: key, Size: info.Size(), ModTime: info.ModTime()})
	})
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
GOTOOLCHAIN=local go test -race -count=1 ./internal/blobstore/ -v
```

Expected: `TestLocalStore`, `TestLocalRejectsKeysOutsideItsDirectory`, `TestLocalPutReplacesFile`, and `TestNewLocalNeedsDirectory` pass.

- [ ] **Step 6: Commit**

```bash
git add internal/blobstore/blobstore.go internal/blobstore/local.go internal/blobstore/store_test.go internal/blobstore/local_test.go
git commit -m "feat(snapshots): add the storage interface and local storage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- internal/blobstore/blobstore.go \
  internal/blobstore/local.go internal/blobstore/store_test.go internal/blobstore/local_test.go
```

---

### Task 4: S3 storage

**Files:**
- Create: `internal/blobstore/s3.go`, `internal/blobstore/s3_test.go`, `internal/blobstore/open_test.go`
- Modify: `internal/blobstore/blobstore.go`

**Interfaces:**
- Consumes: `Store`, `Object`, `ErrNotFound`, `NewLocal`, and `testStore` from Task 3.
- Produces:
  - `blobstore.S3Config{Endpoint, Region, Bucket, AccessKeyID, SecretAccessKey string; PathStyle bool}` and `blobstore.NewS3(cfg) (*S3, error)`.
  - `blobstore.Config{Kind, LocalDir string; S3 S3Config}` and `blobstore.Open(cfg) (Store, error)`. `Open` returns a nil store for an empty `Kind`, and an error for an unknown kind or incomplete settings.

- [ ] **Step 1: Write the failing tests**

The signing tests use the S3 examples in the AWS documentation ("Signature Calculations for the Authorization Header: Transferring Payload in a Single Chunk"): the `GET` of `test.txt` with a range, and the bucket listing. Matching their published signatures checks the canonical request, the string to sign, and the key derivation. `fakeS3` is an in-memory, path-style S3 endpoint. It rejects unsigned requests and uploads whose `X-Amz-Content-Sha256` does not match, and it lists two keys per page.

Create `internal/blobstore/s3_test.go`:

```go
package blobstore

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// awsExampleStore is the account in the S3 signing examples of the AWS
// documentation ("Signature Calculations for the Authorization Header").
func awsExampleStore(t *testing.T) *S3 {
	t.Helper()
	store, err := NewS3(S3Config{
		Endpoint:        "https://s3.amazonaws.com",
		Region:          "us-east-1",
		Bucket:          "examplebucket",
		AccessKeyID:     "AKIAIOSFODNN7EXAMPLE",
		SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	store.now = func() time.Time { return time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC) }
	return store
}

func signedAuthorization(t *testing.T, store *S3, req *http.Request) (signedHeaders, signature string) {
	t.Helper()
	signV4(req, store.cfg.AccessKeyID, store.cfg.SecretAccessKey, store.cfg.Region, store.now())
	auth := req.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ") {
		t.Fatalf("Authorization = %q", auth)
	}
	for _, part := range strings.Split(auth, ", ") {
		if value, ok := strings.CutPrefix(part, "SignedHeaders="); ok {
			signedHeaders = value
		}
		if value, ok := strings.CutPrefix(part, "Signature="); ok {
			signature = value
		}
	}
	return signedHeaders, signature
}

func TestSignV4MatchesAWSGetObjectExample(t *testing.T) {
	store := awsExampleStore(t)
	req, err := store.newRequest(t.Context(), http.MethodGet, "test.txt", nil, nil, emptyPayloadHash)
	if err != nil {
		t.Fatalf("newRequest: %v", err)
	}
	req.Header.Set("Range", "bytes=0-9")
	if req.URL.String() != "https://examplebucket.s3.amazonaws.com/test.txt" {
		t.Fatalf("URL = %s", req.URL)
	}
	signedHeaders, signature := signedAuthorization(t, store, req)
	if signedHeaders != "host;range;x-amz-content-sha256;x-amz-date" ||
		signature != "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41" {
		t.Fatalf("signed %s with %s", signedHeaders, signature)
	}
}

func TestSignV4MatchesAWSListObjectsExample(t *testing.T) {
	store := awsExampleStore(t)
	req, err := store.newRequest(t.Context(), http.MethodGet, "", url.Values{"max-keys": {"2"}, "prefix": {"J"}}, nil, emptyPayloadHash)
	if err != nil {
		t.Fatalf("newRequest: %v", err)
	}
	if req.URL.String() != "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J" {
		t.Fatalf("URL = %s", req.URL)
	}
	signedHeaders, signature := signedAuthorization(t, store, req)
	if signedHeaders != "host;x-amz-content-sha256;x-amz-date" ||
		signature != "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7" {
		t.Fatalf("signed %s with %s", signedHeaders, signature)
	}
}

func TestObjectURLEscapesKeys(t *testing.T) {
	store, err := NewS3(S3Config{Endpoint: "http://minio:9000", Region: "auto", Bucket: "snaps", AccessKeyID: "a", SecretAccessKey: "b", PathStyle: true})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	got := store.objectURL("snapshots/a b/c+d", url.Values{"prefix": {"snapshots/"}}).String()
	if got != "http://minio:9000/snaps/snapshots/a%20b/c%2Bd?prefix=snapshots%2F" {
		t.Fatalf("objectURL = %s", got)
	}
}

func TestNewS3ChecksConfig(t *testing.T) {
	valid := S3Config{Endpoint: "https://s3.example.com", Region: "us-east-1", Bucket: "b", AccessKeyID: "a", SecretAccessKey: "s"}
	for name, mutate := range map[string]func(*S3Config){
		"endpoint scheme": func(c *S3Config) { c.Endpoint = "ftp://s3.example.com" },
		"endpoint host":   func(c *S3Config) { c.Endpoint = "https://" },
		"region":          func(c *S3Config) { c.Region = "" },
		"bucket":          func(c *S3Config) { c.Bucket = "" },
		"access key":      func(c *S3Config) { c.AccessKeyID = "" },
		"secret key":      func(c *S3Config) { c.SecretAccessKey = "" },
	} {
		cfg := valid
		mutate(&cfg)
		if _, err := NewS3(cfg); err == nil {
			t.Errorf("NewS3 accepted a config with a bad %s", name)
		}
	}
	if _, err := NewS3(valid); err != nil {
		t.Fatalf("NewS3(valid): %v", err)
	}
}

// fakeS3 is an in-memory, path-style S3 endpoint for one bucket. It checks
// that requests are signed and that uploads match their payload hash, and
// lists two keys per page so pagination is exercised.
type fakeS3 struct {
	t       *testing.T
	mu      sync.Mutex
	objects map[string][]byte
	ranges  []string
}

func newFakeS3(t *testing.T) (*fakeS3, *httptest.Server) {
	fake := &fakeS3{t: t, objects: map[string][]byte{}}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	return fake, server
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=test-key/") {
		http.Error(w, "<Error><Code>AccessDenied</Code></Error>", http.StatusForbidden)
		return
	}
	key, ok := strings.CutPrefix(r.URL.Path, "/bucket/")
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/bucket":
		f.list(w, r.URL.Query())
	case !ok:
		http.Error(w, "<Error><Code>NoSuchBucket</Code></Error>", http.StatusNotFound)
	case r.Method == http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		sum := sha256.Sum256(body)
		if r.Header.Get("X-Amz-Content-Sha256") != hex.EncodeToString(sum[:]) {
			http.Error(w, "<Error><Code>XAmzContentSHA256Mismatch</Code></Error>", http.StatusBadRequest)
			return
		}
		f.objects[key] = body
	case r.Method == http.MethodGet:
		data, exists := f.objects[key]
		if !exists {
			http.Error(w, "<Error><Code>NoSuchKey</Code></Error>", http.StatusNotFound)
			return
		}
		rangeHeader := r.Header.Get("Range")
		f.ranges = append(f.ranges, rangeHeader)
		if start, ok := strings.CutPrefix(rangeHeader, "bytes="); ok {
			offset, _ := strconv.Atoi(strings.TrimSuffix(start, "-"))
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, len(data)-1, len(data)))
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write(data[offset:])
			return
		}
		_, _ = w.Write(data)
	case r.Method == http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "unexpected request", http.StatusMethodNotAllowed)
	}
}

func (f *fakeS3) list(w http.ResponseWriter, query url.Values) {
	if query.Get("list-type") != "2" {
		http.Error(w, "want ListObjectsV2", http.StatusBadRequest)
		return
	}
	var keys []string
	for key := range f.objects {
		if strings.HasPrefix(key, query.Get("prefix")) {
			keys = append(keys, key)
		}
	}
	slices.Sort(keys)
	start, _ := strconv.Atoi(query.Get("continuation-token"))
	end := min(start+2, len(keys))
	var body strings.Builder
	body.WriteString(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`)
	for _, key := range keys[start:end] {
		fmt.Fprintf(&body, "<Contents><Key>%s</Key><LastModified>2026-10-23T08:00:00.000Z</LastModified><Size>%d</Size></Contents>", key, len(f.objects[key]))
	}
	if end < len(keys) {
		fmt.Fprintf(&body, "<IsTruncated>true</IsTruncated><NextContinuationToken>%d</NextContinuationToken>", end)
	} else {
		body.WriteString("<IsTruncated>false</IsTruncated>")
	}
	body.WriteString("</ListBucketResult>")
	w.Header().Set("Content-Type", "application/xml")
	_, _ = io.WriteString(w, body.String())
}

func newFakeS3Store(t *testing.T, endpoint string) *S3 {
	t.Helper()
	store, err := NewS3(S3Config{Endpoint: endpoint, Region: "us-east-1", Bucket: "bucket", AccessKeyID: "test-key", SecretAccessKey: "test-secret", PathStyle: true})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	return store
}

func TestS3Store(t *testing.T) {
	_, server := newFakeS3(t)
	testStore(t, newFakeS3Store(t, server.URL))
}

func TestS3ListFollowsContinuationTokens(t *testing.T) {
	_, server := newFakeS3(t)
	store := newFakeS3Store(t, server.URL)
	for i := range 5 {
		if err := store.Put(t.Context(), fmt.Sprintf("snapshots/u/%d", i), []byte("x")); err != nil {
			t.Fatalf("Put: %v", err)
		}
	}
	count := 0
	if err := store.List(t.Context(), "snapshots/", func(Object) error { count++; return nil }); err != nil {
		t.Fatalf("List: %v", err)
	}
	if count != 5 {
		t.Fatalf("listed %d objects, want 5", count)
	}
}

func TestS3OpenRequestsRangeAfterSeek(t *testing.T) {
	fake, server := newFakeS3(t)
	store := newFakeS3Store(t, server.URL)
	if err := store.Put(t.Context(), "snapshots/u/a", []byte("0123456789")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	reader, err := store.Open(t.Context(), "snapshots/u/a", 10)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reader.Close()
	if _, err := reader.Seek(4, io.SeekStart); err != nil {
		t.Fatalf("Seek: %v", err)
	}
	rest, err := io.ReadAll(reader)
	if err != nil || string(rest) != "456789" {
		t.Fatalf("read %q, %v; want %q", rest, err, "456789")
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if !slices.Equal(fake.ranges, []string{"", "bytes=4-"}) {
		t.Fatalf("GET ranges = %q, want the whole file and then bytes=4-", fake.ranges)
	}
}

func TestS3ReportsSigningFailures(t *testing.T) {
	_, server := newFakeS3(t)
	store, err := NewS3(S3Config{Endpoint: server.URL, Region: "us-east-1", Bucket: "bucket", AccessKeyID: "wrong-key", SecretAccessKey: "s", PathStyle: true})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	err = store.Put(t.Context(), "snapshots/u/a", []byte("x"))
	if err == nil || !strings.Contains(err.Error(), "AccessDenied") {
		t.Fatalf("Put with a rejected key = %v, want an AccessDenied error", err)
	}
}
```

Create `internal/blobstore/open_test.go`:

```go
package blobstore

import (
	"path/filepath"
	"testing"
)

func TestOpen(t *testing.T) {
	if store, err := Open(Config{}); store != nil || err != nil {
		t.Fatalf("Open without a kind = %v, %v; want no store", store, err)
	}
	if store, err := Open(Config{Kind: "local", LocalDir: filepath.Join(t.TempDir(), "files")}); err != nil {
		t.Fatalf("Open local: %v", err)
	} else if _, ok := store.(*Local); !ok {
		t.Fatalf("Open local returned %T", store)
	}
	s3 := S3Config{Endpoint: "http://minio:9000", Region: "us-east-1", Bucket: "b", AccessKeyID: "a", SecretAccessKey: "s", PathStyle: true}
	if store, err := Open(Config{Kind: "s3", S3: s3}); err != nil {
		t.Fatalf("Open s3: %v", err)
	} else if _, ok := store.(*S3); !ok {
		t.Fatalf("Open s3 returned %T", store)
	}
	for _, cfg := range []Config{{Kind: "local"}, {Kind: "s3"}, {Kind: "gcs"}} {
		if store, err := Open(cfg); err == nil || store != nil {
			t.Errorf("Open(%+v) = %v, %v; want an error and no store", cfg, store, err)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
GOTOOLCHAIN=local go test -count=1 ./internal/blobstore/
```

Expected: the build fails with `undefined: S3`.

- [ ] **Step 3: Write the S3 store**

Notes on the implementation:
- Requests are signed with AWS Signature Version 4, following the server's SES mailer.
- Uploads sign the payload's SHA-256.
- Listing uses `ListObjectsV2` and follows continuation tokens.
- `Open` fetches the start of the file at once, so a missing file fails before the response starts. After a seek, the reader asks for `bytes=<offset>-`, which lets `http.ServeContent` answer Range requests.

Create `internal/blobstore/s3.go`:

```go
package blobstore

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

var _ Store = (*S3)(nil)

// emptyPayloadHash is the SHA-256 of an empty body.
const emptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// S3Config describes an S3 or S3-compatible bucket.
type S3Config struct {
	// Endpoint is the service URL, such as https://s3.us-east-1.amazonaws.com
	// or http://minio:9000.
	Endpoint        string
	Region          string
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
	// PathStyle puts the bucket in the path (endpoint/bucket/key) instead of
	// the host name (bucket.endpoint/key). MinIO and many compatible stores need it.
	PathStyle bool
}

// S3 keeps files in a bucket. Requests are signed with AWS Signature Version 4.
type S3 struct {
	cfg      S3Config
	endpoint *url.URL
	client   *http.Client
	now      func() time.Time
}

// NewS3 checks cfg and returns an S3 store.
func NewS3(cfg S3Config) (*S3, error) {
	endpoint, err := url.Parse(cfg.Endpoint)
	if err != nil || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Host == "" {
		return nil, fmt.Errorf("blobstore: invalid S3 endpoint %q", cfg.Endpoint)
	}
	if cfg.Region == "" || cfg.Bucket == "" || cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return nil, errors.New("blobstore: S3 region, bucket, and keys are required")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	return &S3{cfg: cfg, endpoint: endpoint, client: &http.Client{Transport: transport}, now: time.Now}, nil
}

func (s *S3) Put(ctx context.Context, key string, data []byte) error {
	sum := sha256.Sum256(data)
	req, err := s.newRequest(ctx, http.MethodPut, key, nil, bytes.NewReader(data), hex.EncodeToString(sum[:]))
	if err != nil {
		return err
	}
	req.ContentLength = int64(len(data))
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := s.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return responseError(resp, "put "+key)
	}
	return nil
}

// Open fetches the start of the file, so a missing file fails here rather than mid-response.
func (s *S3) Open(ctx context.Context, key string, size int64) (io.ReadSeekCloser, error) {
	reader := &s3Reader{ctx: ctx, store: s, key: key, size: size}
	if err := reader.fetch(); err != nil {
		return nil, err
	}
	return reader, nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	req, err := s.newRequest(ctx, http.MethodDelete, key, nil, nil, emptyPayloadHash)
	if err != nil {
		return err
	}
	resp, err := s.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		return responseError(resp, "delete "+key)
	}
	return nil
}

type listBucketResult struct {
	Contents []struct {
		Key          string `xml:"Key"`
		Size         int64  `xml:"Size"`
		LastModified string `xml:"LastModified"`
	} `xml:"Contents"`
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
}

func (s *S3) List(ctx context.Context, prefix string, fn func(Object) error) error {
	token := ""
	for {
		query := url.Values{"list-type": {"2"}, "prefix": {prefix}}
		if token != "" {
			query.Set("continuation-token", token)
		}
		req, err := s.newRequest(ctx, http.MethodGet, "", query, nil, emptyPayloadHash)
		if err != nil {
			return err
		}
		resp, err := s.do(req)
		if err != nil {
			return err
		}
		if resp.StatusCode != http.StatusOK {
			err := responseError(resp, "list "+prefix)
			resp.Body.Close()
			return err
		}
		var page listBucketResult
		err = xml.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&page)
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("blobstore: decode S3 listing: %w", err)
		}
		for _, item := range page.Contents {
			modTime, err := time.Parse(time.RFC3339, item.LastModified)
			if err != nil {
				return fmt.Errorf("blobstore: S3 listing time %q: %w", item.LastModified, err)
			}
			if err := fn(Object{Key: item.Key, Size: item.Size, ModTime: modTime}); err != nil {
				return err
			}
		}
		if !page.IsTruncated || page.NextContinuationToken == "" {
			return nil
		}
		token = page.NextContinuationToken
	}
}

// objectURL is the URL of key, or of the bucket when key is empty.
func (s *S3) objectURL(key string, query url.Values) *url.URL {
	u := *s.endpoint
	path := "/" + key
	if s.cfg.PathStyle {
		path = "/" + s.cfg.Bucket + path
		if key == "" {
			path = "/" + s.cfg.Bucket
		}
	} else {
		u.Host = s.cfg.Bucket + "." + u.Host
	}
	u.Path = path
	u.RawPath = escapePath(path)
	u.RawQuery = canonicalQuery(query)
	return &u
}

func (s *S3) newRequest(ctx context.Context, method, key string, query url.Values, body io.Reader, payloadHash string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, s.objectURL(key, query).String(), body)
	if err != nil {
		return nil, fmt.Errorf("blobstore: build S3 request: %w", err)
	}
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	return req, nil
}

func (s *S3) do(req *http.Request) (*http.Response, error) {
	signV4(req, s.cfg.AccessKeyID, s.cfg.SecretAccessKey, s.cfg.Region, s.now())
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("blobstore: S3 %s: %w", req.Method, err)
	}
	return resp, nil
}

// signV4 signs req for S3. It signs the host, any Range header, and every
// x-amz-* header; x-amz-content-sha256 must already be set.
func signV4(req *http.Request, accessKeyID, secretAccessKey, region string, now time.Time) {
	amzDate := now.UTC().Format("20060102T150405Z")
	date := amzDate[:8]
	req.Header.Set("X-Amz-Date", amzDate)

	headers := map[string]string{"host": req.URL.Host}
	for name, values := range req.Header {
		lower := strings.ToLower(name)
		if lower == "range" || strings.HasPrefix(lower, "x-amz-") {
			headers[lower] = strings.TrimSpace(strings.Join(values, ","))
		}
	}
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	slices.Sort(names)
	var canonicalHeaders strings.Builder
	for _, name := range names {
		canonicalHeaders.WriteString(name + ":" + headers[name] + "\n")
	}
	signedHeaders := strings.Join(names, ";")

	canonicalRequest := strings.Join([]string{
		req.Method,
		req.URL.EscapedPath(),
		req.URL.RawQuery,
		canonicalHeaders.String(),
		signedHeaders,
		req.Header.Get("X-Amz-Content-Sha256"),
	}, "\n")
	scope := date + "/" + region + "/s3/aws4_request"
	requestHash := sha256.Sum256([]byte(canonicalRequest))
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(requestHash[:])

	key := hmacSHA256([]byte("AWS4"+secretAccessKey), date)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, stringToSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+accessKeyID+"/"+scope+
		", SignedHeaders="+signedHeaders+", Signature="+signature)
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

// awsEscape percent-encodes everything but unreserved characters, as SigV4 requires.
func awsEscape(value string) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

func escapePath(path string) string {
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		segments[i] = awsEscape(segment)
	}
	return strings.Join(segments, "/")
}

// canonicalQuery encodes query sorted by name and then value, as SigV4 requires.
func canonicalQuery(query url.Values) string {
	names := make([]string, 0, len(query))
	for name := range query {
		names = append(names, name)
	}
	slices.Sort(names)
	var pairs []string
	for _, name := range names {
		values := slices.Clone(query[name])
		slices.Sort(values)
		for _, value := range values {
			pairs = append(pairs, awsEscape(name)+"="+awsEscape(value))
		}
	}
	return strings.Join(pairs, "&")
}

func responseError(resp *http.Response, operation string) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	var s3Err struct {
		Code string `xml:"Code"`
	}
	_ = xml.Unmarshal(body, &s3Err)
	if resp.StatusCode == http.StatusNotFound && s3Err.Code != "NoSuchBucket" {
		return ErrNotFound
	}
	return fmt.Errorf("blobstore: S3 %s: %s %s", operation, resp.Status, s3Err.Code)
}

// s3Reader reads an object with ranged GET requests from the current offset.
type s3Reader struct {
	ctx    context.Context
	store  *S3
	key    string
	size   int64
	offset int64
	body   io.ReadCloser
}

func (r *s3Reader) fetch() error {
	req, err := r.store.newRequest(r.ctx, http.MethodGet, r.key, nil, nil, emptyPayloadHash)
	if err != nil {
		return err
	}
	if r.offset > 0 {
		req.Header.Set("Range", "bytes="+strconv.FormatInt(r.offset, 10)+"-")
	}
	resp, err := r.store.do(req)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		err := responseError(resp, "get "+r.key)
		resp.Body.Close()
		return err
	}
	if r.offset > 0 && resp.StatusCode == http.StatusOK {
		resp.Body.Close()
		return fmt.Errorf("blobstore: S3 get %s ignored the range request", r.key)
	}
	r.body = resp.Body
	return nil
}

func (r *s3Reader) Read(p []byte) (int, error) {
	if r.offset >= r.size {
		return 0, io.EOF
	}
	if r.body == nil {
		if err := r.fetch(); err != nil {
			return 0, err
		}
	}
	n, err := r.body.Read(p)
	r.offset += int64(n)
	if err == io.EOF && r.offset < r.size {
		err = io.ErrUnexpectedEOF
	}
	return n, err
}

func (r *s3Reader) Seek(offset int64, whence int) (int64, error) {
	var target int64
	switch whence {
	case io.SeekStart:
		target = offset
	case io.SeekCurrent:
		target = r.offset + offset
	case io.SeekEnd:
		target = r.size + offset
	default:
		return 0, errors.New("blobstore: invalid seek whence")
	}
	if target < 0 {
		return 0, errors.New("blobstore: negative seek position")
	}
	if target != r.offset && r.body != nil {
		r.body.Close()
		r.body = nil
	}
	r.offset = target
	return target, nil
}

func (r *s3Reader) Close() error {
	if r.body == nil {
		return nil
	}
	err := r.body.Close()
	r.body = nil
	return err
}
```

- [ ] **Step 4: Add `Config` and `Open`**

In `internal/blobstore/blobstore.go`:

Replace:

```go
import (
	"context"
	"errors"
	"io"
	"time"
)
```

with:

```go
import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"
)
```

Append to the end of `internal/blobstore/blobstore.go`:

```go
// Config selects a store: Kind "local" keeps files under LocalDir, "s3" in
// the S3 bucket, and "" means no store.
type Config struct {
	Kind     string
	LocalDir string
	S3       S3Config
}

// Open returns the store cfg describes, or nil when Kind is empty.
func Open(cfg Config) (Store, error) {
	switch cfg.Kind {
	case "":
		return nil, nil
	case "local":
		store, err := NewLocal(cfg.LocalDir)
		if err != nil {
			return nil, err
		}
		return store, nil
	case "s3":
		store, err := NewS3(cfg.S3)
		if err != nil {
			return nil, err
		}
		return store, nil
	default:
		return nil, fmt.Errorf("blobstore: unknown storage %q (want local or s3)", cfg.Kind)
	}
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
GOTOOLCHAIN=local go test -race -count=1 ./internal/blobstore/ -v
```

Expected:
- `TestSignV4MatchesAWSGetObjectExample` and `TestSignV4MatchesAWSListObjectsExample` pass. Their signatures are `f0e8bdb8…` and `34b48302…`.
- `TestObjectURLEscapesKeys`, `TestNewS3ChecksConfig`, `TestS3Store`, `TestS3ListFollowsContinuationTokens`, `TestS3OpenRequestsRangeAfterSeek`, `TestS3ReportsSigningFailures`, and `TestOpen` pass, along with the local tests.

- [ ] **Step 6: Commit**

```bash
git add internal/blobstore/blobstore.go internal/blobstore/s3.go internal/blobstore/s3_test.go internal/blobstore/open_test.go
git commit -m "feat(snapshots): add S3 storage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- internal/blobstore/blobstore.go \
  internal/blobstore/s3.go internal/blobstore/s3_test.go internal/blobstore/open_test.go
```

---

### Task 5: Snapshot service core, sync rows, and signed URLs

**Files:**
- Modify: `internal/model/model.go`
- Create: `internal/snapshots/snapshots.go`, `change.go`, `urls.go`, `service.go`, `rows.go`, `keycheck.go`
- Test: `internal/snapshots/helpers_test.go`, `urls_test.go`, `rows_test.go`

**Interfaces:**
- Consumes: Task 1's tables, `jobqueue.Queue` and `jobqueue.Job` (Task 2), `blobstore.Store` (Task 3), `pubsub.Hub`, and `billing.Limits`.
- Produces:
  - Constants:
    - statuses `StatusQueued`, `StatusReady`, `StatusFailed`, `StatusUnsupported`, `StatusDeleted`;
    - asset types `AssetReader`, `AssetScreenshot`, `AssetCover`, `AssetFile`, `AssetArchive`;
    - `ReasonStorageFull`.
  - Interfaces: `LimitsProvider` (implemented by `billing.Provider`) and `TextIndex` (`UpsertSnapshotText(bookmarkID, userID, text)` and `DeleteSnapshotTexts([]string)`; `*search.Client` implements it in Task 10).
  - `AssetKey(userID, assetID) string`.
  - Package-internal helpers that later tasks use: `lockUser`, `storageUsage`, `storageLimit`, `hasRoom`, `nextSeq`, `deleteSnapshots`, `change`/`bumpSeq`, `effects.finish`, `querier`, `ignoreNoRows`, `millis`.
  - `NewSigner(current, previous string) (*Signer, error)`, with `URL(assetID)`, `Valid(assetID, sig)`, and `Fingerprint()`.
  - `snapshots.Config{DB, Store, Queue, Signer, Hub, Limits, Text, MaxAttemptsPerDay}` and `NewService(cfg) *Service`, whose methods are `Auto`, `SetAuto`, `NoteSync`, `Rows(ctx, userID, afterSeq) ([]model.Snapshot, error)`, and `CheckURLKey(ctx) error`.
  - `model.Snapshot`, the sync row.
  - Test helpers for later tasks: `newEnv(t, storageMB)`, `fakeQueue.take`, `fakeText`, and the `env` methods `addUser`, `addCollection`, `addBookmark`, `addReadySnapshot`, `snapshot`, `count`, `fileExists`, `subscribe`, and `exec`. Also `expectBroadcast`, `jobBookmarks`, and `seqIDs`.

- [ ] **Step 1: Write the test helpers and failing tests**

`newEnv` builds a real `Service` on the test database, with local storage in a temporary directory, a fake queue, a fake text index, and an in-memory hub. It adds one user with an active workspace and collection.

Create `internal/snapshots/helpers_test.go`:

```go
package snapshots

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/billing"
	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
	"github.com/google/uuid"
)

// openTestDB connects to TEST_DATABASE_URL and empties the tables these
// tests use. Run DB-backed packages with go test -p 1: the handler tests
// truncate the same tables.
func openTestDB(t *testing.T) *db.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	database, err := db.Open(dsn)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(database.Close)
	if err := db.Migrate(database); err != nil {
		t.Fatalf("migrate test db: %v", err)
	}
	if _, err := database.Exec(t.Context(),
		`TRUNCATE TABLE bookmarks, collections, workspaces, user_sync_seq, users RESTART IDENTITY CASCADE`); err != nil {
		t.Fatalf("truncate test db: %v", err)
	}
	if _, err := database.Exec(t.Context(), `DELETE FROM server_config WHERE key = $1`, urlKeyConfig); err != nil {
		t.Fatalf("clear URL key fingerprint: %v", err)
	}
	return database
}

type fakeQueue struct {
	mu   sync.Mutex
	jobs []jobqueue.Job
	err  error
}

func (q *fakeQueue) Enqueue(_ context.Context, job jobqueue.Job) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.err != nil {
		return q.err
	}
	q.jobs = append(q.jobs, job)
	return nil
}

// take returns and forgets the jobs enqueued so far.
func (q *fakeQueue) take() []jobqueue.Job {
	q.mu.Lock()
	defer q.mu.Unlock()
	jobs := q.jobs
	q.jobs = nil
	return jobs
}

type fakeLimits struct {
	storageMB int
}

func (f fakeLimits) GetLimits(context.Context, string) (*billing.Limits, error) {
	return &billing.Limits{MaxSnapshotStorageMB: f.storageMB}, nil
}

type fakeText struct {
	mu      sync.Mutex
	texts   map[string]string
	deleted []string
}

func newFakeText() *fakeText {
	return &fakeText{texts: map[string]string{}}
}

func (f *fakeText) UpsertSnapshotText(bookmarkID, _ string, text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.texts[bookmarkID] = text
}

func (f *fakeText) DeleteSnapshotTexts(bookmarkIDs []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, bookmarkIDs...)
	for _, id := range bookmarkIDs {
		delete(f.texts, id)
	}
}

func (f *fakeText) wasDeleted(bookmarkID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Contains(f.deleted, bookmarkID)
}

// env is a user with one active workspace and collection, and a Service
// over a local store.
type env struct {
	t            *testing.T
	db           *db.DB
	store        *blobstore.Local
	queue        *fakeQueue
	text         *fakeText
	hub          *pubsub.InMemoryHub
	signer       *Signer
	service      *Service
	userID       string
	collectionID string
	created      int64
}

func newEnv(t *testing.T, storageMB int) *env {
	t.Helper()
	database := openTestDB(t)
	store, err := blobstore.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	signer, err := NewSigner(testSecret, "")
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	e := &env{t: t, db: database, store: store, queue: &fakeQueue{}, text: newFakeText(), hub: pubsub.NewInMemoryHub(), signer: signer}
	t.Cleanup(e.hub.Close)
	e.service = NewService(Config{
		DB: database, Store: store, Queue: e.queue, Signer: signer, Hub: e.hub,
		Limits: fakeLimits{storageMB: storageMB}, Text: e.text,
	})
	e.userID = e.addUser("owner@example.com")
	e.collectionID = e.addCollection(e.userID, "collection-1", false)
	return e
}

func (e *env) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.db.Exec(e.t.Context(), sql, args...); err != nil {
		e.t.Fatalf("exec %q: %v", sql, err)
	}
}

func (e *env) addUser(email string) string {
	e.t.Helper()
	id := uuid.NewString()
	e.exec(`INSERT INTO users (id, name, email, password_hash, is_verified, last_sync_at)
	        VALUES ($1, 'Test', $2, 'x', TRUE, $3)`, id, email, time.Now().Unix())
	return id
}

// addCollection adds a workspace and a collection, archived when asked.
func (e *env) addCollection(userID, id string, archived bool) string {
	e.t.Helper()
	var archivedAt *int64
	if archived {
		at := int64(1)
		archivedAt = &at
	}
	e.exec(`INSERT INTO workspaces (id, user_id, name) VALUES ($1, $2, 'Workspace')`, "ws-"+id, userID)
	e.exec(`INSERT INTO collections (id, user_id, workspace_id, name, archived_at) VALUES ($1, $2, $3, 'Collection', $4)`,
		id, userID, "ws-"+id, archivedAt)
	return id
}

// addBookmark adds an active bookmark; later bookmarks are newer.
func (e *env) addBookmark(id, url string) {
	e.t.Helper()
	e.created++
	e.exec(`INSERT INTO bookmarks (id, user_id, collection_id, title, url, created_at, updated_at)
	        VALUES ($1, $2, $3, 'Title', $4, $5, $5)`, id, e.userID, e.collectionID, url, e.created)
}

// addReadySnapshot stores a ready page snapshot with files of the given sizes.
func (e *env) addReadySnapshot(bookmarkID, url string, sizes map[string]int) map[string]string {
	e.t.Helper()
	e.exec(`INSERT INTO bookmark_snapshots (bookmark_id, user_id, url, status, kind, captured_at, title, seq, updated_at)
	        VALUES ($1, $2, $3, 'ready', 'page', 1, 'Captured', 1, 1)`, bookmarkID, e.userID, url)
	ids := map[string]string{}
	for assetType, size := range sizes {
		id := uuid.NewString()
		ids[assetType] = id
		e.exec(`INSERT INTO snapshot_assets (id, user_id, bookmark_id, type, content_type, size, created_at)
		        VALUES ($1, $2, $3, $4, 'application/octet-stream', $5, 1)`, id, e.userID, bookmarkID, assetType, size)
		if err := e.store.Put(e.t.Context(), AssetKey(e.userID, id), make([]byte, size)); err != nil {
			e.t.Fatalf("put file: %v", err)
		}
	}
	return ids
}

type snapshotState struct {
	status, failureReason, archiveStatus string
	generation, seq                      int64
	pending, archivePending              bool
}

func (e *env) snapshot(bookmarkID string) snapshotState {
	e.t.Helper()
	var s snapshotState
	if err := e.db.QueryRow(e.t.Context(), `
		SELECT status, failure_reason, archive_status, generation, seq, queued_at IS NOT NULL, archive_queued_at IS NOT NULL
		FROM bookmark_snapshots WHERE bookmark_id = $1`, bookmarkID,
	).Scan(&s.status, &s.failureReason, &s.archiveStatus, &s.generation, &s.seq, &s.pending, &s.archivePending); err != nil {
		e.t.Fatalf("read snapshot %s: %v", bookmarkID, err)
	}
	return s
}

func (e *env) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.db.QueryRow(e.t.Context(), sql, args...).Scan(&n); err != nil {
		e.t.Fatalf("count %q: %v", sql, err)
	}
	return n
}

func (e *env) fileExists(assetID string) bool {
	e.t.Helper()
	reader, err := e.store.Open(e.t.Context(), AssetKey(e.userID, assetID), 0)
	if errors.Is(err, blobstore.ErrNotFound) {
		return false
	}
	if err != nil {
		e.t.Fatalf("open %s: %v", assetID, err)
	}
	reader.Close()
	return true
}

// subscribe returns a channel of the sequence numbers broadcast to the user.
func (e *env) subscribe() <-chan int64 {
	e.t.Helper()
	_, ch, ok := e.hub.TrySubscribe(e.userID, 10)
	if !ok {
		e.t.Fatal("subscribe failed")
	}
	return ch
}

func expectBroadcast(t *testing.T, ch <-chan int64) int64 {
	t.Helper()
	select {
	case seq := <-ch:
		return seq
	case <-time.After(2 * time.Second):
		t.Fatal("no sync broadcast")
		return 0
	}
}

func jobBookmarks(jobs []jobqueue.Job) []string {
	ids := make([]string, len(jobs))
	for i, job := range jobs {
		ids[i] = job.BookmarkID
	}
	slices.Sort(ids)
	return ids
}

func seqIDs(prefix string, n int) []string {
	ids := make([]string, n)
	for i := range n {
		ids[i] = fmt.Sprintf("%s-%03d", prefix, i)
	}
	return ids
}
```

Create `internal/snapshots/urls_test.go`:

```go
package snapshots

import (
	"strings"
	"testing"
)

const (
	testSecret      = "0123456789abcdef0123456789abcdef"
	testOtherSecret = "fedcba9876543210fedcba9876543210"
)

func signatureOf(t *testing.T, url string) string {
	t.Helper()
	_, sig, ok := strings.Cut(url, "?sig=")
	if !ok {
		t.Fatalf("URL %q has no signature", url)
	}
	return sig
}

func TestSignerURLsVerify(t *testing.T) {
	signer, err := NewSigner(testSecret, "")
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	url := signer.URL("asset-1")
	if !strings.HasPrefix(url, "/snapshot-assets/asset-1?sig=") {
		t.Fatalf("URL = %q", url)
	}
	sig := signatureOf(t, url)
	if !signer.Valid("asset-1", sig) {
		t.Fatal("own signature rejected")
	}
	if signer.Valid("asset-2", sig) {
		t.Fatal("signature accepted for another asset")
	}
	if signer.Valid("asset-1", "zz") || signer.Valid("asset-1", "") {
		t.Fatal("malformed signature accepted")
	}
}

func TestSignerAcceptsPreviousKeyDuringRotation(t *testing.T) {
	old, err := NewSigner(testOtherSecret, "")
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	oldSig := signatureOf(t, old.URL("asset-1"))

	rotated, err := NewSigner(testSecret, testOtherSecret)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	if !rotated.Valid("asset-1", oldSig) {
		t.Fatal("URL signed with the previous key rejected during rotation")
	}
	if signatureOf(t, rotated.URL("asset-1")) == oldSig {
		t.Fatal("new URLs still use the previous key")
	}

	after, err := NewSigner(testSecret, "")
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	if after.Valid("asset-1", oldSig) {
		t.Fatal("URL signed with a removed key accepted")
	}
	if after.Fingerprint() != rotated.Fingerprint() || after.Fingerprint() == old.Fingerprint() {
		t.Fatal("fingerprint must follow the current key only")
	}
}

func TestNewSignerRequiresLongSecret(t *testing.T) {
	if _, err := NewSigner("short", ""); err == nil {
		t.Fatal("NewSigner accepted a short secret")
	}
}
```

Create `internal/snapshots/rows_test.go`:

```go
package snapshots

import (
	"testing"
	"time"
)

func TestAutoSetting(t *testing.T) {
	e := newEnv(t, -1)
	if auto, err := e.service.Auto(t.Context(), e.userID); err != nil || !auto {
		t.Fatalf("Auto = %v, %v; want true by default", auto, err)
	}
	if err := e.service.SetAuto(t.Context(), e.userID, false); err != nil {
		t.Fatalf("SetAuto: %v", err)
	}
	if auto, err := e.service.Auto(t.Context(), e.userID); err != nil || auto {
		t.Fatalf("Auto = %v, %v; want false", auto, err)
	}
}

func TestRowsCarrySignedURLs(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-ready", "https://ready.example.com")
	e.addBookmark("bm-gone", "https://gone.example.com")
	assets := e.addReadySnapshot("bm-ready", "https://ready.example.com", map[string]int{AssetReader: 10, AssetCover: 5})
	e.exec(`INSERT INTO bookmark_snapshots (bookmark_id, user_id, url, status, seq, updated_at)
	        VALUES ('bm-gone', $1, 'https://gone.example.com', 'deleted', 7, 1)`, e.userID)

	rows, err := e.service.Rows(t.Context(), e.userID, 0)
	if err != nil {
		t.Fatalf("Rows: %v", err)
	}
	if len(rows) != 2 || rows[0].BookmarkID != "bm-ready" || rows[1].Status != StatusDeleted {
		t.Fatalf("rows = %+v", rows)
	}
	ready := rows[0]
	if ready.Size != 15 || ready.ReaderURL != e.signer.URL(assets[AssetReader]) ||
		ready.CoverURL != e.signer.URL(assets[AssetCover]) || ready.ScreenshotURL != "" || ready.Title != "Captured" {
		t.Fatalf("ready row = %+v", ready)
	}
	later, err := e.service.Rows(t.Context(), e.userID, 1)
	if err != nil || len(later) != 1 || later[0].BookmarkID != "bm-gone" {
		t.Fatalf("Rows after seq 1 = %+v, %v", later, err)
	}
}

func TestCheckURLKeyRenumbersRowsWhenKeyChanges(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	e.addReadySnapshot("bm-1", "https://one.example.com", nil)
	if err := e.service.CheckURLKey(t.Context()); err != nil {
		t.Fatalf("first CheckURLKey: %v", err)
	}
	before := e.snapshot("bm-1").seq
	if err := e.service.CheckURLKey(t.Context()); err != nil {
		t.Fatalf("CheckURLKey with the same key: %v", err)
	}
	if got := e.snapshot("bm-1").seq; got != before {
		t.Fatalf("seq changed from %d to %d without a key change", before, got)
	}

	rotated, err := NewSigner(testOtherSecret, testSecret)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	e.service.signer = rotated
	if err := e.service.CheckURLKey(t.Context()); err != nil {
		t.Fatalf("CheckURLKey after rotation: %v", err)
	}
	var userSeq int64
	if err := e.db.QueryRow(t.Context(), `SELECT seq FROM user_sync_seq WHERE user_id = $1`, e.userID).Scan(&userSeq); err != nil {
		t.Fatalf("read user seq: %v", err)
	}
	if got := e.snapshot("bm-1").seq; got <= before || got != userSeq {
		t.Fatalf("seq after rotation = %d (user seq %d), want a new one above %d", got, userSeq, before)
	}
}

func TestNoteSyncWritesAtMostDaily(t *testing.T) {
	e := newEnv(t, -1)
	e.exec(`UPDATE users SET last_sync_at = NULL`)
	now := time.Unix(1_800_000_000, 0)
	e.service.now = func() time.Time { return now }
	if err := e.service.NoteSync(t.Context(), e.userID); err != nil {
		t.Fatalf("NoteSync: %v", err)
	}
	now = now.Add(time.Hour)
	if err := e.service.NoteSync(t.Context(), e.userID); err != nil {
		t.Fatalf("NoteSync: %v", err)
	}
	if got := e.count(`SELECT last_sync_at FROM users WHERE id = $1`, e.userID); got != 1_800_000_000 {
		t.Fatalf("last_sync_at = %d, want the first sync of the day", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/snapshots/
```

Expected: the build fails with `undefined: urlKeyConfig`, `undefined: Signer`, and `undefined: Service`.

- [ ] **Step 3: Add the sync row type**

In `internal/model/model.go`:

Replace:

```go
	ParentType string `json:"parent_type,omitempty"`
}

type SyncPullResponse struct {
	Entities     SyncEntities     `json:"entities"`
	ServerSeq    int64            `json:"server_seq"`
```

with:

```go
	ParentType string `json:"parent_type,omitempty"`
}

// Snapshot is a bookmark's web snapshot as GET /sync/pull returns it. File
// URLs are relative to the server URL and empty when the file does not exist.
// A row with status "deleted" tells clients to drop their copy.
type Snapshot struct {
	BookmarkID     string `json:"bookmark_id"`
	Status         string `json:"status"`
	Kind           string `json:"kind"`
	CapturedAt     *int64 `json:"captured_at"`
	Title          string `json:"title"`
	Excerpt        string `json:"excerpt"`
	Size           int64  `json:"size"`
	CoverURL       string `json:"cover_url"`
	ScreenshotURL  string `json:"screenshot_url"`
	ReaderURL      string `json:"reader_url"`
	FileURL        string `json:"file_url"`
	ArchiveURL     string `json:"archive_url"`
	ArchiveStatus  string `json:"archive_status"`
	ArchiveAt      *int64 `json:"archive_at"`
	ArchiveError   string `json:"archive_error"`
	FailureReason  string `json:"failure_reason"`
	FailureStatus  int    `json:"failure_status"`
	FailedAt       *int64 `json:"failed_at"`
	Pending        bool   `json:"pending"`
	ArchivePending bool   `json:"archive_pending"`
	Seq            int64  `json:"seq"`
}

type SyncPullResponse struct {
	Entities     SyncEntities     `json:"entities"`
	ServerSeq    int64            `json:"server_seq"`
```

- [ ] **Step 4: Write the shared helpers**

Notes on the helpers:
- Every snapshot write takes `lockUser`, a transaction-scoped advisory lock keyed by the user, before reading usage or changing rows. That serializes API requests, worker saves, and the scheduler for one user.
- `deleteSnapshots` keeps the row with status `deleted` and a new sequence number, so other devices drop their copy. It returns the storage keys to delete after the commit.

Create `internal/snapshots/snapshots.go`:

```go
// Package snapshots runs web snapshots around the capture package: it
// decides what to capture, enforces the storage quota, enqueues jobs, saves
// results, and serves snapshot rows for sync. Service is the API side and
// Worker the cmd/fetcher side.
package snapshots

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/billing"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Snapshot statuses (bookmark_snapshots.status).
const (
	StatusQueued      = "queued"
	StatusReady       = "ready"
	StatusFailed      = "failed"
	StatusUnsupported = "unsupported"
	StatusDeleted     = "deleted"
)

// Asset types (snapshot_assets.type).
const (
	AssetReader     = "reader"
	AssetScreenshot = "screenshot"
	AssetCover      = "cover"
	AssetFile       = "file"
	AssetArchive    = "archive"
)

// ReasonStorageFull marks a capture that did not fit in the user's storage.
// The capture package's reasons cover every other failure.
const ReasonStorageFull = "storage_full"

// Advisory lock keys. Both forms take (namespace, key) pairs of int4.
const (
	userLockSpace   = 0x534E5055 // "SNPU": one user's snapshot rows and quota
	serverLockSpace = 0x534E5053 // "SNPS": server-wide snapshot work
	schedulerLockID = 1
	urlKeyLockID    = 2
)

// LimitsProvider returns a user's plan limits; billing.Provider implements it.
type LimitsProvider interface {
	GetLimits(ctx context.Context, userID string) (*billing.Limits, error)
}

// TextIndex keeps snapshot text in the search index; *search.Client
// implements it. Both methods return at once and work in the background.
type TextIndex interface {
	UpsertSnapshotText(bookmarkID, userID, text string)
	DeleteSnapshotTexts(bookmarkIDs []string)
}

// querier is the part of *db.DB and pgx.Tx that reads rows.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// AssetKey is where a snapshot file lives in storage.
func AssetKey(userID, assetID string) string {
	return "snapshots/" + userID + "/" + assetID
}

// storageLimit converts a plan's MiB limit to bytes; -1 stays unlimited.
func storageLimit(limits *billing.Limits) int64 {
	if limits.MaxSnapshotStorageMB < 0 {
		return -1
	}
	return int64(limits.MaxSnapshotStorageMB) << 20
}

// hasRoom reports whether usage leaves more than reserve (a fraction of the
// limit) free. A limit of 0 means the plan has no snapshots.
func hasRoom(limit, usage int64, reserve float64) bool {
	if limit < 0 {
		return true
	}
	return float64(limit-usage) > float64(limit)*reserve
}

func lockUser(ctx context.Context, tx pgx.Tx, userID string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, userLockSpace, userID); err != nil {
		return fmt.Errorf("lock snapshots of %s: %w", userID, err)
	}
	return nil
}

func storageUsage(ctx context.Context, q querier, userID string) (int64, error) {
	var usage int64
	if err := q.QueryRow(ctx,
		`SELECT COALESCE(SUM(size), 0)::BIGINT FROM snapshot_assets WHERE user_id = $1`, userID,
	).Scan(&usage); err != nil {
		return 0, fmt.Errorf("snapshot storage usage: %w", err)
	}
	return usage, nil
}

// nextSeq allocates the user's next sync sequence number, as
// handler.incrementSeq does for every other entity.
func nextSeq(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	var seq int64
	err := tx.QueryRow(ctx,
		`INSERT INTO user_sync_seq (user_id, seq) VALUES ($1, 1)
		 ON CONFLICT (user_id) DO UPDATE SET seq = user_sync_seq.seq + 1
		 RETURNING seq`, userID,
	).Scan(&seq)
	if err != nil {
		return 0, fmt.Errorf("next sync seq: %w", err)
	}
	return seq, nil
}

// deleteSnapshots marks the user's snapshots of bookmarkIDs as deleted and
// removes their asset rows. It returns the storage keys of the removed files,
// which the caller deletes after committing.
func deleteSnapshots(ctx context.Context, tx pgx.Tx, userID string, bookmarkIDs []string, seq, now int64) ([]string, error) {
	rows, err := tx.Query(ctx,
		`DELETE FROM snapshot_assets WHERE user_id = $1 AND bookmark_id = ANY($2) RETURNING id`, userID, bookmarkIDs)
	if err != nil {
		return nil, fmt.Errorf("delete snapshot assets: %w", err)
	}
	assetIDs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, fmt.Errorf("delete snapshot assets: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE bookmark_snapshots
		SET status = 'deleted', kind = '', captured_at = NULL, http_status = 0, final_url = '',
		    title = '', excerpt = '', failure_reason = '', failure_status = 0, failed_at = NULL,
		    archive_status = '', archive_at = NULL, archive_error = '', manual_requested_at = NULL,
		    queued_at = NULL, enqueued_at = NULL, archive_queued_at = NULL, archive_enqueued_at = NULL,
		    seq = $3, updated_at = $4
		WHERE user_id = $1 AND bookmark_id = ANY($2)`, userID, bookmarkIDs, seq, now); err != nil {
		return nil, fmt.Errorf("mark snapshots deleted: %w", err)
	}
	keys := make([]string, len(assetIDs))
	for i, id := range assetIDs {
		keys[i] = AssetKey(userID, id)
	}
	return keys, nil
}

func ignoreNoRows(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}

func millis(t time.Time) int64 {
	return t.UnixMilli()
}
```

`change` collects what one transaction did. After the commit, `effects.finish` deletes replaced files and search texts, enqueues jobs, and broadcasts the sequence number. Its failures are logged: the daily garbage collection removes leftover files, and the scheduler enqueues queued snapshots again.

Create `internal/snapshots/change.go`:

```go
package snapshots

import (
	"context"
	"log"

	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
	"github.com/jackc/pgx/v5"
)

// change collects what one transaction did to a user's snapshots, so the
// work that must wait for the commit can follow it.
type change struct {
	userID string
	seq    int64          // 0 until the first row changes
	keys   []string       // storage keys of files to delete
	texts  []string       // bookmark IDs whose search text to delete
	jobs   []jobqueue.Job // jobs to enqueue
}

// bumpSeq allocates the transaction's sequence number on first use; every
// row the transaction changes gets the same one.
func (c *change) bumpSeq(ctx context.Context, tx pgx.Tx) (int64, error) {
	if c.seq != 0 {
		return c.seq, nil
	}
	seq, err := nextSeq(ctx, tx, c.userID)
	if err != nil {
		return 0, err
	}
	c.seq = seq
	return seq, nil
}

// effects are the services a change touches after its commit.
type effects struct {
	store blobstore.Store
	queue jobqueue.Queue // nil in the worker, which enqueues nothing
	text  TextIndex      // nil when search is off
	hub   pubsub.Hub
}

// finish deletes replaced files and texts, enqueues jobs, and tells the
// user's devices to pull. Failures are logged: the daily cleanup removes
// files left behind, and the scheduler enqueues queued snapshots again.
func (e effects) finish(ctx context.Context, c *change) {
	ctx = context.WithoutCancel(ctx)
	for _, key := range c.keys {
		if err := e.store.Delete(ctx, key); err != nil {
			log.Printf("snapshots: delete file %s: %v", key, err)
		}
	}
	if len(c.texts) > 0 && e.text != nil {
		e.text.DeleteSnapshotTexts(c.texts)
	}
	for _, job := range c.jobs {
		if err := e.queue.Enqueue(ctx, job); err != nil {
			log.Printf("snapshots: enqueue %s: %v", job.Key(), err)
		}
	}
	if c.seq != 0 {
		e.hub.Broadcast(c.userID, c.seq)
	}
}
```

- [ ] **Step 5: Write the URL signer**

Create `internal/snapshots/urls.go`:

```go
package snapshots

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
)

// minSecretBytes matches the guidance for JWT_SECRET (openssl rand -hex 32).
const minSecretBytes = 32

// Signer makes and checks the capability URLs of snapshot files. A URL is
// /snapshot-assets/<assetId>?sig=<hex>, where sig is an HMAC of the asset ID.
type Signer struct {
	current  []byte
	previous []byte
}

// NewSigner takes SNAPSHOT_URL_SECRET and, during a key rotation,
// SNAPSHOT_URL_SECRET_PREVIOUS (empty otherwise).
func NewSigner(current, previous string) (*Signer, error) {
	if len(current) < minSecretBytes {
		return nil, errors.New("snapshots: SNAPSHOT_URL_SECRET must be at least 32 bytes")
	}
	signer := &Signer{current: []byte(current)}
	if previous != "" {
		signer.previous = []byte(previous)
	}
	return signer, nil
}

func signature(key []byte, assetID string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("snapshot-asset:" + assetID))
	return mac.Sum(nil)
}

// URL returns the file URL of assetID, relative to the server URL.
func (s *Signer) URL(assetID string) string {
	return "/snapshot-assets/" + assetID + "?sig=" + hex.EncodeToString(signature(s.current, assetID))
}

// Valid reports whether sig signs assetID with the current or the previous key.
func (s *Signer) Valid(assetID, sig string) bool {
	got, err := hex.DecodeString(sig)
	if err != nil {
		return false
	}
	if hmac.Equal(got, signature(s.current, assetID)) {
		return true
	}
	return s.previous != nil && hmac.Equal(got, signature(s.previous, assetID))
}

// Fingerprint identifies the current key without revealing it.
func (s *Signer) Fingerprint() string {
	sum := sha256.Sum256(append([]byte("tabslate-snapshot-url-key:"), s.current...))
	return hex.EncodeToString(sum[:16])
}
```

- [ ] **Step 6: Write the service, the sync rows, and the key check**

Create `internal/snapshots/service.go`:

```go
package snapshots

import (
	"context"
	"fmt"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
)

// Config wires a Service.
type Config struct {
	DB     *db.DB
	Store  blobstore.Store
	Queue  jobqueue.Queue
	Signer *Signer
	Hub    pubsub.Hub
	Limits LimitsProvider
	// Text is nil when MeiliSearch is not configured.
	Text TextIndex
	// MaxAttemptsPerDay caps capture attempts per user per UTC day; 0 is unlimited.
	MaxAttemptsPerDay int
}

// Service is the API side of web snapshots.
type Service struct {
	db          *db.DB
	signer      *Signer
	limits      LimitsProvider
	maxAttempts int
	effects     effects
	now         func() time.Time
}

// NewService returns a Service.
func NewService(cfg Config) *Service {
	return &Service{
		db:          cfg.DB,
		signer:      cfg.Signer,
		limits:      cfg.Limits,
		maxAttempts: cfg.MaxAttemptsPerDay,
		effects:     effects{store: cfg.Store, queue: cfg.Queue, text: cfg.Text, hub: cfg.Hub},
		now:         time.Now,
	}
}

// Auto reports the user's "Save snapshots automatically" setting.
func (s *Service) Auto(ctx context.Context, userID string) (bool, error) {
	var auto bool
	if err := s.db.QueryRow(ctx, `SELECT snapshot_auto FROM users WHERE id = $1`, userID).Scan(&auto); err != nil {
		return false, fmt.Errorf("read snapshot setting: %w", err)
	}
	return auto, nil
}

// SetAuto changes the user's "Save snapshots automatically" setting.
func (s *Service) SetAuto(ctx context.Context, userID string, auto bool) error {
	if _, err := s.db.Exec(ctx, `UPDATE users SET snapshot_auto = $1 WHERE id = $2`, auto, userID); err != nil {
		return fmt.Errorf("write snapshot setting: %w", err)
	}
	return nil
}

// NoteSync records that the user synced, which keeps them in the backfill.
// It writes at most once a day per user.
func (s *Service) NoteSync(ctx context.Context, userID string) error {
	now := s.now().Unix()
	if _, err := s.db.Exec(ctx,
		`UPDATE users SET last_sync_at = $1 WHERE id = $2 AND (last_sync_at IS NULL OR last_sync_at < $3)`,
		now, userID, now-24*60*60); err != nil {
		return fmt.Errorf("note sync: %w", err)
	}
	return nil
}
```

`Rows` returns rows changed after `afterSeq`, each with signed URLs for the files it has and the sum of their sizes.

Create `internal/snapshots/rows.go`:

```go
package snapshots

import (
	"context"
	"fmt"

	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/jackc/pgx/v5"
)

// Rows returns the user's snapshot rows changed after afterSeq, in seq
// order, with signed file URLs.
func (s *Service) Rows(ctx context.Context, userID string, afterSeq int64) ([]model.Snapshot, error) {
	rows, err := s.db.Query(ctx, `
		SELECT bookmark_id, status, kind, captured_at, title, excerpt, archive_status, archive_at, archive_error,
		       failure_reason, failure_status, failed_at, queued_at IS NOT NULL, archive_queued_at IS NOT NULL, seq
		FROM bookmark_snapshots
		WHERE user_id = $1 AND seq > $2
		ORDER BY seq, bookmark_id`, userID, afterSeq)
	if err != nil {
		return nil, fmt.Errorf("query snapshots: %w", err)
	}
	snapshots, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (model.Snapshot, error) {
		var snap model.Snapshot
		err := row.Scan(&snap.BookmarkID, &snap.Status, &snap.Kind, &snap.CapturedAt, &snap.Title, &snap.Excerpt,
			&snap.ArchiveStatus, &snap.ArchiveAt, &snap.ArchiveError, &snap.FailureReason, &snap.FailureStatus,
			&snap.FailedAt, &snap.Pending, &snap.ArchivePending, &snap.Seq)
		return snap, err
	})
	if err != nil {
		return nil, fmt.Errorf("query snapshots: %w", err)
	}
	if len(snapshots) == 0 {
		return []model.Snapshot{}, nil
	}

	index := make(map[string]int, len(snapshots))
	ids := make([]string, len(snapshots))
	for i, snap := range snapshots {
		index[snap.BookmarkID] = i
		ids[i] = snap.BookmarkID
	}
	assetRows, err := s.db.Query(ctx, `
		SELECT bookmark_id, id, type, size FROM snapshot_assets WHERE user_id = $1 AND bookmark_id = ANY($2)`,
		userID, ids)
	if err != nil {
		return nil, fmt.Errorf("query snapshot assets: %w", err)
	}
	defer assetRows.Close()
	for assetRows.Next() {
		var bookmarkID, assetID, assetType string
		var size int64
		if err := assetRows.Scan(&bookmarkID, &assetID, &assetType, &size); err != nil {
			return nil, fmt.Errorf("scan snapshot asset: %w", err)
		}
		snap := &snapshots[index[bookmarkID]]
		snap.Size += size
		url := s.signer.URL(assetID)
		switch assetType {
		case AssetReader:
			snap.ReaderURL = url
		case AssetScreenshot:
			snap.ScreenshotURL = url
		case AssetCover:
			snap.CoverURL = url
		case AssetFile:
			snap.FileURL = url
		case AssetArchive:
			snap.ArchiveURL = url
		}
	}
	if err := assetRows.Err(); err != nil {
		return nil, fmt.Errorf("query snapshot assets: %w", err)
	}
	return snapshots, nil
}
```

`CheckURLKey` stores a fingerprint of `SNAPSHOT_URL_SECRET` in `server_config`. When the fingerprint changes, every snapshot row gets its user's next sequence number, so clients pull URLs signed with the new key. An advisory lock keeps two API instances from doing this at once.

Create `internal/snapshots/keycheck.go`:

```go
package snapshots

import (
	"context"
	"fmt"
)

const urlKeyConfig = "snapshot_url_key_fingerprint"

// CheckURLKey runs at startup. When SNAPSHOT_URL_SECRET changed since the
// last start, it gives every snapshot row a new sequence number, so clients
// pull URLs signed with the new key.
func (s *Service) CheckURLKey(ctx context.Context) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin URL key check: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, $2)`, serverLockSpace, urlKeyLockID); err != nil {
		return fmt.Errorf("lock URL key check: %w", err)
	}
	var stored string
	err = tx.QueryRow(ctx, `SELECT value FROM server_config WHERE key = $1`, urlKeyConfig).Scan(&stored)
	if err := ignoreNoRows(err); err != nil {
		return fmt.Errorf("read URL key fingerprint: %w", err)
	}
	fingerprint := s.signer.Fingerprint()
	if stored == fingerprint {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		WITH bumped AS (
			INSERT INTO user_sync_seq (user_id, seq)
			SELECT DISTINCT user_id, 1 FROM bookmark_snapshots
			ON CONFLICT (user_id) DO UPDATE SET seq = user_sync_seq.seq + 1
			RETURNING user_id, seq
		)
		UPDATE bookmark_snapshots s SET seq = bumped.seq FROM bumped WHERE s.user_id = bumped.user_id`); err != nil {
		return fmt.Errorf("renumber snapshots: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO server_config (key, value) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, urlKeyConfig, fingerprint); err != nil {
		return fmt.Errorf("store URL key fingerprint: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit URL key check: %w", err)
	}
	return nil
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go vet ./internal/snapshots/ ./internal/model/
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/snapshots/ -v
```

Expected: `vet` passes, and these tests pass:
- `TestSignerURLsVerify`, `TestSignerAcceptsPreviousKeyDuringRotation`, `TestNewSignerRequiresLongSecret`;
- `TestAutoSetting`, `TestRowsCarrySignedURLs`, `TestCheckURLKeyRenumbersRowsWhenKeyChanges`, `TestNoteSyncWritesAtMostDaily`.

- [ ] **Step 8: Commit**

```bash
git add internal/model/model.go internal/snapshots/snapshots.go internal/snapshots/change.go internal/snapshots/urls.go \
  internal/snapshots/service.go internal/snapshots/rows.go internal/snapshots/keycheck.go \
  internal/snapshots/helpers_test.go internal/snapshots/urls_test.go internal/snapshots/rows_test.go
git commit -m "feat(snapshots): add the snapshot service core, sync rows, and signed URLs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- internal/model/model.go \
  internal/snapshots/snapshots.go internal/snapshots/change.go internal/snapshots/urls.go \
  internal/snapshots/service.go internal/snapshots/rows.go internal/snapshots/keycheck.go \
  internal/snapshots/helpers_test.go internal/snapshots/urls_test.go internal/snapshots/rows_test.go
```

---

### Task 6: Manual requests, archives, and deletion

**Files:**
- Create: `internal/snapshots/requests.go`
- Test: `internal/snapshots/requests_test.go`

**Interfaces:**
- Consumes: Task 5's helpers, `netguard.ValidateURL` (C2-1), and `jobqueue.Job`.
- Produces:
  - `(*Service).Request(ctx, userID string, bookmarkIDs []string) (*RequestResult, error)`, with `RequestResult{Queued []string; Skipped []Skipped}` and `Skipped{BookmarkID, Reason string}`.
  - `(*Service).RequestArchive(ctx, userID, bookmarkID) error`.
  - `(*Service).Delete(ctx, userID, bookmarkID) error` and `(*Service).DeleteArchive(ctx, userID, bookmarkID) error`.
  - `(*Service).RemoveGone(ctx, userID) error`.
  - Errors: `ErrQuotaExceeded`, `ErrDailyLimit`, `ErrNotFound`, `ErrNoPage`, `ErrAlreadyQueued`.
  - Skip reasons: `SkipNotFound`, `SkipTooSoon`, `SkipUnsupported`, `SkipDailyLimit`. Also `MaxRequestBookmarks = 100`.
  - Internal, for Tasks 7 to 9: `candidate`, `queueCaptures(ctx, tx, ch, candidates, now, manual, limit)`, `removeGone(ctx, tx, ch, now)`, and `(*Service).reserveAttempts`.

- [ ] **Step 1: Write the failing tests**

The tests cover:
- queued jobs and rows, with the generation and the broadcast sequence number;
- every skip reason;
- a pending snapshot that counts as queued without a second job;
- the 10-minute rule;
- `403` when the plan has no snapshots or storage is full;
- the daily limit;
- archive rules;
- deletion that frees files and search text.

Create `internal/snapshots/requests_test.go`:

```go
package snapshots

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
)

func TestRequestQueuesBookmarks(t *testing.T) {
	e := newEnv(t, 100)
	e.addBookmark("bm-1", "https://one.example.com")
	e.addBookmark("bm-2", "https://two.example.com")
	updates := e.subscribe()

	result, err := e.service.Request(t.Context(), e.userID, []string{"bm-1", "bm-2", "bm-1"})
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if !slices.Equal(result.Queued, []string{"bm-1", "bm-2"}) || len(result.Skipped) != 0 {
		t.Fatalf("result = %+v, want both queued once", result)
	}
	jobs := e.queue.take()
	if !slices.Equal(jobBookmarks(jobs), []string{"bm-1", "bm-2"}) {
		t.Fatalf("jobs = %+v", jobs)
	}
	seq := expectBroadcast(t, updates)
	for _, job := range jobs {
		state := e.snapshot(job.BookmarkID)
		if job.Kind != jobqueue.KindCapture || job.UserID != e.userID || job.StorageLimit != 100<<20 ||
			state.generation != job.Generation || state.status != StatusQueued || !state.pending || state.seq != seq {
			t.Fatalf("job %+v with row %+v, broadcast seq %d", job, state, seq)
		}
	}
}

func TestRequestSkips(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-ready", "https://ready.example.com")
	e.addBookmark("bm-unsupported", "https://video.example.com/clip.mp4")
	e.addBookmark("bm-local", "file:///etc/hosts")
	e.addBookmark("bm-trashed", "https://trashed.example.com")
	e.exec(`UPDATE bookmarks SET is_trashed = 1 WHERE id = 'bm-trashed'`)
	e.exec(`INSERT INTO bookmark_snapshots (bookmark_id, user_id, url, status, updated_at)
	        VALUES ('bm-unsupported', $1, 'https://video.example.com/clip.mp4', 'unsupported', 1)`, e.userID)
	otherID := e.addUser("other@example.com")
	e.addCollection(otherID, "other-collection", false)
	e.exec(`INSERT INTO bookmarks (id, user_id, collection_id, title, url) VALUES ('bm-other', $1, 'other-collection', 'T', 'https://other.example.com')`, otherID)

	first, err := e.service.Request(t.Context(), e.userID, []string{"bm-ready"})
	if err != nil || !slices.Equal(first.Queued, []string{"bm-ready"}) {
		t.Fatalf("first request = %+v, %v", first, err)
	}
	result, err := e.service.Request(t.Context(), e.userID,
		[]string{"bm-ready", "bm-unsupported", "bm-local", "bm-trashed", "bm-other", "bm-missing"})
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	want := []Skipped{
		{"bm-ready", SkipTooSoon},
		{"bm-unsupported", SkipUnsupported},
		{"bm-local", SkipUnsupported},
		{"bm-trashed", SkipNotFound},
		{"bm-other", SkipNotFound},
		{"bm-missing", SkipNotFound},
	}
	if len(result.Queued) != 0 || !slices.Equal(result.Skipped, want) {
		t.Fatalf("result = %+v, want skipped %+v", result, want)
	}
}

func TestRequestCountsPendingSnapshotAsQueued(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	e.exec(`INSERT INTO bookmark_snapshots (bookmark_id, user_id, url, status, generation, queued_at, enqueued_at, updated_at)
	        VALUES ('bm-1', $1, 'https://one.example.com', 'queued', 7, $2, $2, $2)`, e.userID, time.Now().UnixMilli())

	result, err := e.service.Request(t.Context(), e.userID, []string{"bm-1"})
	if err != nil || !slices.Equal(result.Queued, []string{"bm-1"}) {
		t.Fatalf("Request = %+v, %v", result, err)
	}
	if jobs := e.queue.take(); len(jobs) != 0 || e.snapshot("bm-1").generation != 7 {
		t.Fatalf("a pending snapshot was queued again: %+v", jobs)
	}
}

func TestRequestAllowsUpdateAfterTenMinutes(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	e.addReadySnapshot("bm-1", "https://one.example.com", map[string]int{AssetReader: 10})
	e.exec(`UPDATE bookmark_snapshots SET manual_requested_at = $1`, time.Now().Add(-11*time.Minute).UnixMilli())

	result, err := e.service.Request(t.Context(), e.userID, []string{"bm-1"})
	if err != nil || !slices.Equal(result.Queued, []string{"bm-1"}) {
		t.Fatalf("Request = %+v, %v", result, err)
	}
	if state := e.snapshot("bm-1"); state.status != StatusReady || !state.pending {
		t.Fatalf("snapshot = %+v, want it ready with an update pending", state)
	}
}

func TestRequestNeedsStorage(t *testing.T) {
	t.Run("plan without snapshots", func(t *testing.T) {
		e := newEnv(t, 0)
		e.addBookmark("bm-1", "https://one.example.com")
		if _, err := e.service.Request(t.Context(), e.userID, []string{"bm-1"}); !errors.Is(err, ErrQuotaExceeded) {
			t.Fatalf("Request = %v, want ErrQuotaExceeded", err)
		}
	})
	t.Run("storage full", func(t *testing.T) {
		e := newEnv(t, 1)
		e.addBookmark("bm-1", "https://one.example.com")
		e.addBookmark("bm-2", "https://two.example.com")
		e.addReadySnapshot("bm-1", "https://one.example.com", map[string]int{AssetScreenshot: 1 << 20})
		if _, err := e.service.Request(t.Context(), e.userID, []string{"bm-2"}); !errors.Is(err, ErrQuotaExceeded) {
			t.Fatalf("Request = %v, want ErrQuotaExceeded", err)
		}
	})
}

func TestRequestDailyLimit(t *testing.T) {
	e := newEnv(t, -1)
	e.service.maxAttempts = 2
	for _, id := range []string{"bm-1", "bm-2", "bm-3"} {
		e.addBookmark(id, "https://"+id+".example.com")
	}
	result, err := e.service.Request(t.Context(), e.userID, []string{"bm-1", "bm-2", "bm-3"})
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if !slices.Equal(result.Queued, []string{"bm-1", "bm-2"}) || !slices.Equal(result.Skipped, []Skipped{{"bm-3", SkipDailyLimit}}) {
		t.Fatalf("result = %+v", result)
	}
	if got := e.count(`SELECT attempts FROM snapshot_attempts WHERE user_id = $1`, e.userID); got != 2 {
		t.Fatalf("attempts = %d, want 2", got)
	}
}

func TestRequestArchive(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-page", "https://page.example.com")
	e.addBookmark("bm-none", "https://none.example.com")
	e.addReadySnapshot("bm-page", "https://page.example.com", map[string]int{AssetReader: 10})

	if err := e.service.RequestArchive(t.Context(), e.userID, "bm-none"); !errors.Is(err, ErrNoPage) {
		t.Fatalf("archive without a snapshot = %v, want ErrNoPage", err)
	}
	if err := e.service.RequestArchive(t.Context(), e.userID, "bm-missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("archive of a missing bookmark = %v, want ErrNotFound", err)
	}
	if err := e.service.RequestArchive(t.Context(), e.userID, "bm-page"); err != nil {
		t.Fatalf("RequestArchive: %v", err)
	}
	jobs := e.queue.take()
	state := e.snapshot("bm-page")
	if len(jobs) != 1 || jobs[0].Kind != jobqueue.KindArchive || state.archiveStatus != "queued" || !state.archivePending {
		t.Fatalf("jobs %+v, snapshot %+v", jobs, state)
	}
	if err := e.service.RequestArchive(t.Context(), e.userID, "bm-page"); !errors.Is(err, ErrAlreadyQueued) {
		t.Fatalf("second archive request = %v, want ErrAlreadyQueued", err)
	}
}

func TestDeleteFreesSpace(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	assets := e.addReadySnapshot("bm-1", "https://one.example.com", map[string]int{AssetReader: 10, AssetArchive: 20})
	updates := e.subscribe()

	if err := e.service.Delete(t.Context(), e.userID, "bm-1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if state := e.snapshot("bm-1"); state.status != StatusDeleted || state.seq != expectBroadcast(t, updates) {
		t.Fatalf("snapshot after delete = %+v", state)
	}
	if n := e.count(`SELECT COUNT(*) FROM snapshot_assets`); n != 0 {
		t.Fatalf("%d assets left", n)
	}
	for _, id := range assets {
		if e.fileExists(id) {
			t.Fatalf("file %s left in storage", id)
		}
	}
	if !e.text.wasDeleted("bm-1") {
		t.Fatal("search text not deleted")
	}
	if err := e.service.Delete(t.Context(), e.userID, "bm-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v, want ErrNotFound", err)
	}
}

func TestDeleteArchiveKeepsSnapshot(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	assets := e.addReadySnapshot("bm-1", "https://one.example.com", map[string]int{AssetReader: 10, AssetArchive: 20})
	e.exec(`UPDATE bookmark_snapshots SET archive_status = 'ready', archive_at = 1`)

	if err := e.service.DeleteArchive(t.Context(), e.userID, "bm-1"); err != nil {
		t.Fatalf("DeleteArchive: %v", err)
	}
	if state := e.snapshot("bm-1"); state.status != StatusReady || state.archiveStatus != "" {
		t.Fatalf("snapshot = %+v", state)
	}
	if e.fileExists(assets[AssetArchive]) || !e.fileExists(assets[AssetReader]) {
		t.Fatal("DeleteArchive removed the wrong files")
	}
	if err := e.service.DeleteArchive(t.Context(), e.userID, "bm-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second DeleteArchive = %v, want ErrNotFound", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/snapshots/
```

Expected: the build fails with `e.service.Request undefined (type *Service has no field or method Request)`.

- [ ] **Step 3: Write the requests**

How a request works:
- **Request.** `Request` checks the quota before it looks at the bookmarks, so storage that is already full answers `403` for the whole request. It then classifies each bookmark in order. A bookmark with a pending job counts as queued and gets no second job.
- **Queuing.** `queueCaptures` gives every queued bookmark a new generation and one shared sequence number. The `ON CONFLICT` branch keeps a `ready` snapshot `ready` while it is updated.
- **Stale snapshots.** Every request first runs `removeGone` under the user's lock, so a snapshot of an old URL is deleted before anything is queued for the new one.

Create `internal/snapshots/requests.go`:

```go
package snapshots

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/internal/netguard"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
	"github.com/jackc/pgx/v5"
)

const (
	// MaxRequestBookmarks is the most bookmarks one POST /snapshots may name.
	MaxRequestBookmarks = 100
	// manualInterval is the shortest time between manual requests for one bookmark.
	manualInterval = 10 * time.Minute
)

// Skip reasons in a POST /snapshots response.
const (
	SkipNotFound    = "not_found"
	SkipTooSoon     = "too_soon"
	SkipUnsupported = "unsupported"
	SkipDailyLimit  = "daily_limit"
)

var (
	// ErrQuotaExceeded means the user's snapshot storage is full or the plan has none.
	ErrQuotaExceeded = errors.New("snapshot storage is full")
	// ErrDailyLimit means the user used up today's capture attempts.
	ErrDailyLimit = errors.New("daily snapshot limit reached")
	// ErrNotFound means the bookmark or its snapshot does not exist.
	ErrNotFound = errors.New("snapshot not found")
	// ErrNoPage means a full-page archive needs a ready page snapshot first.
	ErrNoPage = errors.New("no page snapshot to archive")
	// ErrAlreadyQueued means a full-page archive is already on its way.
	ErrAlreadyQueued = errors.New("full-page archive already queued")
)

// Skipped is a bookmark that a request did not queue.
type Skipped struct {
	BookmarkID string `json:"bookmark_id"`
	Reason     string `json:"reason"`
}

// RequestResult answers POST /snapshots.
type RequestResult struct {
	Queued  []string  `json:"queued"`
	Skipped []Skipped `json:"skipped"`
}

type candidate struct {
	id       string
	url      string
	status   string
	manualAt *int64
	pending  bool
}

// Request takes or updates snapshots of the user's bookmarks on demand.
// Archived bookmarks qualify; trashed ones do not.
func (s *Service) Request(ctx context.Context, userID string, bookmarkIDs []string) (*RequestResult, error) {
	limits, err := s.limits.GetLimits(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("snapshot limits: %w", err)
	}
	limit := storageLimit(limits)

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin snapshot request: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockUser(ctx, tx, userID); err != nil {
		return nil, err
	}
	ch := &change{userID: userID}
	now := s.now()
	if err := removeGone(ctx, tx, ch, now); err != nil {
		return nil, err
	}
	usage, err := storageUsage(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	if !hasRoom(limit, usage, 0) {
		return nil, ErrQuotaExceeded
	}

	ids := uniqueIDs(bookmarkIDs)
	rows, err := tx.Query(ctx, `
		SELECT b.id, b.url, COALESCE(s.status, ''), s.manual_requested_at, s.queued_at IS NOT NULL
		FROM bookmarks b
		JOIN collections c ON c.id = b.collection_id AND c.user_id = b.user_id
		JOIN workspaces w ON w.id = c.workspace_id AND w.user_id = c.user_id
		LEFT JOIN bookmark_snapshots s ON s.bookmark_id = b.id
		WHERE b.user_id = $1 AND b.id = ANY($2)
		  AND b.deleted_at IS NULL AND b.is_trashed = 0
		  AND c.deleted_at IS NULL AND c.is_deleted = 0 AND w.is_deleted = 0`, userID, ids)
	if err != nil {
		return nil, fmt.Errorf("load requested bookmarks: %w", err)
	}
	found, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (candidate, error) {
		var c candidate
		err := row.Scan(&c.id, &c.url, &c.status, &c.manualAt, &c.pending)
		return c, err
	})
	if err != nil {
		return nil, fmt.Errorf("load requested bookmarks: %w", err)
	}
	byID := make(map[string]candidate, len(found))
	for _, c := range found {
		byID[c.id] = c
	}

	result := &RequestResult{Queued: []string{}, Skipped: []Skipped{}}
	var toQueue []candidate
	for _, id := range ids {
		c, ok := byID[id]
		_, urlErr := netguard.ValidateURL(c.url)
		switch {
		case !ok:
			result.Skipped = append(result.Skipped, Skipped{id, SkipNotFound})
		case c.status == StatusUnsupported || urlErr != nil:
			result.Skipped = append(result.Skipped, Skipped{id, SkipUnsupported})
		case c.manualAt != nil && now.Sub(time.UnixMilli(*c.manualAt)) < manualInterval:
			result.Skipped = append(result.Skipped, Skipped{id, SkipTooSoon})
		case c.pending:
			result.Queued = append(result.Queued, id)
		default:
			toQueue = append(toQueue, c)
		}
	}
	granted, err := s.reserveAttempts(ctx, tx, userID, len(toQueue))
	if err != nil {
		return nil, err
	}
	for _, c := range toQueue[granted:] {
		result.Skipped = append(result.Skipped, Skipped{c.id, SkipDailyLimit})
	}
	toQueue = toQueue[:granted]
	if err := queueCaptures(ctx, tx, ch, toQueue, now, true, limit); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit snapshot request: %w", err)
	}
	s.effects.finish(ctx, ch)
	for _, c := range toQueue {
		result.Queued = append(result.Queued, c.id)
	}
	return result, nil
}

// queueCaptures marks candidates as waiting for a capture, each with a new
// generation, and adds their jobs to ch. A ready snapshot stays ready while
// it is updated.
func queueCaptures(ctx context.Context, tx pgx.Tx, ch *change, candidates []candidate, now time.Time, manual bool, limit int64) error {
	if len(candidates) == 0 {
		return nil
	}
	seq, err := ch.bumpSeq(ctx, tx)
	if err != nil {
		return err
	}
	var manualAt *int64
	if manual {
		at := millis(now)
		manualAt = &at
	}
	for _, c := range candidates {
		var generation int64
		if err := tx.QueryRow(ctx, `
			INSERT INTO bookmark_snapshots (bookmark_id, user_id, url, status, generation, queued_at, enqueued_at,
			                                manual_requested_at, seq, updated_at)
			VALUES ($1, $2, $3, 'queued', nextval('snapshot_generation_seq'), $4, $4, $5, $6, $4)
			ON CONFLICT (bookmark_id) DO UPDATE
			SET url = EXCLUDED.url,
			    status = CASE WHEN bookmark_snapshots.status = 'ready' THEN 'ready' ELSE 'queued' END,
			    generation = EXCLUDED.generation,
			    queued_at = EXCLUDED.queued_at,
			    enqueued_at = EXCLUDED.enqueued_at,
			    manual_requested_at = COALESCE(EXCLUDED.manual_requested_at, bookmark_snapshots.manual_requested_at),
			    seq = EXCLUDED.seq,
			    updated_at = EXCLUDED.updated_at
			RETURNING generation`,
			c.id, ch.userID, c.url, millis(now), manualAt, seq,
		).Scan(&generation); err != nil {
			return fmt.Errorf("queue snapshot of %s: %w", c.id, err)
		}
		ch.jobs = append(ch.jobs, jobqueue.Job{
			Kind: jobqueue.KindCapture, UserID: ch.userID, BookmarkID: c.id, Generation: generation, StorageLimit: limit,
		})
	}
	return nil
}

// RequestArchive saves a full-page archive of a bookmark whose page snapshot is ready.
func (s *Service) RequestArchive(ctx context.Context, userID, bookmarkID string) error {
	limits, err := s.limits.GetLimits(ctx, userID)
	if err != nil {
		return fmt.Errorf("snapshot limits: %w", err)
	}
	limit := storageLimit(limits)

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin archive request: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockUser(ctx, tx, userID); err != nil {
		return err
	}
	ch := &change{userID: userID}
	now := s.now()
	if err := removeGone(ctx, tx, ch, now); err != nil {
		return err
	}
	usage, err := storageUsage(ctx, tx, userID)
	if err != nil {
		return err
	}
	if !hasRoom(limit, usage, 0) {
		return ErrQuotaExceeded
	}
	var status, kind string
	var pending bool
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(s.status, ''), COALESCE(s.kind, ''), COALESCE(s.archive_queued_at IS NOT NULL, FALSE)
		FROM bookmarks b
		JOIN collections c ON c.id = b.collection_id AND c.user_id = b.user_id
		JOIN workspaces w ON w.id = c.workspace_id AND w.user_id = c.user_id
		LEFT JOIN bookmark_snapshots s ON s.bookmark_id = b.id
		WHERE b.user_id = $1 AND b.id = $2
		  AND b.deleted_at IS NULL AND b.is_trashed = 0
		  AND c.deleted_at IS NULL AND c.is_deleted = 0 AND w.is_deleted = 0`,
		userID, bookmarkID).Scan(&status, &kind, &pending)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return ErrNotFound
	case err != nil:
		return fmt.Errorf("load archive request: %w", err)
	case status != StatusReady || kind != "page":
		return ErrNoPage
	case pending:
		return ErrAlreadyQueued
	}
	granted, err := s.reserveAttempts(ctx, tx, userID, 1)
	if err != nil {
		return err
	}
	if granted == 0 {
		return ErrDailyLimit
	}
	seq, err := ch.bumpSeq(ctx, tx)
	if err != nil {
		return err
	}
	var generation int64
	if err := tx.QueryRow(ctx, `
		UPDATE bookmark_snapshots
		SET archive_status = CASE WHEN archive_status = 'ready' THEN 'ready' ELSE 'queued' END,
		    archive_generation = nextval('snapshot_generation_seq'),
		    archive_queued_at = $2, archive_enqueued_at = $2, seq = $3, updated_at = $2
		WHERE bookmark_id = $1
		RETURNING archive_generation`, bookmarkID, millis(now), seq).Scan(&generation); err != nil {
		return fmt.Errorf("queue archive of %s: %w", bookmarkID, err)
	}
	ch.jobs = append(ch.jobs, jobqueue.Job{
		Kind: jobqueue.KindArchive, UserID: userID, BookmarkID: bookmarkID, Generation: generation, StorageLimit: limit,
	})
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit archive request: %w", err)
	}
	s.effects.finish(ctx, ch)
	return nil
}

// Delete removes a bookmark's snapshot, including its archive, and frees its space.
func (s *Service) Delete(ctx context.Context, userID, bookmarkID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin snapshot delete: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockUser(ctx, tx, userID); err != nil {
		return err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM bookmark_snapshots WHERE user_id = $1 AND bookmark_id = $2 AND status <> 'deleted')`,
		userID, bookmarkID).Scan(&exists); err != nil {
		return fmt.Errorf("find snapshot: %w", err)
	}
	if !exists {
		return ErrNotFound
	}
	ch := &change{userID: userID, texts: []string{bookmarkID}}
	seq, err := ch.bumpSeq(ctx, tx)
	if err != nil {
		return err
	}
	if ch.keys, err = deleteSnapshots(ctx, tx, userID, []string{bookmarkID}, seq, millis(s.now())); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit snapshot delete: %w", err)
	}
	s.effects.finish(ctx, ch)
	return nil
}

// DeleteArchive removes only the full-page archive, or cancels a queued one.
func (s *Service) DeleteArchive(ctx context.Context, userID, bookmarkID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin archive delete: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockUser(ctx, tx, userID); err != nil {
		return err
	}
	var archiveStatus string
	var assetID *string
	err = tx.QueryRow(ctx, `
		SELECT s.archive_status, a.id
		FROM bookmark_snapshots s
		LEFT JOIN snapshot_assets a ON a.bookmark_id = s.bookmark_id AND a.type = 'archive'
		WHERE s.user_id = $1 AND s.bookmark_id = $2 AND s.status <> 'deleted'`,
		userID, bookmarkID).Scan(&archiveStatus, &assetID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && archiveStatus == "" && assetID == nil) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("find archive: %w", err)
	}
	ch := &change{userID: userID}
	seq, err := ch.bumpSeq(ctx, tx)
	if err != nil {
		return err
	}
	if assetID != nil {
		if _, err := tx.Exec(ctx, `DELETE FROM snapshot_assets WHERE id = $1`, *assetID); err != nil {
			return fmt.Errorf("delete archive asset: %w", err)
		}
		ch.keys = []string{AssetKey(userID, *assetID)}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE bookmark_snapshots
		SET archive_status = '', archive_at = NULL, archive_error = '', archive_queued_at = NULL,
		    archive_enqueued_at = NULL, seq = $2, updated_at = $3
		WHERE bookmark_id = $1`, bookmarkID, seq, millis(s.now())); err != nil {
		return fmt.Errorf("clear archive: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit archive delete: %w", err)
	}
	s.effects.finish(ctx, ch)
	return nil
}

// reserveAttempts records up to n capture attempts for today and returns how
// many the daily limit allows. The caller holds the user's lock.
func (s *Service) reserveAttempts(ctx context.Context, tx pgx.Tx, userID string, n int) (int, error) {
	if s.maxAttempts <= 0 || n == 0 {
		return n, nil
	}
	day := s.now().UTC().Format(time.DateOnly)
	var used int
	err := tx.QueryRow(ctx, `SELECT attempts FROM snapshot_attempts WHERE user_id = $1 AND day = $2`, userID, day).Scan(&used)
	if err := ignoreNoRows(err); err != nil {
		return 0, fmt.Errorf("read snapshot attempts: %w", err)
	}
	granted := min(n, max(s.maxAttempts-used, 0))
	if granted == 0 {
		return 0, nil
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO snapshot_attempts (user_id, day, attempts) VALUES ($1, $2, $3)
		ON CONFLICT (user_id, day) DO UPDATE SET attempts = snapshot_attempts.attempts + EXCLUDED.attempts`,
		userID, day, granted); err != nil {
		return 0, fmt.Errorf("record snapshot attempts: %w", err)
	}
	return granted, nil
}

func uniqueIDs(ids []string) []string {
	seen := make(map[string]bool, len(ids))
	unique := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		unique = append(unique, id)
	}
	return unique
}

// RemoveGone deletes the user's snapshots whose bookmark was permanently
// deleted (is_trashed = 2) or now has a different URL.
func (s *Service) RemoveGone(ctx context.Context, userID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockUser(ctx, tx, userID); err != nil {
		return err
	}
	ch := &change{userID: userID}
	if err := removeGone(ctx, tx, ch, s.now()); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	s.effects.finish(ctx, ch)
	return nil
}

// removeGone is RemoveGone inside a transaction that holds the user's lock.
func removeGone(ctx context.Context, tx pgx.Tx, ch *change, now time.Time) error {
	rows, err := tx.Query(ctx, `
		SELECT s.bookmark_id
		FROM bookmark_snapshots s
		JOIN bookmarks b ON b.id = s.bookmark_id
		WHERE s.user_id = $1 AND s.status <> 'deleted' AND (b.is_trashed = 2 OR b.url <> s.url)`, ch.userID)
	if err != nil {
		return fmt.Errorf("find gone snapshots: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return fmt.Errorf("find gone snapshots: %w", err)
	}
	if len(ids) == 0 {
		return nil
	}
	seq, err := ch.bumpSeq(ctx, tx)
	if err != nil {
		return err
	}
	keys, err := deleteSnapshots(ctx, tx, ch.userID, ids, seq, millis(now))
	if err != nil {
		return err
	}
	ch.keys = append(ch.keys, keys...)
	ch.texts = append(ch.texts, ids...)
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/snapshots/ -v -run 'Request|Delete'
```

Expected: these tests pass: `TestRequestQueuesBookmarks`, `TestRequestSkips`, `TestRequestCountsPendingSnapshotAsQueued`, `TestRequestAllowsUpdateAfterTenMinutes`, `TestRequestNeedsStorage`, `TestRequestDailyLimit`, `TestRequestArchive`, `TestDeleteFreesSpace`, and `TestDeleteArchiveKeepsSnapshot`.

- [ ] **Step 5: Commit**

```bash
git add internal/snapshots/requests.go internal/snapshots/requests_test.go
git commit -m "feat(snapshots): add manual requests, archives, and deletion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- internal/snapshots/requests.go internal/snapshots/requests_test.go
```

---

### Task 7: Automatic triggers

**Files:**
- Create: `internal/snapshots/triggers.go`
- Test: `internal/snapshots/triggers_test.go`

**Interfaces:**
- Consumes: `candidate`, `queueCaptures`, `RemoveGone`, and `reserveAttempts` (Task 6).
- Produces:
  - `(*Service).AfterBookmarkWrites(ctx, userID string, bookmarkIDs []string)`. Task 12 calls it after sync pushes and REST writes. It logs its errors.
  - `(*Service).queueAutomatic(ctx, userID, bookmarkIDs, limit, reserve) error`, which the Task 9 backfill calls with nil IDs, 20 bookmarks, and a 0.2 reserve.
  - `maxAutoPerWrite = 50`.

- [ ] **Step 1: Write the failing tests**

The tests cover:
- the eligibility rules: archived, trashed, `chrome://`, already snapshotted, finally failed, and in an archived collection;
- the newest 50 of 60 new bookmarks;
- the automatic setting and full storage;
- a URL change, which deletes the old snapshot and queues the new URL;
- permanent deletion.

Create `internal/snapshots/triggers_test.go`:

```go
package snapshots

import (
	"slices"
	"testing"
)

func TestAfterBookmarkWritesQueuesNewBookmarks(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-new", "https://new.example.com")
	e.addBookmark("bm-archived", "https://archived.example.com")
	e.addBookmark("bm-trashed", "https://trashed.example.com")
	e.addBookmark("bm-tab", "chrome://settings")
	e.addBookmark("bm-has-snapshot", "https://has.example.com")
	e.addBookmark("bm-failed", "https://failed.example.com")
	e.exec(`UPDATE bookmarks SET is_archived = TRUE WHERE id = 'bm-archived'`)
	e.exec(`UPDATE bookmarks SET is_trashed = 1 WHERE id = 'bm-trashed'`)
	e.addReadySnapshot("bm-has-snapshot", "https://has.example.com", nil)
	e.exec(`INSERT INTO bookmark_snapshots (bookmark_id, user_id, url, status, failure_reason, updated_at)
	        VALUES ('bm-failed', $1, 'https://failed.example.com', 'failed', 'dns_error', 1)`, e.userID)
	e.collectionID = e.addCollection(e.userID, "archived-collection", true)
	e.addBookmark("bm-in-archived-collection", "https://inarchive.example.com")

	e.service.AfterBookmarkWrites(t.Context(), e.userID, []string{
		"bm-new", "bm-archived", "bm-trashed", "bm-tab", "bm-has-snapshot", "bm-failed", "bm-in-archived-collection",
	})
	if got := jobBookmarks(e.queue.take()); !slices.Equal(got, []string{"bm-new"}) {
		t.Fatalf("queued %v, want only bm-new", got)
	}
	if state := e.snapshot("bm-new"); state.status != StatusQueued || !state.pending {
		t.Fatalf("bm-new snapshot = %+v", state)
	}
}

func TestAfterBookmarkWritesQueuesAtMostFifty(t *testing.T) {
	e := newEnv(t, -1)
	ids := seqIDs("bm", 60)
	for _, id := range ids {
		e.addBookmark(id, "https://"+id+".example.com")
	}
	e.service.AfterBookmarkWrites(t.Context(), e.userID, ids)
	got := jobBookmarks(e.queue.take())
	if len(got) != 50 || got[0] != "bm-010" {
		t.Fatalf("queued %d bookmarks starting at %v, want the newest 50", len(got), got[:1])
	}
}

func TestAfterBookmarkWritesRespectsSettingAndSpace(t *testing.T) {
	t.Run("automatic snapshots off", func(t *testing.T) {
		e := newEnv(t, -1)
		e.addBookmark("bm-1", "https://one.example.com")
		e.exec(`UPDATE users SET snapshot_auto = FALSE`)
		e.service.AfterBookmarkWrites(t.Context(), e.userID, []string{"bm-1"})
		if jobs := e.queue.take(); len(jobs) != 0 {
			t.Fatalf("queued %+v with automatic snapshots off", jobs)
		}
	})
	t.Run("storage full", func(t *testing.T) {
		e := newEnv(t, 1)
		e.addBookmark("bm-1", "https://one.example.com")
		e.addBookmark("bm-2", "https://two.example.com")
		e.addReadySnapshot("bm-1", "https://one.example.com", map[string]int{AssetReader: 1 << 20})
		e.service.AfterBookmarkWrites(t.Context(), e.userID, []string{"bm-2"})
		if jobs := e.queue.take(); len(jobs) != 0 {
			t.Fatalf("queued %+v with storage full", jobs)
		}
	})
}

func TestAfterBookmarkWritesHandlesURLChangeAndPermanentDeletion(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-moved", "https://new.example.com")
	e.addBookmark("bm-purged", "https://purged.example.com")
	moved := e.addReadySnapshot("bm-moved", "https://old.example.com", map[string]int{AssetReader: 10})
	purged := e.addReadySnapshot("bm-purged", "https://purged.example.com", map[string]int{AssetReader: 10})
	e.exec(`UPDATE bookmarks SET is_trashed = 2 WHERE id = 'bm-purged'`)

	e.service.AfterBookmarkWrites(t.Context(), e.userID, []string{"bm-moved", "bm-purged"})

	if e.fileExists(moved[AssetReader]) || e.fileExists(purged[AssetReader]) {
		t.Fatal("files of the old snapshots are still stored")
	}
	if state := e.snapshot("bm-purged"); state.status != StatusDeleted {
		t.Fatalf("purged bookmark snapshot = %+v, want deleted", state)
	}
	if state := e.snapshot("bm-moved"); state.status != StatusQueued {
		t.Fatalf("moved bookmark snapshot = %+v, want queued again", state)
	}
	if got := jobBookmarks(e.queue.take()); !slices.Equal(got, []string{"bm-moved"}) {
		t.Fatalf("queued %v, want bm-moved", got)
	}
	var url string
	if err := e.db.QueryRow(t.Context(), `SELECT url FROM bookmark_snapshots WHERE bookmark_id = 'bm-moved'`).Scan(&url); err != nil || url != "https://new.example.com" {
		t.Fatalf("snapshot URL = %q, %v; want the new URL", url, err)
	}
	if n := e.count(`SELECT COUNT(*) FROM snapshot_assets`); n != 0 {
		t.Fatalf("%d assets left", n)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/snapshots/
```

Expected: the build fails with `e.service.AfterBookmarkWrites undefined (type *Service has no field or method AfterBookmarkWrites)`.

- [ ] **Step 3: Write the triggers**

`queueAutomatic` reads the candidates once without the lock, so users with nothing to capture cost one query and no call to billing. It then reads them again under the lock before queuing.

Create `internal/snapshots/triggers.go`:

```go
package snapshots

import (
	"context"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5"
)

// maxAutoPerWrite is the most new bookmarks one sync push or REST write enqueues.
const maxAutoPerWrite = 50

// AfterBookmarkWrites runs after a sync push or a REST write has committed
// changes to bookmarkIDs. It deletes snapshots whose bookmark was permanently
// deleted or now has another URL, and enqueues bookmarks that have no
// snapshot yet. Errors are logged: the write itself succeeded, and the
// backfill picks up what this misses.
func (s *Service) AfterBookmarkWrites(ctx context.Context, userID string, bookmarkIDs []string) {
	if err := s.RemoveGone(ctx, userID); err != nil {
		log.Printf("snapshots: remove gone snapshots of %s: %v", userID, err)
	}
	if len(bookmarkIDs) == 0 {
		return
	}
	if err := s.queueAutomatic(ctx, userID, bookmarkIDs, maxAutoPerWrite, 0); err != nil {
		log.Printf("snapshots: queue new bookmarks of %s: %v", userID, err)
	}
}

// autoCandidates lists active bookmarks without a snapshot, newest first,
// for users who keep automatic snapshots on. bookmarkIDs nil means all of
// the user's bookmarks.
func autoCandidates(ctx context.Context, q querier, userID string, bookmarkIDs []string, limit int) ([]candidate, error) {
	rows, err := q.Query(ctx, `
		SELECT b.id, b.url
		FROM bookmarks b
		JOIN users u ON u.id = b.user_id
		JOIN collections c ON c.id = b.collection_id AND c.user_id = b.user_id
		JOIN workspaces w ON w.id = c.workspace_id AND w.user_id = c.user_id
		LEFT JOIN bookmark_snapshots s ON s.bookmark_id = b.id
		WHERE b.user_id = $1 AND ($2::text[] IS NULL OR b.id = ANY($2))
		  AND u.snapshot_auto
		  AND b.deleted_at IS NULL AND b.is_trashed = 0 AND NOT b.is_archived
		  AND b.url ~* '^https?://'
		  AND c.deleted_at IS NULL AND c.archived_at IS NULL AND c.is_deleted = 0 AND w.is_deleted = 0
		  AND (s.bookmark_id IS NULL OR s.status = 'deleted')
		ORDER BY b.created_at DESC, b.id
		LIMIT $3`, userID, bookmarkIDs, limit)
	if err != nil {
		return nil, fmt.Errorf("find bookmarks to snapshot: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (candidate, error) {
		var c candidate
		err := row.Scan(&c.id, &c.url)
		return c, err
	})
}

// queueAutomatic enqueues up to limit bookmarks without a snapshot while the
// user's free space is above reserve (a fraction of the limit).
func (s *Service) queueAutomatic(ctx context.Context, userID string, bookmarkIDs []string, limit int, reserve float64) error {
	// Reading without the lock first skips users with nothing to capture
	// before asking billing for their limits.
	candidates, err := autoCandidates(ctx, s.db, userID, bookmarkIDs, limit)
	if err != nil || len(candidates) == 0 {
		return err
	}
	limits, err := s.limits.GetLimits(ctx, userID)
	if err != nil {
		return fmt.Errorf("snapshot limits: %w", err)
	}
	storage := storageLimit(limits)

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockUser(ctx, tx, userID); err != nil {
		return err
	}
	usage, err := storageUsage(ctx, tx, userID)
	if err != nil || !hasRoom(storage, usage, reserve) {
		return err
	}
	if candidates, err = autoCandidates(ctx, tx, userID, bookmarkIDs, limit); err != nil {
		return err
	}
	granted, err := s.reserveAttempts(ctx, tx, userID, len(candidates))
	if err != nil {
		return err
	}
	ch := &change{userID: userID}
	if err := queueCaptures(ctx, tx, ch, candidates[:granted], s.now(), false, storage); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	s.effects.finish(ctx, ch)
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/snapshots/ -v -run AfterBookmarkWrites
```

Expected: `TestAfterBookmarkWritesQueuesNewBookmarks`, `TestAfterBookmarkWritesQueuesAtMostFifty`, `TestAfterBookmarkWritesRespectsSettingAndSpace`, and `TestAfterBookmarkWritesHandlesURLChangeAndPermanentDeletion` pass.

- [ ] **Step 5: Commit**

```bash
git add internal/snapshots/triggers.go internal/snapshots/triggers_test.go
git commit -m "feat(snapshots): enqueue new bookmarks and drop stale snapshots after writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- internal/snapshots/triggers.go internal/snapshots/triggers_test.go
```

---

### Task 8: Worker

**Files:**
- Create: `internal/snapshots/text.go`, `internal/snapshots/worker.go`
- Test: `internal/snapshots/text_test.go`, `internal/snapshots/worker_test.go`

**Interfaces:**
- Consumes:
  - `capture.Result`, `capture.ArchiveResult`, `capture.Failure`, `capture.ErrArchivesDisabled`, and the reasons (C2-1);
  - `jobqueue.Job`;
  - Task 5's helpers.
- Produces:
  - `snapshots.Capturer` (`Capture` and `Archive`; `*capture.Capturer` implements it).
  - `snapshots.WorkerConfig{DB, Store, Capturer, Hub, Text}`, `NewWorker(cfg) *Worker`, and `(*Worker).Handle(ctx, job, lastAttempt) error`, which is a `jobqueue.Handler`.
  - `ReaderText(readerHTML []byte) string`, at most 50,000 characters.

- [ ] **Step 1: Write the failing tests**

The tests cover:
- a full page capture: files, rows, sync rows, and search text;
- replacement that keeps the archive;
- a failed update that keeps the ready snapshot and records the 404;
- retries and then the final failure;
- `unsupported`;
- stale jobs: an older generation, a URL change, and a snapshot deleted during the capture;
- `storage_full`;
- two concurrent saves near the limit, where exactly one is saved;
- an image file;
- archives, including a `too_large` update that keeps the old archive.

Create `internal/snapshots/text_test.go`:

```go
package snapshots

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestReaderTextCollapsesMarkup(t *testing.T) {
	got := ReaderText([]byte(`<h1>Title</h1><p>First   paragraph with <em>em</em>phasis.</p>
		<ul><li>One</li><li>Two &amp; three</li></ul><img src="x.png" alt="ignored">`))
	want := "Title First paragraph with emphasis. One Two & three"
	if got != want {
		t.Fatalf("ReaderText = %q, want %q", got, want)
	}
}

func TestReaderTextStopsAtLimit(t *testing.T) {
	if n := utf8.RuneCountInString(ReaderText([]byte("<p>" + strings.Repeat("é", 60_000) + "</p>"))); n != maxTextRunes {
		t.Fatalf("text has %d characters, want %d", n, maxTextRunes)
	}
	spaced := ReaderText([]byte("<p>" + strings.Repeat("ab ", 40_000) + "</p>"))
	if n := utf8.RuneCountInString(spaced); n > maxTextRunes || strings.HasSuffix(spaced, " ") {
		t.Fatalf("spaced text has %d characters ending in %q, want at most %d and no trailing space", n, spaced[len(spaced)-1:], maxTextRunes)
	}
}
```

Create `internal/snapshots/worker_test.go`:

```go
package snapshots

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots/capture"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
)

type fakeCapturer struct {
	mu      sync.Mutex
	result  *capture.Result
	archive *capture.ArchiveResult
	err     error
	calls   int
}

func (f *fakeCapturer) Capture(context.Context, string) (*capture.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.result, f.err
}

func (f *fakeCapturer) Archive(context.Context, string) (*capture.ArchiveResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.archive, f.err
}

func pageResult(size int) *capture.Result {
	return &capture.Result{
		Kind: capture.KindPage, FinalURL: "https://one.example.com/final", HTTPStatus: 200,
		Title: "Final title", Excerpt: "An excerpt",
		Reader:     &capture.File{Data: []byte("<p>Reader text</p>"), ContentType: "text/html; charset=utf-8"},
		Screenshot: &capture.File{Data: bytes.Repeat([]byte{1}, size), ContentType: "image/jpeg"},
		Cover:      &capture.File{Data: []byte("cover"), ContentType: "image/jpeg"},
	}
}

func (e *env) worker(capturer Capturer) *Worker {
	return NewWorker(WorkerConfig{DB: e.db, Store: e.store, Capturer: capturer, Hub: e.hub, Text: e.text})
}

// queueOne requests a snapshot of bookmarkID and returns its job.
func (e *env) queueOne(bookmarkID string) jobqueue.Job {
	e.t.Helper()
	e.exec(`UPDATE bookmark_snapshots SET manual_requested_at = NULL WHERE bookmark_id = $1`, bookmarkID)
	if _, err := e.service.Request(e.t.Context(), e.userID, []string{bookmarkID}); err != nil {
		e.t.Fatalf("Request: %v", err)
	}
	jobs := e.queue.take()
	if len(jobs) != 1 {
		e.t.Fatalf("queued %+v, want one job", jobs)
	}
	return jobs[0]
}

func (e *env) assetTypes(bookmarkID string) map[string]string {
	e.t.Helper()
	rows, err := e.db.Query(e.t.Context(), `SELECT type, id FROM snapshot_assets WHERE bookmark_id = $1`, bookmarkID)
	if err != nil {
		e.t.Fatalf("query assets: %v", err)
	}
	defer rows.Close()
	types := map[string]string{}
	for rows.Next() {
		var assetType, id string
		if err := rows.Scan(&assetType, &id); err != nil {
			e.t.Fatalf("scan asset: %v", err)
		}
		types[assetType] = id
	}
	return types
}

func TestWorkerSavesPageCapture(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	job := e.queueOne("bm-1")
	updates := e.subscribe()

	if err := e.worker(&fakeCapturer{result: pageResult(100)}).Handle(t.Context(), job, false); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	state := e.snapshot("bm-1")
	if state.status != StatusReady || state.pending || state.seq != expectBroadcast(t, updates) {
		t.Fatalf("snapshot = %+v", state)
	}
	assets := e.assetTypes("bm-1")
	if len(assets) != 3 || !e.fileExists(assets[AssetReader]) || !e.fileExists(assets[AssetScreenshot]) || !e.fileExists(assets[AssetCover]) {
		t.Fatalf("assets = %v", assets)
	}
	rows, err := e.service.Rows(t.Context(), e.userID, 0)
	if err != nil || len(rows) != 1 || rows[0].Title != "Final title" || rows[0].Kind != "page" || rows[0].CapturedAt == nil {
		t.Fatalf("rows = %+v, %v", rows, err)
	}
	if e.text.texts["bm-1"] != "Reader text" {
		t.Fatalf("indexed text = %q", e.text.texts["bm-1"])
	}
}

func TestWorkerReplacesFilesButKeepsArchive(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	old := e.addReadySnapshot("bm-1", "https://one.example.com", map[string]int{AssetReader: 10, AssetFile: 10, AssetArchive: 10})
	job := e.queueOne("bm-1")

	if err := e.worker(&fakeCapturer{result: pageResult(10)}).Handle(t.Context(), job, false); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if e.fileExists(old[AssetReader]) || e.fileExists(old[AssetFile]) || !e.fileExists(old[AssetArchive]) {
		t.Fatal("old reader and file must go and the archive must stay")
	}
	if assets := e.assetTypes("bm-1"); len(assets) != 4 || assets[AssetArchive] != old[AssetArchive] {
		t.Fatalf("assets = %v", assets)
	}
}

func TestWorkerKeepsReadySnapshotWhenUpdateFails(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	old := e.addReadySnapshot("bm-1", "https://one.example.com", map[string]int{AssetReader: 10})
	job := e.queueOne("bm-1")
	gone := &capture.Failure{Reason: capture.ReasonHTTPError, HTTPStatus: 404}

	if err := e.worker(&fakeCapturer{err: gone}).Handle(t.Context(), job, false); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	state := e.snapshot("bm-1")
	if state.status != StatusReady || state.failureReason != "http_error" || state.pending || !e.fileExists(old[AssetReader]) {
		t.Fatalf("snapshot = %+v", state)
	}
	rows, _ := e.service.Rows(t.Context(), e.userID, 0)
	if rows[0].FailureStatus != 404 || rows[0].FailedAt == nil {
		t.Fatalf("row = %+v, want the 404 recorded", rows[0])
	}
}

func TestWorkerRetriesThenRecordsFailure(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	job := e.queueOne("bm-1")
	busy := &capture.Failure{Reason: capture.ReasonTimeout, Retryable: true}
	worker := e.worker(&fakeCapturer{err: busy})

	if err := worker.Handle(t.Context(), job, false); !errors.Is(err, busy) {
		t.Fatalf("Handle = %v, want the failure back for a retry", err)
	}
	if state := e.snapshot("bm-1"); state.status != StatusQueued || !state.pending {
		t.Fatalf("snapshot after a retryable failure = %+v", state)
	}
	if err := worker.Handle(t.Context(), job, true); err != nil {
		t.Fatalf("last attempt: %v", err)
	}
	if state := e.snapshot("bm-1"); state.status != StatusFailed || state.failureReason != "timeout" || state.pending {
		t.Fatalf("snapshot after the last attempt = %+v", state)
	}
}

func TestWorkerMarksUnsupportedLinks(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com/movie.mp4")
	job := e.queueOne("bm-1")
	unsupported := &capture.Failure{Reason: capture.ReasonUnsupported, Detail: "video/mp4"}
	if err := e.worker(&fakeCapturer{err: unsupported}).Handle(t.Context(), job, false); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if state := e.snapshot("bm-1"); state.status != StatusUnsupported {
		t.Fatalf("snapshot = %+v", state)
	}
}

func TestWorkerDropsStaleJobs(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	job := e.queueOne("bm-1")
	capturer := &fakeCapturer{result: pageResult(10)}
	worker := e.worker(capturer)

	older := job
	older.Generation--
	if err := worker.Handle(t.Context(), older, false); err != nil {
		t.Fatalf("Handle of an older generation: %v", err)
	}
	e.exec(`UPDATE bookmarks SET url = 'https://moved.example.com' WHERE id = 'bm-1'`)
	if err := worker.Handle(t.Context(), job, false); err != nil {
		t.Fatalf("Handle after a URL change: %v", err)
	}
	if capturer.calls != 0 || len(e.assetTypes("bm-1")) != 0 {
		t.Fatalf("stale jobs captured %d times", capturer.calls)
	}
}

func TestWorkerDropsResultOfSnapshotDeletedMeanwhile(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	job := e.queueOne("bm-1")
	capturer := &deletingCapturer{env: e, result: pageResult(10)}
	if err := e.worker(capturer).Handle(t.Context(), job, false); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if state := e.snapshot("bm-1"); state.status != StatusDeleted || len(e.assetTypes("bm-1")) != 0 {
		t.Fatalf("snapshot = %+v", state)
	}
	if n := countFiles(t, e); n != 0 {
		t.Fatalf("%d files left behind", n)
	}
}

// deletingCapturer deletes the snapshot while the capture runs.
type deletingCapturer struct {
	env    *env
	result *capture.Result
}

func (d *deletingCapturer) Capture(ctx context.Context, _ string) (*capture.Result, error) {
	if err := d.env.service.Delete(ctx, d.env.userID, "bm-1"); err != nil {
		d.env.t.Errorf("Delete: %v", err)
	}
	return d.result, nil
}

func (d *deletingCapturer) Archive(context.Context, string) (*capture.ArchiveResult, error) {
	return nil, errors.New("unused")
}

func countFiles(t *testing.T, e *env) int {
	t.Helper()
	n := 0
	if err := e.store.List(t.Context(), "snapshots/", func(blobstore.Object) error { n++; return nil }); err != nil {
		t.Fatalf("List: %v", err)
	}
	return n
}

func TestWorkerChecksStorageBeforeSaving(t *testing.T) {
	e := newEnv(t, 1)
	e.addBookmark("bm-1", "https://one.example.com")
	job := e.queueOne("bm-1")
	if err := e.worker(&fakeCapturer{result: pageResult(2 << 20)}).Handle(t.Context(), job, false); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if state := e.snapshot("bm-1"); state.status != StatusFailed || state.failureReason != ReasonStorageFull {
		t.Fatalf("snapshot = %+v", state)
	}
	if n := countFiles(t, e); n != 0 {
		t.Fatalf("%d files left behind", n)
	}
}

func TestConcurrentSavesStayWithinQuota(t *testing.T) {
	e := newEnv(t, 1)
	e.addBookmark("bm-1", "https://one.example.com")
	e.addBookmark("bm-2", "https://two.example.com")
	jobs := []jobqueue.Job{e.queueOne("bm-1"), e.queueOne("bm-2")}
	worker := e.worker(&fakeCapturer{result: pageResult(600 << 10)})

	var wg sync.WaitGroup
	for _, job := range jobs {
		wg.Go(func() {
			if err := worker.Handle(context.Background(), job, false); err != nil {
				t.Errorf("Handle: %v", err)
			}
		})
	}
	wg.Wait()
	states := []snapshotState{e.snapshot("bm-1"), e.snapshot("bm-2")}
	ready, full := 0, 0
	for _, state := range states {
		switch {
		case state.status == StatusReady:
			ready++
		case state.failureReason == ReasonStorageFull:
			full++
		}
	}
	if ready != 1 || full != 1 {
		t.Fatalf("snapshots = %+v, want one saved and one storage_full", states)
	}
}

func TestWorkerSavesImageFile(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com/photo.png")
	job := e.queueOne("bm-1")
	image := &capture.Result{Kind: capture.KindImage, HTTPStatus: 200, File: &capture.File{Data: []byte("png"), ContentType: "image/png"}}
	if err := e.worker(&fakeCapturer{result: image}).Handle(t.Context(), job, false); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	rows, err := e.service.Rows(t.Context(), e.userID, 0)
	if err != nil || rows[0].Kind != "image" || rows[0].FileURL == "" || rows[0].ReaderURL != "" {
		t.Fatalf("rows = %+v, %v", rows, err)
	}
	if !e.text.wasDeleted("bm-1") {
		t.Fatal("a snapshot without a reader version must clear its search text")
	}
}

func TestWorkerSavesArchive(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	e.addReadySnapshot("bm-1", "https://one.example.com", map[string]int{AssetReader: 10})
	if err := e.service.RequestArchive(t.Context(), e.userID, "bm-1"); err != nil {
		t.Fatalf("RequestArchive: %v", err)
	}
	job := e.queue.take()[0]
	archive := &capture.ArchiveResult{FinalURL: "https://one.example.com", Archive: capture.File{Data: []byte("<html>"), ContentType: "text/html; charset=utf-8"}}
	if err := e.worker(&fakeCapturer{archive: archive}).Handle(t.Context(), job, false); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if state := e.snapshot("bm-1"); state.archiveStatus != "ready" || state.archivePending {
		t.Fatalf("snapshot = %+v", state)
	}
	first := e.assetTypes("bm-1")[AssetArchive]

	e.exec(`UPDATE bookmark_snapshots SET archive_queued_at = NULL`)
	if err := e.service.RequestArchive(t.Context(), e.userID, "bm-1"); err != nil {
		t.Fatalf("second RequestArchive: %v", err)
	}
	job = e.queue.take()[0]
	tooLarge := &capture.Failure{Reason: capture.ReasonTooLarge, Detail: "archive"}
	if err := e.worker(&fakeCapturer{err: tooLarge}).Handle(t.Context(), job, false); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	rows, _ := e.service.Rows(t.Context(), e.userID, 0)
	if rows[0].ArchiveStatus != "ready" || rows[0].ArchiveError != "too_large" || e.assetTypes("bm-1")[AssetArchive] != first {
		t.Fatalf("row = %+v, want the first archive kept with the too_large error", rows[0])
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/snapshots/
```

Expected: the build fails with `undefined: Capturer`, `undefined: Worker`, and `undefined: NewWorker`.

- [ ] **Step 3: Write the reader text**

Create `internal/snapshots/text.go`:

```go
package snapshots

import (
	"bytes"
	"strings"
	"unicode"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// maxTextRunes caps the snapshot text sent to the search index.
const maxTextRunes = 50_000

// blockElements end a run of text, so their words do not run together.
var blockElements = map[atom.Atom]bool{
	atom.Address: true, atom.Article: true, atom.Aside: true, atom.Blockquote: true, atom.Br: true,
	atom.Dd: true, atom.Div: true, atom.Dl: true, atom.Dt: true, atom.Figcaption: true, atom.Figure: true,
	atom.Footer: true, atom.H1: true, atom.H2: true, atom.H3: true, atom.H4: true, atom.H5: true, atom.H6: true,
	atom.Header: true, atom.Hr: true, atom.Li: true, atom.Main: true, atom.Nav: true, atom.Ol: true, atom.P: true,
	atom.Pre: true, atom.Section: true, atom.Table: true, atom.Td: true, atom.Th: true, atom.Tr: true, atom.Ul: true,
}

// ReaderText returns the plain text of a reader version for the search
// index, with whitespace collapsed and at most 50,000 characters.
func ReaderText(readerHTML []byte) string {
	tokenizer := html.NewTokenizer(bytes.NewReader(readerHTML))
	var text strings.Builder
	runes := 0
	gap := false
	for {
		switch tokenizer.Next() {
		case html.ErrorToken:
			return text.String()
		case html.StartTagToken, html.EndTagToken, html.SelfClosingTagToken:
			name, _ := tokenizer.TagName()
			if blockElements[atom.Lookup(name)] {
				gap = true
			}
		case html.TextToken:
			for _, r := range string(tokenizer.Text()) {
				if unicode.IsSpace(r) {
					gap = true
					continue
				}
				if gap && runes > 0 {
					if runes+2 > maxTextRunes {
						return text.String()
					}
					text.WriteByte(' ')
					runes++
				}
				gap = false
				text.WriteRune(r)
				runes++
				if runes == maxTextRunes {
					return text.String()
				}
			}
		}
	}
}
```

- [ ] **Step 4: Write the worker**

How a job runs:
- **Checking.** A job runs only while it is current: its generation is the snapshot's, the snapshot waits for it, and the bookmark still exists with the same URL. The worker checks this before capturing and again under the user's lock before saving.
- **Saving.**
  - The worker writes the new files first.
  - In one transaction it re-checks `usage - replaced files + new files` against `job.StorageLimit`, swaps the asset rows, and updates the snapshot row.
  - After the commit it deletes the old files.
  - When the files do not fit, it rolls back, deletes the new files, and records `storage_full`. It rolls back first, so that recording the failure can take the lock.
- **Failures.** A retryable failure goes back to the queue until the last attempt; any other failure is recorded at once. A failed update keeps a ready snapshot `ready`.

Create `internal/snapshots/worker.go`:

```go
package snapshots

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"
	"unicode/utf8"

	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots/capture"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Lengths kept of a page's reader title and excerpt.
const (
	maxTitleRunes   = 1000
	maxExcerptRunes = 2000
)

// Capturer takes snapshots; *capture.Capturer implements it.
type Capturer interface {
	Capture(ctx context.Context, rawURL string) (*capture.Result, error)
	Archive(ctx context.Context, rawURL string) (*capture.ArchiveResult, error)
}

// WorkerConfig wires a Worker.
type WorkerConfig struct {
	DB       *db.DB
	Store    blobstore.Store
	Capturer Capturer
	Hub      pubsub.Hub
	// Text is nil when MeiliSearch is not configured.
	Text TextIndex
}

// Worker runs snapshot jobs in cmd/fetcher.
type Worker struct {
	db       *db.DB
	store    blobstore.Store
	capturer Capturer
	text     TextIndex
	effects  effects
	now      func() time.Time
}

// NewWorker returns a Worker.
func NewWorker(cfg WorkerConfig) *Worker {
	return &Worker{
		db:       cfg.DB,
		store:    cfg.Store,
		capturer: cfg.Capturer,
		text:     cfg.Text,
		effects:  effects{store: cfg.Store, text: cfg.Text, hub: cfg.Hub},
		now:      time.Now,
	}
}

// pendingCaptureSQL finds the URL of a capture job that is still current:
// its generation is the snapshot's, the snapshot waits for it, and the
// bookmark still exists with the same URL.
const pendingCaptureSQL = `
	SELECT s.url FROM bookmark_snapshots s JOIN bookmarks b ON b.id = s.bookmark_id
	WHERE s.bookmark_id = $1 AND s.user_id = $2 AND s.generation = $3 AND s.queued_at IS NOT NULL
	  AND b.is_trashed < 2 AND b.url = s.url`

// pendingArchiveSQL is pendingCaptureSQL for full-page archives.
const pendingArchiveSQL = `
	SELECT s.url FROM bookmark_snapshots s JOIN bookmarks b ON b.id = s.bookmark_id
	WHERE s.bookmark_id = $1 AND s.user_id = $2 AND s.archive_generation = $3 AND s.archive_queued_at IS NOT NULL
	  AND s.status = 'ready' AND b.is_trashed < 2 AND b.url = s.url`

// Handle runs one job; it is a jobqueue.Handler. A stale job is dropped.
func (w *Worker) Handle(ctx context.Context, job jobqueue.Job, lastAttempt bool) error {
	switch job.Kind {
	case jobqueue.KindCapture:
		return w.capture(ctx, job, lastAttempt)
	case jobqueue.KindArchive:
		return w.archive(ctx, job, lastAttempt)
	default:
		log.Printf("snapshots: dropping job of unknown kind %q", job.Kind)
		return nil
	}
}

func pendingURL(ctx context.Context, q querier, query string, job jobqueue.Job) (string, bool, error) {
	var url string
	err := q.QueryRow(ctx, query, job.BookmarkID, job.UserID, job.Generation).Scan(&url)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("load job %s: %w", job.Key(), err)
	}
	return url, true, nil
}

func (w *Worker) capture(ctx context.Context, job jobqueue.Job, lastAttempt bool) error {
	url, ok, err := pendingURL(ctx, w.db, pendingCaptureSQL, job)
	if err != nil || !ok {
		return err
	}
	result, err := w.capturer.Capture(ctx, url)
	if err != nil {
		failure := asFailure(err)
		if failure.Retryable && !lastAttempt {
			return err
		}
		return w.recordFailure(ctx, job, string(failure.Reason), failure.HTTPStatus)
	}
	return w.saveCapture(ctx, job, result)
}

func (w *Worker) archive(ctx context.Context, job jobqueue.Job, lastAttempt bool) error {
	url, ok, err := pendingURL(ctx, w.db, pendingArchiveSQL, job)
	if err != nil || !ok {
		return err
	}
	result, err := w.capturer.Archive(ctx, url)
	if err != nil {
		failure := asFailure(err)
		if failure.Retryable && !lastAttempt {
			return err
		}
		return w.recordArchiveFailure(ctx, job, string(failure.Reason))
	}
	return w.saveArchive(ctx, job, result)
}

// asFailure reads the reason of a capture error. Capturer errors are
// *capture.Failure values, except that a worker without monolith reports
// capture.ErrArchivesDisabled.
func asFailure(err error) *capture.Failure {
	var failure *capture.Failure
	switch {
	case errors.As(err, &failure):
		return failure
	case errors.Is(err, capture.ErrArchivesDisabled):
		return &capture.Failure{Reason: capture.ReasonUnsupported, Detail: "full-page archives are off", Err: err}
	default:
		return &capture.Failure{Reason: capture.ReasonRenderError, Err: err}
	}
}

type newAsset struct {
	id        string
	assetType string
	file      *capture.File
}

// putFiles writes files to storage under new asset IDs. On error it removes
// what it wrote and returns the error, so the queue retries the job.
func (w *Worker) putFiles(ctx context.Context, userID string, assets []newAsset) error {
	for i := range assets {
		assets[i].id = uuid.NewString()
		if err := w.store.Put(ctx, AssetKey(userID, assets[i].id), assets[i].file.Data); err != nil {
			w.removeFiles(ctx, userID, assets[:i])
			return fmt.Errorf("store snapshot file: %w", err)
		}
	}
	return nil
}

func (w *Worker) removeFiles(ctx context.Context, userID string, assets []newAsset) {
	ctx = context.WithoutCancel(ctx)
	for _, asset := range assets {
		if err := w.store.Delete(ctx, AssetKey(userID, asset.id)); err != nil {
			log.Printf("snapshots: remove unused file %s: %v", asset.id, err)
		}
	}
}

// replaceAssets swaps the bookmark's assets of the given types for the new
// ones inside tx. It reports false, without changing anything, when the new
// files would take the user over job.StorageLimit.
func replaceAssets(ctx context.Context, tx pgx.Tx, ch *change, job jobqueue.Job, types []string, assets []newAsset, now int64) (bool, error) {
	if job.StorageLimit >= 0 {
		usage, err := storageUsage(ctx, tx, job.UserID)
		if err != nil {
			return false, err
		}
		var replaced int64
		if err := tx.QueryRow(ctx,
			`SELECT COALESCE(SUM(size), 0)::BIGINT FROM snapshot_assets WHERE bookmark_id = $1 AND type = ANY($2)`,
			job.BookmarkID, types).Scan(&replaced); err != nil {
			return false, fmt.Errorf("size of replaced files: %w", err)
		}
		added := int64(0)
		for _, asset := range assets {
			added += int64(len(asset.file.Data))
		}
		if usage-replaced+added > job.StorageLimit {
			return false, nil
		}
	}
	rows, err := tx.Query(ctx,
		`DELETE FROM snapshot_assets WHERE bookmark_id = $1 AND type = ANY($2) RETURNING id`, job.BookmarkID, types)
	if err != nil {
		return false, fmt.Errorf("delete replaced assets: %w", err)
	}
	oldIDs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return false, fmt.Errorf("delete replaced assets: %w", err)
	}
	for _, id := range oldIDs {
		ch.keys = append(ch.keys, AssetKey(job.UserID, id))
	}
	for _, asset := range assets {
		if _, err := tx.Exec(ctx, `
			INSERT INTO snapshot_assets (id, user_id, bookmark_id, type, content_type, size, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			asset.id, job.UserID, job.BookmarkID, asset.assetType, asset.file.ContentType, len(asset.file.Data), now); err != nil {
			return false, fmt.Errorf("insert asset: %w", err)
		}
	}
	return true, nil
}

func (w *Worker) saveCapture(ctx context.Context, job jobqueue.Job, result *capture.Result) error {
	var assets []newAsset
	for _, item := range []newAsset{
		{assetType: AssetReader, file: result.Reader},
		{assetType: AssetScreenshot, file: result.Screenshot},
		{assetType: AssetCover, file: result.Cover},
		{assetType: AssetFile, file: result.File},
	} {
		if item.file != nil {
			assets = append(assets, item)
		}
	}
	if err := w.putFiles(ctx, job.UserID, assets); err != nil {
		return err
	}

	tx, err := w.db.Begin(ctx)
	if err != nil {
		w.removeFiles(ctx, job.UserID, assets)
		return fmt.Errorf("begin save: %w", err)
	}
	defer tx.Rollback(ctx)
	saved, err := w.applyCapture(ctx, tx, job, result, assets)
	if err == nil && saved != nil {
		err = tx.Commit(ctx)
	}
	if err != nil || saved == nil {
		_ = tx.Rollback(ctx)
		w.removeFiles(ctx, job.UserID, assets)
		if errors.Is(err, errStorageFull) {
			return w.recordFailure(ctx, job, ReasonStorageFull, 0)
		}
		return err
	}
	w.effects.finish(ctx, saved)
	if w.text != nil {
		if result.Reader != nil {
			w.text.UpsertSnapshotText(job.BookmarkID, job.UserID, ReaderText(result.Reader.Data))
		} else {
			w.text.DeleteSnapshotTexts([]string{job.BookmarkID})
		}
	}
	return nil
}

var errStorageFull = errors.New("snapshot does not fit in storage")

// applyCapture records a successful capture in tx. It returns nil, nil for
// a job that is no longer current.
func (w *Worker) applyCapture(ctx context.Context, tx pgx.Tx, job jobqueue.Job, result *capture.Result, assets []newAsset) (*change, error) {
	if err := lockUser(ctx, tx, job.UserID); err != nil {
		return nil, err
	}
	if _, ok, err := pendingURL(ctx, tx, pendingCaptureSQL, job); err != nil || !ok {
		return nil, err
	}
	ch := &change{userID: job.UserID}
	now := millis(w.now())
	fits, err := replaceAssets(ctx, tx, ch, job, []string{AssetReader, AssetScreenshot, AssetCover, AssetFile}, assets, now)
	if err != nil {
		return nil, err
	}
	if !fits {
		return nil, errStorageFull
	}
	seq, err := ch.bumpSeq(ctx, tx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE bookmark_snapshots
		SET status = 'ready', kind = $2, captured_at = $3, http_status = $4, final_url = $5, title = $6,
		    excerpt = $7, failure_reason = '', failure_status = 0, failed_at = NULL,
		    queued_at = NULL, enqueued_at = NULL, seq = $8, updated_at = $3
		WHERE bookmark_id = $1`,
		job.BookmarkID, string(result.Kind), now, result.HTTPStatus, result.FinalURL,
		truncateRunes(result.Title, maxTitleRunes), truncateRunes(result.Excerpt, maxExcerptRunes), seq); err != nil {
		return nil, fmt.Errorf("save snapshot: %w", err)
	}
	return ch, nil
}

func (w *Worker) saveArchive(ctx context.Context, job jobqueue.Job, result *capture.ArchiveResult) error {
	assets := []newAsset{{assetType: AssetArchive, file: &result.Archive}}
	if err := w.putFiles(ctx, job.UserID, assets); err != nil {
		return err
	}
	tx, err := w.db.Begin(ctx)
	if err != nil {
		w.removeFiles(ctx, job.UserID, assets)
		return fmt.Errorf("begin save: %w", err)
	}
	defer tx.Rollback(ctx)
	saved, err := w.applyArchive(ctx, tx, job, assets)
	if err == nil && saved != nil {
		err = tx.Commit(ctx)
	}
	if err != nil || saved == nil {
		_ = tx.Rollback(ctx)
		w.removeFiles(ctx, job.UserID, assets)
		if errors.Is(err, errStorageFull) {
			return w.recordArchiveFailure(ctx, job, ReasonStorageFull)
		}
		return err
	}
	w.effects.finish(ctx, saved)
	return nil
}

func (w *Worker) applyArchive(ctx context.Context, tx pgx.Tx, job jobqueue.Job, assets []newAsset) (*change, error) {
	if err := lockUser(ctx, tx, job.UserID); err != nil {
		return nil, err
	}
	if _, ok, err := pendingURL(ctx, tx, pendingArchiveSQL, job); err != nil || !ok {
		return nil, err
	}
	ch := &change{userID: job.UserID}
	now := millis(w.now())
	fits, err := replaceAssets(ctx, tx, ch, job, []string{AssetArchive}, assets, now)
	if err != nil {
		return nil, err
	}
	if !fits {
		return nil, errStorageFull
	}
	seq, err := ch.bumpSeq(ctx, tx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE bookmark_snapshots
		SET archive_status = 'ready', archive_at = $2, archive_error = '', archive_queued_at = NULL,
		    archive_enqueued_at = NULL, seq = $3, updated_at = $2
		WHERE bookmark_id = $1`, job.BookmarkID, now, seq); err != nil {
		return nil, fmt.Errorf("save archive: %w", err)
	}
	return ch, nil
}

// recordFailure ends a capture job without a new snapshot. A ready snapshot
// stays ready and only records the failure.
func (w *Worker) recordFailure(ctx context.Context, job jobqueue.Job, reason string, httpStatus int) error {
	return w.finishJob(ctx, job, pendingCaptureSQL, func(tx pgx.Tx, seq, now int64) error {
		_, err := tx.Exec(ctx, `
			UPDATE bookmark_snapshots
			SET status = CASE WHEN status = 'ready' THEN 'ready' WHEN $2 = 'unsupported' THEN 'unsupported' ELSE 'failed' END,
			    failure_reason = $2, failure_status = $3, failed_at = $4, queued_at = NULL, enqueued_at = NULL,
			    seq = $5, updated_at = $4
			WHERE bookmark_id = $1`, job.BookmarkID, reason, httpStatus, now, seq)
		return err
	})
}

// recordArchiveFailure ends an archive job without a new archive; an
// existing archive stays.
func (w *Worker) recordArchiveFailure(ctx context.Context, job jobqueue.Job, reason string) error {
	return w.finishJob(ctx, job, pendingArchiveSQL, func(tx pgx.Tx, seq, now int64) error {
		_, err := tx.Exec(ctx, `
			UPDATE bookmark_snapshots
			SET archive_status = CASE WHEN archive_status = 'ready' THEN 'ready' ELSE 'failed' END,
			    archive_error = $2, archive_queued_at = NULL, archive_enqueued_at = NULL, seq = $3, updated_at = $4
			WHERE bookmark_id = $1`, job.BookmarkID, reason, seq, now)
		return err
	})
}

// finishJob runs update in a transaction if the job is still current.
func (w *Worker) finishJob(ctx context.Context, job jobqueue.Job, pendingSQL string, update func(tx pgx.Tx, seq, now int64) error) error {
	tx, err := w.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockUser(ctx, tx, job.UserID); err != nil {
		return err
	}
	if _, ok, err := pendingURL(ctx, tx, pendingSQL, job); err != nil || !ok {
		return err
	}
	ch := &change{userID: job.UserID}
	seq, err := ch.bumpSeq(ctx, tx)
	if err != nil {
		return err
	}
	if err := update(tx, seq, millis(w.now())); err != nil {
		return fmt.Errorf("record job result: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	w.effects.finish(ctx, ch)
	return nil
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 -race ./internal/snapshots/ -v -run 'Worker|Concurrent|ReaderText'
```

Expected: the race detector stays quiet, and all thirteen tests pass:
- `TestReaderTextCollapsesMarkup`, `TestReaderTextStopsAtLimit`;
- `TestWorkerSavesPageCapture`, `TestWorkerReplacesFilesButKeepsArchive`, `TestWorkerKeepsReadySnapshotWhenUpdateFails`, `TestWorkerRetriesThenRecordsFailure`;
- `TestWorkerMarksUnsupportedLinks`, `TestWorkerDropsStaleJobs`, `TestWorkerDropsResultOfSnapshotDeletedMeanwhile`, `TestWorkerChecksStorageBeforeSaving`;
- `TestConcurrentSavesStayWithinQuota`, `TestWorkerSavesImageFile`, `TestWorkerSavesArchive`.

- [ ] **Step 6: Check that the concurrency test needs the lock**

Remove the `lockUser` call at the top of `applyCapture` in `worker.go` and run `go test -p 1 -count=3 ./internal/snapshots/ -run TestConcurrentSavesStayWithinQuota` with `TEST_DATABASE_URL` set. Expected: it fails, because both saves see the usage before the other one. Restore the call (`git diff internal/snapshots/worker.go` shows nothing once restored).

- [ ] **Step 7: Commit**

```bash
git add internal/snapshots/text.go internal/snapshots/text_test.go internal/snapshots/worker.go internal/snapshots/worker_test.go
git commit -m "feat(snapshots): add the snapshot worker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- internal/snapshots/text.go \
  internal/snapshots/text_test.go internal/snapshots/worker.go internal/snapshots/worker_test.go
```

---

### Task 9: Scheduler and garbage collection

**Files:**
- Create: `internal/snapshots/scheduler.go`
- Test: `internal/snapshots/scheduler_test.go`

**Interfaces:**
- Consumes: `queueAutomatic` (Task 7), `RemoveGone` (Task 6), `effects` (Task 5), and `env.queueOne` (Task 8's tests).
- Produces:
  - `(*Service).RunScheduler(ctx)`, which runs `Tick` every 5 minutes.
  - `(*Service).Tick(ctx) error`. It expires jobs after 24 hours, enqueues again those without a result after 15 minutes, and runs the backfill, all under a session-level advisory lock.
  - `(*Service).RemoveGoneEverywhere(ctx) error` and `(*Service).CollectGarbage(ctx) error`, which Task 12's daily cleanup calls.

- [ ] **Step 1: Write the failing tests**

The tests cover:
- expiry for a new snapshot, an update, and an archive;
- a re-enqueue with the same generation that happens only once in 15 minutes;
- the backfill: the newest 20, active users only, and the 20% reserve;
- the lock held by another instance;
- garbage collection of old unreferenced files and old attempt counts;
- `RemoveGoneEverywhere`.

Create `internal/snapshots/scheduler_test.go`:

```go
package snapshots

import (
	"slices"
	"testing"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
)

func TestTickExpiresJobsAfterADay(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-new", "https://new.example.com")
	e.addBookmark("bm-update", "https://update.example.com")
	e.addReadySnapshot("bm-update", "https://update.example.com", map[string]int{AssetReader: 10})
	for _, id := range []string{"bm-new", "bm-update"} {
		e.queueOne(id)
	}
	e.exec(`UPDATE bookmark_snapshots SET archive_status = 'queued', archive_queued_at = $1, archive_enqueued_at = $1
	        WHERE bookmark_id = 'bm-update'`, time.Now().UnixMilli())
	e.service.now = func() time.Time { return time.Now().Add(25 * time.Hour) }

	if err := e.service.Tick(t.Context()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if state := e.snapshot("bm-new"); state.status != StatusFailed || state.failureReason != "timeout" || state.pending {
		t.Fatalf("new bookmark snapshot = %+v", state)
	}
	state := e.snapshot("bm-update")
	if state.status != StatusReady || state.failureReason != "timeout" || state.archiveStatus != "failed" || state.archivePending {
		t.Fatalf("updated snapshot = %+v", state)
	}
}

func TestTickEnqueuesJobsWithoutResultAgain(t *testing.T) {
	e := newEnv(t, 5)
	e.addBookmark("bm-1", "https://one.example.com")
	job := e.queueOne("bm-1")
	e.service.now = func() time.Time { return time.Now().Add(16 * time.Minute) }

	if err := e.service.Tick(t.Context()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	again := e.queue.take()
	if len(again) != 1 || again[0] != job {
		t.Fatalf("enqueued %+v, want the same job %+v", again, job)
	}
	if err := e.service.Tick(t.Context()); err != nil {
		t.Fatalf("second Tick: %v", err)
	}
	if jobs := e.queue.take(); len(jobs) != 0 {
		t.Fatalf("enqueued %+v again within 15 minutes", jobs)
	}
	if state := e.snapshot("bm-1"); state.status != StatusQueued || state.generation != job.Generation {
		t.Fatalf("snapshot = %+v", state)
	}
}

func TestTickBackfillsNewestBookmarks(t *testing.T) {
	e := newEnv(t, -1)
	ids := seqIDs("bm", 25)
	for _, id := range ids {
		e.addBookmark(id, "https://"+id+".example.com")
	}
	idle := e.addUser("idle@example.com")
	e.exec(`UPDATE users SET last_sync_at = $1 WHERE id = $2`, time.Now().Add(-31*24*time.Hour).Unix(), idle)
	e.addCollection(idle, "idle-collection", false)
	e.exec(`INSERT INTO bookmarks (id, user_id, collection_id, title, url) VALUES ('idle-bm', $1, 'idle-collection', 'T', 'https://idle.example.com')`, idle)

	if err := e.service.Tick(t.Context()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	got := jobBookmarks(e.queue.take())
	if !slices.Equal(got, ids[5:]) {
		t.Fatalf("backfill queued %v, want the newest 20 of the active user", got)
	}
}

func TestBackfillKeepsAReserveOfFreeSpace(t *testing.T) {
	for _, tc := range []struct {
		usedMB   int
		wantJobs int
	}{{usedMB: 7, wantJobs: 1}, {usedMB: 9, wantJobs: 0}} {
		e := newEnv(t, 10)
		e.addBookmark("bm-full", "https://full.example.com")
		e.addBookmark("bm-new", "https://new.example.com")
		e.addReadySnapshot("bm-full", "https://full.example.com", map[string]int{AssetScreenshot: tc.usedMB << 20})
		if err := e.service.Tick(t.Context()); err != nil {
			t.Fatalf("Tick: %v", err)
		}
		if jobs := e.queue.take(); len(jobs) != tc.wantJobs {
			t.Fatalf("with %d of 10 MB used the backfill queued %d jobs, want %d", tc.usedMB, len(jobs), tc.wantJobs)
		}
	}
}

func TestTickRunsOnOneInstanceAtATime(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	conn, err := e.db.Acquire(t.Context())
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(t.Context(), `SELECT pg_advisory_lock($1, $2)`, serverLockSpace, schedulerLockID); err != nil {
		t.Fatalf("lock: %v", err)
	}
	if err := e.service.Tick(t.Context()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if jobs := e.queue.take(); len(jobs) != 0 {
		t.Fatalf("Tick ran while another instance held the lock: %+v", jobs)
	}
	if _, err := conn.Exec(t.Context(), `SELECT pg_advisory_unlock($1, $2)`, serverLockSpace, schedulerLockID); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	if err := e.service.Tick(t.Context()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if jobs := e.queue.take(); len(jobs) != 1 || jobs[0].Kind != jobqueue.KindCapture {
		t.Fatalf("Tick after unlock queued %+v", jobs)
	}
}

func TestCollectGarbageRemovesOldUnreferencedFiles(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	kept := e.addReadySnapshot("bm-1", "https://one.example.com", map[string]int{AssetReader: 10})
	orphan := "99999999-9999-4999-8999-999999999999"
	if err := e.store.Put(t.Context(), AssetKey(e.userID, orphan), []byte("orphan")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	day := func(offset int) string { return time.Now().UTC().AddDate(0, 0, offset).Format(time.DateOnly) }
	e.exec(`INSERT INTO snapshot_attempts (user_id, day, attempts) VALUES ($1, $2, 1), ($1, $3, 1)`, e.userID, day(-3), day(0))

	if err := e.service.CollectGarbage(t.Context()); err != nil {
		t.Fatalf("CollectGarbage: %v", err)
	}
	if !e.fileExists(orphan) {
		t.Fatal("a file younger than an hour was deleted")
	}
	e.service.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if err := e.service.CollectGarbage(t.Context()); err != nil {
		t.Fatalf("CollectGarbage: %v", err)
	}
	if e.fileExists(orphan) || !e.fileExists(kept[AssetReader]) {
		t.Fatal("garbage collection must delete only the unreferenced file")
	}
	if n := e.count(`SELECT COUNT(*) FROM snapshot_attempts`); n != 1 {
		t.Fatalf("%d attempt rows left, want only today's", n)
	}
}

func TestRemoveGoneEverywhere(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	e.addReadySnapshot("bm-1", "https://one.example.com", map[string]int{AssetReader: 10})
	e.exec(`UPDATE bookmarks SET is_trashed = 2 WHERE id = 'bm-1'`)
	if err := e.service.RemoveGoneEverywhere(t.Context()); err != nil {
		t.Fatalf("RemoveGoneEverywhere: %v", err)
	}
	if state := e.snapshot("bm-1"); state.status != StatusDeleted {
		t.Fatalf("snapshot = %+v", state)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/snapshots/
```

Expected: the build fails with `e.service.Tick undefined (type *Service has no field or method Tick)`.

- [ ] **Step 3: Write the scheduler**

`Tick` holds `pg_try_advisory_lock` on one pooled connection and unlocks on the same connection before releasing it. `CollectGarbage` checks listed files against `snapshot_assets` in batches of 500 while it lists.

Create `internal/snapshots/scheduler.go`:

```go
package snapshots

import (
	"context"
	"errors"
	"fmt"
	"log"
	"path"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
	"github.com/jackc/pgx/v5"
)

const (
	schedulerInterval = 5 * time.Minute
	// requeueAfter is how long a job may go without a result before it is enqueued again.
	requeueAfter = 15 * time.Minute
	// expireAfter is how long a job may wait before it fails.
	expireAfter = 24 * time.Hour
	// requeueBatch caps the jobs one pass enqueues again.
	requeueBatch = 1000
	// The backfill enqueues up to backfillPerUser bookmarks per pass for each
	// user who synced within backfillActiveWithin, while more than
	// backfillReserve of their storage is free.
	backfillPerUser      = 20
	backfillActiveWithin = 30 * 24 * time.Hour
	backfillReserve      = 0.2
	// orphanGrace keeps files a worker may have written but not yet recorded.
	orphanGrace = time.Hour
	gcBatch     = 500
)

// RunScheduler does the periodic snapshot work every 5 minutes until ctx is
// cancelled.
func (s *Service) RunScheduler(ctx context.Context) {
	ticker := time.NewTicker(schedulerInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.Tick(ctx); err != nil {
				log.Printf("snapshots: scheduler: %v", err)
			}
		}
	}
}

// Tick fails jobs that waited a day, enqueues again jobs without a result
// after 15 minutes, and runs the backfill. With several API instances, a
// Postgres advisory lock lets only one run a pass at a time.
func (s *Service) Tick(ctx context.Context) error {
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Release()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1, $2)`, serverLockSpace, schedulerLockID).Scan(&locked); err != nil {
		return fmt.Errorf("lock scheduler: %w", err)
	}
	if !locked {
		return nil
	}
	defer func() {
		if _, err := conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1, $2)`, serverLockSpace, schedulerLockID); err != nil {
			log.Printf("snapshots: unlock scheduler: %v", err)
		}
	}()
	return errors.Join(s.expireStuck(ctx), s.requeueStuck(ctx), s.backfill(ctx))
}

func queryStrings(ctx context.Context, q querier, sql string, args ...any) ([]string, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// expireStuck fails jobs queued more than a day ago. They use no space.
func (s *Service) expireStuck(ctx context.Context) error {
	now := s.now()
	cutoff := millis(now.Add(-expireAfter))
	users, err := queryStrings(ctx, s.db,
		`SELECT DISTINCT user_id FROM bookmark_snapshots WHERE queued_at < $1 OR archive_queued_at < $1`, cutoff)
	if err != nil {
		return fmt.Errorf("find expired jobs: %w", err)
	}
	var errs []error
	for _, userID := range users {
		if err := s.expireUser(ctx, userID, cutoff, millis(now)); err != nil {
			errs = append(errs, fmt.Errorf("expire jobs of %s: %w", userID, err))
		}
	}
	return errors.Join(errs...)
}

func (s *Service) expireUser(ctx context.Context, userID string, cutoff, now int64) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockUser(ctx, tx, userID); err != nil {
		return err
	}
	ch := &change{userID: userID}
	seq, err := ch.bumpSeq(ctx, tx)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE bookmark_snapshots
		SET status = CASE WHEN status = 'ready' THEN 'ready' ELSE 'failed' END,
		    failure_reason = 'timeout', failure_status = 0, failed_at = $3,
		    queued_at = NULL, enqueued_at = NULL, seq = $4, updated_at = $3
		WHERE user_id = $1 AND queued_at < $2`, userID, cutoff, now, seq); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE bookmark_snapshots
		SET archive_status = CASE WHEN archive_status = 'ready' THEN 'ready' ELSE 'failed' END,
		    archive_error = 'timeout', archive_queued_at = NULL, archive_enqueued_at = NULL, seq = $4, updated_at = $3
		WHERE user_id = $1 AND archive_queued_at < $2`, userID, cutoff, now, seq); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.effects.finish(ctx, ch)
	return nil
}

// requeueStuck enqueues again, with the same generation, jobs that have had
// no result for 15 minutes, in case the queue lost them.
func (s *Service) requeueStuck(ctx context.Context) error {
	cutoff := millis(s.now().Add(-requeueAfter))
	rows, err := s.db.Query(ctx, `
		SELECT user_id, bookmark_id, 'capture', generation FROM bookmark_snapshots
		WHERE queued_at IS NOT NULL AND enqueued_at < $1
		UNION ALL
		SELECT user_id, bookmark_id, 'archive', archive_generation FROM bookmark_snapshots
		WHERE archive_queued_at IS NOT NULL AND archive_enqueued_at < $1
		LIMIT $2`, cutoff, requeueBatch)
	if err != nil {
		return fmt.Errorf("find jobs to enqueue again: %w", err)
	}
	jobs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (jobqueue.Job, error) {
		var job jobqueue.Job
		err := row.Scan(&job.UserID, &job.BookmarkID, &job.Kind, &job.Generation)
		return job, err
	})
	if err != nil {
		return fmt.Errorf("find jobs to enqueue again: %w", err)
	}
	limits := map[string]int64{}
	var errs []error
	for _, job := range jobs {
		limit, ok := limits[job.UserID]
		if !ok {
			userLimits, err := s.limits.GetLimits(ctx, job.UserID)
			if err != nil {
				errs = append(errs, fmt.Errorf("limits of %s: %w", job.UserID, err))
				continue
			}
			limit = storageLimit(userLimits)
			limits[job.UserID] = limit
		}
		job.StorageLimit = limit
		if err := s.effects.queue.Enqueue(ctx, job); err != nil {
			errs = append(errs, fmt.Errorf("enqueue %s again: %w", job.Key(), err))
			continue
		}
		update := `UPDATE bookmark_snapshots SET enqueued_at = $3 WHERE bookmark_id = $1 AND generation = $2`
		if job.Kind == jobqueue.KindArchive {
			update = `UPDATE bookmark_snapshots SET archive_enqueued_at = $3 WHERE bookmark_id = $1 AND archive_generation = $2`
		}
		if _, err := s.db.Exec(ctx, update, job.BookmarkID, job.Generation, millis(s.now())); err != nil {
			errs = append(errs, fmt.Errorf("record enqueue of %s: %w", job.Key(), err))
		}
	}
	return errors.Join(errs...)
}

// backfill enqueues the newest bookmarks without a snapshot for users who
// keep automatic snapshots on and synced recently.
func (s *Service) backfill(ctx context.Context) error {
	since := s.now().Add(-backfillActiveWithin).Unix()
	users, err := queryStrings(ctx, s.db, `
		SELECT id FROM users
		WHERE snapshot_auto AND is_verified AND suspended_at IS NULL AND deletion_requested_at IS NULL
		  AND last_sync_at >= $1
		ORDER BY id`, since)
	if err != nil {
		return fmt.Errorf("find backfill users: %w", err)
	}
	var errs []error
	for _, userID := range users {
		if err := s.queueAutomatic(ctx, userID, nil, backfillPerUser, backfillReserve); err != nil {
			errs = append(errs, fmt.Errorf("backfill %s: %w", userID, err))
		}
	}
	return errors.Join(errs...)
}

// RemoveGoneEverywhere runs RemoveGone for every user with snapshots of
// permanently deleted bookmarks. The daily trash cleanup calls it after
// moving expired trash to the permanently deleted state.
func (s *Service) RemoveGoneEverywhere(ctx context.Context) error {
	users, err := queryStrings(ctx, s.db, `
		SELECT DISTINCT s.user_id
		FROM bookmark_snapshots s
		JOIN bookmarks b ON b.id = s.bookmark_id
		WHERE s.status <> 'deleted' AND (b.is_trashed = 2 OR b.url <> s.url)`)
	if err != nil {
		return fmt.Errorf("find gone snapshots: %w", err)
	}
	var errs []error
	for _, userID := range users {
		if err := s.RemoveGone(ctx, userID); err != nil {
			errs = append(errs, fmt.Errorf("remove gone snapshots of %s: %w", userID, err))
		}
	}
	return errors.Join(errs...)
}

// CollectGarbage deletes stored files that no asset row references once
// they are an hour old, which covers files whose deletion failed and
// workers that stopped between writing a file and recording it. It also
// drops attempt counts from before yesterday.
func (s *Service) CollectGarbage(ctx context.Context) error {
	cutoff := s.now().Add(-orphanGrace)
	var batch []string
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		ids := make([]string, len(batch))
		for i, key := range batch {
			ids[i] = path.Base(key)
		}
		known, err := queryStrings(ctx, s.db, `SELECT id FROM snapshot_assets WHERE id = ANY($1)`, ids)
		if err != nil {
			return fmt.Errorf("look up stored files: %w", err)
		}
		referenced := make(map[string]bool, len(known))
		for _, id := range known {
			referenced[id] = true
		}
		for i, key := range batch {
			if referenced[ids[i]] {
				continue
			}
			if err := s.effects.store.Delete(ctx, key); err != nil {
				return err
			}
		}
		batch = batch[:0]
		return nil
	}
	err := s.effects.store.List(ctx, "snapshots/", func(object blobstore.Object) error {
		if !object.ModTime.Before(cutoff) {
			return nil
		}
		batch = append(batch, object.Key)
		if len(batch) < gcBatch {
			return nil
		}
		return flush()
	})
	if err == nil {
		err = flush()
	}
	if err != nil {
		return fmt.Errorf("delete unreferenced snapshot files: %w", err)
	}
	yesterday := s.now().UTC().AddDate(0, 0, -1).Format(time.DateOnly)
	if _, err := s.db.Exec(ctx, `DELETE FROM snapshot_attempts WHERE day < $1`, yesterday); err != nil {
		return fmt.Errorf("delete old snapshot attempts: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/snapshots/ -v -run 'Tick|Backfill|Garbage|Everywhere'
GOTOOLCHAIN=local go test -p 1 -count=1 -race ./internal/snapshots/...
```

Expected: `TestTickExpiresJobsAfterADay`, `TestTickEnqueuesJobsWithoutResultAgain`, `TestTickBackfillsNewestBookmarks`, `TestBackfillKeepsAReserveOfFreeSpace`, `TestTickRunsOnOneInstanceAtATime`, `TestCollectGarbageRemovesOldUnreferencedFiles`, and `TestRemoveGoneEverywhere` pass. Then the whole package passes with `-race`.

- [ ] **Step 5: Commit**

```bash
git add internal/snapshots/scheduler.go internal/snapshots/scheduler_test.go
git commit -m "feat(snapshots): add the backfill, stuck-job checks, and garbage collection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- internal/snapshots/scheduler.go internal/snapshots/scheduler_test.go
```

---

### Task 10: Snapshot text search

**Files:**
- Modify: `internal/search/client.go`, `internal/search/types.go`, `internal/handler/search.go` (rewritten)
- Create: `internal/snapshots/reindex.go`
- Test: `internal/search/snapshot_text_test.go`, `internal/handler/search_snapshot_test.go`, `internal/snapshots/reindex_test.go`

**Interfaces:**
- Consumes: `ReaderText` (Task 8) and `AssetKey` (Task 5).
- Produces:
  - `search.SnapshotTextDoc{ID, UserID, Content}` and `search.SnapshotTextHit{ID, Snippet}`.
  - Methods on `*search.Client`:
    - `UpsertSnapshotText(bookmarkID, userID, text)` and `DeleteSnapshotTexts([]string)`. Together they implement `snapshots.TextIndex`.
    - `BulkUpsertSnapshotTexts(docs) error`.
    - `SearchSnapshotTexts(userID, query) ([]SnapshotTextHit, error)`.
  - `DeleteUserDocumentsAsync` now clears both indexes.
  - `GET /search` results gain `snippet` for bookmarks that matched only in snapshot text.
  - `snapshots.EachReaderText(ctx, db, store, fn) error`, which Task 13's `cmd/reindex` uses.

- [ ] **Step 1: Write the failing tests**

`TestSearchSnapshotTextsReturnsSnippets` checks the request that MeiliSearch receives: the user filter, `attributesToRetrieve: ["id"]`, `attributesToCrop: ["content"]`, and `cropLength: 30`. MeiliSearch returns a cropped attribute in `_formatted` even when it is not retrieved, so the text never leaves MeiliSearch.

Create `internal/search/snapshot_text_test.go`:

```go
package search

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeMeili answers index setup and records the requests for one path.
func fakeMeili(t *testing.T, path string, response string) (*Client, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/tasks/") {
			_, _ = io.WriteString(w, `{"uid":1,"status":"succeeded","type":"indexCreation"}`)
			return
		}
		if r.URL.Path == path {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			bodies = append(bodies, body)
			mu.Unlock()
			_, _ = io.WriteString(w, response)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"taskUid":1,"status":"enqueued"}`)
	}))
	t.Cleanup(server.Close)
	return New(server.URL, ""), &bodies
}

func TestSearchSnapshotTextsReturnsSnippets(t *testing.T) {
	client, bodies := fakeMeili(t, "/indexes/snapshots/search", `{"hits":[
		{"id":"bm-1","_formatted":{"id":"bm-1","content":"…the quick brown fox…"}},
		{"id":"bm-2","_formatted":{"id":"bm-2","content":"fox in the text"}}],
		"query":"fox","limit":20,"offset":0,"estimatedTotalHits":2,"processingTimeMs":1}`)

	hits, err := client.SearchSnapshotTexts("user-1", "fox")
	if err != nil {
		t.Fatalf("SearchSnapshotTexts: %v", err)
	}
	want := []SnapshotTextHit{{ID: "bm-1", Snippet: "…the quick brown fox…"}, {ID: "bm-2", Snippet: "fox in the text"}}
	if len(hits) != 2 || hits[0] != want[0] || hits[1] != want[1] {
		t.Fatalf("hits = %+v, want %+v", hits, want)
	}
	request := (*bodies)[0]
	if request["filter"] != `userId = "user-1"` || request["cropLength"] != float64(30) ||
		request["attributesToCrop"].([]any)[0] != "content" || request["attributesToRetrieve"].([]any)[0] != "id" {
		t.Fatalf("search request = %v", request)
	}
}

func TestSnapshotTextMethodsAreNilSafe(t *testing.T) {
	var c *Client
	c.UpsertSnapshotText("bm-1", "user-1", "text")
	c.DeleteSnapshotTexts([]string{"bm-1"})
	if err := c.BulkUpsertSnapshotTexts([]SnapshotTextDoc{{ID: "bm-1"}}); err != nil {
		t.Fatalf("BulkUpsertSnapshotTexts on nil client: %v", err)
	}
	if hits, err := c.SearchSnapshotTexts("user-1", "fox"); err != nil || len(hits) != 0 {
		t.Fatalf("SearchSnapshotTexts on nil client = %v, %v", hits, err)
	}
}
```

Create `internal/handler/search_snapshot_test.go`:

```go
package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TabSlate-dev/TabSlate-server/internal/middleware"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/gin-gonic/gin"
)

// fixedTextSearcher returns fixed bookmark matches and snapshot text matches.
type fixedTextSearcher struct {
	fixedBookmarkSearcher
	hits []search.SnapshotTextHit
	err  error
}

func (s fixedTextSearcher) SearchSnapshotTexts(string, string) ([]search.SnapshotTextHit, error) {
	return s.hits, s.err
}

type searchResponse struct {
	Bookmarks []struct {
		ID      string `json:"id"`
		Title   string `json:"title"`
		URL     string `json:"url"`
		Snippet string `json:"snippet"`
	} `json:"bookmarks"`
}

func runSearch(t *testing.T, handler *SearchHandler, userID string) searchResponse {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	ginContext.Request = httptest.NewRequest(http.MethodGet, "/search?q=fox", nil)
	ginContext.Set(middleware.UserIDKey, userID)
	handler.Search(ginContext)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var response searchResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode search response: %v", err)
	}
	return response
}

func TestSearchAddsSnapshotTextMatches(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "search-snapshots@example.com", password: "password123"})
	insertNotesCollection(t, testDB, userID, "search-snapshot-workspace", "search-snapshot-collection")
	if _, err := testDB.Exec(t.Context(), `
		INSERT INTO bookmarks (id, user_id, collection_id, title, url, is_trashed, created_at, updated_at)
		VALUES ('by-title', $1, 'search-snapshot-collection', 'Fox facts', 'https://title.example.com', 0, 1, 1),
		       ('by-text', $1, 'search-snapshot-collection', 'Animals', 'https://text.example.com', 0, 1, 1),
		       ('trashed', $1, 'search-snapshot-collection', 'Trashed', 'https://trashed.example.com', 1, 1, 1)`, userID); err != nil {
		t.Fatalf("insert bookmarks: %v", err)
	}
	searcher := fixedTextSearcher{
		fixedBookmarkSearcher: fixedBookmarkSearcher{documents: []search.BookmarkDoc{{ID: "by-title", Title: "Fox facts"}}},
		hits: []search.SnapshotTextHit{
			{ID: "by-title", Snippet: "a fox"},
			{ID: "by-text", Snippet: "…the quick brown fox…"},
			{ID: "trashed", Snippet: "fox in the trash"},
		},
	}

	response := runSearch(t, NewSearchHandler(testDB, searcher), userID)
	if len(response.Bookmarks) != 2 {
		t.Fatalf("bookmarks = %+v, want the title match and the text match", response.Bookmarks)
	}
	first, second := response.Bookmarks[0], response.Bookmarks[1]
	if first.ID != "by-title" || first.Snippet != "" {
		t.Fatalf("first result = %+v, want the title match without a snippet", first)
	}
	if second.ID != "by-text" || second.Title != "Animals" || second.URL != "https://text.example.com" || second.Snippet != "…the quick brown fox…" {
		t.Fatalf("second result = %+v, want the text match with its fields and snippet", second)
	}
}

func TestSearchKeepsBookmarkMatchesWhenTextSearchFails(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "search-snapshots-down@example.com", password: "password123"})
	insertNotesCollection(t, testDB, userID, "search-down-workspace", "search-down-collection")
	if _, err := testDB.Exec(t.Context(), `
		INSERT INTO bookmarks (id, user_id, collection_id, title, url, created_at, updated_at)
		VALUES ('by-title', $1, 'search-down-collection', 'Fox facts', 'https://title.example.com', 1, 1)`, userID); err != nil {
		t.Fatalf("insert bookmark: %v", err)
	}
	searcher := fixedTextSearcher{
		fixedBookmarkSearcher: fixedBookmarkSearcher{documents: []search.BookmarkDoc{{ID: "by-title"}}},
		err:                   errors.New("snapshots index down"),
	}
	response := runSearch(t, NewSearchHandler(testDB, searcher), userID)
	if len(response.Bookmarks) != 1 || response.Bookmarks[0].ID != "by-title" {
		t.Fatalf("bookmarks = %+v, want the title match", response.Bookmarks)
	}
}
```

Create `internal/snapshots/reindex_test.go`:

```go
package snapshots

import (
	"testing"

	"github.com/google/uuid"
)

func TestEachReaderTextReadsStoredReaderVersions(t *testing.T) {
	e := newEnv(t, -1)
	e.addBookmark("bm-1", "https://one.example.com")
	e.addBookmark("bm-purged", "https://purged.example.com")
	e.addBookmark("bm-missing", "https://missing.example.com")
	e.addReadySnapshot("bm-1", "https://one.example.com", nil)
	reader := []byte("<p>Text of x</p>")
	for _, id := range []string{"bm-1", "bm-purged"} {
		assetID := uuid.NewString()
		e.exec(`INSERT INTO snapshot_assets (id, user_id, bookmark_id, type, content_type, size, created_at)
		        VALUES ($1, $2, $3, 'reader', 'text/html', $4, 1)`, assetID, e.userID, id, len(reader))
		if err := e.store.Put(t.Context(), AssetKey(e.userID, assetID), reader); err != nil {
			t.Fatalf("Put: %v", err)
		}
	}
	e.exec(`INSERT INTO snapshot_assets (id, user_id, bookmark_id, type, content_type, size, created_at)
	        VALUES ($1, $2, 'bm-missing', 'reader', 'text/html', 10, 1)`, uuid.NewString(), e.userID)
	e.exec(`UPDATE bookmarks SET is_trashed = 2 WHERE id = 'bm-purged'`)

	got := map[string]string{}
	err := EachReaderText(t.Context(), e.db, e.store, func(bookmarkID, userID, text string) error {
		if userID != e.userID {
			t.Errorf("user of %s = %s", bookmarkID, userID)
		}
		got[bookmarkID] = text
		return nil
	})
	if err != nil {
		t.Fatalf("EachReaderText: %v", err)
	}
	if len(got) != 1 || got["bm-1"] != "Text of x" {
		t.Fatalf("texts = %v, want only bm-1", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/search/ ./internal/handler/ ./internal/snapshots/
```

Expected: the three packages fail to build, for example with `client.SearchSnapshotTexts undefined (type *Client has no field or method SearchSnapshotTexts)`.

- [ ] **Step 3: Add the snapshots index to the search client**

In `internal/search/types.go`:

Append to the end of `internal/search/types.go`:

```go
// SnapshotTextDoc is the searchable text of a bookmark's snapshot, in the
// snapshots index. ID is the bookmark's ID.
type SnapshotTextDoc struct {
	ID      string `json:"id"`
	UserID  string `json:"userId"`
	Content string `json:"content"`
}

// SnapshotTextHit is a bookmark whose snapshot text matched a search, with
// about 30 words around the match.
type SnapshotTextHit struct {
	ID      string
	Snippet string
}
```

In `internal/search/client.go`:

Replace:

```go
const indexName = "bookmarks"

// Client wraps a MeiliSearch index. All methods are nil-safe —
// if the client is nil (search disabled), they are no-ops.
type Client struct {
	svc   meilisearch.ServiceManager
	index meilisearch.IndexManager
}

// New creates a Client. Returns nil when host is empty (search disabled).
```

with:

```go
const indexName = "bookmarks"

// textIndexName holds snapshot text. It is separate from the bookmark
// documents, which the API rewrites and deletes as bookmarks change, so that
// snapshot text survives those rewrites.
const textIndexName = "snapshots"

// Client wraps the MeiliSearch indexes. All methods are nil-safe —
// if the client is nil (search disabled), they are no-ops.
type Client struct {
	svc   meilisearch.ServiceManager
	index meilisearch.IndexManager
	texts meilisearch.IndexManager
}

// New creates a Client. Returns nil when host is empty (search disabled).
```

Replace:

```go
	c := &Client{
		svc:   svc,
		index: svc.Index(indexName),
	}
	c.initIndex()
	return c
}

// initIndex creates the index and waits for it to be ready, then applies
// settings. Waiting is necessary because MeiliSearch index creation is async —
// without it, the first AddDocuments call races against index creation and gets
// a 404. If the index already exists the wait is skipped.
func (c *Client) initIndex() {
	task, err := c.svc.CreateIndex(&meilisearch.IndexConfig{
		Uid:        indexName,
		PrimaryKey: "id",
	})
	if err != nil {
		// Index likely already exists — that's fine.
		log.Printf("[search] createIndex (may already exist): %v", err)
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := c.svc.WaitForTaskWithContext(ctx, task.TaskUID, 50*time.Millisecond); err != nil {
			log.Printf("[search] wait for createIndex task: %v", err)
		}
	}
	if _, err := c.index.UpdateSettings(&meilisearch.Settings{
		FilterableAttributes: []string{"userId"},
		SearchableAttributes: []string{"title", "url", "description", "notes"},
	}); err != nil {
		log.Printf("[search] updateSettings: %v", err)
	}
}
```

with:

```go
	c := &Client{
		svc:   svc,
		index: svc.Index(indexName),
		texts: svc.Index(textIndexName),
	}
	c.initIndex(indexName, c.index, &meilisearch.Settings{
		FilterableAttributes: []string{"userId"},
		SearchableAttributes: []string{"title", "url", "description", "notes"},
	})
	c.initIndex(textIndexName, c.texts, &meilisearch.Settings{
		FilterableAttributes: []string{"userId"},
		SearchableAttributes: []string{"content"},
	})
	return c
}

// initIndex creates an index and waits for it to be ready, then applies
// settings. Waiting is necessary because MeiliSearch index creation is async —
// without it, the first AddDocuments call races against index creation and gets
// a 404. If the index already exists the wait is skipped.
func (c *Client) initIndex(uid string, index meilisearch.IndexManager, settings *meilisearch.Settings) {
	task, err := c.svc.CreateIndex(&meilisearch.IndexConfig{
		Uid:        uid,
		PrimaryKey: "id",
	})
	if err != nil {
		// Index likely already exists — that's fine.
		log.Printf("[search] createIndex %s (may already exist): %v", uid, err)
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := c.svc.WaitForTaskWithContext(ctx, task.TaskUID, 50*time.Millisecond); err != nil {
			log.Printf("[search] wait for createIndex %s task: %v", uid, err)
		}
	}
	if _, err := index.UpdateSettings(settings); err != nil {
		log.Printf("[search] updateSettings %s: %v", uid, err)
	}
}
```

Replace:

```go
		if _, err := c.index.DeleteDocumentsByFilterWithContext(context.Background(), filter, nil); err != nil {
			log.Printf("[search] deleteUserDocuments %s: %v", userID, err)
		}
	}()
}

// SearchBookmarks queries the index filtered to a single user.
```

with:

```go
		if _, err := c.index.DeleteDocumentsByFilterWithContext(context.Background(), filter, nil); err != nil {
			log.Printf("[search] deleteUserDocuments %s: %v", userID, err)
		}
		if _, err := c.texts.DeleteDocumentsByFilterWithContext(context.Background(), filter, nil); err != nil {
			log.Printf("[search] deleteUserSnapshotTexts %s: %v", userID, err)
		}
	}()
}

// UpsertSnapshotText adds or replaces the snapshot text of a bookmark.
// Fire-and-forget goroutine.
func (c *Client) UpsertSnapshotText(bookmarkID, userID, text string) {
	if c == nil {
		return
	}
	go func() {
		pk := "id"
		doc := SnapshotTextDoc{ID: bookmarkID, UserID: userID, Content: text}
		if _, err := c.texts.AddDocuments([]SnapshotTextDoc{doc}, &meilisearch.DocumentOptions{PrimaryKey: &pk}); err != nil {
			log.Printf("[search] upsertSnapshotText %s: %v", bookmarkID, err)
		}
	}()
}

// DeleteSnapshotTexts removes the snapshot text of bookmarks.
// Fire-and-forget goroutine.
func (c *Client) DeleteSnapshotTexts(bookmarkIDs []string) {
	if c == nil || len(bookmarkIDs) == 0 {
		return
	}
	go func() {
		if _, err := c.texts.DeleteDocuments(bookmarkIDs, nil); err != nil {
			log.Printf("[search] deleteSnapshotTexts %d docs: %v", len(bookmarkIDs), err)
		}
	}()
}

// BulkUpsertSnapshotTexts adds or replaces snapshot texts synchronously.
// Used by the reindex CLI tool.
func (c *Client) BulkUpsertSnapshotTexts(docs []SnapshotTextDoc) error {
	if c == nil || len(docs) == 0 {
		return nil
	}
	pk := "id"
	if _, err := c.texts.AddDocuments(docs, &meilisearch.DocumentOptions{PrimaryKey: &pk}); err != nil {
		return fmt.Errorf("meilisearch addDocuments: %w", err)
	}
	return nil
}

// SearchSnapshotTexts finds a user's bookmarks whose snapshot text matches
// query, each with a snippet of about 30 words around the match.
func (c *Client) SearchSnapshotTexts(userID, query string) ([]SnapshotTextHit, error) {
	if c == nil {
		return []SnapshotTextHit{}, nil
	}
	res, err := c.texts.Search(query, &meilisearch.SearchRequest{
		Filter:               fmt.Sprintf(`userId = "%s"`, userID),
		AttributesToRetrieve: []string{"id"},
		AttributesToCrop:     []string{"content"},
		CropLength:           30,
		Limit:                20,
	})
	if err != nil {
		return nil, fmt.Errorf("meilisearch search snapshot texts: %w", err)
	}
	var docs []struct {
		ID        string `json:"id"`
		Formatted struct {
			Content string `json:"content"`
		} `json:"_formatted"`
	}
	if err := res.Hits.DecodeInto(&docs); err != nil {
		return nil, fmt.Errorf("decode snapshot text hits: %w", err)
	}
	hits := make([]SnapshotTextHit, len(docs))
	for i, doc := range docs {
		hits[i] = SnapshotTextHit{ID: doc.ID, Snippet: doc.Formatted.Content}
	}
	return hits, nil
}

// SearchBookmarks queries the index filtered to a single user.
```

- [ ] **Step 4: Merge text matches into `GET /search`**

The handler takes a text searcher as an optional interface, so the existing `fixedBookmarkSearcher` tests keep compiling. `visibleBookmarks` replaces `visibleBookmarkIDs`. It returns the bookmark fields that text-only results need, and it applies the same visibility join as before.

Replace the contents of `internal/handler/search.go` with:

```go
package handler

import (
	"context"
	"log"
	"net/http"

	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/middleware"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/gin-gonic/gin"
)

// maxSearchResults caps GET /search, as SearchBookmarks caps its own hits.
const maxSearchResults = 20

type bookmarkSearcher interface {
	SearchBookmarks(userID, query string) ([]search.BookmarkDoc, error)
}

// snapshotTextSearcher finds bookmarks by their snapshot text. *search.Client
// implements it; a searcher without it returns only bookmark matches.
type snapshotTextSearcher interface {
	SearchSnapshotTexts(userID, query string) ([]search.SnapshotTextHit, error)
}

// searchResult is one bookmark in a GET /search response. Snippet is set for
// a bookmark that matched only in its snapshot text, and the response never
// contains the text itself.
type searchResult struct {
	search.BookmarkDoc
	Snippet string `json:"snippet,omitempty"`
}

type SearchHandler struct {
	db     *db.DB
	search bookmarkSearcher
}

func NewSearchHandler(d *db.DB, sc bookmarkSearcher) *SearchHandler {
	return &SearchHandler{db: d, search: sc}
}

// GET /search?q=<query>
func (h *SearchHandler) Search(c *gin.Context) {
	q := c.Query("q")
	if len([]rune(q)) < 2 {
		c.JSON(http.StatusOK, gin.H{"bookmarks": []searchResult{}})
		return
	}

	userID := middleware.UserID(c)
	docs, err := h.search.SearchBookmarks(userID, q)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "search failed"})
		return
	}
	var textHits []search.SnapshotTextHit
	if texts, ok := h.search.(snapshotTextSearcher); ok {
		if textHits, err = texts.SearchSnapshotTexts(userID, q); err != nil {
			// The bookmark matches still answer the search.
			log.Printf("search snapshot texts for %s: %v", userID, err)
		}
	}
	candidateIDs := make([]string, 0, len(docs)+len(textHits))
	for _, document := range docs {
		candidateIDs = append(candidateIDs, document.ID)
	}
	for _, hit := range textHits {
		candidateIDs = append(candidateIDs, hit.ID)
	}
	visible, err := h.visibleBookmarks(c.Request.Context(), userID, candidateIDs)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "search failed"})
		return
	}
	results := make([]searchResult, 0, len(docs))
	seen := make(map[string]bool, len(candidateIDs))
	for _, document := range docs {
		if _, ok := visible[document.ID]; ok && !seen[document.ID] {
			seen[document.ID] = true
			results = append(results, searchResult{BookmarkDoc: document})
		}
	}
	for _, hit := range textHits {
		document, ok := visible[hit.ID]
		if !ok || seen[hit.ID] || len(results) >= maxSearchResults {
			continue
		}
		seen[hit.ID] = true
		results = append(results, searchResult{BookmarkDoc: document, Snippet: hit.Snippet})
	}

	c.JSON(http.StatusOK, gin.H{"bookmarks": results})
}

// visibleBookmarks returns the candidates that the user can see, keyed by
// ID, with the fields a search result shows.
func (h *SearchHandler) visibleBookmarks(
	ctx context.Context,
	userID string,
	candidateIDs []string,
) (map[string]search.BookmarkDoc, error) {
	visible := make(map[string]search.BookmarkDoc, len(candidateIDs))
	if len(candidateIDs) == 0 {
		return visible, nil
	}
	rows, err := h.db.Query(ctx, `
		SELECT b.id, b.title, b.url, COALESCE(b.description, ''), b.collection_id, b.is_archived
		FROM bookmarks b
		JOIN collections c ON c.id=b.collection_id AND c.user_id=b.user_id
		JOIN workspaces w ON w.id=c.workspace_id AND w.user_id=c.user_id
		WHERE b.user_id=$1
		  AND b.id=ANY($2)
		  AND b.deleted_at IS NULL
		  AND b.is_trashed=0
		  AND c.deleted_at IS NULL
		  AND c.is_deleted=0
		  AND w.is_deleted=0`, userID, candidateIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var document search.BookmarkDoc
		if err := rows.Scan(&document.ID, &document.Title, &document.URL, &document.Description,
			&document.CollectionID, &document.IsArchived); err != nil {
			return nil, err
		}
		visible[document.ID] = document
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return visible, nil
}
```

- [ ] **Step 5: Read stored reader versions for the reindex**

Create `internal/snapshots/reindex.go`:

```go
package snapshots

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
)

// EachReaderText calls fn with the plain text of every stored reader
// version whose bookmark still exists, for cmd/reindex. Files missing from
// storage are skipped.
func EachReaderText(ctx context.Context, database *db.DB, store blobstore.Store, fn func(bookmarkID, userID, text string) error) error {
	rows, err := database.Query(ctx, `
		SELECT a.bookmark_id, a.user_id, a.id, a.size
		FROM snapshot_assets a
		JOIN bookmarks b ON b.id = a.bookmark_id
		WHERE a.type = 'reader' AND b.is_trashed < 2
		ORDER BY a.bookmark_id`)
	if err != nil {
		return fmt.Errorf("query reader versions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var bookmarkID, userID, assetID string
		var size int64
		if err := rows.Scan(&bookmarkID, &userID, &assetID, &size); err != nil {
			return fmt.Errorf("scan reader version: %w", err)
		}
		file, err := store.Open(ctx, AssetKey(userID, assetID), size)
		if errors.Is(err, blobstore.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(file, size))
		file.Close()
		if err != nil {
			return fmt.Errorf("read reader version %s: %w", assetID, err)
		}
		if err := fn(bookmarkID, userID, ReaderText(data)); err != nil {
			return err
		}
	}
	return rows.Err()
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/search/ ./internal/handler/ ./internal/snapshots/
```

Expected: all three packages pass. This includes the new `TestSearchSnapshotTextsReturnsSnippets`, `TestSnapshotTextMethodsAreNilSafe`, `TestSearchAddsSnapshotTextMatches`, `TestSearchKeepsBookmarkMatchesWhenTextSearchFails`, and `TestEachReaderTextReadsStoredReaderVersions`, and the existing `TestSearchFiltersRetainedWorkspace` and notes indexing tests.

- [ ] **Step 7: Commit**

```bash
git add internal/search/client.go internal/search/types.go internal/search/snapshot_text_test.go \
  internal/handler/search.go internal/handler/search_snapshot_test.go \
  internal/snapshots/reindex.go internal/snapshots/reindex_test.go
git commit -m "feat(search): index snapshot text and add snippets to search results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- internal/search/client.go internal/search/types.go \
  internal/search/snapshot_text_test.go internal/handler/search.go internal/handler/search_snapshot_test.go \
  internal/snapshots/reindex.go internal/snapshots/reindex_test.go
```

---

### Task 11: Snapshot endpoints and file serving

**Files:**
- Create: `internal/snapshots/assets.go`, `internal/handler/snapshots.go`
- Test: `internal/handler/snapshots_test.go`

**Interfaces:**
- Consumes: the `Service` methods of Tasks 5 and 6.
- Produces:
  - `(*Service).OpenAsset(ctx, assetID, sig) (*Asset, io.ReadSeekCloser, error)` and `snapshots.Asset{ID, Type, ContentType, Size, CreatedAt}` with `FileName()`.
  - `handler.NewSnapshotHandler(service *snapshots.Service) *SnapshotHandler`, whose methods are `Request`, `RequestArchive`, `Delete`, `DeleteArchive`, `GetSettings`, `PutSettings`, and `ServeAsset`. Every method answers `503` when the service is nil.
  - Test helpers for Task 12: `newSnapshotTest(t, storageMB)`, `(*snapshotTest).addBookmark`, `addAsset`, `call`, and `recordingQueue`.

- [ ] **Step 1: Write the failing tests**

The tests cover:
- `503` without snapshots;
- request validation and the `quota_exceeded` code;
- the archive and delete status codes;
- the settings;
- file serving: headers, Range, `download=1`, a tampered signature, an unknown asset, and the PDF exception.

Gin writes a status without a body only when a request ends, so the helpers call `WriteHeaderNow` before reading the recorder.

Create `internal/handler/snapshots_test.go`:

```go
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
	"github.com/TabSlate-dev/TabSlate-server/internal/middleware"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const snapshotTestSecret = "0123456789abcdef0123456789abcdef"

type recordingQueue struct {
	mu   sync.Mutex
	jobs []jobqueue.Job
}

func (q *recordingQueue) Enqueue(_ context.Context, job jobqueue.Job) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.jobs = append(q.jobs, job)
	return nil
}

type snapshotTest struct {
	t       *testing.T
	db      *db.DB
	store   *blobstore.Local
	queue   *recordingQueue
	signer  *snapshots.Signer
	service *snapshots.Service
	handler *SnapshotHandler
	userID  string
}

// newSnapshotTest sets up a user with one collection and a snapshot service
// whose plan allows storageMB of snapshots.
func newSnapshotTest(t *testing.T, storageMB int) *snapshotTest {
	t.Helper()
	testDB := openSyncTestDB(t)
	store, err := blobstore.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	signer, err := snapshots.NewSigner(snapshotTestSecret, "")
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	limits := syncTestLimits()
	limits.MaxSnapshotStorageMB = storageMB
	st := &snapshotTest{t: t, db: testDB, store: store, queue: &recordingQueue{}, signer: signer}
	st.service = snapshots.NewService(snapshots.Config{
		DB: testDB, Store: store, Queue: st.queue, Signer: signer, Hub: pubsub.NewInMemoryHub(),
		Limits: fixedLimitsProvider{limits: limits},
	})
	st.handler = NewSnapshotHandler(st.service)
	st.userID = insertAuthTestUser(t, testDB, authTestUserSeed{email: "snapshots@example.com", password: "password123"})
	insertNotesCollection(t, testDB, st.userID, "snapshot-workspace", "snapshot-collection")
	return st
}

func (st *snapshotTest) addBookmark(id, url string) {
	st.t.Helper()
	if _, err := st.db.Exec(st.t.Context(), `
		INSERT INTO bookmarks (id, user_id, collection_id, title, url, created_at, updated_at)
		VALUES ($1, $2, 'snapshot-collection', 'Title', $3, 1, 1)`, id, st.userID, url); err != nil {
		st.t.Fatalf("insert bookmark: %v", err)
	}
}

// addAsset stores a ready snapshot's file and returns its signed URL.
func (st *snapshotTest) addAsset(bookmarkID, assetType, contentType string, data []byte) string {
	st.t.Helper()
	if _, err := st.db.Exec(st.t.Context(), `
		INSERT INTO bookmark_snapshots (bookmark_id, user_id, url, status, kind, seq, updated_at)
		SELECT id, user_id, url, 'ready', 'page', 1, 1 FROM bookmarks WHERE id = $1
		ON CONFLICT (bookmark_id) DO NOTHING`, bookmarkID); err != nil {
		st.t.Fatalf("insert snapshot: %v", err)
	}
	id := uuid.NewString()
	if _, err := st.db.Exec(st.t.Context(), `
		INSERT INTO snapshot_assets (id, user_id, bookmark_id, type, content_type, size, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, 1)`, id, st.userID, bookmarkID, assetType, contentType, len(data)); err != nil {
		st.t.Fatalf("insert asset: %v", err)
	}
	if err := st.store.Put(st.t.Context(), snapshots.AssetKey(st.userID, id), data); err != nil {
		st.t.Fatalf("put file: %v", err)
	}
	return st.signer.URL(id)
}

// call runs one handler as the test user.
func (st *snapshotTest) call(handle gin.HandlerFunc, method, target, body string, params ...gin.Param) *httptest.ResponseRecorder {
	st.t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	ginContext.Request = httptest.NewRequest(method, target, strings.NewReader(body))
	ginContext.Request.Header.Set("Content-Type", "application/json")
	ginContext.Set(middleware.UserIDKey, st.userID)
	ginContext.Params = params
	handle(ginContext)
	// Gin writes a status without a body when the request ends; do it here.
	ginContext.Writer.WriteHeaderNow()
	return recorder
}

func bookmarkParam(id string) gin.Param {
	return gin.Param{Key: "bookmarkId", Value: id}
}

func TestSnapshotEndpointsWithoutSnapshots(t *testing.T) {
	handler := NewSnapshotHandler(nil)
	for name, handle := range map[string]gin.HandlerFunc{
		"request": handler.Request, "archive": handler.RequestArchive, "delete": handler.Delete,
		"delete archive": handler.DeleteArchive, "get settings": handler.GetSettings,
		"put settings": handler.PutSettings, "asset": handler.ServeAsset,
	} {
		recorder := httptest.NewRecorder()
		ginContext, _ := gin.CreateTestContext(recorder)
		ginContext.Request = httptest.NewRequest(http.MethodGet, "/", nil)
		handle(ginContext)
		ginContext.Writer.WriteHeaderNow()
		if recorder.Code != http.StatusServiceUnavailable {
			t.Errorf("%s answered %d, want 503", name, recorder.Code)
		}
	}
}

func TestSnapshotRequestEndpoint(t *testing.T) {
	st := newSnapshotTest(t, -1)
	st.addBookmark("bm-1", "https://one.example.com")

	tooMany := make([]string, 101)
	for i := range tooMany {
		tooMany[i] = "bm"
	}
	tooManyBody, _ := json.Marshal(map[string]any{"bookmark_ids": tooMany})
	for _, body := range []string{`{}`, `{"bookmark_ids":[]}`, `{"bookmark_ids":[""]}`, string(tooManyBody)} {
		if recorder := st.call(st.handler.Request, http.MethodPost, "/snapshots", body); recorder.Code != http.StatusBadRequest {
			t.Errorf("body %.40s answered %d, want 400", body, recorder.Code)
		}
	}

	recorder := st.call(st.handler.Request, http.MethodPost, "/snapshots", `{"bookmark_ids":["bm-1","bm-missing"]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var result snapshots.RequestResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(result.Queued) != 1 || result.Queued[0] != "bm-1" || len(result.Skipped) != 1 || result.Skipped[0].Reason != snapshots.SkipNotFound {
		t.Fatalf("result = %+v", result)
	}
	if len(st.queue.jobs) != 1 {
		t.Fatalf("enqueued %d jobs, want 1", len(st.queue.jobs))
	}
}

func TestSnapshotRequestEndpointWhenStorageIsFull(t *testing.T) {
	st := newSnapshotTest(t, 0)
	st.addBookmark("bm-1", "https://one.example.com")
	recorder := st.call(st.handler.Request, http.MethodPost, "/snapshots", `{"bookmark_ids":["bm-1"]}`)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), `"code":"quota_exceeded"`) {
		t.Fatalf("status = %d body=%s, want 403 quota_exceeded", recorder.Code, recorder.Body.String())
	}
}

func TestSnapshotArchiveAndDeleteEndpoints(t *testing.T) {
	st := newSnapshotTest(t, -1)
	st.addBookmark("bm-1", "https://one.example.com")
	st.addBookmark("bm-2", "https://two.example.com")
	st.addAsset("bm-1", snapshots.AssetReader, "text/html; charset=utf-8", []byte("<p>hi</p>"))

	for _, tc := range []struct {
		handle gin.HandlerFunc
		method string
		id     string
		want   int
	}{
		{st.handler.RequestArchive, http.MethodPost, "bm-2", http.StatusConflict},
		{st.handler.RequestArchive, http.MethodPost, "bm-missing", http.StatusNotFound},
		{st.handler.RequestArchive, http.MethodPost, "bm-1", http.StatusAccepted},
		{st.handler.RequestArchive, http.MethodPost, "bm-1", http.StatusConflict},
		{st.handler.DeleteArchive, http.MethodDelete, "bm-1", http.StatusNoContent},
		{st.handler.DeleteArchive, http.MethodDelete, "bm-1", http.StatusNotFound},
		{st.handler.Delete, http.MethodDelete, "bm-1", http.StatusNoContent},
		{st.handler.Delete, http.MethodDelete, "bm-1", http.StatusNotFound},
	} {
		recorder := st.call(tc.handle, tc.method, "/snapshots/"+tc.id, "", bookmarkParam(tc.id))
		if recorder.Code != tc.want {
			t.Fatalf("%s %s answered %d body=%s, want %d", tc.method, tc.id, recorder.Code, recorder.Body.String(), tc.want)
		}
	}
}

func TestSnapshotSettingsEndpoints(t *testing.T) {
	st := newSnapshotTest(t, -1)
	if recorder := st.call(st.handler.GetSettings, http.MethodGet, "/snapshots/settings", ""); recorder.Body.String() != `{"auto":true}` {
		t.Fatalf("GET settings = %s", recorder.Body.String())
	}
	if recorder := st.call(st.handler.PutSettings, http.MethodPut, "/snapshots/settings", `{}`); recorder.Code != http.StatusBadRequest {
		t.Fatalf("PUT without auto answered %d, want 400", recorder.Code)
	}
	if recorder := st.call(st.handler.PutSettings, http.MethodPut, "/snapshots/settings", `{"auto":false}`); recorder.Code != http.StatusOK {
		t.Fatalf("PUT settings answered %d", recorder.Code)
	}
	if recorder := st.call(st.handler.GetSettings, http.MethodGet, "/snapshots/settings", ""); recorder.Body.String() != `{"auto":false}` {
		t.Fatalf("GET settings after PUT = %s", recorder.Body.String())
	}
}

func (st *snapshotTest) serve(url string, header http.Header) *httptest.ResponseRecorder {
	st.t.Helper()
	path, _, _ := strings.Cut(url, "?")
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	ginContext.Request = httptest.NewRequest(http.MethodGet, url, nil)
	for name, values := range header {
		ginContext.Request.Header[name] = values
	}
	ginContext.Params = gin.Params{{Key: "assetId", Value: strings.TrimPrefix(path, "/snapshot-assets/")}}
	st.handler.ServeAsset(ginContext)
	ginContext.Writer.WriteHeaderNow()
	return recorder
}

func TestServeSnapshotAsset(t *testing.T) {
	st := newSnapshotTest(t, -1)
	st.addBookmark("bm-1", "https://one.example.com")
	html := []byte("<p>reader version</p>")
	url := st.addAsset("bm-1", snapshots.AssetReader, "text/html; charset=utf-8", html)

	recorder := st.serve(url, nil)
	if recorder.Code != http.StatusOK || !bytes.Equal(recorder.Body.Bytes(), html) {
		t.Fatalf("status = %d body=%q", recorder.Code, recorder.Body.String())
	}
	for name, want := range map[string]string{
		"Content-Type":            "text/html; charset=utf-8",
		"X-Content-Type-Options":  "nosniff",
		"Cache-Control":           "private, max-age=31536000, immutable",
		"Content-Security-Policy": snapshotCSP,
	} {
		if got := recorder.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}

	partial := st.serve(url, http.Header{"Range": {"bytes=3-8"}})
	if partial.Code != http.StatusPartialContent || partial.Body.String() != "reader" {
		t.Fatalf("range request = %d %q, want 206 %q", partial.Code, partial.Body.String(), "reader")
	}
	download := st.serve(url+"&download=1", nil)
	if got := download.Header().Get("Content-Disposition"); got != `attachment; filename="snapshot-reader.html"` {
		t.Fatalf("Content-Disposition = %q", got)
	}

	tampered := url[:len(url)-1] + "0"
	if strings.HasSuffix(url, "0") {
		tampered = url[:len(url)-1] + "1"
	}
	if recorder := st.serve(tampered, nil); recorder.Code != http.StatusNotFound {
		t.Fatalf("tampered signature answered %d, want 404", recorder.Code)
	}
	if recorder := st.serve(st.signer.URL(uuid.NewString()), nil); recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown asset answered %d, want 404", recorder.Code)
	}
}

func TestServeSnapshotPDFWithoutSandbox(t *testing.T) {
	st := newSnapshotTest(t, -1)
	st.addBookmark("bm-1", "https://one.example.com/paper.pdf")
	url := st.addAsset("bm-1", snapshots.AssetFile, "application/pdf", []byte("%PDF-1.7"))
	recorder := st.serve(url, nil)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Security-Policy") != "" ||
		recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("PDF response = %d with headers %v", recorder.Code, recorder.Header())
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/handler/
```

Expected: the build fails with `undefined: SnapshotHandler` and `undefined: NewSnapshotHandler`.

- [ ] **Step 3: Open files by signed URL**

`OpenAsset` answers `ErrNotFound` without touching the database when the asset ID is not a UUID or the signature is wrong.

Create `internal/snapshots/assets.go`:

```go
package snapshots

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"

	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Asset is a stored snapshot file.
type Asset struct {
	ID          string
	Type        string
	ContentType string
	Size        int64
	// CreatedAt is in Unix milliseconds.
	CreatedAt int64
}

var fileExtensions = map[string]string{
	"text/html":       ".html",
	"image/jpeg":      ".jpg",
	"image/png":       ".png",
	"image/gif":       ".gif",
	"image/webp":      ".webp",
	"image/svg+xml":   ".svg",
	"image/avif":      ".avif",
	"application/pdf": ".pdf",
}

// FileName names a downloaded copy of the asset.
func (a *Asset) FileName() string {
	mediaType, _, _ := mime.ParseMediaType(a.ContentType)
	ext, ok := fileExtensions[mediaType]
	if !ok {
		ext = ".bin"
	}
	return "snapshot-" + a.Type + ext
}

// OpenAsset checks a file URL's signature and opens the file. A bad
// signature, an unknown asset, and a file missing from storage all return
// ErrNotFound.
func (s *Service) OpenAsset(ctx context.Context, assetID, sig string) (*Asset, io.ReadSeekCloser, error) {
	if uuid.Validate(assetID) != nil || !s.signer.Valid(assetID, sig) {
		return nil, nil, ErrNotFound
	}
	asset := &Asset{ID: assetID}
	var userID string
	err := s.db.QueryRow(ctx, `
		SELECT user_id, type, content_type, size, created_at FROM snapshot_assets WHERE id = $1`, assetID,
	).Scan(&userID, &asset.Type, &asset.ContentType, &asset.Size, &asset.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, fmt.Errorf("look up asset: %w", err)
	}
	file, err := s.effects.store.Open(ctx, AssetKey(userID, assetID), asset.Size)
	if errors.Is(err, blobstore.ErrNotFound) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, fmt.Errorf("open asset: %w", err)
	}
	return asset, file, nil
}
```

- [ ] **Step 4: Write the handler**

`ServeAsset` sets the headers and hands the file to `http.ServeContent`. `ServeContent` answers Range, `If-Range`, and `If-None-Match` (against the asset ID as `ETag`) itself.

Create `internal/handler/snapshots.go`:

```go
package handler

import (
	"errors"
	"log"
	"mime"
	"net/http"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/internal/middleware"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots"
	"github.com/gin-gonic/gin"
)

// snapshotCSP isolates snapshot files, following Karakeep: they cannot run
// scripts, submit forms, or load anything but images, styles, fonts, and media.
const snapshotCSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; " +
	"img-src https: data: blob:; style-src 'unsafe-inline' https: data:; font-src https: data:; " +
	"media-src https: data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'"

// SnapshotHandler serves the web snapshot endpoints and files. Without a
// snapshot service (no storage or queue configured) every endpoint answers 503.
type SnapshotHandler struct {
	snapshots *snapshots.Service
}

func NewSnapshotHandler(service *snapshots.Service) *SnapshotHandler {
	return &SnapshotHandler{snapshots: service}
}

func (h *SnapshotHandler) configured(c *gin.Context) bool {
	if h.snapshots == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "snapshots are not configured"})
		return false
	}
	return true
}

// respondSnapshotError maps service errors to responses.
func respondSnapshotError(c *gin.Context, operation string, err error) {
	switch {
	case errors.Is(err, snapshots.ErrQuotaExceeded):
		c.JSON(http.StatusForbidden, gin.H{"error": "snapshot storage is full", "code": "quota_exceeded"})
	case errors.Is(err, snapshots.ErrDailyLimit):
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "daily snapshot limit reached", "code": "daily_limit"})
	case errors.Is(err, snapshots.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "snapshot not found"})
	case errors.Is(err, snapshots.ErrNoPage):
		c.JSON(http.StatusConflict, gin.H{"error": "the bookmark has no page snapshot", "code": "no_snapshot"})
	case errors.Is(err, snapshots.ErrAlreadyQueued):
		c.JSON(http.StatusConflict, gin.H{"error": "a full-page archive is already queued", "code": "already_queued"})
	default:
		log.Printf("snapshots %s user_id=%q: %v", operation, middleware.UserID(c), err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "snapshot request failed"})
	}
}

// POST /snapshots  body: {"bookmark_ids": [...]}
func (h *SnapshotHandler) Request(c *gin.Context) {
	if !h.configured(c) {
		return
	}
	var body struct {
		BookmarkIDs []string `json:"bookmark_ids" binding:"required,min=1,max=100,dive,required,max=200"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bookmark_ids must list 1 to 100 bookmark IDs"})
		return
	}
	result, err := h.snapshots.Request(c.Request.Context(), middleware.UserID(c), body.BookmarkIDs)
	if err != nil {
		respondSnapshotError(c, "request", err)
		return
	}
	c.JSON(http.StatusOK, result)
}

// POST /snapshots/:bookmarkId/archive
func (h *SnapshotHandler) RequestArchive(c *gin.Context) {
	if !h.configured(c) {
		return
	}
	if err := h.snapshots.RequestArchive(c.Request.Context(), middleware.UserID(c), c.Param("bookmarkId")); err != nil {
		respondSnapshotError(c, "archive request", err)
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"queued": true})
}

// DELETE /snapshots/:bookmarkId
func (h *SnapshotHandler) Delete(c *gin.Context) {
	if !h.configured(c) {
		return
	}
	if err := h.snapshots.Delete(c.Request.Context(), middleware.UserID(c), c.Param("bookmarkId")); err != nil {
		respondSnapshotError(c, "delete", err)
		return
	}
	c.Status(http.StatusNoContent)
}

// DELETE /snapshots/:bookmarkId/archive
func (h *SnapshotHandler) DeleteArchive(c *gin.Context) {
	if !h.configured(c) {
		return
	}
	if err := h.snapshots.DeleteArchive(c.Request.Context(), middleware.UserID(c), c.Param("bookmarkId")); err != nil {
		respondSnapshotError(c, "archive delete", err)
		return
	}
	c.Status(http.StatusNoContent)
}

// GET /snapshots/settings
func (h *SnapshotHandler) GetSettings(c *gin.Context) {
	if !h.configured(c) {
		return
	}
	auto, err := h.snapshots.Auto(c.Request.Context(), middleware.UserID(c))
	if err != nil {
		respondSnapshotError(c, "read settings", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"auto": auto})
}

// PUT /snapshots/settings  body: {"auto": true}
func (h *SnapshotHandler) PutSettings(c *gin.Context) {
	if !h.configured(c) {
		return
	}
	var body struct {
		Auto *bool `json:"auto" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "auto must be true or false"})
		return
	}
	if err := h.snapshots.SetAuto(c.Request.Context(), middleware.UserID(c), *body.Auto); err != nil {
		respondSnapshotError(c, "write settings", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"auto": *body.Auto})
}

// GET /snapshot-assets/:assetId?sig=<hex>[&download=1]
// The signed URL is the credential: <img> and <iframe> requests cannot send
// an Authorization header. A file never changes at its URL, so responses are
// cached for a year.
func (h *SnapshotHandler) ServeAsset(c *gin.Context) {
	if !h.configured(c) {
		return
	}
	asset, file, err := h.snapshots.OpenAsset(c.Request.Context(), c.Param("assetId"), c.Query("sig"))
	if errors.Is(err, snapshots.ErrNotFound) {
		c.Status(http.StatusNotFound)
		return
	}
	if err != nil {
		log.Printf("snapshots serve asset %q: %v", c.Param("assetId"), err)
		c.Status(http.StatusInternalServerError)
		return
	}
	defer file.Close()

	header := c.Writer.Header()
	header.Set("Content-Type", asset.ContentType)
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Cache-Control", "private, max-age=31536000, immutable")
	header.Set("ETag", `"`+asset.ID+`"`)
	// Browsers do not open PDFs in sandboxed documents.
	if mediaType, _, _ := mime.ParseMediaType(asset.ContentType); mediaType != "application/pdf" {
		header.Set("Content-Security-Policy", snapshotCSP)
	}
	if c.Query("download") == "1" {
		header.Set("Content-Disposition", `attachment; filename="`+asset.FileName()+`"`)
	}
	http.ServeContent(c.Writer, c.Request, "", time.UnixMilli(asset.CreatedAt), file)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/handler/ ./internal/snapshots/
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/handler/ -v -run 'Snapshot'
```

Expected: both packages pass. The new tests are `TestSnapshotEndpointsWithoutSnapshots`, `TestSnapshotRequestEndpoint`, `TestSnapshotRequestEndpointWhenStorageIsFull`, `TestSnapshotArchiveAndDeleteEndpoints`, `TestSnapshotSettingsEndpoints`, `TestServeSnapshotAsset`, and `TestServeSnapshotPDFWithoutSandbox`.

- [ ] **Step 6: Commit**

```bash
git add internal/snapshots/assets.go internal/handler/snapshots.go internal/handler/snapshots_test.go
git commit -m "feat(snapshots): add snapshot endpoints and signed file serving

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- internal/snapshots/assets.go \
  internal/handler/snapshots.go internal/handler/snapshots_test.go
```

---

### Task 12: Sync, REST, and cleanup

**Files:**
- Modify: `internal/model/model.go`, `internal/handler/sync.go`, `internal/handler/bookmarks.go`, `internal/handler/cleanup.go`
- Test: `internal/handler/snapshot_sync_test.go`

**Interfaces:**
- Consumes:
  - `Rows`, `NoteSync`, `AfterBookmarkWrites`, `RemoveGoneEverywhere`, and `CollectGarbage`;
  - Task 11's test helpers.
- Produces:
  - `model.SyncEntities.Snapshots []model.Snapshot` (`json:"snapshots"`) and `model.SyncCapabilities.Snapshots bool` (`json:"snapshots"`).
  - `(*SyncHandler).WithSnapshots`, `(*BookmarkHandler).WithSnapshots`, and `(*CleanupHandler).WithSnapshots`. Each takes a `*snapshots.Service` and returns its receiver. With nil, behavior is unchanged.
  - `GET /sync/pull` reads `server_seq` before the entities.

- [ ] **Step 1: Write the failing tests**

The tests cover:
- pull rows and the capability flag, with and without snapshots, and the `last_sync_at` write;
- a push with a new bookmark, a URL change, and a permanently deleted bookmark;
- a REST create;
- the daily cleanup deleting the snapshot of a bookmark whose trash expired.

Create `internal/handler/snapshot_sync_test.go`:

```go
package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/internal/middleware"
	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots"
	"github.com/gin-gonic/gin"
)

func (st *snapshotTest) push(entities model.SyncPushEntities) model.SyncPushResponse {
	st.t.Helper()
	body, err := json.Marshal(model.SyncPushRequest{Entities: entities})
	if err != nil {
		st.t.Fatalf("marshal push: %v", err)
	}
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	ginContext.Request = httptest.NewRequest(http.MethodPost, "/sync/push", bytes.NewReader(body))
	ginContext.Request.Header.Set("Content-Type", "application/json")
	ginContext.Set(middleware.UserIDKey, st.userID)
	hub := pubsub.NewInMemoryHub()
	NewSyncHandler(st.db, nil, hub, fixedLimitsProvider{limits: syncTestLimits()}, NewWorkspaceLifecycleService(st.db, hub, nil)).
		WithSnapshots(st.service).Push(ginContext)
	assertSyncStatusOK(st.t, recorder)
	return decodeSyncPushResponse(st.t, recorder)
}

func (st *snapshotTest) pull(service *snapshots.Service) model.SyncPullResponse {
	st.t.Helper()
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	ginContext.Request = httptest.NewRequest(http.MethodGet, "/sync/pull?after_seq=0", nil)
	ginContext.Set(middleware.UserIDKey, st.userID)
	NewSyncHandler(st.db, nil, pubsub.NewInMemoryHub(), fixedLimitsProvider{limits: syncTestLimits()}).
		WithSnapshots(service).Pull(ginContext)
	assertSyncStatusOK(st.t, recorder)
	var response model.SyncPullResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		st.t.Fatalf("decode pull: %v", err)
	}
	return response
}

func (st *snapshotTest) snapshotStatus(bookmarkID string) string {
	st.t.Helper()
	var status string
	if err := st.db.QueryRow(st.t.Context(), `SELECT status FROM bookmark_snapshots WHERE bookmark_id = $1`, bookmarkID).Scan(&status); err != nil {
		st.t.Fatalf("read snapshot status: %v", err)
	}
	return status
}

func snapshotCollectionID() *string {
	id := "snapshot-collection"
	return &id
}

func TestSyncPullReturnsSnapshots(t *testing.T) {
	st := newSnapshotTest(t, -1)
	st.addBookmark("bm-1", "https://one.example.com")
	url := st.addAsset("bm-1", snapshots.AssetScreenshot, "image/jpeg", []byte("jpeg"))
	if _, err := st.db.Exec(t.Context(), `INSERT INTO user_sync_seq (user_id, seq) VALUES ($1, 5)`, st.userID); err != nil {
		t.Fatalf("insert user sync sequence: %v", err)
	}

	response := st.pull(st.service)
	if !response.Capabilities.Snapshots || len(response.Entities.Snapshots) != 1 {
		t.Fatalf("capabilities = %+v, snapshots = %+v", response.Capabilities, response.Entities.Snapshots)
	}
	if row := response.Entities.Snapshots[0]; row.BookmarkID != "bm-1" || row.ScreenshotURL != url || row.Size != 4 {
		t.Fatalf("snapshot row = %+v", row)
	}
	var lastSync *int64
	if err := st.db.QueryRow(t.Context(), `SELECT last_sync_at FROM users WHERE id = $1`, st.userID).Scan(&lastSync); err != nil || lastSync == nil {
		t.Fatalf("last_sync_at = %v, %v; want the pull recorded", lastSync, err)
	}

	without := st.pull(nil)
	if without.Capabilities.Snapshots || without.Entities.Snapshots == nil || len(without.Entities.Snapshots) != 0 {
		t.Fatalf("without snapshots: capabilities = %+v, snapshots = %#v", without.Capabilities, without.Entities.Snapshots)
	}
}

func TestSyncPushTriggersSnapshots(t *testing.T) {
	st := newSnapshotTest(t, -1)
	st.addBookmark("bm-moved", "https://old.example.com")
	st.addBookmark("bm-purged", "https://purged.example.com")
	st.addAsset("bm-moved", snapshots.AssetReader, "text/html; charset=utf-8", []byte("<p>old</p>"))
	st.addAsset("bm-purged", snapshots.AssetReader, "text/html; charset=utf-8", []byte("<p>purged</p>"))
	if _, err := st.db.Exec(t.Context(), `UPDATE bookmarks SET updated_at = 1`); err != nil {
		t.Fatalf("rewind bookmarks: %v", err)
	}
	deletedAt := time.Now().UnixMilli()

	response := st.push(model.SyncPushEntities{Bookmarks: []model.Bookmark{
		{ID: "bm-new", CollectionID: snapshotCollectionID(), Title: "New", URL: "https://new.example.com"},
		{ID: "bm-moved", CollectionID: snapshotCollectionID(), Title: "Moved", URL: "https://moved.example.com"},
		{ID: "bm-purged", CollectionID: snapshotCollectionID(), Title: "Purged", URL: "https://purged.example.com", IsTrashed: 2, DeletedAt: &deletedAt},
	}})
	if len(response.Rejected) != 0 {
		t.Fatalf("rejected %+v", response.Rejected)
	}
	if got := st.snapshotStatus("bm-new"); got != snapshots.StatusQueued {
		t.Fatalf("new bookmark snapshot = %s, want queued", got)
	}
	if got := st.snapshotStatus("bm-moved"); got != snapshots.StatusQueued {
		t.Fatalf("moved bookmark snapshot = %s, want queued for the new URL", got)
	}
	if got := st.snapshotStatus("bm-purged"); got != snapshots.StatusDeleted {
		t.Fatalf("purged bookmark snapshot = %s, want deleted", got)
	}
	assertEntityCount(t, st.db, `SELECT COUNT(*) FROM snapshot_assets`, 0)
	if len(st.queue.jobs) != 2 {
		t.Fatalf("enqueued %+v, want the new and the moved bookmark", st.queue.jobs)
	}
}

func TestBookmarkRESTWritesTriggerSnapshots(t *testing.T) {
	st := newSnapshotTest(t, -1)
	handler := NewBookmarkHandler(st.db, nil, pubsub.NewInMemoryHub(), fixedLimitsProvider{limits: syncTestLimits()}).WithSnapshots(st.service)

	var created model.Bookmark
	decodeHandlerResponse(t, performHandlerRequest(t, st.userID, http.MethodPost, "/bookmarks", marshalBookmarkRequest(t, model.BookmarkRequest{
		CollectionID: snapshotCollectionID(), Title: "Doc", URL: "https://doc.example.com",
	}), handler.Create), http.StatusCreated, &created)
	if got := st.snapshotStatus(created.ID); got != snapshots.StatusQueued {
		t.Fatalf("created bookmark snapshot = %s, want queued", got)
	}
}

func TestCleanupRemovesSnapshotsOfExpiredTrash(t *testing.T) {
	st := newSnapshotTest(t, -1)
	st.addBookmark("bm-1", "https://one.example.com")
	st.addAsset("bm-1", snapshots.AssetReader, "text/html; charset=utf-8", []byte("<p>trashed</p>"))
	expired := time.Now().Add(-10 * 24 * time.Hour).UnixMilli()
	if _, err := st.db.Exec(t.Context(), `UPDATE bookmarks SET is_trashed = 1, deleted_at = $1 WHERE id = 'bm-1'`, expired); err != nil {
		t.Fatalf("trash bookmark: %v", err)
	}
	NewCleanupHandler(st.db, 7, nil, fixedLimitsProvider{limits: syncTestLimits()}, nil).WithSnapshots(st.service).runOnce(t.Context())

	if got := st.snapshotStatus("bm-1"); got != snapshots.StatusDeleted {
		t.Fatalf("snapshot of expired trash = %s, want deleted", got)
	}
	assertEntityCount(t, st.db, `SELECT COUNT(*) FROM snapshot_assets`, 0)
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/handler/
```

Expected: the build fails with `WithSnapshots undefined (type *SyncHandler has no field or method WithSnapshots)` and `response.Capabilities.Snapshots undefined`.

- [ ] **Step 3: Add the sync fields**

In `internal/model/model.go`:

Replace:

```go
	Bookmarks   []Bookmark      `json:"bookmarks"`
	Tags        []Tag           `json:"tags"`
	Groups      []Group         `json:"groups"`
}

// SyncPushEntities is the request shape accepted by push.
```

with:

```go
	Bookmarks   []Bookmark      `json:"bookmarks"`
	Tags        []Tag           `json:"tags"`
	Groups      []Group         `json:"groups"`
	// Snapshots is read only: clients never push snapshots.
	Snapshots []Snapshot `json:"snapshots"`
}

// SyncPushEntities is the request shape accepted by push.
```

Replace:

```go
type SyncCapabilities struct {
	WorkspaceParentTombstone bool `json:"workspace_parent_tombstone"`
}

// SSEToken is a short-lived token for authenticating the SSE stream.
```

with:

```go
type SyncCapabilities struct {
	WorkspaceParentTombstone bool `json:"workspace_parent_tombstone"`
	// Snapshots is true when the server has snapshot storage and a queue.
	Snapshots bool `json:"snapshots"`
}

// SSEToken is a short-lived token for authenticating the SSE stream.
```

- [ ] **Step 4: Hook sync push and pull**

The push collects the IDs of bookmarks whose upsert succeeded. After the commit and the search updates, it calls `AfterBookmarkWrites` when the push contained bookmarks or collections. The pull:
- reads `server_seq` first (Note 7);
- returns snapshot rows when the service is set;
- records the sync for the backfill.

In `internal/handler/sync.go`:

Replace:

```go
	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)
```

with:

```go
	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)
```

Replace:

```go
	hub       pubsub.Hub
	billing   billing.Provider
	lifecycle *WorkspaceLifecycleService
}

func NewSyncHandler(
```

with:

```go
	hub       pubsub.Hub
	billing   billing.Provider
	lifecycle *WorkspaceLifecycleService
	snapshots *snapshots.Service
}

func NewSyncHandler(
```

Replace:

```go
		billing:   bp,
		lifecycle: lifecycleService,
	}
}

// POST /sync/push
```

with:

```go
		billing:   bp,
		lifecycle: lifecycleService,
	}
}

// WithSnapshots turns on web snapshots: pulls return snapshot rows, and
// pushes trigger snapshots of new bookmarks. Pass nil to leave them off.
func (h *SyncHandler) WithSnapshots(service *snapshots.Service) *SyncHandler {
	h.snapshots = service
	return h
}

// POST /sync/push
```

Replace:

```go
	}
	var searchUpserts []search.BookmarkDoc
	var searchDeletes []string

	legacyMetadataWorkspaceIDs := []string{}
	legacyMetadataWorkspaceIDSet := entityIDSet{}
```

with:

```go
	}
	var searchUpserts []search.BookmarkDoc
	var searchDeletes []string
	var acceptedBookmarkIDs []string

	legacyMetadataWorkspaceIDs := []string{}
	legacyMetadataWorkspaceIDSet := entityIDSet{}
```

Replace:

```go
				respondSyncDatabaseError(c, "bookmark upsert", userID, bookmarkIDs, err)
				return
			}
			if bm.DeletedAt != nil || bm.IsTrashed > 0 {
				searchDeletes = append(searchDeletes, bm.ID)
				continue
```

with:

```go
				respondSyncDatabaseError(c, "bookmark upsert", userID, bookmarkIDs, err)
				return
			}
			acceptedBookmarkIDs = append(acceptedBookmarkIDs, bm.ID)
			if bm.DeletedAt != nil || bm.IsTrashed > 0 {
				searchDeletes = append(searchDeletes, bm.ID)
				continue
```

Replace:

```go
	h.search.BulkUpsertAsync(searchUpserts)
	h.search.BulkDeleteAsync(searchDeletes)

	if rejected == nil {
		rejected = []model.Rejected{}
	}
```

with:

```go
	h.search.BulkUpsertAsync(searchUpserts)
	h.search.BulkDeleteAsync(searchDeletes)

	if h.snapshots != nil && (len(req.Entities.Bookmarks) > 0 || len(req.Entities.Collections) > 0) {
		h.snapshots.AfterBookmarkWrites(ctx, userID, acceptedBookmarkIDs)
	}

	if rejected == nil {
		rejected = []model.Rejected{}
	}
```

Replace:

```go
		}
	}

	resp := model.SyncPullResponse{
		Capabilities: model.SyncCapabilities{WorkspaceParentTombstone: true},
	}

	// Workspaces are always returned in full, never seq-filtered like every
```

with:

```go
		}
	}

	// Read the sequence number before the entities. A change committed while
	// the entities are read then has a higher number and comes back in the
	// next pull; reading it last would skip such a change for good, which
	// matters for snapshot results that the worker saves at any time.
	serverSeq, err := currentSeq(ctx, h.db, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "sync failed"})
		return
	}

	resp := model.SyncPullResponse{
		ServerSeq:    serverSeq,
		Capabilities: model.SyncCapabilities{WorkspaceParentTombstone: true, Snapshots: h.snapshots != nil},
	}

	// Workspaces are always returned in full, never seq-filtered like every
```

Replace:

```go
		resp.Entities.Tags = []model.Tag{}
	}

	serverSeq, err := currentSeq(ctx, h.db, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "sync failed"})
		return
	}
	resp.ServerSeq = serverSeq

	c.JSON(http.StatusOK, resp)
}
```

with:

```go
		resp.Entities.Tags = []model.Tag{}
	}

	resp.Entities.Snapshots = []model.Snapshot{}
	if h.snapshots != nil {
		rows, err := h.snapshots.Rows(ctx, userID, afterSeq)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "snapshots query failed"})
			return
		}
		resp.Entities.Snapshots = rows
		if err := h.snapshots.NoteSync(ctx, userID); err != nil {
			log.Printf("sync pull user_id=%q: %v", userID, err)
		}
	}

	c.JSON(http.StatusOK, resp)
}
```

- [ ] **Step 5: Hook REST writes**

In `internal/handler/bookmarks.go`:

Replace:

```go
	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type BookmarkHandler struct {
	db      *db.DB
	search  *search.Client
	hub     pubsub.Hub
	billing billing.Provider
}

func NewBookmarkHandler(d *db.DB, sc *search.Client, hub pubsub.Hub, bp billing.Provider) *BookmarkHandler {
	return &BookmarkHandler{db: d, search: sc, hub: hub, billing: bp}
}

// GET /bookmarks?collection_id=&favorite=&archived=&trashed=
```

with:

```go
	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type BookmarkHandler struct {
	db        *db.DB
	search    *search.Client
	hub       pubsub.Hub
	billing   billing.Provider
	snapshots *snapshots.Service
}

func NewBookmarkHandler(d *db.DB, sc *search.Client, hub pubsub.Hub, bp billing.Provider) *BookmarkHandler {
	return &BookmarkHandler{db: d, search: sc, hub: hub, billing: bp}
}

// WithSnapshots makes creates and updates trigger web snapshots. Pass nil
// to leave them off.
func (h *BookmarkHandler) WithSnapshots(service *snapshots.Service) *BookmarkHandler {
	h.snapshots = service
	return h
}

// GET /bookmarks?collection_id=&favorite=&archived=&trashed=
```

Replace:

```go
	}

	h.hub.Broadcast(userID, seq)
	if !req.IsTrashed {
		h.search.UpsertBookmark(search.BookmarkDoc{
			ID:           id,
```

with:

```go
	}

	h.hub.Broadcast(userID, seq)
	if h.snapshots != nil {
		h.snapshots.AfterBookmarkWrites(ctx, userID, []string{id})
	}
	if !req.IsTrashed {
		h.search.UpsertBookmark(search.BookmarkDoc{
			ID:           id,
```

Replace:

```go
	}

	h.hub.Broadcast(userID, seq)
	if req.IsTrashed {
		h.search.DeleteBookmark(id)
	} else {
```

with:

```go
	}

	h.hub.Broadcast(userID, seq)
	if h.snapshots != nil {
		h.snapshots.AfterBookmarkWrites(ctx, userID, []string{id})
	}
	if req.IsTrashed {
		h.search.DeleteBookmark(id)
	} else {
```

- [ ] **Step 6: Hook the daily cleanup**

The snapshot cleanup runs after the four existing phases, so phase 1's newly promoted bookmarks and phase 2's hard deletes are covered.

In `internal/handler/cleanup.go`:

Replace:

```go
	"github.com/TabSlate-dev/TabSlate-server/internal/mailer"
	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/jackc/pgx/v5"
)
```

with:

```go
	"github.com/TabSlate-dev/TabSlate-server/internal/mailer"
	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots"
	"github.com/jackc/pgx/v5"
)
```

Replace:

```go
	billing        CleanupBillingProvider
	search         *search.Client
	lifecycle      *WorkspaceLifecycleService
}

func NewCleanupHandler(
```

with:

```go
	billing        CleanupBillingProvider
	search         *search.Client
	lifecycle      *WorkspaceLifecycleService
	snapshots      *snapshots.Service
}

func NewCleanupHandler(
```

Replace:

```go
		search:         sc,
		lifecycle:      firstWorkspaceLifecycleService(lifecycle),
	}
}

// Run starts the cleanup loop. Call as a goroutine; exits when ctx is cancelled.
```

with:

```go
		search:         sc,
		lifecycle:      firstWorkspaceLifecycleService(lifecycle),
	}
}

// WithSnapshots adds the daily snapshot cleanup: snapshots of bookmarks whose
// trash expired, and files that no snapshot references. Pass nil to leave it off.
func (h *CleanupHandler) WithSnapshots(service *snapshots.Service) *CleanupHandler {
	h.snapshots = service
	return h
}

// Run starts the cleanup loop. Call as a goroutine; exits when ctx is cancelled.
```

Replace:

```go
	h.phase2(ctx, nowMs, graceMs, tombstoneMs)
	h.phase3(ctx)
	h.phase4(ctx)
}

// expireWorkspaces purges state=1 Workspace roots after the user's plan
```

with:

```go
	h.phase2(ctx, nowMs, graceMs, tombstoneMs)
	h.phase3(ctx)
	h.phase4(ctx)
	if h.snapshots != nil {
		if err := h.snapshots.RemoveGoneEverywhere(ctx); err != nil {
			log.Printf("cleanup snapshots: %v", err)
		}
		if err := h.snapshots.CollectGarbage(ctx); err != nil {
			log.Printf("cleanup snapshot files: %v", err)
		}
	}
}

// expireWorkspaces purges state=1 Workspace roots after the user's plan
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/handler/
GOTOOLCHAIN=local go test -p 1 -count=1 ./internal/handler/ -v -run 'TestSyncPullReturnsSnapshots|TestSyncPushTriggersSnapshots|TestBookmarkRESTWritesTriggerSnapshots|TestCleanupRemovesSnapshotsOfExpiredTrash'
```

Expected: the whole handler package passes, including every existing sync and pull test (the earlier `server_seq` read changes no expected value), and the four new tests pass.

- [ ] **Step 8: Commit**

```bash
git add internal/model/model.go internal/handler/sync.go internal/handler/bookmarks.go internal/handler/cleanup.go \
  internal/handler/snapshot_sync_test.go
git commit -m "feat(snapshots): sync snapshot rows and trigger snapshots from writes and cleanup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- internal/model/model.go internal/handler/sync.go \
  internal/handler/bookmarks.go internal/handler/cleanup.go internal/handler/snapshot_sync_test.go
```

---

### Task 13: Configuration, wiring, and the worker binary

**Files:**
- Create: `app/snapshots.go`, `cmd/fetcher/main.go`
- Modify: `app/config.go`, `app/server.go`, `cmd/reindex/main.go`
- Test: `app/snapshots_test.go`

**Interfaces:**
- Consumes: everything above.
- Produces (public, for C2-3):
  - `app.SnapshotConfig{Storage blobstore.Config; URLSecret, URLSecretPrevious string; MaxAttemptsPerDay int; BrowserURL, BrowserToken, MonolithPath string; WorkerConcurrency int}` and `Config.Snapshots`.
  - `app.FetcherConfig{DatabaseURL, RedisURL, MeiliSearchHost, MeiliSearchAPIKey string; Snapshots SnapshotConfig}` and `app.LoadFetcherConfig()`. It needs `DATABASE_URL` but no `JWT_SECRET`.
  - `app.Option`, `app.WithSnapshotQueue(jobqueue.Queue) Option`, and `app.New(cfg, database, bp, ctx, opts ...Option)`.
  - `app.RunFetcher(ctx, cfg *FetcherConfig, database *db.DB, worker jobqueue.Worker) error`.
  - Routes:
    - `POST /snapshots`, `GET`/`PUT /snapshots/settings`, `POST /snapshots/:bookmarkId/archive`, `DELETE /snapshots/:bookmarkId`, and `DELETE /snapshots/:bookmarkId/archive`. They are verified only and rate limited to 60 requests per minute per user.
    - `GET /snapshot-assets/:assetId`, which is public; the signed URL is the credential.
  - `cmd/fetcher`.
  - Environment variables (read by `loadSnapshotConfig`):
    - storage: `SNAPSHOT_STORAGE`, `SNAPSHOT_LOCAL_DIR`, and `SNAPSHOT_S3_ENDPOINT`, `_REGION` (default `us-east-1`), `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_PATH_STYLE`;
    - URL signing: `SNAPSHOT_URL_SECRET` and `SNAPSHOT_URL_SECRET_PREVIOUS`;
    - limits: `SNAPSHOT_MAX_ATTEMPTS_PER_DAY` (default 0);
    - worker: `SNAPSHOT_BROWSER_URL`, `SNAPSHOT_BROWSER_TOKEN`, `SNAPSHOT_MONOLITH_PATH`, and `SNAPSHOT_WORKER_CONCURRENCY` (default 4).

- [ ] **Step 1: Write the failing tests**

The tests cover:
- reading the variables and their defaults;
- `LoadFetcherConfig` without `JWT_SECRET`;
- `newSnapshotService` in each case: off without storage, off without a queue, on with an injected queue, on with Redis (miniredis), and an error for a short secret;
- `RunFetcher` refusing to start without storage or a browser.

Create `app/snapshots_test.go`:

```go
package app

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TabSlate-dev/TabSlate-server/billing/local"
	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
	"github.com/alicebob/miniredis/v2"
)

const testSnapshotSecret = "0123456789abcdef0123456789abcdef"

type nopQueue struct{}

func (nopQueue) Enqueue(context.Context, jobqueue.Job) error { return nil }

func TestLoadSnapshotConfig(t *testing.T) {
	for key, value := range map[string]string{
		"SNAPSHOT_STORAGE":              "s3",
		"SNAPSHOT_S3_ENDPOINT":          "http://minio:9000",
		"SNAPSHOT_S3_BUCKET":            "snapshots",
		"SNAPSHOT_S3_ACCESS_KEY_ID":     "key",
		"SNAPSHOT_S3_SECRET_ACCESS_KEY": "secret",
		"SNAPSHOT_S3_PATH_STYLE":        "true",
		"SNAPSHOT_URL_SECRET":           testSnapshotSecret,
		"SNAPSHOT_MAX_ATTEMPTS_PER_DAY": "1000",
		"SNAPSHOT_BROWSER_URL":          "ws://obscura:9222/devtools/browser",
		"SNAPSHOT_WORKER_CONCURRENCY":   "8",
	} {
		t.Setenv(key, value)
	}
	cfg := loadSnapshotConfig()
	want := blobstore.S3Config{
		Endpoint: "http://minio:9000", Region: "us-east-1", Bucket: "snapshots",
		AccessKeyID: "key", SecretAccessKey: "secret", PathStyle: true,
	}
	if cfg.Storage.Kind != "s3" || cfg.Storage.S3 != want || cfg.URLSecret != testSnapshotSecret ||
		cfg.MaxAttemptsPerDay != 1000 || cfg.BrowserURL != "ws://obscura:9222/devtools/browser" || cfg.WorkerConcurrency != 8 {
		t.Fatalf("config = %+v", cfg)
	}
}

func TestSnapshotConfigDefaults(t *testing.T) {
	cfg := loadSnapshotConfig()
	if cfg.Storage.Kind != "" || cfg.MaxAttemptsPerDay != 0 || cfg.WorkerConcurrency != 4 || cfg.Storage.S3.Region != "us-east-1" {
		t.Fatalf("defaults = %+v", cfg)
	}
}

func TestLoadFetcherConfigNeedsNoLoginSecret(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://fetcher@db/tabslate")
	t.Setenv("JWT_SECRET", "")
	t.Setenv("REDIS_URL", "redis://redis:6379")
	cfg := LoadFetcherConfig()
	if cfg.DatabaseURL != "postgres://fetcher@db/tabslate" || cfg.RedisURL != "redis://redis:6379" {
		t.Fatalf("config = %+v", cfg)
	}
}

func snapshotTestConfig(t *testing.T) *Config {
	return &Config{Snapshots: SnapshotConfig{
		Storage:   blobstore.Config{Kind: "local", LocalDir: filepath.Join(t.TempDir(), "snapshots")},
		URLSecret: testSnapshotSecret,
	}}
}

func TestNewSnapshotService(t *testing.T) {
	hub := pubsub.NewInMemoryHub()
	defer hub.Close()

	t.Run("off without storage", func(t *testing.T) {
		service, cleanup, err := newSnapshotService(&Config{}, nil, local.New(nil), nil, hub, nopQueue{})
		defer cleanup()
		if service != nil || err != nil {
			t.Fatalf("service = %v, err = %v; want snapshots off", service, err)
		}
	})
	t.Run("off without a queue", func(t *testing.T) {
		service, cleanup, err := newSnapshotService(snapshotTestConfig(t), nil, local.New(nil), nil, hub, nil)
		defer cleanup()
		if service != nil || err != nil {
			t.Fatalf("service = %v, err = %v; want snapshots off", service, err)
		}
	})
	t.Run("on with an injected queue", func(t *testing.T) {
		service, cleanup, err := newSnapshotService(snapshotTestConfig(t), nil, local.New(nil), nil, hub, nopQueue{})
		defer cleanup()
		if service == nil || err != nil {
			t.Fatalf("service = %v, err = %v; want snapshots on", service, err)
		}
	})
	t.Run("on with Redis", func(t *testing.T) {
		cfg := snapshotTestConfig(t)
		cfg.RedisURL = "redis://" + miniredis.RunT(t).Addr()
		service, cleanup, err := newSnapshotService(cfg, nil, local.New(nil), nil, hub, nil)
		defer cleanup()
		if service == nil || err != nil {
			t.Fatalf("service = %v, err = %v; want snapshots on", service, err)
		}
	})
	t.Run("short URL secret", func(t *testing.T) {
		cfg := snapshotTestConfig(t)
		cfg.Snapshots.URLSecret = "short"
		service, cleanup, err := newSnapshotService(cfg, nil, local.New(nil), nil, hub, nopQueue{})
		defer cleanup()
		if service != nil || err == nil {
			t.Fatalf("service = %v, err = %v; want an error", service, err)
		}
	})
}

func TestRunFetcherNeedsStorageAndBrowser(t *testing.T) {
	if err := RunFetcher(t.Context(), &FetcherConfig{}, nil, nil); err == nil || !strings.Contains(err.Error(), "SNAPSHOT_STORAGE") {
		t.Fatalf("RunFetcher without storage = %v", err)
	}
	cfg := &FetcherConfig{Snapshots: SnapshotConfig{Storage: blobstore.Config{Kind: "local", LocalDir: t.TempDir()}}}
	if err := RunFetcher(t.Context(), cfg, nil, nil); err == nil || !strings.Contains(err.Error(), "SNAPSHOT_BROWSER_URL") {
		t.Fatalf("RunFetcher without a browser = %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
GOTOOLCHAIN=local go test -count=1 ./app/
```

Expected: the build fails with `undefined: loadSnapshotConfig` and `undefined: LoadFetcherConfig`.

- [ ] **Step 3: Write the configuration and the worker wiring**

How the wiring works:
- `newSnapshotService` returns a nil service when storage or a queue is missing, and returns an error for a configuration error.
- `RunFetcher` assembles the worker:
  - netguard's guard;
  - obscura through `browser.Browser`;
  - the capturer, with monolith from `SNAPSHOT_MONOLITH_PATH` or the `PATH`;
  - storage and the search client;
  - the hub, so results reach SSE clients through Redis pub/sub.

Create `app/snapshots.go`:

```go
package app

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"

	"github.com/TabSlate-dev/TabSlate-server/billing"
	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
	"github.com/TabSlate-dev/TabSlate-server/internal/browser"
	"github.com/TabSlate-dev/TabSlate-server/internal/infra"
	"github.com/TabSlate-dev/TabSlate-server/internal/netguard"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots/capture"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue/redisqueue"
)

// SnapshotConfig configures web snapshots. The API turns them on when
// storage, a queue, and a URL secret are configured; cmd/fetcher also needs
// the browser.
type SnapshotConfig struct {
	// Storage holds snapshot files. An empty kind (SNAPSHOT_STORAGE unset)
	// turns snapshots off.
	Storage blobstore.Config

	// URLSecret signs file URLs. During a key rotation URLSecretPrevious is
	// accepted as well.
	URLSecret         string
	URLSecretPrevious string

	// MaxAttemptsPerDay caps capture attempts per user per UTC day; 0 is unlimited.
	MaxAttemptsPerDay int

	// BrowserURL is obscura's CDP endpoint, e.g. ws://obscura:9222/devtools/browser,
	// and BrowserToken its OBSCURA_CDP_TOKEN.
	BrowserURL   string
	BrowserToken string

	// MonolithPath is the monolith binary. Empty looks for monolith on the
	// PATH; without it full-page archives are off.
	MonolithPath string

	// WorkerConcurrency is how many jobs one fetcher runs at a time.
	WorkerConcurrency int
}

func loadSnapshotConfig() SnapshotConfig {
	return SnapshotConfig{
		Storage: blobstore.Config{
			Kind:     os.Getenv("SNAPSHOT_STORAGE"),
			LocalDir: os.Getenv("SNAPSHOT_LOCAL_DIR"),
			S3: blobstore.S3Config{
				Endpoint:        os.Getenv("SNAPSHOT_S3_ENDPOINT"),
				Region:          envOr("SNAPSHOT_S3_REGION", "us-east-1"),
				Bucket:          os.Getenv("SNAPSHOT_S3_BUCKET"),
				AccessKeyID:     os.Getenv("SNAPSHOT_S3_ACCESS_KEY_ID"),
				SecretAccessKey: os.Getenv("SNAPSHOT_S3_SECRET_ACCESS_KEY"),
				PathStyle:       os.Getenv("SNAPSHOT_S3_PATH_STYLE") == "true",
			},
		},
		URLSecret:         os.Getenv("SNAPSHOT_URL_SECRET"),
		URLSecretPrevious: os.Getenv("SNAPSHOT_URL_SECRET_PREVIOUS"),
		MaxAttemptsPerDay: envInt("SNAPSHOT_MAX_ATTEMPTS_PER_DAY", 0),
		BrowserURL:        os.Getenv("SNAPSHOT_BROWSER_URL"),
		BrowserToken:      os.Getenv("SNAPSHOT_BROWSER_TOKEN"),
		MonolithPath:      os.Getenv("SNAPSHOT_MONOLITH_PATH"),
		WorkerConcurrency: envInt("SNAPSHOT_WORKER_CONCURRENCY", 4),
	}
}

// FetcherConfig configures cmd/fetcher. It needs no login secrets.
type FetcherConfig struct {
	DatabaseURL       string
	RedisURL          string
	MeiliSearchHost   string
	MeiliSearchAPIKey string
	Snapshots         SnapshotConfig
}

// LoadFetcherConfig reads FetcherConfig from environment variables and
// fatals when DATABASE_URL is missing.
func LoadFetcherConfig() *FetcherConfig {
	return &FetcherConfig{
		DatabaseURL:       mustEnv("DATABASE_URL"),
		RedisURL:          os.Getenv("REDIS_URL"),
		MeiliSearchHost:   os.Getenv("MEILISEARCH_HOST"),
		MeiliSearchAPIKey: os.Getenv("MEILISEARCH_API_KEY"),
		Snapshots:         loadSnapshotConfig(),
	}
}

// Option changes how New builds the server.
type Option func(*options)

type options struct {
	snapshotQueue jobqueue.Queue
}

// WithSnapshotQueue sets the queue for web snapshot jobs instead of the Redis
// queue on REDIS_URL. TabSlate Cloud passes its Hatchet queue.
func WithSnapshotQueue(queue jobqueue.Queue) Option {
	return func(o *options) { o.snapshotQueue = queue }
}

// newSnapshotService returns the snapshot service, or nil when snapshots are
// off because storage or a queue is missing. The cleanup function closes the
// Redis queue it may have opened.
func newSnapshotService(cfg *Config, database *db.DB, bp billing.Provider, sc *search.Client, hub pubsub.Hub, queue jobqueue.Queue) (*snapshots.Service, func(), error) {
	noCleanup := func() {}
	snap := cfg.Snapshots
	if snap.Storage.Kind == "" {
		log.Println("web snapshots off: SNAPSHOT_STORAGE is not set")
		return nil, noCleanup, nil
	}
	cleanup := noCleanup
	if queue == nil {
		if cfg.RedisURL == "" {
			log.Println("web snapshots off: no job queue (set REDIS_URL)")
			return nil, noCleanup, nil
		}
		redisQueue, err := redisqueue.New(cfg.RedisURL)
		if err != nil {
			return nil, noCleanup, err
		}
		queue = redisQueue
		cleanup = func() { _ = redisQueue.Close() }
	}
	store, err := blobstore.Open(snap.Storage)
	if err != nil {
		cleanup()
		return nil, noCleanup, err
	}
	signer, err := snapshots.NewSigner(snap.URLSecret, snap.URLSecretPrevious)
	if err != nil {
		cleanup()
		return nil, noCleanup, err
	}
	var text snapshots.TextIndex
	if sc != nil {
		text = sc
	}
	service := snapshots.NewService(snapshots.Config{
		DB: database, Store: store, Queue: queue, Signer: signer, Hub: hub,
		Limits: bp, Text: text, MaxAttemptsPerDay: snap.MaxAttemptsPerDay,
	})
	log.Printf("web snapshots on (%s storage)", snap.Storage.Kind)
	return service, cleanup, nil
}

// RunFetcher runs the web snapshot worker until ctx is cancelled. worker
// delivers the jobs: cmd/fetcher passes the Redis queue, and TabSlate Cloud
// passes its own.
func RunFetcher(ctx context.Context, cfg *FetcherConfig, database *db.DB, worker jobqueue.Worker) error {
	snap := cfg.Snapshots
	store, err := blobstore.Open(snap.Storage)
	if err != nil {
		return err
	}
	if store == nil {
		return errors.New("SNAPSHOT_STORAGE is not set")
	}
	if snap.BrowserURL == "" {
		return errors.New("SNAPSHOT_BROWSER_URL is not set")
	}
	infraProviders, infraCleanup, err := infra.New(cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("infra: %w", err)
	}
	defer infraCleanup()

	monolith := snap.MonolithPath
	if monolith == "" {
		if path, err := exec.LookPath("monolith"); err == nil {
			monolith = path
		}
	}
	if monolith == "" {
		log.Println("monolith not found: full-page archives are off")
	}
	capturer := capture.New(capture.Config{
		Guard:        netguard.New(netguard.Options{}),
		Renderer:     &browser.Browser{URL: snap.BrowserURL, Token: snap.BrowserToken, Limits: browser.DefaultLimits},
		MonolithPath: monolith,
	})
	var text snapshots.TextIndex
	if sc := search.New(cfg.MeiliSearchHost, cfg.MeiliSearchAPIKey); sc != nil {
		text = sc
	}
	w := snapshots.NewWorker(snapshots.WorkerConfig{
		DB: database, Store: store, Capturer: capturer, Hub: infraProviders.Hub, Text: text,
	})
	log.Printf("snapshot worker running (%s storage)", snap.Storage.Kind)
	return worker.Run(ctx, w.Handle)
}
```

In `app/config.go`:

Replace:

```go
	// automatically promoted to permanently deleted (state=2). The cleanup
	// goroutine uses this value. Defaults to 7.
	TrashGraceDays int
}

// LoadConfig reads configuration from environment variables and fatals on any
```

with:

```go
	// automatically promoted to permanently deleted (state=2). The cleanup
	// goroutine uses this value. Defaults to 7.
	TrashGraceDays int

	// Snapshots configures web snapshots (SNAPSHOT_* variables).
	Snapshots SnapshotConfig
}

// LoadConfig reads configuration from environment variables and fatals on any
```

Replace:

```go
		}),

		TrashGraceDays: envInt("TRASH_GRACE_DAYS", 7),
	}
}
```

with:

```go
		}),

		TrashGraceDays: envInt("TRASH_GRACE_DAYS", 7),

		Snapshots: loadSnapshotConfig(),
	}
}
```

- [ ] **Step 4: Wire the server**

`New` builds the service, checks the URL key, and starts the scheduler, as described in Note 9. It hands the service to the bookmark, sync, cleanup, and snapshot handlers, registers the routes, and closes the Redis queue on shutdown.

In `app/server.go`:

Replace:

```go
	"github.com/TabSlate-dev/TabSlate-server/internal/mailer"
	"github.com/TabSlate-dev/TabSlate-server/internal/middleware"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)
```

with:

```go
	"github.com/TabSlate-dev/TabSlate-server/internal/mailer"
	"github.com/TabSlate-dev/TabSlate-server/internal/middleware"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)
```

Replace:

```go
	ctx          context.Context
	infra        *infra.Providers
	infraCleanup func()
}

// New creates and configures the server. Captcha and mailer services are
```

with:

```go
	ctx          context.Context
	infra        *infra.Providers
	infraCleanup func()
	// snapshots is nil when web snapshots are off.
	snapshots        *snapshots.Service
	snapshotsCleanup func()
}

// New creates and configures the server. Captcha and mailer services are
```

Replace:

```go
// need to import internal packages. Call Run to start listening.
// ctx controls background goroutines (cleanup tasks); pass a context tied to
// the process lifetime, e.g. a signal-cancellable context from main.
func New(cfg *Config, database *db.DB, bp billing.Provider, ctx context.Context) *Server {
	if cfg.GinMode != "" {
		gin.SetMode(cfg.GinMode)
	}
```

with:

```go
// need to import internal packages. Call Run to start listening.
// ctx controls background goroutines (cleanup tasks); pass a context tied to
// the process lifetime, e.g. a signal-cancellable context from main.
// opts inject edition-specific parts, such as the snapshot job queue.
func New(cfg *Config, database *db.DB, bp billing.Provider, ctx context.Context, opts ...Option) *Server {
	var o options
	for _, opt := range opts {
		opt(&o)
	}

	if cfg.GinMode != "" {
		gin.SetMode(cfg.GinMode)
	}
```

Replace:

```go
		log.Fatalf("infra: %v", err)
	}

	r := gin.Default()
	if err := r.SetTrustedProxies(cfg.TrustedProxies); err != nil {
		log.Fatalf("router: SetTrustedProxies: %v", err)
```

with:

```go
		log.Fatalf("infra: %v", err)
	}

	snapshotService, snapshotsCleanup, err := newSnapshotService(cfg, database, bp, sc, infraProviders.Hub, o.snapshotQueue)
	if err != nil {
		log.Fatalf("snapshots: %v", err)
	}
	if snapshotService != nil {
		if err := snapshotService.CheckURLKey(ctx); err != nil {
			log.Fatalf("snapshots: check URL key: %v", err)
		}
		go snapshotService.RunScheduler(ctx)
	}

	r := gin.Default()
	if err := r.SetTrustedProxies(cfg.TrustedProxies); err != nil {
		log.Fatalf("router: SetTrustedProxies: %v", err)
```

Replace:

```go
		ctx:          ctx,
		infra:        infraProviders,
		infraCleanup: infraCleanup,
	}
	s.lifecycle = handler.NewWorkspaceLifecycleService(database, s.infra.Hub, s.search)
	s.setupCORS()
	s.setupRoutes()
	var cleanupBilling handler.CleanupBillingProvider = s.billing
	cleanupH := handler.NewCleanupHandler(database, cfg.TrashGraceDays, s.mailer, cleanupBilling, s.search, s.lifecycle)
	go cleanupH.Run(ctx)
	return s
}
```

with:

```go
		ctx:          ctx,
		infra:        infraProviders,
		infraCleanup: infraCleanup,

		snapshots:        snapshotService,
		snapshotsCleanup: snapshotsCleanup,
	}
	s.lifecycle = handler.NewWorkspaceLifecycleService(database, s.infra.Hub, s.search)
	s.setupCORS()
	s.setupRoutes()
	var cleanupBilling handler.CleanupBillingProvider = s.billing
	cleanupH := handler.NewCleanupHandler(database, cfg.TrashGraceDays, s.mailer, cleanupBilling, s.search, s.lifecycle).
		WithSnapshots(s.snapshots)
	go cleanupH.Run(ctx)
	return s
}
```

Replace:

```go
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown: %v", err)
	}
	s.infraCleanup()
}
```

with:

```go
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown: %v", err)
	}
	s.snapshotsCleanup()
	s.infraCleanup()
}
```

Replace:

```go
	captchaH := handler.NewCaptchaHandler(s.cfg.ProsopoBundleURL)
	wsH := handler.NewWorkspaceHandler(s.db, s.infra.Hub, s.billing, s.lifecycle)
	colH := handler.NewCollectionHandler(s.db, s.infra.Hub, s.billing)
	bmH := handler.NewBookmarkHandler(s.db, s.search, s.infra.Hub, s.billing)
	tagH := handler.NewTagHandler(s.db, s.infra.Hub, s.billing)
	syncH := handler.NewSyncHandler(s.db, s.search, s.infra.Hub, s.billing, s.lifecycle)
	searchH := handler.NewSearchHandler(s.db, s.search)
	sseH := handler.NewSSEHandler(s.infra.Hub, s.infra.Cache)
	billH := handler.NewBillingHandler(s.billing, s.infra.Cache, s.db)
```

with:

```go
	captchaH := handler.NewCaptchaHandler(s.cfg.ProsopoBundleURL)
	wsH := handler.NewWorkspaceHandler(s.db, s.infra.Hub, s.billing, s.lifecycle)
	colH := handler.NewCollectionHandler(s.db, s.infra.Hub, s.billing)
	bmH := handler.NewBookmarkHandler(s.db, s.search, s.infra.Hub, s.billing).WithSnapshots(s.snapshots)
	tagH := handler.NewTagHandler(s.db, s.infra.Hub, s.billing)
	syncH := handler.NewSyncHandler(s.db, s.search, s.infra.Hub, s.billing, s.lifecycle).WithSnapshots(s.snapshots)
	snapH := handler.NewSnapshotHandler(s.snapshots)
	searchH := handler.NewSearchHandler(s.db, s.search)
	sseH := handler.NewSSEHandler(s.infra.Hub, s.infra.Cache)
	billH := handler.NewBillingHandler(s.billing, s.infra.Cache, s.db)
```

Replace:

```go
	// ── SSE stream — unauthenticated (SSE token auth inside handler) ─────────
	s.router.GET("/sync/stream", sseH.Stream)

	// ── Protected routes ──────────────────────────────────────────────────────
	api := s.router.Group("/")
```

with:

```go
	// ── SSE stream — unauthenticated (SSE token auth inside handler) ─────────
	s.router.GET("/sync/stream", sseH.Stream)

	// ── Snapshot files — the signed URL is the credential ───────────────────
	s.router.GET("/snapshot-assets/:assetId", snapH.ServeAsset)

	// ── Protected routes ──────────────────────────────────────────────────────
	api := s.router.Group("/")
```

Replace:

```go
				authH.IssueSSEToken,
			)

			verified.POST("/sync/push", func(c *gin.Context) {
				c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 512*1024)
				c.Next()
```

with:

```go
				authH.IssueSSEToken,
			)

			snapshotLimit := middleware.RateLimitByUser(s.infra.Limiter, 60, time.Minute)
			verified.POST("/snapshots", snapshotLimit, snapH.Request)
			verified.GET("/snapshots/settings", snapshotLimit, snapH.GetSettings)
			verified.PUT("/snapshots/settings", snapshotLimit, snapH.PutSettings)
			verified.POST("/snapshots/:bookmarkId/archive", snapshotLimit, snapH.RequestArchive)
			verified.DELETE("/snapshots/:bookmarkId", snapshotLimit, snapH.Delete)
			verified.DELETE("/snapshots/:bookmarkId/archive", snapshotLimit, snapH.DeleteArchive)

			verified.POST("/sync/push", func(c *gin.Context) {
				c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 512*1024)
				c.Next()
```

- [ ] **Step 5: Add the worker binary**

Create `cmd/fetcher/main.go`:

```go
// Command fetcher runs web snapshot jobs from the Redis queue (Asynq): it
// renders pages in obscura and saves snapshot files to snapshot storage.
// TabSlate Cloud runs the same worker through app.RunFetcher with its own queue.
//
// Required env vars: DATABASE_URL, REDIS_URL, SNAPSHOT_STORAGE (with its
// settings), SNAPSHOT_BROWSER_URL, and SNAPSHOT_BROWSER_TOKEN.
package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/TabSlate-dev/TabSlate-server/app"
	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/jobqueue/redisqueue"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	cfg := app.LoadFetcherConfig()
	if cfg.RedisURL == "" {
		log.Fatal("REDIS_URL is not set: the snapshot worker takes its jobs from Redis")
	}

	database, err := db.Open(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("connect db: %v", err)
	}
	defer database.Close()

	worker, err := redisqueue.NewWorker(cfg.RedisURL, cfg.Snapshots.WorkerConcurrency)
	if err != nil {
		log.Fatalf("queue: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := app.RunFetcher(ctx, cfg, database, worker); err != nil {
		log.Fatalf("fetcher: %v", err)
	}
}
```

- [ ] **Step 6: Include snapshot text in the reindex**

In `cmd/reindex/main.go`:

Replace:

```go
// Command reindex drops the MeiliSearch bookmarks index and rebuilds it
// from the PostgreSQL bookmarks table. Useful when the index drifts out of
// sync (e.g. after a bulk import, schema change, or MeiliSearch data loss).
//
// Usage:
//
```

with:

```go
// Command reindex drops the MeiliSearch bookmarks and snapshots indexes and
// rebuilds them from the PostgreSQL bookmarks table and the stored reader
// versions of web snapshots. Useful when the indexes drift out of sync (e.g.
// after a bulk import, schema change, or MeiliSearch data loss).
//
// Usage:
//
```

Replace:

```go
//	go run ./cmd/reindex -batch 500
//
// Required env vars: DATABASE_URL, MEILISEARCH_HOST, MEILISEARCH_API_KEY.
package main

import (
```

with:

```go
//	go run ./cmd/reindex -batch 500
//
// Required env vars: DATABASE_URL, MEILISEARCH_HOST, MEILISEARCH_API_KEY.
// Snapshot text needs the SNAPSHOT_STORAGE settings as well; without them
// only bookmarks are indexed.
package main

import (
```

Replace:

```go
	"github.com/TabSlate-dev/TabSlate-server/app"
	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/joho/godotenv"
	meilisearch "github.com/meilisearch/meilisearch-go"
)
```

with:

```go
	"github.com/TabSlate-dev/TabSlate-server/app"
	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/blobstore"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
	"github.com/TabSlate-dev/TabSlate-server/internal/snapshots"
	"github.com/joho/godotenv"
	meilisearch "github.com/meilisearch/meilisearch-go"
)
```

Replace:

```go
	defer database.Close()
	log.Println("database connected")

	// ── Delete old MeiliSearch index ─────────────────────────────────────────
	svc := meilisearch.New(cfg.MeiliSearchHost, meilisearch.WithAPIKey(cfg.MeiliSearchAPIKey))
	log.Println("deleting index \"bookmarks\"...")

	task, err := svc.DeleteIndex("bookmarks")
	if err != nil {
		// 404 = index doesn't exist yet, that's fine.
		log.Printf("delete index (may not exist): %v", err)
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := svc.WaitForTaskWithContext(ctx, task.TaskUID, 100*time.Millisecond); err != nil {
			log.Printf("wait for delete task: %v", err)
		}
		log.Println("old index deleted")
	}

	// ── Recreate index with settings ─────────────────────────────────────────
```

with:

```go
	defer database.Close()
	log.Println("database connected")

	// ── Delete old MeiliSearch indexes ───────────────────────────────────────
	svc := meilisearch.New(cfg.MeiliSearchHost, meilisearch.WithAPIKey(cfg.MeiliSearchAPIKey))
	for _, index := range []string{"bookmarks", "snapshots"} {
		log.Printf("deleting index %q...", index)
		task, err := svc.DeleteIndex(index)
		if err != nil {
			// 404 = index doesn't exist yet, that's fine.
			log.Printf("delete index (may not exist): %v", err)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		if _, err := svc.WaitForTaskWithContext(ctx, task.TaskUID, 100*time.Millisecond); err != nil {
			log.Printf("wait for delete task: %v", err)
		}
		cancel()
		log.Printf("old index %q deleted", index)
	}

	// ── Recreate index with settings ─────────────────────────────────────────
```

Replace:

```go
	}

	log.Printf("done — %d bookmarks indexed from %d total rows", indexed, total)
}

// flushBatch sends a batch of documents to MeiliSearch using the search.Client.
```

with:

```go
	}

	log.Printf("done — %d bookmarks indexed from %d total rows", indexed, total)

	// ── Index snapshot text from stored reader versions ──────────────────────
	store, err := blobstore.Open(cfg.Snapshots.Storage)
	if err != nil {
		log.Fatalf("snapshot storage: %v", err)
	}
	if store == nil {
		log.Println("SNAPSHOT_STORAGE is not set — skipping snapshot text")
		return
	}
	texts := make([]search.SnapshotTextDoc, 0, *batchSize)
	textCount := 0
	flushTexts := func() error {
		if err := sc.BulkUpsertSnapshotTexts(texts); err != nil {
			return fmt.Errorf("bulk upsert snapshot texts: %w", err)
		}
		textCount += len(texts)
		texts = texts[:0]
		return nil
	}
	err = snapshots.EachReaderText(ctx, database, store, func(bookmarkID, userID, text string) error {
		texts = append(texts, search.SnapshotTextDoc{ID: bookmarkID, UserID: userID, Content: text})
		if len(texts) < *batchSize {
			return nil
		}
		return flushTexts()
	})
	if err == nil {
		err = flushTexts()
	}
	if err != nil {
		log.Fatalf("index snapshot text: %v", err)
	}
	log.Printf("done — %d snapshot texts indexed", textCount)
}

// flushBatch sends a batch of documents to MeiliSearch using the search.Client.
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
GOTOOLCHAIN=local go test -count=1 ./app/ -v
GOTOOLCHAIN=local go build ./... && GOTOOLCHAIN=local go vet ./...
gofmt -l app cmd/fetcher cmd/reindex
```

Expected:
- These tests pass: `TestLoadSnapshotConfig`, `TestSnapshotConfigDefaults`, `TestLoadFetcherConfigNeedsNoLoginSecret`, `TestNewSnapshotService` (five subtests), and `TestRunFetcherNeedsStorageAndBrowser`.
- Build and vet pass.
- `gofmt` prints nothing.

- [ ] **Step 8: Check that Cloud still builds**

Cloud uses `../TabSlate-server` through a `replace` directive. Check it in a scratch copy; do not change the Cloud checkout. The commands link `/tmp/TabSlate-server` to this repository, so first check that `/tmp/TabSlate-server` does not exist; if it does, stop and ask. Then run:

```bash
rm -rf /tmp/c22-cloud-check && mkdir /tmp/c22-cloud-check
git -C /Users/lieutenant/Documents/github/TabSlate-Cloud archive main | tar -x -C /tmp/c22-cloud-check
ln -s /Users/lieutenant/Documents/github/TabSlate-server /tmp/TabSlate-server
cd /tmp/c22-cloud-check && GOTOOLCHAIN=local go mod tidy && GOTOOLCHAIN=local go build ./... && GOTOOLCHAIN=local go test ./...
rm /tmp/TabSlate-server && rm -rf /tmp/c22-cloud-check
cd /Users/lieutenant/Documents/github/TabSlate-server
```

Expected: `go mod tidy` adds the new dependencies to the scratch copy's `go.sum`, Cloud's unchanged `tabapp.New(cfg, database, bp, ctx)` call compiles, and its tests pass.

- [ ] **Step 9: Commit**

```bash
git add app/snapshots.go app/snapshots_test.go app/config.go app/server.go cmd/fetcher/main.go cmd/reindex/main.go
git commit -m "feat(snapshots): wire web snapshots into the server and add cmd/fetcher

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/snapshots.go app/snapshots_test.go \
  app/config.go app/server.go cmd/fetcher/main.go cmd/reindex/main.go
```

---

### Task 14: Docker, documentation, and full verification

**Files:**
- Modify: `Dockerfile`, `docker-compose.yml`, `.github/workflows/docker-publish.yml`, `.env.example`, `README.md`, `CLAUDE.md`, `ARCHITECTURE.md`

**Interfaces:**
- Consumes: `cmd/fetcher` and every environment variable from Task 13.
- Produces:
  - The `fetcher` build target (image `tabslate-fetcher`).
  - The compose services `fetcher`, `obscura`, and `redis` under the `snapshots` profile.
  - The documentation.

- [ ] **Step 1: Pin obscura to the checked version**

Read the `// Verified against:` comment in `internal/browser/obscura_integration_test.go`, which C2-1's Task 3 wrote. The compose file below uses `h4ckf0r0day/obscura:0.2.5`; if C2-1 recorded another tag, use that tag instead.

Image 0.2.5's entrypoint is `/obscura`, and its default command is `serve --port 9222 --host 0.0.0.0`. The README documents `--worker-max-rss` in MB and `--worker-max-age` in seconds. Confirm the flags:

```bash
docker run --rm h4ckf0r0day/obscura:0.2.5 serve --help
```

Expected: the help lists `--host`, `--workers`, `--worker-max-connections`, `--worker-max-rss`, and `--worker-max-age`. If any flag is missing, stop and report, because the compose file depends on them.

- [ ] **Step 2: Add the fetcher image**

Notes on the image:
- The server stage stays last, so `docker build .` and CI still build the API image by default.
- The fetcher stage downloads monolith v2.11.6 for the target architecture and runs `monolith -V`, so a broken download fails the build.
- The fetcher runs as uid 10001. Both images make `/data` belong to that uid, so a named volume is writable by the fetcher whichever container mounts it first.

Replace the contents of `Dockerfile` with:

```dockerfile
# ── Build stage ──────────────────────────────────────────────────────────────
FROM golang:1.25-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server ./cmd/server \
 && CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o fetcher ./cmd/fetcher

# ── Snapshot worker: docker build --target fetcher ───────────────────────────
# monolith's release binaries link against glibc, so this image is Debian.
# It runs as uid 10001, which owns /data for local snapshot storage.
FROM debian:bookworm-slim AS fetcher

ARG TARGETARCH
ARG MONOLITH_VERSION=v2.11.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
 && case "$TARGETARCH" in \
      amd64) monolith_arch=x86_64 ;; \
      arm64) monolith_arch=aarch64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/monolith \
      "https://github.com/Y2Z/monolith/releases/download/${MONOLITH_VERSION}/monolith-cli-linux-${monolith_arch}" \
 && chmod +x /usr/local/bin/monolith \
 && /usr/local/bin/monolith -V \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home fetcher \
 && mkdir -p /data && chown fetcher /data

WORKDIR /app
COPY --from=builder /app/fetcher .
USER fetcher
CMD ["./fetcher"]

# ── Run stage: the API server (the default target) ──────────────────────────
FROM alpine:3.20

# /data belongs to the fetcher's uid, so a snapshot volume first mounted
# here is writable by the fetcher too.
RUN apk add --no-cache ca-certificates tzdata \
 && mkdir -p /data && chown 10001 /data

WORKDIR /app
COPY --from=builder /app/server .

EXPOSE 8080
CMD ["./server"]
```

- [ ] **Step 3: Add the compose services**

How the services connect:
- `obscura` is only on the `browser` network. It reaches the internet, but not `api`, `redis`, or the database, and it is not published to the host.
- `fetcher` joins both networks.
- The snapshot services start only with the `snapshots` profile.

Replace the contents of `docker-compose.yml` with:

```yaml
services:
  api:
    image: ghcr.io/tabslate-dev/tabslate-server:latest
    env_file:
      - .env
    environment:
      - PORT=8080
      - GIN_MODE=release
    restart: unless-stopped
    expose:
      - "8080"
    volumes:
      # Local snapshot storage (SNAPSHOT_STORAGE=local, SNAPSHOT_LOCAL_DIR=/data).
      - snapshots:/data

  # Terminates TLS for the api service and obtains/renews a certificate
  # automatically via Let's Encrypt. Requires DOMAIN in .env to point at a
  # public DNS A/AAAA record for this host. api itself is not published to
  # the host — only reachable through Caddy — so there is no way to hit it
  # over plaintext HTTP from outside this compose network.
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      - DOMAIN=${DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - api

  # ── Web snapshots ─────────────────────────────────────────────────────────
  # The services below start only with the "snapshots" profile
  # (COMPOSE_PROFILES=snapshots in .env). See "Web snapshots" in README.md.

  # Runs snapshot jobs. It joins the browser network to reach obscura.
  fetcher:
    image: ghcr.io/tabslate-dev/tabslate-fetcher:latest
    profiles: ["snapshots"]
    env_file:
      - .env
    environment:
      - SNAPSHOT_BROWSER_URL=ws://obscura:9222/devtools/browser
      - SNAPSHOT_BROWSER_TOKEN=${OBSCURA_CDP_TOKEN}
    restart: unless-stopped
    volumes:
      - snapshots:/data
    networks:
      - default
      - browser
    depends_on:
      - api
      - obscura
      - redis

  # Headless browser for the fetcher. It is only on the browser network, so
  # pages it renders can reach the internet but not the API, Redis, or the
  # database, and it is not published to the host.
  obscura:
    image: h4ckf0r0day/obscura:0.2.5
    profiles: ["snapshots"]
    # Four worker processes, each recycled after 50 connections (one per
    # job), 1024 MB resident, or an hour.
    command:
      [
        "serve", "--port", "9222", "--host", "0.0.0.0", "--workers", "4",
        "--worker-max-connections", "50", "--worker-max-rss", "1024", "--worker-max-age", "3600",
      ]
    environment:
      - OBSCURA_CDP_TOKEN=${OBSCURA_CDP_TOKEN}
    restart: unless-stopped
    mem_limit: 4g
    cpus: 2
    networks:
      - browser

  # Job queue for snapshots. Leave it out and set REDIS_URL in .env to use
  # an external Redis instead.
  redis:
    image: redis:7-alpine
    profiles: ["snapshots"]
    command: ["redis-server", "--appendonly", "yes"]
    restart: unless-stopped
    volumes:
      - redis_data:/data

networks:
  browser: {}

volumes:
  caddy_data:
  caddy_config:
  snapshots:
  redis_data:
```

- [ ] **Step 4: Publish the fetcher image**

In `.github/workflows/docker-publish.yml`:

Append to the end of `.github/workflows/docker-publish.yml`:

```yaml
      # The snapshot worker image: the Dockerfile's fetcher stage.
      - name: Extract fetcher metadata (tags, labels)
        id: fetcher-meta
        uses: docker/metadata-action@v5
        with:
          images: |
            ghcr.io/${{ github.repository_owner }}/tabslate-fetcher
            ${{ vars.ALIYUN_ACR_REGISTRY }}/${{ vars.ALIYUN_ACR_NAMESPACE }}/tabslate-fetcher
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=ref,event=tag
            type=semver,pattern=v{{version}}
            type=semver,pattern={{version}}

      - name: Build and push fetcher image
        uses: docker/build-push-action@v6
        with:
          context: .
          target: fetcher
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.fetcher-meta.outputs.tags }}
          labels: ${{ steps.fetcher-meta.outputs.labels }}
```

- [ ] **Step 5: Document the settings**

In `.env.example`:

Append to the end of `.env.example`:

```bash
# ── Web snapshots ─────────────────────────────────────────────────────────────
# Server-side copies of saved pages: a reader version, a screenshot, a cover
# copy, and full-page archives on demand. Off unless SNAPSHOT_STORAGE, a job
# queue (REDIS_URL), and SNAPSHOT_URL_SECRET are all set. The server visits
# bookmarked URLs from its own IP address; each user can turn automatic
# snapshots off in the extension's settings.
#
# With docker-compose.yml, start the fetcher, obscura, and redis services:
# COMPOSE_PROFILES=snapshots
# and point REDIS_URL above at the bundled Redis: redis://redis:6379

# Storage: "local" or "s3". Empty turns snapshots off.
# SNAPSHOT_STORAGE=local
# Directory for SNAPSHOT_STORAGE=local; docker-compose.yml mounts the
# snapshots volume at /data.
# SNAPSHOT_LOCAL_DIR=/data

# S3 or S3-compatible storage (SNAPSHOT_STORAGE=s3).
# SNAPSHOT_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
# SNAPSHOT_S3_REGION=us-east-1
# SNAPSHOT_S3_BUCKET=
# SNAPSHOT_S3_ACCESS_KEY_ID=
# SNAPSHOT_S3_SECRET_ACCESS_KEY=
# Set to true for MinIO and other stores that need path-style URLs.
# SNAPSHOT_S3_PATH_STYLE=false

# [required for snapshots] Signs snapshot file URLs; separate from JWT_SECRET.
# Generate with: openssl rand -hex 32
# SNAPSHOT_URL_SECRET=
# During a key rotation, the old key. Remove it once clients have synced.
# SNAPSHOT_URL_SECRET_PREVIOUS=

# [required for docker-compose.yml snapshots] CDP token that obscura requires
# and the fetcher sends; at least 32 bytes. Generate with: openssl rand -hex 32
# OBSCURA_CDP_TOKEN=

# Capture attempts per user per UTC day; 0 = unlimited (default).
# SNAPSHOT_MAX_ATTEMPTS_PER_DAY=0

# cmd/fetcher outside docker-compose.yml (which sets the browser URL and token):
# SNAPSHOT_BROWSER_URL=ws://localhost:9222/devtools/browser
# SNAPSHOT_BROWSER_TOKEN=
# SNAPSHOT_WORKER_CONCURRENCY=4
# Without monolith on the PATH, full-page archives are off.
# SNAPSHOT_MONOLITH_PATH=/usr/local/bin/monolith
```

In `README.md`:

Replace:

```markdown
  * `MEILISEARCH_HOST` and `MEILISEARCH_API_KEY`.
* **Prosopo CAPTCHA**: Used for bot protection during registration and login.
  * `PROSOPO_SECRET`.

### Other Configuration
| Variable | Description | Default |
```

with:

```markdown
  * `MEILISEARCH_HOST` and `MEILISEARCH_API_KEY`.
* **Prosopo CAPTCHA**: Used for bot protection during registration and login.
  * `PROSOPO_SECRET`.
* **Web snapshots**: Server-side copies of saved pages (a reader version, a screenshot, and full-page archives on demand), so bookmarks stay readable after their sites disappear. They need storage (a local directory or S3-compatible), Redis as the job queue, the `fetcher` worker, and the [obscura](https://github.com/h4ckf0r0day/obscura) headless browser.
  * `SNAPSHOT_STORAGE`, `SNAPSHOT_URL_SECRET`, `OBSCURA_CDP_TOKEN`, and `REDIS_URL`; see [Web snapshots](#web-snapshots).

### Other Configuration
| Variable | Description | Default |
```

Replace:

```markdown
| `ALLOW_REGISTRATION` | Set to `false` to disable new user signups. | `true` |

For the complete list of tunable parameters (such as rate limits and specific mail provider configurations), see the [`.env.example`](.env.example) file.

---
```

with:

```markdown
| `ALLOW_REGISTRATION` | Set to `false` to disable new user signups. | `true` |

For the complete list of tunable parameters (such as rate limits and specific mail provider configurations), see the [`.env.example`](.env.example) file.

### Web snapshots

Web snapshots are off until you configure them, so upgrading changes nothing by itself. To turn them on with the bundled `docker-compose.yml`:

1. In `.env`, set:
   * `COMPOSE_PROFILES=snapshots`, which starts the `fetcher`, `obscura`, and `redis` services;
   * `REDIS_URL=redis://redis:6379` (or your own Redis);
   * `SNAPSHOT_STORAGE=local` and `SNAPSHOT_LOCAL_DIR=/data`, or the `SNAPSHOT_S3_*` settings for S3 or MinIO;
   * `SNAPSHOT_URL_SECRET` and `OBSCURA_CDP_TOKEN`, each from `openssl rand -hex 32`.
2. Run `docker-compose up -d`.

**Privacy.** The server fetches bookmarked pages from its own IP address, for new bookmarks and gradually for existing ones. Each user can turn automatic snapshots off in the extension's settings; snapshots they request themselves keep working. obscura runs on its own Docker network, which reaches the internet but not the API, Redis, or the database.

To rebuild the search index, including the text of saved snapshots, run `go run ./cmd/reindex` with the same environment.

---
```

- [ ] **Step 6: Update CLAUDE.md and ARCHITECTURE.md**

In `CLAUDE.md`:

Replace:

````markdown
go vet ./...            # 静态分析
go test ./...           # 运行所有测试
go test ./internal/...  # 运行某个包的测试
go run ./cmd/server     # 本地启动（需要 .env 文件）
```
````

with:

````markdown
go vet ./...            # 静态分析
go test ./...           # 运行所有测试
go test ./internal/...  # 运行某个包的测试
TEST_DATABASE_URL=postgres://... go test -p 1 ./...  # 连同数据库测试；handler 与 snapshots 的测试共用数据表，必须 -p 1
go run ./cmd/server     # 本地启动（需要 .env 文件）
```
````

Replace:

```markdown
| GET/POST/PUT/DELETE | `/collections[/:id]` 🔒 | 集合 CRUD |
| GET/POST/PUT/DELETE | `/bookmarks[/:id]` 🔒 | 书签 CRUD |
| GET/POST/PUT/DELETE | `/tags[/:id]` 🔒 | 标签 CRUD |
| GET | `/search` 🔒 | 全文搜索（`?q=`，≥2 字符，需 MeiliSearch） |
| POST | `/sync/push` 🔒 | 增量推送变更（含 groups） |
| GET | `/sync/pull` 🔒 | 拉取服务端变更（`?since=<seq>`） |
| GET | `/api/plan` 🔒 | 当前套餐及用量 |
```

with:

```markdown
| GET/POST/PUT/DELETE | `/collections[/:id]` 🔒 | 集合 CRUD |
| GET/POST/PUT/DELETE | `/bookmarks[/:id]` 🔒 | 书签 CRUD |
| GET/POST/PUT/DELETE | `/tags[/:id]` 🔒 | 标签 CRUD |
| GET | `/search` 🔒 | 全文搜索（`?q=`，≥2 字符，需 MeiliSearch）；只在快照文本中命中的结果带 `snippet` |
| POST | `/snapshots` 🔒 | 保存或更新网页快照（`{"bookmark_ids": [...]}`，最多 100 个）；返回 queued 与带原因的 skipped |
| POST/DELETE | `/snapshots/:bookmarkId/archive` 🔒 | 保存 / 删除完整存档 |
| DELETE | `/snapshots/:bookmarkId` 🔒 | 删除快照（含存档）并释放空间 |
| GET/PUT | `/snapshots/settings` 🔒 | 自动快照开关 `{"auto": bool}` |
| GET | `/snapshot-assets/:assetId` | 快照文件；`?sig=` 签名即凭据（`<img>`/`<iframe>` 无法带 Authorization） |
| POST | `/sync/push` 🔒 | 增量推送变更（含 groups） |
| GET | `/sync/pull` 🔒 | 拉取服务端变更（`?since=<seq>`） |
| GET | `/api/plan` 🔒 | 当前套餐及用量 |
```

Replace:

````markdown
```

`app.New()` 内部根据 `Config` 的 Prosopo / Mail 字段自动创建 `captcha.Verifier` 和 `mailer.Mailer`，外部调用方无需导入 `internal/` 包。Cloud 仓库的 `main.go` 只需将 `local.New(...)` 替换为 `flexprice.New(...)`，并调用 `bp.ResolvePlans(ctx)` 解析套餐 UUID，其余不变。`RegisterWebhook()` 供 Cloud 额外挂载 webhook 路由。

### 数据库
````

with:

````markdown
```

`app.New()` 内部根据 `Config` 的 Prosopo / Mail 字段自动创建 `captcha.Verifier` 和 `mailer.Mailer`，外部调用方无需导入 `internal/` 包。Cloud 仓库的 `main.go` 只需将 `local.New(...)` 替换为 `flexprice.New(...)`，并调用 `bp.ResolvePlans(ctx)` 解析套餐 UUID，其余不变。`RegisterWebhook()` 供 Cloud 额外挂载 webhook 路由。

网页快照的任务队列是另一个注入点：接口在公开包 `jobqueue`，`app.New(..., app.WithSnapshotQueue(q))` 替换 `REDIS_URL` 上的 Asynq 队列；快照 Worker 由 `app.RunFetcher(ctx, cfg, db, worker)` 运行，OSS 的 `cmd/fetcher` 传入 `redisqueue.Worker`，Cloud 的 `cmd/fetcher` 传入自己的实现。Worker 不含计费逻辑：API 入队时把用户的存储上限写进 `jobqueue.Job.StorageLimit`。

### 数据库
````

Replace:

```markdown
| `internal/model` | 内部 | 请求/响应结构体、`Plan` 常量 |
| `internal/netguard` | 内部 | 网页快照 Worker 的网络出口：只连接公网地址的拨号器（`code.dny.dev/ssrf`，每个连接在 DNS 解析后检查，重定向与 DNS rebinding 都到不了内网）、Worker 自身请求用的 HTTP 客户端（最多 5 次重定向，只接受不含凭据的 http(s) URL，忽略代理环境变量，固定 `UserAgent`），以及供 monolith 使用的本地出口代理（goproxy；普通请求与 CONNECT 都经同一拨号器） |
| `internal/browser` | 内部 | 自带的最小 CDP 客户端（`github.com/coder/websocket`，以 `Authorization: Bearer` 传 obscura 的 CDP token）与页面渲染：每个页面一条连接、一个 browser context，只用 obscura 文档列出的 CDP 方法；视口 1280×800，拒绝媒体与字体请求，超过 300 个子请求或 25 MB 后拒绝其余请求，导航 15 秒、脚本 10 秒；`-tags integration` 测试在真实 obscura 容器上验证 |
| `internal/snapshots/capture` | 内部 | 网页快照抓取核心，不读配置、不访问数据库、不入队：只读响应头的预检（HTML 交给浏览器；不超过 20 MB 的图片与 PDF 直接作为快照；视频、音频、附件等标记 unsupported）、阅读版（go-readability + bluemonday，最多 2 MB）、截图（JPEG q80，裁到视口）、封面副本（最多 5 MB，解码前检查像素数，640 px 宽 JPEG）、完整存档（monolith 经出口代理，最多 20 MB）、失败原因码与可重试判断；每个站点同时最多 2 个任务 |

### 认证流程
```

with:

```markdown
| `internal/model` | 内部 | 请求/响应结构体、`Plan` 常量 |
| `internal/netguard` | 内部 | 网页快照 Worker 的网络出口：只连接公网地址的拨号器（`code.dny.dev/ssrf`，每个连接在 DNS 解析后检查，重定向与 DNS rebinding 都到不了内网）、Worker 自身请求用的 HTTP 客户端（最多 5 次重定向，只接受不含凭据的 http(s) URL，忽略代理环境变量，固定 `UserAgent`），以及供 monolith 使用的本地出口代理（goproxy；普通请求与 CONNECT 都经同一拨号器） |
| `internal/browser` | 内部 | 自带的最小 CDP 客户端（`github.com/coder/websocket`，以 `Authorization: Bearer` 传 obscura 的 CDP token）与页面渲染：每个页面一条连接、一个 browser context，只用 obscura 文档列出的 CDP 方法；视口 1280×800，拒绝媒体与字体请求，超过 300 个子请求或 25 MB 后拒绝其余请求，导航 15 秒、脚本 10 秒；`-tags integration` 测试在真实 obscura 容器上验证 |
| `jobqueue` | 公开 | 网页快照任务队列接口：`Job`（kind、user、bookmark、generation、`StorageLimit`）、`Queue.Enqueue`、`Worker.Run`、`Handler(ctx, job, lastAttempt)`、`MaxRetries = 3`；Cloud 可导入并实现 |
| `jobqueue/redisqueue` | 公开 | OSS 队列：Asynq on Redis（`snapshots` 队列）；`Job.Key()` 作为 task ID，排队中的同一任务只保留一份；handler 返回错误即重试，`lastAttempt` 由重试次数计算 |
| `internal/blobstore` | 内部 | 快照文件存储：`Store`（Put / Open / Delete / List）；`Local`（目录，先写临时文件再改名）与 `S3`（自带 SigV4 签名，支持 path-style 与 S3 兼容存储，`Open` 返回可 Seek 的 ranged GET 读取器）；`Open(Config)` 按 `SNAPSHOT_STORAGE` 选择 |
| `internal/snapshots` | 内部 | 网页快照服务：`Service`（API 侧：手动请求、新书签与回填触发、删除、设置、同步行与签名 URL、URL 密钥轮换检查、5 分钟调度、每日垃圾回收）与 `Worker`（cmd/fetcher 侧：执行抓取、在锁内复核配额、替换文件、记录失败）；不含计费逻辑 |
| `internal/snapshots/capture` | 内部 | 网页快照抓取核心，不读配置、不访问数据库、不入队：只读响应头的预检（HTML 交给浏览器；不超过 20 MB 的图片与 PDF 直接作为快照；视频、音频、附件等标记 unsupported）、阅读版（go-readability + bluemonday，最多 2 MB）、截图（JPEG q80，裁到视口）、封面副本（最多 5 MB，解码前检查像素数，640 px 宽 JPEG）、完整存档（monolith 经出口代理，最多 20 MB）、失败原因码与可重试判断；每个站点同时最多 2 个任务 |

### 认证流程
```

Replace:

```markdown
| `TRASH_GRACE_DAYS` | | 垃圾桶自动过期天数（state 1 → 2）；默认 `7` |
| `MEILISEARCH_HOST` | | MeiliSearch 实例内部 URL（如 `http://meilisearch:7700`）；空 = 禁用全文搜索 |
| `MEILISEARCH_API_KEY` | | MeiliSearch master/admin API key（对应 `MEILI_MASTER_KEY`） |
| `RATE_LIMIT_AUTH` | | auth 端点每窗口最大请求数/IP；默认 `10` |
| `RATE_LIMIT_AUTH_WINDOW` | | auth 限流窗口，Go duration；默认 `1m` |
| `RATE_LIMIT_SYNC_PUSH` | | POST /sync/push 每窗口最大请求数/IP；默认 `60` |
```

with:

```markdown
| `TRASH_GRACE_DAYS` | | 垃圾桶自动过期天数（state 1 → 2）；默认 `7` |
| `MEILISEARCH_HOST` | | MeiliSearch 实例内部 URL（如 `http://meilisearch:7700`）；空 = 禁用全文搜索 |
| `MEILISEARCH_API_KEY` | | MeiliSearch master/admin API key（对应 `MEILI_MASTER_KEY`） |
| `SNAPSHOT_STORAGE` | | 网页快照存储：`local` / `s3`；空 = 关闭快照（还需队列与 `SNAPSHOT_URL_SECRET`） |
| `SNAPSHOT_LOCAL_DIR` | | `local` 存储目录；docker-compose 中为 `/data` |
| `SNAPSHOT_S3_ENDPOINT` / `SNAPSHOT_S3_REGION` / `SNAPSHOT_S3_BUCKET` / `SNAPSHOT_S3_ACCESS_KEY_ID` / `SNAPSHOT_S3_SECRET_ACCESS_KEY` | | S3 或兼容存储；region 默认 `us-east-1` |
| `SNAPSHOT_S3_PATH_STYLE` | | `true` = path-style URL（MinIO 等） |
| `SNAPSHOT_URL_SECRET` | | 快照文件 URL 的签名密钥，≥32 字节，与 `JWT_SECRET` 分开；配置了存储时必填 |
| `SNAPSHOT_URL_SECRET_PREVIOUS` | | 密钥轮换期间仍接受的旧密钥 |
| `SNAPSHOT_MAX_ATTEMPTS_PER_DAY` | | 每用户每 UTC 日的抓取次数上限；默认 `0` = 不限（Cloud 设 1000） |
| `SNAPSHOT_BROWSER_URL` / `SNAPSHOT_BROWSER_TOKEN` | | 仅 cmd/fetcher：obscura 的 CDP 地址与 token |
| `SNAPSHOT_WORKER_CONCURRENCY` | | 仅 cmd/fetcher：同时运行的任务数；默认 `4` |
| `SNAPSHOT_MONOLITH_PATH` | | 仅 cmd/fetcher：monolith 路径；空 = 在 PATH 中查找，找不到则关闭完整存档 |
| `RATE_LIMIT_AUTH` | | auth 端点每窗口最大请求数/IP；默认 `10` |
| `RATE_LIMIT_AUTH_WINDOW` | | auth 限流窗口，Go duration；默认 `1m` |
| `RATE_LIMIT_SYNC_PUSH` | | POST /sync/push 每窗口最大请求数/IP；默认 `60` |
```

Replace:

```markdown
- **Tag 模型缺少 UpdatedAt**：`model.Tag` 结构体无 `UpdatedAt` 字段，Pull handler 的 tag SELECT 因此只取 6 列（无 `updated_at`）；LWW 通过 `seq` 而非 `updated_at` 实现。
- **Bookmark tag_ids**：`bookmarks` 表有 `tag_ids text[] NOT NULL DEFAULT '{}'` 列，存储该书签关联的 Tag ID 数组。`model.Bookmark.TagIDs []string` 对应此列；Push upsert 和 Pull SELECT 均包含 `tag_ids`；pgx 原生支持 `[]string ↔ text[]` 扫描，无需额外包。
- **Bookmark notes / edited_at**：`bookmarks.notes TEXT NOT NULL DEFAULT ''`、`bookmarks.edited_at BIGINT`（可空）。`model.Bookmark.Notes *string` / `EditedAt *int64`，nil 表示客户端未发送：Push 与 REST 更新未发送 `notes` 时保留库中值（`COALESCE`），未发送 `edited_at` 时写服务端时间；超过 `model.MaxBookmarkNotesLength`（10,000 rune）的 Push 以 `invalid_field` 拒绝，REST 由 `binding:"max=10000"` 返回 400。搜索文档（sync push、REST、workspace 恢复、`cmd/reindex`）都使用库中备注。
- **Bookmark cover (image_url)**：`bookmarks.image_url TEXT NOT NULL DEFAULT ''`，扩展保存网页时读取的 `og:image` 地址。`model.Bookmark.ImageURL *string`，nil 表示客户端未发送：Push 与 REST 更新未发送时保留库中值，空字符串清除封面；非空值必须是绝对 http(s) 地址且不超过 `model.MaxBookmarkImageURLLength`（2,048 字符），由 `model.ValidBookmarkImageURL` 校验，否则 Push 以 `invalid_field` 拒绝该书签、REST 返回 400。Pull 与 REST 读取总是返回该字段；不进入搜索索引。

---
```

with:

```markdown
- **Tag 模型缺少 UpdatedAt**：`model.Tag` 结构体无 `UpdatedAt` 字段，Pull handler 的 tag SELECT 因此只取 6 列（无 `updated_at`）；LWW 通过 `seq` 而非 `updated_at` 实现。
- **Bookmark tag_ids**：`bookmarks` 表有 `tag_ids text[] NOT NULL DEFAULT '{}'` 列，存储该书签关联的 Tag ID 数组。`model.Bookmark.TagIDs []string` 对应此列；Push upsert 和 Pull SELECT 均包含 `tag_ids`；pgx 原生支持 `[]string ↔ text[]` 扫描，无需额外包。
- **Bookmark notes / edited_at**：`bookmarks.notes TEXT NOT NULL DEFAULT ''`、`bookmarks.edited_at BIGINT`（可空）。`model.Bookmark.Notes *string` / `EditedAt *int64`，nil 表示客户端未发送：Push 与 REST 更新未发送 `notes` 时保留库中值（`COALESCE`），未发送 `edited_at` 时写服务端时间；超过 `model.MaxBookmarkNotesLength`（10,000 rune）的 Push 以 `invalid_field` 拒绝，REST 由 `binding:"max=10000"` 返回 400。搜索文档（sync push、REST、workspace 恢复、`cmd/reindex`）都使用库中备注。
- **网页快照**（`internal/snapshots`）：存储、队列（注入的或 `REDIS_URL` 上的 Asynq）与 `SNAPSHOT_URL_SECRET` 都配置时才开启；否则 `capabilities.snapshots=false`、`/snapshots*` 返回 503，其余行为不变。`bookmark_snapshots` 每书签一行，`status` 为 queued / ready / failed / unsupported / deleted（deleted 行保留，删除才能同步到其他设备）；更新已有快照时保持 ready，`queued_at` 非空表示任务在途；更新失败只记录 `failure_reason`，旧快照保留。每次入队从 `snapshot_generation_seq` 取新 generation，Worker 只在 generation 相同、任务在途、书签 URL 未变且未永久删除时保存结果。所有快照写操作先取每用户 advisory 锁（`lockUser`），配额（`snapshot_assets.size` 之和）在锁内计算，并发 Worker 不会超额；每次变更分配新的同步 seq 并广播。文件 key 为 `snapshots/<userId>/<assetId>`：先写文件，事务内换行，提交后删旧文件；每日 cleanup 删除一小时以上且无行引用的文件。书签永久删除（`is_trashed=2`）或改 URL 时快照被删除（sync push、REST 写入之后与每日 cleanup 中执行），物理删除靠外键级联。搜索文本在独立的 MeiliSearch `snapshots` 索引中，书签文档的重写与删除不影响它。`GET /sync/pull` 先读 `currentSeq` 再查实体，避免并发写入（如 Worker 结果）被永久跳过。
- **Bookmark cover (image_url)**：`bookmarks.image_url TEXT NOT NULL DEFAULT ''`，扩展保存网页时读取的 `og:image` 地址。`model.Bookmark.ImageURL *string`，nil 表示客户端未发送：Push 与 REST 更新未发送时保留库中值，空字符串清除封面；非空值必须是绝对 http(s) 地址且不超过 `model.MaxBookmarkImageURLLength`（2,048 字符），由 `model.ValidBookmarkImageURL` 校验，否则 Push 以 `invalid_field` 拒绝该书签、REST 返回 400。Pull 与 REST 读取总是返回该字段；不进入搜索索引。

---
```

In `ARCHITECTURE.md`:

Replace:

```markdown
TabSlate-server/
├── cmd/server/
│   └── main.go              # 入口：LoadConfig → db.Open → local.New → bp.Start → app.New → s.Run()
│
├── app/
│   ├── config.go            # Config（LoadConfig 从环境变量读取）
│   └── server.go            # Server 结构体：New、setupCORS、setupRoutes、Run、RegisterWebhook、SyncSubscription
│
├── billing/
│   ├── types.go             # 共享类型：Limits（MaxWorkspaces/MaxBookmarks/MaxCollections/MaxTags/MaxSavedGroups/TrashGraceDays），Subscription，Invoice
```

with:

```markdown
TabSlate-server/
├── cmd/server/
│   └── main.go              # 入口：LoadConfig → db.Open → local.New → bp.Start → app.New → s.Run()
├── cmd/fetcher/
│   └── main.go              # 网页快照 Worker 入口：LoadFetcherConfig → db.Open → redisqueue.NewWorker → app.RunFetcher
│
├── app/
│   ├── config.go            # Config（LoadConfig 从环境变量读取）
│   ├── server.go            # Server 结构体：New(…, opts ...Option)、setupCORS、setupRoutes、Run、RegisterWebhook、SyncSubscription
│   └── snapshots.go         # SnapshotConfig、FetcherConfig、WithSnapshotQueue、newSnapshotService、RunFetcher
│
├── jobqueue/
│   ├── jobqueue.go          # 公开的快照任务队列接口：Job、Queue、Worker、Handler、MaxRetries（Cloud 实现 Hatchet 版）
│   └── redisqueue/          # OSS 实现：Asynq on Redis
│
├── billing/
│   ├── types.go             # 共享类型：Limits（MaxWorkspaces/MaxBookmarks/MaxCollections/MaxTags/MaxSavedGroups/TrashGraceDays），Subscription，Invoice
```

Replace:

```markdown
│
└── internal/
    ├── auth/                # JWT 签发/验证（HS256）、bcrypt、refresh token 生成
    ├── browser/             # 最小 CDP 客户端与页面渲染（obscura）；只用 obscura 文档列出的 CDP 方法
    ├── captcha/             # Prosopo procaptcha 验证；PROSOPO_SECRET 为空则跳过
    ├── mailer/              # 邮件发送：SMTP、Resend 或 Amazon SES（SigV4）；MAIL_PROVIDER 为空则禁用
```

with:

```markdown
│
└── internal/
    ├── auth/                # JWT 签发/验证（HS256）、bcrypt、refresh token 生成
    ├── blobstore/           # 快照文件存储：Store 接口、Local（目录）、S3（自带 SigV4）、Open(Config)
    ├── browser/             # 最小 CDP 客户端与页面渲染（obscura）；只用 obscura 文档列出的 CDP 方法
    ├── captcha/             # Prosopo procaptcha 验证；PROSOPO_SECRET 为空则跳过
    ├── mailer/              # 邮件发送：SMTP、Resend 或 Amazon SES（SigV4）；MAIL_PROVIDER 为空则禁用
```

Replace:

```markdown
    │   ├── memory.go        # InMemoryLimiter（OSS 单机）
    │   └── redis.go         # RedisLimiter（多实例；Allow 用 sorted-set Lua 脚本，IncrCounter 用原子 Lua 脚本）
    ├── search/
    │   ├── types.go         # BookmarkDoc（MeiliSearch 文档结构）
    │   └── client.go        # Client：nil-safe 包装器；MEILISEARCH_HOST 为空时返回 nil（禁用）
    ├── snapshots/
    │   └── capture/         # 网页快照抓取核心：预检、渲染、阅读版、截图、封面副本、完整存档、失败原因码
    ├── store/
    │   ├── cache.go         # Cache 接口：Set / Get / Del（带 TTL）
```

with:

```markdown
    │   ├── memory.go        # InMemoryLimiter（OSS 单机）
    │   └── redis.go         # RedisLimiter（多实例；Allow 用 sorted-set Lua 脚本，IncrCounter 用原子 Lua 脚本）
    ├── search/
    │   ├── types.go         # BookmarkDoc、SnapshotTextDoc、SnapshotTextHit（MeiliSearch 文档结构）
    │   └── client.go        # Client：nil-safe 包装器；MEILISEARCH_HOST 为空时返回 nil（禁用）；bookmarks 与 snapshots 两个索引
    ├── snapshots/
    │   ├── snapshots.go     # 状态与文件类型常量、每用户 advisory 锁、存储用量、nextSeq、deleteSnapshots
    │   ├── service.go       # Service（API 侧）：Request、RequestArchive、Delete、DeleteArchive、Auto/SetAuto、NoteSync、每日次数
    │   ├── triggers.go      # AfterBookmarkWrites、RemoveGone、自动入队（新书签与回填共用）
    │   ├── rows.go          # Rows：同步行与签名文件 URL
    │   ├── assets.go        # OpenAsset：校验签名并打开文件
    │   ├── urls.go          # Signer：HMAC 签名 URL，支持轮换期旧密钥
    │   ├── keycheck.go      # CheckURLKey：密钥变化时给所有快照行分配新 seq
    │   ├── worker.go        # Worker（cmd/fetcher 侧）：执行任务、锁内复核配额、替换文件、记录失败
    │   ├── scheduler.go     # 5 分钟调度（过期、重新入队、回填）、RemoveGoneEverywhere、CollectGarbage
    │   ├── text.go          # ReaderText（阅读版纯文本，最多 50,000 字符）、EachReaderText（reindex 用）
    │   ├── change.go        # 一次事务的提交后工作：删旧文件、删搜索文本、入队、广播
    │   └── capture/         # 网页快照抓取核心：预检、渲染、阅读版、截图、封面副本、完整存档、失败原因码
    ├── store/
    │   ├── cache.go         # Cache 接口：Set / Get / Del（带 TTL）
```

Replace:

```markdown
        ├── sync_dependencies.go  # entityIDSet / parentAvailability / retainedQuota / classifyParent(Rejection)：push 内父子可用性判定与配额记账的共享小工具
        ├── sync_seq.go      # incrementSeq / currentSeq（per-user 单调序列）
        ├── cleanup.go       # CleanupHandler：后台 goroutine，每 24h 四阶段清理 + Workspace 按套餐保留期过期（见下文）
        ├── search.go        # GET /search?q=（书签全文搜索；最少 2 个 Unicode 字符；需 Bearer JWT）；visibleBookmarkIDs 用 PostgreSQL join 过滤 MeiliSearch 可能滞后返回的、父 Collection/Workspace 已不可见的书签
        ├── sse.go           # GET /sync/stream（SSE 流；通过 pubsub.Hub 接收广播）
        ├── billing.go       # GET /api/plan（subscription+limits+usage 汇总）、/api/subscription、/api/limits（60s 缓存）、/api/checkout、/api/invoices、DELETE /api/subscription
        └── captcha.go       # GET /captcha/widget、/captcha/widget.js
```

with:

```markdown
        ├── sync_dependencies.go  # entityIDSet / parentAvailability / retainedQuota / classifyParent(Rejection)：push 内父子可用性判定与配额记账的共享小工具
        ├── sync_seq.go      # incrementSeq / currentSeq（per-user 单调序列）
        ├── cleanup.go       # CleanupHandler：后台 goroutine，每 24h 四阶段清理 + Workspace 按套餐保留期过期（见下文）
        ├── search.go        # GET /search?q=（书签全文搜索；最少 2 个 Unicode 字符；需 Bearer JWT）；visibleBookmarks 用 PostgreSQL join 过滤 MeiliSearch 可能滞后返回的、父 Collection/Workspace 已不可见的书签；只在快照文本中命中的书签排在后面并带 snippet
        ├── snapshots.go     # /snapshots 端点与 GET /snapshot-assets/:assetId（签名校验、CSP、nosniff、Range、下载）
        ├── sse.go           # GET /sync/stream（SSE 流；通过 pubsub.Hub 接收广播）
        ├── billing.go       # GET /api/plan（subscription+limits+usage 汇总）、/api/subscription、/api/limits（60s 缓存）、/api/checkout、/api/invoices、DELETE /api/subscription
        └── captcha.go       # GET /captcha/widget、/captcha/widget.js
```

Replace:

```markdown
| GET/POST/PUT/DELETE | `/tags` | 标签 CRUD | Bearer JWT |
| POST | `/sync/push` | 批量推送本地变更（512KB 限制） | Bearer JWT |
| GET | `/sync/pull` | 拉取指定 seq 之后的增量 | Bearer JWT |
| GET | `/search` | 全文搜索书签（`?q=`，最少 2 字符，MeiliSearch） | Bearer JWT |
| GET | `/api/plan` | 套餐 + 配额上限 + 当前使用量汇总 | Bearer JWT |
| GET | `/api/subscription` | 当前订阅信息 | Bearer JWT |
| GET | `/api/limits` | 当前配额上限（60s 缓存） | Bearer JWT |
```

with:

```markdown
| GET/POST/PUT/DELETE | `/tags` | 标签 CRUD | Bearer JWT |
| POST | `/sync/push` | 批量推送本地变更（512KB 限制） | Bearer JWT |
| GET | `/sync/pull` | 拉取指定 seq 之后的增量 | Bearer JWT |
| GET | `/search` | 全文搜索书签（`?q=`，最少 2 字符，MeiliSearch）；快照文本命中带 `snippet` | Bearer JWT |
| POST | `/snapshots` | 保存或更新网页快照（最多 100 个书签） | Bearer JWT |
| POST/DELETE | `/snapshots/:bookmarkId/archive` | 保存 / 删除完整存档 | Bearer JWT |
| DELETE | `/snapshots/:bookmarkId` | 删除快照与存档 | Bearer JWT |
| GET/PUT | `/snapshots/settings` | 自动快照开关 | Bearer JWT |
| GET | `/snapshot-assets/:assetId` | 快照文件 | `?sig=` 签名 |
| GET | `/api/plan` | 套餐 + 配额上限 + 当前使用量汇总 | Bearer JWT |
| GET | `/api/subscription` | 当前订阅信息 | Bearer JWT |
| GET | `/api/limits` | 当前配额上限（60s 缓存） | Bearer JWT |
```

Replace:

```markdown
  7. 提交事务
  8. h.hub.Broadcast(userID, seq)       // 通知所有 SSE 连接（in-memory 或 Redis pub/sub）
  9. 对成功 upsert 的书签触发 MeiliSearch upsert/delete（事务提交后，fire-and-forget）
 10. 返回 { server_seq, rejected: [] }
     rejected 项结构：{ id, reason, type, parent_id?, parent_type? }
     reason 取值：
```

with:

```markdown
  7. 提交事务
  8. h.hub.Broadcast(userID, seq)       // 通知所有 SSE 连接（in-memory 或 Redis pub/sub）
  9. 对成功 upsert 的书签触发 MeiliSearch upsert/delete（事务提交后，fire-and-forget）
 9b. 若开启网页快照且 push 含书签或集合：snapshots.AfterBookmarkWrites（删除永久删除或改了 URL 的书签的快照，并为没有快照的新书签入队，每次最多 50 个）
 10. 返回 { server_seq, rejected: [] }
     rejected 项结构：{ id, reason, type, parent_id?, parent_type? }
     reason 取值：
```

Replace:

````markdown
```
GET /sync/pull?after_seq=N  →  SyncHandler.Pull
  1. after_seq < 0 → 400
  2. 五张表各自 SELECT WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC
     workspaces 额外返回 is_deleted、deletion_model（state 2 行的 name/icon/color/position 已在写入时被清空，见下文）
     collections 额外用 CTE 计算 is_default（每个 workspace 下 position 最小的 active collection）
     groups 用 LEFT JOIN group_tabs 聚合 tabs（ANY($1) 批量取 tab，groupIdx map 分发）
  3. rows.Err() 检查
  4. currentSeq → server_seq
  5. 返回 { server_seq, entities: {...}, capabilities: { workspace_parent_tombstone: true } }
     （含软删除记录，deleted_at != NULL 表示墓碑；软删除 group 的 tabs 字段为 []；capabilities 是本次重构新增字段，始终为 true——所有生产环境服务端都已实现 parent-tombstone 语义，字段的存在本身就是客户端探测「服务端已升级」的信号，见下文 Capability 协商）
```
````

with:

````markdown
```
GET /sync/pull?after_seq=N  →  SyncHandler.Pull
  1. after_seq < 0 → 400
  1b. currentSeq → server_seq（先于实体读取：查询期间提交的变更 seq 更大，下次拉取仍会返回；放在最后读会永久跳过这类变更）
  2. 五张表各自 SELECT WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC
     workspaces 额外返回 is_deleted、deletion_model（state 2 行的 name/icon/color/position 已在写入时被清空，见下文）
     collections 额外用 CTE 计算 is_default（每个 workspace 下 position 最小的 active collection）
     groups 用 LEFT JOIN group_tabs 聚合 tabs（ANY($1) 批量取 tab，groupIdx map 分发）
  3. rows.Err() 检查
  4. 开启网页快照时：entities.snapshots = snapshots.Rows（seq 过滤，带签名文件 URL），并以每天最多一次的频率写 users.last_sync_at
  5. 返回 { server_seq, entities: {...}, capabilities: { workspace_parent_tombstone: true, snapshots: <是否开启> } }
     （含软删除记录，deleted_at != NULL 表示墓碑；软删除 group 的 tabs 字段为 []；capabilities 是本次重构新增字段，始终为 true——所有生产环境服务端都已实现 parent-tombstone 语义，字段的存在本身就是客户端探测「服务端已升级」的信号，见下文 Capability 协商）
```
````

Replace:

````markdown
| `groups` | id, user_id, workspace_id, seq, deleted_at, **is_deleted INT** | `is_deleted`: 0/1/2 三态；软删除保留行 |
| `group_tabs` | id, group_id FK→groups, title, url, favicon, position | 组内 tab；ON DELETE CASCADE；无 seq，整体快照替换 |
| `refresh_tokens` | token_hash, user_id, expires_at | SHA-256 哈希存储，使用后轮换 |
| `subscription_capacity` | plan_code PK, plan_id, max_workspaces, max_bookmarks, max_collections, max_tags, max_saved_groups, trash_grace_days, updated_at | 套餐配额；OSS 写 `unlimited`（全 -1）；Cloud（Flexprice）不使用此表，配额从 Entitlement API 实时读取；-1 = 不限制 |

**Delta-pull 索引**（`schema.pg.sql` 末尾）：
```sql
````

with:

````markdown
| `groups` | id, user_id, workspace_id, seq, deleted_at, **is_deleted INT** | `is_deleted`: 0/1/2 三态；软删除保留行 |
| `group_tabs` | id, group_id FK→groups, title, url, favicon, position | 组内 tab；ON DELETE CASCADE；无 seq，整体快照替换 |
| `refresh_tokens` | token_hash, user_id, expires_at | SHA-256 哈希存储，使用后轮换 |
| `bookmark_snapshots` | bookmark_id PK FK→bookmarks, user_id, url, status, kind, captured_at, failure_reason, archive_status, generation, queued_at, enqueued_at, archive_generation, archive_queued_at, archive_enqueued_at, seq | 每书签一个网页快照；`status`: queued / ready / failed / unsupported / deleted；`queued_at` 非空 = 抓取任务在途，`enqueued_at` = 最近一次入队；时间均为 Unix ms |
| `snapshot_assets` | id PK, user_id, bookmark_id FK→bookmarks, type, content_type, size, created_at；UNIQUE (bookmark_id, type) | 每个存储文件一行（reader / screenshot / cover / file / archive）；用户存储用量 = `SUM(size)` |
| `snapshot_attempts` | (user_id, day) PK, attempts | 每用户每 UTC 日的抓取次数（`SNAPSHOT_MAX_ATTEMPTS_PER_DAY` > 0 时才写） |
| `subscription_capacity` | plan_code PK, plan_id, max_workspaces, max_bookmarks, max_collections, max_tags, max_saved_groups, trash_grace_days, max_snapshot_storage_mb, updated_at | 套餐配额；OSS 写 `unlimited`（全 -1）；Cloud（Flexprice）不使用此表，配额从 Entitlement API 实时读取；-1 = 不限制 |

**Delta-pull 索引**（`schema.pg.sql` 末尾）：
```sql
````

Replace:

```markdown
| `PUT /bookmarks/:id`（Update，is_trashed=true） | DeleteBookmark |
| `DELETE /bookmarks/:id`（软删除） | DeleteBookmark |
| `POST /sync/push`（Push，书签 upsert 成功） | 批量 Upsert 或 Delete（提交后） |

**冷启动注意：** MeiliSearch 的 `UpdateSettings` 是异步任务，极短时间内的首次搜索请求可能因 `userId` 尚未变为 filterable 而返回 500。通常在数秒内自动恢复。
```

with:

```markdown
| `PUT /bookmarks/:id`（Update，is_trashed=true） | DeleteBookmark |
| `DELETE /bookmarks/:id`（软删除） | DeleteBookmark |
| `POST /sync/push`（Push，书签 upsert 成功） | 批量 Upsert 或 Delete（提交后） |
| Worker 保存快照 | `snapshots` 索引 UpsertSnapshotText（阅读版纯文本，最多 50,000 字符；无阅读版则删除） |
| 删除快照（API、URL 变化、永久删除） | `snapshots` 索引 DeleteSnapshotTexts |

快照文本放在独立的 `snapshots` 索引（`id` = 书签 ID，`userId`，`content`），而不是书签文档里：书签文档会随每次编辑被整体重写，进回收站时被删除、恢复时重建，而 API 无法在这些路径上从存储重新读取阅读版。`SearchHandler.Search` 先取书签索引的命中，再追加只在快照文本中命中的书签（字段取自 PostgreSQL，`snippet` 为 MeiliSearch 裁剪的约 30 个词），总数最多 20；文本本身从不返回。`DeleteUserDocumentsAsync` 同时清理两个索引；`cmd/reindex` 从存储中的阅读版重建 `snapshots` 索引。

**冷启动注意：** MeiliSearch 的 `UpdateSettings` 是异步任务，极短时间内的首次搜索请求可能因 `userId` 尚未变为 filterable 而返回 500。通常在数秒内自动恢复。
```

Replace:

```markdown
Cloud 仓库只需将 `local.New(...)` 替换为 `flexprice.New(...)`，调用 `bp.ResolvePlans(ctx)` 解析套餐 UUID，并设置 `REDIS_URL` 即可实现水平扩展。Flexprice 无后台容量同步 goroutine，配额直接从 Entitlement API 按需读取（5 分钟 TTL 缓存）。

## 认证机制

| 凭证 | 算法 | 有效期 | 存储 |
```

with:

````markdown
Cloud 仓库只需将 `local.New(...)` 替换为 `flexprice.New(...)`，调用 `bp.ResolvePlans(ctx)` 解析套餐 UUID，并设置 `REDIS_URL` 即可实现水平扩展。Flexprice 无后台容量同步 goroutine，配额直接从 Entitlement API 按需读取（5 分钟 TTL 缓存）。

网页快照：`app.New` 在 `SNAPSHOT_STORAGE`、队列（`app.WithSnapshotQueue` 注入的，或 `REDIS_URL` 上的 `redisqueue`）与 `SNAPSHOT_URL_SECRET` 齐备时创建 `snapshots.Service`，启动时执行 `CheckURLKey`，并启动 `RunScheduler`；否则为 nil，各 handler 的 `WithSnapshots(nil)` 保持原行为。`cmd/fetcher` 经 `app.RunFetcher` 组装 netguard、browser、capture、blobstore 与 `snapshots.Worker`，由传入的 `jobqueue.Worker` 投递任务。

## 网页快照（C2）

```
扩展 ──POST /snapshots──► API (snapshots.Service) ──Enqueue──► 队列（Asynq / Hatchet）
  ▲                          │ 写 bookmark_snapshots（queued，新 generation，新 seq）
  │ pull: entities.snapshots │
  │ <img>/<iframe>: /snapshot-assets/<id>?sig=…
  │                          ▼
  └──── SSE ◄── Redis pub/sub ◄── cmd/fetcher (snapshots.Worker) ──CDP──► obscura（独立网络）
                                     │ capture：预检、渲染、阅读版、截图、封面、monolith 存档
                                     └► blobstore：snapshots/<userId>/<assetId>
```

- **触发**：sync push 与 REST 写入后为没有快照的活跃书签入队（每次最多 50 个；需 `users.snapshot_auto`、有剩余空间、书签与集合未归档、父集合与工作区活跃）；调度器每 5 分钟为 30 天内同步过的用户回填最多 20 个（最新优先，剩余空间需超过 20%）；手动请求（`POST /snapshots`）也接受已归档书签，同一书签 10 分钟内只接受一次。
- **任务**：`jobqueue.Job{Kind, UserID, BookmarkID, Generation, StorageLimit}`。Worker 只处理仍然有效的任务（generation 一致、`queued_at` 非空、书签存在且 URL 未变）；超时、5xx、429 与浏览器忙由队列重试最多 3 次，最后一次失败记录原因码。调度器把 15 分钟无结果的任务以同一 generation 重新入队，24 小时仍无结果则以 `timeout` 失败。
- **保存**：先写文件，再在每用户 advisory 锁内复核 `用量 - 被替换文件 + 新文件 ≤ StorageLimit`（超出则 `storage_full` 并删除新文件），事务内替换 `snapshot_assets` 行并更新快照行，提交后删除旧文件、更新搜索文本、广播 seq。抓取只替换阅读版、截图、封面与文件；完整存档只被新的存档替换。
- **删除**：API 删除快照或存档、书签改 URL、书签永久删除（sync push / REST 之后与每日 cleanup 的 `RemoveGoneEverywhere`）都把行标为 `deleted` 并删除文件；工作区清除与账户删除通过外键级联删行，文件由每日 `CollectGarbage`（存储中一小时以上、无行引用的文件）清理。
- **文件 URL**：`Signer` 以 `SNAPSHOT_URL_SECRET` 做 HMAC，轮换期间也接受 `SNAPSHOT_URL_SECRET_PREVIOUS`；`CheckURLKey` 发现密钥指纹变化时给所有快照行分配新 seq，客户端重新拉取新 URL。响应带 `Cache-Control: private, max-age=31536000, immutable`、`X-Content-Type-Options: nosniff` 与严格 CSP（PDF 除外），支持 Range 与 `download=1`。

## 认证机制

| 凭证 | 算法 | 有效期 | 存储 |
````

- [ ] **Step 7: Check the Docker files**

Run `docker compose config` only with `--quiet` or `--services`: without them it prints the resolved environment, including the secrets in `.env`.

```bash
cp .env.example /tmp/c22-compose.env
docker compose --env-file /tmp/c22-compose.env -f docker-compose.yml config --quiet
COMPOSE_PROFILES=snapshots docker compose --env-file /tmp/c22-compose.env -f docker-compose.yml config --services
rm /tmp/c22-compose.env
docker build --check .
docker build --target fetcher -t tabslate-fetcher:c22-check .
docker run --rm --entrypoint /usr/local/bin/monolith tabslate-fetcher:c22-check -V
docker run --rm --entrypoint id tabslate-fetcher:c22-check
docker image rm tabslate-fetcher:c22-check
```

Expected:
- **Compose.**
  - `config --quiet` prints nothing. If it complains that `.env` is missing, run the two compose commands with a temporary `.env` copied from `.env.example`, then delete that `.env`. Never touch an existing `.env`.
  - The profile run lists `api`, `caddy`, `fetcher`, `obscura`, and `redis`.
- **Dockerfile.** `docker build --check` reports `Check complete, no warnings found.`
- **Fetcher image.**
  - The image builds.
  - `monolith -V` prints version 2.11.6.
  - `id` starts with `uid=10001(fetcher)`.

- [ ] **Step 8: Run the full verification**

```bash
export TEST_DATABASE_URL='postgres://postgres:c22test@127.0.0.1:55433/tabslate_test?sslmode=disable'
GOTOOLCHAIN=local go build ./...
GOTOOLCHAIN=local go vet ./...
env -u TEST_DATABASE_URL GOTOOLCHAIN=local go test -count=1 ./...
GOTOOLCHAIN=local go test -p 1 -count=1 ./...
GOTOOLCHAIN=local go test -p 1 -count=1 -race ./jobqueue/... ./internal/blobstore/ ./internal/snapshots/... ./internal/search/ ./app/
git diff --name-only feat/bookmark-cover -- '*.go' | xargs gofmt -l
grep -n "^go \|^toolchain" go.mod
```

Expected:
- Build and vet pass.
- The run without a database passes, with the DB tests skipping, as in CI.
- The run with the database passes.
- The race run passes.
- `gofmt` lists none of the files this plan touched.
- `go.mod` shows `go 1.25.0` and no `toolchain` line.

- [ ] **Step 9: Commit**

```bash
git add Dockerfile docker-compose.yml .github/workflows/docker-publish.yml .env.example README.md CLAUDE.md ARCHITECTURE.md
git commit -m "feat(snapshots): add the fetcher image, compose services, and documentation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- Dockerfile docker-compose.yml \
  .github/workflows/docker-publish.yml .env.example README.md CLAUDE.md ARCHITECTURE.md
```

- [ ] **Step 10: Stop the test database and report**

```bash
docker stop tabslate-c22-test-pg
```

Report to the user:
- the branch (`feat/web-snapshots` in TabSlate-server, not pushed) and the commits;
- the obscura tag in the compose file;
- the manual checks that remain from the spec's Testing section. They need a full stack and real sites:
  - a docker-compose run;
  - snapshots of an article, a single-page app, a YouTube page, a PDF link, an image link, and an archive download link;
  - MinIO as S3 storage;
  - a full quota;
  - a URL change;
  - an update after the original site went offline.

C2-3 then adds Cloud's Hatchet queue and storage feature, and C2-4 adds the extension.
