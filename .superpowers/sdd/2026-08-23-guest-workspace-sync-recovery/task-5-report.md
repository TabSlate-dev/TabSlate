# Task 5 Report — Pure Guest Classification and Migration Planning

## Files changed

- `lib/guest-workspace.ts`
- `test/guest-workspace.test.js`
- `.superpowers/sdd/2026-08-23-guest-workspace-sync-recovery/task-5-report.md`

## Implementation

Added the pure guest reconciliation policy without IndexedDB, Zustand, sync-engine, server, or UI changes:

- Exported the discriminated discard, migrate, and conflict plan interfaces plus target and bookmark-update interfaces.
- Implemented `isUntouchedGuestWorkspace(snapshot)`. It requires the marked workspace and marked default collection to exist, remain active, unsynced, and fingerprint-matching; it rejects additional source collections, bookmarks in every lifecycle bucket, and active or trashed source groups.
- Implemented stable confirmed-target selection: the selected confirmed workspace wins, otherwise the confirmed workspace with the lowest position; its active confirmed default collection is required.
- Implemented deterministic planning. Untouched seeds produce a discard plan with an empty active-workspace ID. Meaningful data either produces a conflict without a valid target or migrates source collections/groups, merges only an unchanged source default into the target default, and rewrites active, archived, and trashed bookmarks only for that merged default.
- Collection migration retains IDs, names, icons, and lifecycle fields while changing only `workspaceId`, `position`, `isDefault`, and `seq`; groups retain their contents and lifecycle state while changing only `workspaceId` and `seq`.
- Lifecycle checks use explicit `=== undefined`, so the valid numeric timestamp `0` is still recognized as deleted or archived.

## TDD evidence

### RED

1. Added classification, target-selection, discard, migration, and conflict tests before adding planner exports.
2. Ran `bun test test/guest-workspace.test.js`.
3. Result: `SyntaxError: Export named 'isUntouchedGuestWorkspace' not found`; 0 passing tests and 1 error. This verified the tests failed because the requested public API was absent.
4. Added a second regression test for zero-valued lifecycle timestamps before changing lifecycle checks.
5. Ran `bun test test/guest-workspace.test.js`.
6. Result: 7 pass, 2 fail. The failures showed that `deletedAt: 0` and `archivedAt: 0` were incorrectly treated as active in classification and target selection.

### GREEN

1. Added the pure planner implementation and plan interfaces.
2. Re-ran `bun test test/guest-workspace.test.js`: 7 pass, 0 fail.
3. Changed lifecycle checks to compare against `undefined` explicitly.
4. Re-ran `bun test test/guest-workspace.test.js`: 9 pass, 0 fail, 24 assertions.
5. Ran `bun run compile`: `tsc --noEmit` completed successfully.
6. Ran `git diff --check`: no whitespace errors.

## Commands and final output

```text
$ bun test test/guest-workspace.test.js
9 pass
0 fail
24 expect() calls

$ bun run compile
$ tsc --noEmit

$ git diff --check
(no output; exit 0)
```

## Commit

`feat(sync): plan guest workspace reconciliation` (this task commit includes the implementation, tests, and this report).

## Self-review

- Verified all requested branches: exact untouched classification, each meaningful-data trigger, selected/fallback target selection, target validity, discard, default merge/bookmark rewrites, retained renamed default/ordinary collections, group preservation, and no-target conflict.
- Confirmed inputs are not mutated: all sorted arrays are created by `filter` before sorting and plans create copied entities.
- Confirmed all parent-ID changes are limited to the migration plan and no persistence/store/remote behavior was introduced.
- Confirmed source bookmark lifecycle state and group lifecycle/content remain intact because only the allowed fields are copied with replacements.

## Concerns

None for Task 5. The returned plans are intentionally not executed here; Task 7 owns canonical snapshot loading, atomic IndexedDB commit, and store application.
