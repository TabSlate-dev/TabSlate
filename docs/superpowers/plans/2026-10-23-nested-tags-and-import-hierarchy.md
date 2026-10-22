# Nested Tags and Import Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five-level nested tags, descendant-aware filtering, hierarchy-preserving imports, and tag cleanup without losing bookmarks or breaking older clients.

**Architecture:** Store parent references on tags and use one pure tree module for every frontend surface. Validate the accepted graph inside the server's existing per-user sync transaction. Persist multi-entity mutations before publishing state or enqueueing sync, and retain pending deletions until acknowledgement; collections remain flat.

**Tech Stack:** TypeScript, React 19, Zustand, WXT, Bun tests with happy-dom, IndexedDB v3; Go, Gin, pgx, PostgreSQL 17+.

**Spec:** [2026-10-21-nested-tags-and-import-hierarchy-design.md](../specs/2026-10-21-nested-tags-and-import-hierarchy-design.md)

**Status:** Execution authorized on 2026-10-23: subagent-driven, in-place on a new branch from the current branch, no new worktree, commit after each task. The deletion collision policy was explicitly confirmed; requesting execution of this plan accepts its reviewed amendments, now reconciled into the source spec.

## Global Constraints

- “Collections stay one level deep. The hierarchy is added to tags only.”
- “At most five levels.” Root tags count as level one.
- “Unique among siblings, case-insensitively.” Compare trimmed names using the same case normalization in client and server; locale collation is for display order only.
- “Paths are displayed as `编程 › 后端 › Go`. `/` is only used for input.” Existing names containing `/` remain literal names until renamed.
- “Expansion is per device and does not sync.” Persist under IndexedDB `kv["tag-tree-expanded"]`.
- “Active, archived, and trashed bookmarks count, in every workspace, because tags are shared across workspaces.” This applies to merge and unused-tag cleanup, including retained workspaces.
- “The changes go out in one sync enqueue, split by B's byte-limited push chunks.” Preserve 900 entities and `384 * 1024` bytes per chunk; this is not a promise of one remote transaction.
- “New extension, old server”: omitted `parent_id` in pulls preserves the local hierarchy. “Old extension, new server”: omitted `parent_id` in writes preserves the stored hierarchy.
- “Deployment order. TabSlate-server, then TabSlate-cloud (build and test only), then the extension.” The actual local repository is `TabSlate-Cloud`.
- “Every new string is translated in English and Simplified Chinese with `[component]_[description]` keys, including the import root tag's name.” Use `useTranslation`; popup/background must not import application stores.
- Use Bun for frontend dependencies. Reuse existing test helpers, shadcn components, named exports, fine-grained selectors, and memoized derived data. No new dependency or IndexedDB version is needed.
- Do not add unrelated features, tag drag and drop, nested collections, import sources, or Markdown files outside the specification/plan workflow.

## Review Focus

1. A remote move to top level must clear a local parent, while an old server's omitted field must preserve it. Test in Tasks 2 and 4.
2. Moving a shallow root with a deep subtree must validate the deepest descendant; same-batch and concurrent parent edits must never commit a cycle. Test in Tasks 1–2.
3. Offline deletion/merge followed by restart or failure between sync chunks must retain every pending change without resurrection or loss of later chunks. Test in Tasks 3–5.
4. Deleting a parent into same-named siblings must preserve IDs and bookmark assignments using deterministic “ (2)” suffixes. Test in Tasks 1–3 and 7.
5. Deduplicated imports, slash-containing folder names, exhausted tag quota, and quota changes after preview must yield an accurate summary and no dangling bookmark tag IDs. Test in Tasks 9–10.

## Design Review and Amendments

The design's scope and component boundaries fit the repository. These concrete gaps need resolution as part of implementation; do not silently treat the original text as sufficient.

| Finding | Evidence and consequence | Planned resolution |
|---|---|---|
| P1: root-parent serialization is ambiguous | Spec §1 uses `*string` with `omitempty`; current pull and REST DTOs omit absent fields. Returning an omitted SQL NULL cannot communicate a remote move to root. | Keep nullable storage and optional request fields. New-server responses always emit `parent_id`, with `""` for root. Only omission from an old server means “preserve local.” |
| P1: deletion has no durable pending record | `workspace-store.deleteTag` deletes IDB immediately; `sweepUnsynced` only reads live state. An offline restart loses the deletion. | Persist `Tag { deletedAt, seq: 0 }` in `tags`, hide it from public `tags` state, sweep it from IDB, and remove it only after matching acknowledgement. Local tombstones dominate older live pulls. |
| P1: accepted-graph and chunk boundaries are unspecified | Spec §1 allows child-before-parent; current splitter retains input tag order and queue stops at first rejection. Validating a proposed parent that is later rejected admits an invalid child. | Validate against admitted, non-stale entities plus stored state, process graph dependencies deterministically, and topologically order live tag writes before splitting. Confirm earlier chunks and retain unattempted work on partial rejection. |
| P1: parent-rejection recovery lacks information | Current rejection callback receives accepted entities, and all non-stale typed rejections become persistent conflicts. The rejected move cannot be identified safely after a newer local edit. | Carry the attempted payload and a rejection `field`; recover only `type=tag, reason=invalid_field, field=parent_id` against an authoritative pull under the existing serialized/session-guarded resolution path. |
| P2: promotion can violate sibling uniqueness | Spec §1 deletes a parent by lifting children but does not define name collisions. | **User confirmed:** keep both tags; suffix promoted children “ (2)”, “ (3)”, etc., preserving IDs and bookmark assignments. Reserve names across the entire promotion before writing. |
| P2: quota text contradicts current lifecycle | Spec §5 says merged tags release quota only after permanent deletion. Tags have no permanent-delete UI; REST and push quota count `deleted_at IS NULL`, and current frontend deletion decrements immediately. | Retain the existing active-tag quota rule. Deletion/merge release local usage once, successful server tombstones release server usage, and server cleanup physically removes old tombstones later. No new tag lifecycle is introduced. |
| P2: import fallback omits Toby labels and external names | Toby labels still create tags; folder/label names can contain `/`, whitespace, or names exceeding REST's 50-character binding limit. | Budget existing mandatory Toby label creation first, then optional provenance tags. Fail preflight if mandatory labels cannot fit. Treat external names as literal segments; normalize new imported names as described in Task 10. Never parse exported names as typed paths. |
| P2: success action assumes a root always exists | Spec §4 permits no tags when quota is exhausted or the option is off. Selecting a nonexistent root would hide the imported bookmarks. | Show the root-filter action only when a root was actually committed. Otherwise report success without that action or the root-deletion hint. |

Additional implementation decisions: creating a path that already exists returns its leaf without a write; editing a tag into a same-named sibling fails inline. New or renamed segments have a 50-Unicode-code-point limit, matching the existing REST limit; unchanged longer legacy names remain usable. Existing duplicate or slash-bearing legacy names remain usable for color-only edits. A new child inherits its parent color; a new root uses the requested color. The edit dialog may explicitly recolor its edited tag.

## Repository and File Map

Paths below are relative to their named repository. Execute frontend commands in `/Users/lieutenant/Documents/github/TabSlate`; server commands in `/Users/lieutenant/Documents/github/TabSlate-server`; Cloud commands in `/Users/lieutenant/Documents/github/TabSlate-Cloud`.

| Area | Files and responsibility |
|---|---|
| Shared tree model | New `lib/tag-tree.ts`, `lib/tag-mutations.ts`, `lib/tag-counts.ts`; modify `lib/types.ts`, `lib/tag-name.ts`. Pure graph, mutation planning, and counts, respectively. |
| Durable tag operations | New `lib/tag-persistence.ts`; modify `store/workspace-store.ts`, `store/bookmarks-store.ts`, `lib/sync-confirmation.ts`, `lib/storage.ts`. Keep public workspace tags active-only. |
| Sync | Modify `lib/api.ts`, `lib/sync-recovery.ts`, `lib/sync-queue.ts`, `lib/sync-engine.ts`, `lib/sync-conflicts.ts`, `entrypoints/newtab/App.tsx`; new `lib/tag-sync-recovery.ts`. |
| UI | New `hooks/use-tag-tree.ts`, `hooks/use-tag-tree-expansion.ts`, `components/dashboard/shared/tag-tree-picker.tsx`, `components/dashboard/sidebar/tag-tree-row.tsx`, `tag-merge-dialog.tsx`, `unused-tags-dialog.tsx`. Modify existing tag surfaces and import dialog. |
| Import | New `lib/import-tags.ts`; modify `lib/import-types.ts`, `lib/import-chrome.ts`, `lib/import-toby.ts`, `components/dashboard/import-dialog.tsx`. |
| Server | Modify `db/schema.pg.sql`, `internal/model/model.go`, `internal/handler/tags.go`, `internal/handler/sync.go`; new `internal/handler/tag_hierarchy.go` and its tests. No Cloud product changes. |
| Documentation | Update existing `CLAUDE.md` and `ARCHITECTURE.md` in frontend and server. Update this spec's reviewed rules; create no additional Markdown files. |

Dependencies: Task 1 → Tasks 2–3; Tasks 2–3 → Task 4; Tasks 1 and 3 → Task 5; Tasks 1, 3, and 5 → Tasks 6–9; Tasks 1, 3–5, and 8–9 → Task 10. Execute in numbered order. Do not ship import/UI changes before the tag mutation and sync contracts pass.

## Test and Execution Conventions

- Before implementation, inspect each repository's current instructions/status and use `superpowers:using-git-worktrees` for isolation as appropriate. This documentation-only turn does not create worktrees, commit, or start implementation.
- Use `test/helpers/dom-environment.ts`, `createModuleReplacer`, and existing fixture factories. Tests that need process-global Bun module mocks follow `test/helpers/isolated-run.ts`; restore patched exports after each suite.
- Each test step below supplies named cases and concrete assertions. Add those tests, run the task command and observe the intended assertion/import failure, implement only that task, rerun until all pass, then commit the task's listed files. Do not count an unrelated setup error as a red test.
- Go handler tests use `openSyncTestDB`, `pushSync`, and `pullSync`. New integration test names must start with `TestTagHierarchy` or `TestSyncTagHierarchy` so the focused command executes them. They truncate tables: `TEST_DATABASE_URL` must name a dedicated disposable PostgreSQL database. A skipped database suite is not passing evidence.
- Add translations in the task that introduces the UI, rather than deferring functional text to a final cleanup task.

---

### Task 1: Define the Shared Tag Graph and Pure Mutation Plans

**Files:** Modify `lib/types.ts`, `lib/tag-name.ts`; create `lib/tag-tree.ts`, `lib/tag-mutations.ts`; create `test/tag-tree.test.ts`, `test/tag-mutations.test.ts`; modify `test/tag-name.test.ts` and `test/helpers/library-fixtures.ts`.

**Interfaces:**
- `Tag.parentId?: string`; canonical local root is `undefined`.
- `TagTree` exposes `tagsById: ReadonlyMap<string, Tag>`, `parentById: ReadonlyMap<string, string | undefined>`, `childrenByParent: ReadonlyMap<string | undefined, readonly string[]>`, `roots: readonly string[]`, and `locale: string`.
- `buildTagTree(tags: readonly Tag[], locale: string): TagTree`; exclude tombstones, treat missing/deleted parents as displayed roots, and break corrupt cycles deterministically by detaching the lexically smallest ID in each cycle **in the view only**. This guarantees termination without a migration.
- `tagAncestors(tree: TagTree, id: string): string[]`, `tagDescendants(tree: TagTree, id: string): Set<string>` (including self), `tagPath(tree: TagTree, id: string): Tag[]`, `displayTagPath(tree: TagTree, id: string): string`, `expandTagSelection(tree: TagTree, selected: readonly string[]): Set<string>`.
- `TagValidationError = "empty" | "empty_segment" | "duplicate" | "slash" | "too_long" | "depth" | "invalid_parent" | "cycle" | "missing"`; keep `tagNameError(name, takenNames)` compatible, adding `"slash"` and `"too_long"` to its result for new/renamed literal names. Export `MAX_TAG_NAME_LENGTH = 50` from `lib/tag-name.ts`; count with `Array.from(name).length`, not UTF-16 length. Preserve room for promotion/import suffixes within that limit.
- `resolveTagPath(tree: TagTree, input: string, parentId: string | undefined, rootColor: string, newId: () => string): TagPathResult`, a discriminated result `{ ok: true; leaf: Tag; created: Tag[] } | { ok: false; error: TagValidationError }`. New records use `seq: 0`.
- `planTagEdit(tree: TagTree, id: string, patch: Partial<Pick<Tag, "name" | "color" | "parentId">>): TagMutationPlanResult`; `planTagDeletion(tree: TagTree, ids: readonly string[], now: number): TagMutationPlanResult`; `planTagMerge(tree: TagTree, sourceId: string, targetId: string, now: number): TagMutationPlanResult`.
- `TagMutationPlan` has `upserts: Tag[]`, `tombstones: Tag[]`, `replacements: ReadonlyMap<string, string>`; `TagMutationPlanResult` is `{ ok: true; plan: TagMutationPlan } | { ok: false; error: TagValidationError }`. Merge maps every removed descendant to its surviving tag.
- `tagTargetError(tree: TagTree, sourceId: string, targetId: string | undefined, operation: "move" | "merge"): TagValidationError | null`; merge requires a real target, and simulates recursive child coalescing before checking depth.

- [ ] **Step 1: Write failing graph and mutation tests.** `path_reuses_siblings` creates `编程/后端/Go`, reuses differently cased siblings, returns only missing levels, and gives new children their parent's color. `depth_includes_subtree` rejects moving a three-level subtree under a level-four tag. `legacy_graph_is_finite` covers missing/deleted parents and A↔B cycles without mutating inputs. `delete_promotes_without_identity_loss` starts with root `Go`, root `Go (2)`, and `编程/Go`; deletion promotes the child as `Go (3)` with its original ID. Test two promoted names competing for the same suffix, case-insensitive collisions, relative creation, empty segments, literal legacy `/`, self/descendant targets, recursive merge, and deduplicated descendant expansion.

  Assertion anchor for `path_reuses_siblings` on an empty graph:
  ```ts
  let serial = 0;
  const result = resolveTagPath(buildTagTree([], "en"), "编程/后端/Go", undefined, "blue", () => String(++serial));
  if (!result.ok) { throw new Error(result.error); }
  expect(result.created.map(tag => [tag.name, tag.parentId])).toEqual([
    ["编程", undefined], ["后端", "1"], ["Go", "2"],
  ]);
  expect(result.leaf.id).toBe("3");
  ```
- [ ] **Step 2: Run the red tests.** `bun test test/tag-name.test.ts test/tag-tree.test.ts test/tag-mutations.test.ts` → failure for the missing helpers or behavior.
- [ ] **Step 3: Implement the interfaces.** Use `Intl.Collator(locale, { sensitivity: "base" })` plus ID tie-breaking for display; use language-independent normalized names for identity. Plan changes without writing IDB or calling a store. Allocate deletion suffixes in stable ID order after reserving unaffected sibling names. A path create may reuse its leaf; a rename/move may not create a sibling duplicate.
- [ ] **Step 4: Verify.** Rerun Step 2 → all cases pass, including frozen-input tests proving helpers are pure.
- [ ] **Step 5: Commit.** Stage the files listed above; `git commit -m "feat(tags): add shared hierarchy and mutation planning"`.

### Task 2: Add Server Parent Support and Transactional Graph Validation

**Files (server):** Modify `db/schema.pg.sql`, `internal/model/model.go`, `internal/handler/sync.go`, `internal/handler/tags.go`; create `internal/handler/tag_hierarchy.go`, `tag_hierarchy_test.go`, `tag_hierarchy_integration_test.go`; modify `internal/handler/sync_test.go`.

**Interfaces:**
- `model.Tag.ParentID *string` and `model.TagRequest.ParentID *string`, both `json:"parent_id,omitempty"` on requests. Nil means preserve on update, root on creation; `""` means explicit root; an ID means that parent. Response construction always supplies a non-nil pointer, normalizing stored NULL to `""`.
- `model.Rejected.Field string` with `json:"field,omitempty"`; hierarchy rejections use `reason:"invalid_field", type:"tag", field:"parent_id"`; invalid new/renamed literal names use `field:"name"`.
- `validateTagHierarchy(stored []model.Tag, incoming []model.Tag) []model.Rejected` is pure and validates proposed accepted changes against stored ownership-scoped state; its callers exclude candidates rejected by ownership, staleness, and quota first. REST shares the same graph and name validation.
- `promoteDeletedTagChildren(tags []model.Tag, deletedID string) []model.Tag` returns child changes with the Task 1 suffix algorithm; REST DELETE applies them and the parent tombstone in one transaction with one sequence.

- [ ] **Step 1: Add failing Go tests.** Test absent/empty/ID JSON round trips; explicit root in pull and GET/POST/PUT responses; migration twice preserving old records; child-before-parent in one request; rejected/quota-blocked parent not authorizing its child; a cross-user parent; self-parent; a same-request cycle; the depth of every existing descendant after a move. Test legacy slash names on color-only edits, sibling case collisions on create/move, ordinary tombstones, REST deletion promotion with `Go (3)`, and omitted-parent writes from an old client. A legacy DELETE must promote descendants too.

  `TestTagHierarchyRootIsExplicit`, after seeding one root tag:
  ```go
  response := pullSync(t, testDB, userID, 0)
  if len(response.Entities.Tags) != 1 { t.Fatal("expected one tag") }
  parent := response.Entities.Tags[0].ParentID
  if parent == nil || *parent != "" { t.Fatalf("root parent must be explicit: %v", parent) }
  ```
- [ ] **Step 2: Observe red.** In server: `go test ./internal/handler -run 'TestTagHierarchy|TestSyncTagHierarchy' -count=1 -v`. Run against the dedicated test database; expected assertions fail, not skip.
- [ ] **Step 3: Implement storage and validators.** Add `ALTER TABLE tags ADD COLUMN IF NOT EXISTS parent_id TEXT` without a foreign key. Query owned tags once inside the existing user-sequence transaction; overlay proposed writes and validate the resulting graph, excluding ownership/stale/quota rejections. Recompute dependent eligibility until no rejected entity is being used as a proposed parent; reject cyclic components and moves whose resulting subtree exceeds depth five. Do not reject a valid multi-edit final graph solely because an intermediate input order was invalid. Do not use a parent that a stale SQL upsert would fail to change. Reserve quota only for candidates that survive validation. Apply the 50-code-point name rule to new/renamed names, leaving unchanged legacy names alone. Serialize REST create/update/delete through the same per-user sequence boundary and use serializable isolation; return a retryable transaction error on serialization failure rather than committing an inconsistent graph.
- [ ] **Step 4: Implement request compatibility.** Omitted parent preserves storage; response root is always `""`. Grandfather unchanged legacy names and pre-existing sibling collisions; reject newly introduced collisions. SQL remains owner-scoped. Push tombstones do not require a valid parent and do not independently promote children: new clients send the complete planned changes. REST DELETE performs promotion for older callers. Preserve existing tombstone timestamp/retention safeguards.
- [ ] **Step 5: Verify.** Rerun Step 2; add a concurrent A→B/B→A test that allows serialization retry but proves only one conflicting move commits and the retried loser gets `invalid_field`. Run `go test ./...`, `go vet ./...`, `go build ./...` with non-skipped DB evidence.
- [ ] **Step 6: Commit.** Stage this task's server files; `git commit -m "feat(tags): validate and sync parent relationships"`.

### Task 3: Commit Tag Paths, Moves, and Deletions Durably

**Files:** Create `lib/tag-persistence.ts`, `test/tag-persistence.test.ts`, `test/workspace-tags.test.ts`; modify `lib/tag-mutations.ts`, `lib/api.ts`, `store/workspace-store.ts`, `lib/sync-confirmation.ts`, `lib/storage.ts` and the existing tag dialog/menu/picker/bulk handlers and locale feedback for mechanical async-result handling.

**Interfaces:**
- `TagActionResult = { ok: true; tagId?: string } | { ok: false; error: TagValidationError | "quota" | "stale" | "storage" }` in `lib/tag-mutations.ts`.
- New workspace action `createTagPath(input: string, color: string, parentId?: string): Promise<TagActionResult>`; retain `createTag(name: string, color: string): Promise<TagActionResult>` temporarily as a wrapper over `createTagPath`, then remove it once Tasks 7–9 migrate every caller. Mechanically await its result at existing creation call sites in this task; a synchronous `Tag` return cannot guarantee persistence-before-publication. The wrapper must not duplicate hierarchy or quota logic.
- `updateTag(id, patch: Partial<Pick<Tag, "name" | "color" | "parentId">>): Promise<TagActionResult>`; `moveTag(id, parentId: string | undefined): Promise<TagActionResult>`; `deleteTag(id): Promise<TagActionResult>`.
- `commitTagMutation(plan: TagMutationPlan, expectedTags: readonly Tag[]): Promise<void>` in `lib/tag-persistence.ts` compares the current active tag records with the caller's snapshot inside the same readwrite transaction, then writes all upserts/tombstones. A mismatch aborts with exported `TagMutationStaleError`; actions translate it to `error:"stale"`. No store import. Workspace public `tags` stays active-only. `sweepUnsynced` also reads persisted dirty tag tombstones.
- Workspace `restoreRejectedTagParent(id: string, attempted: SyncEntity, authoritative: Tag | undefined, isSessionCurrent?: () => boolean): Promise<void>` is guarded by current parent identity and the caller's session guard (wired in Task 4). For an absent live authoritative tag, preserve the local tag ID/name/color and bookmark references, clear only the rejected parent edge to root, and leave it dirty for creation/retry. An authoritative tombstone uses guarded deletion handling instead; do not confuse absence with a deletion acknowledgement.

- [ ] **Step 1: Add failing store tests.** A three-level path with capacity for only two creates zero tags and raises one quota alert; all-existing path returns its leaf without writes. Assert one transaction, one state update, and one enqueue for promotion; IDs and bookmark tag arrays remain unchanged. Test color-only edits of legacy slash tags, moving an orphan normalizing to its displayed parent, failed IDB writes publishing nothing, and stale target/name validation at execution time.

  `path_quota_is_atomic`, with an empty tag store and `max_tags=2`:
  ```ts
  const result = await useWorkspaceStore.getState().createTagPath("编程/后端/Go", "blue");
  expect(result).toEqual({ ok: false, error: "quota" });
  expect(useWorkspaceStore.getState().tags).toEqual([]);
  expect(await idbGetAll<Tag>("tags")).toEqual([]);
  expect(syncEnqueueCalls).toHaveLength(0);
  ```
- [ ] **Step 2: Observe red.** `bun test test/tag-persistence.test.ts test/workspace-tags.test.ts test/workspace-store.test.js` → the targeted new cases fail.
- [ ] **Step 3: Implement durable actions.** Resolve/validate the latest graph, reserve the whole path's quota, persist once, publish one workspace update, then enqueue once outside Zustand updaters. Recheck graph/quota after awaited work; serialize local tag mutations and compare the durable snapshot to detect popup/other-newtab changes. Keep `seq:0` for every changed live tag and tombstone. Store errors return `storage` without closing a dialog as if it saved. Mechanically update existing create/edit/delete handlers and picker/bulk creation callbacks to await the result; their hierarchy UI remains Tasks 7–8. Add only the pending/error feedback needed to preserve form input and prevent false success. `hydrate`/popup readers filter tombstones, and `mergeFromServer` preserves a newer pending local mutation rather than resurrecting it.
- [ ] **Step 4: Implement deletion recovery.** Matching accepted tombstones remove the durable pending record; late acknowledgements never delete newer edits. For a never-synced tag deleted while its create may be in flight, retain the deletion until authoritative absence or tombstone is confirmed. Expose a guarded settlement action for existing server `invalid_state` on an unknown deleted tag; unit-test settlement only after authoritative absence. Task 4 owns the rejection callback and authoritative fetch integration; never create a retry loop. Local usage decrements once on deletion, excludes hidden tombstones, and server quota rejections still refresh usage.
- [ ] **Step 5: Verify restart behavior.** Add `offline_delete_survives_hydrate`, `older_pull_does_not_resurrect`, `create_delete_race_settles`, and `late_ack_keeps_newer_parent`; rerun Step 2 → pass. Ensure old unrelated workspace lifecycle tests continue to pass.
- [ ] **Step 6: Commit.** Stage this task's files; `git commit -m "feat(tags): persist atomic hierarchy mutations and pending deletions"`.

### Task 4: Preserve Parent Intent Through Sync, Rejections, and Chunking

**Files:** Modify `lib/api.ts`, `lib/sync-confirmation.ts`, `lib/sync-recovery.ts`, `lib/sync-queue.ts`, `lib/sync-engine.ts`, `lib/sync-conflicts.ts`, `lib/sync-engine-runtime.ts`, `entrypoints/newtab/App.tsx`, `store/workspace-store.ts`; create `lib/tag-sync-recovery.ts`, `test/tag-sync.test.ts`; modify `test/sync-confirmation.test.ts`, `test/sync-recovery.test.js`, `test/sync-queue.test.js`, `test/sync-engine-ordering.test.js`.

**Interfaces:**
- `ServerTag.parent_id?: string | null` (incoming null explicitly means root); add `invalid_field` and optional `SyncRejected.field?: string` to the existing wire types/guards without treating other errors as hierarchy recovery.
- Extend engine `OnPushSuccess(resp, confirmedPayload, attemptedPayload: SyncPushPayload): Promise<string | null>`; queue callbacks provide all attempted chunks, while accepted confirmations exclude rejections. Update all call sites, including `forcePush` and runtime drivers.
- `reconcileRejectedTagParents(response: SyncPushResponse, attempted: SyncPushPayload, authoritative: SyncPullResponse, isCurrent: () => boolean): Promise<void>` in `lib/tag-sync-recovery.ts` delegates durable restoration to Task 3. Capture only parent-field rejections; restore only if the live local parent still equals the rejected payload's parent. A newer rename/color stays dirty and is re-enqueued with the restored parent.
- `toServerTag` always emits `parent_id: tag.parentId ?? ""`. Both IDB and memory acknowledgement predicates include normalized parent identity.

- [ ] **Step 1: Add failing compatibility tests.** `omission_preserves_local_parent` keeps local `parentId=p` after an old-server pull; `empty_parent_clears_it` removes it after `parent_id:""`. `late_ack_cannot_confirm_new_move` leaves `seq=0` after a previous parent's acknowledgement. `rejected_move_restores_only_attempt` restores A's old parent, preserves a later local parent edit and later name/color edits, and creates no persistent hierarchy conflict. Recover using a full authoritative pull even when the rejected tag is absent from the normal delta; never advance the pull checkpoint through this auxiliary fetch.

  Assert after `late_ack_cannot_confirm_new_move`, whose current parent is `new-parent`:
  ```ts
  const current = useWorkspaceStore.getState().tags.find(tag => tag.id === "moving");
  expect(current?.parentId).toBe("new-parent");
  expect(current?.seq).toBe(0);
  ```
- [ ] **Step 2: Observe red.** `bun test test/tag-sync.test.ts test/sync-confirmation.test.ts test/sync-recovery.test.js test/sync-queue.test.js test/sync-engine-ordering.test.js` → the new assertions fail.
- [ ] **Step 3: Implement serialization and reconciliation.** Consume Task 3's durable mutation support. Reconcile within the engine's existing serialized boundary; check session/engine identity after awaits. Exempt recognized parent-field rejections from persistent conflicts; also handle `type=tag, reason=invalid_state` for a matching dirty tombstone by fetching authoritative data and using Task 3's guarded absence/tombstone settlement. Name/other validation failures remain inspectable. If authoritative data cannot be fetched, retain the local dirty record and retry recovery; do not pretend convergence succeeded.
- [ ] **Step 4: Implement dependency-safe chunking.** Order tag creations/updates by final parent dependencies and deterministic ID ties; keep byte/entity limits for both ordinary queue and `forcePush`. Preserve earlier successful chunks in confirmations when a later chunk rejects, and pass unattempted chunks through onUnsent to mark still-matching records seq=0, then discard those raw chunks; rebuild payloads from current local state through the coordinated pull and sweep. A rejected parent must not cause children to be marked confirmed or discarded. Use tombstones first and dependency-aware live updates to replay actual promotion/merge plans. When tags must span chunks, fetch an auxiliary authoritative tag graph within the serialized/session boundary and use a pure safe-order/packing helper that validates each intermediate batch. A stored A→B→C→D→E chain plus X can receive valid E-to-root (or shallow Y) then A-under-X actions; coalescing must not send A before E and create a false depth-six rejection. Keep coupled updates together within existing limits; an inseparable oversized group retains pending data with a recoverable ordering error. Sync tombstones do not promote children; REST DELETE does. Add no persistent history or protocol metadata and do not promise remote atomicity across chunks.
- [ ] **Step 5: Verify partial failures.** Add and run `parent_precedes_child_across_900_boundary`, `parent_precedes_child_across_byte_boundary`, `rejection_keeps_prior_acks_and_later_work`, and `merge_restarts_between_chunks`. Assert exact retained entities, no stale acknowledgement, and one eventual converged graph after replay. Rerun Step 2 → all pass.
- [ ] **Step 6: Commit.** Stage this task's sync files and tests; `git commit -m "fix(tags): preserve hierarchy intent across sync recovery"`.

### Task 5: Merge Tags Across Buckets and Delete Unused Subtrees

**Files:** Modify `store/workspace-store.ts`, `store/bookmarks-store.ts`, `lib/tag-persistence.ts`; create `test/tag-cleanup.test.ts`, `test/bookmark-tag-replacement.test.ts`; create `lib/tag-counts.ts` and `test/tag-counts.test.ts`.

**Interfaces:**
- `mergeTag(sourceId: string, targetId: string): Promise<TagActionResult>` and `deleteUnusedTags(): Promise<TagActionResult>` are workspace actions.
- `unusedTagIds(tree: TagTree, bookmarks: readonly Bookmark[]): Set<string>` and `countTagUsage(tree: TagTree, bookmarks: readonly Bookmark[]): Map<string, number>` in `lib/tag-counts.ts`; each bookmark contributes at most once to each ancestor.
- Extend `commitTagMutation(plan: TagMutationPlan, expectedTags: readonly Tag[]): Promise<CommittedTagMutation>` to apply `plan.replacements`. `CommittedTagMutation` contains `tags: Tag[]` and `bookmarks: BookmarkBucketChanges`; `BookmarkBucketChanges` has changed `active`, `archived`, and `trashed` arrays of bookmarks. Define both interfaces in `lib/tag-persistence.ts`; the previous task's callers may ignore the returned changes.
- Bookmark store `applyTagReplacementChanges(changes: BookmarkBucketChanges, replacements: ReadonlyMap<string, string>): void` updates active entries, only already-loaded archive/trash arrays, and selected tags in one `set`; it performs no IDB write or enqueue. Workspace coordinator assembles one payload for changed tags/bookmarks. Bookmark wire mapping must preserve bucket flags, optional notes/covers, and `edited_at`.

- [ ] **Step 1: Add failing merge tests.** With A→B and A/Docs→B/Docs, assert both replacement IDs are applied to active, archived, and trashed bookmarks across two workspaces, duplicate target IDs collapse, untouched tag order stays stable, and selected A/Docs follows the surviving child. Test target-as-ancestor, target-as-descendant rejection, and depth after recursive coalescing. Assert one IDB transaction and one sync enqueue.

  In `unloaded_archive_is_updated_without_hydration`, archived `archived-b` initially carries A:
  ```ts
  await useWorkspaceStore.getState().mergeTag("A", "B");
  expect((await idbGet<Bookmark>("archived-bookmarks", "archived-b"))?.tags).toEqual(["B"]);
  expect(useBookmarksStore.getState()._archivedLoaded).toBe(false);
  expect(useBookmarksStore.getState().archivedBookmarks).toEqual([]);
  expect(syncEnqueueCalls).toHaveLength(1);
  ```
- [ ] **Step 2: Observe red.** `bun test test/tag-cleanup.test.ts test/bookmark-tag-replacement.test.ts test/tag-counts.test.ts` → failure for missing cleanup behavior.
- [ ] **Step 3: Implement atomic replacement.** Read affected persisted buckets and perform replacements within the same readwrite transaction as tag changes, using IndexedDB request callbacks; do not await inside an IDB transaction callback. Revalidate source/target and changed graph before committing. Snapshot/revision guards must prevent a bookmark edited during preparatory awaits from being overwritten. Apply changed loaded records by ID, preserving unrelated state. Do not set loader flags or load archive/trash just to merge; changed unloaded buckets stay IDB-only. Set user edit time only for bookmarks whose tag IDs actually change.
- [ ] **Step 4: Implement unused cleanup.** Explicitly await both existing archive/trash loaders, compute all-workspace usage including descendants, and recompute on confirmation so a tag newly used after opening the dialog survives. Tombstone the complete unused set in one mutation; no promotion is needed for that set. Remove deleted IDs from selected filters and decrement tag usage by the actual removed count exactly once.
- [ ] **Step 5: Verify.** Add loaded/unloaded permutations, an IDB rollback case, a concurrent bookmark edit, and an unused parent used only through a trashed descendant in another workspace. Assert loader flags remain unchanged during merge and become loaded only through the cleanup loaders. Rerun Step 2 → pass.
- [ ] **Step 6: Commit.** Stage this task's files; `git commit -m "feat(tags): merge tag trees and remove unused tags"`.

### Task 6: Apply Descendant Filters, Counts, and Full Paths

**Files:** Create `hooks/use-tag-tree.ts`; modify `store/bookmarks-store.ts`, `components/dashboard/content.tsx`, `favorites-content.tsx`, `bookmark-card.tsx`, `archive-content.tsx`, `trash-content.tsx`, `components/ui/tag-list.tsx`, `components/dashboard/shared/active-filter-chips.tsx`; modify `test/library-visible-filters.test.tsx`, `test/tag-counts.test.ts`; create `test/tag-path-display.test.tsx`.

**Interfaces:**
- `useTagTree(): TagTree` selects raw tags and current language separately and memoizes `buildTagTree`. It does no derived work inside a store selector.
- Extend `getFilteredBookmarks(workspaceCollectionIds: Set<string>, expandedTagIds?: ReadonlySet<string>): Bookmark[]`. Undefined preserves existing direct selected-ID behavior for old callers/tests. An empty selection means no tag constraint; a nonempty selection expanding to an empty set matches nothing. Both library and Favorites pass Task 1's expanded selection.
- `TagListProps.pathByTagId?: ReadonlyMap<string, string>` supplies full-path tooltip/accessibility text while visible chips keep the leaf name. Callers build paths from the complete tag graph, never from just a bookmark's assigned tags.

- [ ] **Step 1: Add failing tests.** Selecting a parent matches a child-only bookmark in library and Favorites; several selections use OR; a bookmark tagged parent and child counts once. An active-workspace count excludes hidden/archived collections and other workspaces. Moving a tag updates results without changing selected IDs. Full paths render on active, archive, and trash chips; filter chips show truncated paths with full tooltip text.

  In `parent_filter_matches_child`, with selected parent `p` and bookmark `child-bookmark` carrying only `c`:
  ```ts
  const ids = useBookmarksStore.getState().getFilteredBookmarks(new Set(["collection"]), new Set(["p", "c"]));
  expect(ids.map(bookmark => bookmark.id)).toEqual(["child-bookmark"]);
  expect(countTagUsage(tree, [childBookmark, parentAndChildBookmark]).get("p")).toBe(2);
  ```
- [ ] **Step 2: Observe red.** `bun test test/library-visible-filters.test.tsx test/tag-counts.test.ts test/tag-path-display.test.tsx` → new hierarchy assertions fail.
- [ ] **Step 3: Implement the interfaces.** Memoize expanded IDs with tree and selection dependencies. Keep bookmark store independent of workspace store. Pass current language to collation, preserve existing collection/type/search filters, stop card tag clicks from opening/selecting the card, and reuse the existing Tooltip component for mouse and keyboard access.
- [ ] **Step 4: Verify.** Rerun Step 2 → pass, including workspace switching and tag changes while a parent is selected. Confirm all `TagList` call sites receive complete-path data where tags are displayed.
- [ ] **Step 5: Commit.** Stage this task's files; `git commit -m "feat(tags): filter descendants and display full tag paths"`.

### Task 7: Build the Sidebar Tree and Hierarchy Dialogs

**Files:** Create `hooks/use-tag-tree-expansion.ts`, `components/dashboard/sidebar/tag-tree-row.tsx`, `tag-merge-dialog.tsx`, `unused-tags-dialog.tsx`, `components/dashboard/shared/tag-tree-picker.tsx`; modify `components/dashboard/sidebar/tags-section.tsx`, `tag-dialog.tsx`, `tag-delete-dialog.tsx`, both locale files; modify `test/sidebar-tags-section.test.tsx`, `test/sidebar-tag-menu.test.tsx`, `test/tag-dialog.test.tsx`; create `test/tag-tree-picker.test.tsx`.

**Interfaces:**
- `TagTreePickerProps { tree: TagTree; value: string | undefined; onChange: (parentId: string | undefined) => void; disabledReason: (tagId: string | undefined) => string | undefined; includeTopLevel?: boolean; label: string }`. Root is a distinct row ID, not an empty tag ID. Move/parent selection includes root; merge excludes root.
- Tag dialog consumes all tags, optional `initial?: Tag`, `initialParentId?: string`, and `onSubmit(input: { name: string; color: string; parentId?: string }): Promise<TagActionResult>`. It stays open on failed validation/quota/storage and prevents double submit.
- `useTagTreeExpansion(tree, selectedIds, query)` returns `{ expandedIds: ReadonlySet<string>; toggle: (id: string) => void }`; IDB stores `{ key:"tag-tree-expanded", value:string[] }`. Search and selected-ancestor expansion are derived overlays; they do not overwrite manually persisted choices.

- [ ] **Step 1: Add failing sidebar tests.** Roots start collapsed; manual expansion survives unmount/remount; a selected nested tag becomes visible. Search displays only matching tags and ancestors with highlighted substrings, expands their path, and Esc/× leaves selection unchanged. Expansion arrow clicks never toggle selection. Missing stale expansion IDs are harmless, and a late IDB read cannot overwrite a click made during hydration.

  After selecting nested `go` in `selected_descendant_expands_ancestors`:
  ```ts
  expect(getBySelector('[data-tag-id="go"]').getAttribute("aria-pressed")).toBe("true");
  expect(useBookmarksStore.getState().selectedTags).toEqual(["go"]);
  ```
- [ ] **Step 2: Observe red.** `bun test test/sidebar-tags-section.test.tsx test/sidebar-tag-menu.test.tsx test/tag-dialog.test.tsx test/tag-tree-picker.test.tsx` → hierarchy expectations fail.
- [ ] **Step 3: Implement shared picker and dialogs.** Use Task 1 target validation to disable self, descendants, sibling collisions, and over-depth moves. Support keyboard search/navigation, announce disabled reasons, and keep expansion and row selection as sibling buttons rather than nested buttons. Creating `后端/Go` under `编程` calls `createTagPath`; editing submits one combined name/color/parent patch. Recheck execution-time validity rather than trusting an open dialog's snapshot.
- [ ] **Step 4: Implement rows and menus.** Preserve tags-section collapse and the one-second edit tooltip. Add New child, Move, Merge, and the header cleanup menu. Merge confirmation shows direct affected bookmark count across all buckets and descendant replacements; while loading counts, disable confirmation. Delete confirmation shows immediate promoted-child count and proposed collision renames. Unused confirmation lists at most ten full paths and the remainder count, disabled at zero. Call async actions with pending/error state; close only after success.
- [ ] **Step 5: Verify and translate.** Add tests for `aria-pressed`, separately labeled `aria-expanded`, keyboard target activation, disabled target attempts, child creation at depth five, merge confirmation, zero-unused state, and “ (2)” promotion preview. Rerun Step 2 → pass in both locale fixtures; new copy uses i18n placeholders.
- [ ] **Step 6: Commit.** Stage this task's UI/hook/tests/locale changes; `git commit -m "feat(tags): add sidebar hierarchy and cleanup dialogs"`.

### Task 8: Share Path Search and Creation in Form and Bulk Pickers

**Files:** Modify `lib/tag-tree.ts`, `components/dashboard/shared/filterable-list.tsx`, `tag-picker.tsx`, `components/dashboard/bulk-actions/tags-menu.tsx`, both locale files; modify `test/filterable-list.test.tsx`, `test/tag-picker.test.tsx`, `test/bulk-tags-menu.test.tsx`, `test/bulk-tags.test.ts`.

**Interfaces:**
- `searchTagPaths(tree: TagTree, query: string): Tag[]` matches any path segment, prioritizes exact leaf-name matches, then sorts by full path with the tree's collation. Slash-separated input matches corresponding path segments; existing literal-slash legacy tags remain searchable by their literal name.
- Add optional `matchesQuery?: (item: T, query: string) => boolean` and `hasExactMatch?: (query: string) => boolean` to `FilterableListProps<T>`; defaults preserve collection-picker behavior. A path-aware caller controls creation eligibility instead of comparing `›` display text with `/` input.
- TagPicker continues `value/onChange`; async path creation appends only the returned leaf ID. Bulk uses the same search/create helpers but checkbox states remain direct tag assignment only.

- [ ] **Step 1: Add failing tests.** Query `Go` ranks exact leaves before path-only matches, distinguishes identical leaves by full path, and `编程/后端/Go` resolves existing levels. An exact leaf match prevents a duplicate create offer; a genuinely missing path offers creation. Selected chips show leaf names plus path tooltips. Checking a parent in the bulk menu adds only its ID. Failed multi-level quota creation changes no tag selection.

  Keep this direct-assignment assertion in `bulk_parent_does_not_assign_descendants`:
  ```ts
  const patches = bulkTagPatches([makeBookmark("b", { tags: [] })], new Map([["parent", "checked"]]));
  expect(patches).toEqual([{ id: "b", patch: { tags: ["parent"] } }]);
  ```
- [ ] **Step 2: Observe red.** `bun test test/filterable-list.test.tsx test/tag-picker.test.tsx test/bulk-tags-menu.test.tsx test/bulk-tags.test.ts` → new path assertions fail.
- [ ] **Step 3: Implement search and picker changes.** Preserve FilterableList's IME, Escape, Backspace, and Cmd/Ctrl+Enter handling. Bulk idle rows use an indented pre-order tree; filtered rows retain path context. Both create from top level via `createTagPath`, inherit colors through Task 1, disable duplicate submission, and keep the query on failure. Migrate callers off temporary `createTag`.
- [ ] **Step 4: Verify.** Rerun Step 2 → all pass, including existing collection-picker default filtering and three-state bulk checkbox tests.
- [ ] **Step 5: Commit.** Stage this task's files; `git commit -m "feat(tags): support paths in bookmark and bulk tag pickers"`.

### Task 9: Make Popup Hierarchy Creation Store-Free and Quota-Aware

**Files:** Modify `lib/storage.ts`, `lib/tag-persistence.ts`, `entrypoints/popup/App.tsx`, both locale files; create `test/popup-tags.test.tsx`, `test/storage-tags.test.ts`; modify `test/popup-save-ack.test.tsx`.

**Interfaces:**
- `storageService.addTagPath(input: string, color: string): Promise<TagActionResult>` re-reads persisted active tags, resolves from root, validates depth/names, and writes all new levels in one transaction. Remove/replace popup's old `addTag` call.
- Extract the tag-capacity read needed by popup into a store-free storage helper in `lib/storage.ts`: `readTagCapacity(): Promise<{ limit: number }>` using `chrome.storage.local["tabslate-plan"]`'s Zustand JSON `state.limits.max_tags`. Absent limits and `-1` both allow local creation, matching `usePlanStore.checkQuota`; the server remains authoritative. Check the whole path against the current active IDB tag count in the write transaction, excluding pending tombstones. No new popup network or authentication flow is needed.
- Existing `WORKSPACE_CHANGED` notifies newtabs after successful creation; popup receives the final leaf ID and reloads available tags.

- [ ] **Step 1: Add failing tests.** Full-path suggestions share Task 8 ordering; Enter selects the first suggestion; no suggestion creates a complete path. Simultaneous popup path creation reuses one sibling set. Insufficient capacity creates no partial levels or selected ID. Verify `WORKSPACE_CHANGED` only follows successful writes, no application store module is loaded, and bookmark save acknowledgement behavior stays intact.

  In `popup_path_quota_is_atomic`, with an empty IDB and cached limit 2:
  ```ts
  expect(await storageService.addTagPath("编程/后端/Go", "blue")).toEqual({ ok: false, error: "quota" });
  expect(await idbGetAll<Tag>("tags")).toEqual([]);
  ```
- [ ] **Step 2: Observe red.** `bun test test/storage-tags.test.ts test/popup-tags.test.tsx test/popup-save-ack.test.tsx` → new tests fail.
- [ ] **Step 3: Implement popup integration.** Reuse pure tree/path/name helpers, filter durable tombstones from `getWorkspaceState`, and render pending/inline error states. Make the popup quota message local and translated; no QuotaAlert/store mount is available here. On a snapshot mismatch, re-read and resolve once so concurrent creation can reuse newly created levels; a second mismatch returns `stale` without partial writes. Validate against the transaction's current records, not the list loaded when the popup opened.
- [ ] **Step 4: Verify.** Rerun Step 2 → pass. Check guest, verified-online, cached/offline, and Firefox account-consent-denied cases; no forbidden network request is sent. Remove temporary frontend `createTag` once an `rg` call-site audit proves all production callers migrated.
- [ ] **Step 5: Commit.** Stage this task's files; `git commit -m "feat(tags): create nested tag paths from the popup"`.

### Task 10: Preserve Import Folders, Budget Tag Trees, and Reveal Results

**Files:** Create `lib/import-tags.ts`, `test/import-chrome.test.ts`, `test/import-toby.test.ts`, `test/import-tags.test.ts`, `test/import-dialog.test.tsx`; modify `lib/import-types.ts`, `lib/import-chrome.ts`, `lib/import-toby.ts`, `store/workspace-store.ts`, `components/dashboard/import-dialog.tsx`, both locale files.

**Interfaces:**
- Extend parsed Chrome items with `folderPath: string[]` relative to their allocated collection; direct collection bookmarks use `[]`. Preserve existing root-folder skipping, collection creation/name allocation, safe-URL checks, and exact-URL duplicate behavior.
- Add `ImportTagOptions { enabled: boolean; rootName: string; existingTags: readonly Tag[]; availableTags: number }`; `-1` means unlimited. Capture localized source/date `rootName` once per import configuration, using the user's local calendar date in `YYYY-MM-DD` form.
- Append `tagOptions?: ImportTagOptions` after existing builder parameters to preserve old call signatures. Omission means prior behavior for existing direct callers; ImportDialog always supplies the enabled-by-default option.
- Extend `ImportPlan` with optional `provenance?: { rootTagId?: string; mode: "full" | "root-only" | "none"; requestedTagCount: number }`. `tags` already carries parent references through `Tag`; do not introduce a second tag DTO.
- `addImportTags(plan: ImportPlan, source: "chrome" | "toby", pathsByBookmarkId: ReadonlyMap<string, readonly string[]>, options: ImportTagOptions): ImportPlan` in `lib/import-tags.ts` is pure and shares Task 1 path/identity helpers.
- `importFromPlan(plan: ImportPlan): Promise<ImportCommitResult>` where result is `{ ok: true; collectionsCreated: number; bookmarksImported: number; tagsCreated: number; rootTagId?: string } | { ok: false; error: "quota" | "target_unavailable" | "stale_plan" | "storage" }`. Revalidate at commit; if preview decisions need changing, return `stale_plan` so the user sees the new summary before importing.

- [ ] **Step 1: Add failing parser/plan tests.** A bookmark under `书签栏/开发/前端/React` retains collection `开发` and path `前端/React`; resulting tag path is `Chrome import 2026-10-21 › 开发 › 前端 › React`. Direct root-folder bookmarks keep their existing root-named collection. Cover empty folders, duplicate collection names “ (2)”, sibling folders sharing a tag, invalid URLs, skipped duplicates, and depth beyond five mapping to the level-five ancestor. No tag is created for a folder whose bookmarks were all skipped.

  In `chrome_falls_back_to_root`, with three desired provenance tags and one available slot:
  ```ts
  expect(plan.provenance?.mode).toBe("root-only");
  expect(plan.tags).toHaveLength(1);
  expect(plan.bookmarks.every(bookmark => bookmark.tags.length === 1 && bookmark.tags[0] === plan.provenance?.rootTagId)).toBe(true);
  ```
- [ ] **Step 2: Observe red.** `bun test test/import-chrome.test.ts test/import-toby.test.ts test/import-tags.test.ts test/import-dialog.test.tsx` → new hierarchy assertions fail.
- [ ] **Step 3: Implement provenance plans.** Allocate a unique root against effective top-level tags using trimmed/case-insensitive comparison. Chrome tag levels are root + allocated collection name + at most three lower folders. Treat source folder/label names as literal segments: trim, replace literal `/` with `／`, use localized “Untitled” for empty names, and limit newly created segments to 50 Unicode code points to match current REST validation; allocate suffix space within that limit, including the root. If different original folder names normalize/truncate to the same value, allocate distinct suffixed names; only equivalent original sibling names coalesce. Reuse existing literal top-level Toby labels by name first, including legacy `/`, before normalizing a missing label. Never rename collections or existing tags as a side effect.
- [ ] **Step 4: Implement quota decisions.** Build the desired tree only for accepted bookmarks. If all optional tags fit, use `full`; otherwise attach only a root if it fits; otherwise use `none`. Mandatory Toby label tags are reserved first; if those cannot fit, block with the tag quota message instead of partially applying labels. Existing nested labels with the same name are not Toby reuse targets. The option off preserves previous collections/bookmarks/labels and adds no provenance tree. Never leave IDs of discarded optional tags on bookmarks.
- [ ] **Step 5: Implement commit and UI.** Replace per-entity writes with one cross-store IDB transaction for new tags, collections, and bookmarks; apply state and one enqueue only after commit. Respect bookmark usage including archive/trash and collection usage including retained collections; refresh/check quotas before commitment. Recheck target workspace visibility, current sibling/root collisions, and reused label IDs after awaits. Keep preview IDs stable for unchanged input, rebuild visibly on stale/quota changes, and report actual committed counts. Fix the dialog's current derived-bookmark store selector by selecting the raw map and memoizing conversion.
- [ ] **Step 6: Implement success navigation.** Add the option, tag count, root-only/no-tag explanation, and conditional “Show imported bookmarks” button. On click, switch to the target active workspace, navigate to the library, select `all`, clear selected tags/type/search, then select only the committed root. Clear bookmark multi-selection as part of the scope change. If the target/root disappeared after success, disable the action or show an inline unavailable message. Show the root-deletion explanation only when a root exists.
- [ ] **Step 7: Verify.** Add component cases for toggle default/on/off, root-name collisions, `full/root-only/none`, Toby mandatory labels at capacity, all-duplicate input, timezone date boundaries, failed IDB rollback, and quota changes after preview. Assert summary equals actual results, no mutation occurs on stale preflight, and reveal clears every unrelated filter. Rerun Step 2 → all pass.
- [ ] **Step 8: Commit.** Stage this task's files; `git commit -m "feat(import): preserve folder hierarchy with quota-aware tags"`.

## Final Integration, Documentation, and Release Gate

These steps belong to the completed feature's verification, not a separate scaffolding task.

- [ ] Reconcile the source spec with the reviewed amendments: explicit root responses, suffix-preserving deletion, active-tag quota, durable pending tombstones, and import label/root fallback rules. Update existing frontend/server `CLAUDE.md` and `ARCHITECTURE.md` with the tag contracts and `tag-tree-expanded` key; preserve all unrelated guidance.
- [ ] Frontend: run `bun test`, `bun run compile`, `bun run build`, `bun run build:firefox`. Expected: zero failed tests, no TypeScript errors, successful Chrome and Firefox production builds. Do not add snapshots that only mirror implementation.
- [ ] Server: with a dedicated `TEST_DATABASE_URL`, run `go test ./... -count=1`, `go vet ./...`, `go build ./...`. Inspect output for skipped hierarchy integration cases; execute them with the test DB before claiming the feature verified.
- [ ] Cloud: verify `go env GOWORK` and the module replacement resolve the changed sibling server, then run `go test ./...`, `go vet ./...`, `go build ./...`. Current `go.mod` replaces `github.com/TabSlate-dev/TabSlate-server` with `../TabSlate-server`; no Cloud source change is necessary. Record which server commit was tested. Do not claim a released dependency was updated by these local checks.
- [ ] Manual browser check: import a real deep Chrome export, inspect full paths and depth collapse, filter the root, bulk-edit its children, merge two subtrees, delete a root with colliding children, and reopen newtab after an offline deletion. Verify disabled targets and keyboard-only picker/tree use.
- [ ] Compatibility matrix: new extension/old server retains local hierarchy through push/pull; old extension/new server edits name/color without clearing parents; new/new syncs root moves; two devices making A↔B converge after rejection/retry. Delete a parent with an older client and verify orphan display remains usable; REST deletion promotes children.
- [ ] Review the final diff using `superpowers:requesting-code-review` and verify every Review Focus case has executed evidence. Fix findings before declaring completion. Commit existing documentation with `git commit -m "docs(tags): document hierarchy and import contracts"`.
- [ ] Report verified server/frontend commits and remaining manual/environment limitations. Deployment, pushing branches, or publishing extensions are separate actions; execute only within the user's authorization. Rollout order remains server → Cloud verification/release integration → extension.

## Coverage and Handoff

| Spec requirement | Owning tasks |
|---|---|
| §1 data model, sibling/depth/cycle rules, compatibility | 1–4 |
| §1 create/move/rename/delete, all-or-none quota | 1, 3 |
| §2 rows, counts, selection, expansion, search, menus, dialog | 5–7 |
| §3 descendant OR filtering and paths on every surface | 1, 6, 8–9 |
| §4 Chrome folders, Toby labels, provenance options/fallback, reveal | 9–10 |
| §5 recursive merge and all-bucket unused cleanup | 1, 3, 5, 7 |
| Error handling, i18n, accessibility, server/Cloud/manual checks | Each owning task and the final integration gate |

Self-review: interfaces are defined before use; task dependencies follow execution order; tests cover every Review Focus item. Before execution, review the recommended amendments with the user. For this cross-repository feature, subagent-driven execution provides useful fresh review at the server, durability, and import boundaries; native execution is also supported. Do not start implementation merely because this plan exists.
