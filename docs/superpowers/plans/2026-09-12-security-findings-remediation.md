# Security Findings Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every currently reproducible Codex Security finding across the TabSlate extension, server, and Cloud provider without changing the intentionally goroutine-free Flexprice cache architecture.

**Architecture:** The extension will give the frameable overlay a short-lived capability bound to its tab before it can use privileged runtime messages. The server will enforce lifecycle and admission invariants at their shared stores and handlers, fail closed on unavailable authorization state, and retain account-deletion work until external PII deletion succeeds. Cloud will pin the fixed server revision and reject incomplete entitlement schemas instead of converting missing limits into unlimited values.

**Tech Stack:** TypeScript, React, Chrome MV3/WXT, Go, Gin, pgx/PostgreSQL, Redis/in-memory pubsub, Flexprice HTTP API, Bun, Go test.

**Spec:** `docs/superpowers/plans/2026-09-12-security-findings-remediation.md`

## Global Constraints

- Execute in the existing `main` worktrees; the user explicitly requested no worktree.
- Do not modify `TabSlate-Cloud/internal/flexprice/cache.go` or add a Flexprice background goroutine/`Start()` method; cross-replica entitlement-cache invalidation is intentionally excluded.
- Preserve the extension’s optional-host-permission model and closed ShadowRoot overlay UI.
- Keep full immutable SHA pins identical in Cloud CI and Docker workflows.
- Preserve explicit enabled `-1` entitlement values as unlimited; reject only incomplete, disabled, duplicated, or malformed required limits.
- Do not create a commit unless the user separately asks for one.

---

## File Structure

- `TabSlate/lib/search-overlay-session.ts` owns nonce format, short-lived registration, tab-bound validation, revocation, and query parsing.
- `TabSlate/entrypoints/content.ts`, `entrypoints/background.ts`, and `entrypoints/search-overlay/main.tsx` form the producer, authorization boundary, and consumer for that capability.
- `TabSlate-server/internal/pubsub/*` owns atomic local stream admission; `internal/handler/sse.go` consumes it.
- `TabSlate-server/internal/authstate`, `internal/handler/auth.go`, and `internal/middleware/auth.go` own durable credential invalidation and fail-closed authorization.
- `TabSlate-server/internal/handler/sync.go` and `cleanup.go` own tag tombstone lifecycle and durable external deletion retries.
- `TabSlate-Cloud/internal/flexprice/*` owns entitlement completeness validation; workflow files own the backend pin.

### Task 1: Gate the web-accessible search overlay with a capability

**Files:**
- Create: `TabSlate/lib/search-overlay-session.ts`
- Create: `TabSlate/lib/search-overlay-session.test.ts`
- Modify: `TabSlate/lib/messages.ts`
- Modify: `TabSlate/entrypoints/content.ts`
- Modify: `TabSlate/entrypoints/background.ts`
- Modify: `TabSlate/entrypoints/search-overlay/main.tsx`

**Interfaces:**
- Produces: `SearchOverlaySessionStore.register(nonce: string, tabID: number, now?: number): boolean`, `validate(nonce: string, tabID: number, now?: number): boolean`, `revoke(nonce: string, tabID: number): boolean`, and `getSearchOverlaySession(search: string): string | null`.
- Consumes: `REGISTER_SEARCH_OVERLAY_SESSION` and `VALIDATE_SEARCH_OVERLAY_SESSION` runtime messages.

- [ ] **Step 1: Write the failing test**

```ts
it("allows a registered nonce only in its issuing tab and rejects a different tab and expiry", () => {
  const sessions = new SearchOverlaySessionStore(1_000);
  const nonce = "a49f0fa8-2f92-467f-bda2-c1a2e5906d25";
  expect(sessions.register(nonce, 10, 100)).toBe(true);
  expect(sessions.validate(nonce, 11, 101)).toBe(false);
  expect(sessions.validate(nonce, 10, 102)).toBe(true);
  expect(sessions.validate(nonce, 10, 1_101)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/search-overlay-session.test.ts`

Expected: FAIL because the session-store module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SearchOverlaySessionStore {
  private readonly sessions = new Map<string, { expiresAt: number; tabID: number }>();

  public constructor(private readonly ttlMs = 30_000) {}

  public register(nonce: string, tabID: number, now = Date.now()): boolean { /* reject invalid values; record expiry */ }
  public consume(nonce: string, tabID: number, now = Date.now()): boolean { /* delete then validate tab and expiry */ }
}
```

Have `content.ts` create a UUID, register it from the content-script sender, and append it to `search-overlay.html`. Have `background.ts` accept registration only from a tab-bound non-extension sender and validation only from `search-overlay.html`; require the consumed tab-bound nonce before dispatching any overlay runtime operation. Have `main.tsx` validate the query nonce before calling `createRoot`, leaving direct frames blank.

- [ ] **Step 4: Run focused extension tests**

Run: `bun test lib/search-overlay-session.test.ts && bun run compile`

Expected: PASS; the direct-frame path has no capability and every normal in-content-script launch has a single valid capability.

- [ ] **Step 5: Inspect the message boundary**

Run: `rg -n 'GET_OPEN_TABS|SEARCH_BOOKMARKS|FOCUS_TAB|OPEN_TAB|REGISTER_SEARCH_OVERLAY_SESSION|VALIDATE_SEARCH_OVERLAY_SESSION' entrypoints lib`

Expected: every overlay operation remains behind the validated session path; no direct-frame dispatch remains.

### Task 2: Make local SSE admission and token consumption atomic

**Files:**
- Modify: `TabSlate-server/internal/pubsub/hub.go`
- Modify: `TabSlate-server/internal/pubsub/memory.go`
- Modify: `TabSlate-server/internal/pubsub/redis.go`
- Modify: `TabSlate-server/internal/pubsub/memory_test.go`
- Modify: `TabSlate-server/internal/handler/sse.go`
- Modify: `TabSlate-server/internal/handler/sse_test.go`

**Interfaces:**
- Produces: `Hub.TrySubscribe(userID string, limit int) (Subscription, bool)`.
- Consumes: an atomic cache `Take`/`GetDel` equivalent that consumes an SSE token exactly once.

- [ ] **Step 1: Write failing concurrency tests**

```go
func TestInMemoryHubTrySubscribeHonorsLimitAtomically(t *testing.T) {
    hub := pubsub.NewInMemoryHub()
    var admitted atomic.Int32
    var wg sync.WaitGroup
    for range 32 {
        wg.Add(1)
        go func() {
            defer wg.Done()
            if sub, ok := hub.TrySubscribe("user", 3); ok {
                admitted.Add(1)
                defer sub.Close()
            }
        }()
    }
    wg.Wait()
    require.Equal(t, int32(3), admitted.Load())
}
```

Add an SSE-handler test that races two requests using one one-time token and asserts only one reaches stream setup.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `go test ./internal/pubsub ./internal/handler -run 'Test(InMemoryHubTrySubscribeHonorsLimitAtomically|SSE.*SingleUse)' -count=1`

Expected: FAIL because admission and token consumption are separate read/write operations.

- [ ] **Step 3: Implement the atomic shared boundaries**

```go
type Hub interface {
    TrySubscribe(userID string, limit int) (Subscription, bool)
    Broadcast(userID string, event Event)
    Unsubscribe(userID string, sub Subscription)
}
```

Under the existing mutex in each hub implementation, reject when the user has `limit` subscriptions; otherwise allocate and register the subscription before releasing the lock. Replace `Count` plus `Subscribe` in `sse.go` with this call. Add an atomic cache consume primitive using the cache backend’s single-operation API, and use its returned value to validate the SSE token before admission.

- [ ] **Step 4: Run focused tests to verify pass**

Run: `go test ./internal/pubsub ./internal/handler -run 'Test(InMemoryHubTrySubscribeHonorsLimitAtomically|SSE.*SingleUse)' -count=1`

Expected: PASS; exactly the configured per-process cap is admitted and one token is not reusable.

- [ ] **Step 5: Run package checks**

Run: `go test ./internal/pubsub ./internal/handler -count=1`

Expected: PASS.

### Task 3: Fail closed and persist credential invalidation atomically

**Files:**
- Modify: `TabSlate-server/internal/authstate/authstate.go`
- Modify: `TabSlate-server/internal/handler/auth.go`
- Modify: `TabSlate-server/internal/handler/auth_test.go`
- Modify: `TabSlate-server/internal/middleware/auth.go`
- Create: `TabSlate-server/internal/middleware/auth_test.go`
- Modify: `TabSlate-server/app/server.go`

**Interfaces:**
- Produces: `Store.RevokeInTx(ctx context.Context, tx pgx.Tx, userID string, validAfter int64) error` and `Store.Invalidate(ctx context.Context, userID string) error`.
- Consumes: a narrow `authStateReader` interface in middleware with `Get(context.Context, string) (authstate.State, error)`.

- [ ] **Step 1: Write the failing tests**

```go
func TestAuthRejectsWhenAuthorizationStateIsUnavailable(t *testing.T) {
    router := gin.New()
    router.Use(middleware.Auth(testSecret, failingStateReader{}))
    reached := false
    router.GET("/protected", func(c *gin.Context) { reached = true; c.Status(http.StatusNoContent) })
    response := performAuthorizedRequest(t, router, "/protected", testAccessToken(t, testSecret))
    require.Equal(t, http.StatusServiceUnavailable, response.Code)
    require.False(t, reached)
}

func TestLogoutRevokesAccessEvenWhenRefreshTokenIsAlreadyGone(t *testing.T) {
    handler, context := newAuthenticatedAuthHandler(t, "user-1", "stale-refresh")
    handler.Logout(context)
    require.Equal(t, http.StatusOK, context.Writer.Status())
    require.Greater(t, tokenValidAfter(t, "user-1"), int64(0))
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `go test ./internal/middleware ./internal/handler -run 'Test(AuthRejectsWhenAuthorizationStateIsUnavailable|LogoutRevokesAccessEvenWhenRefreshTokenIsAlreadyGone)' -count=1`

Expected: FAIL because authstate errors fall through and logout relies on a matching refresh token before revocation.

- [ ] **Step 3: Implement the durable transition**

```go
func (s *Store) RevokeInTx(ctx context.Context, tx pgx.Tx, userID string, validAfter int64) error {
    _, err := tx.Exec(ctx, `UPDATE users SET token_valid_after = $1 WHERE id = $2`, validAfter, userID)
    return err
}
```

Move logout under the authenticated API route, obtain its subject from middleware context, and in one transaction delete the submitted refresh token and update `token_valid_after`; do not report success if the transaction fails. Make password reset and account deletion use the same update in their existing transactions, then invalidate the cache after commit. If state lookup or post-commit cache invalidation cannot establish a non-stale state, return a service error rather than accepting a bearer token. In `middleware.Auth`, abort with 503 before setting user context on `Get` failure.

- [ ] **Step 4: Run focused tests to verify pass**

Run: `go test ./internal/middleware ./internal/handler -run 'Test(AuthRejectsWhenAuthorizationStateIsUnavailable|LogoutRevokesAccessEvenWhenRefreshTokenIsAlreadyGone)' -count=1`

Expected: PASS; unavailable state cannot authorize and an authenticated logout advances the authorization watermark regardless of stale refresh rows.

- [ ] **Step 5: Run owning package checks**

Run: `go test ./internal/authstate ./internal/middleware ./internal/handler ./app -count=1`

Expected: PASS.

### Task 4: Bound tag tombstone storage and preserve external-deletion retries

**Files:**
- Modify: `TabSlate-server/internal/handler/sync.go`
- Modify: `TabSlate-server/internal/handler/sync_test.go`
- Modify: `TabSlate-server/internal/handler/cleanup.go`
- Modify: `TabSlate-server/internal/handler/cleanup_test.go`

**Interfaces:**
- Produces: tag synchronization that only accepts an incoming delete for an owned existing tag and applies a server-generated deletion time.
- Produces: cleanup that retains an expired user record when `billing.UserDeleter.OnUserDeleted` fails, so a later cleanup pass retries it.

- [ ] **Step 1: Write failing lifecycle tests**

```go
func TestSyncRejectsUnknownDeletedTag(t *testing.T) {
    result := syncTags(t, syncedTag{ID: "unknown", DeletedAt: ptr(time.Now().AddDate(10, 0, 0))})
    require.Empty(t, result.Accepted)
    require.Zero(t, countTags(t, "unknown"))
}

func TestCleanupRetainsUserWhenExternalDeletionFails(t *testing.T) {
    billing := &cleanupBillingSpy{deleteErr: errors.New("temporary Flexprice failure")}
    handler := newCleanupHandler(t, billing)
    createExpiredUser(t, handler.db, "user-1")
    handler.runOnce(context.Background())
    require.True(t, userExists(t, handler.db, "user-1"))
    billing.deleteErr = nil
    handler.runOnce(context.Background())
    require.False(t, userExists(t, handler.db, "user-1"))
}
```

- [ ] **Step 2: Run focused tests to verify failure**

Run: `go test ./internal/handler -run 'Test(SyncRejectsUnknownDeletedTag|CleanupRetainsUserWhenExternalDeletionFails)' -count=1`

Expected: FAIL because a novel tag tombstone is stored and cleanup deletes the local user before the external deletion succeeds.

- [ ] **Step 3: Implement the narrow lifecycle boundaries**

For a deleted incoming tag, query the existing tag under the authenticated user before upsert. Accept only a matching owned tag, write `deleted_at` using the server clock, and preserve idempotent updates of an existing tombstone. Add cleanup of expired tag tombstones using the existing retention window. In account cleanup, call `OnUserDeleted` before deleting the final local user record; on error, leave the record intact and continue processing other candidates. Keep the existing provider’s 404-as-success behavior so a crash after remote success can safely retry.

- [ ] **Step 4: Run focused tests to verify pass**

Run: `go test ./internal/handler -run 'Test(SyncRejectsUnknownDeletedTag|CleanupRetainsUserWhenExternalDeletionFails)' -count=1`

Expected: PASS; unowned tombstones do not persist and a transient external delete failure is retried from durable local state.

- [ ] **Step 5: Run handler package checks**

Run: `go test ./internal/handler -count=1`

Expected: PASS.

### Task 5: Fail closed on incomplete Flexprice entitlement schemas

**Files:**
- Modify: `TabSlate-Cloud/internal/flexprice/client.go`
- Modify: `TabSlate-Cloud/internal/flexprice/provider.go`
- Modify: `TabSlate-Cloud/internal/flexprice/provider_test.go`

**Interfaces:**
- Produces: `parseEntitlements(items []Entitlement) (*billing.Limits, error)` that requires exactly one enabled value for each supported entitlement key.

- [ ] **Step 1: Write failing provider tests**

```go
func TestGetLimitsRejectsIncompleteEntitlements(t *testing.T) {
    provider, server := newEntitlementProvider(t, activeSubscription(), entitlementResponse("feat-max-bookmarks", "100"))
    defer server.Close()
    _, err := provider.GetLimits(context.Background(), "customer-1")
    require.Error(t, err)
    require.Empty(t, provider.cache.entries)
}

func TestGetLimitsAcceptsCompleteExplicitUnlimitedEntitlements(t *testing.T) {
    provider, server := newEntitlementProvider(t, activeSubscription(), allEntitlements("-1"))
    defer server.Close()
    limits, err := provider.GetLimits(context.Background(), "customer-1")
    require.NoError(t, err)
    require.Equal(t, -1, limits.MaxBookmarks)
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `go test ./internal/flexprice -run 'TestGetLimits(RejectsIncompleteEntitlements|AcceptsCompleteExplicitUnlimitedEntitlements)' -count=1`

Expected: FAIL because omitted entries inherit `-1` and the incomplete response is cached.

- [ ] **Step 3: Implement complete-schema parsing**

Initialize no quota defaults. Reject empty `static_values` in the client. In `parseEntitlements`, track the six required keys, reject duplicate or disabled known keys, reject a missing required key after iteration, and keep unknown future keys ignored. Return parsing errors to `GetLimits` before writing the cache. Keep a present enabled literal `-1` and literal `0` as valid values.

- [ ] **Step 4: Run focused tests to verify pass**

Run: `go test ./internal/flexprice -run 'TestGetLimits(RejectsIncompleteEntitlements|AcceptsCompleteExplicitUnlimitedEntitlements)' -count=1`

Expected: PASS; a partial response does not become unlimited or enter cache, while an explicit complete unlimited plan remains valid.

- [ ] **Step 5: Run Cloud package checks**

Run: `go test ./internal/flexprice -count=1`

Expected: PASS.

### Task 6: Pin the Cloud build to the repaired server revision

**Files:**
- Modify: `TabSlate-Cloud/.github/workflows/ci.yml`
- Modify: `TabSlate-Cloud/.github/workflows/docker-publish.yml`

**Interfaces:**
- Produces: identical full-SHA `TabSlate-server` references in both Cloud workflows.

- [ ] **Step 1: Write the failing configuration assertion**

```sh
refs=$(rg -o 'TabSlate-server@[0-9a-f]{40}' .github/workflows | sort -u)
test "$refs" = "TabSlate-server@fffb895a6b9ccd9ceba1ab7a2dab6493dcbd7ead"
```

- [ ] **Step 2: Run the assertion to verify failure**

Run: `refs=$(rg -o 'TabSlate-server@[0-9a-f]{40}' .github/workflows | sort -u); test "$refs" = "TabSlate-server@fffb895a6b9ccd9ceba1ab7a2dab6493dcbd7ead"`

Expected: FAIL because both workflows still pin the pre-remediation SHA.

- [ ] **Step 3: Update both immutable pins**

Replace each `edb83dc172c6b0ca3b908c1c6d0fb1b028c7a1de` reference with `fffb895a6b9ccd9ceba1ab7a2dab6493dcbd7ead` and do not change the sibling-module `replace` directive.

- [ ] **Step 4: Run the configuration assertion to verify pass**

Run: `refs=$(rg -o 'TabSlate-server@[0-9a-f]{40}' .github/workflows | sort -u); test "$refs" = "TabSlate-server@fffb895a6b9ccd9ceba1ab7a2dab6493dcbd7ead"`

Expected: PASS; the two immutable pins are identical and target the repaired revision.

### Task 7: Review and verify the candidate

**Files:**
- Review: all diffs in `TabSlate`, `TabSlate-server`, and `TabSlate-Cloud`

**Interfaces:**
- Consumes: the completed tests and the final diff from Tasks 1–6.

- [ ] **Step 1: Run final static and unit verification**

Run: `bun run compile && bun run build` in `TabSlate`; `go test ./...` in `TabSlate-server`; `go test ./...` in `TabSlate-Cloud`.

Expected: PASS.

- [ ] **Step 2: Re-run the security-trigger tests**

Run: the focused test commands from Tasks 1–5 plus the workflow-pin assertion from Task 6.

Expected: PASS; direct overlay frames, concurrent SSE admission, unavailable auth state, stale logout refresh rows, unknown tag tombstones, failed external deletion, and incomplete entitlement payloads are all rejected or safely retained.

- [ ] **Step 3: Inspect every changed caller and final diff**

Run: `git -C /Users/lieutenant/Documents/github/TabSlate diff --check && git -C /Users/lieutenant/Documents/github/TabSlate-server diff --check && git -C /Users/lieutenant/Documents/github/TabSlate-Cloud diff --check`

Expected: PASS; no whitespace errors or unrelated changes.

- [ ] **Step 4: Perform the required fresh read-only bypass review**

Give a fresh reviewer only the finding scope, the three repository roots, the explicit exclusion of Cloud cross-replica cache invalidation, applicable repository policy, and the candidate diff. Confirm each concrete report against source or focused tests, make any necessary narrow revision, then repeat the affected verification.

## Self-Review

- Spec coverage: Task 1 covers overlay framing; Task 2 covers SSE admission and one-time token races; Task 3 covers durable revocation plus authstate fail-open; Task 4 covers deleted tags and customer PII retry; Task 5 covers entitlement defaults; Task 6 covers Cloud dependency pinning. The previously reported invalid collection/bookmark/group terminal-state path is already closed at the current server head and is intentionally a no-change item. Cross-replica Flexprice cache invalidation is explicitly excluded by user direction.
- Placeholder scan: no deferred implementation markers remain; every task has a command and concrete expected outcome.
- Type consistency: `SearchOverlaySessionStore`, `Hub.TrySubscribe`, `Store.RevokeInTx`, `Store.Invalidate`, and `parseEntitlements` are each defined before their consumers in the plan.
