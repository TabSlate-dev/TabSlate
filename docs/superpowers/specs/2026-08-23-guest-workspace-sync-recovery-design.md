# Guest Workspace Sync Recovery Design

## Summary

TabSlate currently creates a local `My Workspace` and `Default` collection for every hydrated empty guest. When that guest logs in to an account that already owns the maximum number of workspaces, the server rejects the guest workspace for quota but continues processing its child collection. PostgreSQL then rejects the collection because its `workspace_id` does not exist, the server reduces the database error to `collection upsert failed`, and the client retries the same invalid payload indefinitely.

The fix keeps offline guest mode while making the guest seed explicit and recoverable. An untouched seed is discarded when an existing account is loaded. Meaningful guest data remains a separate workspace when the account has capacity; when it does not, the client atomically migrates the guest data into a confirmed server workspace. The server independently validates parent dependencies and returns structured business rejections instead of allowing a rejected parent to reach a child foreign-key failure.

The client serializes push resolution, pull, and unsynced sweeps; persists unresolved conflicts; and stops blindly retrying deterministic failures. No database schema migration is required.

## Goals

- Preserve the immediately usable offline guest dashboard.
- Avoid creating a second server workspace merely because the client created an untouched guest seed.
- Preserve all meaningful guest collections, bookmarks, saved groups, tabs, lifecycle states, and tags when the user logs in.
- Automatically recover when an account has no capacity for the guest workspace.
- Prevent child entities from being written when their parent was rejected or is invalid.
- Replace the generic failure path with structured, actionable business rejections.
- Prevent permanent payload failures from entering an endless two-second-to-sixty-second retry loop.
- Make guest reconciliation crash-safe, idempotent, and safe across extension restarts.
- Keep the OSS Server and Cloud API behavior identical.

## Non-goals

- Removing guest mode or requiring authentication before dashboard use.
- Changing plan limits or granting free accounts another workspace.
- Automatically merging every collection-quota or saved-group-quota conflict into another entity.
- Adding a server-side guest identity.
- Changing collection, bookmark, group, or workspace database schemas.
- Redesigning the general account logout policy, which continues to clear account-local data before creating a fresh guest session.
- Exposing PostgreSQL messages, constraint names, or internal database details to clients.

## Current State and Root Cause

### Guest seed creation

`StoreGate` in `entrypoints/newtab/App.tsx` creates `My Workspace` through the normal `createWorkspace()` action whenever all stores are hydrated, the session is guest, and no workspace exists. `createWorkspace()` creates both the workspace and its `Default` collection with `seq === 0`.

The guest-to-verified transition intentionally preserves local state. After the sync engine starts, a pull merges the existing account into the local stores and `sweepUnsynced()` uploads every remaining `seq === 0` guest entity. This behavior was introduced to support offline guest use and is correct for meaningful guest data, but the client currently cannot distinguish an untouched bootstrap seed from user-created data.

### Server failure chain

Cloud's free plan allows one workspace. For an existing account that already owns one workspace, a push containing the guest workspace and its default collection is processed as follows:

1. The workspace quota check rejects the guest workspace with `quota_exceeded`.
2. The collection loop still adds the guest collection to its PostgreSQL batch.
3. `collections.workspace_id` references the rejected, nonexistent workspace.
4. PostgreSQL raises a foreign-key error.
5. The handler returns the fixed HTTP 500 message `collection upsert failed` and does not log the underlying PostgreSQL error or entity context.
6. `SyncQueue` requeues the same payload and retries with exponential backoff.
7. A later pull or application restart sweeps the unchanged `seq === 0` entities and recreates the same failure.

The collection error is therefore a downstream symptom. The root causes are missing guest-seed provenance, parent-unaware server rejection handling, asynchronous synchronization callbacks that are not awaited, and a retry policy that treats deterministic payload failures like transient network failures.

### Workspace creation paths

There are two automatic workspace creation paths:

- The primary path is `StoreGate` guest initialization after hydration.
- `SyncProvider` also creates a workspace after an initial pull when both local and server sequence are zero and the merged local workspace list is empty. This path is for a genuinely empty account.

The first path produces the unexpected workspace seen after login. The second path remains valid but must use the same explicit seed initializer so every automatic seed has provenance and atomic persistence.

## Considered Approaches

### 1. Explicit guest provenance plus server dependency-aware rejection

Persist a local marker for the automatically created guest seed, reconcile it after the first authenticated pull, and add parent validation to the server. This preserves guest behavior, allows precise empty-seed deletion, supports automatic migration, and makes the server safe against malformed or stale clients.

This is the selected approach.

### 2. Client plan preflight only

The client could fetch plan usage before uploading and merge the workspace when it predicts a quota failure. This improves the common case but cannot be authoritative because plan data may be stale, concurrent clients can consume capacity, and old or malformed clients can still send invalid dependency chains. It also leaves the server's foreign-key failure behavior unchanged.

### 3. Virtual or lazy guest workspace

The guest dashboard could avoid persisting a real workspace until the user creates meaningful data. This would remove the empty seed conflict but requires broad changes to selectors, routing, creation flows, and every feature that currently assumes a persisted active workspace. It is disproportionate to the bug and carries higher regression risk.

## Selected Architecture

### Guest workspace provenance

Automatic seed creation is separated from the ordinary user-facing `createWorkspace()` action. A dedicated asynchronous initializer creates the workspace, default collection, active workspace key, and provenance record in one IndexedDB transaction.

The provenance record lives in the existing `kv` store and contains:

- A version number.
- The generated workspace ID.
- The generated default collection ID.
- The original mutable seed fingerprint, including workspace name and color and default collection name, icon, and initial position.
- A state indicating that server confirmation is still pending.

The record is local metadata and is never sent through the sync API. User-created workspaces do not receive this marker.

Provenance is removed only in one of these cases:

- An untouched seed is atomically discarded before guest data is merged with an existing account.
- A meaningful source workspace is atomically migrated into a confirmed server workspace.
- A later pull confirms that the original guest workspace now exists on the server.

Keeping provenance until pull confirmation covers lost push responses, extension shutdown during synchronization, and compatibility recovery against older servers.

### Meaningful guest data

The coordinator determines whether the marked seed is untouched from canonical IndexedDB data, not only from currently loaded Zustand arrays. The seed is untouched only when all of the following remain true:

- The workspace still matches its original seed fingerprint.
- The original default collection still matches its seed fingerprint.
- No additional collection belongs to the workspace.
- No active, archived, or trashed bookmark belongs to any collection in the workspace.
- No active or trashed saved group belongs to the workspace.

A renamed or recolored workspace, a renamed or otherwise modified default collection, any additional collection, any bookmark in any lifecycle bucket, or any saved group makes the seed meaningful.

Tags are global rather than workspace-owned. Guest tags are never discarded with an untouched workspace seed; they remain `seq === 0` and follow the normal tag synchronization path.

### Reconciliation coordinator

A dedicated client coordinator owns guest reconciliation. It reads the relevant IndexedDB records, produces a pure migration plan, commits all storage operations atomically, and only then applies the same result to the in-memory stores.

This coordinator prevents guest-specific decisions from being spread across `workspace-store`, `bookmarks-store`, `groups-store`, and `App.tsx`. Store actions may expose narrow internal apply operations, but the coordinator owns ordering and the transaction boundary.

### Sync serialization

Both pull-success and push-success callbacks become asynchronous contracts. `SyncEngine` awaits them before changing status, initiating a pull, or allowing an unsynced sweep.

Push reconciliation, pull merging, and `sweepUnsynced()` run through one serialized chain. SSE notifications received during reconciliation wait on the same chain. This prevents a pull from overwriting or duplicating state while a guest migration is in progress.

If a successful push chunk contains a rejection, the queue stops sending later chunks built from the old snapshot. It waits for reconciliation, discards the unsent stale snapshots, and rebuilds work from canonical IndexedDB state through a new sweep. Changes enqueued independently while the request was in flight remain in the live queue.

## Authenticated Data Flows

### Existing account and untouched guest seed

1. The client performs its first authenticated pull from sequence zero.
2. The response identifies one or more confirmed active server workspaces.
3. Before merging the remote state, the coordinator loads and classifies the marked guest seed.
4. If the seed is untouched, one IndexedDB transaction deletes its workspace and default collection and clears its provenance and stale active-workspace key.
5. The server data is merged and a confirmed server workspace becomes active.
6. No guest workspace or default collection is pushed.

### Existing account, meaningful guest data, and available capacity

1. The coordinator retains the guest entities and their `seq === 0` values.
2. The remote account is merged without replacing the guest source.
3. The normal sweep uploads the guest workspace and all children.
4. Provenance remains pending until a pull includes the guest workspace with a server-confirmed sequence.
5. The confirming pull clears provenance.

Client-side capacity information may optimize this path, but the server remains authoritative.

### Existing account, meaningful guest data, and no workspace capacity

1. The server returns `quota_exceeded` for the guest workspace and dependency rejections for its children.
2. `SyncEngine` pauses pull and later push chunks while the coordinator resolves the rejection.
3. The target workspace is the currently selected confirmed active server workspace when valid; otherwise it is the confirmed active server workspace with the lowest position.
4. Ordinary guest collections keep their IDs, names, icons, lifecycle state, and contents. Their `workspaceId` is rewritten to the target and their positions are assigned deterministically after the target's current range.
5. An untouched guest `Default` collection is merged into the target's confirmed default collection. Its active, archived, and trashed bookmarks keep their IDs and lifecycle state but receive the target default collection ID. The guest default collection is then removed.
6. A renamed or otherwise modified guest `Default` collection is preserved as an ordinary collection. It keeps its ID and content, moves to the target workspace, and clears `isDefault` so the server-confirmed target default remains unique.
7. Saved groups keep their IDs, titles, colors, tabs, tab ordering, and deletion state. Only their `workspaceId` changes.
8. Group-tab records do not require parent rewrites because their group IDs are preserved.
9. Tags remain unchanged.
10. One IndexedDB transaction writes all rewritten entities, removes the source workspace and any merged default collection, changes the active workspace, clears provenance, and clears handled conflicts.
11. In-memory stores are updated only after the transaction succeeds.
12. Canonical rewritten entities are enqueued and a pull follows their successful resolution.

The operation is idempotent: if interrupted after the IndexedDB commit, the absence of the source workspace and provenance prevents a second migration; remaining `seq === 0` entities are simply swept again.

### No valid target workspace

If the account has no confirmed active target, including a plan with a zero-workspace limit, the coordinator does not delete or rewrite guest data. It records a persistent conflict, stops automatic retries for the rejected dependency chain, displays an actionable sync error, and retains every local entity for later recovery.

### Empty account

When both local and server state are genuinely empty, the standard automatic seed is retained and uploaded. Provenance is cleared only after a pull confirms that workspace on the server. A network failure or restart therefore cannot turn an unconfirmed automatic seed into an untraceable ordinary workspace.

## Server Rejection Protocol

The wire response extends each rejected entity with dependency context:

```json
{
  "id": "entity-id",
  "type": "collection",
  "reason": "parent_rejected",
  "parent_id": "workspace-id",
  "parent_type": "workspace"
}
```

New server responses always include `type`. The new client transport decoder tolerates a missing `type` so it remains compatible with older servers.

Supported entity types are:

- `workspace`
- `collection`
- `bookmark`
- `saved_group`
- `tag`

Supported reasons are:

- `stale`: the server owns a newer version. The client pulls server truth and does not retry the old representation directly.
- `quota_exceeded`: the entity itself exceeds a plan limit.
- `parent_rejected`: the required parent was rejected earlier in the same push. `parent_id` and `parent_type` identify the root dependency.
- `invalid_parent`: the parent does not exist or is not owned by the authenticated user.

Business rejections use HTTP 200. Successfully accepted entities commit and the response includes the resulting `server_seq`.

### Dependency-aware processing

At the beginning of the transaction, the handler preloads the workspace and collection IDs owned by the authenticated user when request entities require those parents. It maintains accepted and rejected ID sets while processing entity types in dependency order.

The rules are:

1. A collection or saved group whose workspace was rejected in the current request is skipped with `parent_rejected`.
2. A collection or saved group whose workspace neither exists for the user nor was accepted in the current request is skipped with `invalid_parent`.
3. A bookmark whose collection was rejected in the current request is skipped with `parent_rejected`.
4. A bookmark whose collection neither exists for the user nor was accepted in the current request is skipped with `invalid_parent`.
5. A stale update to an already owned parent does not make that parent invalid for children; the authoritative parent already exists.
6. A parent ID owned by another user is never treated as valid, even though the global foreign key could otherwise resolve it.
7. Rejected entities are never added to a PostgreSQL batch.

The server enforces these rules independently of client provenance. This protects self-hosted installations, old clients, malformed payloads, and concurrency races.

### Database errors and observability

PostgreSQL failures are logged internally with:

- Operation and entity type.
- Relevant entity IDs or a bounded list for batch failures.
- SQLSTATE.
- Table and constraint metadata when available.
- Request and authenticated user correlation fields already supported by server logging.

The public response remains generic. PostgreSQL constraint details and raw messages are never returned.

Serialization failures (`40001`) and deadlocks (`40P01`) are classified as transient and return a retryable 503. Other unexpected database failures return a generic 500. Dependency validation should make the known foreign-key failure unreachable; if it recurs, the new logs provide the missing root-cause evidence.

## Client Conflict and Retry Model

### Persistent conflicts

Unresolved deterministic rejections are stored as a versioned record in the existing IndexedDB `kv` store. Each entry includes entity type, entity ID, reason, optional parent context, and creation time.

The queue consumes structured rejections rather than re-enqueuing the response payload. Automated sweeps skip explicitly conflicted entities and their rejected children. This prevents application restart, periodic pull, or SSE activity from recreating the same deterministic request loop.

Workspace quota conflicts resolved by automatic migration do not remain in the conflict record. Collection and saved-group quota conflicts remain local and visible because silently flattening or deleting those resources is outside this design.

A conflict may be retried when:

- The user edits the conflicted entity.
- A refreshed plan shows that capacity is now available.
- A parent is reassigned to a confirmed valid target.
- The user explicitly requests a force sync.

If the retry is rejected again, the conflict is persisted again. Local data always remains `seq === 0` until the server confirms it.

### Retry classification

- Network failures, HTTP 408, HTTP 429, HTTP 503, and other 5xx responses use exponential backoff with jitter.
- HTTP 429 respects `Retry-After` when present.
- HTTP 401 and 403 use the existing refresh-token recovery path and persisted recovery snapshot, with one authentication retry.
- Other deterministic 4xx responses are not automatically retried. The payload remains recoverable from IndexedDB and the sync status exposes an actionable error.
- HTTP 200 business rejections enter reconciliation and are never retried verbatim.
- After five consecutive failures with the same payload fingerprint and 5xx class, active retry switches to a five-minute probe. Network recovery, a new local edit, or manual force sync triggers an immediate probe.

The exact orphan-parent issue resolves through structured rejections rather than the 5xx circuit breaker. The breaker limits damage from unknown persistent server failures while still allowing eventual self-recovery from an outage.

### User feedback

Successful automatic migration produces one localized, non-blocking notification explaining that offline data was merged into the selected workspace. Quota information is refreshed afterward.

An unresolved conflict sets sync status to error and exposes a sanitized message through the existing sync-status tooltip. Quota rejections continue to trigger the quota alert and plan refresh. Dependency children do not generate duplicate alerts when the parent already explains the problem.

## Atomicity and Store Consistency

The coordinator loads canonical data before planning because archived and trashed bookmark buckets may not be hydrated in memory. It includes these object stores in the migration transaction:

- `workspaces`
- `collections`
- `bookmarks`
- `archived-bookmarks`
- `trashed-bookmarks`
- `groups`
- `kv`

`group-tabs` are read for meaningful-data detection but require no writes when group IDs are preserved. If a future migration changes group IDs, `group-tabs` must join the same transaction.

`idbBulkWrite()` issues all operations synchronously inside one IndexedDB transaction. No `await` occurs inside the transaction callback. The coordinator computes all reads and writes before opening the write transaction.

After the transaction commits, narrow store actions apply the already-computed state. Archived and trashed in-memory arrays are updated only when their existing loaded flags are true; otherwise IndexedDB remains authoritative and their normal lazy loaders will observe the migrated records later.

An IndexedDB failure leaves in-memory stores unchanged, keeps synchronization serialized, and surfaces an error. The client never pulls over a partially applied local migration.

## Backward Compatibility and Rollout

No PostgreSQL migration or IndexedDB version upgrade is required. Both new local records use the existing `kv` store.

Deployment order is:

1. Release `TabSlate-server` with dependency-aware rejection and logging.
2. Update the `TabSlate-cloud` Go module dependency and deploy Cloud.
3. Release the client reconciliation update.

Compatibility behavior is:

- New server with old client: the foreign-key 500 is removed. The old client may continue sweeping quota-rejected local data until it is upgraded, but it does not crash the transaction with an invalid child write.
- New client with old server: after a 500, the client performs one compatibility diagnostic pull. It may infer the legacy orphan-parent case only when pending guest provenance exists, the marked workspace is absent remotely, a confirmed target workspace exists, and authoritative plan data shows workspace capacity is full. It then uses the normal migration coordinator. Without all of this evidence it does not guess and follows the 5xx retry policy.
- Unknown future rejection reasons are preserved as unresolved conflicts rather than retried blindly.
- Old clients ignore additional JSON fields. New clients tolerate the old omission of `type` on stale rejections.

Cloud does not add a separate handler or business branch. It inherits the Server behavior through the existing module boundary; only the module version and verification change.

## Testing Strategy

### Client unit tests

Guest provenance and classification tests cover:

- Atomic seed creation records the workspace, default collection, active workspace, and provenance together.
- A seed is created only for a hydrated empty guest or a genuinely empty authenticated account.
- An untouched seed is discarded for an existing account.
- Workspace or default-collection edits make the seed meaningful.
- Additional collections, all three bookmark lifecycle buckets, and active or trashed groups make the seed meaningful.
- Global tags survive untouched-seed deletion.
- Provenance remains until a pull confirms an uploaded guest workspace.

Pure reconciliation-plan tests cover:

- Stable target selection.
- Independent-workspace preservation when capacity exists.
- Workspace-quota migration of ordinary collections and saved groups.
- Untouched default-collection merge across active, archived, and trashed bookmarks.
- Modified default preservation as a non-default collection.
- Deterministic, collision-free target positions.
- No-target conflict behavior.
- Repeated reconciliation is idempotent and does not duplicate entities.

Persistence and store tests cover:

- All migration writes are submitted through one bulk transaction.
- A transaction failure leaves every Zustand store unchanged.
- Loaded archived or trashed arrays are updated, while unloaded arrays remain lazy and are not overwritten.
- The source workspace, merged default, active workspace key, provenance, and handled conflicts change together.

Queue and engine tests cover:

- Async push-success and pull-success callbacks are awaited.
- Pull and SSE events wait for reconciliation.
- A rejected chunk stops later stale chunks and triggers a canonical resweep.
- New edits enqueued during an in-flight request are retained.
- `parent_rejected` is resolved with its root and not retried independently.
- Persistent conflicts survive restart and are skipped by sweeps.
- User edit, capacity refresh, and force sync can clear and retry a conflict.
- Network, 408, 429, authentication, deterministic 4xx, transient 5xx, and repeated-5xx probe behavior follow the retry matrix.
- Legacy-server compatibility inference requires every safety condition.

### Server tests

PostgreSQL-backed sync handler tests, gated by the existing `TEST_DATABASE_URL` convention, cover:

- With `MaxWorkspaces=1` and an existing workspace, an incoming guest workspace receives `quota_exceeded` while its collection and saved group receive `parent_rejected`; the response is HTTP 200 and no guest entity is inserted.
- A collection quota rejection causes its bookmarks to receive `parent_rejected`.
- Missing and cross-user workspace parents receive `invalid_parent`.
- Missing and cross-user collection parents receive `invalid_parent` for bookmarks.
- Children of existing owned parents and parents accepted earlier in the same request are inserted successfully.
- A stale but existing owned parent remains valid for children.
- Partial rejection does not roll back unrelated accepted entities and advances `server_seq` consistently.
- Transient PostgreSQL SQLSTATE values map to a retryable response.
- Public failures do not expose PostgreSQL constraint details.

### Cloud verification

After updating the Server module, Cloud runs its complete Go test, vet, and build checks to ensure the injected billing provider still supplies the quota limits used by the shared handler.

## Verification Commands

Frontend:

```bash
bun test
bun run compile
bun run build
```

Server:

```bash
go test ./...
go vet ./...
go build ./...
```

Cloud:

```bash
go test ./...
go vet ./...
go build ./...
```

Manual verification covers a guest with meaningful data logging into an existing free account, automatic migration, page refresh, browser restart, interrupted push recovery, a genuinely empty account, and an account with no valid target workspace.

## Acceptance Criteria

- Logging into an existing account does not upload an untouched automatic guest workspace.
- Meaningful guest data is never silently deleted because of workspace quota.
- Meaningful guest data remains independent when capacity exists and migrates automatically when capacity does not.
- Default-collection merging preserves all bookmark lifecycle states and IDs.
- Saved groups and group tabs survive workspace migration.
- The server never attempts to insert a child whose parent was rejected or is not owned by the user.
- The known scenario returns structured HTTP 200 rejections instead of `collection upsert failed`.
- Reconciliation completes before pull or another stale chunk can race it.
- Deterministic rejections and permanent client errors do not loop indefinitely.
- Interrupted reconciliation is recoverable after restart and does not duplicate data.
- Unexpected database errors are diagnosable from server logs without leaking internal details to clients.
- OSS Server and Cloud expose the same API contract and behavior.
