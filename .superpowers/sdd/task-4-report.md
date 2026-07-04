# Task 4 Report: Firefox signing helper and browser-specific packaging verification

## Scope completed

- Added Firefox signing helper at `scripts/sign-firefox.mjs`.
- Added Edge packaging helper at `scripts/zip-edge.mjs`.
- Restored Firefox signing/package entrypoints in `package.json`.
- Added `web-ext` as a dev dependency and regenerated `bun.lock`.
- Added packaging script contract coverage in `test/wxt-config.test.ts`.
- Added helper behavior coverage in `test/sign-firefox.test.ts`.
- Added Edge packaging helper coverage in `test/zip-edge.test.ts`.

## Implementation details

### `package.json`

- Changed `zip:edge` -> `node scripts/zip-edge.mjs`
- Added `sign:firefox` -> `node scripts/sign-firefox.mjs`
- Added `package:firefox:selfhost` -> `node scripts/sign-firefox.mjs --selfhost`
- Kept `package:firefox:amo` pointing at `bun run zip:firefox`
- Added `web-ext` dev dependency

### `scripts/zip-edge.mjs`

- Invokes `npx wxt zip -b chrome --mv3`
- Verifies the expected Chromium zip exists at `.output/tab-slate-${version}-chrome.zip`
- Copies that artifact to `.output/tab-slate-${version}-edge.zip`
- Fails fast if the underlying packaging step fails or if the Chromium zip is missing

### `scripts/sign-firefox.mjs`

- Detects `--selfhost` and selects:
  - `listed` for AMO-listed signing
  - `unlisted` for self-hosted signing
- Requires both `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`
- Invokes `npx web-ext sign` against `.output/firefox-mv3`
- Uses environment-based credential handoff for `web-ext` via `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`
- Keeps AMO credentials out of process arguments
- Exits non-zero if credentials are missing or if `web-ext` fails

## Test work

### Red/green cycle performed

1. Added script contract assertions to `test/wxt-config.test.ts`
2. Ran `bun test test/wxt-config.test.ts`
3. Observed expected failure because `sign:firefox` was missing
4. Implemented package scripts and helper
5. Re-ran focused test and confirmed pass
6. Added helper behavior tests in `test/sign-firefox.test.ts`
7. Ran `bun test test/sign-firefox.test.ts`
8. Observed expected failure because helper did not forward API credentials
9. Updated helper to pass `--api-key/--api-secret`
10. Re-ran focused tests and confirmed pass
11. Repaired the new test to avoid `Bun` globals so `tsc --noEmit` stays clean
12. Review found two blockers: `zip:edge` did not emit a distinct Edge artifact, and `sign-firefox` exposed the AMO secret on the command line
13. Added a failing contract assertion for `zip:edge` and a new failing helper test in `test/zip-edge.test.ts`
14. Updated `test/sign-firefox.test.ts` to require `WEB_EXT_*` environment handoff and forbid credential argv flags
15. Implemented `scripts/zip-edge.mjs` and rewired `package.json`
16. Updated `scripts/sign-firefox.mjs` to hand credentials to `web-ext` through environment variables only
17. Re-ran the focused tests and confirmed all pass

## Verification evidence

### Focused tests

- `bun test test/wxt-config.test.ts` -> PASS
- `bun test test/sign-firefox.test.ts` -> PASS
- `bun test test/zip-edge.test.ts` -> PASS

### Full relevant verification

- `bun run compile && bun run zip:chrome && bun run zip:edge && bun run zip:firefox` -> PASS
- Produced:
  - `.output/tab-slate-0.1.3-chrome.zip`
  - `.output/tab-slate-0.1.3-edge.zip`
  - `.output/tab-slate-0.1.3-firefox.zip`
  - `.output/tab-slate-0.1.3-sources.zip`
- Verified with:
  - `ls -l .output/tab-slate-0.1.3-chrome.zip .output/tab-slate-0.1.3-edge.zip .output/tab-slate-0.1.3-firefox.zip .output/tab-slate-0.1.3-sources.zip`
- Result:
  - Chrome and Edge upload zips both exist as distinct files
  - Chrome zip size: `1296022`
  - Edge zip size: `1296022`
  - Firefox zip size: `1296081`
  - Firefox sources zip size: `2403268`

### Signing helper verification

- `AMO_JWT_ISSUER=example AMO_JWT_SECRET=example node scripts/sign-firefox.mjs`
- Result: helper invoked `web-ext sign`, built from `.output/firefox-mv3`, and reached AMO authentication.
- Observed controlled remote failure:
  - `WebExtError: Upload failed: Unauthorized`
  - `Unknown JWT iss (issuer).`

This confirms the helper now passes credentials through to `web-ext` without putting the AMO secret on the command line; the remaining failure is expected for dummy credentials.

## Self-review

- Changes are limited to Task 4 packaging/signing scope.
- No search, manifest-shape, or tab-group behavior was reworked.
- The untracked plan file `docs/superpowers/plans/2026-07-04-cross-browser-compatibility.md` was intentionally left out of the commit.
- Existing unrelated modification `.superpowers/sdd/task-1-report.md` was not touched or reverted.

## Commit

- Intended commit message: `build: add Firefox signing helper`
- Follow-up fix commit message: `build: fix edge and Firefox packaging helpers`
