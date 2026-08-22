# Guest Workspace Sync Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the automatic guest seed from causing collection upsert failures, preserve meaningful guest data, and make client/server sync self-heal from workspace-quota and invalid-parent rejections.

**Architecture:** The Server validates parent ownership and availability before batching children and returns structured HTTP 200 business rejections. The client records local-only guest provenance, computes reconciliation with pure functions, commits migrations atomically across IndexedDB stores, serializes rejection resolution with pull/sweep, and persists deterministic conflicts. Cloud inherits the Server behavior through its Go module dependency and receives no separate handler.

**Tech Stack:** Go 1.25, PostgreSQL 17+, pgx v5, Gin, TypeScript 5.9 strict mode, React 19, Zustand 5, IndexedDB, WXT 0.20, Chrome i18n, Bun test runner.

**Spec:** docs/superpowers/specs/2026-08-23-guest-workspace-sync-recovery-design.md

## Global Constraints

- At execution time, create isolated worktrees with superpowers:using-git-worktrees. Keep Frontend, Server, and Cloud worktrees as siblings so Cloud can verify the local Server module.
- Use TDD for every behavior change: add a focused failing test, observe the expected failure, implement the minimum behavior, and rerun the focused test.
- Use Bun for frontend dependency management and verification.
- Keep TypeScript strict. Never add any; avoid unknown and assertions; prefer interfaces for object shapes; use curly braces for every if.
- Never call syncEngine.enqueue inside a Zustand set updater.
- Preserve lazy archived/trashed bookmark loading; never replace an unloaded bucket with an in-memory empty array.
- Automatic guest provenance is local-only in IndexedDB kv and never enters a sync payload.
- Keep guest entities at seq 0 until a pull confirms them.
- Discard an untouched guest seed only after an existing server account is confirmed.
- Keep meaningful guest data independent when workspace capacity exists; migrate it into a confirmed server workspace when capacity is unavailable.
- Choose the selected confirmed active server workspace first, then the confirmed active workspace with the lowest position.
- Preserve IDs and lifecycle states. Rewrite only required parent IDs, merged-default bookmark collection IDs, deterministic collection positions, seq, and isDefault.
- Business rejections return HTTP 200. PostgreSQL internals are logged server-side and never returned publicly.
- Nil collection workspace_id and bookmark collection_id remain legal; nil saved-group workspace_id is invalid.
- Do not add a PostgreSQL migration or bump the IndexedDB version.
- Retry from a two-second exponential delay capped at 60 seconds with jitter; after five identical 5xx payload failures, switch to a five-minute probe.
- Preserve the existing 401/403 recovery snapshot behavior.
- Do not change Cloud limits or add Cloud-specific sync logic.
- Preserve the untracked TabSlate-cloud/.DS_Store; never stage or delete it.
- Do not create/push a Server tag, publish, deploy, or push remote commits without explicit release authorization.
- Do not create Markdown files other than this Superpowers plan; updating the existing CLAUDE.md is allowed.

---

## File Map

### TabSlate-server

New files:

- internal/handler/sync_dependencies.go — pure parent classification.
- internal/handler/sync_dependencies_test.go — classifier tests.
- internal/handler/sync_errors.go — SQLSTATE classification, bounded logging, sanitized responses.
- internal/handler/sync_errors_test.go — error response tests.
- internal/handler/sync_test.go — PostgreSQL-backed sync push tests.

Modified files:

- internal/model/model.go — structured Rejected fields.
- internal/handler/sync.go — owned-parent preload, dependency filtering, complete rejection types, diagnostic error routing.
- internal/handler/collections.go — keep direct-create collection quota on active collections.
- internal/handler/billing.go — report active collection usage for capacity recovery.

### TabSlate frontend

New files:

- lib/guest-workspace.ts — provenance, seed construction, classification, target selection, and pure migration planning.
- lib/sync-conflicts.ts — IndexedDB-backed deterministic conflict registry.
- lib/guest-workspace-reconciliation.ts — snapshot loading, atomic commit, store apply, pull/push/legacy resolution.
- components/ui/sync-recovery-alert.tsx — localized migration notification.
- test/guest-workspace.test.js — pure guest policy tests.
- test/sync-conflicts.test.js — conflict persistence/filtering tests.
- test/guest-workspace-reconciliation.test.js — transaction and rollback tests.
- test/sync-engine-ordering.test.js — callback and pull ordering tests.
- test/sync-recovery-i18n.test.js — locale key tests.

Modified files:

- lib/api.ts — typed sync entities and structured rejection transport.
- lib/sync-recovery.ts — remove broad object assertions.
- lib/sync-queue.ts — async rejection resolution, stale-chunk stop, retry classification and probe.
- lib/sync-engine.ts — serialized async callbacks and legacy resolution.
- store/workspace-store.ts — atomic guest initializer, async merge/sweep, reconciliation apply.
- store/bookmarks-store.ts — async conflict-aware sweep and lazy-safe apply.
- store/groups-store.ts — async merge/sweep and reconciliation apply.
- store/plan-store.ts — return authoritative plan data.
- entrypoints/newtab/App.tsx — ordered login/push recovery and notification.
- test/plan-store.test.ts — authoritative plan fetch return/concurrency coverage.
- public/_locales/en/messages.json and public/_locales/zh_CN/messages.json — recovery copy.
- existing focused tests — adapt mocks/signatures and add regressions.
- CLAUDE.md — document new kv keys and sync lifecycle.

### TabSlate-cloud

Modified only after authorized Server release:

- go.mod and go.sum — require Server v0.1.1 and remove the temporary replace.
- .github/workflows/ci.yml — remove sibling Server checkout after replace removal.
- CLAUDE.md — record the released dependency floor and local multi-repository workflow.

---

### Task 1: Define the Server Rejection Contract and Parent Classifier

**Files:**

- Create: /Users/lieutenant/Documents/github/TabSlate-server/internal/handler/sync_dependencies.go
- Create: /Users/lieutenant/Documents/github/TabSlate-server/internal/handler/sync_dependencies_test.go
- Modify: /Users/lieutenant/Documents/github/TabSlate-server/internal/model/model.go:226-231

**Interfaces:**

- Produces model.Rejected with ID, Reason, Type, ParentID, ParentType.
- Produces entityIDSet.Add/Has.
- Produces classifyParent(entityID, entityType string, parentID *string, parentType string, allowNil bool, owned, accepted, unavailable entityIDSet) *model.Rejected.
- Task 2 calls the classifier before batching collections, bookmarks, or groups.

- [ ] **Step 1: Write the failing classifier test**

Create sync_dependencies_test.go:

~~~go
package handler

import "testing"

func testStringPointer(value string) *string {
	return &value
}

func TestClassifyParent(t *testing.T) {
	tests := []struct {
		name        string
		parentID    *string
		allowNil    bool
		owned       entityIDSet
		accepted    entityIDSet
		unavailable entityIDSet
		wantReason  string
	}{
		{name: "owned", parentID: testStringPointer("owned"), owned: entityIDSet{"owned": {}}, wantReason: ""},
		{name: "accepted", parentID: testStringPointer("accepted"), accepted: entityIDSet{"accepted": {}}, wantReason: ""},
		{name: "rejected", parentID: testStringPointer("rejected"), unavailable: entityIDSet{"rejected": {}}, wantReason: "parent_rejected"},
		{name: "missing", parentID: testStringPointer("missing"), wantReason: "invalid_parent"},
		{name: "allowed nil", parentID: nil, allowNil: true, wantReason: ""},
		{name: "required nil", parentID: nil, allowNil: false, wantReason: "invalid_parent"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			rejection := classifyParent(
				"child-1", "collection", test.parentID, "workspace", test.allowNil,
				test.owned, test.accepted, test.unavailable,
			)
			if test.wantReason == "" {
				if rejection != nil {
					t.Fatalf("expected accepted parent, got %#v", rejection)
				}
				return
			}
			if rejection == nil || rejection.Reason != test.wantReason {
				t.Fatalf("rejection = %#v, want %q", rejection, test.wantReason)
			}
			if rejection.ID != "child-1" || rejection.Type != "collection" || rejection.ParentType != "workspace" {
				t.Fatalf("unexpected context: %#v", rejection)
			}
		})
	}
}
~~~

- [ ] **Step 2: Run the test and verify it fails**

Run:

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go test ./internal/handler -run TestClassifyParent -count=1
~~~

Expected: FAIL because entityIDSet, classifyParent, and parent fields do not exist.

- [ ] **Step 3: Extend model.Rejected**

Replace the struct with:

~~~go
type Rejected struct {
	ID         string `json:"id"`
	Reason     string `json:"reason"`
	Type       string `json:"type"`
	ParentID   string `json:"parent_id,omitempty"`
	ParentType string `json:"parent_type,omitempty"`
}
~~~

New Server responses always set Type, including stale. The frontend remains tolerant of old responses that omit it.

- [ ] **Step 4: Implement the classifier**

Create sync_dependencies.go:

~~~go
package handler

import "github.com/TabSlate-dev/TabSlate-server/internal/model"

type entityIDSet map[string]struct{}

func (set entityIDSet) Add(id string) {
	set[id] = struct{}{}
}

func (set entityIDSet) Has(id string) bool {
	_, exists := set[id]
	return exists
}

func classifyParent(
	entityID string,
	entityType string,
	parentID *string,
	parentType string,
	allowNil bool,
	owned entityIDSet,
	accepted entityIDSet,
	unavailable entityIDSet,
) *model.Rejected {
	if parentID == nil {
		if allowNil {
			return nil
		}
		return &model.Rejected{
			ID: entityID, Reason: "invalid_parent", Type: entityType, ParentType: parentType,
		}
	}
	if unavailable.Has(*parentID) {
		return &model.Rejected{
			ID: entityID, Reason: "parent_rejected", Type: entityType,
			ParentID: *parentID, ParentType: parentType,
		}
	}
	if owned.Has(*parentID) || accepted.Has(*parentID) {
		return nil
	}
	return &model.Rejected{
		ID: entityID, Reason: "invalid_parent", Type: entityType,
		ParentID: *parentID, ParentType: parentType,
	}
}
~~~

- [ ] **Step 5: Format, test, and commit**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-server
gofmt -w internal/model/model.go internal/handler/sync_dependencies.go internal/handler/sync_dependencies_test.go
go test ./internal/handler -run TestClassifyParent -count=1
git add internal/model/model.go internal/handler/sync_dependencies.go internal/handler/sync_dependencies_test.go
git commit -m "feat(sync): define dependency rejection contract"
~~~

Expected: test PASS and one focused commit.

---

### Task 2: Reject Invalid Dependency Chains Before PostgreSQL Batches

**Files:**

- Create: /Users/lieutenant/Documents/github/TabSlate-server/internal/handler/sync_test.go
- Modify: /Users/lieutenant/Documents/github/TabSlate-server/internal/handler/sync.go:55-420
- Modify: /Users/lieutenant/Documents/github/TabSlate-server/internal/handler/collections.go
- Modify: /Users/lieutenant/Documents/github/TabSlate-server/internal/handler/billing.go

**Interfaces:**

- Consumes classifyParent and entityIDSet.
- Produces dependency-aware POST /sync/push behavior.
- Produces owned/accepted/unavailable workspace and collection sets.

- [ ] **Step 1: Add the integration-test provider and HTTP helper**

Create sync_test.go with a complete billing.Provider:

~~~go
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TabSlate-dev/TabSlate-server/billing"
	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/middleware"
	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/gin-gonic/gin"
)

type fixedLimitsProvider struct {
	limits billing.Limits
}

func (provider fixedLimitsProvider) OnUserCreated(context.Context, billing.UserInfo) error { return nil }
func (provider fixedLimitsProvider) GetLimits(context.Context, string) (*billing.Limits, error) {
	limits := provider.limits
	return &limits, nil
}
func (provider fixedLimitsProvider) GetSubscription(context.Context, string) (*billing.Subscription, error) {
	return &billing.Subscription{Plan: billing.PlanFree, Status: "active"}, nil
}
func (provider fixedLimitsProvider) ChangePlan(context.Context, string, string) error { return nil }
func (provider fixedLimitsProvider) CancelSubscription(context.Context, string) error { return nil }
func (provider fixedLimitsProvider) ListInvoices(context.Context, string, int, int) ([]billing.Invoice, error) {
	return []billing.Invoice{}, nil
}

func pushSync(
	t *testing.T,
	testDB *db.DB,
	userID string,
	limits billing.Limits,
	entities model.SyncEntities,
) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(model.SyncPushRequest{Entities: entities})
	if err != nil {
		t.Fatalf("marshal sync request: %v", err)
	}
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	ginContext.Request = httptest.NewRequest(http.MethodPost, "/sync/push", bytes.NewReader(body))
	ginContext.Request.Header.Set("Content-Type", "application/json")
	ginContext.Set(middleware.UserIDKey, userID)
	handler := NewSyncHandler(testDB, nil, pubsub.NewInMemoryHub(), fixedLimitsProvider{limits: limits})
	handler.Push(ginContext)
	return recorder
}

func decodeSyncPushResponse(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) model.SyncPushResponse {
	t.Helper()
	var response model.SyncPushResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode sync response: %v body=%s", err, recorder.Body.String())
	}
	return response
}
~~~

- [ ] **Step 2: Write the failing original-regression test**

Add TestSyncPushRejectsChildrenOfQuotaRejectedWorkspace. Insert one existing workspace, push a second workspace plus its default collection and saved group with MaxWorkspaces 1, and assert:

~~~go
if recorder.Code != http.StatusOK {
	t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
}
response := decodeSyncPushResponse(t, recorder)
want := map[string]string{
	"guest-ws":      "quota_exceeded",
	"guest-default": "parent_rejected",
	"guest-group":   "parent_rejected",
}
for _, rejection := range response.Rejected {
	if want[rejection.ID] != rejection.Reason {
		t.Fatalf("unexpected rejection: %#v", rejection)
	}
	delete(want, rejection.ID)
}
if len(want) != 0 {
	t.Fatalf("missing rejections: %#v", want)
}
~~~

Query collections and groups afterward and assert both guest child counts are zero.

Use a `syncTestLimits` helper that sets every unrelated resource limit to -1, then override only the limit under test. This prevents Go zero values from accidentally turning unrelated resources into zero-capacity plans.

- [ ] **Step 3: Run the integration test and verify the current 500**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-server
TEST_DATABASE_URL="$TEST_DATABASE_URL" go test ./internal/handler -run TestSyncPushRejectsChildrenOfQuotaRejectedWorkspace -count=1 -v
~~~

Expected: FAIL with HTTP 500 and collection upsert failed. Configure TEST_DATABASE_URL before continuing; a skipped test is not evidence.

- [ ] **Step 4: Preload owned parent IDs separately from active quota IDs**

Before quota filtering, query all IDs owned by the authenticated user:

~~~go
ownedWorkspaceIDs := entityIDSet{}
if len(req.Entities.Collections) > 0 || len(req.Entities.Groups) > 0 {
	rows, queryErr := tx.Query(ctx, `SELECT id FROM workspaces WHERE user_id = $1`, userID)
	if queryErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "workspace parent check failed"})
		return
	}
	for rows.Next() {
		var id string
		if scanErr := rows.Scan(&id); scanErr != nil {
			rows.Close()
			c.JSON(http.StatusInternalServerError, gin.H{"error": "workspace parent check failed"})
			return
		}
		ownedWorkspaceIDs.Add(id)
	}
	rows.Close()
	if rowsErr := rows.Err(); rowsErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "workspace parent check failed"})
		return
	}
}
~~~

Repeat with SELECT id FROM collections WHERE user_id = $1 when bookmarks exist. Parent ownership includes every non-physically-deleted lifecycle state, independently from active quota membership. Initialize:

~~~go
acceptedWorkspaceIDs := entityIDSet{}
unavailableWorkspaceIDs := entityIDSet{}
acceptedCollectionIDs := entityIDSet{}
unavailableCollectionIDs := entityIDSet{}
~~~

Use the same fixed generic response for the collection-parent preload during this task. Task 3 replaces both temporary parent-check responses with logged, sanitized shared handling.

- [ ] **Step 5: Track workspace availability**

On workspace quota rejection:

~~~go
rejected = append(rejected, model.Rejected{
	ID: ws.ID, Reason: "quota_exceeded", Type: "workspace",
})
unavailableWorkspaceIDs.Add(ws.ID)
continue
~~~

After each workspace Exec:

~~~go
if commandTag.RowsAffected() == 0 {
	rejected = append(rejected, model.Rejected{ID: ws.ID, Reason: "stale", Type: "workspace"})
	if !ownedWorkspaceIDs.Has(ws.ID) {
		unavailableWorkspaceIDs.Add(ws.ID)
	}
	continue
}
acceptedWorkspaceIDs.Add(ws.ID)
ownedWorkspaceIDs.Add(ws.ID)
~~~

An owned stale workspace stays a valid parent; a conflicting ID owned by another user does not.

- [ ] **Step 6: Filter collections before quota counting**

At the top of the collection loop:

~~~go
if dependency := classifyParent(
	col.ID, "collection", col.WorkspaceID, "workspace", true,
	ownedWorkspaceIDs, acceptedWorkspaceIDs, unavailableWorkspaceIDs,
); dependency != nil {
	rejected = append(rejected, *dependency)
	unavailableCollectionIDs.Add(col.ID)
	continue
}
~~~

On collection quota rejection, add its ID to unavailableCollectionIDs. On successful Exec, add its ID to acceptedCollectionIDs and ownedCollectionIDs. On stale Exec, set Type collection and mark unavailable only if it was not already owned.

Keep quota membership consistent with the repository invariant: the sync baseline query, direct collection-create quota query, and billing usage query all count only `deleted_at IS NULL AND archived_at IS NULL`. An incoming collection consumes a new slot only when both timestamps are nil. Add an integration assertion that archived and trashed collections do not consume active collection capacity, while restoring one does.

- [ ] **Step 7: Filter bookmarks and groups before batching**

Build bookmarkUpserts:

~~~go
var bookmarkUpserts []model.Bookmark
for _, bookmark := range req.Entities.Bookmarks {
	if dependency := classifyParent(
		bookmark.ID, "bookmark", bookmark.CollectionID, "collection", true,
		ownedCollectionIDs, acceptedCollectionIDs, unavailableCollectionIDs,
	); dependency != nil {
		rejected = append(rejected, *dependency)
		continue
	}
	bookmarkUpserts = append(bookmarkUpserts, bookmark)
}
~~~

Queue and read results from bookmarkUpserts, not the original request slice. Nil collection remains legal.

At the top of the group loop call classifyParent with entity type saved_group, parent type workspace, and allowNil false. A rejected group never enters the group or group-tabs batch.

Set Type on every remaining stale append in the handler: bookmark, tag, and saved_group, in addition to workspace and collection. Stale rejections have empty parent fields.

- [ ] **Step 8: Add the remaining dependency tests**

Add explicit database-backed tests for:

~~~text
bookmark-only + another user's collection => bookmark/invalid_parent
collection quota rejection + child bookmark => collection/quota_exceeded then bookmark/parent_rejected
new accepted workspace + child collection => both inserted, no rejection
stale existing owned workspace + new child => workspace/stale, child inserted
nil bookmark collection => accepted uncategorized bookmark
nil saved-group workspace => saved_group/invalid_parent
~~~

Each test asserts both response fields and database rows.

- [ ] **Step 9: Run, format, and commit**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-server
gofmt -w internal/handler/sync.go internal/handler/sync_test.go internal/handler/collections.go internal/handler/billing.go
TEST_DATABASE_URL="$TEST_DATABASE_URL" go test ./internal/handler -run TestSyncPush -count=1 -v
git add internal/handler/sync.go internal/handler/sync_test.go internal/handler/collections.go internal/handler/billing.go
git commit -m "fix(sync): reject children of unavailable parents"
~~~

Expected: all sync integration tests PASS; the original request returns HTTP 200 and inserts no orphan.

---

### Task 3: Add Sanitized Server Diagnostics and Transient SQLSTATE Handling

**Files:**

- Create: /Users/lieutenant/Documents/github/TabSlate-server/internal/handler/sync_errors.go
- Create: /Users/lieutenant/Documents/github/TabSlate-server/internal/handler/sync_errors_test.go
- Modify: /Users/lieutenant/Documents/github/TabSlate-server/internal/handler/sync.go

**Interfaces:**

- Produces syncDatabaseHTTPStatus(error) and respondSyncDatabaseError(context, operation, userID, entityIDs, error).
- Consumes every database error in SyncHandler.Push.

- [ ] **Step 1: Write failing SQLSTATE tests**

~~~go
func TestSyncDatabaseHTTPStatus(t *testing.T) {
	tests := []struct {
		err  error
		want int
	}{
		{err: &pgconn.PgError{Code: "40001"}, want: http.StatusServiceUnavailable},
		{err: &pgconn.PgError{Code: "40P01"}, want: http.StatusServiceUnavailable},
		{err: &pgconn.PgError{Code: "23503"}, want: http.StatusInternalServerError},
		{err: errors.New("database unavailable"), want: http.StatusInternalServerError},
	}
	for _, test := range tests {
		if got := syncDatabaseHTTPStatus(test.err); got != test.want {
			t.Fatalf("status = %d, want %d", got, test.want)
		}
	}
}
~~~

Also invoke the responder with a foreign-key PgError and assert body equals {"error":"sync failed"} and excludes its constraint/message.

- [ ] **Step 2: Run and verify missing functions**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go test ./internal/handler -run TestSyncDatabase -count=1
~~~

Expected: FAIL because the helpers do not exist.

- [ ] **Step 3: Implement error classification and bounded logging**

Create sync_errors.go:

~~~go
package handler

import (
	"errors"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
)

const maxLoggedSyncEntityIDs = 10

func syncPostgresError(err error) *pgconn.PgError {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError
	}
	return nil
}

func syncDatabaseHTTPStatus(err error) int {
	postgresError := syncPostgresError(err)
	if postgresError != nil && (postgresError.Code == "40001" || postgresError.Code == "40P01") {
		return http.StatusServiceUnavailable
	}
	return http.StatusInternalServerError
}

func boundedSyncEntityIDs(ids []string) []string {
	if len(ids) <= maxLoggedSyncEntityIDs {
		return ids
	}
	return ids[:maxLoggedSyncEntityIDs]
}

func respondSyncDatabaseError(
	ginContext *gin.Context,
	operation string,
	userID string,
	entityIDs []string,
	err error,
) {
	status := syncDatabaseHTTPStatus(err)
	postgresError := syncPostgresError(err)
	if postgresError == nil {
		log.Printf("sync push operation=%q user_id=%q entity_ids=%q error=%v",
			operation, userID, boundedSyncEntityIDs(entityIDs), err)
	} else {
		log.Printf(
			"sync push operation=%q user_id=%q entity_ids=%q sqlstate=%q table=%q constraint=%q error=%v",
			operation, userID, boundedSyncEntityIDs(entityIDs), postgresError.Code,
			postgresError.TableName, postgresError.ConstraintName, err,
		)
	}
	message := "sync failed"
	if status == http.StatusServiceUnavailable {
		message = "sync temporarily unavailable"
	}
	ginContext.JSON(status, gin.H{"error": message})
}
~~~

- [ ] **Step 4: Route Push database failures through the responder**

Collect bounded IDs for each entity batch and replace fixed upsert failure responses. Also handle BatchResults.Close errors:

~~~go
if closeErr := batchResults.Close(); closeErr != nil {
	respondSyncDatabaseError(c, "close collection batch", userID, collectionIDs, closeErr)
	return
}
~~~

Use stable operation names for transaction begin/increment/commit, quota/parent queries, workspace/collection/bookmark/tag/group upserts, collection cascade, and group-tab replacement. Keep billing provider failures as quota check failed, but log their error.

- [ ] **Step 5: Verify Server and commit**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-server
gofmt -w internal/handler/sync.go internal/handler/sync_errors.go internal/handler/sync_errors_test.go
TEST_DATABASE_URL="$TEST_DATABASE_URL" go test ./internal/handler -run 'TestSyncDatabase|TestSyncPush' -count=1
TEST_DATABASE_URL="$TEST_DATABASE_URL" go test ./...
go vet ./...
go build ./...
git add internal/handler/sync.go internal/handler/sync_errors.go internal/handler/sync_errors_test.go
git commit -m "fix(sync): classify and log database failures"
~~~

Expected: all commands exit 0; public bodies never include SQLSTATE, table, constraint, or raw PostgreSQL messages.

---

### Task 4: Add Typed Sync Entities and Atomic Guest Seed Provenance

**Files:**

- Create: /Users/lieutenant/Documents/github/TabSlate/lib/guest-workspace.ts
- Create: /Users/lieutenant/Documents/github/TabSlate/test/guest-workspace.test.js
- Modify: lib/api.ts, lib/sync-recovery.ts, lib/sync-queue.ts, lib/sync-engine.ts
- Modify: store/workspace-store.ts, store/bookmarks-store.ts, store/groups-store.ts, entrypoints/newtab/App.tsx
- Modify: test/workspace-store.test.js and test/auth-session.test.js

**Interfaces:**

- Produces SyncEntity, SyncEntityType, KnownSyncRejectionReason, and structured SyncRejected.
- Produces GUEST_WORKSPACE_PROVENANCE_KEY and GuestWorkspaceProvenance.
- Produces createGuestWorkspaceSeed(workspaceId, collectionId, position).
- Produces workspaceStore.initializeGuestWorkspace(): Promise<void>.

- [ ] **Step 1: Write failing seed tests**

Create test/guest-workspace.test.js:

~~~js
import { describe, expect, test } from "bun:test";
import {
  GUEST_WORKSPACE_PROVENANCE_KEY,
  createGuestWorkspaceSeed,
} from "../lib/guest-workspace";

describe("guest workspace seed", () => {
  test("builds workspace, default collection, and provenance", () => {
    const seed = createGuestWorkspaceSeed("guest-ws", "guest-default", 0);
    expect(seed.workspace).toEqual({
      id: "guest-ws", name: "My Workspace", color: "blue", position: 0, seq: 0,
    });
    expect(seed.collection).toEqual({
      id: "guest-default", workspaceId: "guest-ws", name: "Default",
      icon: "inbox", position: 0, isDefault: true, seq: 0,
    });
    expect(seed.provenance.key).toBe(GUEST_WORKSPACE_PROVENANCE_KEY);
    expect(seed.provenance.value.state).toBe("pending-server-confirmation");
  });
});
~~~

Extend workspace-store.test.js: generate two IDs, defer idbBulkWrite, call initializeGuestWorkspace twice concurrently, assert exactly one transaction with workspace, collection, activeWorkspaceId, and provenance puts, and assert no state update before resolution.

- [ ] **Step 2: Run and verify missing exports/actions**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/guest-workspace.test.js test/workspace-store.test.js test/auth-session.test.js
~~~

Expected: FAIL because the new module and action do not exist.

- [ ] **Step 3: Type sync payload IDs and rejection transport**

In lib/api.ts add:

~~~ts
export interface SyncEntity {
  id: string;
}

export type SyncEntityType =
  | "workspace"
  | "collection"
  | "bookmark"
  | "saved_group"
  | "tag";

export type KnownSyncRejectionReason =
  | "stale"
  | "quota_exceeded"
  | "parent_rejected"
  | "invalid_parent";

export interface SyncRejected {
  id: string;
  reason: string;
  type?: string;
  parent_id?: string;
  parent_type?: string;
}

export interface SyncPushEntities {
  workspaces: SyncEntity[];
  collections: SyncEntity[];
  bookmarks: SyncEntity[];
  tags: SyncEntity[];
  groups: SyncEntity[];
}

export interface SyncPushPayload {
  entities: SyncPushEntities;
}

export function isSyncEntityType(value: string | undefined): value is SyncEntityType {
  return value === "workspace" ||
    value === "collection" ||
    value === "bookmark" ||
    value === "saved_group" ||
    value === "tag";
}
~~~

Keep reason as string because JSON can contain future values. Add isKnownSyncRejectionReason for the four known strings. Change sync-recovery merge arrays to SyncEntity[] and use entity.id directly.

Change only the return annotation of every existing frontend serializer; keep each current object-literal body:

~~~diff
-function toServerCollection(c: Collection, opts?: { isDeleted?: number }): object {
+function toServerCollection(c: Collection, opts?: { isDeleted?: number }): SyncEntity {
-function toServerWorkspace(w: Workspace): object {
+function toServerWorkspace(w: Workspace): SyncEntity {
-function toServerTag(t: Tag): object {
+function toServerTag(t: Tag): SyncEntity {
-function toServerBookmark(b: Bookmark, opts: { isArchived?: boolean; isTrashed?: number } = {}): object {
+function toServerBookmark(b: Bookmark, opts: { isArchived?: boolean; isTrashed?: number } = {}): SyncEntity {
-function toServerGroup(g: SavedGroup, tabs: GroupTab[], opts?: { isDeleted?: number }): object {
+function toServerGroup(g: SavedGroup, tabs: GroupTab[], opts?: { isDeleted?: number }): SyncEntity {
~~~

Also change SyncEngine.forcePush to accept Partial<SyncPushEntities>, SyncEngine.enqueue to accept Partial<SyncPushEntities>, SyncQueue.enqueue to accept Partial<SyncPushEntities>, and every QueuedEntities map to Map<string, SyncEntity>. Change requeueSnapshot's merge helper to (map: Map<string, SyncEntity>, entities: SyncEntity[]) and read entity.id directly. This is required before replacing assertion-based queue/recovery merging.

- [ ] **Step 4: Implement the guest seed model**

Create lib/guest-workspace.ts:

~~~ts
import type { Bookmark, Collection, Workspace } from "@/lib/types";
import type { GroupTab, SavedGroup } from "@/store/groups-store";

export const GUEST_WORKSPACE_PROVENANCE_KEY = "guest-workspace-provenance-v1";

export interface GuestWorkspaceFingerprint {
  workspaceName: string;
  workspaceColor: string;
  workspacePosition: number;
  collectionName: string;
  collectionIcon: string;
  collectionPosition: number;
}

export interface GuestWorkspaceProvenanceValue {
  version: 1;
  state: "pending-server-confirmation";
  workspaceId: string;
  defaultCollectionId: string;
  fingerprint: GuestWorkspaceFingerprint;
}

export interface GuestWorkspaceProvenanceRecord {
  key: typeof GUEST_WORKSPACE_PROVENANCE_KEY;
  value: GuestWorkspaceProvenanceValue;
}

export interface GuestWorkspaceSeed {
  workspace: Workspace;
  collection: Collection;
  provenance: GuestWorkspaceProvenanceRecord;
}

export interface GuestWorkspaceSnapshot {
  provenance: GuestWorkspaceProvenanceValue;
  workspace?: Workspace;
  collections: Collection[];
  activeBookmarks: Bookmark[];
  archivedBookmarks: Bookmark[];
  trashedBookmarks: Bookmark[];
  groups: SavedGroup[];
  groupTabs: GroupTab[];
}

export function createGuestWorkspaceSeed(
  workspaceId: string,
  collectionId: string,
  position: number,
): GuestWorkspaceSeed {
  const workspace: Workspace = {
    id: workspaceId, name: "My Workspace", color: "blue", position, seq: 0,
  };
  const collection: Collection = {
    id: collectionId, workspaceId, name: "Default", icon: "inbox",
    position: 0, isDefault: true, seq: 0,
  };
  return {
    workspace,
    collection,
    provenance: {
      key: GUEST_WORKSPACE_PROVENANCE_KEY,
      value: {
        version: 1,
        state: "pending-server-confirmation",
        workspaceId,
        defaultCollectionId: collectionId,
        fingerprint: {
          workspaceName: workspace.name,
          workspaceColor: workspace.color,
          workspacePosition: workspace.position,
          collectionName: collection.name,
          collectionIcon: collection.icon,
          collectionPosition: collection.position,
        },
      },
    },
  };
}
~~~

- [ ] **Step 5: Add the atomic idempotent initializer**

Add initializeGuestWorkspace(): Promise<void> to WorkspaceState and one module-level promise. Recheck get().workspaces inside that promise, create two IDs, await one idbBulkWrite with four puts, then set memory and enqueue. Do not increment plan usage or workspace_created analytics for an automatic seed.

Core transaction:

~~~ts
await idbBulkWrite([
  { type: "put", store: "workspaces", value: seed.workspace },
  { type: "put", store: "collections", value: seed.collection },
  { type: "put", store: "kv", value: { key: "activeWorkspaceId", value: seed.workspace.id } },
  { type: "put", store: "kv", value: seed.provenance },
]);
set({
  workspaces: [seed.workspace],
  collections: [seed.collection],
  activeWorkspaceId: seed.workspace.id,
});
~~~

Clear the module promise in finally.

- [ ] **Step 6: Use the initializer in both automatic paths**

StoreGate selects initializeGuestWorkspace and invokes it with void. The empty-server pull branch awaits initializeGuestWorkspace. Keep createWorkspace unchanged for explicit user actions.

- [ ] **Step 7: Test, compile, and commit**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/guest-workspace.test.js test/workspace-store.test.js test/auth-session.test.js
bun run compile
git add lib/api.ts lib/sync-recovery.ts lib/sync-queue.ts lib/sync-engine.ts lib/guest-workspace.ts store/workspace-store.ts store/bookmarks-store.ts store/groups-store.ts entrypoints/newtab/App.tsx test/guest-workspace.test.js test/workspace-store.test.js test/auth-session.test.js
git commit -m "feat(sync): record automatic guest workspace provenance"
~~~

Expected: tests and strict compilation PASS.

---

### Task 5: Implement Pure Guest Classification and Migration Planning

**Files:**

- Modify: lib/guest-workspace.ts
- Modify: test/guest-workspace.test.js

**Interfaces:**

- Produces isUntouchedGuestWorkspace(snapshot).
- Produces selectGuestMigrationTarget(workspaces, collections, activeWorkspaceId).
- Produces planGuestWorkspaceMigration(snapshot, target).
- Produces discard, migrate, and conflict discriminated plan interfaces.

- [ ] **Step 1: Write failing classification tests**

Build complete fixtures and assert:

~~~js
expect(isUntouchedGuestWorkspace(makeSnapshot())).toBe(true);
expect(isUntouchedGuestWorkspace(makeSnapshot({ workspaceName: "Renamed" }))).toBe(false);
expect(isUntouchedGuestWorkspace(makeSnapshot({ collectionName: "Inbox" }))).toBe(false);
expect(isUntouchedGuestWorkspace(makeSnapshot({ extraCollection: true }))).toBe(false);
expect(isUntouchedGuestWorkspace(makeSnapshot({ activeBookmark: true }))).toBe(false);
expect(isUntouchedGuestWorkspace(makeSnapshot({ archivedBookmark: true }))).toBe(false);
expect(isUntouchedGuestWorkspace(makeSnapshot({ trashedBookmark: true }))).toBe(false);
expect(isUntouchedGuestWorkspace(makeSnapshot({ activeGroup: true }))).toBe(false);
expect(isUntouchedGuestWorkspace(makeSnapshot({ trashedGroup: true }))).toBe(false);
~~~

- [ ] **Step 2: Write failing target and migration tests**

Assert selected confirmed target wins; otherwise lowest position wins. Assert an untouched default is deleted and active/archived/trashed bookmarks are rewritten to the target default. Assert a renamed default and ordinary collections remain, become non-default, and receive consecutive positions after the target maximum. Assert groups keep IDs and only workspaceId/seq change.

- [ ] **Step 3: Run and verify missing functions**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/guest-workspace.test.js
~~~

Expected: FAIL for missing exports.

- [ ] **Step 4: Add explicit plan interfaces**

~~~ts
export interface GuestMigrationTarget {
  workspace: Workspace;
  defaultCollection: Collection;
}

export interface GuestBookmarkUpdates {
  active: Bookmark[];
  archived: Bookmark[];
  trashed: Bookmark[];
}

export interface GuestWorkspaceDiscardPlan {
  kind: "discard";
  workspaceDeletes: string[];
  collectionDeletes: string[];
  activeWorkspaceId: "";
}

export interface GuestWorkspaceMigrationPlan {
  kind: "migrate";
  targetWorkspaceId: string;
  targetWorkspaceName: string;
  workspaceDeletes: string[];
  collectionPuts: Collection[];
  collectionDeletes: string[];
  bookmarkPuts: GuestBookmarkUpdates;
  groupPuts: SavedGroup[];
  activeWorkspaceId: string;
}

export interface GuestWorkspaceConflictPlan {
  kind: "conflict";
  sourceWorkspaceId: string;
  reason: "no_valid_target";
}

export type GuestWorkspacePlan =
  | GuestWorkspaceDiscardPlan
  | GuestWorkspaceMigrationPlan
  | GuestWorkspaceConflictPlan;
~~~

- [ ] **Step 5: Implement untouched classification**

Compare the workspace and sole source collection against the stored fingerprint. Build the source collection ID set and require no bookmark in any bucket and no group in either lifecycle state.

The marked workspace and default collection must also still be active with seq 0; the collection must still be default. A changed seq, deleted/archived timestamp, or changed isDefault flag makes the seed meaningful.

~~~ts
const sourceCollectionIds = new Set(sourceCollections.map((collection) => collection.id));
const hasBookmark = [...activeBookmarks, ...archivedBookmarks, ...trashedBookmarks]
  .some((bookmark) => sourceCollectionIds.has(bookmark.collectionId));
const hasGroup = groups.some((group) => group.workspaceId === workspace.id);
return !hasBookmark && !hasGroup;
~~~

A missing marked workspace/default is not untouched.

- [ ] **Step 6: Implement stable target selection**

~~~ts
const confirmed = workspaces
  .filter((workspace) => workspace.seq > 0 && !workspace.deletedAt)
  .sort((left, right) => left.position - right.position);
const selected = confirmed.find((workspace) => workspace.id === activeWorkspaceId) ?? confirmed[0];
if (!selected) {
  return null;
}
const defaultCollection = collections.find((collection) =>
  collection.workspaceId === selected.id &&
  collection.seq > 0 &&
  collection.isDefault === true &&
  !collection.deletedAt &&
  !collection.archivedAt,
);
return defaultCollection ? { workspace: selected, defaultCollection } : null;
~~~

- [ ] **Step 7: Implement deterministic migration planning**

Determine mergeDefault from the stored default fingerprint plus its original active/default lifecycle state and seq 0. Assign retained source collections target workspaceId, isDefault false, seq 0, and positions max target position + 1 in stable source position/ID order. Rewrite all three bookmark buckets only when merging the untouched default:

~~~ts
const rewriteBucket = (bookmarks: Bookmark[]): Bookmark[] => {
  if (!mergeDefault || !sourceDefault) {
    return [];
  }
  return bookmarks
    .filter((bookmark) => bookmark.collectionId === sourceDefault.id)
    .map((bookmark) => ({
      ...bookmark,
      collectionId: target.defaultCollection.id,
      seq: 0,
    }));
};
~~~

Rewrite source groups with preserved IDs/content and target workspaceId/seq 0. Delete the source workspace and only delete source default when mergeDefault is true. An untouched discard plan sets activeWorkspaceId to the empty-string literal so the coordinator removes the stale selection before remote merge. Return conflict when source or target is absent.

- [ ] **Step 8: Test, compile, and commit**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/guest-workspace.test.js
bun run compile
git add lib/guest-workspace.ts test/guest-workspace.test.js
git commit -m "feat(sync): plan guest workspace reconciliation"
~~~

Expected: all planner cases PASS.

---

### Task 6: Persist Deterministic Conflicts and Filter Sweeps

**Files:**

- Create: lib/sync-conflicts.ts
- Create: test/sync-conflicts.test.js
- Modify: store/workspace-store.ts, store/bookmarks-store.ts, store/groups-store.ts, lib/sync-engine.ts, entrypoints/newtab/App.tsx

**Interfaces:**

- Produces SyncConflictRegistry ready/list/isBlocked/recordRejections/recordPayload/clearEntity/clearEntities/clearRoot/prepareClearRootMutation/applyMutation/clearAllForManualRetry/filterPayload/reset.
- Changes every sweepUnsynced signature to Promise<void>.
- Task 7 records unresolved reconciliation; Task 8 records permanent HTTP payload failures.

- [ ] **Step 1: Write failing persistence/filter tests**

Mock idbGet/idbPut/idbDelete, record a workspace quota root, its collection child, and a bookmark grandchild. Assert all are blocked, all are filtered, clearRoot removes the complete transitive chain, and a new registry instance rehydrates them from the persisted record.

~~~js
await registry.recordRejections([
  { id: "guest-ws", type: "workspace", reason: "quota_exceeded" },
  {
    id: "guest-col", type: "collection", reason: "parent_rejected",
    parent_id: "guest-ws", parent_type: "workspace",
  },
  {
    id: "guest-bookmark", type: "bookmark", reason: "parent_rejected",
    parent_id: "guest-col", parent_type: "collection",
  },
]);
expect(registry.isBlocked("workspace", "guest-ws")).toBe(true);
expect(registry.filterPayload(payload).entities.collections).toEqual([]);
await registry.clearRoot("workspace", "guest-ws");
expect(registry.isBlocked("collection", "guest-col")).toBe(false);
expect(registry.isBlocked("bookmark", "guest-bookmark")).toBe(false);
~~~

- [ ] **Step 2: Run and verify missing module**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/sync-conflicts.test.js
~~~

Expected: FAIL because sync-conflicts.ts does not exist.

- [ ] **Step 3: Implement the versioned registry**

Use key sync-conflicts-v1 and this entry:

~~~ts
export interface SyncConflict {
  entityType: SyncEntityType;
  entityId: string;
  reason: string;
  parentType?: SyncEntityType;
  parentId?: string;
  createdAt: number;
}
~~~

Use this reference shape for batched explicit-edit clears:

~~~ts
export interface SyncEntityReference {
  entityType: SyncEntityType;
  entityId: string;
}
~~~

Keep a Map keyed by entityType:entityId and one hydration promise. list returns copied entry objects after callers await ready. recordRejections ignores stale, validates type/parent_type with isSyncEntityType, then persists once. recordPayload records all five payload arrays using their API/entity type mapping. clearRoot computes a breadth-first transitive closure: after removing the root, repeatedly remove entries whose parent is any removed entity until no descendants remain. reset clears memory and deletes kv.

Expose a mutation preview so Task 7 can put the conflict update in the same transaction as the data migration:

Import `BulkWriteOp` from `lib/idb.ts` for the transaction operation type.

~~~ts
export interface SyncConflictMutation {
  entries: SyncConflict[];
  operation: BulkWriteOp;
}

prepareClearRootMutation(
  entityType: SyncEntityType,
  entityId: string,
): SyncConflictMutation;

applyMutation(mutation: SyncConflictMutation): void;
~~~

prepareClearRootMutation computes the transitive remaining entries without changing memory or IndexedDB and returns a kv put for the complete versioned record, including an empty entries array. clearRoot awaits idbBulkWrite with that one operation and calls applyMutation only after commit. clearEntities removes a list of exact entity references and persists once. Task 7 embeds the root mutation operation in its larger transaction and calls applyMutation after that transaction commits.

Implement filterPayload without assertions:

~~~ts
return {
  entities: {
    workspaces: payload.entities.workspaces.filter((entity) => !this.isBlocked("workspace", entity.id)),
    collections: payload.entities.collections.filter((entity) => !this.isBlocked("collection", entity.id)),
    bookmarks: payload.entities.bookmarks.filter((entity) => !this.isBlocked("bookmark", entity.id)),
    tags: payload.entities.tags.filter((entity) => !this.isBlocked("tag", entity.id)),
    groups: payload.entities.groups.filter((entity) => !this.isBlocked("saved_group", entity.id)),
  },
};
~~~

- [ ] **Step 4: Make sweeps async and conflict-aware**

Change all three interfaces to sweepUnsynced(): Promise<void>. Await registry.ready, retain bookmark load-and-keep, filter the payload, and enqueue only non-empty output with conflictPolicy respect. Add the optional parameter to SyncEngine.enqueue now; Task 8 implements clear/respect behavior.

- [ ] **Step 5: Reset registry on authenticated-to-guest cleanup**

In StoreGate's shouldResetLocalData branch invoke syncConflictRegistry.reset. clearDB removes persistence; reset synchronizes module memory immediately.

- [ ] **Step 6: Test, compile, and commit**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/sync-conflicts.test.js test/workspace-store.test.js test/bookmarks-store-offline.test.js test/groups-store-delete.test.js
bun run compile
git add lib/sync-conflicts.ts test/sync-conflicts.test.js store/workspace-store.ts store/bookmarks-store.ts store/groups-store.ts lib/sync-engine.ts entrypoints/newtab/App.tsx
git commit -m "feat(sync): persist deterministic conflicts"
~~~

Expected: PASS and no lazy bookmark regression.

---

### Task 7: Commit Guest Reconciliation Atomically and Apply It to Stores

**Files:**

- Create: lib/guest-workspace-reconciliation.ts
- Create: test/guest-workspace-reconciliation.test.js
- Modify: store/workspace-store.ts, store/bookmarks-store.ts, store/groups-store.ts

**Interfaces:**

- Produces prepareGuestWorkspaceForPull(response: SyncPullResponse): Promise<GuestReconciliationResult>.
- Produces confirmGuestWorkspaceFromPull(response: SyncPullResponse): Promise<void>.
- Produces resolveGuestPushRejections(response: SyncPushResponse): Promise<GuestReconciliationResult>.
- Produces resolveLegacyGuestWorkspaceFailure(plan: PlanResponse, remote: SyncPullResponse): Promise<GuestReconciliationResult>.
- Produces clearCapacityResolvedConflicts(plan: PlanResponse): Promise<boolean>.
- Produces getPersistentSyncErrorKey(): Promise<SyncConflictErrorKey|null>.
- Produces sweepAllUnsynced(): Promise<void>.
- Produces GuestReconciliationResult.
- Produces narrow store apply actions with no IDB or enqueue side effects.

- [ ] **Step 1: Write failing transaction tests**

Mock all IDB reads, idbBulkWrite, registry, and store getState. Test untouched discard (including clearing activeWorkspaceId while leaving tags untouched); quota migration across active/archive/trash/groups; group tabs are read and remain byte-for-byte unchanged; deferred transaction does not apply memory; rejected transaction leaves memory unchanged; second resolution after committed provenance deletion returns none.

Add separate tests that assert meaningful guest data is retained before pull merge, an empty remote account does not discard the seed, provenance clears only when a pulled workspace matches the marked ID with seq > 0, capacity refresh clears only quota roots, and legacy recovery returns none when any one of its four evidence conditions is absent.

~~~js
expect((await prepareGuestWorkspaceForPull(existingAccountResponse)).kind).toBe("retained");
expect((await prepareGuestWorkspaceForPull(emptyAccountResponse)).kind).toBe("retained");
await confirmGuestWorkspaceFromPull(unrelatedWorkspaceResponse);
expect(provenanceDeleted).toBe(false);
await confirmGuestWorkspaceFromPull(confirmedGuestWorkspaceResponse);
expect(provenanceDeleted).toBe(true);

for (const evidence of legacyEvidenceMissingOneCondition) {
  expect((await resolveLegacyGuestWorkspaceFailure(evidence.plan, evidence.remote)).kind).toBe("none");
}
~~~

Expected migration operations include:

~~~js
expect(storesInTransaction).toEqual(new Set([
  "workspaces", "collections", "bookmarks", "archived-bookmarks",
  "trashed-bookmarks", "groups", "kv",
]));
~~~

- [ ] **Step 2: Run and verify missing coordinator**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/guest-workspace-reconciliation.test.js
~~~

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add post-commit store apply actions**

Add an exported object-shape interface to lib/guest-workspace.ts, then add these store actions:

~~~ts
export interface GuestWorkspaceChanges {
  workspaceDeletes: string[];
  collectionPuts: Collection[];
  collectionDeletes: string[];
  activeWorkspaceId?: string;
}

applyGuestWorkspaceChanges: (changes: GuestWorkspaceChanges) => void;
applyGuestBookmarkChanges: (changes: GuestBookmarkUpdates) => void;
applyGuestGroupChanges: (groups: SavedGroup[]) => void;
~~~

Workspace action deletes/merges by ID. Bookmark action updates active Map/counts and only updates archived/trashed arrays if their loaded flags are true. Group action merges by ID and leaves tabs unchanged. These actions never write IDB or enqueue.

- [ ] **Step 4: Make workspace/group pull merges await persistence**

Change mergeFromServer to Promise<void> in workspace and groups stores. Collect their current fire-and-forget puts/deletes into BulkWriteOp arrays and await one idbBulkWrite after the pure state update. Preserve all tombstone, isDefault, and lazy-load rules.

Also change workspace setLocalSeq to Promise<void>. Persist the kv value first and update Zustand only after idbPut resolves:

~~~ts
setLocalSeq: async (seq) => {
  await idbPut("kv", { key: "localSeq", value: seq });
  set({ localSeq: seq });
},
~~~

- [ ] **Step 5: Implement canonical snapshot loading**

Read provenance and all canonical stores before planning:

~~~ts
const [workspaces, collections, activeBookmarks, archivedBookmarks, trashedBookmarks, groups, groupTabs] =
  await Promise.all([
    idbGetAll<Workspace>("workspaces"),
    idbGetAll<Collection>("collections"),
    idbGetAll<Bookmark>("bookmarks"),
    idbGetAll<Bookmark>("archived-bookmarks"),
    idbGetAll<Bookmark>("trashed-bookmarks"),
    idbGetAll<SavedGroup>("groups"),
    idbGetAll<GroupTab>("group-tabs"),
  ]);
~~~

Include groupTabs in the snapshot for completeness and meaningful-data auditing, but do not emit group-tabs writes because group IDs are preserved.

If both marked workspace and marked default are absent, delete stale provenance. If only one remains, persist a conflict rather than deleting data.

- [ ] **Step 6: Commit a migration in one bulk write**

For an untouched discard, one transaction deletes the marked workspace, marked default collection, activeWorkspaceId kv entry, and provenance kv entry. After commit, apply the workspace changes with activeWorkspaceId empty; the following remote workspace merge chooses and persists the confirmed target. Do not include tags or unrelated entities in this transaction.

Convert the pure plan to puts/deletes for all stores plus activeWorkspaceId and provenance delete. Before opening the transaction, call prepareClearRootMutation("workspace", sourceWorkspaceId) and append its operation to the same BulkWriteOp array. Await one idbBulkWrite, then apply the three store actions and call applyMutation. The conflict record, provenance, source deletion, rewritten children, and active workspace therefore commit together.

~~~ts
export interface GuestReconciliationResult {
  kind: "none" | "discarded" | "retained" | "migrated" | "conflict";
  needsResweep: boolean;
  targetWorkspaceName?: string;
  errorKey?: SyncConflictErrorKey;
}

export type SyncConflictErrorKey =
  | "sync_noMigrationTarget"
  | "sync_invalidParentConflict"
  | "sync_quotaConflict";
~~~

On IDB rejection, apply no store changes, apply no conflict mutation, enqueue nothing, and rethrow.

- [ ] **Step 7: Implement pull preparation and confirmation**

prepareGuestWorkspaceForPull discards only when the response contains an active remote workspace other than the marked source and the seed is untouched. Meaningful data returns retained.

confirmGuestWorkspaceFromPull deletes provenance only when the response contains the marked workspace with seq greater than zero and no deleted_at.

- [ ] **Step 8: Implement push rejection resolution**

Order:

~~~text
hydrate registry
record every non-stale structured rejection
load provenance
find marked workspace rejection
no marked workspace quota root => return current persistent conflict, if any
marked non-quota rejection => return current persistent conflict, if any
quota + no confirmed target => persist root, response children, and every local descendant, sync_noMigrationTarget
quota + target => build plan, bulk commit, apply stores, clear root, return migrated/resweep
~~~

Target selection uses current workspace/collection state after the first pull.

This ordering also preserves unrelated collection or saved-group rejections when the marked guest workspace succeeds or migrates. With no provenance, derive the result from the persisted registry: an invalid_parent root takes sync_invalidParentConflict; an unresolved quota root takes sync_quotaConflict. A parent_rejected child follows its root cause and does not override a quota message. Stale-only responses add no conflict.

For the no-target branch, load the canonical source snapshot and synthesize conflict entries for every source collection, every bookmark in all three buckets whose collection belongs to the source, and every source group. Parent links form workspace -> collection/group -> bookmark so one later transitive clear releases the whole chain without an intermediate rejected upload.

- [ ] **Step 9: Implement canonical sweep and legacy evidence gate**

~~~ts
export async function sweepAllUnsynced(): Promise<void> {
  await useWorkspaceStore.getState().sweepUnsynced();
  await useBookmarksStore.getState().sweepUnsynced();
  await useGroupsStore.getState().sweepUnsynced();
}
~~~

Legacy inference requires pending provenance, source absent from full remote pull, at least one active remote workspace, and limits.max_workspaces not -1 with usage.workspaces at or above the limit. It never checks the English error string and never merges the diagnostic pull itself.

- [ ] **Step 10: Implement capacity conflict clearing**

clearCapacityResolvedConflicts(plan) clears only quota root chains whose resource has available usage under its exact limit. For each resource, compute available slots as unlimited when limit is -1 or `max(0, limit - usage)` otherwise; sort roots by createdAt then entity ID and clear at most that many chains. It does not clear invalid_parent and does not release more blocked entities than current capacity can accept. Return true when at least one root was cleared so App can resweep. Add tests for finite one-slot capacity, zero capacity, and unlimited capacity.

Implement getPersistentSyncErrorKey after registry hydration by reading provenance and registry.list. Pending provenance plus a blocked workspace quota root maps to sync_noMigrationTarget; any invalid_parent entry maps to sync_invalidParentConflict; any remaining quota root maps to sync_quotaConflict; an orphaned parent_rejected entry falls back to sync_invalidParentConflict; no entries returns null. This is the single source used after every pull and push so restart restores the error state.

- [ ] **Step 11: Test, compile, and commit**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/guest-workspace.test.js test/guest-workspace-reconciliation.test.js test/workspace-store.test.js test/bookmarks-store-offline.test.js test/groups-store-delete.test.js
bun run compile
git add lib/guest-workspace-reconciliation.ts test/guest-workspace-reconciliation.test.js store/workspace-store.ts store/bookmarks-store.ts store/groups-store.ts
git commit -m "feat(sync): reconcile guest workspaces atomically"
~~~

Expected: PASS, including transaction rollback and idempotence.

---

### Task 8: Make SyncQueue Await Resolution and Stop Blind Retries

**Files:**

- Modify: lib/sync-queue.ts
- Modify: test/sync-queue.test.js

**Interfaces:**

- Produces SyncConflictPolicy clear/respect.
- Produces async OnPushSuccess(response, confirmedPayload).
- Produces SyncPushFailure and async OnPushFailure(failure): Promise<boolean>.
- Produces isRetryablePushError and computeRetryDelay.

- [ ] **Step 1: Write failing stale-chunk and async callback tests**

For 901 bookmarks, return a rejection from the first 900-item chunk, delay onSuccess, and assert flush stays pending and only one API call occurs. After callback resolution, assert the last stale chunk was neither sent nor requeued.

- [ ] **Step 2: Write failing retry matrix tests**

Use a deterministic random option and assert:

~~~js
expect(isRetryablePushError(new MockApiError("timeout", 408))).toBe(true);
expect(isRetryablePushError(new MockApiError("rate", 429))).toBe(true);
expect(isRetryablePushError(new MockApiError("server", 500))).toBe(true);
expect(isRetryablePushError(new MockApiError("invalid", 422))).toBe(false);
expect(computeRetryDelay(2000, new MockApiError("server", 500), () => 0)).toBe(1600);
expect(computeRetryDelay(2000, new MockApiError("server", 500), () => 1)).toBe(2400);
~~~

Also assert fifth identical 5xx schedules base 300000, a permanent 4xx is recorded and not requeued, a failure handler returning true discards old chunks, and a newer in-flight edit wins over an older requeue.

- [ ] **Step 3: Run and verify failures**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/sync-queue.test.js
~~~

Expected: FAIL because callbacks are synchronous and every non-auth error retries.

- [ ] **Step 4: Add typed queue contracts**

Use Map<string, SyncEntity>. Add:

~~~ts
export type SyncConflictPolicy = "clear" | "respect";

export interface SyncQueueOptions {
  random?: () => number;
}

export interface SyncPushFailure {
  error: Error;
  payload: SyncPushPayload;
  retryable: boolean;
  status: number;
}

type OnPushSuccess = (response: SyncPushResponse, confirmedPayload: SyncPushPayload) => Promise<void>;
type OnPushFailure = (failure: SyncPushFailure) => Promise<boolean>;
~~~

Default enqueue policy is clear for user edits; sweeps pass respect. Keep a Map of SyncEntityReference values named pendingConflictClears beside the entity maps. A clear enqueue adds each entity key to that map; a respect enqueue does not. doPush already waits for recoveryReady—extend that readiness promise to await syncConflictRegistry.ready(), pass the pending values to clearEntities so they persist once, then filter the snapshot. This keeps enqueue synchronous for existing store callers while guaranteeing the first push cannot race conflict hydration.

When a clear and respect enqueue contain the same ID before a push, the clear marker wins because it represents an explicit user edit. Remove pending clear markers only after their registry update succeeds.

- [ ] **Step 5: Implement retry classification and jitter**

~~~ts
export function pushErrorStatus(error: Error): number {
  return error instanceof ApiError ? error.status : 0;
}

export function isRetryablePushError(error: Error): boolean {
  const status = pushErrorStatus(error);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export function computeRetryDelay(baseDelay: number, error: Error, random: () => number): number {
  const jittered = Math.round(baseDelay * (0.8 + random() * 0.4));
  if (error instanceof ApiError && error.status === 429 && error.retryAfter !== undefined) {
    return Math.max(error.retryAfter * 1000, jittered);
  }
  return jittered;
}
~~~

Keep 401/403 before this classifier.

- [ ] **Step 6: Stop stale chunks on structured rejection**

After each successful chunk, if rejected is non-empty, reset retry state, await onSuccess(response, chunk), and return. Do not requeue unsent chunks; canonical seq 0 data stays in IndexedDB and the callback resweeps.

For no-rejection chunks, retain aggregate partial success behavior. Maintain a confirmedPayload by merging successful chunks by entity ID. On complete success pass the original full payload; before reporting a later chunk failure pass confirmedPayload. Await aggregate onSuccess before onFailure.

- [ ] **Step 7: Distinguish handled, retryable, and permanent failures**

Build one snapshot from the failed current chunk plus remaining unsent chunks, call onFailure before requeue, and:

~~~text
handled true => discard old snapshot, reset counters
permanent => registry.recordPayload(http_status), do not requeue
retryable => requeue without overwriting newer map entries, schedule jitter
same 5xx fingerprint count 5 => use 300000 base probe
successful complete push or changed fingerprint => reset identical count
~~~

Fingerprint JSON.stringify(snapshot.entities). For retry requeue, merge old entities only when the live queue does not already contain that ID, preserving a newer edit made while the request was in flight.

- [ ] **Step 8: Verify and commit**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/sync-queue.test.js test/sync-recovery.test.js
bun run compile
git add lib/sync-queue.ts test/sync-queue.test.js
git commit -m "fix(sync): stop retrying stale rejected payloads"
~~~

Expected: existing auth recovery and newer-edit tests remain green.

---

### Task 9: Serialize SyncEngine Resolution, Pull, and SSE Work

**Files:**

- Create: test/sync-engine-ordering.test.js
- Modify: lib/sync-engine.ts
- Modify: test/sync-engine-analytics.test.js

**Interfaces:**

- Produces async OnPullSuccess, OnPushSuccess, and OnLegacyPushFailure.
- Pull/push success callbacks return a persistent conflict message or null; SyncEngine alone owns status transitions.
- Guarantees pull and SSE pull wait for current push reconciliation, and coalesced pull requests are never dropped.

- [ ] **Step 1: Write failing ordering tests**

Mock SyncQueue and SSEClient. Capture queue success callback. Delay onPushSuccess and assert no pull occurs until it resolves. Record:

~~~js
expect(events).toEqual([
  "push-resolution-start",
  "push-resolution-end",
  "pull-request",
  "pull-merge-start",
  "pull-merge-end",
]);
~~~

Delay onPullSuccess, emit a second SSE sequence, and assert pull callbacks never overlap.

While the first pull callback is deferred, emit another SSE sequence and assert a second network pull runs after the first completes rather than being dropped. Seed a callback result of "Local data needs attention" and assert the final engine status remains error after the pull; a later null result clears it.

- [ ] **Step 2: Run and verify ordering failure**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/sync-engine-ordering.test.js test/sync-engine-analytics.test.js
~~~

Expected: FAIL because the engine does not await callbacks.

- [ ] **Step 3: Change callback contracts**

~~~ts
type OnPullSuccess = (response: SyncPullResponse) => Promise<string | null>;
type OnPushSuccess = (
  response: SyncPushResponse,
  confirmedPayload: SyncPushPayload,
) => Promise<string | null>;
type OnLegacyPushFailure = (failure: SyncPushFailure) => Promise<boolean>;
~~~

The returned string is already localized/sanitized presentation text; null means no persistent business conflict.

Add legacy callback as the sixth constructor argument after onStatusChange. Adapt existing tests with async no-op callbacks.

- [ ] **Step 4: Add a resolution chain**

~~~ts
private resolutionChain: Promise<void> = Promise.resolve();

private serializeResolution<Result>(operation: () => Promise<Result>): Promise<Result> {
  const next = this.resolutionChain.then(operation, operation);
  this.resolutionChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
~~~

Queue success awaits serialized onPushSuccess. Rejected success then awaits pull. Queue failure invokes the legacy callback only for retryable 5xx. When handled, set status from the current queue emptiness without emitting an error; when unhandled, set the existing sanitized error status and return false to the queue.

- [ ] **Step 5: Replace the lossy isPulling guard with a coalescing pull loop**

Replace isPulling with pullRequested and pullPromise. Every start/SSE/rejection/periodic/force request sets pullRequested. If a pull loop exists, return its promise; otherwise start a loop that clears the flag, awaits the current resolution chain, performs one authenticated pull, serializes and awaits onPullSuccess, applies its returned persistent conflict status, and repeats if another request arrived. Clear pullPromise in finally. This coalesces bursts but guarantees a request arriving during a pull causes one later pass.

After a rejected queue success, finish its serialized onPushSuccess first, then request and await the pull loop; do not request pull from inside the serialized operation. If the push callback returns a conflict message and the subsequent pull cannot run because credentials disappeared, retain that error status.

For a non-rejected success, apply the callback's returned persistent conflict message or the queue-derived idle/syncing status. For a completed pull, set error when the callback returns a message; otherwise set queue-derived status. This prevents an unresolved business conflict from being overwritten by idle and restores it after restart.

forceSync awaits queue.flush and then the same pull request method, rather than starting a separate network pull. Preserve token refresh, offline status, periodic pull, analytics sanitization, and instance-specific cleanup.

Avoid wrapping queue.flush and its callback in the same chain, which would deadlock.

- [ ] **Step 6: Verify and commit**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/sync-engine-ordering.test.js test/sync-engine-analytics.test.js test/sync-queue.test.js
bun run compile
git add lib/sync-engine.ts test/sync-engine-ordering.test.js test/sync-engine-analytics.test.js
git commit -m "fix(sync): serialize rejection resolution and pulls"
~~~

Expected: no overlapping pull callback and no analytics regression.

---

### Task 10: Wire Login Recovery, Capacity Retry, Legacy Fallback, and Feedback

**Files:**

- Create: components/ui/sync-recovery-alert.tsx
- Create: test/sync-recovery-i18n.test.js
- Modify: entrypoints/newtab/App.tsx, store/plan-store.ts
- Modify: test/plan-store.test.ts
- Modify: public/_locales/en/messages.json, public/_locales/zh_CN/messages.json
- Modify: CLAUDE.md

**Interfaces:**

- Consumes coordinator, async engine, and registry.
- Produces ordered first pull, push self-heal, plan capacity retry, force retry, and localized feedback.

- [ ] **Step 1: Write failing locale tests**

~~~js
import { describe, expect, test } from "bun:test";
import en from "../public/_locales/en/messages.json";
import zhCN from "../public/_locales/zh_CN/messages.json";

describe("sync recovery messages", () => {
  test("defines migration and conflict copy", () => {
    expect(en.sync_guestDataMerged.message).toContain("$1");
    expect(zhCN.sync_guestDataMerged.message).toContain("$1");
    expect(en.sync_noMigrationTarget.message.length).toBeGreaterThan(0);
    expect(zhCN.sync_noMigrationTarget.message.length).toBeGreaterThan(0);
    expect(en.sync_invalidParentConflict.message.length).toBeGreaterThan(0);
    expect(zhCN.sync_invalidParentConflict.message.length).toBeGreaterThan(0);
    expect(en.sync_quotaConflict.message.length).toBeGreaterThan(0);
    expect(zhCN.sync_quotaConflict.message.length).toBeGreaterThan(0);
  });
});
~~~

Run bun test test/sync-recovery-i18n.test.js and expect missing-key failure.

- [ ] **Step 2: Add English/Chinese messages**

English:

~~~json
"sync_guestDataMerged": {
  "message": "Offline data was merged into $1",
  "placeholders": { "workspace": { "content": "$1" } }
},
"sync_noMigrationTarget": {
  "message": "Offline data is safe locally, but no workspace is available for synchronization."
},
"sync_invalidParentConflict": {
  "message": "Some local data references a workspace or collection that is not available on this account."
},
"sync_quotaConflict": {
  "message": "Some local data exceeds the current plan capacity and remains safely stored on this device."
}
~~~

Chinese:

~~~json
"sync_guestDataMerged": {
  "message": "离线数据已合并到 $1",
  "placeholders": { "workspace": { "content": "$1" } }
},
"sync_noMigrationTarget": {
  "message": "离线数据已安全保留在本地，但当前没有可用于同步的工作区。"
},
"sync_invalidParentConflict": {
  "message": "部分本地数据引用了当前账号中不可用的工作区或收藏集。"
},
"sync_quotaConflict": {
  "message": "部分本地数据超出当前套餐容量，现已安全保留在此设备上。"
}
~~~

- [ ] **Step 3: Add the standard migration Alert**

Create SyncRecoveryAlert with targetWorkspaceName string|null, useTranslation, CheckCircle2, and shared Alert. Return null without a name; render t("sync_guestDataMerged", [name]) with the standard fixed top-center Alert classes.

- [ ] **Step 4: Return plan data from fetchPlan**

Change fetchPlan to Promise<PlanResponse|null>. Add a module-level in-flight record containing the credential pair, request generation, and promise. Concurrent callers with the same current credentials await and receive that promise instead of starting a second request. Return data only after a current authenticated request updates state; return null for missing credentials, stale generation, changed credentials, or caught failure. Clear the in-flight record in finally only when it still points to that request.

Extend test/plan-store.test.ts to defer api.getPlan, call fetchPlan twice, assert one HTTP call, resolve it, and assert both promises return the same authoritative PlanResponse. Also retain the existing credential-change test and assert its stale request returns null.

- [ ] **Step 5: Order onPullSuccess**

In SyncProvider, read `t` with useTranslation and mirror it into a ref just like the store callbacks. Use the ref inside engine callbacks so a locale render does not tear down and recreate the active engine.

Use this exact order:

~~~ts
const needsInitialPush = localSeqRef.current === 0 && response.server_seq === 0;
await prepareGuestWorkspaceForPull(response);
await mergeWorkspacesRef.current(response);
await mergeGroupsRef.current(response);
await mergeBookmarksRef.current(response);
await confirmGuestWorkspaceFromPull(response);

await setLocalSeqRef.current(response.server_seq);
localSeqRef.current = response.server_seq;

if (needsInitialPush && useWorkspaceStore.getState().workspaces.length === 0) {
  await useWorkspaceStore.getState().initializeGuestWorkspace();
}
await sweepAllUnsynced();

const refreshedPlan = await usePlanStore.getState().fetchPlan();
if (refreshedPlan && await clearCapacityResolvedConflicts(refreshedPlan)) {
  await sweepAllUnsynced();
}

const persistentErrorKey = await getPersistentSyncErrorKey();
return persistentErrorKey ? t(persistentErrorKey) : null;
~~~

This replaces old enqueueAllToSync branching.

- [ ] **Step 6: Resolve push rejections before pull**

Await resolveGuestPushRejections. Keep one quota alert per root type and refresh plan. On migrated, set recoveryWorkspaceName and resweep. Return the translated current result from getPersistentSyncErrorKey; do not set syncStatus directly because SyncEngine owns status transitions. Clear the notice after four seconds and cancel the timer on unmount.

- [ ] **Step 7: Wire legacy 500 diagnosis**

The sixth SyncEngine callback returns false unless status 500. For 500, get current credentials, full pull after_seq 0, and fresh plan. Call resolveLegacyGuestWorkspaceFailure. If migrated, show notice, resweep, and return true; otherwise false. Never match collection upsert failed text.

- [ ] **Step 8: Make manual force sync explicit**

~~~ts
const handleForceSync = useCallback(() => {
  void (async () => {
    await syncConflictRegistry.clearAllForManualRetry();
    await sweepAllUnsynced();
    if (syncEngine) {
      await syncEngine.forceSync();
      return;
    }
    if (serverUrl) {
      await useAuthStore.getState().silentRefresh();
    }
  })();
}, [serverUrl]);
~~~

Direct edits use default conflictPolicy clear; automatic sweeps use respect.

- [ ] **Step 9: Render notice and update architecture notes**

Render SyncRecoveryAlert beside QuotaAlert. In CLAUDE.md add guest-workspace-provenance-v1 and sync-conflicts-v1 to kv; document untouched/meaningful/capacity policy, async resolution before pull, and conflict-aware sweeps. Preserve unrelated rules.

- [ ] **Step 10: Run focused and full frontend verification**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
bun test test/auth-session.test.js test/guest-workspace.test.js test/guest-workspace-reconciliation.test.js test/sync-conflicts.test.js test/sync-queue.test.js test/sync-engine-ordering.test.js test/sync-engine-analytics.test.js test/sync-recovery.test.js test/sync-recovery-i18n.test.js test/plan-store.test.ts
bun test
bun run compile
bun run build
~~~

Expected: all commands exit 0.

- [ ] **Step 11: Commit client integration**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate
git add entrypoints/newtab/App.tsx store/plan-store.ts lib/guest-workspace-reconciliation.ts components/ui/sync-recovery-alert.tsx public/_locales/en/messages.json public/_locales/zh_CN/messages.json test/sync-recovery-i18n.test.js test/plan-store.test.ts CLAUDE.md
git commit -m "fix(sync): recover guest data on workspace quota"
~~~

---

### Task 11: Verify Cloud Integration and Prepare the Authorized Module Release

**Files:**

- Modify after authorization: /Users/lieutenant/Documents/github/TabSlate-cloud/go.mod
- Modify after authorization: /Users/lieutenant/Documents/github/TabSlate-cloud/go.sum
- Modify after authorization: /Users/lieutenant/Documents/github/TabSlate-cloud/.github/workflows/ci.yml
- Modify after authorization: /Users/lieutenant/Documents/github/TabSlate-cloud/CLAUDE.md

**Interfaces:**

- Consumes completed local Server module.
- Produces a verified Cloud build.
- After authorization, pins Cloud to Server v0.1.1 without local replace.

- [ ] **Step 1: Verify Cloud against the sibling Server**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-cloud
go test ./...
go vet ./...
go build ./...
git status --short
~~~

Expected: commands exit 0; status still shows only the existing untracked .DS_Store.

- [ ] **Step 2: Reverify Server before release**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-server
TEST_DATABASE_URL="$TEST_DATABASE_URL" go test ./...
go vet ./...
go build ./...
git status --short
~~~

Expected: commands exit 0, PostgreSQL sync tests run rather than skip, worktree clean.

- [ ] **Step 3: Stop for explicit release authorization**

Report the verified Server SHA and request permission before creating or pushing v0.1.1. Approval of this plan is not release authorization.

- [ ] **Step 4: After authorization, publish the patch tag**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git tag -a v0.1.1 -m "TabSlate-server v0.1.1"
git push origin v0.1.1
~~~

If v0.1.1 exists, stop and inspect; never move or overwrite a tag.

- [ ] **Step 5: Update Cloud to the release**

Remove the temporary replace block from go.mod, then:

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-cloud
go get github.com/TabSlate-dev/TabSlate-server@v0.1.1
go mod tidy
~~~

Expected: require v0.1.1, no replace, updated sums.

- [ ] **Step 6: Simplify Cloud CI**

Remove GONOSUMDB, sibling Server checkout, path-specific checkout, and working-directory lines. Final steps:

~~~yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-go@v6
    with:
      go-version-file: go.mod
      cache: true
  - name: Build
    run: go build ./...
  - name: Vet
    run: go vet ./...
  - name: Test
    run: go test ./...
~~~

Update Cloud CLAUDE.md dependency instructions in the same change: remove the statement that the replace directive is temporarily retained, record v0.1.1 as the minimum Server module carrying dependency-aware sync rejection, and keep go work as the recommended local multi-repository workflow.

- [ ] **Step 7: Verify and commit Cloud update**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-cloud
go list -m github.com/TabSlate-dev/TabSlate-server
go test ./...
go vet ./...
go build ./...
git diff --check
git status --short
git add go.mod go.sum .github/workflows/ci.yml CLAUDE.md
git commit -m "chore: update dependency-aware sync server"
~~~

Expected: go list reports v0.1.1 and .DS_Store remains unstaged.

- [ ] **Step 8: Run final cross-repository verification**

~~~bash
cd /Users/lieutenant/Documents/github/TabSlate-server
TEST_DATABASE_URL="$TEST_DATABASE_URL" go test ./... && go vet ./... && go build ./...

cd /Users/lieutenant/Documents/github/TabSlate
bun test && bun run compile && bun run build

cd /Users/lieutenant/Documents/github/TabSlate-cloud
go test ./... && go vet ./... && go build ./...
~~~

Expected: all nine commands exit 0.

- [ ] **Step 9: Manually verify acceptance flows without deploying**

Verify:

1. Untouched guest + existing free account discards only the automatic seed.
2. Meaningful guest + full workspace limit migrates all three bookmark buckets and groups, shows one notice, refreshes without duplicates.
3. Meaningful guest + spare capacity keeps an independent workspace until confirmation pull clears provenance.
4. Interrupted push/restart preserves provenance and resumes.
5. No valid target preserves local data and suppresses repeated sweeps.
6. Collection quota preserves collection/bookmarks locally without repeated pushes.
7. Network/503 retries recover; five identical 5xx failures use five-minute probing.
8. Legacy inference runs only with all four evidence conditions.

Capture the original regression response: HTTP 200 with workspace/quota_exceeded and dependent parent_rejected entries, never collection upsert failed.

---

## Completion Checklist

- [ ] Every new Server rejection includes type; dependency rejections include parent context.
- [ ] Server tests prove rejected parents never reach child batches.
- [ ] PostgreSQL diagnostics are internal and public errors are sanitized.
- [ ] Guest seed/provenance creation is atomic and idempotent.
- [ ] Untouched, meaningful-with-capacity, meaningful-without-capacity, empty-account, and no-target paths are tested.
- [ ] Active, archived, and trashed bookmarks survive default migration.
- [ ] Groups keep IDs/tabs and change only parent/seq.
- [ ] Pull/SSE cannot race push reconciliation.
- [ ] Structured rejections are not retried verbatim.
- [ ] Permanent conflicts survive restart and automated sweeps skip them.
- [ ] Edit, plan capacity, and force sync expose explicit retry paths.
- [ ] Frontend, Server, and Cloud verification commands pass.
- [ ] No database migration, IndexedDB bump, Cloud handler, leaked DB detail, or staged .DS_Store was introduced.
