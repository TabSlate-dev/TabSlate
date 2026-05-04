# TabSlate Sync Design

**Date:** 2026-05-02  
**Scope:** Full data sync (workspaces, collections, bookmarks, tags) across devices  
**Repos affected:** `TabSlate` (frontend), `TabSlate-server` (backend)

---

## Goals

- Near-real-time sync across devices via SSE (primary)
- Periodic pull every 5 minutes as SSE fallback
- Manual "sync now" trigger for user control
- Correct behavior across devices with offline edits (soft deletes + LWW)
- Secure: no cross-user data leakage, no clock-skew bugs

## Non-Goals

- Collaborative real-time editing (multi-user same workspace)
- Operation log / undo history
- WebSocket (SSE is sufficient)

---

## Data Model Changes

### Server — New Table

```sql
CREATE TABLE user_sync_seq (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    seq     BIGINT NOT NULL DEFAULT 0
);
```

One row per user. Created during user registration (inside the same transaction that creates the `users` row). Every write atomically increments this counter and stamps the entity with the returned `seq`.

### Server — Schema Additions (all synced tables)

```sql
-- Apply to: workspaces, collections, bookmarks, tags
ALTER TABLE <table> ADD COLUMN seq        BIGINT NOT NULL DEFAULT 0;
ALTER TABLE <table> ADD COLUMN deleted_at BIGINT;  -- NULL = alive; unix ms = soft-deleted

CREATE INDEX idx_<table>_user_seq ON <table> (user_id, seq);
```

Hard-delete paths are removed. All DELETE endpoints become soft-delete: set `deleted_at`, bump `seq`.

### Frontend — Interface Changes

```typescript
// Added to Collection, Workspace, Bookmark, Tag interfaces in lib/types.ts
seq: number;         // 0 = never synced to server
deletedAt?: number;  // unix ms; undefined = alive
```

```typescript
// New chrome.storage key: "tabslate-sync"
// Stored separately from tabslate-workspace — it is a global per-user cursor, not workspace data
interface SyncMeta {
  localSeq: number;  // highest seq confirmed from server; 0 = never synced
}
```

---

## Server Sync Protocol

### Atomic Seq Helper (internal)

Used by every write path (CRUD endpoints + push handler) inside the same DB transaction:

```sql
UPDATE user_sync_seq SET seq = seq + 1 WHERE user_id = $1 RETURNING seq;
```

### `POST /sync/push`

Client pushes local changes.

**Request:**
```json
{
  "entities": {
    "workspaces":  [...],
    "collections": [...],
    "bookmarks":   [...],
    "tags":        [...]
  }
}
```

**Server logic (single transaction):**
1. Verify `user_id` ownership for every incoming entity ID — `403` + abort entire batch if any mismatch
2. Enforce payload limits: max 500KB body, max 1000 entities total
3. For each entity: LWW upsert — `UPDATE ... WHERE id = $id AND updated_at < $incoming_updated_at`
4. For creates: run plan quota check (`plan.CheckX()`); add to `rejected` with reason `"quota_exceeded"` if over limit
5. Stamp all accepted entities with new `seq` from `user_sync_seq`

**Response:**
```json
{
  "server_seq": 142,
  "rejected": [
    { "id": "abc", "reason": "quota_exceeded" },
    { "id": "xyz", "reason": "stale" }
  ]
}
```

### `GET /sync/pull?after_seq=<N>`

Client fetches delta since last known seq.

**Server query** (all four tables):
```sql
SELECT * FROM <table>
WHERE user_id = $uid AND seq > $N
ORDER BY seq ASC;
```

Includes soft-deleted rows (`deleted_at IS NOT NULL`).

**Response:**
```json
{
  "entities": {
    "workspaces":  [...],
    "collections": [...],
    "bookmarks":   [...],
    "tags":        [...]
  },
  "server_seq": 142
}
```

Client saves `server_seq` as its new `localSeq`.

### `POST /auth/sse-token`

Issues a short-lived SSE authentication token (EventSource cannot set Authorization headers).

- Returns a single-use token with 30-second TTL, stored in DB
- Token is deleted immediately on first use

**Response:** `{ "token": "<uuid>" }`

### `GET /sync/stream?token=<sse_token>`

SSE connection — primary real-time channel.

- Server validates token, binds connection to `user_id`, deletes token
- On every write for this `user_id`, server sends:
  ```
  data: {"seq": 143}
  ```
- Server sends `: ping` comment every 30s to keep connection alive through proxies
- Rate limit: max 10 concurrent SSE connections per user

**Rate limits:**
| Endpoint | Limit |
|---|---|
| `POST /sync/push` | 60 req/min per user |
| `GET /sync/pull` | 120 req/min per user |
| `GET /sync/stream` | 10 concurrent connections per user |

---

## Client Sync Engine

### Architecture

`lib/sync-engine.ts` — single class, instantiated once in `App.tsx` after auth hydration.

```
SyncEngine
  ├── SSEClient      — EventSource + reconnect logic
  ├── SyncScheduler  — 5-minute periodic pull timer
  └── SyncQueue      — debounced push queue (2s debounce)
```

### Local Write Flow (optimistic)

1. Store applies change immediately (`seq: 0`, `deletedAt` set for deletes) — UI updates instantly
2. Store calls `syncEngine.enqueue(changedEntities)`
3. `SyncQueue` debounces 2 seconds, then calls `POST /sync/push`
4. On success: store updates entity `seq` values and `localSeq` from `server_seq`
5. On failure: exponential backoff retry (2s → 4s → 8s → max 60s); local state preserved

### Pull Merge Logic

All three pull triggers (SSE, periodic, manual) call the same `pull()` method:

| Condition | Action |
|---|---|
| Entity not in local store | Add it |
| `incoming.updated_at > local.updated_at` | Overwrite local |
| `incoming.deleted_at` is set | Remove from UI; keep tombstone in store |
| `incoming.updated_at ≤ local.updated_at` | Discard — local wins |
| Orphaned bookmark (unknown `collectionId`) | Hold in `pendingOrphans`; resolve on next pull |
| Orphaned collection (unknown `workspaceId`) | Hold in `pendingOrphans`; resolve on next pull |

### SSE Client

```
connect()  →  fetch /auth/sse-token  →  new EventSource(/sync/stream?token=...)
onmessage  →  parse seq; if seq > localSeq → pull()
onerror    →  reconnect: 1s → 2s → 4s → max 30s
              after 3 failures: activate periodic pull; status → "offline"
```

SSE is established after `StoreGate` hydration completes. Torn down on logout.

### Manual Sync

`syncEngine.forceSync()`:
1. Flush debounce queue immediately (push pending changes)
2. Pull from `after_seq=localSeq`
3. Returns `{ pushed: N, pulled: M }` — shown as toast in UI

### Multi-Window Leader Election

Multiple browser windows each instantiate `SyncEngine`. To avoid redundant SSE connections:

- On init, attempt to claim a `tabslate-sync-leader` key in `chrome.storage.local` with a TTL timestamp
- Only the leader maintains the SSE connection
- Other windows still push/pull via HTTP; they receive store updates via `chrome.storage.onChanged`
- Leader re-claims on each heartbeat (every 25s); non-leaders promote themselves if claim expires

### Sync Status

```typescript
type SyncStatus = "idle" | "syncing" | "error" | "offline"
```

Exposed from `SyncEngine` and shown in the sidebar as a small indicator.

### Full Re-sync Trigger

If server returns a `server_seq` lower than the client's `localSeq` (e.g. after account recovery or data wipe), client detects divergence and re-syncs from scratch: `pull?after_seq=0`.

---

## Security Summary

| Concern | Mitigation |
|---|---|
| Cross-user entity injection | Ownership check on all incoming IDs before transaction |
| SSE token leakage via URL logs | Single-use, 30s TTL, deleted on first use |
| Buggy client hammering | Per-user rate limits on push/pull/stream |
| Large payload DoS | 500KB + 1000-entity hard caps on push |
| Plan quota bypass | Server-side quota enforcement inside push transaction |
| Clock skew | Server-assigned `seq` used as sync cursor; `updated_at` only used for LWW ordering |

---

## Error Scenarios

| Scenario | Behavior |
|---|---|
| Push network failure | Retry with exponential backoff |
| Push rejected (LWW loss) | Server version applied on next pull |
| SSE disconnect | Reconnect with backoff; periodic pull as fallback |
| Orphaned bookmark on pull | Buffered in `pendingOrphans`; resolved when parent collection arrives |
| `localSeq` divergence | Full re-sync from `after_seq=0` |
| Logout | Flush queue, tear down SSE, clear `localSeq` |
| Quota exceeded on push | Entity reverted locally; toast shown to user |
