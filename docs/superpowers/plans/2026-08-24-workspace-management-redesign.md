# Workspace Management Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace destructive Workspace decomposition with a recoverable parent-tombstone aggregate, an account-level Workspace Manager, unified quota accounting, and a backward-compatible server/client lifecycle protocol.

**Architecture:** The Go server is the lifecycle authority and retains Workspace states `0/1/2`; one transaction-aware lifecycle service is shared by Sync, REST, and Cleanup. The extension stores deleted roots and versioned lifecycle intents in IndexedDB, reconciles those intents in SyncEngine’s serialized resolution boundary, and deletes a local aggregate only after a confirmed terminal tombstone. Normal reads enforce active-parent visibility; Sync pull remains the recovery channel.

**Tech Stack:** Go, pgx/PostgreSQL, MeiliSearch, TypeScript, React 19, Zustand, IndexedDB, Chrome extension APIs, Bun test runner, WXT.

**Spec:** `docs/superpowers/specs/2026-08-23-workspace-management-redesign-design.md`

## Global Constraints

- Implement and deploy `TabSlate-server` before enabling the frontend lifecycle actions.
- Protocol-version-2 Workspace lifecycle transitions use only `lifecycle_action`; ordinary metadata mutations cannot change lifecycle state.
- Workspace `is_deleted=2` is a scrubbed protocol tombstone retained until account deletion. Never physically remove it from periodic cleanup.
- Every recoverable entity counts toward quota. Only terminal state `2` releases quota.
- `activeWorkspaceId` must always reference an active Workspace after bootstrap.
- Deleted descendants remain structurally attached to their Workspace. Never flatten them into another Workspace’s trash or migration target.
- Persist local Workspace mutation, lifecycle intent, and active-Workspace replacement in one IndexedDB transaction.
- Do not advance `localSeq` until full pull merge, terminal cleanup, conflict updates, migration markers, and durable writes complete.
- Use `useTranslation`; add both English and Simplified Chinese strings for every new UI message.
- Use Bun for frontend commands and Go tooling for the server. Never use `any`; keep Zustand selectors fine-grained.
- Run each test command from the repository named in the task. Commit only that task’s related files.

---

## Phase 1: Server contract and lifecycle authority

### Task 1: Add the persistent Workspace lifecycle schema and versioned wire DTOs

**Files**

- Modify: `../TabSlate-server/db/schema.pg.sql`
- Modify: `../TabSlate-server/internal/model/model.go`
- Test: `../TabSlate-server/internal/model/model_test.go`
- Test: `../TabSlate-server/internal/handler/sync_test.go`

**Interfaces**

```go
type WorkspaceLifecycleAction string

const (
    WorkspaceLifecycleDelete  WorkspaceLifecycleAction = "delete"
    WorkspaceLifecycleRestore WorkspaceLifecycleAction = "restore"
    WorkspaceLifecyclePurge   WorkspaceLifecycleAction = "purge"
)

type SyncWorkspace struct {
    ID            string  `json:"id"`
    UserID        string  `json:"user_id"`
    Name          string  `json:"name"`
    Icon          *string `json:"icon"`
    Color         *string `json:"color"`
    Position      int     `json:"position"`
    Seq           int64   `json:"seq"`
    DeletedAt     *int64  `json:"deleted_at"`
    IsDeleted     int     `json:"is_deleted"`
    DeletionModel int     `json:"deletion_model"`
    CreatedAt     int64   `json:"created_at"`
    UpdatedAt     int64   `json:"updated_at"`
}

type SyncWorkspaceMutation struct {
    ID              string                   `json:"id"`
    Name            string                   `json:"name"`
    Icon            *string                  `json:"icon,omitempty"`
    Color           *string                  `json:"color,omitempty"`
    Position        int                      `json:"position"`
    Seq             int64                    `json:"seq"`
    DeletedAt       *int64                   `json:"deleted_at,omitempty"`
    CreatedAt       int64                    `json:"created_at"`
    UpdatedAt       int64                    `json:"updated_at"`
    LifecycleAction WorkspaceLifecycleAction `json:"lifecycle_action,omitempty"`
}

type SyncPushRequest struct {
    ProtocolVersion int              `json:"protocol_version,omitempty"`
    Entities        SyncPushEntities `json:"entities"`
}

type SyncCapabilities struct {
    WorkspaceParentTombstone bool `json:"workspace_parent_tombstone"`
}
```

- [ ] Add a failing model JSON test proving that a version-2 Workspace mutation can distinguish an omitted lifecycle action from `delete`, and that pull JSON contains `is_deleted`, `deletion_model`, and `capabilities.workspace_parent_tombstone`.

- [ ] Run `go test ./internal/model ./internal/handler -run 'TestSyncWorkspaceMutationJSON|TestSyncPullCapabilities'` and confirm it fails because the DTOs and capability do not exist.

- [ ] Add idempotent schema changes. Use a one-time migration marker so only pre-redesign deleted rows are classified as legacy:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at BIGINT NOT NULL
);

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_deleted INT NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deletion_model SMALLINT NOT NULL DEFAULT 1;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspaces_is_deleted_check'
          AND conrelid = 'workspaces'::regclass
    ) THEN
        ALTER TABLE workspaces ADD CONSTRAINT workspaces_is_deleted_check
        CHECK (is_deleted IN (0, 1, 2));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspaces_deletion_model_check'
          AND conrelid = 'workspaces'::regclass
    ) THEN
        ALTER TABLE workspaces ADD CONSTRAINT workspaces_deletion_model_check
        CHECK (deletion_model IN (0, 1));
    END IF;
END $$;

WITH first_run AS (
    INSERT INTO schema_migrations (name, applied_at)
    VALUES ('workspace_parent_tombstone_v1', EXTRACT(EPOCH FROM NOW())::BIGINT)
    ON CONFLICT DO NOTHING
    RETURNING name
)
UPDATE workspaces
SET is_deleted = 1,
    deletion_model = 0
WHERE deleted_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM first_run);

CREATE INDEX IF NOT EXISTS idx_workspaces_user_deleted
ON workspaces (user_id, is_deleted);

CREATE INDEX IF NOT EXISTS idx_workspaces_retention
ON workspaces (user_id, is_deleted, deleted_at);
```

- [ ] Split push and pull Workspace representations in `internal/model/model.go`. Make `SyncEntities.Workspaces` use `[]SyncWorkspace`, make `SyncPushEntities.Workspaces` use `[]SyncWorkspaceMutation`, and keep REST `Workspace` independent. Nullable pull icon/color must scan and serialize canonical state-2 nulls without `COALESCE`. Add the four new rejection reasons as constants: `last_active_workspace`, `workspace_deleted`, `parent_deleted`, and `permanently_deleted`.

- [ ] Update the pull response model to include `Capabilities SyncCapabilities` and update decoding/encoding tests so a versionless request still decodes with `ProtocolVersion == 0`.

- [ ] Run `go test ./internal/model ./internal/handler -run 'TestSyncWorkspaceMutationJSON|TestSyncPullCapabilities'` and confirm it passes.

- [ ] Commit in `../TabSlate-server`:

```bash
git add db/schema.pg.sql internal/model/model.go internal/model/model_test.go internal/handler/sync_test.go
git commit -m "feat(sync): add workspace lifecycle protocol"
```

### Task 2: Centralize parent-tombstone delete, restore, and purge transactions

**Files**

- Create: `../TabSlate-server/internal/handler/workspace_lifecycle.go`
- Create: `../TabSlate-server/internal/handler/workspace_lifecycle_test.go`
- Modify: `../TabSlate-server/internal/handler/workspaces.go`
- Modify: `../TabSlate-server/app/server.go`

**Interfaces**

```go
type WorkspaceLifecycleEffect struct {
    Changed       bool
    Seq           int64
    SearchDeletes []string
    SearchUpserts []search.BookmarkDoc
}

type WorkspaceLifecycleService struct {
    db     *db.DB
    hub    pubsub.Hub
    search *search.Client
}

func (s *WorkspaceLifecycleService) Apply(
    ctx context.Context,
    userID string,
    workspaceID string,
    action model.WorkspaceLifecycleAction,
    deletionModel int,
) (WorkspaceLifecycleEffect, *model.Rejected, error)

func (s *WorkspaceLifecycleService) ApplyInTx(
    ctx context.Context,
    tx pgx.Tx,
    userID string,
    workspaceID string,
    action model.WorkspaceLifecycleAction,
    deletionModel int,
    seq int64,
    now int64,
) (WorkspaceLifecycleEffect, *model.Rejected, error)
```

- [ ] Write failing PostgreSQL-backed tests for: parent-only delete leaves descendants byte-for-byte unchanged; restore clears only the root tombstone; deleting the final active Workspace returns `last_active_workspace`; purge deletes descendants and retains one scrubbed state-2 row; repeating purge returns success without changing the terminal root or descendants.

- [ ] Add purge rollback subtests that install transaction-local failing triggers on the root update and each descendant table in turn. After every forced `workspaces`, `group_tabs`, `groups`, `bookmarks`, or `collections` failure, assert the root is still state `1`, unscrubbed, and every descendant remains.

- [ ] Run `go test ./internal/handler -run 'TestWorkspaceLifecycle_(DeleteParentOnly|RestoreParentOnly|RejectLastActive|PurgeScrubsRoot)'` and confirm the tests fail because the service is absent.

- [ ] Implement `Apply` as a serializable transaction wrapper. It must allocate one user sequence for a real transition, call `ApplyInTx`, commit only successful actions, broadcast only when `effect.Changed` after commit, and dispatch MeiliSearch work after canonical data commits. An idempotent repeated action returns `Changed=false` and produces no broadcast/search work.

- [ ] Implement the state transition lock in `ApplyInTx`:

```go
rows, err := tx.Query(ctx, `
    SELECT id, is_deleted, deletion_model
    FROM workspaces
    WHERE user_id = $1 AND is_deleted < 2
    ORDER BY id
    FOR UPDATE`, userID)
```

Lock all nonterminal rows in stable ID order before evaluating active count. If the target is absent from that set, issue a second target-only `FOR UPDATE` lookup to distinguish unowned/missing from state `2` without locking every historical terminal row. For `delete`, require the target to be state `0` and the locked active count to exceed one. For `restore`, require state `1`. Purge transitions state `1`; a concurrent state-0 restore returns the existing `stale` reason, while a repeated purge against state `2` is an accepted no-op with `Changed=false` and the existing root sequence. Return `permanently_deleted` for every other state-2 mutation and make repeated matching delete/restore actions idempotent.

- [ ] Implement parent-model delete and restore with one root update and no child update. On restore, set `deletion_model=1`. On delete, collect all descendant Bookmark IDs for post-commit search removal; on restore, query complete descendant `search.BookmarkDoc` values only for `is_trashed=0` Bookmarks (active or archived) inside the transaction for post-commit bulk reindexing.

- [ ] Implement purge inside the same transaction: first update the locked root to `is_deleted=2`, `name=''`, `icon=NULL`, `color=NULL`, `position=0` with the new sequence; then delete `group_tabs`, `groups`, `bookmarks`, and `collections` in dependency order. Do not delete the Workspace row.

- [ ] Construct one `WorkspaceLifecycleService` in `app/server.go` and inject the same instance into Workspace, Sync, and Cleanup handlers. Keep transaction logic out of the handlers.

- [ ] Run `go test ./internal/handler -run 'TestWorkspaceLifecycle_'` and confirm all lifecycle tests pass.

- [ ] Commit in `../TabSlate-server`:

```bash
git add internal/handler/workspace_lifecycle.go internal/handler/workspace_lifecycle_test.go internal/handler/workspaces.go app/server.go
git commit -m "feat(workspaces): centralize lifecycle transactions"
```

### Task 3: Preserve versionless clients with an atomic legacy cascade and one-time restore

**Files**

- Modify: `../TabSlate-server/internal/handler/workspace_lifecycle.go`
- Modify: `../TabSlate-server/internal/handler/workspace_lifecycle_test.go`
- Modify: `../TabSlate-server/internal/handler/sync.go`
- Test: `../TabSlate-server/internal/handler/sync_test.go`

**Interfaces**

```go
func (s *WorkspaceLifecycleService) applyLegacyDeleteInTx(
    ctx context.Context,
    tx pgx.Tx,
    userID string,
    workspaceID string,
    seq int64,
    now int64,
) (WorkspaceLifecycleEffect, error)

func (s *WorkspaceLifecycleService) applyLegacyRestoreInTx(
    ctx context.Context,
    tx pgx.Tx,
    workspace model.SyncWorkspace,
    seq int64,
    now int64,
) (WorkspaceLifecycleEffect, error)
```

- [ ] Add failing tests proving that a versionless request with `deleted_at` atomically marks the root `deletion_model=0` and cascades one sequence to active Collections, their active/archived Bookmarks, and active Saved Groups; already-trashed descendants must retain their earlier sequence.

- [ ] Add failing restore tests proving that only descendants with `seq >= workspace.seq` are restored, Collection `archived_at` survives, restored legacy Bookmarks become active, older independent trash remains trash, and a successful restore changes `deletion_model` to `1`.

- [ ] Run `go test ./internal/handler -run 'TestWorkspaceLifecycle_Legacy|TestSyncPush_LegacyWorkspace'` and confirm the new cases fail.

- [ ] Implement the legacy cascade as set-based SQL in the existing transaction. Restrict every update to state `0` so a later child payload is idempotent and cannot overwrite an older independent tombstone.

- [ ] Implement sequence-evidence restore. Query candidate Collection IDs first, then restore only candidate descendants satisfying the sequence rule. If evidence is missing or contradictory, leave that child in trash. Return complete restored Bookmark documents for post-commit search reindexing.

- [ ] Route only versionless `deleted_at != nil` mutations through legacy delete. A versionless metadata mutation against state `1` must return `workspace_deleted`; it must never imply restore.

- [ ] Run `go test ./internal/handler -run 'TestWorkspaceLifecycle_Legacy|TestSyncPush_LegacyWorkspace'` and confirm all cases pass.

- [ ] Commit in `../TabSlate-server`:

```bash
git add internal/handler/workspace_lifecycle.go internal/handler/workspace_lifecycle_test.go internal/handler/sync.go internal/handler/sync_test.go
git commit -m "feat(workspaces): support legacy lifecycle migration"
```

### Task 4: Enforce protocol-version-2 lifecycle ordering and parent-state rejections in Sync

**Files**

- Modify: `../TabSlate-server/internal/handler/sync.go`
- Modify: `../TabSlate-server/internal/handler/sync_dependencies.go`
- Modify: `../TabSlate-server/internal/handler/sync_test.go`
- Modify: `../TabSlate-server/internal/handler/sync_dependencies_test.go`

**Interfaces**

```go
type parentAvailability map[string]string

func classifyParent(
    parentID string,
    ownedActive map[string]struct{},
    acceptedInRequest map[string]struct{},
    unavailable parentAvailability,
) (accepted bool, reason string)
```

- [ ] Add failing Sync tests for: version-2 ordinary metadata cannot delete or restore; explicit actions call the lifecycle service; state-1 root update returns `workspace_deleted`; a child under state `1` returns `parent_deleted`; state `2` returns `permanently_deleted` for non-purge mutations and idempotent success for repeated purge; pull exposes all three root states plus retained descendants and capability `true`.

- [ ] Add failing quota tests proving retained Workspaces, Collections, Bookmarks, and Saved Groups are included in Sync creation guards and only terminal records release capacity.

- [ ] Run `go test ./internal/handler -run 'TestSync(Push|Pull).*Workspace|TestSyncPush.*Quota'` and confirm the lifecycle and retained-quota cases fail.

- [ ] Refactor parent classification to retain a reason per unavailable parent. Populate Workspace state `1` as `parent_deleted` and state `2` as `permanently_deleted`; propagate that reason through owned Collections so Bookmark writes inherit the Workspace outcome. Keep `parent_rejected` for a parent rejected earlier in the same request and `invalid_parent` for unowned IDs. Saved Groups classify directly against their Workspace.

- [ ] Process Workspace mutations before descendants. For protocol `2`, accept lifecycle transitions only from `LifecycleAction`; for an omitted action, apply create/metadata LWW only when the stored root is active. Call `ApplyInTx` with the Sync transaction’s existing sequence and merge its search effects into post-commit work.

- [ ] Update all Sync quota predicates to the shared retained definitions:

```sql
workspaces.is_deleted < 2
collections.is_deleted < 2
bookmarks.is_trashed < 2
groups.is_deleted < 2
```

- [ ] Return `Capabilities{WorkspaceParentTombstone: true}` on every successful authenticated pull, including an empty delta, and include retained Workspace descendants in full/delta Sync queries.

- [ ] Run `go test ./internal/handler -run 'TestSync(Push|Pull).*Workspace|TestSyncPush.*Quota'` and confirm all new and existing Sync tests pass.

- [ ] Commit in `../TabSlate-server`:

```bash
git add internal/handler/sync.go internal/handler/sync_dependencies.go internal/handler/sync_test.go internal/handler/sync_dependencies_test.go
git commit -m "feat(sync): enforce workspace parent tombstones"
```

### Task 5: Expose lifecycle REST actions and enforce active-parent visibility

**Files**

- Modify: `../TabSlate-server/internal/handler/workspaces.go`
- Modify: `../TabSlate-server/internal/handler/collections.go`
- Modify: `../TabSlate-server/internal/handler/bookmarks.go`
- Modify: `../TabSlate-server/internal/handler/search.go`
- Modify: `../TabSlate-server/app/server.go`
- Create: `../TabSlate-server/internal/handler/workspace_visibility_test.go`

**Interfaces**

```go
func (h *WorkspaceHandler) Restore(c *gin.Context)
func (h *WorkspaceHandler) PermanentlyDelete(c *gin.Context)

func (h *SearchHandler) visibleBookmarkIDs(
    ctx context.Context,
    userID string,
    candidateIDs []string,
) (map[string]struct{}, error)
```

- [ ] Add failing route tests for `POST /api/workspaces/:id/restore` and `DELETE /api/workspaces/:id/permanent`. Verify structured lifecycle reasons map to stable HTTP responses and purge never reports success when the service rejects it.

- [ ] Add failing visibility tests proving Workspace list returns only state `0`; Collection and Bookmark list/get/create/update paths hide or reject descendants whose parent Workspace is state `1`; search drops retained-parent hits even when MeiliSearch returns them.

- [ ] Run `go test ./internal/handler -run 'TestWorkspaceRoutes_Lifecycle|TestRetainedWorkspaceVisibility|TestSearchFiltersRetainedWorkspace'` and confirm the new tests fail.

- [ ] Wire the two REST actions to the shared lifecycle service. Keep existing `DELETE /workspaces/:id` as soft delete, but call `lifecycle.Apply(ctx, userID, id, model.WorkspaceLifecycleDelete, 1)`. Return HTTP 409 for `last_active_workspace` and `workspace_deleted`, HTTP 404 for missing/unowned roots, and HTTP 410 for `permanently_deleted`.

- [ ] Change normal SQL reads to require an active parent. Use an explicit join rather than filtering in Go:

```sql
JOIN workspaces w ON w.id = c.workspace_id AND w.user_id = c.user_id
WHERE c.user_id = $1 AND w.is_deleted = 0
```

Apply the equivalent Collection → Workspace join to Bookmark routes and default-Collection computation. Sync queries are explicitly exempt.

- [ ] Inject the database into `SearchHandler`. Validate returned candidate IDs against PostgreSQL with Bookmark → Collection → Workspace joins and require `b.is_trashed=0`, `c.is_deleted=0`, and `w.is_deleted=0` before serializing hits. Preserve MeiliSearch order by filtering the original hit slice against the returned ID set.

- [ ] Ensure lifecycle search effects call the existing bulk-delete/reindex helpers. A failed index operation is logged and retried/repaired later; it never rolls back PostgreSQL.

- [ ] Run `go test ./internal/handler -run 'TestWorkspaceRoutes_Lifecycle|TestRetainedWorkspaceVisibility|TestSearchFiltersRetainedWorkspace'` and confirm all cases pass.

- [ ] Commit in `../TabSlate-server`:

```bash
git add internal/handler/workspaces.go internal/handler/collections.go internal/handler/bookmarks.go internal/handler/search.go internal/handler/workspace_visibility_test.go app/server.go
git commit -m "feat(workspaces): enforce active parent visibility"
```

### Task 6: Use the lifecycle service for per-plan retention expiry

**Files**

- Modify: `../TabSlate-server/internal/handler/cleanup.go`
- Modify: `../TabSlate-server/internal/handler/cleanup_test.go`
- Modify: `../TabSlate-server/app/server.go`

**Interfaces**

```go
type CleanupBillingProvider interface {
    GetLimits(ctx context.Context, userID string) (*billing.Limits, error)
}

func (h *CleanupHandler) expireWorkspaces(ctx context.Context, now time.Time) error
```

- [ ] Add failing cleanup tests with two users on different `TrashGraceDays` values plus one unlimited (`-1`) user. Verify only expired state-1 Workspaces are purged, `-1` never expires, descendants are deleted atomically, restored roots are skipped, failures leave the aggregate recoverable, and state-2 Workspace rows remain after every cleanup phase.

- [ ] Run `go test ./internal/handler -run 'TestCleanup_WorkspaceRetention|TestCleanup_NeverDeletesWorkspaceTerminal'` and confirm it fails because Cleanup ignores Workspaces.

- [ ] Add the narrow billing interface to Cleanup and inject the existing provider from `app/server.go`; do not read an independent retention environment value.

- [ ] Query retained Workspace candidates by user, call `GetLimits` once per user, skip automatic expiry when `TrashGraceDays < 0`, compare `deleted_at` against nonnegative grace periods, and call `lifecycle.Apply(ctx, userID, workspaceID, model.WorkspaceLifecyclePurge, 1)` for each expired root. Treat a concurrent restore or already-terminal result as a benign skip; a billing lookup failure leaves that user’s roots retained for the next run.

- [ ] Keep the existing child phase-2 cleanup, but explicitly exclude the `workspaces` table from physical tombstone deletion. Add a regression assertion that a state-2 row older than every child tombstone window still exists and remains scrubbed.

- [ ] Run `go test ./internal/handler -run 'TestCleanup_WorkspaceRetention|TestCleanup_NeverDeletesWorkspaceTerminal'` and then `go test ./internal/handler`.

- [ ] Commit in `../TabSlate-server`:

```bash
git add internal/handler/cleanup.go internal/handler/cleanup_test.go app/server.go
git commit -m "feat(cleanup): expire retained workspaces by plan"
```

### Task 7: Return unified total and effective-trash quota usage

**Files**

- Modify: `../TabSlate-server/internal/handler/billing.go`
- Create: `../TabSlate-server/internal/handler/billing_usage_test.go`
- Modify: `../TabSlate-server/internal/handler/workspaces.go`
- Modify: `../TabSlate-server/internal/handler/collections.go`
- Modify: `../TabSlate-server/internal/handler/bookmarks.go`

**Interfaces**

```go
type planUsage struct {
    Workspaces  int `json:"workspaces"`
    Collections int `json:"collections"`
    Bookmarks   int `json:"bookmarks"`
    Tags        int `json:"tags"`
    SavedGroups int `json:"saved_groups"`
}

type planResponse struct {
    Subscription *billing.Subscription `json:"subscription"`
    Limits       *billing.Limits       `json:"limits"`
    Usage        planUsage             `json:"usage"`
    TrashUsage   planUsage             `json:"trash_usage"`
}
```

- [ ] Add a failing fixture test containing active, individually trashed, archived, retained-parent, and terminal resources. Assert each total uses the retained definition and every resource satisfies `usage = (usage - trash_usage) + trash_usage` without double-counting nested trash.

- [ ] Run `go test ./internal/handler -run 'TestPlanUsage_EffectiveContainment|TestCreationQuotaCountsRetainedRows'` and confirm retained-parent and trash-breakdown assertions fail.

- [ ] Replace independent count queries with one snapshot-consistent SQL statement composed from CTEs. Compute effective trash using containment predicates:

```sql
-- Collection trash predicate
c.is_deleted = 1 OR w.is_deleted = 1

-- Bookmark trash predicate
b.is_trashed = 1 OR c.is_deleted = 1 OR w.is_deleted = 1

-- Saved Group trash predicate
g.is_deleted = 1 OR w.is_deleted = 1
```

Use `< 2` for totals, count each row once, count archive as in use, and return zero trash for Tags.

- [ ] Align REST creation guards with the same total predicates. Restoring a Workspace must not call a quota guard because the retained aggregate was already counted.

- [ ] Run `go test ./internal/handler -run 'TestPlanUsage_EffectiveContainment|TestCreationQuotaCountsRetainedRows'` and then `go test ./...`.

- [ ] Commit in `../TabSlate-server`:

```bash
git add internal/handler/billing.go internal/handler/billing_usage_test.go internal/handler/workspaces.go internal/handler/collections.go internal/handler/bookmarks.go
git commit -m "feat(billing): unify retained and trash usage"
```

### Server checkpoint

- [ ] From `../TabSlate-server`, run:

```bash
gofmt -w internal/model/model.go internal/model/model_test.go internal/handler/workspace_lifecycle.go internal/handler/workspace_lifecycle_test.go internal/handler/sync.go internal/handler/sync_dependencies.go internal/handler/sync_test.go internal/handler/sync_dependencies_test.go internal/handler/workspaces.go internal/handler/collections.go internal/handler/bookmarks.go internal/handler/search.go internal/handler/workspace_visibility_test.go internal/handler/cleanup.go internal/handler/cleanup_test.go internal/handler/billing.go internal/handler/billing_usage_test.go app/server.go
go test ./...
```
- [ ] Run `go test -race ./internal/handler -run 'TestWorkspaceLifecycle|TestSyncPush.*Workspace|TestCleanup_Workspace'`.
- [ ] Inspect the migration against a database snapshot and record counts for active, legacy-retained, and terminal Workspaces. Confirm no state-2 row retains a name, icon, color, or nonzero position.
- [ ] Do not begin frontend lifecycle implementation until pull returns `capabilities.workspace_parent_tombstone=true` and the server tests pass.

---

## Phase 2: Client persistence and serialized reconciliation

### Task 8: Add client lifecycle DTOs, IndexedDB v3, intents, and scoped capability state

**Files**

- Modify: `lib/types.ts`
- Modify: `lib/api.ts`
- Modify: `lib/idb.ts`
- Create: `lib/workspace-lifecycle-state.ts`
- Create: `test/workspace-lifecycle-state.test.ts`
- Create: `test/api.test.ts`

**Interfaces**

```ts
export type WorkspaceLifecycleAction = "delete" | "restore" | "purge";

export interface WorkspaceLifecycleIntent {
  workspaceId: string;
  action: Exclude<WorkspaceLifecycleAction, "purge">;
  baseSeq: number;
  previousActiveWorkspaceId: string;
  createdAt: number;
}

export interface WorkspaceLifecycleIntentRecord {
  version: 1;
  intents: WorkspaceLifecycleIntent[];
}

export interface WorkspaceLifecycleCapabilityRecord {
  version: 1;
  userId: string;
  serverOrigin: string;
  supported: true;
  observedAt: number;
}

export interface WorkspaceFullPullRecord {
  version: 1;
  userId: string;
  serverOrigin: string;
  serverSeq: number;
  completedAt: number;
}

export interface WorkspaceLifecycleDeferredSyncRecord {
  version: 1;
  payloadsByWorkspaceId: Record<string, SyncPushPayload>;
}

export interface SyncCapabilities {
  workspace_parent_tombstone?: boolean;
}

export interface CommitWorkspaceLifecycleIntentInput {
  workspace: Workspace;
  intent: WorkspaceLifecycleIntent;
  activeWorkspaceId?: string;
}

export function idbCommitWorkspaceLifecycleIntent(
  input: CommitWorkspaceLifecycleIntentInput,
): Promise<void>;
```

- [ ] Write failing DTO tests for protocol version `2`, explicit `lifecycle_action`, pull capability, Workspace `is_deleted/deletion_model`, `trash_usage`, and all four structured rejection reasons.

- [ ] Write failing persistence tests proving a capability confirmed for user A/server A is unavailable to user B or server B; an omitted/false later capability invalidates it; a delete intent round-trips with all five fields; deferred payload merge/removal is isolated per Workspace.

- [ ] Run `bun test test/api.test.ts test/workspace-lifecycle-state.test.ts` and confirm it fails on missing fields and storage functions.

- [ ] Extend local `Workspace` with `deletionModel?: 0 | 1`, then update `lib/api.ts` with separate pull and push Workspace types. The `api.syncPush` network boundary must always inject `protocol_version: 2`; internal queue/recovery payloads can remain entity-only snapshots, and ordinary queue Workspace entities omit `lifecycle_action`. Normalize an older pull with missing fields to `is_deleted = deleted_at ? 1 : 0` and `deletion_model = deleted_at ? 0 : 1`; make `capabilities` plus `trash_usage` optional when decoding an older self-hosted server.

- [ ] Bump `DB_VERSION` from `2` to `3` and add `workspaceId` to the `groups` object store:

```ts
if (oldVersion < 3) {
  const groupsStore = transaction.objectStore("groups");
  if (!groupsStore.indexNames.contains("workspaceId")) {
    groupsStore.createIndex("workspaceId", "workspaceId", { unique: false });
  }
}
```

- [ ] Implement versioned KV records using these exact keys:

```ts
export const WORKSPACE_LIFECYCLE_INTENTS_KEY = "workspace-lifecycle-intents-v1";
export const WORKSPACE_CAPABILITY_KEY_PREFIX = "workspace-parent-tombstone-capability-v1";
export const WORKSPACE_FULL_PULL_KEY_PREFIX = "workspace-parent-tombstone-full-pull-v1";
export const WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY =
  "workspace-lifecycle-deferred-sync-v1";
```

Normalize the server URL to `new URL(serverUrl).origin`; include both normalized origin and user ID in capability/full-pull keys. Expose read, merge, remove, and invalidate helpers for intents, deferred payloads, capability, and full-pull state without type assertions or `any`.

- [ ] Add `idbCommitWorkspaceLifecycleIntent(input)` to `lib/idb.ts`. In one readwrite transaction over `workspaces` and `kv`, write the new Workspace root, update the versioned intent list, and optionally update `activeWorkspaceId`. Resolve only after transaction completion.

- [ ] Run `bun test test/api.test.ts test/workspace-lifecycle-state.test.ts` and `bun run compile`.

- [ ] Commit:

```bash
git add lib/types.ts lib/api.ts lib/idb.ts lib/workspace-lifecycle-state.ts test/api.test.ts test/workspace-lifecycle-state.test.ts
git commit -m "feat(sync): persist workspace lifecycle state"
```

### Task 9: Implement atomic local aggregate discovery and terminal cleanup

**Files**

- Modify: `lib/idb.ts`
- Create: `lib/workspace-aggregate.ts`
- Create: `test/workspace-aggregate.test.ts`

**Interfaces**

```ts
export interface WorkspaceAggregateIds {
  workspaceId: string;
  collectionIds: string[];
  bookmarkIds: string[];
  groupIds: string[];
  groupTabIds: string[];
}

export function loadWorkspaceAggregateIds(
  workspaceId: string,
): Promise<WorkspaceAggregateIds>;

export function permanentlyDeleteWorkspaceAggregate(
  workspaceId: string,
  conflictOperation: BulkWriteOp,
): Promise<WorkspaceAggregateIds>;

export function clearWorkspaceAggregate(
  workspaceId: string,
  onCommitted: (ids: WorkspaceAggregateIds) => void,
): Promise<WorkspaceAggregateIds | undefined>;

export function toSyncEntityReferences(
  ids: WorkspaceAggregateIds,
): SyncEntityReference[];
```

- [ ] Add failing tests with active, archived, and trashed Bookmarks plus Saved Group tabs. Do not call lazy bucket loaders. Assert discovery returns every ID and terminal cleanup deletes all records, matching lifecycle intent/deferred payload, matching Guest provenance/orphan-recovery entry, and all descendant conflict records while leaving unrelated aggregates and account-scoped capability/full-pull markers intact.

- [ ] Add a failing atomicity test that injects a request error after descendant discovery and proves no store changed. Add an idempotency case that runs cleanup twice and a registry-reset race proving a committed aggregate is still reported as canonical success without reappearing in UI.

- [ ] Run `bun test test/workspace-aggregate.test.ts` and confirm the cleanup tests fail.

- [ ] Implement aggregate discovery from IndexedDB indexes: Collections by `workspaceId`, Groups by the new `workspaceId`, all three Bookmark buckets by each Collection ID, and Group Tabs by each Group ID. Deduplicate IDs with `Set` only in memory; do not hydrate Zustand stores.

- [ ] Implement one readwrite transaction spanning `workspaces`, `collections`, all Bookmark buckets, `groups`, `group-tabs`, and `kv`. Queue descendant deletes inside index request callbacks so the transaction remains alive. Read-modify-write lifecycle intents, lifecycle deferred payloads, Guest provenance, and the orphan-recovery record inside the same transaction. If `activeWorkspaceId` still matches the terminal root, select the nearest retained local state-0 root by position then ID and persist the replacement in this transaction.

- [ ] Wrap permanent cleanup with the existing cross-context conflict boundary:

```ts
let committedIds: WorkspaceAggregateIds | undefined;
await syncConflictRegistry.executeClearRootTransaction(
  "workspace",
  workspaceId,
  async mutation => {
    committedIds = await permanentlyDeleteWorkspaceAggregate(
      workspaceId,
      mutation.operation,
    );
  },
  () => {
    if (committedIds) {
      onCommitted(committedIds);
    }
  },
);
return committedIds;
```

Keep the existing `executeClearRootTransaction` boolean contract so current callers remain unchanged; the closure carries the committed ID set to the post-commit callback. Treat a defined `committedIds` as canonical success even if a concurrent registry reset makes the method return `false`, because the aggregate transaction has already committed. In that reset race, do not roll back the optimistic card; account/store reset or the next hydrate reconciles memory.

- [ ] Expose `toSyncEntityReferences(ids)` so queue and recovery pruning operate on the same canonical descendant set.

- [ ] Run `bun test test/workspace-aggregate.test.ts test/sync-conflicts.test.js` and `bun run compile` to cover the new aggregate path and the unchanged conflict transaction contract.

- [ ] Commit:

```bash
git add lib/idb.ts lib/workspace-aggregate.ts test/workspace-aggregate.test.ts
git commit -m "feat(workspaces): add atomic aggregate cleanup"
```

### Task 10: Add idempotent queue pruning and confirmed Sync resolution primitives

**Files**

- Modify: `lib/sync-queue.ts`
- Modify: `lib/sync-recovery.ts`
- Modify: `lib/sync-engine.ts`
- Modify: `lib/sync-engine-runtime.ts`
- Modify: `lib/workspace-lifecycle-state.ts`
- Modify: `test/sync-queue.test.js`
- Modify: `test/sync-recovery.test.js`
- Modify: `test/sync-engine-ordering.test.js`
- Modify: `test/workspace-lifecycle-state.test.ts`

**Interfaces**

```ts
export interface SyncResolutionContext {
  pullConfirmed(afterSeq: number): Promise<SyncPullResponse>;
  pushConfirmed(payload: SyncPushPayload): Promise<SyncPushResponse>;
  captureDeferredEntities(
    workspaceId: string,
    references: readonly SyncEntityReference[],
  ): Promise<void>;
  blockEntities(references: readonly SyncEntityReference[]): void;
  pruneEntities(references: readonly SyncEntityReference[]): Promise<void>;
  isCurrent(): boolean;
}

export interface PullMergeResult {
  errorMessage: string | null;
}

export interface WorkspaceLifecycleSyncGate {
  shouldResolveWorkspaceLifecycleBeforePush(): Promise<boolean>;
}

export interface SyncQueueLifecycleGate {
  shouldDeferOrdinaryPush(): Promise<boolean>;
}

export interface WorkspaceLifecycleQueueCapture {
  extractEntities(
    references: readonly SyncEntityReference[],
  ): SyncPushPayload;
}

export type OnPullSuccess = (
  response: SyncPullResponse,
  isCurrent: () => boolean,
  context: SyncResolutionContext,
) => Promise<PullMergeResult>;

export class SyncRejectedError extends Error {
  constructor(readonly rejected: readonly SyncRejected[]) {
    super("Sync push was rejected");
  }
}
```

- [ ] Add failing queue tests proving `extractEntities` returns/removes only matching IDs from every live entity map and pending conflict-clear map, and `pruneEntities` is an idempotent discard wrapper. Prove `blockEntities` prevents the same root/descendants from re-entering the queue until engine destruction. Add recovery tests proving extraction removes the same references from `tabslate-sync-recovery`, including a snapshot loaded after restart.

- [ ] Add failing engine/queue tests proving confirmed push returns the body, refreshes once on 401, checks retirement/currentness before and after I/O, and serializes with pull merge. Assert public `forcePush` throws `SyncRejectedError` when the requested root appears in `rejected`. When a lifecycle intent exists, assert debounce/recovery auto-push leaves the queue untouched and startup/manual sync performs pull plus lifecycle reconciliation before the first ordinary queue flush.

- [ ] Run `bun test test/sync-queue.test.js test/sync-recovery.test.js test/sync-engine-ordering.test.js test/workspace-lifecycle-state.test.ts` and confirm the new cases fail.

- [ ] Add `SyncQueue.extractEntities(references)`, `SyncQueue.blockEntities(references)`, `SyncQueue.pruneEntities(references)`, and `extractSyncRecoveryEntities(references)`. Reuse one entity-type-to-payload-key mapping, ignore blocked IDs in later `enqueue`, persist the filtered recovery remainder, and clear the session key when it becomes empty. Extract/export the existing 900-entity dependency-safe chunker so lifecycle confirmed pushes use the identical request limit.

- [ ] Implement `captureDeferredEntities(workspaceId, references)` by extracting matching live and recovery payloads, merging them by ID, and atomically merging the result into `workspace-lifecycle-deferred-sync-v1`. Repeated capture keeps the newest snapshot per entity and never overwrites another Workspace’s deferred payload.

- [ ] Refactor authenticated HTTP retry into private `pullWithRefresh` and `pushWithRefresh` methods. Build `SyncResolutionContext` only inside the existing `resolutionChain`, and reject context use when the engine is retired or no longer current.

- [ ] Change `forcePush` to run on the same serialization boundary, return `SyncPushResponse`, call the existing rejection resolution path, and throw `SyncRejectedError` if a target is rejected. Update Collection/Group permanent-delete callers to roll back on this exception rather than trusting HTTP 200.

- [ ] Pass `SyncResolutionContext` to `onPullSuccess`. Keep `localSeq` ownership in `App.tsx`; the engine must not advance it before the callback resolves.

- [ ] Inject `shouldResolveWorkspaceLifecycleBeforePush()` into SyncEngine and the equivalent `shouldDeferOrdinaryPush()` into SyncQueue. While a persisted lifecycle intent is runnable under a confirmed/cached capability, automatic debounce/recovery pushes return without taking a queue snapshot. In `forceSync` and initial recovery, run a pull/resolution pass first; only after that pass resolves and clears/blocks the intent may the ordinary queue flush. This guarantees direct child enqueues created during an offline restore cannot reach a still-retained server parent before the restore action.

- [ ] Run `bun test test/sync-queue.test.js test/sync-recovery.test.js test/sync-engine-ordering.test.js test/workspace-lifecycle-state.test.ts` and `bun run compile`.

- [ ] Commit:

```bash
git add lib/sync-queue.ts lib/sync-recovery.ts lib/sync-engine.ts lib/sync-engine-runtime.ts lib/workspace-lifecycle-state.ts test/sync-queue.test.js test/sync-recovery.test.js test/sync-engine-ordering.test.js test/workspace-lifecycle-state.test.ts
git commit -m "feat(sync): confirm and prune lifecycle pushes"
```

### Task 11: Convert the Workspace store to parent tombstones and active-only selection

**Files**

- Modify: `store/workspace-store.ts`
- Modify: `lib/sync-lifecycle.ts`
- Modify: `store/bookmarks-store.ts`
- Modify: `store/groups-store.ts`
- Modify: `test/workspace-store.test.js`
- Create: `test/workspace-store-lifecycle.test.ts`

**Interfaces**

```ts
export interface WorkspaceActionResult {
  status: "queued" | "completed" | "blocked" | "unsupported";
  reason?: "last_active_workspace" | "server_capability" | "offline";
}

export interface WorkspaceMergeResult {
  terminalWorkspaceIds: string[];
  restoredWorkspaceIds: string[];
}

interface WorkspaceState {
  deleteWorkspace(id: string): Promise<WorkspaceActionResult>;
  restoreWorkspace(id: string): Promise<WorkspaceActionResult>;
  permanentlyDeleteWorkspace(id: string): Promise<WorkspaceActionResult>;
  getActiveWorkspaces(): Workspace[];
  getDeletedWorkspaces(): Workspace[];
  mergeFromServer(response: SyncPullResponse): Promise<WorkspaceMergeResult>;
  confirmWorkspaceStoreEntitySeqs(
    entities: Pick<SyncPushEntities, "workspaces" | "collections" | "tags">,
    serverSeq: number,
  ): void;
}

interface BookmarkSyncConfirmationAction {
  confirmBookmarkEntitySeqs(
    entities: readonly SyncEntity[],
    serverSeq: number,
  ): void;
}

interface GroupSyncConfirmationAction {
  confirmGroupEntitySeqs(
    entities: readonly SyncEntity[],
    serverSeq: number,
  ): void;
}
```

- [ ] Add failing store tests proving delete writes only the root tombstone/intent/replacement active ID; every child object and bucket is byte-identical; the final active Workspace is blocked; deleted roots survive hydration but are never selected active.

- [ ] Add failing merge tests for pending local delete vs server state `0`, pending restore vs server state `1`, acknowledged matching state, remote state `1` switching the active ID, and state `2` returned as `terminalWorkspaceIds` without persisting a usable root.

- [ ] Run `bun test test/workspace-store.test.js test/workspace-store-lifecycle.test.ts` and confirm current destructive delete and merge behavior fail.

- [ ] Replace destructive `deleteWorkspace` with `idbCommitWorkspaceLifecycleIntent`. Choose the nearest active replacement by position and stable ID, persist first, then update Zustand. Ask the registered engine to capture pending aggregate queue/recovery entries before reconciliation. Do not call Collection, Bookmark, or Group delete actions and do not decrement usage.

- [ ] Implement restore as one root+intent transaction. It preserves position and every child lifecycle field. Guest actions are always available; authenticated soft actions require the scoped cached capability. Add a runtime wake function accepting `workspaceId`; the registered engine first captures that aggregate’s pending live/recovery queue entries into the durable deferred record, then requests Sync. Do not directly import the mutable `syncEngine` singleton into the store.

- [ ] Implement permanent delete as push-first: authenticated mode removes only the card from Zustand optimistically, calls the registered runtime purge, and rolls the card back on network failure or rejection. It must not delete IndexedDB records or decrement usage before confirmed success; after cleanup, refresh the authoritative plan snapshot rather than guessing unloaded descendant counts. Guest mode calls the atomic local aggregate cleanup and derives usage from the remaining aggregate data. Offline authenticated mode returns `offline` and makes no optimistic change.

- [ ] Make `hydrate`, active-ID setters, default Collection selection, and public active/deleted selectors use explicit active predicates. Prevent `setActiveWorkspaceId` from accepting a deleted ID. Creation quota counts all retained roots, while a new Workspace position is `max(position across active and deleted roots) + 1` to avoid a future restore collision.

- [ ] Change Workspace merge to preserve state `1`, never `idbDelete` it, honor pending intents, and return terminal plus state-1-to-state-0 restored IDs for the serialized pull coordinator. Add store-only `removeWorkspaceAggregateFromState(ids)` actions to Workspace, Bookmark, and Group stores; each action must respect lazy bucket loaded flags.

- [ ] Exclude roots with pending lifecycle intents from `workspace-store.sweepUnsynced()` so an ordinary state snapshot cannot collapse the ordered transition.

- [ ] Add sequence-only confirmation actions to Workspace, Bookmark, and Group stores. They update a loaded entity only when its current canonical sync fields still match the pushed snapshot; Bookmark actions respect lazy archived/trashed flags. These actions do no IndexedDB writes and are called only after `sync-confirmation.ts` commits.

- [ ] Run `bun test test/workspace-store.test.js test/workspace-store-lifecycle.test.ts` and `bun run compile`.

- [ ] Commit:

```bash
git add store/workspace-store.ts store/bookmarks-store.ts store/groups-store.ts lib/sync-lifecycle.ts test/workspace-store.test.js test/workspace-store-lifecycle.test.ts
git commit -m "feat(workspaces): store parent tombstone intents"
```

### Task 12: Reconcile lifecycle intents inside SyncEngine’s serialized pull boundary

**Files**

- Create: `lib/workspace-lifecycle-coordinator.ts`
- Create: `lib/sync-confirmation.ts`
- Modify: `lib/sync-engine.ts`
- Modify: `lib/sync-lifecycle.ts`
- Modify: `entrypoints/newtab/App.tsx`
- Modify: `lib/guest-workspace-reconciliation.ts`
- Create: `test/workspace-lifecycle-coordinator.test.ts`
- Create: `test/sync-confirmation.test.ts`
- Modify: `test/sync-engine-ordering.test.js`
- Modify: `test/sync-pull-persistence.test.js`

**Interfaces**

```ts
export interface WorkspaceLifecycleCoordinatorDependencies {
  context: SyncResolutionContext;
  userId: string;
  serverOrigin: string;
  authoritativeWorkspaces: readonly ServerWorkspace[];
  reportConflict(conflict: SyncConflict): Promise<void>;
  notify(messageKey: string): void;
}

export async function reconcileWorkspaceLifecycleIntents(
  dependencies: WorkspaceLifecycleCoordinatorDependencies,
): Promise<void>;

export interface WorkspacePurgeResult {
  status: "completed" | "rejected";
  reason?: KnownSyncRejectionReason;
}

export function confirmSyncPayload(
  payload: SyncPushPayload,
  serverSeq: number,
): Promise<void>;
```

- [ ] Add failing coordinator tests for a never-synced offline Workspace: push active root, then Collections/Bookmarks/Groups in dependency-safe chunks, then `lifecycle_action=delete`. Assert every response is awaited, each accepted chunk persists its `server_seq` before the next phase, and any rejection stops the next phase.

- [ ] Add failing confirmation tests across Workspaces, Collections, Tags, all three Bookmark buckets, and Groups. A confirmation updates only `seq`, only when the current canonical sync fields still match the pushed snapshot (ignore server-generated `seq`/`updated_at`), and updates loaded Zustand state only after the IndexedDB transaction commits. A concurrent rename/move/tab edit must remain unsynced.

- [ ] Add failing tests for a confirmed root delete (descendants before action), restore (root action before pre-existing direct child enqueues and normal sweep), `last_active_workspace` rollback, purge of an as-yet-unconfirmed local delete (confirm delete first), terminal purge blocking plus queue/recovery pruning before local cleanup, engine retirement during each awaited phase, and restart with a persisted intent.

- [ ] Add a failing full-pull migration test: a delta response first reveals capability `true`, the callback requests `after_seq=0`, merges that authoritative response, performs terminal cleanup, commits the scoped marker and `localSeq` last, and retries everything if it is retired before completion. Add a downgrade test proving a later omitted/false capability quarantines pending intents without blocking unrelated queue entities.

- [ ] Run `bun test test/workspace-lifecycle-coordinator.test.ts test/sync-confirmation.test.ts test/sync-engine-ordering.test.js test/sync-pull-persistence.test.js` and confirm the ordering/checkpoint tests fail.

- [ ] Reconcile each intent against the authoritative Workspace states from the just-completed pull: delete + absent/state `0` runs ordered upload then delete; delete + state `1` clears the acknowledged intent and, if deferred entries remain from a concurrent remote delete, keeps them under a `parent_deleted` root conflict for a later restore; restore + state `1` sends restore then uploads deferred entries; restore + state `0` uploads deferred entries then clears the acknowledged intent; restore + absent and `baseSeq===0` creates the active root, uploads deferred entries, and lets normal descendant sweeps follow; either action + state `2` runs terminal cleanup. A confirmed root missing from a full pull is treated as terminal/missing conflict, never recreated.

- [ ] Implement aggregate payload construction from current IndexedDB values. Before a delete transition against an absent or active server root, capture matching queue/recovery snapshots into the deferred record, then push the latest aggregate explicitly in these phases:

```ts
await pushAndRequireAccepted(activeWorkspacePayload);
await pushAndRequireAccepted(collectionsAndGroupsPayload);
await pushAndRequireAccepted(bookmarksPayload);
await pushAndRequireAccepted(deleteLifecyclePayload);
```

For an active server root, the first phase flushes the latest root metadata before deletion; for an absent base-sequence-zero root, it creates the active parent. Include every entity referenced by the durable deferred payload plus every local `seq=0` descendant, and omit already-confirmed entities that have no deferred reference. Never represent both active and deleted root states in the ordinary queue.

The first phase must derive an active wire mutation from the locally deleted root by omitting `lifecycle_action` and `deleted_at`; it must not serialize the local tombstone early. Split every phase with the shared 900-entity chunker and require every chunk to be accepted before continuing.

After each accepted chunk, call `confirmSyncPayload(chunk, response.server_seq)` before issuing the next chunk. Use one IndexedDB transaction per confirmed chunk and update only sequence fields, never lifecycle/content fields. Compare canonical persisted values with the pushed snapshot before setting a sequence, so a concurrent edit stays unsynced, and remove only the accepted entity references from the durable deferred payload in that transaction. For the final delete action, confirm the root sequence and clear the matching intent in the same transaction. A restore action confirms the root but retains its intent until every pre-restore deferred entity is accepted; only then does one transaction clear the intent/deferred entry. This makes a crash between phases restart from the first unconfirmed phase instead of resending confirmed children beneath a retained parent.

For the active-root phase of a pending delete, compare name/color/position and other metadata while treating the local `deletedAt` plus matching delete intent as an intentional overlay; do not require the local root to look active and do not clear the intent. The final lifecycle confirmation handles `deletedAt` and intent removal.

- [ ] Implement restore as one confirmed `lifecycle_action=restore` push followed by durable deferred-entity chunks while the intent continues gating the ordinary queue. After those chunks succeed, clear the intent/deferred entry, clear the root’s `parent_deleted` descendant conflict tree, and then allow normal sweeps. If the pre-restore root used `deletionModel=0`, emit the one-time localized archive-state limitation notice. Do the same conflict clear for remote restored IDs returned by Workspace merge. On `last_active_workspace`, atomically restore the local root and `previousActiveWorkspaceId`, clear the delete intent, and emit the localized reason. Map new `parent_deleted` responses to blocked descendant conflicts and `permanently_deleted` to aggregate cleanup.

- [ ] Add a registered `purgeWorkspace(id)` engine method. If the root still has a delete intent, first run pull/lifecycle reconciliation and require a confirmed server state `1`. Then await the ordinary queue flush outside `resolutionChain`, enter the chain, push only `lifecycle_action=purge`, and require the root to be absent from `rejected`. After confirmation it blocks the aggregate references from queue re-entry, prunes live/recovery entities, performs conflict-wrapped aggregate cleanup, and returns a structured result. Network/rejection paths preserve every local record.

- [ ] Update `App.tsx` pull orchestration. When a capability-true response lacks the scoped full-pull marker, call `context.pullConfirmed(0)` and use that response for all subsequent work. Preserve this exact order:

```ts
prepareGuestWorkspaceForPull();
mergeWorkspaces();
mergeGroups();
mergeBookmarks();
blockPruneAndCleanTerminalAggregates();
clearRestoredWorkspaceConflictTrees();
confirmGuestWorkspaceFromPull();
reconcileWorkspaceLifecycleIntents();
sweepAllUnsynced();
commitFullPullMarkerAndLocalSeq();
```

Move `localSeq` persistence to the final durable checkpoint. If capability is omitted/false, invalidate the scoped cache and leave lifecycle actions disabled; do not run an unsafe fallback.

Commit the scoped full-pull marker and `localSeq` in one `idbBulkWrite` transaction, then update Zustand. `localSeq` must use only the authoritative pull response sequence, never a later push response sequence, because another device may have written an unseen intermediate delta. A failed checkpoint leaves both values unchanged so the full migration repeats safely.

- [ ] When a later response omits/disables capability, retain every local lifecycle intent and aggregate, record an `unsupported_server` Workspace conflict, and capture that aggregate from live/recovery queues into its durable deferred payload. The gate treats the intent as quarantined while capability is false so unrelated ordinary entities may flush. A future capability-true pull clears that root conflict and makes the intent runnable again; never roll it back or translate it into the legacy cascade.

- [ ] Keep lifecycle-specific rejection handling before generic quota-conflict handling. Any deterministic rejection during a phased aggregate upload stops before the parent delete, preserves the intent, captures remaining aggregate queue/recovery entries into the deferred record, and records the rejected entity plus a lifecycle-root conflict; that root is quarantined so unrelated data may sync. Capacity refresh/manual retry clears recoverable quota conflicts and resumes at the first entity whose confirmation was not persisted. A pending deleted Guest root rejected by Workspace quota is never passed to `planGuestWorkspaceMigration`.

- [ ] Run `bun test test/workspace-lifecycle-coordinator.test.ts test/sync-confirmation.test.ts test/sync-engine-ordering.test.js test/sync-pull-persistence.test.js` and `bun run compile`.

- [ ] Commit:

```bash
git add lib/workspace-lifecycle-coordinator.ts lib/sync-confirmation.ts lib/sync-engine.ts lib/sync-lifecycle.ts lib/guest-workspace-reconciliation.ts entrypoints/newtab/App.tsx test/workspace-lifecycle-coordinator.test.ts test/sync-confirmation.test.ts test/sync-engine-ordering.test.js test/sync-pull-persistence.test.js
git commit -m "feat(sync): reconcile workspace lifecycle intents"
```

### Task 13: Recover legacy Guest orphan aggregates without flattening deleted data

**Files**

- Create: `lib/guest-workspace-orphan-recovery.ts`
- Modify: `lib/guest-workspace.ts`
- Modify: `lib/guest-workspace-reconciliation.ts`
- Modify: `entrypoints/newtab/App.tsx`
- Create: `test/guest-workspace-orphan-recovery.test.ts`
- Modify: `test/guest-workspace.test.js`
- Modify: `test/guest-workspace-reconciliation.test.js`

**Interfaces**

```ts
export const GUEST_WORKSPACE_ORPHAN_RECOVERY_KEY =
  "guest-workspace-orphan-recovery-v1";

export interface RecoveredGuestWorkspaceRecord {
  workspaceId: string;
  collectionIds: string[];
  groupIds: string[];
  recoveredAt: number;
}

export function recoverLegacyGuestWorkspaceOrphans(): Promise<
  RecoveredGuestWorkspaceRecord[]
>;

export function restoreRecoveredGuestAggregate(
  workspaceId: string,
): Promise<void>;
```

- [ ] Add failing migration tests with orphan Collections, all Bookmark buckets, Saved Groups, and Group Tabs. Assert one synthetic retained root per unresolved `workspaceId`, original IDs remain unchanged, earliest child deletion time is used, and the completion marker is written only after the transaction commits.

- [ ] Add failing tests proving the migration is idempotent, ignores empty/unrecoverable IDs, does not claim `guest-workspace-provenance-v1`, and restores synthetic descendants to active while retaining Collection archive metadata.

- [ ] Add a failing quota-reconciliation test proving a deleted automatic Guest seed remains intact when Workspace capacity is unavailable and is never migrated into another confirmed Workspace.

- [ ] Run `bun test test/guest-workspace-orphan-recovery.test.ts test/guest-workspace.test.js test/guest-workspace-reconciliation.test.js` and confirm the new cases fail.

- [ ] Implement one IndexedDB migration transaction that scans unresolved parent IDs, synthesizes `{ id: originalId, name: "Recovered Workspace", deletedAt, deletionModel: 0, seq: 0 }`, writes a matching base-sequence-zero delete intent, retains descendants in place, and writes the separate recovery marker last. Run it after store hydration but before creating a new Guest seed.

- [ ] Implement the disclosed legacy restore transaction. Clear cascade-era Collection/Group/Bookmark trash state for descendants recorded under the synthetic root, preserve Collection `archivedAt`, change the restored root to `deletionModel=1`, clear its synthetic delete intent, and persist it as the active Workspace when selected. Update loaded Zustand buckets only after commit and show the localized archival-loss notice once.

- [ ] Add an early deleted-root branch to Guest reconciliation. If capacity exists, let the lifecycle coordinator confirm active root → descendants → delete. If capacity is absent, retain the aggregate and intent, record a Workspace root quota conflict, capture only that aggregate into its durable deferred payload, and treat the intent as quarantined so unrelated account data continues syncing. Offer only upgrade, another permanent deletion, or retry; when `fetchPlan()` observes capacity, clear the root conflict and wake lifecycle reconciliation.

- [ ] Run `bun test test/guest-workspace-orphan-recovery.test.ts test/guest-workspace.test.js test/guest-workspace-reconciliation.test.js` and `bun run compile`.

- [ ] Commit:

```bash
git add lib/guest-workspace-orphan-recovery.ts lib/guest-workspace.ts lib/guest-workspace-reconciliation.ts entrypoints/newtab/App.tsx test/guest-workspace-orphan-recovery.test.ts test/guest-workspace.test.js test/guest-workspace-reconciliation.test.js
git commit -m "feat(workspaces): recover legacy guest aggregates"
```

---

## Phase 3: Workspace Manager, quota presentation, and visibility

### Task 14: Build the account-level Workspace Manager and guarded lifecycle dialogs

**Files**

- Create: `components/dashboard/workspace-manager/index.tsx`
- Create: `components/dashboard/workspace-manager/model.ts`
- Create: `components/dashboard/workspace-manager/workspace-card.tsx`
- Create: `components/dashboard/workspace-manager/delete-workspace-dialog.tsx`
- Create: `components/dashboard/workspace-manager/permanent-delete-dialog.tsx`
- Modify: `components/dashboard/workspace-rail.tsx`
- Modify: `public/_locales/en/messages.json`
- Modify: `public/_locales/zh_CN/messages.json`
- Create: `test/workspace-manager.test.tsx`

**Interfaces**

```ts
interface WorkspaceAggregateCounts {
  collections: number;
  bookmarks: number;
  savedGroups: number;
}

interface WorkspaceCardProps {
  workspace: Workspace;
  counts: WorkspaceAggregateCounts;
  retentionLabel: string;
  canDelete: boolean;
  onSwitch(workspaceId: string): void;
  onRename(workspaceId: string): void;
  onRecolor(workspaceId: string): void;
  onDelete(workspaceId: string): void;
  onRestore(workspaceId: string): void;
  onPermanentlyDelete(workspaceId: string): void;
}

export function createWorkspaceManagerViewModel(input: {
  workspaces: readonly Workspace[];
  collections: readonly Collection[];
  bookmarks: {
    active: readonly Bookmark[];
    archived: readonly Bookmark[];
    trashed: readonly Bookmark[];
  };
  groups: readonly SavedGroup[];
  now: number;
  trashGraceDays: number;
  isGuest: boolean;
}): WorkspaceManagerViewModel;

export function canConfirmPermanentDelete(
  typedName: string,
  workspaceName: string,
): boolean;
```

- [ ] Add failing view-model/render-tree tests for the two semantic tabs (`In use`, `Deleted`), create/switch/rename/recolor actions in `In use`, active/deleted partitioning, aggregate counts across all Bookmark buckets, finite authenticated retention label, unlimited/Guest no-auto-delete labels, and `Still counts toward quota`.

- [ ] Add failing pure guard/handler tests: the last active Workspace has disabled Delete with the required explanation; soft delete confirmation receives counts/retention/quota; permanent delete remains disabled until the exact Workspace name is typed; offline authenticated purge is disabled; missing capability returns update-server guidance. Keep focus and keyboard behavior in the manual accessibility check because the repository has no DOM test runtime.

- [ ] Run `bun test test/workspace-manager.test.tsx` and confirm it fails because the manager does not exist.

- [ ] Build the manager as a standard shadcn `Dialog`. Implement accessible tabs with `role="tablist"`, `role="tab"`, `aria-selected`, and matching `tabpanel` IDs; do not add nonstandard `DialogContent` border/shadow overrides.

- [ ] On manager open, call the idempotent archived/trashed Bookmark loaders so deleted aggregate counts are complete. Select raw store fields with fine-grained Zustand selectors and calculate partitions/counts with `useMemo`.

- [ ] Implement card actions with `useCallback` handlers. Use the store’s structured results to keep dialogs open on failure and display existing `Alert` notifications. Do not optimistically claim purge completion before Sync confirmation.

- [ ] Replace the Rail’s inline create/edit/delete menu entry point with `Workspace Manager`; continue rendering only active Workspaces in the Rail. Move create, rename, recolor, switch, and delete management into the `In use` tab, and open the manager independently of `activeWorkspaceId`.

- [ ] Add all strings through `useTranslation`, including plural count variants, retention remaining/expired, Guest retention, quota warning, last-active guard, capability requirement, offline purge, confirmation labels, and the legacy restore disclosure.

- [ ] Run `bun test test/workspace-manager.test.tsx`, `bun run compile`, and manually verify keyboard tab selection, focus return, Escape behavior, and destructive-dialog focus trapping.

- [ ] Commit:

```bash
git add components/dashboard/workspace-manager components/dashboard/workspace-rail.tsx public/_locales/en/messages.json public/_locales/zh_CN/messages.json test/workspace-manager.test.tsx
git commit -m "feat(workspaces): add workspace manager"
```

### Task 15: Present one quota model with in-use and recycle-bin breakdowns

**Files**

- Create: `lib/quota-usage.ts`
- Modify: `store/plan-store.ts`
- Modify: `components/dashboard/sidebar/quota-card.tsx`
- Modify: `components/dashboard/workspace-manager/index.tsx`
- Modify: `components/ui/quota-alert.tsx`
- Modify: `public/_locales/en/messages.json`
- Modify: `public/_locales/zh_CN/messages.json`
- Modify: `test/plan-store.test.ts`
- Create: `test/quota-usage.test.ts`

**Interfaces**

```ts
export interface QuotaUsageBreakdown {
  total: PlanUsage;
  trash: PlanUsage;
  inUse: PlanUsage;
}

export function calculateGuestQuotaUsage(input: {
  workspaces: readonly Workspace[];
  collections: readonly Collection[];
  bookmarks: readonly Bookmark[];
  archivedBookmarks: readonly Bookmark[];
  trashedBookmarks: readonly Bookmark[];
  groups: readonly SavedGroup[];
  tags: readonly Tag[];
}): QuotaUsageBreakdown;

export function createQuotaBreakdown(
  total: PlanUsage,
  trash: PlanUsage,
): QuotaUsageBreakdown;
```

- [ ] Add failing pure-function tests for nested effective trash. Include a Bookmark that is individually trashed inside a trashed Collection inside a retained Workspace and prove it is counted exactly once. Assert archived entities are in use and every `inUse` value is `total - trash` without going negative.

- [ ] Update plan-store tests to require server `trash_usage`, retain it in state/persistence, reset it on logout, and preserve existing capacity-conflict recovery based on total usage.

- [ ] Run `bun test test/quota-usage.test.ts test/plan-store.test.ts` and confirm the new breakdown assertions fail.

- [ ] Implement `calculateGuestQuotaUsage` with effective parent containment and sets of retained Workspace/trashed Collection IDs. Count Workspace/Collection/Bookmark/Group rows while state is `< 2`; Tags use current total and zero trash.

- [ ] Add `trashUsage` and memoized `inUseUsage` to plan state. Authenticated mode trusts the server snapshot when present and defaults an older server’s omitted `trash_usage` to zeros while lifecycle capability remains disabled; Guest mode derives all three values locally after lazy Bookmark buckets are loaded for quota surfaces.

- [ ] Change `QuotaCard` to one resource table that shows `total / limit` and a secondary localized line such as `$1 in use + $2 in recycle bin`. Do not present Workspace quota as freed while descendant totals remain retained.

- [ ] Reuse the same breakdown in Workspace Manager and local quota alerts. Replace hardcoded strings in `QuotaAlert` with Chrome i18n keys.

- [ ] Run `bun test test/quota-usage.test.ts test/plan-store.test.ts` and `bun run compile`.

- [ ] Commit:

```bash
git add lib/quota-usage.ts store/plan-store.ts components/dashboard/sidebar/quota-card.tsx components/dashboard/workspace-manager/index.tsx components/ui/quota-alert.tsx public/_locales/en/messages.json public/_locales/zh_CN/messages.json test/quota-usage.test.ts test/plan-store.test.ts
git commit -m "feat(quota): show unified retained usage"
```

### Task 16: Enforce active-parent visibility in every client view and save target

**Files**

- Create: `lib/workspace-visibility.ts`
- Modify: `components/dashboard/content.tsx`
- Modify: `components/dashboard/favorites-content.tsx`
- Modify: `components/dashboard/archive-content.tsx`
- Modify: `components/dashboard/trash-content.tsx`
- Modify: `components/dashboard/search-box.tsx`
- Modify: `components/search/search-panel.tsx`
- Modify: `components/dashboard/add-bookmark-dialog.tsx`
- Modify: `components/dashboard/import-dialog.tsx`
- Modify: `components/dashboard/tabs-panel/save-collection-dialog.tsx`
- Modify: `components/dashboard/group-detail/index.tsx`
- Modify: `components/dashboard/groups-panel/index.tsx`
- Modify: `components/dashboard/groups-panel/create-group-bar.tsx`
- Modify: `components/dashboard/groups-panel/droppable-group-card.tsx`
- Modify: `components/dashboard/tabs-dnd-provider.tsx`
- Modify: `components/dashboard/tab-row.tsx`
- Modify: `components/dashboard/tabs-panel/group-card.tsx`
- Modify: `components/dashboard/sidebar/index.tsx`
- Modify: `entrypoints/popup/App.tsx`
- Create: `test/workspace-visibility.test.ts`

**Interfaces**

```ts
export function isActiveWorkspace(
  workspace: Workspace | undefined,
): workspace is Workspace;

export function getActiveWorkspaceCollectionIds(
  activeWorkspaceId: string,
  workspaces: readonly Workspace[],
  collections: readonly Collection[],
): Set<string>;

export function belongsToActiveWorkspace(
  collectionId: string,
  activeCollectionIds: ReadonlySet<string>,
): boolean;
```

- [ ] Add failing selector tests proving a deleted parent hides otherwise-active, favorite, archived, and trashed descendants from every current-Workspace scope. Assert no unresolved-parent fallback assigns an orphan to the active Workspace.

- [ ] Add failing target tests proving create/import/save/group dialogs and popup never offer a Collection whose Workspace is retained, even when stale UI state still names it.

- [ ] Run `bun test test/workspace-visibility.test.ts` and confirm the orphan-trash and retained-target cases fail.

- [ ] Implement pure visibility helpers and use them from memoized component derivations. Select raw arrays from Zustand, derive with `useMemo`, and keep existing Default-first/position-descending Collection ordering after filtering.

- [ ] Remove the orphan fallback from `TrashContent`. The retained Collection predicate must be exactly its own trash state plus `collection.workspaceId === activeWorkspaceId`; individual Bookmark/Group trash must resolve through the same active parent.

- [ ] Filter Favorites, Archive, dashboard Content, group detail, Groups panel, Tabs drag/drop/save controls, Sidebar counts, local SearchBox results, and newtab SearchPanel results through active Workspace Collections. Content-script search cannot load Zustand, so it relies on the server’s PostgreSQL parent validation from Task 5 and performs no independent ownership inference.

- [ ] Validate the active Workspace again inside every mutation handler, not only while rendering options. If a retained target was selected before a remote pull, abort, refresh selection, and display a localized Alert rather than writing under it.

- [ ] Run `bun test test/workspace-visibility.test.ts`, the existing Bookmark/Group/UI tests, and `bun run compile`.

- [ ] Commit:

```bash
git add lib/workspace-visibility.ts components/dashboard/content.tsx components/dashboard/favorites-content.tsx components/dashboard/archive-content.tsx components/dashboard/trash-content.tsx components/dashboard/search-box.tsx components/search/search-panel.tsx components/dashboard/add-bookmark-dialog.tsx components/dashboard/import-dialog.tsx components/dashboard/tabs-panel/save-collection-dialog.tsx components/dashboard/group-detail/index.tsx components/dashboard/groups-panel/index.tsx components/dashboard/groups-panel/create-group-bar.tsx components/dashboard/groups-panel/droppable-group-card.tsx components/dashboard/tabs-dnd-provider.tsx components/dashboard/tab-row.tsx components/dashboard/tabs-panel/group-card.tsx components/dashboard/sidebar/index.tsx entrypoints/popup/App.tsx test/workspace-visibility.test.ts
git commit -m "fix(workspaces): isolate retained parent content"
```

---

## Phase 4: Migration, acceptance, and rollout verification

### Task 17: Add multi-device, restart, legacy, and retention acceptance coverage

**Files**

- Create: `test/workspace-management-acceptance.test.ts`
- Modify: `ARCHITECTURE.md`
- Create: `../TabSlate-server/internal/handler/workspace_management_acceptance_test.go`
- Modify: `../TabSlate-server/ARCHITECTURE.md`
- Modify: `../TabSlate-server/README.md`

**Interfaces**

```ts
interface AcceptanceDevice {
  engine: SyncEngine;
  deviceId: string;
  persistence: {
    restart(): Promise<void>;
    readRecoverySnapshot(): Promise<SyncPushPayload | null>;
  };
  goOffline(): void;
  goOnline(): Promise<void>;
  readAggregate(workspaceId: string): Promise<{
    workspace?: Workspace;
    collections: Collection[];
    bookmarks: Bookmark[];
    groups: SavedGroup[];
    groupTabs: GroupTab[];
  }>;
}
```

```go
type workspaceAcceptanceFixture struct {
    UserID      string
    WorkspaceID string
    CollectionID string
    BookmarkIDs []string
    GroupID     string
}
```

- [ ] Add a failing frontend acceptance harness with separate injected IndexedDB/session-storage persistence doubles for Device A and Device B. Cover delete → remote pull/switch, restore → unchanged child states, purge → complete local cleanup, restart with pending intent, and cached capability scoped to user/origin.

- [ ] Add a failing server acceptance fixture covering manual purge and retention expiry through the same service, stale restore after state `2`, a device offline longer than retention, search-index delay with PostgreSQL visibility filtering, and versionless delete/restore migration.

- [ ] Run `bun test test/workspace-management-acceptance.test.ts` and `go test ./internal/handler -run 'TestWorkspaceManagementAcceptance'` from their respective repositories; confirm the missing scenario wiring fails first.

- [ ] Implement only the fixture/adapters needed to exercise the production paths. Do not duplicate lifecycle algorithms in test helpers. Assert exact IDs, sequences, child states, queue contents, conflict roots, quota totals, and scrubbed state-2 fields after every transition.

- [ ] Update both architecture documents with the final state table, protocol-version-2 action contract, capability/full-pull migration, IndexedDB v3 indexes/keys, serialized lifecycle order, quota equations, and cleanup ownership. Update the server README API section with soft delete, restore, and permanent-delete routes.

- [ ] Run the focused acceptance tests again, then run the full repository gates:

```bash
# TabSlate
bun test
bun run compile
bun run build

# TabSlate-server
go test ./...
go test -race ./internal/handler -run 'TestWorkspaceLifecycle|TestWorkspaceManagementAcceptance'

# TabSlate-cloud (local replace points at the modified server module)
go test ./...
```

- [ ] Commit backend acceptance coverage and docs in `../TabSlate-server`:

```bash
git add internal/handler/workspace_management_acceptance_test.go ARCHITECTURE.md README.md
git commit -m "test(workspaces): cover lifecycle acceptance flows"
```

- [ ] Commit frontend acceptance coverage and docs:

```bash
git add test/workspace-management-acceptance.test.ts ARCHITECTURE.md
git commit -m "test(workspaces): cover manager lifecycle flows"
```

### Release checkpoint

- [ ] Deploy the compatible server schema and server code first. Confirm `/sync/pull` advertises capability `true` in OSS and Cloud and both return identical Workspace DTOs and `trash_usage`.
- [ ] Verify migration metrics before client rollout: active roots, legacy retained roots, terminal scrubbed roots, orphan Collections, orphan Groups, and retained-vs-plan quota deltas.
- [ ] Roll out the client only after the server checkpoint. Test one upgraded authenticated account, one self-hosted old server, one offline returning device, and one legacy Guest profile before broad release.
- [ ] Monitor structured rejection counts by reason, lifecycle transaction rollback counts, cleanup purge counts, search visibility drops, full-pull migration failures, and quota equation mismatches.
- [ ] Keep legacy restore code until both the supported client-upgrade window and the maximum retained legacy population window have elapsed. State-2 anti-resurrection rows remain until account deletion regardless of that cleanup.

## Definition of Done

- [ ] The Workspace Manager is the only surface for deleted Workspace recovery and permanent deletion.
- [ ] Soft delete changes only the aggregate root and never releases quota.
- [ ] Restore re-exposes exact child IDs and parent-model child lifecycle states.
- [ ] Permanent delete is server-confirmed, atomic, queue-safe, and irreversible.
- [ ] The last active Workspace invariant is enforced locally and transactionally on the server.
- [ ] Normal UI, REST, and search never expose retained-parent content; Sync pull still hydrates it.
- [ ] Guest retained Workspaces never auto-expire and legacy Guest orphans remain recoverable.
- [ ] Versionless clients cannot resurrect retained roots and use the atomic legacy cascade.
- [ ] `usage = in use + trash_usage` for every resource in Guest, OSS, and Cloud modes.
- [ ] Frontend tests/typecheck/build, server full/race tests, and Cloud module tests all pass from clean worktrees.

## Plan Self-Review Checklist

- [ ] Every design invariant has at least one implementation task and one automated assertion.
- [ ] Every new server field has a matching Go JSON field, TypeScript field, migration, and contract test.
- [ ] Every local destructive path prunes live queue and recovery state before aggregate cleanup.
- [ ] No task uses a placeholder, unspecified file, unversioned KV key, or ambiguous lifecycle transition.
- [ ] Server-first rollout and old-server capability behavior are testable before enabling frontend actions.
