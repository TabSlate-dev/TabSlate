# Task 2 report: URL matching tiers

## Changes

- Added `lib/url-match.ts` with strict and loose URL keys, tier selection, and bookmark matching.
- Updated `normalizeUrl` in `lib/bookmark-utils.ts` to delegate to `strictUrlKey`, preserving case-sensitive paths, queries, and fragments while normalizing scheme/host case, default ports, and trailing slash.
- Added `test/url-match.test.ts` covering strict and loose matching, bookmark selection, and duplicate detection.

## Reconciliation

Ran `git log --oneline -- lib/bookmark-utils.ts | head -3`; the latest entries were `17c2e9a`, `c139baa`, and `81026fb`. The current `normalizeUrl` still lowercased the full URL and had no standalone case-sensitive fix, so there were no existing tests to carry forward.

## Test-first evidence

- Before implementation: `bun test test/url-match.test.ts` — failed with `Cannot find module '../../lib/url-match.ts?fresh=1'`, as expected while the module was absent.
- After implementation: `bun test test/url-match.test.ts` — 27 pass, 0 fail, 27 assertions.
- Full suite: `bun test` — 221 pass, 0 fail, 532 assertions across 55 files.
- Type check: `bun run compile` — exited 0 (`tsc --noEmit`).
- Diff hygiene: `git diff --check` — exited 0.

## Self-review and concerns

The loose tier is only used as a comparison key; strict duplicate detection is retained for blocking saves. Invalid or non-HTTP(S) inputs are trimmed and otherwise left unchanged. URL parsing follows the platform `URL` implementation, including its standard URL canonicalization. No concerns identified.

## Round 1 review fix: preserve URL credentials

The review found strict and loose key serialization omitted URL username/password. Added a small authority serializer used by both tiers; loose matching still removes only its declared scheme/`www`/fragment/tracking differences. Added strict regressions for distinct usernames/passwords, absent credentials, username-only values, and equivalent scheme/host/default-port forms; added loose regressions for credential differences.

- Red: `bun test test/url-match.test.ts` — 5 credential assertions failed because both tiers collapsed credential-bearing URLs to the same host key.
- Green: `bun test test/url-match.test.ts` — 33 pass, 0 fail, 33 assertions.
- Type check: `bun run compile` — exited 0 (`tsc --noEmit`).
- Diff hygiene: `git diff --check` — exited 0.
- Full suite was not rerun for this focused correction, per the task instruction.
