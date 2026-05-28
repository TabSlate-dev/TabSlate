# Code Review Findings — All 3 Repos

> Reviewed: TabSlate (Chrome extension), TabSlate-server (Go OSS backend), TabSlate-Cloud (Go Cloud backend)
> Date: 2026-05-27
> Reviewer: Claude Sonnet 4.6
> Note: Issue #12 (email HTML injection, auth.go:712–718) was removed — already verified as FALSE POSITIVE in bug.md (FP-3). Self-affecting only, no cross-user impact.

---

## 🔴 Critical (2)

### 1. `permanentlyDeleteBatch` partial-chunk failure permanently loses data

**Repo:** TabSlate
**File:** `store/bookmarks-store.ts:534–563`

All bookmarks are removed from state optimistically before any push. On chunk N failure, only chunk N is restored to state. Items from chunks 0..N-1 have already been confirmed by the server, but `idbBulkWrite` (line 563) is never reached because the function returns early. Result: items are absent from both state and IDB, but present on the server — permanently invisible to the user until a full pull re-inserts them on the next login.

**Root cause:** The rollback at line 548–551 only restores `chunk` (the failing chunk), not the previously-confirmed chunks. `idbBulkWrite` is called once after the entire loop, so partial success is never persisted.

**Fix:** Track confirmed bookmarks incrementally. After each successful chunk push, immediately write that chunk's IDB deletes before proceeding to the next chunk. On failure, only items not yet IDB-deleted need rollback.

---

### 2. Refresh token `DELETE` return value ignored → token replay attack

**Repo:** TabSlate-server
**File:** `internal/handler/auth.go:556–561`

```go
h.db.Exec(ctx, `DELETE FROM refresh_tokens WHERE token_hash = $1`, tokenHash)
// error silently discarded

var user model.User
h.db.QueryRow(ctx,
    `SELECT id, name, email, is_verified, created_at, updated_at FROM users WHERE id = $1`, userID,
).Scan(&user.ID, &user.Name, &user.Email, &user.IsVerified, &user.CreatedAt, &user.UpdatedAt)
// scan error also silently discarded
```

Two problems on the same path:

1. If `DELETE` fails, the old refresh token is not invalidated and can be replayed by an attacker to get a second token pair — bypassing the rotation guarantee.
2. If `QueryRow().Scan()` fails (e.g. user was deleted), `user` is a zero-value struct. `issueTokens` is called with empty `ID` and `Email`, issuing a JWT with empty `sub` and `email` claims.

**Fix:** Check both return values. If `Exec` returns an error, return 500. If `Scan` returns an error, return 401 (user no longer exists).

---

## 🟠 High (5)

### 3. `forceSync()` bypasses `isPulling` guard → concurrent pulls corrupt `localSeq`

**Repo:** TabSlate
**File:** `lib/sync-engine.ts:106–137`

`forceSync()` calls `this.doPull()` directly (line 113), skipping the `isPulling` mutex guard that lives in `pull()` (line 140). If a periodic or SSE-triggered `pull()` is in flight when `forceSync()` is called (e.g. during logout cleanup in `SyncProvider`), two concurrent `syncPull` HTTP requests run against the same `localSeq`. Both call `onPullSuccess`, applying the same server delta twice and advancing `localSeq` to the wrong value.

**Fix:** Route `forceSync` through `pull()` (which has the `isPulling` guard), or set `isPulling = true` at the top of `forceSync` and release it in `finally`.

---

### 4. `permanentlyDelete` while offline skips push → server resurrects bookmark on next sync

**Repo:** TabSlate
**File:** `store/bookmarks-store.ts:491–514`

When `syncEngine` is `null`/`undefined` (cold start or offline), the function skips the `forcePush` block entirely and proceeds directly to `idbDelete` + `decrementUsage`. No tombstone is ever sent to the server. On the next online session, `sweepUnsynced` or the next pull re-inserts the bookmark from the server, silently undoing the user's deletion.

**Fix:** When `syncEngine` is absent, do not delete from IDB. Instead, write the bookmark with `isTrashed: 2` and `seq: 0` to IDB so `sweepUnsynced` picks it up and pushes the tombstone when connectivity is restored.

---

### 5. `deleteWorkspace` races async `trashCollectionBookmarks` → orphan active bookmarks in IDB

**Repo:** TabSlate
**File:** `store/workspace-store.ts:454–496`

`trashCollectionBookmarks(c.id)` is called as `void` (fire-and-forget async) for each collection. The workspace `idbDelete` and state `set()` execute immediately after without waiting. If the tab is closed in the window between workspace removal and `trashCollectionBookmarks` completing its `idbBulkWrite`, active bookmarks remain in the `bookmarks` IDB store with a `collectionId` that references a deleted workspace — permanently orphaned and counted against quota forever.

**Fix:** Either `await` all `trashCollectionBookmarks` calls before `idbDelete("workspaces", id)`, or use `idbTransaction` / `idbBulkWrite` to batch the entire workspace + bookmark move atomically.

---

### 6. 401 recovery snapshot stored only in module memory → lost on tab reload

**Repo:** TabSlate
**File:** `lib/sync-queue.ts:123–129` / `lib/sync-recovery.ts`

On a 401 error mid-chunk-sequence, `bufferSyncRecoverySnapshot(chunks[i])` stores the failed chunk in the module-level variable `_pendingRecoverySnapshot`. If the page reloads before a new `SyncQueue` is constructed to consume it via `takeSyncRecoverySnapshot()` (e.g. auth store triggers a full navigation after `silentRefresh`), the buffered chunk is silently dropped. All entity changes in that chunk are permanently lost with no fallback persistence.

**Fix:** Persist `_pendingRecoverySnapshot` to `chrome.storage.session` or IDB `kv` store on write, and load it from there on `SyncQueue` construction.

---

### 7. `handleSyncOn404` + `inFlight` guard → spurious HTTP 500 on first post-verification request

**Repo:** TabSlate-Cloud
**File:** `internal/meteroid/provider.go:195–234`

Race window: `OnUserCreated` goroutine is mid-flight for user X holding the `inFlight` lock. A concurrent `GET /api/plan` hits `GetLimits` → `GetActiveSubscription` → 404 → `handleSyncOn404` → `EnsureUserSynced` → `inFlight.LoadOrStore("X")` returns `loaded=true` → short-circuits returning `nil`. The retry `GetActiveSubscription` at line 229 still returns 404 (subscription not yet created by `OnUserCreated`). This propagates as an HTTP 500 to the client on the very first API call after email verification.

**Fix:** On a 404 after `EnsureUserSynced` short-circuits (because another goroutine is already creating the customer), return a temporary "not ready" response (e.g. free-plan limits) rather than a 500.

---

## 🟡 Medium (5)

### 8. Multi-chunk partial success: `onSuccess` not called → retry with `seq=0` → server rejects as stale

**Repo:** TabSlate
**File:** `lib/sync-queue.ts:117–150`

When chunks 0..k-1 succeed and chunk k fails with a non-401 error, the method returns early (line 145) without calling `onSuccess`. The re-queued chunks are pushed on retry with all entity `seq` values at `0`. The server's LWW logic (`WHERE updated_at < $14`) rejects entities already confirmed at a higher seq, returning them as `"stale"` — effectively causing the confirmed writes to be silently dropped on retry.

**Fix:** Track `finalServerSeq` from successful chunks and call `onSuccess({ server_seq: finalServerSeq, rejected: allRejected })` before returning on failure, so `localSeq` is advanced for the chunks that were already confirmed.

---

### 9. `ads-store.ts`: `response.json()` failure leaves `fetchedAt` stale → `ensureFresh` silently skips retry for 10 min

**Repo:** TabSlate
**File:** `store/ads-store.ts:74–103`

`fetchedAt` is only set on the full success path (line 94). If `fetch()` succeeds (HTTP 200) but `response.json()` throws (malformed JSON from the API), the catch block only resets `isFetching: false`, leaving `fetchedAt` at its previous value. `ensureFresh()` sees an in-TTL timestamp and skips retrying, silently serving empty ads for up to 10 minutes.

**Fix:** In the catch block, also set `fetchedAt: null` so the next `ensureFresh` call triggers a fresh fetch.

---

### 10. `content.ts` `onMessage` listener not cleaned up → double `sendResponse` on extension reload

**Repo:** TabSlate
**File:** `entrypoints/content.ts:59–90`

`chrome.runtime.onMessage.addListener` is called inside WXT's `ctx.main()` but never paired with a `removeListener` via `ctx.onInvalidated()`. On extension reload/update, a second listener is registered alongside the first. Both fire on `GET_PAGE_INFO`. The first sends a response; the second's `sendResponse` call throws *"The message channel is closed before a response was received"*, surfacing as an unhandled background error.

**Fix:**
```ts
const handler = (msg, sender, sendResponse) => { ... };
chrome.runtime.onMessage.addListener(handler);
ctx.onInvalidated(() => chrome.runtime.onMessage.removeListener(handler));
```

---

### 11. `deleteGroup` decrements quota even if group is already soft-deleted → double-decrement on double-click

**Repo:** TabSlate
**File:** `store/groups-store.ts:172–184`

The guard at line 173 checks `if (!group)` (not found in state) but not `group.deletedAt`. A rapid double-click or re-entrant call can trigger `deleteGroup` on a group already soft-deleted in state but before re-render disables the button. `decrementUsage("saved_group")` fires twice, permanently underreporting the quota count in `usePlanStore`.

**Fix:** Add `if (!group || group.deletedAt) return;` at the top of the action.

---

## Summary

| # | Severity | Repo | File | Description |
|---|---|---|---|---|
| 1 | 🔴 Critical | TabSlate | `store/bookmarks-store.ts:534–563` | `permanentlyDeleteBatch` partial-chunk data loss |
| 2 | 🔴 Critical | TabSlate-server | `internal/handler/auth.go:556–561` | Refresh token DELETE ignored → replay attack + empty JWT |
| 3 | 🟠 High | TabSlate | `lib/sync-engine.ts:106–137` | `forceSync` bypasses `isPulling` → double `onPullSuccess` |
| 4 | 🟠 High | TabSlate | `store/bookmarks-store.ts:491–514` | `permanentlyDelete` offline → server resurrects bookmark |
| 5 | 🟠 High | TabSlate | `store/workspace-store.ts:454–496` | `deleteWorkspace` races async trash → orphan IDB bookmarks |
| 6 | 🟠 High | TabSlate | `lib/sync-queue.ts:123–129` | 401 recovery snapshot lost on tab reload |
| 7 | 🟠 High | TabSlate-Cloud | `internal/meteroid/provider.go:195–234` | `inFlight` race → spurious 500 post-verification |
| 8 | 🟡 Medium | TabSlate | `lib/sync-queue.ts:117–150` | Partial chunk success: seq not reported → stale rejections on retry |
| 9 | 🟡 Medium | TabSlate | `store/ads-store.ts:74–103` | JSON parse error leaves `fetchedAt` stale → no retry for 10 min |
| 10 | 🟡 Medium | TabSlate | `entrypoints/content.ts:59–90` | `onMessage` listener not removed → double `sendResponse` |
| 11 | 🟡 Medium | TabSlate | `store/groups-store.ts:172–184` | `deleteGroup` double-decrement on rapid re-click |
