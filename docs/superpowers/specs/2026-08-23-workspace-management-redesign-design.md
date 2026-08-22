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

`deleted_at` remains the time the Workspace entered retention. `updated_at` records the latest transition and is the terminal-tombstone clock when state becomes `2`.

The client does not keep a separate permanent state in its normal `Workspace` model. `deletedAt` represents state `1`; a pulled state `2` record triggers local aggregate cleanup and is never persisted as a usable Workspace. The client keeps `deletionModel` only while a retained legacy Workspace still needs compatibility restoration; every new deletion uses the parent model.

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
2. Writes `{ deletedAt, seq: 0 }` to the Workspace in IndexedDB and state.
3. Does not call Group, Collection, or Bookmark deletion actions.
4. Selects the nearest active Workspace by position and persists `activeWorkspaceId`.
5. Enqueues only the Workspace state `1` representation.

`restoreWorkspace()` clears `deletedAt`, sets `seq: 0`, persists the root, and enqueues state `0`. The original position is retained. Position ties use the existing stable secondary ID ordering until a later explicit reorder normalizes positions.

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
- `kv` when `activeWorkspaceId` needs repair

Collections already have a `workspaceId` index, and Bookmark buckets have `collectionId` indexes. IndexedDB is bumped to add a `workspaceId` index to `groups`, allowing the aggregate cleanup to find Group IDs and then delete Group Tabs through their existing `groupId` index without loading all stores into memory.

State cleanup must work even when archived or trashed Bookmark buckets have never been hydrated. It operates on IndexedDB first and then removes any loaded records from Zustand.

### Content trash scoping

The orphan fallback in `TrashContent` is removed. Deleted Collections are selected only with:

```text
collection.deletedAt && collection.workspaceId === activeWorkspaceId
```

Saved Groups already use the equivalent Workspace filter. Individual trashed Bookmarks are selected through Collections belonging to the active Workspace. No current-Workspace view infers ownership from a missing Workspace parent.

## Sync Protocol

### Wire model

`ServerWorkspace` and the Go `model.Workspace` add `is_deleted` and `deletion_model`. `toServerWorkspace()` mirrors `toServerCollection()` and accepts an optional terminal-state override.

`SyncPullResponse` adds the optional capability `capabilities.workspace_parent_tombstone`. A new authenticated client enables Workspace delete, restore, and permanent delete only after receiving `true`. If an older self-hosted server omits the capability, those actions display an update-server requirement instead of falling back to the unsafe cascaded delete. Guest mode does not depend on a server capability.

Sync pull continues returning Workspace states `0`, `1`, and `2`. It also continues returning child entities under retained Workspaces during full synchronization, because a new device must store the hidden aggregate in order to restore it later. Normal REST and search endpoints apply active-parent visibility; sync is the recovery channel and must not filter retained descendants.

### Delete and restore ordering

Authenticated online delete and restore enqueue only the parent Workspace. Offline delete and restore write `seq=0`; `sweepUnsynced()` later pushes them.

If an offline deletion includes descendant mutations that have not reached the server, synchronization preserves dependency order. When the server does not yet have the Workspace, the coordinator first creates it as state `0`; it then pushes and confirms all unsynced descendants while the server parent is active, and only then pushes the Workspace state `1` transition. When the server already has the Workspace, the coordinator flushes pending descendants before the parent transition. This prevents a parent tombstone from rejecting data that existed before deletion.

After a server Workspace is retained, stale devices may no longer create or update any descendant. The server returns a structured `parent_deleted` rejection. The ordered reconciliation path succeeds because it keeps the server parent at state `0` until every descendant is confirmed; it does not create an exception to the retained-parent rule. A state `2` parent rejects every descendant write and every restore/update attempt.

### Merge behavior

For state `1`, `workspace-store.mergeFromServer()` inserts or updates and keeps the Workspace and its `deletedAt`. It never deletes the IDB row. If the active Workspace becomes retained remotely, the client selects another active Workspace.

A local `seq=0` delete or restore is a pending mutation. An older server state `0` cannot clear a pending local delete, and an older server state `1` cannot undo a pending local restore. A server acknowledgement of the same state replaces `seq=0` with the confirmed sequence. State `2` always overrides pending local state.

For state `2`, the Workspace merge path records the terminal ID before entering Zustand's pure updater. After state reconciliation, it executes aggregate IDB cleanup and removes the Workspace, Collections, Bookmarks, Saved Groups, and Group Tabs from any loaded state.

The terminal parent tombstone represents the entire aggregate, so the server does not need to emit one terminal tombstone per child.

### Concurrency

- Delete and restore below state `2` use server arrival order through the existing LWW timestamp model.
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
3. Set the Workspace to state `2`, with the new sequence and `updated_at=now`.
4. Delete descendant Bookmarks, Group Tabs, Saved Groups, and Collections in dependency-safe order.
5. Commit atomically.
6. Broadcast the sequence and asynchronously delete descendant Bookmark documents from MeiliSearch.

The Workspace terminal row remains for the fixed seven-day tombstone window. Cleanup Phase 2 physically deletes state `2` Workspace rows whose `updated_at` is older than that window. Descendants are already gone, so foreign-key actions cannot create orphans.

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

- Soft-delete failure restores the Workspace and previous `activeWorkspaceId`.
- Restore failure leaves the Workspace in Deleted and displays the structured reason.
- Authenticated permanent deletion requires a working server connection. When offline, the action is disabled and no local data is removed.
- Permanent-push failure rolls back the optimistic card removal and retains all IDB data.
- Guest permanent deletion either commits the entire local transaction or changes nothing.
- Cleanup failures roll back and are retried on the next scheduled run.
- Search-index failure does not roll back canonical data; PostgreSQL result validation prevents visibility leaks.
- Deterministic rejections such as `last_active_workspace`, `parent_deleted`, and `permanently_deleted` are not placed into automatic retry loops.

All messages use Chrome i18n through `useTranslation`. Cross-screen notifications use the existing Alert pattern rather than custom pills.

## Legacy Migration

### Server migration

The schema migration adds `workspaces.is_deleted` and `workspaces.deletion_model` idempotently. It marks every existing `deleted_at IS NOT NULL` Workspace as state `1` with `deletion_model=0`; existing active Workspaces and all future deletions use `deletion_model=1`. Successful legacy restoration changes the marker to `1`, so compatibility logic cannot run twice.

Authenticated clients set a one-time migration marker in `kv` and perform one full pull from sequence zero after upgrade. This is required because an older client may already have advanced `localSeq` past a Workspace tombstone that it then deleted locally.

### Authenticated legacy restore

Existing deleted Workspace rows still retain their ID, name, color, and descendant foreign keys on the server. Legacy restore uses deletion time and sequence context to distinguish children tombstoned by the old Workspace cascade from children that were already individually trashed:

- A state `1` Collection or Saved Group is a cascade candidate when its confirmed sequence is greater than or equal to the legacy Workspace deletion sequence. Clearing the Collection tombstone retains `archived_at`, so previously archived Collections remain archived. Older independent tombstones remain trashed.
- A state `1` Bookmark under a candidate Collection is a cascade candidate when its sequence is greater than or equal to the Workspace deletion sequence. It returns to active. An older independently trashed Bookmark remains trashed.
- If sequence evidence is absent or contradictory, the migration keeps the child in trash rather than silently activating it. The Workspace can still be restored, and the user can restore that child explicitly from its content trash.

The legacy restore is one-time. After it succeeds, the Workspace uses the parent-only lifecycle for every future deletion.

The old implementation did not preserve whether a cascaded Bookmark came from the archived bucket. That information cannot be reconstructed reliably. Such Bookmarks restore as active, and the Workspace Manager shows a one-time localized notice explaining the limitation.

### Guest orphan recovery

Older Guest clients physically removed the Workspace record. On upgrade, the client groups orphan Collections and Saved Groups by their unresolved `workspaceId` and creates one synthetic retained Workspace per orphan ID. The synthetic Workspace keeps the original ID so all descendants remain attached, uses `Recovered Workspace` as its name, and uses the earliest child deletion time available.

Guest records have no confirmed server sequence with which to distinguish an old Workspace cascade from earlier individual trash actions. Restoring a synthetic Workspace therefore restores all of its recoverable legacy descendants to active, while retaining Collection archive metadata when available. The confirmation dialog and completion Alert disclose that some previously archived or individually trashed Bookmarks may return as active. This favors recoverability over silently leaving an apparently restored Workspace empty.

The user can restore, rename, or permanently delete the synthetic Workspace. An empty legacy Guest Workspace with no remaining children cannot be reconstructed, but it also contains no recoverable user content.

The migration is idempotent and records completion in `kv` only after the IndexedDB transaction commits.

## Testing and Acceptance Criteria

### Client unit and integration tests

- Deleting a Workspace changes only the Workspace record and `activeWorkspaceId`.
- Collections, active/archived/trashed Bookmarks, Saved Groups, and Group Tabs keep their exact IDs and lifecycle state.
- The last active Workspace cannot be deleted.
- Deleted Workspaces are absent from Rail, normal routes, search targets, popup targets, and content trash.
- Restore re-exposes the same aggregate without child writes or quota increments.
- State `2` aggregate cleanup deletes every relevant IDB record even when lazy Bookmark buckets were never hydrated.
- Guest deletion survives restart indefinitely and never schedules automatic cleanup.
- Authenticated offline permanent deletion does not remove local data.
- The plan breakdown satisfies `usage = in use + trash_usage` for all resources.
- Legacy authenticated and Guest migrations are idempotent and preserve all recoverable content.

### Server tests

- Workspace state `1` retains descendants and remains counted by every quota path.
- Normal REST and search paths hide descendants of retained Workspaces; sync pull includes them.
- Restore does not create new quota usage.
- Concurrent deletion cannot remove the final active Workspace.
- Descendant mutations under a retained parent receive `parent_deleted`.
- State `2` rejects every stale restore or update.
- Manual purge and retention expiry execute the same atomic descendant deletion.
- A forced failure at each transaction step leaves the whole aggregate recoverable.
- Cleanup retains the parent terminal tombstone for the full synchronization window.
- Search index delays never make retained content visible through the API.

### End-to-end scenarios

- Device A deletes; Device B pulls, hides the aggregate, and switches Workspace.
- Device A restores; Device B receives the root change and re-exposes unchanged child states.
- Device A permanently deletes; Device B removes the entire local aggregate from every IDB store.
- An authenticated Workspace expires while a device is offline and disappears correctly on reconnect.
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

Old clients remain able to push the existing `deleted_at` field. During the compatibility window, a request that omits the new lifecycle fields and carries `deleted_at` is normalized to state `1` with `deletion_model=0`, because that client still cascades child tombstones. New clients require the server capability before enabling parent-only deletion, preventing a new client from creating a retained parent that an old server would mishandle.
