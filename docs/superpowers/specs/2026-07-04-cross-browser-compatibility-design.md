# Cross-Browser Compatibility Design

Date: 2026-07-04
Status: Draft

## Overview

TabSlate currently targets Chrome MV3 first, with placeholder Firefox scripts and no formal Edge packaging flow. This spec defines a single-codebase strategy for Chrome, Edge, and Firefox with these goals:

- Keep one shared MV3 architecture.
- Prefer official browser APIs over custom fallback implementations.
- Only downgrade functionality where the official browser platform has no equivalent.
- Produce browser-specific packaging commands that match each store's documented submission flow.

The design target is:

- Chrome: MV3 build, Chrome Web Store `.zip`.
- Edge: MV3 build, Edge Add-ons `.zip`, Partner Center privacy disclosures.
- Firefox: MV3 build, AMO submission package, and signed `.xpi` for self-distribution.

## Official Findings

### WXT

- WXT supports Chrome, Firefox, Edge, Safari, and Chromium-based browsers.
- WXT defaults to `chrome` when no browser is specified.
- WXT defaults to MV2 for Firefox, so Firefox MV3 must be selected explicitly with `--mv3`.

Implication: Firefox compatibility is not automatic in this repo; the build scripts and manifest generation must opt into MV3 deliberately.

Sources:
- https://wxt.dev/
- https://wxt.dev/guide/essentials/target-different-browsers

### Chrome search API

- `chrome.search.query()` is supported in Chrome 87+.
- It requires the `search` permission.
- It searches with the browser's default provider only.

Implication: TabSlate's recent Chrome search migration is compatible with the current product direction of using the browser-default search engine.

Source:
- https://developer.chrome.com/docs/extensions/reference/api/search

### Edge porting and API support

- Microsoft documents that supported Chrome extension APIs and manifest keys are code-compatible with Edge.
- Edge requires developers to review the extension's used APIs against the Edge supported API list.
- Edge porting guidance requires removing `update_url` from the manifest if present.
- Edge store submission uses a `.zip` package uploaded through Partner Center.
- Edge Partner Center requires:
  - a clear single-purpose description,
  - justification for each declared permission,
  - remote code disclosure,
  - data usage disclosures,
  - a privacy policy URL if the extension collects personal information.
- Edge documents that remote code is not permitted in MV3.

Implication: Edge is structurally compatible with the current codebase, but store submission has stricter metadata and disclosure requirements than a plain Chrome zip upload.

Sources:
- https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension
- https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support
- https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension

### Firefox search API

- `browser.search.query()` performs a search using the browser's default search engine.
- It requires the `search` permission.
- `browser.search.search()` is Firefox-only and can target a named installed search engine.

Implication: The safest cross-browser design is to standardize on default-engine search for all three browsers. Firefox's `search.search()` stays available as a future enhancement, not a requirement for first-pass compatibility.

Sources:
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/search
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/search/query
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/search/search

### Firefox tab groups

- Firefox supports `tabGroups`.
- Firefox supports `tabs.group()` and tab group events.
- `tabGroups` requires the `tabGroups` permission.

Implication: Tab groups are not a planned Firefox downgrade in this design. The first implementation should preserve them and verify runtime behavior rather than hiding the feature preemptively.

Sources:
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabGroups
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/group

### Firefox dynamic content script registration

- `scripting.registerContentScripts()` is available in Chrome MV3.
- It is also available in Firefox 101+ for MV3.

Implication: The existing runtime registration model for the search overlay can remain the primary design for Firefox.

Source:
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/registerContentScripts

### Firefox new tab override and signing requirements

- Firefox supports `chrome_url_overrides.newtab`.
- For Firefox MV3 signing and self-distribution, `browser_specific_settings.gecko.id` is required.
- New AMO submissions also require `browser_specific_settings.gecko.data_collection_permissions`.
- Firefox packaging guidance treats packaged extensions as ZIP-based XPI files and recommends `web-ext build`.
- AMO and self-distribution both rely on signed output; `web-ext sign` is an official submission path.

Implication: Firefox needs manifest augmentation and a signing-aware packaging flow. A plain WXT Firefox zip is not the full distribution story.

Sources:
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/chrome_url_overrides
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings
- https://extensionworkshop.com/documentation/publish/package-your-extension/
- https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/
- https://extensionworkshop.com/documentation/publish/self-distribution/

## Current API Compatibility Matrix

The repo currently uses the following extension platform APIs and manifest features.

| Repo usage | Current examples | Chrome | Edge | Firefox | Design outcome |
|---|---|---|---|---|---|
| `tabs` | `background.ts`, `tabs-store.ts`, `tabs-rail.tsx` | Supported | Supported | Supported | Keep |
| `tabGroups` | `background.ts`, `lib/chrome/tab-groups.ts`, `tabs-store.ts` | Supported | Supported in MV3 | Supported | Keep |
| `storage.local` / `storage.session` | auth + plan + analytics + i18n persistence | Supported | Supported | Supported | Keep |
| `contextMenus` | background save flows | Supported | Supported | Supported | Keep |
| `scripting.registerContentScripts` | runtime registration for `content.ts` | Supported in MV3 | Supported in MV3 | Supported in MV3 | Keep |
| `permissions.request/remove` | optional host permission toggle | Supported | Supported | Supported | Keep, verify runtime UX |
| `commands` | `open-search` shortcut | Supported | Supported | Supported | Keep |
| `search.query` | `search-box.tsx`, `search-panel.tsx`, `background.ts` | Supported | Supported | Replace with Firefox `search.query` | Keep with adapter |
| `chrome_url_overrides.newtab` | `wxt.config.ts` | Supported | Supported via Chromium compatibility | Supported | Keep |
| runtime messaging | background/newtab/content coordination | Supported | Supported | Supported | Keep |
| `optional_host_permissions` | `<all_urls>` permission gating | Supported | Supported | Supported | Keep, verify store review explanations |

Edge compatibility conclusion: every current API and manifest feature directly used by TabSlate appears on Microsoft's supported path for Edge, with no immediate API blocker discovered in the current codebase.

## Design

### 1. Shared architecture

The repo remains a single WXT extension codebase with browser-specific differences confined to:

- manifest generation,
- thin runtime capability helpers,
- packaging commands,
- explicit UI feature gating only where absolutely necessary.

Business logic stays shared. No browser-specific fork of the new tab app is introduced.

### 2. Manifest strategy

`wxt.config.ts` changes from a static manifest object to a function:

```ts
manifest: ({ browser, manifestVersion }) => ({
  // browser-aware config
})
```

The generated manifest must:

- keep `chrome_url_overrides.newtab`,
- keep `commands.open-search`,
- keep `optional_host_permissions`,
- keep the current `host_permissions` hook behavior for OpenPanel,
- define permissions from a browser-aware function,
- inject Firefox-only `browser_specific_settings.gecko`.

Firefox-specific manifest fields:

- `browser_specific_settings.gecko.id`
- `browser_specific_settings.gecko.strict_min_version`
- `browser_specific_settings.gecko.data_collection_permissions`

Recommended initial Firefox values:

```json
{
  "browser_specific_settings": {
    "gecko": {
      "id": "@tabslate",
      "strict_min_version": "128.0",
      "data_collection_permissions": {
        "required": ["none"]
      }
    }
  }
}
```

`strict_min_version` should remain configurable if later testing shows a different lower bound is safe.

### 3. Browser capability adapter layer

Add a small browser abstraction layer under `lib/browser/`.

Suggested files:

- `lib/browser/env.ts`
- `lib/browser/search.ts`
- `lib/browser/capabilities.ts`

Responsibilities:

- expose `isChromeBuild`, `isEdgeBuild`, `isFirefoxBuild`,
- expose `supportsTabGroups`, `supportsDynamicContentScripts`,
- provide a single `runWebSearch` function.

This layer must stay intentionally thin. It is not a full compatibility framework and must not absorb unrelated business logic.

### 4. Search behavior

Unify search product behavior across all browsers:

- search with the browser's default search engine,
- current-tab or new-tab disposition based on existing call site behavior,
- no restored custom search engine picker.

Implementation:

- Chrome and Edge use `chrome.search.query({ text, disposition })`.
- Firefox uses `browser.search.query({ text, disposition })`.

`browser.search.search()` is intentionally out of scope for phase 1. It would introduce browser-specific product behavior and re-open a search engine selection problem the Chrome build intentionally removed.

### 5. Tab groups

The Firefox build keeps saved groups and open tab group workflows enabled.

Required implementation adjustment:

- the current `lib/chrome/tab-groups.ts` wrapper should stop assuming a Chrome-only namespace and callback-only call style,
- callers should depend on a browser-neutral wrapper rather than raw `chrome.tabGroups.*`.

No functional Firefox downgrade is planned unless runtime verification demonstrates a specific incompatibility not covered by the official API docs.

### 6. Dynamic content script registration

Retain the current runtime injection model:

- optional host permission toggle in settings,
- background registration via `scripting.registerContentScripts`,
- messaging bridge for search overlay actions.

Implementation additions:

- wrap registration and unregistration in clearer error handling,
- centralize the content-script capability check,
- verify that Firefox MV3 handles the current registration payload without browser-specific fields that would break registration.

No fallback static registration path is planned in phase 1.

### 7. Edge packaging strategy

Edge needs browser-specific release commands even though the runtime code is Chromium-compatible.

Important distinction:

- browser compatibility is largely shared with Chrome,
- store submission requirements are not identical to Chrome's workflow.

Edge release artifacts must be accompanied by:

- Partner Center permission justifications,
- Single Purpose description,
- remote code declaration set to "No" for MV3,
- data usage disclosures,
- privacy policy URL if applicable.
- no `update_url` manifest field.

Because WXT's public browser-targeting examples are explicit about `chrome` and `firefox` but do not show a separate `edge` example in the docs reviewed here, the design does not assume a unique Edge-only build target is required for phase 1. Instead:

- `build:edge` and `zip:edge` are explicit release-target scripts,
- their initial implementation may reuse the Chrome-compatible MV3 build path,
- the output artifact name and release process are still Edge-specific.

This keeps release semantics clear without inventing an unsupported browser split.

### 8. Firefox packaging strategy

Firefox packaging has two levels:

1. build/submission package,
2. signed distribution artifact.

Phase 1 command semantics:

- `build:firefox` produces a Firefox MV3 build.
- `zip:firefox` produces the upload package for AMO review intake.
- `sign:firefox` runs the official signing flow.
- `package:firefox:selfhost` produces the signed `.xpi` for self-distribution.

The implementation may use WXT for build/zip and `web-ext sign` for the signed output. The exact secret handling for AMO credentials is implementation-plan work, not design work.

## Package Script Design

The script surface should separate browser target from distribution target.

Development and build:

- `dev:chrome`
- `build:chrome`
- `zip:chrome`
- `dev:edge`
- `build:edge`
- `zip:edge`
- `dev:firefox`
- `build:firefox`
- `zip:firefox`

Firefox distribution:

- `package:firefox:amo`
- `sign:firefox`
- `package:firefox:selfhost`

Recommended initial meanings:

- `dev:chrome` -> `wxt -b chrome --mv3`
- `build:chrome` -> `wxt build -b chrome --mv3`
- `zip:chrome` -> `wxt zip -b chrome --mv3`
- `dev:firefox` -> `wxt -b firefox --mv3`
- `build:firefox` -> `wxt build -b firefox --mv3`
- `zip:firefox` -> `wxt zip -b firefox --mv3`
- `package:firefox:amo` -> alias of the Firefox upload-package flow
- `sign:firefox` -> `web-ext sign` against the Firefox build output
- `package:firefox:selfhost` -> signed `.xpi` generation flow

Edge script meanings:

- `dev:edge` and `build:edge` are explicit developer-facing aliases for the Chromium-compatible MV3 build path used for Edge verification.
- `zip:edge` produces the archive intended for Partner Center submission.

## Verification Criteria

The cross-browser design is considered implemented when all of the following are true:

- `build:chrome` succeeds and the extension remains loadable in Chrome.
- `build:edge` succeeds and the extension remains loadable in Edge.
- `build:firefox` succeeds as MV3 and emits a manifest with valid `browser_specific_settings.gecko`.
- New tab override works in all three browsers.
- Bookmark search fallback works in all three browsers, using the official search API for each platform.
- Tab group workflows remain enabled and functional in Firefox.
- Optional host permission toggling still controls runtime search overlay injection.
- `zip:chrome` yields a Chrome store upload archive.
- `zip:edge` yields an Edge Partner Center upload archive.
- Firefox packaging supports both AMO submission and signed self-distribution.

## Risks and Explicit Non-Goals

### Primary risks

- Firefox MV3 in this repo may still expose runtime mismatches even where the docs show API support, especially around permissions UX and content script registration payload shape.
- `chrome.search.query` call sites currently assume the Chrome namespace and Promise behavior; they must be normalized before Firefox support is trustworthy.
- Firefox signing introduces credentials and CI concerns not present in Chrome or Edge zip-only packaging.
- Edge review requirements may reject the package if store disclosures are incomplete even when the runtime behavior is correct.

### Non-goals

- Do not recreate the removed custom search engine picker.
- Do not introduce a Firefox-specific alternate product flow unless the official API surface cannot support the current feature.
- Do not remove tab groups from Firefox preemptively.
- Do not fork the new tab app by browser.

## Recommended implementation order

1. Convert manifest generation to browser-aware MV3 output.
2. Add the browser adapter layer.
3. Migrate search call sites to the adapter.
4. Make tab group wrappers browser-neutral.
5. Add browser-specific package scripts.
6. Validate Chrome, Edge, and Firefox local loads.
7. Validate Firefox signing flow and Edge Partner Center package readiness.
