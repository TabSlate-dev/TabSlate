# Task 4 report: byte-limited sync push chunks

## Implementation

Added `MAX_SYNC_PUSH_BYTES = 384 * 1024` and UTF-8 entity sizing in `lib/sync-recovery.ts`. The budget counts each entity's serialized JSON bytes plus one separator byte; it excludes the payload envelope, including `protocol_version`. Splitting now observes both the 900-entity count cap and byte budget. Entities larger than the budget are sent alone. Existing workspace/collection/tag/group-before-bookmark ordering remains intact, as does returning the original payload when it fits both limits.

Added `test/sync-push-split.test.ts` covering the identity fast path, long Unicode notes, parent-before-bookmark ordering, oversized singletons, and entity count. For normal chunks the test serializes the full request body with `protocol_version: 2` and asserts it is below the server's 512 KiB limit.

## Changed files

- `lib/sync-recovery.ts`
- `test/sync-push-split.test.ts`
- `.superpowers/sdd/2026-10-16-bulk-operations-and-unified-form/task-4-report.md`

## TDD and validation

- RED: `bun test test/sync-push-split.test.ts` — 2 passed, 3 failed as expected: byte-size chunking and oversized-singleton behavior were missing.
- GREEN: focused tests for the new splitter and related sync queue/recovery/deferred capture tests — 14 passed, 0 failed.
- Final focused test: `bun test test/sync-push-split.test.ts` — 5 passed, 0 failed.
- Full suite: `bun test` — 379 passed, 0 failed across 78 files.
- Type check: `bun run compile` — exited 0.
- `git diff --check` — clean.

## Self-review and concerns

Chunk sizing uses `TextEncoder` so multibyte notes count by UTF-8 bytes. Byte calculation includes the array separator budget; actual full request bodies include the envelope and protocol version, and tests verify normal serialized bodies stay below 512 KiB. Oversized singleton chunks remain permitted by design and may still be rejected by the server. No other concerns found.

## Commit

`133921e fix(sync): keep push chunks under the server's body limit`
