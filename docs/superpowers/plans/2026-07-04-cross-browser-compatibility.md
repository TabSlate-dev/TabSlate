# Cross-Browser Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single-codebase MV3 extension that works across Chrome, Edge, and Firefox, uses official browser APIs for search and tab groups, and exposes packaging commands that match each browser's documented distribution flow.

**Architecture:** Convert manifest generation to a browser-aware MV3 config in `wxt.config.ts`, isolate runtime browser differences behind a thin `lib/browser/` adapter layer, and keep product behavior unified around default-engine search and shared tab-group workflows. Chrome and Edge remain Chromium-compatible builds, while Firefox adds MV3-specific manifest metadata and a signing-ready packaging path.

**Tech Stack:** WXT 0.20.x, TypeScript 5.9, React 19, Bun, Chrome Extensions APIs, MDN WebExtensions APIs, `web-ext` for Firefox signing

## Global Constraints

- Use bun for all dependency management.
- Firefox must build with MV3 explicitly; do not rely on WXT's Firefox MV2 default.
- Prefer official browser APIs over custom fallback implementations.
- Only downgrade functionality where the browser has no official equivalent.
- Keep one shared codebase; do not fork the new tab app by browser.
- Do not restore the removed custom search-engine picker.
- Do not add an `update_url` manifest field for Edge.
- Keep `chrome_url_overrides.newtab`, `commands.open-search`, and optional host permissions behavior.
- Use strict TypeScript with no `any`.
- Follow existing code style and use `apply_patch` for file edits.

---

## File Structure

### Existing files to modify

- `package.json`
  - Browser-specific dev/build/zip scripts and Firefox signing/package scripts.
- `wxt.config.ts`
  - Browser-aware MV3 manifest generation, Firefox gecko metadata, browser-specific permissions.
- `entrypoints/background.ts`
  - Replace direct search API calls with adapter usage and centralize content-script registration capability checks.
- `components/dashboard/search-box.tsx`
  - Replace direct `chrome.search.query` usage with browser adapter.
- `components/search/search-panel.tsx`
  - Replace direct `chrome.search.query` usage with browser adapter.
- `lib/chrome/tab-groups.ts`
  - Remove Chrome-only assumptions from the tab-group wrapper while preserving the current public interface.

### New files to create

- `lib/browser/env.ts`
  - Build-target helpers such as `isFirefoxBuild()`.
- `lib/browser/capabilities.ts`
  - Thin capability booleans for content-script registration and tab groups.
- `lib/browser/search.ts`
  - Unified `runWebSearch` function for Chrome, Edge, and Firefox.
- `test/browser-search.test.ts`
  - Unit tests for browser-specific search dispatch.
- `test/wxt-config.test.ts`
  - Unit tests for browser-aware manifest generation and package scripts expectations.
- `scripts/sign-firefox.mjs`
  - Narrow helper for Firefox signing and signed artifact verification.

### Test files to modify or add only if needed by implementation details

- `test/content.test.js`
  - Expand if content-script registration helpers are extracted from `background.ts`.

## Task 1: Convert manifest generation and package scripts to explicit browser-aware MV3 flows

**Files:**
- Create: `test/wxt-config.test.ts`
- Modify: `package.json`
- Modify: `wxt.config.ts`

**Interfaces:**
- Consumes: `defineConfig` from `wxt`; existing manifest keys in `wxt.config.ts`
- Produces:
  - `manifest: ({ browser, manifestVersion }) => ManifestWebExtension`
  - package scripts:
    - `dev:chrome`
    - `build:chrome`
    - `zip:chrome`
    - `dev:edge`
    - `build:edge`
    - `zip:edge`
    - `dev:firefox`
    - `build:firefox`
    - `zip:firefox`
    - `package:firefox:amo`

- [ ] **Step 1: Write the failing config test**

```ts
import { describe, expect, test } from "bun:test";
import config from "../wxt.config";

const getManifest = (
  browser: "chrome" | "firefox" | "edge",
  manifestVersion: 3,
) => {
  const manifestFactory = config.manifest;
  if (typeof manifestFactory !== "function") {
    throw new Error("Expected function manifest config");
  }
  return manifestFactory({
    browser,
    manifestVersion,
    mode: "production",
    command: "build",
  });
};

describe("wxt cross-browser manifest", () => {
  test("adds Firefox gecko metadata for MV3", () => {
    const manifest = getManifest("firefox", 3);

    expect(manifest.browser_specific_settings?.gecko?.id).toBe("@tabslate");
    expect(manifest.browser_specific_settings?.gecko?.strict_min_version).toBe("128.0");
    expect(
      manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required,
    ).toEqual(["none"]);
  });

  test("keeps search and tabGroups permissions for Chromium builds", () => {
    const manifest = getManifest("chrome", 3);

    expect(manifest.permissions).toContain("search");
    expect(manifest.permissions).toContain("tabGroups");
    expect(manifest.chrome_url_overrides?.newtab).toBe("newtab.html");
  });
});
```

- [ ] **Step 2: Run the config test to verify it fails**

Run: `bun test test/wxt-config.test.ts`

Expected: FAIL with an error indicating `config.manifest` is currently an object instead of a function, or that Firefox gecko metadata is missing.

- [ ] **Step 3: Update `package.json` scripts to explicit browser targets**

```json
{
  "scripts": {
    "dev": "bun run dev:chrome",
    "dev:chrome": "wxt -b chrome --mv3",
    "dev:edge": "wxt -b chrome --mv3",
    "dev:firefox": "wxt -b firefox --mv3",
    "build": "bun run build:chrome",
    "build:chrome": "wxt build -b chrome --mv3",
    "build:edge": "wxt build -b chrome --mv3",
    "build:firefox": "wxt build -b firefox --mv3",
    "zip": "bun run zip:chrome",
    "zip:chrome": "wxt zip -b chrome --mv3",
    "zip:edge": "wxt zip -b chrome --mv3",
    "zip:firefox": "wxt zip -b firefox --mv3",
    "package:firefox:amo": "bun run zip:firefox",
    "compile": "tsc --noEmit",
    "postinstall": "wxt prepare"
  }
}
```

- [ ] **Step 4: Convert `wxt.config.ts` to a browser-aware manifest function**

```ts
import { defineConfig } from "wxt";

function getPermissions(browser: string): string[] {
  if (browser === "firefox") {
    return ["tabs", "tabGroups", "storage", "contextMenus", "scripting", "search"];
  }

  return ["tabs", "tabGroups", "storage", "contextMenus", "scripting", "search"];
}

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: ({ browser }) => ({
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    version: "0.1.5",
    default_locale: "en",
    permissions: getPermissions(browser),
    optional_host_permissions: ["<all_urls>"],
    host_permissions: [],
    chrome_url_overrides: {
      newtab: "newtab.html",
    },
    web_accessible_resources: [
      { resources: ["newtab.html"], matches: ["*://*.tabslate.com/*", "http://localhost:*/*"] },
    ],
    commands: {
      "open-search": {
        suggested_key: {
          default: "Ctrl+Shift+K",
          mac: "Command+Shift+K",
        },
        description: "__MSG_commandOpenSearch__",
      },
    },
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "@tabslate",
              strict_min_version: "128.0",
              data_collection_permissions: {
                required: ["none"],
              },
            },
          },
        }
      : {}),
  }),
  vite: () => ({
    build: {
      sourcemap: process.env.NODE_ENV !== "production",
    },
  }),
  hooks: {
    "build:manifestGenerated": (_wxt, manifest) => {
      delete manifest.host_permissions;

      const openpanelUrl = process.env.VITE_OPENPANEL_URL;
      if (!openpanelUrl) {
        return;
      }

      try {
        manifest.host_permissions = [`${new URL(openpanelUrl).origin}/*`];
      } catch {
        // Ignore invalid local config so the build still succeeds without analytics.
      }
    },
  },
});
```

- [ ] **Step 5: Run config and type checks**

Run: `bun test test/wxt-config.test.ts && bun run compile`

Expected: PASS for the config test, then TypeScript exits successfully with no errors.

- [ ] **Step 6: Run browser builds**

Run: `bun run build:chrome && bun run build:firefox && bun run build:edge`

Expected:
- `.output/chrome-mv3/manifest.json` generated
- `.output/firefox-mv3/manifest.json` generated
- no build failure from the Firefox MV3 manifest metadata

- [ ] **Step 7: Commit**

```bash
git add package.json wxt.config.ts test/wxt-config.test.ts
git commit -m "build: add browser-aware MV3 manifest and package scripts"
```

## Task 2: Add a thin browser adapter layer and migrate all search call sites

**Files:**
- Create: `lib/browser/env.ts`
- Create: `lib/browser/capabilities.ts`
- Create: `lib/browser/search.ts`
- Create: `test/browser-search.test.ts`
- Modify: `components/dashboard/search-box.tsx`
- Modify: `components/search/search-panel.tsx`
- Modify: `entrypoints/background.ts`

**Interfaces:**
- Consumes:
  - `import.meta.env.BROWSER`
  - `chrome.search.query`
  - Firefox `browser.search.query`
- Produces:
  - `isFirefoxBuild(): boolean`
  - `isChromiumBuild(): boolean`
  - `runWebSearch(options: { text: string; disposition: "CURRENT_TAB" | "NEW_TAB" | "NEW_WINDOW" }): Promise<void>`

- [ ] **Step 1: Write the failing browser search adapter test**

```ts
import { beforeEach, describe, expect, mock, test } from "bun:test";

describe("runWebSearch", () => {
  beforeEach(() => {
    globalThis.chrome = {
      search: {
        query: mock(async () => {}),
      },
    } as typeof chrome;

    globalThis.browser = {
      search: {
        query: mock(async () => {}),
      },
    } as never;
  });

  test("dispatches to chrome.search.query for Chromium builds", async () => {
    const { runWebSearch } = await import("../lib/browser/search");

    await runWebSearch({ text: "alpha", disposition: "CURRENT_TAB" });

    expect(chrome.search.query).toHaveBeenCalledWith({
      text: "alpha",
      disposition: "CURRENT_TAB",
    });
  });
});
```

- [ ] **Step 2: Run the adapter test to verify it fails**

Run: `bun test test/browser-search.test.ts`

Expected: FAIL with `Cannot find module "../lib/browser/search"` or `runWebSearch` not exported.

- [ ] **Step 3: Create the environment and capability helpers**

```ts
// lib/browser/env.ts
export function getBrowserBuild(): string {
  return import.meta.env.BROWSER;
}

export function isFirefoxBuild(): boolean {
  return getBrowserBuild() === "firefox";
}

export function isChromiumBuild(): boolean {
  return !isFirefoxBuild();
}
```

```ts
// lib/browser/capabilities.ts
import { isFirefoxBuild } from "@/lib/browser/env";

export function supportsTabGroups(): boolean {
  return true;
}

export function supportsDynamicContentScripts(): boolean {
  return true;
}

export function supportsDefaultEngineSearch(): boolean {
  return true;
}

export function usesFirefoxSearchNamespace(): boolean {
  return isFirefoxBuild();
}
```

- [ ] **Step 4: Create the search adapter**

```ts
import { isFirefoxBuild } from "@/lib/browser/env";

export interface WebSearchOptions {
  text: string;
  disposition: "CURRENT_TAB" | "NEW_TAB" | "NEW_WINDOW";
}

export async function runWebSearch({ text, disposition }: WebSearchOptions): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  if (isFirefoxBuild()) {
    await browser.search.query({
      text: trimmed,
      disposition,
    });
    return;
  }

  await chrome.search.query({
    text: trimmed,
    disposition,
  });
}
```

- [ ] **Step 5: Migrate search call sites**

```ts
// components/dashboard/search-box.tsx
import { runWebSearch } from "@/lib/browser/search";

const searchWeb = React.useCallback(() => {
  if (!query.trim()) { return; }
  analytics.track("search_used", { type: "web" });
  void runWebSearch({ text: query.trim(), disposition: "CURRENT_TAB" });
  setQuery("");
}, [query]);
```

```ts
// components/search/search-panel.tsx
import { runWebSearch } from "@/lib/browser/search";

// inside handleSelect
void runWebSearch({ text: query.trim(), disposition: "NEW_TAB" });
onClose?.();
```

```ts
// entrypoints/background.ts
import { runWebSearch } from "@/lib/browser/search";

if (message.type === "WEB_SEARCH") {
  runWebSearch({ text: message.query, disposition: "NEW_TAB" })
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
}
```

- [ ] **Step 6: Expand adapter test coverage**

```ts
test("dispatches to browser.search.query for Firefox builds", async () => {
  mock.module("../lib/browser/env", () => ({
    isFirefoxBuild: () => true,
  }));

  const { runWebSearch } = await import("../lib/browser/search");
  await runWebSearch({ text: "beta", disposition: "NEW_TAB" });

  expect(browser.search.query).toHaveBeenCalledWith({
    text: "beta",
    disposition: "NEW_TAB",
  });
});
```

- [ ] **Step 7: Run tests and compile**

Run: `bun test test/browser-search.test.ts && bun run compile`

Expected: PASS for the adapter tests and no new TypeScript errors in the migrated call sites.

- [ ] **Step 8: Commit**

```bash
git add lib/browser/env.ts lib/browser/capabilities.ts lib/browser/search.ts components/dashboard/search-box.tsx components/search/search-panel.tsx entrypoints/background.ts test/browser-search.test.ts
git commit -m "feat: add cross-browser search adapter"
```

## Task 3: Make tab-group and runtime content-script helpers browser-neutral without changing product behavior

**Files:**
- Modify: `lib/chrome/tab-groups.ts`
- Modify: `entrypoints/background.ts`
- Modify: `test/content.test.js`

**Interfaces:**
- Consumes:
  - current exports from `lib/chrome/tab-groups.ts`
  - `chrome.permissions.contains`
  - `chrome.scripting.getRegisteredContentScripts`
- Produces:
  - unchanged public tab-group function names:
    - `getCurrentWindowGroups(): Promise<BrowserTabGroup[]>`
    - `groupTabs(tabIds: number[], title: string, color: TabGroupColor): Promise<number>`
    - `updateGroup(groupId: number, patch: { title?: string; color?: TabGroupColor; collapsed?: boolean }): Promise<BrowserTabGroup>`
    - `ungroupTabs(tabIds: number[]): Promise<void>`
  - internal `syncContentScriptRegistration` flow that exits early when the browser lacks required APIs

- [ ] **Step 1: Write a failing test for defensive content-script registration**

```js
import { beforeEach, describe, expect, mock, test } from "bun:test";

describe("background content script sync", () => {
  beforeEach(() => {
    globalThis.chrome = {
      runtime: {
        onInstalled: { addListener: mock(() => {}) },
        onStartup: { addListener: mock(() => {}) },
        onMessage: { addListener: mock(() => {}) },
        getManifest: () => ({ version: "0.1.5" }),
      },
      permissions: {
        contains: mock(async () => true),
        onAdded: { addListener: mock(() => {}) },
        onRemoved: { addListener: mock(() => {}) },
      },
      scripting: undefined,
      storage: {
        session: { setAccessLevel: mock(() => {}) },
      },
      contextMenus: {
        create: mock(() => {}),
        onClicked: { addListener: mock(() => {}) },
      },
      tabs: {
        onCreated: { addListener: mock(() => {}) },
        onRemoved: { addListener: mock(() => {}) },
        onUpdated: { addListener: mock(() => {}) },
        onActivated: { addListener: mock(() => {}) },
        onMoved: { addListener: mock(() => {}) },
        query: mock(async () => []),
        sendMessage: mock(async () => {}),
        create: mock(async () => {}),
      },
      tabGroups: {
        onCreated: { addListener: mock(() => {}) },
        onRemoved: { addListener: mock(() => {}) },
        onUpdated: { addListener: mock(() => {}) },
        onMoved: { addListener: mock(() => {}) },
      },
      commands: {
        onCommand: { addListener: mock(() => {}) },
      },
    };
  });

  test("background boot does not throw when scripting API is unavailable", async () => {
    const mod = await import("../entrypoints/background");
    expect(mod.default).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/content.test.js`

Expected: FAIL or remain insufficient because `background.ts` currently assumes `chrome.scripting` exists without a capability guard.

- [ ] **Step 3: Make tab-group helpers namespace-neutral**

```ts
function getTabGroupsApi() {
  return chrome.tabGroups;
}

function getTabsApi() {
  return chrome.tabs;
}

function toGroup(g: chrome.tabGroups.TabGroup): BrowserTabGroup {
  return {
    id: g.id,
    title: g.title ?? "",
    color: (g.color as TabGroupColor) ?? "grey",
    collapsed: g.collapsed,
    windowId: g.windowId,
  };
}

export function getCurrentWindowGroups(): Promise<BrowserTabGroup[]> {
  const tabGroups = getTabGroupsApi();
  return tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT }).then(groups => groups.map(toGroup));
}

export async function groupTabs(tabIds: number[], title: string, color: TabGroupColor): Promise<number> {
  const groupId = await getTabsApi().group({ tabIds: tabIds as [number, ...number[]] });
  await getTabGroupsApi().update(groupId, { title, color });
  return groupId;
}
```

- [ ] **Step 4: Add a capability guard around runtime content-script registration**

```ts
import { supportsDynamicContentScripts } from "@/lib/browser/capabilities";

async function syncContentScriptRegistration() {
  if (!supportsDynamicContentScripts() || !chrome.scripting) {
    return;
  }

  try {
    const hasPermission = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    const isRegistered = scripts.some(s => s.id === "search-overlay");

    if (hasPermission && !isRegistered) {
      await chrome.scripting.registerContentScripts([{
        id: "search-overlay",
        matches: ["<all_urls>"],
        js: ["content-scripts/content.js"],
        runAt: "document_idle",
      }]);
      return;
    }

    if (!hasPermission && isRegistered) {
      await chrome.scripting.unregisterContentScripts({ ids: ["search-overlay"] });
    }
  } catch (err) {
    console.error("[TabSlate] Failed to sync content script registration:", err);
  }
}
```

- [ ] **Step 5: Update or add tests for the guarded registration flow**

```js
test("content registration sync exits when scripting API is absent", async () => {
  globalThis.chrome.scripting = undefined;

  const mod = await import("../entrypoints/background");
  expect(mod.default).toBeDefined();
});
```

- [ ] **Step 6: Run tests, compile, and Firefox build**

Run: `bun test test/content.test.js && bun run compile && bun run build:firefox`

Expected:
- tests pass
- compile passes
- Firefox MV3 build still succeeds after the capability-layer changes

- [ ] **Step 7: Commit**

```bash
git add lib/chrome/tab-groups.ts entrypoints/background.ts test/content.test.js
git commit -m "feat: harden tab groups and content script compatibility"
```

## Task 4: Add Firefox signing helper and verify browser-specific packaging commands end-to-end

**Files:**
- Create: `scripts/sign-firefox.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes:
  - `.output/firefox-mv3`
  - `web-ext sign`
  - env vars:
    - `AMO_JWT_ISSUER`
    - `AMO_JWT_SECRET`
- Produces:
  - signing helper entrypoint
  - `sign:firefox`
  - `package:firefox:selfhost`

- [ ] **Step 1: Write the helper test as a dry-run script contract**

```ts
import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

describe("Firefox packaging scripts", () => {
  test("package scripts expose signing entrypoints", () => {
    expect(pkg.scripts["package:firefox:amo"]).toBe("bun run zip:firefox");
    expect(pkg.scripts["sign:firefox"]).toBe("node scripts/sign-firefox.mjs");
    expect(pkg.scripts["package:firefox:selfhost"]).toBe("node scripts/sign-firefox.mjs --selfhost");
  });
});
```

- [ ] **Step 2: Run the script contract test**

Run: `bun test test/wxt-config.test.ts`

Expected: PASS for the package script assertions; if the assertions are not yet present, FAIL until the script names are finalized.

- [ ] **Step 3: Create the Firefox signing helper**

```js
import { spawnSync } from "node:child_process";

const isSelfhost = process.argv.includes("--selfhost");
const sourceDir = ".output/firefox-mv3";
const args = [
  "web-ext",
  "sign",
  "--source-dir",
  sourceDir,
  "--channel",
  isSelfhost ? "unlisted" : "listed",
];

if (!process.env.AMO_JWT_ISSUER || !process.env.AMO_JWT_SECRET) {
  console.error("Missing AMO_JWT_ISSUER or AMO_JWT_SECRET");
  process.exit(1);
}

const result = spawnSync("npx", args, {
  stdio: "inherit",
  env: process.env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
```

- [ ] **Step 4: Add `web-ext` as a dev dependency**

```json
{
  "devDependencies": {
    "@tailwindcss/postcss": "^4.3.0",
    "@types/chrome": "^0.1.42",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@wxt-dev/module-react": "^1.2.2",
    "postcss": "^8.5.14",
    "tailwindcss": "^4.3.0",
    "typescript": "5.9.3",
    "web-ext": "^8.0.0",
    "wxt": "^0.20.25"
  }
}
```

- [ ] **Step 5: Install dependencies and regenerate lockfile**

Run: `bun install`

Expected:
- `package.json` and `bun.lock` stay in sync
- `web-ext` becomes available to the helper script

- [ ] **Step 6: Run verification commands**

Run: `bun run compile && bun run zip:chrome && bun run zip:edge && bun run zip:firefox`

Expected:
- all commands succeed
- Chrome upload zip exists
- Edge upload zip exists
- Firefox upload zip exists

Run: `AMO_JWT_ISSUER=example AMO_JWT_SECRET=example node scripts/sign-firefox.mjs`

Expected: either a real signing run in a credentialed environment or a controlled authentication failure after the helper successfully invokes `web-ext sign`.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock scripts/sign-firefox.mjs
git commit -m "build: add Firefox signing helper"
```

## Task 5: Perform final cross-browser verification and sanity-check store readiness

**Files:**
- Modify: `package.json` if verification reveals a script naming correction
- Modify: `wxt.config.ts` if verification reveals a browser-specific manifest issue

**Interfaces:**
- Consumes:
  - all outputs from Tasks 1-4
- Produces:
  - final verified browser scripts
  - implementation-ready checklist for Chrome, Edge, and Firefox builds

- [ ] **Step 1: Run the full automated verification set**

Run: `bun test && bun run compile && bun run build:chrome && bun run build:edge && bun run build:firefox`

Expected:
- all unit tests pass
- TypeScript passes
- all three builds succeed

- [ ] **Step 2: Inspect generated manifests**

Run: `cat .output/chrome-mv3/manifest.json`

Expected:
- `chrome_url_overrides.newtab` present
- `permissions` includes `search`, `tabGroups`, `scripting`

Run: `cat .output/firefox-mv3/manifest.json`

Expected:
- `browser_specific_settings.gecko.id` present
- `browser_specific_settings.gecko.data_collection_permissions.required` equals `["none"]`
- build target is MV3-compatible

- [ ] **Step 3: Sideload in browsers and verify runtime behaviors**

Run:
- `bun run dev:chrome`
- `bun run dev:edge`
- `bun run dev:firefox`

Manual checks:
- open a new tab and verify TabSlate loads
- use the search UI and confirm browser-default search opens
- verify tab groups still render and basic group actions work
- toggle the optional host permission and confirm search overlay registration still behaves correctly

Expected:
- no browser-specific runtime errors in the extension consoles

- [ ] **Step 4: Sanity-check store-readiness requirements**

Checklist:
- Edge package is `.zip`
- Edge manifest does not contain `update_url`
- Edge review notes are prepared for single purpose, permission justifications, remote code = no, data usage disclosures, privacy policy URL if needed
- Firefox package path for AMO is defined
- Firefox signed `.xpi` path for self-hosting is defined

- [ ] **Step 5: Final commit if verification required script or manifest adjustments**

```bash
git add package.json wxt.config.ts
git commit -m "chore: finalize cross-browser verification"
```
