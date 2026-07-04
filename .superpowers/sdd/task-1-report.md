# Task 1 Report

## Status

DONE_WITH_CONCERNS

## Scope Delivered

Implemented the browser-aware MV3 baseline for manifest generation and package scripts:

- Converted `wxt.config.ts` from a static manifest object to a browser-aware manifest factory.
- Added Firefox MV3 `browser_specific_settings.gecko` metadata:
  - `id: "@tabslate"`
  - `strict_min_version: "128.0"`
  - `data_collection_permissions.required: ["none"]`
- Kept the Chromium manifest behavior intact for permissions and `chrome_url_overrides.newtab`.
- Expanded `package.json` into explicit browser-targeted MV3 scripts for Chrome, Edge, and Firefox.
- Added a focused config test that asserts Firefox metadata and Chromium permissions/newtab behavior.

## Files Changed

- `package.json`
- `wxt.config.ts`
- `test/wxt-config.test.ts`

## TDD Notes

Started with a failing test:

- `bun test test/wxt-config.test.ts`
- Initial failure: `Expected function manifest config`

Then implemented the manifest factory and explicit scripts, and re-ran the focused test until green.

## Verification Run

Focused verification:

- `bun test test/wxt-config.test.ts`
- `bun run compile`

Full relevant verification:

- `bun run build:chrome`
- `bun run build:firefox`
- `bun run build:edge`

Observed results:

- Focused test passed with 2/2 tests green.
- TypeScript compile passed.
- Chrome build succeeded and emitted `.output/chrome-mv3/manifest.json`.
- Firefox build succeeded and emitted `.output/firefox-mv3/manifest.json`.
- Edge build succeeded via the explicit Chromium MV3 flow.
- Generated Firefox manifest contains the expected `browser_specific_settings.gecko` block.

## Self-Review

Checked the diff and generated manifests after the build:

- `package.json` now exposes explicit MV3 browser scripts with Chrome as the default alias.
- `wxt.config.ts` injects Firefox-only gecko metadata without changing Chromium-only behavior.
- The existing `build:manifestGenerated` hook still removes generated `host_permissions` and preserves OpenPanel origin injection behavior.
- The test covers the two acceptance-critical paths for this task:
  - Firefox MV3 metadata exists
  - Chromium builds keep required permissions and newtab override

## Concerns

- `package.json` now declares `sign:firefox` and `package:firefox:selfhost`, but `scripts/sign-firefox.mjs` does not exist in this task’s scope, so those two commands were not executed and would currently fail if invoked.

## Commit

Planned commit message:

- `build: add browser-aware MV3 manifest and package scripts`
