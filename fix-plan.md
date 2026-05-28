# Fix Plan — All Verified TRUE POSITIVES

> Source: `bug.md` (3 findings) + `claude-bug.md` (10 findings)
> Date: 2026-05-28
> Excludes Bug #3 from claude-bug.md (FALSE POSITIVE — `forceSync` bypasses `isPulling` but never calls `onPullSuccess`; no real impact)

---

## 🔴 Critical (3)

---

### C-1 · `permanentlyDeleteBatch` partial-chunk data loss

**Repo:** TabSlate  
**File:** `store/bookmarks-store.ts:517–566`

**Root cause:** All bookmarks are removed from Zustand state optimistically before any push. On chunk N failure, only chunk N is rolled back. `idbBulkWrite` (after the loop) never runs for confirmed chunks. The always-on SSE connection triggers `mergeFromServer` within ~1 s of chunk 0 succeeding, which permanently removes those IDB records because the server has `is_trashed=2`. Data is unrecoverable.

**Fix:** Replace the single optimistic `set()` + end-of-loop `idbBulkWrite` with per-chunk persistence. After each successful `forcePush`, immediately write that chunk's IDB deletes and remove that chunk from state. Do not touch state or IDB before any push succeeds.

```typescript
// store/bookmarks-store.ts — permanentlyDeleteBatch
// Remove the existing lines 533–564 and replace with:

if (syncEngine) {
  const CHUNK = 900;
  for (let i = 0; i < bookmarks.length; i += CHUNK) {
    const chunk = bookmarks.slice(i, i + CHUNK);
    const chunkIds = new Set(chunk.map((b) => b.id));
    try {
      await syncEngine.forcePush({
        bookmarks: chunk.map((b) => toServerBookmark(b, { isTrashed: 2 })),
      });
    } catch {
      // Items from confirmed chunks were already removed from state/IDB.
      // This chunk and all remaining chunks are still in state — no rollback needed.
      return;
    }
    // Server confirmed this chunk — persist the IDB deletes now.
    const ops: BulkWriteOp[] = chunk.map((b) => ({
      type: "delete" as const,
      store: "trashed-bookmarks" as const,
      key: b.id,
    }));
    await idbBulkWrite(ops);
    set((current) => ({
      trashedBookmarks: current.trashedBookmarks.filter((b) => !chunkIds.has(b.id)),
    }));
    usePlanStore.getState().decrementUsage("bookmark", chunk.length);
  }
} else {
  // Offline — handled by Fix C-2 (tombstone to IDB for sweepUnsynced).
}
```

**Remove** the existing optimistic `set()` at lines 534–537 entirely. State changes happen incrementally inside the loop now.

---

### C-2 · Refresh token `DELETE` return value ignored → replay attack

**Repo:** TabSlate-server  
**File:** `internal/handler/auth.go:556–561`

**Root cause:** `h.db.Exec(DELETE FROM refresh_tokens ...)` return value is discarded. If the delete fails transiently, the old token remains valid and can be replayed for a second token pair. `h.db.QueryRow(...).Scan(...)` error is also discarded; if the user was concurrently deleted, `issueTokens` is called with a zero-value struct.

**Fix:** Check both return values. On `Exec` error return 500. On `Scan` error return 401.

```go
// internal/handler/auth.go — Refresh handler, replace lines 556–561:

_, execErr := h.db.Exec(ctx, `DELETE FROM refresh_tokens WHERE token_hash = $1`, tokenHash)
if execErr != nil {
    c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to invalidate refresh token"})
    return
}

var user model.User
scanErr := h.db.QueryRow(ctx,
    `SELECT id, name, email, is_verified, created_at, updated_at FROM users WHERE id = $1`, userID,
).Scan(&user.ID, &user.Name, &user.Email, &user.IsVerified, &user.CreatedAt, &user.UpdatedAt)
if scanErr != nil {
    c.JSON(http.StatusUnauthorized, gin.H{"error": "user not found"})
    return
}
```

---

### C-3 · TOCTOU quota bypass in `/sync/push`

**Repo:** TabSlate-server  
**File:** `internal/handler/sync.go:77–165`

**Root cause:** Quota is checked by pre-fetching entity counts, then the actual upsert batch executes in a separate transaction. Concurrent `POST /sync/push` calls from multiple tabs/devices can both pass the quota check before either writes, then both commit, pushing the total count above the plan limit.

**Fix:** Wrap the quota pre-fetch and the upsert batch inside a single serializable transaction, or use `SELECT ... FOR UPDATE` on the quota baseline rows to lock them for the duration of the write. The simplest correct approach is to move the entity count queries inside the same `pgx.Tx` as the upserts, using `SELECT COUNT(*) ... FOR UPDATE` to obtain an exclusive lock before comparing against the billing limit.

```go
// internal/handler/sync.go — Push handler
// Option A (recommended): serializable transaction isolation
tx, err := h.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
if err != nil {
    c.JSON(http.StatusInternalServerError, gin.H{"error": "quota check failed"})
    return
}
defer tx.Rollback(ctx)

// Move existing quota SELECT queries inside tx (use tx.QueryRow instead of h.db.QueryRow).
// Move existing upsert batch inside tx.
// tx.Commit() at end — serialization failure (40001) → retry or return 409.

// Option B (lower overhead): advisory lock per user_id
_, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userIDHash)
```

If serializable isolation causes too many retry errors under high load, use an advisory lock keyed on `user_id` inside the transaction to serialize concurrent pushes per user.

---

## 🟠 High (5)

---

### H-1 · `permanentlyDelete` offline skips push → server resurrects bookmark

**Repo:** TabSlate  
**File:** `store/bookmarks-store.ts:491–514`

**Root cause:** When `syncEngine` is null (browser restart + `silentRefresh` pending), the function skips `forcePush` and deletes from IDB directly with no tombstone. On next pull, server sends `is_trashed=1` → `mergeFromServer` puts the bookmark back in `trashed-bookmarks`.

**Fix:** When `syncEngine` is null, do not delete from IDB. Instead write the bookmark with `isTrashed: 2` and `seq: 0` to `trashed-bookmarks`, so `sweepUnsynced` picks it up and pushes the tombstone when the engine is available.

```typescript
// store/bookmarks-store.ts — permanentlyDelete, replace the else branch after line 510:
if (syncEngine) {
  // ... existing forcePush path (unchanged) ...
} else {
  // Offline: write a pending tombstone so sweepUnsynced can push it later.
  const tombstone: Bookmark = { ...bookmark, seq: 0, deletedAt: Date.now() };
  await idbPut("trashed-bookmarks", { ...tombstone, isTrashed: 2 } as unknown as Bookmark);
  // Keep in state with a marker so UI shows it as "pending delete".
  // sweepUnsynced will push is_trashed:2 on next online session.
}
// Remove: await idbDelete("trashed-bookmarks", bookmarkId);
// Remove: usePlanStore.getState().decrementUsage("bookmark");
// (decrementUsage is called after server confirms in the online path only)
```

Alternatively — and more simply — block the action with a toast ("Can't permanently delete while offline — try again once connected") and do not touch IDB at all when `syncEngine` is null. Either approach prevents resurrection.

---

### H-2 · `deleteWorkspace` races fire-and-forget `trashCollectionBookmarks` → orphan bookmarks

**Repo:** TabSlate  
**File:** `store/workspace-store.ts:454–496`

**Root cause:** `trashCollectionBookmarks(c.id)` is called without `await` inside `deleteWorkspace`. If the tab closes during the 5–50 ms window before the async `idbBulkWrite` inside that IIFE completes, bookmarks remain in the `bookmarks` IDB store with ghost `collectionId` references — permanently orphaned since the server soft-delete cascade does not tombstone bookmarks.

**Fix:** `deleteWorkspace` must be made async and must `await` all `trashCollectionBookmarks` calls before calling `idbDelete("workspaces", id)`.

```typescript
// store/workspace-store.ts — deleteWorkspace
// 1. Convert to async action (wrap body in void (async () => { ... })() or change signature)
// 2. Replace fire-and-forget calls:

for (const c of colsToTombstone) {
  idbPut("collections", c);
  await useBookmarksStore.getState().trashCollectionBookmarks(c.id); // ← add await
}
idbDelete("workspaces", id); // ← only called after all IDB bookmark moves are committed
```

`trashCollectionBookmarks` is already declared as returning `void` (it's a `void (async () => {})()` IIFE). Change its signature to return the inner Promise so callers can `await` it:

```typescript
// store/bookmarks-store.ts — trashCollectionBookmarks
// Change:  trashCollectionBookmarks: (collectionId) => { void (async () => { ... })(); }
// To:      trashCollectionBookmarks: (collectionId) => (async () => { ... })()
// (return the Promise directly; callers that don't need to await still work)
```

---

### H-3 · 401 recovery snapshot in module memory → lost on page reload

**Repo:** TabSlate  
**File:** `lib/sync-recovery.ts` + `lib/sync-queue.ts:123–129`

**Root cause:** `_pendingRecoverySnapshot` is a module-level `let` variable. If `silentRefresh` fails, the auth store navigates to the login page, the module reinitializes, and `_pendingRecoverySnapshot` is reset to `null`. Entities with `seq > 0` in the buffered chunk are permanently lost — `sweepUnsynced` only rescues `seq === 0` entities.

**Fix:** Persist `_pendingRecoverySnapshot` to `chrome.storage.session` on every `bufferSyncRecoverySnapshot` call. Load it from there in `SyncQueue` constructor before `takeSyncRecoverySnapshot`.

```typescript
// lib/sync-recovery.ts

const RECOVERY_KEY = "tabslate-sync-recovery";

export function bufferSyncRecoverySnapshot(snapshot: SyncPushPayload) {
  // ... existing merge logic ...
  // After merging, persist to session storage:
  void chrome.storage.session.set({ [RECOVERY_KEY]: JSON.stringify(_pendingRecoverySnapshot) });
}

export function takeSyncRecoverySnapshot(): SyncPushPayload | null {
  // Prefer in-memory (same session), fall back to session storage handled in SyncQueue ctor.
  const snapshot = _pendingRecoverySnapshot;
  _pendingRecoverySnapshot = null;
  void chrome.storage.session.remove(RECOVERY_KEY);
  return snapshot;
}

// New export for SyncQueue constructor to call:
export async function loadRecoverySnapshotFromStorage(): Promise<SyncPushPayload | null> {
  const result = await chrome.storage.session.get(RECOVERY_KEY);
  if (!result[RECOVERY_KEY]) return null;
  try {
    const snapshot = JSON.parse(result[RECOVERY_KEY]) as SyncPushPayload;
    await chrome.storage.session.remove(RECOVERY_KEY);
    return snapshot;
  } catch {
    return null;
  }
}
```

```typescript
// lib/sync-queue.ts — SyncQueue constructor
// Replace the synchronous takeSyncRecoverySnapshot() call:
// Option: make constructor async-aware via a static factory

static async create(...args): Promise<SyncQueue> {
  const q = new SyncQueue(...args);
  const recovery = takeSyncRecoverySnapshot() ?? await loadRecoverySnapshotFromStorage();
  if (recovery) {
    q.requeueSnapshot(recovery);
    q.schedulePush(0);
  }
  return q;
}
```

Update `SyncEngine` to use `await SyncQueue.create(...)` in its constructor (wrap in an `init()` async method called from `start()`).

---

### H-4 · `handleSyncOn404` + `inFlight` short-circuit → HTTP 500 for all new users

**Repo:** TabSlate-Cloud  
**File:** `internal/meteroid/provider.go:195–234`

**Root cause:** When `OnUserCreated` goroutine A holds the `inFlight` entry, a concurrent `GetLimits` call sees `EnsureUserSynced` return `nil` (correctly, goroutine A is handling it) and interprets that as "sync complete." The immediate retry `GetActiveSubscription` still returns 404 because goroutine A hasn't finished. Result: HTTP 500 for every new user's first API call after verification.

**Fix:** When `handleSyncOn404`'s `EnsureUserSynced` returns `nil` but the retry still gets 404, return free-plan limits as a temporary "not ready" response instead of an error. The next request (within seconds, after goroutine A completes) will succeed and cache properly.

```go
// internal/meteroid/provider.go — GetLimits, replace lines 226–234:

sub, err := p.client.GetActiveSubscription(ctx, userID)
if err != nil {
    if synced, syncErr := p.handleSyncOn404(ctx, userID, err); syncErr != nil {
        return nil, fmt.Errorf("meteroid GetLimits: %w", syncErr)
    } else if synced {
        // Retry once — goroutine A may have completed by now.
        sub, err = p.client.GetActiveSubscription(ctx, userID)
        if err != nil {
            // Still 404: goroutine A is still in flight. Return free-plan defaults
            // rather than a 500. The next request will hit the cache or succeed.
            log.Printf("meteroid: user %s not yet synced (in-flight), returning free defaults", userID)
            freeLimits := p.capacity.get("free")
            if freeLimits == nil {
                freeLimits = &billing.Limits{MaxWorkspaces: 1, MaxBookmarks: 1000, MaxCollections: 10, MaxTags: 20}
            }
            return freeLimits, nil
        }
    } else {
        return nil, fmt.Errorf("meteroid GetLimits: %w", err)
    }
}
```

Do NOT cache the free-plan fallback (skip `p.cache.Set`) so the next real call fetches the actual plan after goroutine A finishes.

---

### H-5 · Captcha token theft via wildcard `postMessage` + permissive `frame-ancestors`

**Repo:** TabSlate-server + TabSlate  
**Files:** `internal/handler/captcha.go:67,107–118` · `components/procaptcha.tsx`

**Root cause:** The captcha widget JS calls `parent.postMessage({type:'procaptcha-token', token}, '*')` — any page that embeds the widget (permitted by `frame-ancestors http: https:`) can receive the solved token and replay it against `/auth/register` or `/auth/login` before expiry.

**Two-part fix:**

**Part A — server: restrict `frame-ancestors` and `postMessage` target origin**

```go
// internal/handler/captcha.go — captchaWidgetJS template
// Change postMessage target from '*' to the extension's exact origin:

// Before:
parent.postMessage({type:'procaptcha-token',token:token}, '*');

// After (inject EXTENSION_ORIGIN from server config / env var):
parent.postMessage({type:'procaptcha-token',token:token}, '{{.AllowedOrigin}}');
```

The `AllowedOrigin` for the Chrome extension is `chrome-extension://<extension-id>`. Pass it as a template variable from the handler.

Also tighten the CSP `frame-ancestors` directive at `captcha.go:118`:

```go
// Change:
"frame-ancestors http: https: chrome-extension:"
// To:
"frame-ancestors chrome-extension://YOUR_EXTENSION_ID"
```

If a dynamic extension ID is not acceptable (e.g., development builds), at minimum remove `http:` and `https:` to prevent arbitrary websites from embedding the widget.

**Part B — frontend: validate `event.origin` in the postMessage listener**

```typescript
// components/procaptcha.tsx — message event handler
window.addEventListener("message", (e) => {
  // Reject messages from unexpected origins.
  if (e.origin !== import.meta.env.VITE_API_URL.replace(/\/$/, "")) return;
  if (e.data?.type !== "procaptcha-token") return;
  onToken(e.data.token as string);
});
```

---

## 🟡 Medium (5)

---

### M-1 · Missing body size limit on `PUT /preferences`

**Repo:** TabSlate-server  
**File:** `internal/handler/preferences.go:50–78`

**Root cause:** `c.ShouldBindJSON(&body)` reads from `c.Request.Body` with no `http.MaxBytesReader` wrapper. The `/sync/push` route has a 512 KB cap (`server.go:250–253`) but `/preferences` does not. An authenticated user can send an arbitrarily large JSON body, causing heap exhaustion and an unbounded write to the `preferences` TOAST column.

**Fix:** Add `MaxBytesReader` before the JSON bind in the `UpdatePreferences` handler:

```go
// internal/handler/preferences.go — UpdatePreferences, add at the top of the handler body:
const maxPrefsBytes = 64 * 1024 // 64 KB — preferences are small JSON objects
c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxPrefsBytes)

var body json.RawMessage
if err := c.ShouldBindJSON(&body); err != nil {
    // MaxBytesReader wraps the error; ShouldBindJSON surfaces it.
    c.JSON(http.StatusBadRequest, gin.H{"error": "request body too large or invalid JSON"})
    return
}
```

Alternatively, add a global middleware in `server.go` that sets `MaxBytesReader` for all routes except `/sync/push` (which already has its own limit):

```go
// server.go — setupRoutes, add global middleware:
r.Use(func(c *gin.Context) {
    if c.Request.URL.Path != "/sync/push" {
        c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64*1024)
    }
    c.Next()
})
```

---

### M-2 · Multi-chunk partial success: `onSuccess` not called → quota alerts dropped

**Repo:** TabSlate  
**File:** `lib/sync-queue.ts:117–150`

**Root cause:** When chunks 0..k-1 succeed and chunk k fails (non-401), the function returns early without calling `onSuccess`. Quota-exceeded rejections from successful chunks are silently dropped — no alert shown, no pull triggered.

**Fix:** On non-401 failure, call `onSuccess` with the partial `finalServerSeq` and accumulated `allRejected` from already-confirmed chunks before returning.

```typescript
// lib/sync-queue.ts — doPush, replace lines 133–145:
// Re-enqueue remaining chunks (unchanged):
for (let j = i; j < chunks.length; j++) {
  this.requeueSnapshot(chunks[j]);
}

// Report partial success so quota alerts fire and localSeq advances for confirmed chunks:
if (finalServerSeq > 0 || allRejected.length > 0) {
  this.onSuccess({ server_seq: finalServerSeq, rejected: allRejected });
}

this.onError(err instanceof Error ? err : new Error(String(err)));
if (this.retryTimer) clearTimeout(this.retryTimer);
this.retryTimer = setTimeout(() => {
  this.retryTimer = null;
  this.doPush();
}, this.retryDelay);
this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
return;
```

---

### M-3 · `ads-store.ts`: JSON parse error leaves `fetchedAt` stale → no retry for 10 min

**Repo:** TabSlate  
**File:** `store/ads-store.ts:74–103`

**Root cause:** `fetchedAt` is only set on the success path. If `response.json()` throws, the catch block only resets `isFetching`. `ensureFresh` sees a non-null, in-TTL `fetchedAt` and skips retrying.

**Fix:** Reset `fetchedAt` to `null` in the catch block:

```typescript
// store/ads-store.ts — fetchAds catch block, replace line 101:
} catch (err) {
  console.error("Error fetching ads:", err);
  set({ isFetching: false, fetchedAt: null }); // ← add fetchedAt: null
}
```

---

### M-4 · `content.ts` `onMessage` listener not removed → double `sendResponse` on reload

**Repo:** TabSlate  
**File:** `entrypoints/content.ts:59–90`

**Root cause:** `chrome.runtime.onMessage.addListener(...)` is registered inside `ctx.main()` with no `ctx.onInvalidated(() => removeListener(...))` cleanup. On extension reload, a second listener is registered alongside the first; both fire on `GET_PAGE_INFO` and the second's `sendResponse` call throws a runtime error.

**Fix:** Extract the handler to a named function and register cleanup:

```typescript
// entrypoints/content.ts — replace lines 59–90:
const handleMessage = (
  message: { type: string },
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): boolean => {
  if (message.type === "OPEN_SEARCH") {
    showOverlay();
    return false;
  }
  if (message.type !== "GET_PAGE_INFO") { return false; }

  // ... existing GET_PAGE_INFO response logic (unchanged) ...
  sendResponse({ title: document.title, url: location.href, /* ... */ });
  return true;
};

chrome.runtime.onMessage.addListener(handleMessage);
ctx.onInvalidated(() => chrome.runtime.onMessage.removeListener(handleMessage));
```

---

### M-5 · `deleteGroup` decrements quota even if group is already soft-deleted

**Repo:** TabSlate  
**File:** `store/groups-store.ts:172–184`

**Root cause:** Guard at line 174 checks `if (!group) return` but not `group.deletedAt`. A rapid double-click calls `deleteGroup` twice; Zustand's synchronous `set()` means the second call finds the group in state (with `deletedAt` set by the first call) but the guard doesn't catch it → `decrementUsage` fires twice → quota underreported.

**Fix:** Add the `deletedAt` check to the guard:

```typescript
// store/groups-store.ts — deleteGroup, replace line 174:
const group = get().groups.find(g => g.id === id);
if (!group || group.deletedAt) { return; } // ← add || group.deletedAt
```

---

## Implementation Order

| Priority | Fix | Effort | Blocking? |
|---|---|---|---|
| 1 | **C-1** permanentlyDeleteBatch data loss | Medium | Yes — data loss in production |
| 2 | **C-2** Refresh token DELETE ignored | Trivial | Yes — auth security |
| 3 | **H-4** inFlight race → new user 500 | Small | Yes — 100% new user breakage |
| 4 | **H-5** Captcha token theft | Medium | Yes — anti-abuse bypass |
| 5 | **C-3** TOCTOU quota bypass | Medium | Yes — billing integrity |
| 6 | **H-1** permanentlyDelete offline resurrection | Small | No — edge case |
| 7 | **H-2** deleteWorkspace orphan race | Small | No — edge case |
| 8 | **H-3** 401 recovery snapshot lost | Medium | No — rare auth failure path |
| 9 | **M-1** Missing body size limit | Trivial | No — DoS vector |
| 10 | **M-2** onSuccess not called on partial failure | Small | No — UX regression |
| 11 | **M-4** onMessage listener cleanup | Trivial | No — noise only |
| 12 | **M-3** fetchedAt stale on JSON error | Trivial | No — UX only |
| 13 | **M-5** deleteGroup double-decrement | Trivial | No — client UX drift |
