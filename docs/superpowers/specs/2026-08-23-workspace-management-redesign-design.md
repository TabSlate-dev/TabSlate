# Workspace Management Redesign

## Summary

TabSlate currently deletes a Workspace by removing the parent record locally while soft-deleting its Collections, Bookmarks, and Saved Groups independently. `TrashContent` then treats Collections whose `workspaceId` no longer resolves as belonging to whichever Workspace is active. This flattens a deleted aggregate into another Workspace's content trash, loses the original management boundary, and makes restoration ambiguous. Deleted Groups can become invisible because their trash view still filters by the removed Workspace ID.

The redesign makes Workspace the recoverable aggregate root. Deleting a Workspace writes a tombstone only on the Workspace. Its Collections, Bookmarks, Saved Groups, Group Tabs, and their individual lifecycle states remain unchanged and attached to the original Workspace. The whole aggregate appears as one item in an account-level Workspace Manager and can be restored in place. The current Workspace's content trash remains strictly scoped to content deleted inside that active Workspace.

All retained data continues to count toward quota. Only permanent deletion releases quota. Authenticated Workspaces are automatically purged after the plan's existing `trash_grace_days`; Guest Workspaces have no automatic purge and remain local until explicitly restored or permanently deleted.

## Goals

- Preserve a deleted Workspace as one recoverable aggregate.
- Restore its Collections, Bookmarks, Saved Groups, Group Tabs, and pre-existing archive/trash states without rewriting every child.
- Prevent deleted Workspace data from appearing in another Workspace's content trash, search, archive, favorites, or normal views.
- Use one predictable quota rule: retained data counts; permanently deleted data does not.
- Use the same permanent-deletion transaction for explicit purge and retention expiry.
- Keep authenticated multi-device sync, offline mutations, Guest persistence, and cleanup behavior consistent.
- Preserve the existing OSS Server and Cloud API contract parity.
- Provide a migration path for authenticated legacy tombstones and orphaned Guest data.

## Non-goals

- Adding Workspace sharing, roles, membership, or ownership transfer.
- Adding a separate Workspace archive state. Archive remains a content-level concept.
- Redesigning Tags, which are global and permanently deleted rather than placed in a trash.
- Changing the existing account-deletion lifecycle.
- Treating deleted Workspaces as quota-free backup storage.
- Replacing the current entity delta-sync protocol with snapshots or event sourcing.

## Industry Guidance

The selected design follows several recurring product patterns:

- ClickUp keeps deleted hierarchy intact: children of a deleted Folder, List, or Space do not appear as unrelated top-level trash items, and deleted Spaces are recoverable during retention. See [Restore items from the Trash](https://help.clickup.com/hc/en-us/articles/6311742742423-Restore-items-from-the-Trash) and [Archive or restore Spaces](https://help.clickup.com/hc/en-us/articles/6309342765079-Archive-or-restore-Spaces).
- Notion retains deleted content for a defined window and supports restoration to its original location. See [Delete and restore content](https://www.notion.com/help/duplicate-delete-and-restore-content).
- Linear schedules top-level Workspace deletion and allows cancellation before permanent deletion. See [Workspaces](https://linear.app/docs/workspaces).
- Atlassian restores an organization to the state it had when deleted. See [Can I restore an organization?](https://support.atlassian.com/organization-administration/docs/can-i-restore-an-organization/).
- Google Drive and OneDrive count retained trash toward storage until it is permanently cleared. See [Manage your Google storage](https://support.google.com/drive/answer/6374270?hl=en) and [Manage OneDrive storage](https://support.microsoft.com/en-us/onedrive/manage-your-onedrive-for-work-or-school-storage).

These products vary in exact retention periods and whether top-level deletion is self-service recoverable, but they converge on preserving hierarchy, separating retention from permanent deletion, and making quota release explicit.

## Current State and Root Cause

`deleteWorkspace()` in `store/workspace-store.ts` currently performs a destructive decomposition:

1. Every active Saved Group is soft-deleted.
2. Every non-trashed Collection receives `deletedAt`.
3. Active and archived Bookmarks under those Collections are moved into the trashed bucket.
4. The Workspace is deleted from IndexedDB and removed from Zustand state.
5. `activeWorkspaceId` moves to another Workspace.

`TrashContent` then includes any trashed Collection whose `workspaceId` is absent from the current `workspaces` array. This is the direct cause of deleted Workspace content appearing in another Workspace's trash. Groups do not have the same orphan fallback, so they can no longer be reached through the UI.

The server retains the Workspace row through `deleted_at`, but the client merge path removes confirmed deleted Workspaces and deletes them from IndexedDB. Collections reference Workspaces with `ON DELETE SET NULL`, while Groups use `ON DELETE CASCADE`. The cleanup job handles Bookmark, Collection, and Group tombstones but not Workspace tombstones. The lifecycle therefore differs at every layer.

The existing delete operation also destroys some historical state. In particular, `trashCollectionBookmarks()` moves archived Bookmarks into the trashed store and pushes `is_archived=false`. Legacy restoration cannot perfectly infer that those Bookmarks were previously archived.

## Considered Approaches

### Parent tombstone

Only the Workspace receives a deletion tombstone. Child entities remain attached and keep their own lifecycle state. Effective visibility combines the child's state with the parent Workspace state.

This is the selected approach. It minimizes canonical writes, preserves state, restores atomically, and matches the current relational ownership model.

### Cascaded tombstones with a deletion batch

Every child would receive `deletedAt` and a `workspaceDeletionId`. Restoration would clear only tombstones from that batch and would also need to persist each child's previous active, archived, or trashed state.

This makes standalone child queries simpler, but creates large write amplification, complicated rollback, and difficult multi-device conflict handling. It repeats the structural flaw in the current implementation with more metadata.

### Deleted Workspace snapshots

The client or server would serialize the full aggregate into a `deleted_workspaces` snapshot and remove the live rows. Restore would rehydrate all entities.

This isolates retained data but introduces snapshot schema versioning, duplicate storage, ID collision handling, non-incremental sync, and a second persistence model. It is disproportionate to TabSlate's current entity-sync architecture.

## Selected Domain Model

### Workspace states

The server adds two Workspace lifecycle fields:

- `is_deleted INT NOT NULL DEFAULT 0`.
- `deletion_model SMALLINT NOT NULL DEFAULT 1`, where `0` means the pre-redesign cascaded model and `1` means the parent-tombstone model.

`is_deleted` has these values:

- `0`: active.
- `1`: deleted and retained.
- `2`: terminal tombstone for a permanently deleted Workspace.

`deleted_at` remains the time the Workspace entered retention. `updated_at` records the latest transition.

State `2` is a permanent protocol tombstone rather than recoverable user content. When a Workspace becomes state `2`, the server deletes every descendant and scrubs the Workspace row's user-facing fields: `name` becomes an empty string, `icon` and `color` become null, and `position` becomes zero. It retains only the random Workspace ID, owner ID, terminal state, deletion model, sequence, and timestamps. This minimal row remains until account deletion so an arbitrarily stale device can still pull the terminal state and can never recreate the same aggregate ID. It does not count toward quota or appear in normal APIs.

The client does not keep a separate permanent state in its normal `Workspace` model. `deletedAt` represents state `1`; a pulled state `2` record triggers local aggregate cleanup and is never persisted as a usable Workspace. The client keeps `deletionModel` only while a retained legacy Workspace still needs compatibility restoration; every protocol-version-2 deletion uses the parent model.

### Aggregate ownership

The recoverable aggregate is:

```text
Workspace
├── Collections
│   └── Bookmarks in active, archived, or trashed buckets
└── Saved Groups
    └── Group Tabs
```

Tags remain account-global and are not deleted with a Workspace.

Deleting the Workspace changes only the root. A child may remain internally active while being effectively hidden because its Workspace is deleted. The parent state always wins for visibility:

| Workspace | Child state | Effective location |
|---|---|---|
| Active | Active | Normal current-Workspace view |
| Active | Archived or trashed | Current Workspace archive or content trash |
| Deleted | Any | Aggregated only under Workspace Manager |
| Terminal | Any | Not visible; removed locally |

### Core invariants

- `activeWorkspaceId` is empty only during initial bootstrap and otherwise always references an active Workspace.
- At least one active Workspace must exist. The last active Workspace cannot be deleted.
- Deleted Workspaces remain in the `workspaces` IndexedDB store and Zustand array.
- Content trash never includes content solely because its parent Workspace is missing or deleted.
- Restore clears only the Workspace tombstone; it never bulk-clears child lifecycle fields.
- A Workspace state `2` is irreversible.
- Only state `2` releases quota.

## Workspace Manager Information Architecture

Workspace management becomes an account-level surface opened from the Workspace Rail. It is available regardless of which Workspace is active.

The manager has two tabs:

- **In use**: active Workspaces, with create, switch, rename, recolor, and delete actions.
- **Deleted**: retained Workspaces, with restore and permanent-delete actions.

Each deleted card displays:

- Workspace name and color.
- Collection, Bookmark, and Saved Group counts.
- Deletion time.
- Remaining retention time for authenticated users.
- `Guest: not deleted automatically` for Guest sessions.
- `Still counts toward quota`.

The current Workspace's sidebar continues to contain Archive and Trash. That content Trash shows only Collections, Bookmarks, and Saved Groups whose own lifecycle places them in trash and whose `workspaceId` equals the active Workspace. Deleted Workspaces never appear there.

Ordinary deletion uses a confirmation dialog with aggregate counts, retention behavior, and the quota warning. Permanent deletion requires typing the Workspace name. Restore is a one-click action.

When only one active Workspace remains, Delete is disabled with: `Create or restore another Workspace first.` The server enforces the same invariant.

## Client Data and Store Design

### Workspace store

`WorkspaceState` adds:

- `restoreWorkspace(id)`.
- `permanentlyDeleteWorkspace(id)`.
- `getActiveWorkspaces()`.
- `getDeletedWorkspaces()`.

All Workspace Rail and selection consumers use active Workspaces. Quota counts use all locally retained Workspaces. `hydrate()` and `mergeFromServer()` choose `activeWorkspaceId` only from active Workspaces.

`deleteWorkspace()`:

1. Validates that more than one active Workspace exists.
2. Atomically writes `{ deletedAt, seq: 0 }`, a persistent `delete` lifecycle intent, and the replacement `activeWorkspaceId` to IndexedDB before updating state.
3. Does not call Group, Collection, or Bookmark deletion actions.
4. Selects the nearest active Workspace by position.
5. Requests lifecycle reconciliation; it does not enqueue a state `1` Workspace into the ordinary entity queue.

`restoreWorkspace()` atomically clears `deletedAt`, sets `seq: 0`, and persists a `restore` lifecycle intent. It then requests lifecycle reconciliation instead of putting an ordinary state `0` snapshot in the queue. The original position is retained. Position ties use the existing stable secondary ID ordering until a later explicit reorder normalizes positions.

`permanentlyDeleteWorkspace()` is push-first for authenticated sessions. It removes the card optimistically but does not delete local records until the server confirms. Failure restores the card. Guest sessions skip the server and run the local aggregate transaction immediately.

### IndexedDB aggregate deletion

State `2` pull handling and Guest permanent deletion use one transaction spanning:

- `workspaces`
- `collections`
- `bookmarks`
- `archived-bookmarks`
- `trashed-bookmarks`
- `groups`
- `group-tabs`
- `kv` for `activeWorkspaceId`, lifecycle intents, Guest provenance, migration markers, and the synchronized conflict-registry mutation

Collections already have a `workspaceId` index, and Bookmark buckets have `collectionId` indexes. IndexedDB is bumped from version 2 to version 3 to add a `workspaceId` index to `groups`, allowing the aggregate cleanup to find Group IDs and then delete Group Tabs through their existing `groupId` index without loading all stores into memory.

State cleanup must work even when archived or trashed Bookmark buckets have never been hydrated. It operates on IndexedDB first and then removes any loaded records from Zustand.

### Content trash scoping

The orphan fallback in `TrashContent` is removed. Deleted Collections are selected only with:

```text
collection.deletedAt && collection.workspaceId === activeWorkspaceId
```

Saved Groups already use the equivalent Workspace filter. Individual trashed Bookmarks are selected through Collections belonging to the active Workspace. No current-Workspace view infers ownership from a missing Workspace parent.

## Sync Protocol

### Wire model

Pull and push no longer share one ambiguous Workspace DTO. `ServerWorkspace` and the Go pull model add `is_deleted` and `deletion_model`. Sync push adds an optional top-level `protocol_version`; the new client sends version `2`. Its Workspace mutation DTO adds an optional `lifecycle_action` with the values `delete`, `restore`, and `purge`.

An ordinary version-2 Workspace create or metadata update omits `lifecycle_action` and never changes lifecycle state. A lifecycle transition is accepted only through the explicit action and the centralized Workspace lifecycle service. This prevents a stale client editing a name or position from accidentally restoring a deleted Workspace. State `1` rejects ordinary root updates with `workspace_deleted`; state `2` rejects every mutation with `permanently_deleted`.

Requests without `protocol_version=2` are legacy requests. An existing active Workspace with no `deleted_at` may receive metadata updates, but a legacy update can never restore state `1`. A legacy request with `deleted_at` invokes the server's atomic legacy-delete path described below. Presence-sensitive fields use dedicated push DTOs rather than non-pointer Go integers, so an omitted lifecycle field cannot be decoded as an intentional state `0` transition.

`SyncPullResponse` adds the optional capability `capabilities.workspace_parent_tombstone`. A new authenticated client enables Workspace delete, restore, and permanent delete only after receiving `true`. If an older self-hosted server omits the capability, those actions display an update-server requirement instead of falling back to the unsafe cascaded delete. Guest mode does not depend on a server capability.

The client persists the last observed capability in IndexedDB, keyed by user ID and normalized server origin. A previously confirmed `true` permits offline soft delete and restore after a browser restart. Permanent deletion still requires a live authenticated SyncEngine. A server-origin change, account change, database reset, or later authenticated response that omits or disables the capability invalidates the cached value.

Sync pull continues returning Workspace states `0`, `1`, and `2`. It also continues returning child entities under retained Workspaces during full synchronization, because a new device must store the hidden aggregate in order to restore it later. Normal REST and search endpoints apply active-parent visibility; sync is the recovery channel and must not filter retained descendants.

### Lifecycle intents and ordered reconciliation

Offline delete and restore write a versioned lifecycle-intent record in `kv`. Each intent contains `workspaceId`, `action`, `baseSeq`, `previousActiveWorkspaceId`, and `createdAt`. The record is committed in the same IndexedDB transaction as the local Workspace change. It survives restarts and provides enough information to distinguish an unconfirmed new Workspace from an already-confirmed parent and to roll back a late `last_active_workspace` rejection deterministically.

Lifecycle intents are not represented as ordinary queued Workspace snapshots. `SyncEngine` owns one serialized Workspace lifecycle executor on the same retirement/currentness boundary as push reconciliation and pull merging. The executor uses a confirmed-push primitive that returns the `SyncPushResponse`, processes structured rejections, and never treats HTTP 200 alone as confirmation. The existing direct `forcePush()` behavior is replaced or wrapped by this primitive so permanent-delete callers cannot ignore business rejections.

If an offline deletion includes descendant mutations that have not reached the server, synchronization preserves dependency order. When the server does not yet have the Workspace, the coordinator first creates it as state `0`; it then pushes and confirms all unsynced descendants while the server parent is active, and only then pushes the Workspace state `1` transition. When the server already has the Workspace, the coordinator flushes pending descendants before the parent transition. This prevents a parent tombstone from rejecting data that existed before deletion.

The ordinary queue may still collapse multiple snapshots for the same entity, so it is never used to represent both the active parent and its later lifecycle transition. Reconciliation explicitly executes and awaits the phases. `sweepAllUnsynced()` runs lifecycle reconciliation before normal store sweeps and excludes Workspaces with pending lifecycle intents from the ordinary Workspace payload.

Before an authenticated purge is sent, the executor drains relevant pending writes. After the terminal action is confirmed, it prunes the Workspace and all descendants from the live queue and from `tabslate-sync-recovery`, then performs aggregate cleanup. Queue pruning and recovery-snapshot pruning are idempotent. A root that has become terminal is also blocked from re-entry while cleanup is in progress.

After a server Workspace is retained, stale devices may no longer create or update any descendant. The server returns a structured `parent_deleted` rejection. The ordered reconciliation path succeeds because it keeps the server parent at state `0` until every descendant is confirmed; it does not create an exception to the retained-parent rule. A state `2` parent rejects every descendant write and every restore/update attempt.

### Merge behavior

For state `1`, `workspace-store.mergeFromServer()` inserts or updates and keeps the Workspace and its `deletedAt`. It never deletes the IDB row. If the active Workspace becomes retained remotely, the client selects another active Workspace.

A local `seq=0` delete or restore is a pending mutation. An older server state `0` cannot clear a pending local delete, and an older server state `1` cannot undo a pending local restore. A server acknowledgement of the same state replaces `seq=0` with the confirmed sequence. State `2` always overrides pending local state.

For state `2`, the Workspace merge path records the terminal ID before entering Zustand's pure updater. After state reconciliation, it executes aggregate IDB cleanup and removes the Workspace, Collections, Bookmarks, Saved Groups, and Group Tabs from any loaded state.

Aggregate cleanup uses `syncConflictRegistry.executeClearRootTransaction("workspace", id, ...)` so removal of local records, lifecycle intent, matching Guest provenance, and the root's descendant conflict tree commits under the registry's cross-context serialization boundary. Live and recovery queues are pruned before the transaction. The pull coordinator never advances `localSeq` until queue pruning, every store merge, aggregate cleanup, and all durable writes have completed.

The terminal parent tombstone represents the entire aggregate, so the server does not need to emit one terminal tombstone per child.

### Concurrency

- Explicit delete and restore actions below state `2` use server transaction order. Ordinary metadata LWW updates cannot transition lifecycle state.
- State `2` is terminal and cannot be overwritten by a later state `0` or `1` payload.
- Restore and automatic purge lock the Workspace row. A committed restore makes cleanup skip it; a committed purge makes restore return `permanently_deleted`.
- The server checks the final active-Workspace count inside the transaction. Concurrent deletions cannot reduce it below one.
- Child writes under a state `1` parent return `parent_deleted`; clients pull the parent and retain the rejected local mutation for reconciliation rather than retrying it indefinitely.

## Server Lifecycle Service

Workspace lifecycle logic is centralized in a server service used by Sync, REST handlers, and Cleanup. This avoids three independent interpretations of deletion.

### Soft delete

The service:

1. Locks the target Workspace and the user's active Workspace set.
2. Rejects deletion if it would leave no active Workspace.
3. Sets `is_deleted=1`, `deleted_at=now`, `updated_at=now`, and a new user sequence.
4. Leaves every descendant row unchanged.

### Restore

The service locks the Workspace, rejects state `2`, and sets `is_deleted=0`, `deleted_at=NULL`, `updated_at=now`, and a new sequence. It does not touch descendants or add quota usage because the retained aggregate never left quota.

### Permanent delete

Manual permanent deletion and automatic expiry call the same transaction:

1. Lock the state `1` Workspace.
2. Increment the user sequence once.
3. Set the Workspace to state `2`, with the new sequence and `updated_at=now`, and scrub its user-facing fields.
4. Delete descendant Bookmarks, Group Tabs, Saved Groups, and Collections in dependency-safe order.
5. Commit atomically.
6. Broadcast the sequence and asynchronously delete descendant Bookmark documents from MeiliSearch.

The minimal Workspace terminal row is retained until account deletion. It is the durable anti-resurrection ledger for the delta-sync protocol, contains no recoverable Workspace content, and does not participate in quota or normal reads. Cleanup Phase 2 continues handling existing child tombstones according to their protocol, but it never physically deletes Workspace state `2` rows independently of account deletion.

If any descendant deletion fails, the whole transaction rolls back and the Workspace remains recoverable in state `1`.

### Automatic expiry

Cleanup Phase 1 includes Workspaces with `is_deleted=1` whose age exceeds the same authoritative `trash_grace_days` returned for that user by the billing limits provider. OSS fallback configuration is resolved through that provider as well; Cleanup and `GET /api/plan` must not read independent retention values. Each candidate calls the permanent-delete transaction.

Authenticated clients never run a local expiry timer. The server is the only cleanup authority; offline devices learn the result through the next delta pull. Guest mode has no server and therefore no automatic expiry.

## Visibility and Search

Normal server reads require an active parent. Collection and Bookmark queries join through Workspace and require `w.is_deleted=0`. Saved Group reads require the same parent condition. Default Collection computation excludes retained Workspaces.

Direct access to a descendant of a retained Workspace returns not found to normal application routes. Sync pull remains the only exception because it must hydrate recoverable aggregates.

MeiliSearch is a derivative index. Workspace deletion asynchronously removes its Bookmark documents; restore asynchronously reindexes them. The search handler also validates candidate hits against PostgreSQL parent state before returning them. This database validation is mandatory, so an index delay or failed deletion cannot expose retained content. Reindex remains a repair mechanism rather than a correctness dependency.

Client-side views and global shortcuts apply the same active-parent rule. Favorites, Archive, SearchBox, SearchPanel, content-script search, import targets, popup save targets, and group selectors cannot use a retained Workspace or its Collections.

## Unified Quota Semantics

Every recoverable resource counts until permanent deletion:

- Workspaces: `is_deleted < 2`.
- Collections: `is_deleted < 2`.
- Bookmarks: `is_trashed < 2`.
- Saved Groups: `is_deleted < 2`.
- Tags: current behavior, because Tags have no trash lifecycle.

Creation guards, Sync push quota checks, `GET /api/plan`, and frontend optimistic usage all use the same definitions. Restoring a Workspace does not run a capacity check because it was already counted.

`GET /api/plan` keeps the existing total `usage` object and adds `trash_usage` with the same resource keys. `trash_usage` uses effective containment:

- A retained Workspace counts as a trashed Workspace.
- A Collection counts as trash if it is individually trashed or belongs to a retained Workspace.
- A Bookmark counts as trash if it is individually trashed, belongs to a trashed Collection, or belongs to a retained Workspace.
- A Saved Group counts as trash if it is individually trashed or belongs to a retained Workspace.
- Tags report zero trash usage.

The plan UI displays total usage and a breakdown such as `3 in use + 1 in recycle bin`. For every resource, `total = in use + recycle bin`. Archive remains in use rather than recycle bin.

Guest usage is derived locally with the same effective-containment rules.

## Failure Handling

- `last_active_workspace` rolls back the pending delete, restores the Workspace and persisted `previousActiveWorkspaceId`, clears the intent, and displays the action-specific message.
- A restore rejection leaves the Workspace in Deleted, clears only a rejected restore intent when the rejection is terminal, and displays the structured reason.
- Authenticated permanent deletion requires a working server connection. When offline, the action is disabled and no local data is removed.
- A purge is successful only when the root is absent from `SyncPushResponse.rejected`. Network failure or any rejection rolls back the optimistic card removal and retains all IDB data.
- Guest permanent deletion either commits the entire local transaction or changes nothing.
- Cleanup failures roll back and are retried on the next scheduled run.
- Search-index failure does not roll back canonical data; PostgreSQL result validation prevents visibility leaks.
- `parent_deleted` persists the local child mutation as a blocked conflict until the parent is restored or becomes terminal. `workspace_deleted` never restores the parent implicitly. `permanently_deleted` triggers authoritative aggregate cleanup. None of these deterministic outcomes enters an automatic retry loop.

`KnownSyncRejectionReason` and the server contract include `last_active_workspace`, `workspace_deleted`, `parent_deleted`, and `permanently_deleted`. Lifecycle-specific rejections are resolved before generic quota reconciliation records them.

All messages use Chrome i18n through `useTranslation`. Cross-screen notifications use the existing Alert pattern rather than custom pills.

## Legacy Migration

### Server migration

The schema migration adds `workspaces.is_deleted` and `workspaces.deletion_model` idempotently. It marks every existing `deleted_at IS NOT NULL` Workspace as state `1` with `deletion_model=0`; existing active Workspaces and all protocol-version-2 deletions use `deletion_model=1`. Successful legacy restoration changes the marker to `1`, so compatibility logic cannot run twice.

Authenticated clients set a one-time migration marker in `kv` and perform one full pull from sequence zero after upgrade. This is required because an older client may already have advanced `localSeq` past a Workspace tombstone that it then deleted locally.

The migration does not reset `localSeq` from inside a store. Once capability support is known, the existing `App.tsx` pull coordinator requests an authoritative pull with `after_seq=0`, performs Guest preparation, Workspace/Group/Bookmark merges, aggregate cleanup, conflict updates, and durable persistence in the existing serialized order, and only then commits the migration marker and returned `server_seq`. A failed or retired pull leaves the marker incomplete and retries later.

### Authenticated legacy restore

Existing deleted Workspace rows still retain their ID, name, color, and descendant foreign keys on the server. Legacy restore uses deletion time and sequence context to distinguish children tombstoned by the old Workspace cascade from children that were already individually trashed:

- A state `1` Collection or Saved Group is a cascade candidate when its confirmed sequence is greater than or equal to the legacy Workspace deletion sequence. Clearing the Collection tombstone retains `archived_at`, so previously archived Collections remain archived. Older independent tombstones remain trashed.
- A state `1` Bookmark under a candidate Collection is a cascade candidate when its sequence is greater than or equal to the Workspace deletion sequence. It returns to active. An older independently trashed Bookmark remains trashed.
- If sequence evidence is absent or contradictory, the migration keeps the child in trash rather than silently activating it. The Workspace can still be restored, and the user can restore that child explicitly from its content trash.

The legacy restore is one-time. After it succeeds, the Workspace uses the parent-only lifecycle for every future deletion.

The old implementation did not preserve whether a cascaded Bookmark came from the archived bucket. That information cannot be reconstructed reliably. Such Bookmarks restore as active, and the Workspace Manager shows a one-time localized notice explaining the limitation.

During the compatibility window, a legacy client deletion is not implemented by accepting unrestricted descendant writes beneath a retained parent. When a versionless request carries `deleted_at`, the server lifecycle service atomically marks the Workspace as `deletion_model=0` and applies the legacy Collection, Bookmark, and Saved Group cascade with one server sequence. Later legacy child pushes are idempotent or rejected; they are not required for correctness. A versionless metadata update against state `1` cannot restore it.

### Guest orphan recovery

Older Guest clients physically removed the Workspace record. On upgrade, the client groups orphan Collections and Saved Groups by their unresolved `workspaceId` and creates one synthetic retained Workspace per orphan ID. The synthetic Workspace keeps the original ID so all descendants remain attached, uses `Recovered Workspace` as its name, and uses the earliest child deletion time available.

Guest records have no confirmed server sequence with which to distinguish an old Workspace cascade from earlier individual trash actions. Restoring a synthetic Workspace therefore restores all of its recoverable legacy descendants to active, while retaining Collection archive metadata when available. The confirmation dialog and completion Alert disclose that some previously archived or individually trashed Bookmarks may return as active. This favors recoverability over silently leaving an apparently restored Workspace empty.

The user can restore, rename, or permanently delete the synthetic Workspace. An empty legacy Guest Workspace with no remaining children cannot be reconstructed, but it also contains no recoverable user content.

The migration is idempotent and records completion in the separate `guest-workspace-orphan-recovery-v1` key only after the IndexedDB transaction commits. Synthetic recovered Workspaces do not use `guest-workspace-provenance-v1`, which remains reserved for the single automatic Guest seed.

An automatically seeded Guest Workspace that is already deleted is never eligible for the existing quota-recovery migration into another confirmed Workspace. If the account has no Workspace capacity, the client keeps the entire deleted aggregate and its lifecycle intent locally, records a Workspace quota conflict, and offers only upgrade, permanent deletion of another Workspace, or later retry. Automatic reconciliation never flattens a deleted aggregate into another Workspace. When capacity exists, the lifecycle executor confirms the parent as active, confirms its unsynced descendants, and only then applies its pending delete intent.

## Testing and Acceptance Criteria

### Client unit and integration tests

- Deleting a Workspace changes only the Workspace record and `activeWorkspaceId`.
- Collections, active/archived/trashed Bookmarks, Saved Groups, and Group Tabs keep their exact IDs and lifecycle state.
- The last active Workspace cannot be deleted.
- Deleted Workspaces are absent from Rail, normal routes, search targets, popup targets, and content trash.
- Restore re-exposes the same aggregate without child writes or quota increments.
- State `2` aggregate cleanup deletes every relevant IDB record even when lazy Bookmark buckets were never hydrated.
- Aggregate cleanup also prunes live queue and session recovery snapshots and clears lifecycle, provenance, and descendant-conflict records.
- Guest deletion survives restart indefinitely and never schedules automatic cleanup.
- A deleted Guest seed rejected by Workspace quota remains intact and is never migrated into another Workspace.
- Authenticated offline permanent deletion does not remove local data.
- Offline delete and restore intents survive restart and reconcile in parent-before-children-before-tombstone order.
- A cached capability enables offline soft lifecycle actions only for the same user and server origin.
- The plan breakdown satisfies `usage = in use + trash_usage` for all resources.
- Legacy authenticated and Guest migrations are idempotent and preserve all recoverable content.

### Server tests

- Workspace state `1` retains descendants and remains counted by every quota path.
- Normal REST and search paths hide descendants of retained Workspaces; sync pull includes them.
- Restore does not create new quota usage.
- Concurrent deletion cannot remove the final active Workspace.
- Descendant mutations under a retained parent receive `parent_deleted`.
- State `2` remains as a scrubbed minimal terminal row until account deletion and rejects every stale restore or update, including after a device has been offline longer than the trash retention period.
- Versionless metadata updates cannot restore state `1`; versionless deletes execute the atomic legacy cascade.
- Manual purge and retention expiry execute the same atomic descendant deletion.
- A forced failure at each transaction step leaves the whole aggregate recoverable.
- Cleanup retains the scrubbed parent terminal tombstone until account deletion.
- Search index delays never make retained content visible through the API.

### End-to-end scenarios

- Device A deletes; Device B pulls, hides the aggregate, and switches Workspace.
- Device A restores; Device B receives the root change and re-exposes unchanged child states.
- Device A permanently deletes; Device B removes the entire local aggregate from every IDB store.
- An authenticated Workspace expires while a device is offline and disappears correctly on reconnect.
- A device offline beyond the retention period receives the permanent root tombstone and cannot resurrect the Workspace.
- A Guest Deleted Workspace survives browser restarts and disappears only after manual permanent deletion.
- A legacy authenticated Workspace and a synthetic Guest Recovered Workspace can both be restored.
- TypeScript compilation, production extension build, Go tests, and server race-sensitive lifecycle tests pass.

## Rollout

Deployment is server-first:

1. Deploy the backward-compatible server schema, Workspace state handling, sync capability, query isolation, quota definitions, and lifecycle service.
2. Run the legacy server classification migration and verify counts and orphan queries.
3. Deploy the client with Workspace Manager, parent-tombstone behavior, full-pull migration, and Guest orphan recovery.
4. Monitor Workspace restore/purge failures, `parent_deleted` rejections, cleanup counts, search validation drops, and quota discrepancies.
5. Remove legacy restoration code only after the supported client-upgrade window and retained legacy population have both elapsed.

Old clients remain able to push the existing `deleted_at` field. During the compatibility window, a versionless request that carries `deleted_at` invokes the server's atomic legacy cascade and records `deletion_model=0`; the server does not depend on later child pushes from that client. Versionless metadata updates preserve the current lifecycle state and cannot restore a retained Workspace. New clients require the server capability before enabling parent-only deletion, preventing a new client from creating a retained parent that an old server would mishandle.
