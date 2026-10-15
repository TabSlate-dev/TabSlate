# Library Management Basics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close TabSlate's everyday library-management gaps: synced view preferences, editable tags and collections with right-click menus, tag counts and search, clickable card tags, a save shortcut, and duplicate detection at every save entry point.

**Architecture:** State stays where it lives today. Small focused modules carry the new logic: `lib/url-match.ts` (two URL matching tiers), `lib/duplicate-lookup.ts` (visibility-aware matches), `lib/view-preferences.ts` (local and server preference IO), `lib/reveal-bookmark.ts` (show one bookmark in the list), and `components/ui/context-menu.tsx` plus per-entity menu item components shared by the ⋯ and right-click menus. The settings store orchestrates preference sync with a credentials getter passed in by `App.tsx`.

**Tech Stack:** TypeScript (strict), React 19, Zustand 5, react-router-dom 7 (HashRouter), WXT (MV3, Chromium and Firefox), shadcn/Radix UI, Bun test with happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-15-library-management-basics-design.md`

## Global Constraints

- Run every command from the repository root `/Users/lieutenant/Documents/github/TabSlate`, on branch `feat/bookmark-library-ux`.
- TypeScript strict: never `any`; use `unknown` only to parse external data; prefer interfaces for object shapes; braces on every `if`.
- Zustand: one selector per field (`useStore(s => s.field)`); never destructure a whole store; never derive arrays inside a selector (use `useMemo`).
- Every new UI string goes into both `public/_locales/en/messages.json` and `public/_locales/zh_CN/messages.json` (2-space JSON; `[component]_[description]` keys; `$1`/`$2` placeholders declared under `"placeholders"` exactly like `bookmarksContent_bookmarkCount_other`) and is read with `t()` from `@/hooks/use-translation`.
- Dialogs keep the standard shadcn structure (no overrides that remove the border or default shadow). Forms that show validation errors use `onSubmit` with `preventDefault`, not a React 19 form `action`.
- Tests live in `test/*.test.ts(x)`. Each file starts with `// @ts-expect-error Bun provides this test module at runtime.` before importing `bun:test`. A test file that swaps a module must restore it in `afterAll` (use `test/helpers/module-replacer.ts`); component tests use `test/helpers/dom-environment.ts`.
- Verification commands: `bun test <file>` for one file, `bun test` for the suite, `bun run compile` for types, `bun run build` and `bun run build:firefox` for bundles.
- The popup and background never load the data stores: code they import must not import `store/bookmarks-store`, `store/workspace-store`, `store/groups-store`, `store/tabs-store`, `store/settings-store`, `store/auth-store`, `store/plan-store`, or a module that does. `useTranslation` (which uses `store/i18n-store`) is already used by the popup and stays allowed.
- Each task ends with a commit whose message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Two independent tasks may land while this plan runs. If `test/helpers/` already holds an equivalent module replacer when Task 1 starts, reuse it and adapt imports instead of duplicating it. If `normalizeUrl` was already fixed when Task 2 starts, follow Task 2's reconciliation step.

## Notes on the Spec

The plan simplifies three details of the spec:

- Tags only get a right-click menu, so their menu items stay in `sidebar/tags-section.tsx`, and the shared menu primitives need only `Item` and `Separator` (no sub-menu parts). The tag delete confirmation lives in `sidebar/`, next to its only user.
- The popup's "Open existing bookmark" opens a new TabSlate tab with the highlight link, like the popup's other links to TabSlate, instead of focusing an open one.
- `deleteTag` keeps its current semantics. The confirmation checks that the tag still exists before calling it, so confirming after another device deleted the tag is a no-op.

## File Structure

New files:

| File | Responsibility |
|---|---|
| `test/helpers/module-replacer.ts` | Swap modules for one test file and restore them; load fresh real copies |
| `test/helpers/dom-environment.ts` | happy-dom setup, real app modules for component tests, interaction helpers |
| `test/helpers/library-fixtures.ts` | Workspace, collection, tag, and bookmark fixture builders |
| `test/fixtures/replaceable-module.ts` | Fixture for the module replacer's own test |
| `lib/url-match.ts` | Strict and loose URL keys; match lookup |
| `lib/duplicate-lookup.ts` | Visibility-aware duplicate matches with their location |
| `lib/view-preferences.ts` | View preference types, parsing, last-write-wins decision, local and server IO |
| `lib/reveal-bookmark.ts` | Switch workspace/collection, clear filters, highlight one bookmark |
| `lib/highlight-link.ts` | The `highlight` deep-link parameter name (store-free, shared with the popup) |
| `lib/context-menu-save.ts` | Decide whether a context-menu save is a duplicate |
| `lib/browser/action-badge.ts` | Flash the toolbar badge after a context-menu save |
| `lib/browser/commands.ts` | Read the bound save shortcut |
| `hooks/use-preference-sync-consent.ts` | Firefox switch state for preference sync |
| `hooks/use-workspace-collection-reset.ts` | Fall back to "All bookmarks" when the selection leaves the workspace |
| `hooks/use-highlight-deep-link.ts` | Handle `#/?highlight=<id>` |
| `components/ui/context-menu.tsx` | shadcn context menu |
| `components/dashboard/shared/menu-primitives.tsx` | Item/Separator sets for dropdown and context menus |
| `components/dashboard/shared/collection-menu-items.tsx` | Collection menu items |
| `components/dashboard/shared/bookmark-menu-items.tsx` | Bookmark card menu items |
| `components/dashboard/shared/duplicate-notice.tsx` | "Already saved in…" notice |
| `components/dashboard/sidebar/section-header.tsx` | Collapsible sidebar section header (moved) |
| `components/dashboard/sidebar/tags-section.tsx` | Sidebar tag chips, counts, search, tag menu, tag dialogs |
| `components/dashboard/sidebar/tag-delete-dialog.tsx` | Tag deletion confirmation |
| `components/dashboard/sidebar/collection-row.tsx` | Sidebar collection row with ⋯ and right-click menus and edit dialog |

Modified files: `lib/bookmark-utils.ts`, `lib/storage.ts`, `lib/browser/data-collection-permissions.ts`, `lib/browser/data-collection.ts`, `store/bookmarks-store.ts`, `store/settings-store.ts`, `entrypoints/newtab/App.tsx`, `entrypoints/popup/App.tsx`, `entrypoints/background.ts`, `components/dashboard/settings-dialog.tsx`, `components/dashboard/sidebar/index.tsx`, `components/dashboard/sidebar/tag-dialog.tsx`, `components/dashboard/sidebar/collection-dialog.tsx`, `components/dashboard/shared/bookmark-tags-dialog.tsx`, `components/dashboard/bookmark-card.tsx`, `components/ui/tag-list.tsx`, `components/dashboard/add-bookmark-dialog.tsx`, `components/dashboard/content.tsx`, `wxt.config.ts`, `test/wxt-config.test.ts`, `test/data-collection.test.ts`, both `messages.json`, `CLAUDE.md`, `ARCHITECTURE.md`.

---

### Task 1: Test helpers

**Files:**
- Create: `test/helpers/module-replacer.ts`
- Create: `test/helpers/dom-environment.ts`
- Create: `test/helpers/library-fixtures.ts`
- Create: `test/fixtures/replaceable-module.ts`
- Test: `test/module-replacer.test.ts`

**Interfaces:**
- Produces: `createModuleReplacer(): ModuleReplacer` (`replace(specifier, replacement): Promise<void>`, `restore(): void`); `importFresh<T>(repoPath: string): Promise<T>`; `setupDom()`, `teardownDom()`, `translateKey(key, substitutions?)`, `installAppModules(replacer): Promise<AppModules>` with `AppModules { createRoot, useBookmarksStore, useWorkspaceStore }`; `render(app, element): RenderResult` (`container`, `rerender`, `unmount`); `click`, `rightClick`, `openDropdown`, `pressKey`, `typeInto`, `submitForm` (async), `wait(ms)` (async), `queryByText`, `getByText`, `getBySelector`; fixtures `makeWorkspace`, `makeCollection`, `makeTag`, `makeBookmark`, `bookmarkMap`, `countsByCollection`.

- [x] **Step 1: Write the fixture module and the failing test**

`test/fixtures/replaceable-module.ts`:

```ts
export const value = "original";
```

`test/module-replacer.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";

const FIXTURE = "@/test/fixtures/replaceable-module";

describe("createModuleReplacer", () => {
  test("restores the exports registered before the replacement", async () => {
    const replacer = createModuleReplacer();
    await replacer.replace(FIXTURE, { value: "replacement" });
    expect((await import(FIXTURE)).value).toBe("replacement");

    replacer.restore();

    expect((await import(FIXTURE)).value).toBe("original");
  });

  test("importFresh loads the real module while a replacement is registered", async () => {
    const replacer = createModuleReplacer();
    await replacer.replace(FIXTURE, { value: "replacement" });

    const fresh = await importFresh<typeof import("@/test/fixtures/replaceable-module")>(
      "test/fixtures/replaceable-module.ts",
    );

    expect(fresh.value).toBe("original");
    replacer.restore();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/module-replacer.test.ts`
Expected: FAIL — `Cannot find module './helpers/module-replacer'`.

- [x] **Step 3: Implement the helpers**

`test/helpers/module-replacer.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { mock } from "bun:test";

/**
 * Bun keeps module mocks for the whole run and patches modules that are
 * already loaded in place, so a test file that swaps a module must put the
 * previous exports back when it finishes. Bun also ignores a module namespace
 * returned from a mock factory, so replacements are handed over as plain
 * object copies. Specifiers must be `@/` aliases or package names.
 */
export interface ModuleReplacer {
  replace: (specifier: string, replacement: object) => Promise<void>;
  restore: () => void;
}

export function createModuleReplacer(): ModuleReplacer {
  const previous: Array<readonly [string, object]> = [];
  return {
    async replace(specifier, replacement) {
      previous.push([specifier, { ...(await import(specifier)) }]);
      mock.module(specifier, () => ({ ...replacement }));
    },
    restore() {
      for (const [specifier, exports] of [...previous].reverse()) {
        mock.module(specifier, () => exports);
      }
      previous.length = 0;
    },
  };
}

let freshImportCount = 0;

/**
 * Loads a fresh copy of a module, given its path from the repository root.
 * The query string bypasses any mock another test file registered for the
 * same path; the copy's own imports still resolve through the registry.
 */
export async function importFresh<T>(repoPath: string): Promise<T> {
  freshImportCount += 1;
  return await import(`../../${repoPath}?fresh=${freshImportCount}`);
}
```

`test/helpers/dom-environment.ts`:

```ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { StateStorage } from "zustand/middleware";
import { importFresh, type ModuleReplacer } from "./module-replacer";

/** Registers happy-dom for a component test file. teardownDom is safe after a partial setup. */
export function setupDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  // Store modules open IndexedDB while loading. A request that never settles keeps persistence inert.
  Reflect.set(globalThis, "indexedDB", { open: () => ({}) });
}

export async function teardownDom(): Promise<void> {
  Reflect.deleteProperty(globalThis, "indexedDB");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
}

/** Test translation: the key, followed by its substitutions in brackets, e.g. "tagDeleteDialog_desc[3]". */
export function translateKey(key: string, substitutions?: string | string[]): string {
  if (substitutions === undefined) {
    return key;
  }
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  return `${key}[${values.join(",")}]`;
}

export interface AppModules {
  createRoot: typeof import("react-dom/client").createRoot;
  useBookmarksStore: typeof import("@/store/bookmarks-store").useBookmarksStore;
  useWorkspaceStore: typeof import("@/store/workspace-store").useWorkspaceStore;
}

function createMemoryStorage(): StateStorage {
  const items = new Map<string, string>();
  return {
    getItem: async (name) => items.get(name) ?? null,
    setItem: async (name, value) => {
      items.set(name, value);
    },
    removeItem: async (name) => {
      items.delete(name);
    },
  };
}

/**
 * Points the modules most component tests render through at fresh real copies
 * (other test files leave partial fakes registered) and stubs translations.
 * Each store is registered before the next one loads, so every copy links
 * against complete modules. The plan store persists through chrome.storage,
 * which tests don't have, so it gets an in-memory adapter.
 */
export async function installAppModules(replacer: ModuleReplacer): Promise<AppModules> {
  const reactDomClient = await importFresh<typeof import("react-dom/client")>("node_modules/react-dom/client.js");
  await replacer.replace("react-dom/client", reactDomClient);
  await replacer.replace("@/hooks/use-translation", {
    useTranslation: () => ({
      t: translateKey,
      tNode: (_key: string, node: ReactNode) => node,
      language: "en",
    }),
  });
  await replacer.replace("@/lib/chrome-storage-adapter", { chromeStorageAdapter: createMemoryStorage() });
  await replacer.replace(
    "@/store/plan-store",
    await importFresh<typeof import("@/store/plan-store")>("store/plan-store.ts"),
  );
  const bookmarksStore = await importFresh<typeof import("@/store/bookmarks-store")>("store/bookmarks-store.ts");
  await replacer.replace("@/store/bookmarks-store", bookmarksStore);
  const workspaceStore = await importFresh<typeof import("@/store/workspace-store")>("store/workspace-store.ts");
  await replacer.replace("@/store/workspace-store", workspaceStore);
  await replacer.replace(
    "@/store/i18n-store",
    await importFresh<typeof import("@/store/i18n-store")>("store/i18n-store.ts"),
  );
  return {
    createRoot: reactDomClient.createRoot,
    useBookmarksStore: bookmarksStore.useBookmarksStore,
    useWorkspaceStore: workspaceStore.useWorkspaceStore,
  };
}

export interface RenderResult {
  container: HTMLElement;
  rerender: (element: ReactNode) => void;
  unmount: () => void;
}

export function render(app: Pick<AppModules, "createRoot">, element: ReactNode): RenderResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = app.createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    rerender: (next) => {
      act(() => {
        root.render(next);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
}

export function rightClick(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 8, clientY: 8 }));
  });
}

/** Radix dropdown triggers open on pointerdown, not click. */
export function openDropdown(trigger: Element): void {
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  });
}

export function pressKey(element: Element, key: string): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
  });
}

export function typeInto(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

export async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export function queryByText(text: string, root: ParentNode = document.body): HTMLElement | null {
  const matches = Array.from(root.querySelectorAll<HTMLElement>("*")).filter(
    (element) => element.textContent?.trim() === text,
  );
  return matches.at(-1) ?? null;
}

export function getByText(text: string, root: ParentNode = document.body): HTMLElement {
  const element = queryByText(text, root);
  if (!element) {
    throw new Error(`No element with text "${text}"`);
  }
  return element;
}

export function getBySelector<T extends Element = HTMLElement>(selector: string, root: ParentNode = document.body): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`No element matches ${selector}`);
  }
  return element;
}
```

`test/helpers/library-fixtures.ts`:

```ts
import type { Bookmark, Collection, Tag, Workspace } from "@/lib/types";

export function makeWorkspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return { id, name: id, color: "blue", position: 0, seq: 0, ...overrides };
}

export function makeCollection(id: string, workspaceId: string, overrides: Partial<Collection> = {}): Collection {
  return { id, workspaceId, name: id, icon: "folder", position: 0, seq: 0, ...overrides };
}

export function makeTag(id: string, name: string, overrides: Partial<Tag> = {}): Tag {
  return { id, name, color: "bg-blue-500/10 text-blue-500", seq: 0, ...overrides };
}

export function makeBookmark(id: string, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id,
    title: id,
    url: `https://example.com/${id}`,
    description: "",
    favicon: "",
    collectionId: "",
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    isFavorite: false,
    seq: 0,
    ...overrides,
  };
}

export function bookmarkMap(bookmarks: readonly Bookmark[]): Map<string, Bookmark> {
  return new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));
}

/** Store setup only: the per-collection counts the bookmarks store keeps alongside its map. */
export function countsByCollection(bookmarks: readonly Bookmark[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const bookmark of bookmarks) {
    counts[bookmark.collectionId] = (counts[bookmark.collectionId] ?? 0) + 1;
  }
  return counts;
}
```

- [x] **Step 4: Run the tests and type check**

Run: `bun test test/module-replacer.test.ts && bun run compile`
Expected: 2 pass, 0 fail; `tsc --noEmit` exits 0.

- [x] **Step 5: Commit**

```bash
git add test/helpers test/fixtures/replaceable-module.ts test/module-replacer.test.ts
git commit -m "test: add module replacement and DOM helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: URL matching tiers

**Files:**
- Create: `lib/url-match.ts`
- Modify: `lib/bookmark-utils.ts` (`normalizeUrl`)
- Test: `test/url-match.test.ts`

**Interfaces:**
- Consumes: `importFresh`, `makeBookmark` (Task 1).
- Produces: `type UrlMatchTier = "strict" | "loose"`; `strictUrlKey(url: string): string`; `looseUrlKey(url: string): string`; `urlMatchKey(url: string, tier: UrlMatchTier): string`; `findUrlMatches(url: string, bookmarks: readonly Bookmark[], tier: UrlMatchTier): Bookmark[]`. `normalizeUrl` returns `strictUrlKey(url)`.

- [x] **Step 0: Reconcile with the standalone fix**

Run: `git log --oneline -- lib/bookmark-utils.ts | head -3` and read `normalizeUrl`. If it no longer lowercases the whole URL, keep that fix's tests, and still make `normalizeUrl` delegate to `strictUrlKey` in Step 3 so both share one rule.

- [x] **Step 1: Write the failing test**

`test/url-match.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";
import { makeBookmark } from "./helpers/library-fixtures";

// Other test files register partial fakes for lib/bookmark-utils; load real copies.
const { strictUrlKey, looseUrlKey, findUrlMatches } =
  await importFresh<typeof import("@/lib/url-match")>("lib/url-match.ts");
const { findDuplicateBookmark } =
  await importFresh<typeof import("@/lib/bookmark-utils")>("lib/bookmark-utils.ts");

describe("strictUrlKey", () => {
  const same: Array<[string, string]> = [
    ["HTTPS://Example.COM/Path", "https://example.com/Path"],
    ["https://example.com:443/a", "https://example.com/a"],
    ["http://example.com:80/a", "http://example.com/a"],
    ["https://example.com/docs/", "https://example.com/docs"],
    ["https://example.com/", "https://example.com"],
    ["  not a url ", "not a url"],
  ];
  const different: Array<[string, string]> = [
    ["https://bit.ly/3AbCd", "https://bit.ly/3abcd"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dqw4w9wgxcq"],
    ["https://app.example.com/#/inbox", "https://app.example.com/#/sent"],
    ["http://example.com/a", "https://example.com/a"],
    ["https://www.example.com/a", "https://example.com/a"],
    ["https://example.com:8443/a", "https://example.com/a"],
  ];

  for (const [a, b] of same) {
    test(`treats ${a} and ${b} as the same address`, () => {
      expect(strictUrlKey(a)).toBe(strictUrlKey(b));
    });
  }
  for (const [a, b] of different) {
    test(`keeps ${a} and ${b} apart`, () => {
      expect(strictUrlKey(a)).not.toBe(strictUrlKey(b));
    });
  }
  test("lowercases only the scheme and host", () => {
    expect(strictUrlKey("HTTPS://Example.COM:443/Docs/?q=A#Top")).toBe("https://example.com/Docs?q=A#Top");
  });
});

describe("looseUrlKey", () => {
  const same: Array<[string, string]> = [
    ["http://example.com/a", "https://example.com/a"],
    ["https://www.example.com/a", "https://example.com/a"],
    ["https://example.com/a?utm_source=news&id=7", "https://example.com/a?id=7"],
    ["https://example.com/a?fbclid=abc", "https://example.com/a"],
    ["https://example.com/a#section", "https://example.com/a"],
    ["https://example.com/a/", "https://example.com/a"],
  ];
  const different: Array<[string, string]> = [
    ["https://bit.ly/3AbCd", "https://bit.ly/3abcd"],
    ["https://example.com/a?id=7", "https://example.com/a?id=8"],
    ["https://example.com/a", "https://example.org/a"],
  ];

  for (const [a, b] of same) {
    test(`treats ${a} and ${b} as the same page`, () => {
      expect(looseUrlKey(a)).toBe(looseUrlKey(b));
    });
  }
  for (const [a, b] of different) {
    test(`keeps ${a} and ${b} apart`, () => {
      expect(looseUrlKey(a)).not.toBe(looseUrlKey(b));
    });
  }
  test("drops the scheme, www, fragment and tracking parameters", () => {
    expect(looseUrlKey("http://www.Example.com/Docs/?utm_medium=x&q=A#top")).toBe("example.com/Docs?q=A");
  });
});

describe("findUrlMatches", () => {
  const bookmarks = [
    makeBookmark("exact", { url: "https://example.com/post" }),
    makeBookmark("tracked", { url: "http://www.example.com/post?utm_source=feed" }),
    makeBookmark("other", { url: "https://example.com/other" }),
  ];

  test("the strict tier only finds the same address", () => {
    expect(findUrlMatches("https://example.com/post/", bookmarks, "strict").map((b) => b.id)).toEqual(["exact"]);
  });
  test("the loose tier also finds scheme, www and tracking variants", () => {
    expect(findUrlMatches("https://example.com/post", bookmarks, "loose").map((b) => b.id)).toEqual(["exact", "tracked"]);
  });
});

describe("findDuplicateBookmark", () => {
  test("does not treat links that differ only in path case as duplicates", () => {
    const shortLink = makeBookmark("short", { url: "https://bit.ly/3AbCd" });
    expect(findDuplicateBookmark([shortLink], "https://bit.ly/3abcd")).toBeUndefined();
  });
  test("still matches the same address with a different host case and trailing slash", () => {
    const docs = makeBookmark("docs", { url: "https://Example.com/docs/" });
    expect(findDuplicateBookmark([docs], "https://example.com/docs")?.id).toBe("docs");
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/url-match.test.ts`
Expected: FAIL — `Cannot find module` for `lib/url-match.ts`.

- [x] **Step 3: Implement `lib/url-match.ts` and switch `normalizeUrl`**

`lib/url-match.ts`:

```ts
import type { Bookmark } from "@/lib/types";

/**
 * "strict" blocks a save, so it only ignores differences that never change the
 * page: scheme and host case, a default port, a trailing slash. Path, query and
 * fragment keep their case (short links and video IDs are case-sensitive).
 * "loose" only produces a warning, so it also ignores http/https, a leading
 * www., the fragment and tracking parameters.
 */
export type UrlMatchTier = "strict" | "loose";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "yclid",
  "_hsenc",
  "_hsmi",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

function parseWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function strictUrlKey(url: string): string {
  const parsed = parseWebUrl(url);
  if (!parsed) {
    return url.trim();
  }
  // URL already lowercases the scheme and host and drops default ports.
  return `${parsed.protocol}//${parsed.host}${trimTrailingSlash(parsed.pathname)}${parsed.search}${parsed.hash}`;
}

export function looseUrlKey(url: string): string {
  const parsed = parseWebUrl(url);
  if (!parsed) {
    return url.trim();
  }
  const host = parsed.host.startsWith("www.") ? parsed.host.slice(4) : parsed.host;
  const params = new URLSearchParams(parsed.search);
  for (const name of Array.from(params.keys())) {
    if (isTrackingParam(name)) {
      params.delete(name);
    }
  }
  const query = params.toString();
  return `${host}${trimTrailingSlash(parsed.pathname)}${query ? `?${query}` : ""}`;
}

export function urlMatchKey(url: string, tier: UrlMatchTier): string {
  return tier === "strict" ? strictUrlKey(url) : looseUrlKey(url);
}

export function findUrlMatches(url: string, bookmarks: readonly Bookmark[], tier: UrlMatchTier): Bookmark[] {
  const key = urlMatchKey(url, tier);
  return bookmarks.filter((bookmark) => !!bookmark.url && urlMatchKey(bookmark.url, tier) === key);
}
```

In `lib/bookmark-utils.ts`, add `import { strictUrlKey } from "@/lib/url-match";` below the existing type import and replace:

```ts
/** Remove trailing slash and lowercase for URL comparison. */
export function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/\/$/, "");
}
```

with:

```ts
/** Key used to detect duplicate saves; lib/url-match.ts documents the rules. */
export function normalizeUrl(url: string): string {
  return strictUrlKey(url);
}
```

- [x] **Step 4: Run the tests**

Run: `bun test test/url-match.test.ts && bun test && bun run compile`
Expected: all url-match tests pass; the full suite has 0 failures; compile exits 0.

- [x] **Step 5: Commit**

```bash
git add lib/url-match.ts lib/bookmark-utils.ts test/url-match.test.ts
git commit -m "fix(bookmarks): compare URLs case-sensitively except scheme and host

Duplicate detection lowercased the whole URL, so links that differ only in
path case (short links, video IDs) were skipped as duplicates. Add strict
and loose matching tiers and use the strict one for blocking.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Visible duplicate lookup

**Files:**
- Create: `lib/duplicate-lookup.ts`
- Test: `test/duplicate-lookup.test.ts`

**Interfaces:**
- Consumes: `urlMatchKey`, `UrlMatchTier` (Task 2); `isActiveWorkspace` from `@/lib/workspace-visibility`.
- Produces: `interface BookmarkLibrary { bookmarks; collections; workspaces }` (readonly arrays); `interface DuplicateMatch { bookmark: Bookmark; collection: Collection | null; workspace: Workspace | null }`; `findVisibleDuplicates(url: string, library: BookmarkLibrary, tier: UrlMatchTier, options?: { workspaceId?: string }): DuplicateMatch[]`.

- [x] **Step 1: Write the failing test**

`test/duplicate-lookup.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";
import { makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const { findVisibleDuplicates } =
  await importFresh<typeof import("@/lib/duplicate-lookup")>("lib/duplicate-lookup.ts");

const POST = "https://example.com/post";
const library = {
  workspaces: [makeWorkspace("home"), makeWorkspace("work"), makeWorkspace("retired", { deletedAt: 1 })],
  collections: [
    makeCollection("reading", "home"),
    makeCollection("old", "home", { archivedAt: 1 }),
    makeCollection("binned", "home", { deletedAt: 1 }),
    makeCollection("projects", "work"),
    makeCollection("hidden", "retired"),
  ],
  bookmarks: [
    makeBookmark("in-reading", { collectionId: "reading", url: POST }),
    makeBookmark("in-archived-collection", { collectionId: "old", url: POST }),
    makeBookmark("in-trashed-collection", { collectionId: "binned", url: POST }),
    makeBookmark("in-projects", { collectionId: "projects", url: "http://www.example.com/post?utm_source=feed" }),
    makeBookmark("in-retired-workspace", { collectionId: "hidden", url: POST }),
    makeBookmark("uncategorized", { collectionId: "", url: POST }),
    makeBookmark("different-page", { collectionId: "reading", url: "https://example.com/other" }),
  ],
};

describe("findVisibleDuplicates", () => {
  test("returns visible matches with their location", () => {
    const matches = findVisibleDuplicates(POST, library, "loose");
    expect(matches.map((m) => [m.bookmark.id, m.collection?.id ?? null, m.workspace?.id ?? null])).toEqual([
      ["in-reading", "reading", "home"],
      ["in-projects", "projects", "work"],
      ["uncategorized", null, null],
    ]);
  });

  test("the strict tier skips scheme and tracking variants", () => {
    expect(findVisibleDuplicates(POST, library, "strict").map((m) => m.bookmark.id)).toEqual([
      "in-reading",
      "uncategorized",
    ]);
  });

  test("can be limited to one workspace plus uncategorized bookmarks", () => {
    expect(
      findVisibleDuplicates(POST, library, "loose", { workspaceId: "work" }).map((m) => m.bookmark.id),
    ).toEqual(["in-projects", "uncategorized"]);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/duplicate-lookup.test.ts`
Expected: FAIL — `Cannot find module` for `lib/duplicate-lookup.ts`.

- [x] **Step 3: Implement `lib/duplicate-lookup.ts`**

```ts
import type { Bookmark, Collection, Workspace } from "@/lib/types";
import { isActiveWorkspace } from "@/lib/workspace-visibility";
import { urlMatchKey, type UrlMatchTier } from "@/lib/url-match";

export interface BookmarkLibrary {
  bookmarks: readonly Bookmark[];
  collections: readonly Collection[];
  workspaces: readonly Workspace[];
}

export interface DuplicateMatch {
  bookmark: Bookmark;
  /** null for an uncategorized bookmark */
  collection: Collection | null;
  workspace: Workspace | null;
}

export interface DuplicateLookupOptions {
  /** Only consider this workspace's collections (uncategorized bookmarks always count). */
  workspaceId?: string;
}

/**
 * Finds active bookmarks with the same address. Bookmarks under an archived or
 * trashed collection, or a retained (deleted) workspace, are never matched:
 * normal UI must not expose them.
 */
export function findVisibleDuplicates(
  url: string,
  library: BookmarkLibrary,
  tier: UrlMatchTier,
  options: DuplicateLookupOptions = {},
): DuplicateMatch[] {
  const key = urlMatchKey(url, tier);
  const collectionsById = new Map(library.collections.map((collection) => [collection.id, collection]));
  const workspacesById = new Map(library.workspaces.map((workspace) => [workspace.id, workspace]));
  const matches: DuplicateMatch[] = [];

  for (const bookmark of library.bookmarks) {
    if (!bookmark.url || urlMatchKey(bookmark.url, tier) !== key) {
      continue;
    }
    if (bookmark.collectionId === "") {
      matches.push({ bookmark, collection: null, workspace: null });
      continue;
    }
    const collection = collectionsById.get(bookmark.collectionId);
    if (!collection || collection.deletedAt || collection.archivedAt) {
      continue;
    }
    if (options.workspaceId !== undefined && collection.workspaceId !== options.workspaceId) {
      continue;
    }
    const workspace = workspacesById.get(collection.workspaceId);
    if (!isActiveWorkspace(workspace)) {
      continue;
    }
    matches.push({ bookmark, collection, workspace });
  }
  return matches;
}
```

- [x] **Step 4: Run the test**

Run: `bun test test/duplicate-lookup.test.ts && bun run compile`
Expected: 3 pass, 0 fail; compile exits 0.

- [x] **Step 5: Commit**

```bash
git add lib/duplicate-lookup.ts test/duplicate-lookup.test.ts
git commit -m "feat(bookmarks): look up visible duplicates with their location

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Firefox settings consent

**Files:**
- Modify: `lib/browser/data-collection-permissions.ts`
- Modify: `lib/browser/data-collection.ts`
- Modify: `wxt.config.ts`
- Test: `test/data-collection.test.ts`, `test/wxt-config.test.ts`

**Interfaces:**
- Produces: `FIREFOX_SETTINGS_DATA_COLLECTION` (`["technicalAndInteraction"]`); `hasSettingsSyncConsent(): Promise<boolean>`; `requestSettingsSyncConsent(): Promise<boolean>`; `removeSettingsSyncConsent(): Promise<boolean>`.

- [x] **Step 1: Write the failing tests**

Append to `test/data-collection.test.ts` (the file already defines `useBuild`, `stubPermissions`, `importDataCollectionModule` and restores `chrome` after each test):

```ts
const SETTINGS_DATA_COLLECTION = { data_collection: ["technicalAndInteraction"] };

describe("settings sync consent", () => {
  test("Chromium builds always allow it and never touch the permissions API", async () => {
    useBuild("chrome");
    const contains = mock(async () => false);
    const request = mock(async () => false);
    const remove = mock(async () => false);
    stubPermissions({ contains, request, remove });

    const { hasSettingsSyncConsent, requestSettingsSyncConsent, removeSettingsSyncConsent } =
      await importDataCollectionModule();

    expect(await hasSettingsSyncConsent()).toBe(true);
    expect(await requestSettingsSyncConsent()).toBe(true);
    expect(await removeSettingsSyncConsent()).toBe(true);
    expect(contains).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("Firefox builds check, request and remove only technicalAndInteraction", async () => {
    useBuild("firefox");
    const contains = mock(async () => false);
    const request = mock(async () => true);
    const remove = mock(async () => true);
    stubPermissions({ contains, request, remove });

    const { hasSettingsSyncConsent, requestSettingsSyncConsent, removeSettingsSyncConsent } =
      await importDataCollectionModule();

    expect(await hasSettingsSyncConsent()).toBe(false);
    expect(await requestSettingsSyncConsent()).toBe(true);
    expect(await removeSettingsSyncConsent()).toBe(true);
    expect(contains).toHaveBeenCalledWith(SETTINGS_DATA_COLLECTION);
    expect(request).toHaveBeenCalledWith(SETTINGS_DATA_COLLECTION);
    expect(remove).toHaveBeenCalledWith(SETTINGS_DATA_COLLECTION);
  });

  test("Firefox settings consent fails closed when the permissions API errors", async () => {
    useBuild("firefox");
    stubPermissions({
      contains: mock(async () => {
        throw new Error("permissions unavailable");
      }),
    });

    const { hasSettingsSyncConsent } = await importDataCollectionModule();

    expect(await hasSettingsSyncConsent()).toBe(false);
  });
});
```

In `test/wxt-config.test.ts`, change the expected `optional` list in "adds Firefox gecko metadata for MV3" to:

```ts
      optional: [
        "authenticationInfo",
        "personallyIdentifyingInfo",
        "searchTerms",
        "websiteContent",
        // Only sent once the user turns on view-preference sync (lib/browser/data-collection.ts).
        "technicalAndInteraction",
      ],
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun test test/data-collection.test.ts test/wxt-config.test.ts`
Expected: FAIL — `hasSettingsSyncConsent is not a function`, and the manifest `optional` list lacks `technicalAndInteraction`.

- [x] **Step 3: Implement**

Append to `lib/browser/data-collection-permissions.ts`:

```ts
/**
 * Sent to the sync server only when the user turns it on (Firefox's install
 * prompt, about:addons, or TabSlate's settings): the bookmark view mode and
 * sort order synced through /preferences. Mozilla files extension settings
 * data under this category.
 */
export const FIREFOX_SETTINGS_DATA_COLLECTION: readonly FirefoxDataCollectionPermission[] = [
  "technicalAndInteraction",
];
```

In `lib/browser/data-collection.ts`, extend the import to `import { FIREFOX_ACCOUNT_DATA_COLLECTION, FIREFOX_SETTINGS_DATA_COLLECTION } from "@/lib/browser/data-collection-permissions";` and append:

```ts
function settingsDataCollection(): chrome.permissions.Permissions {
  return { data_collection: [...FIREFOX_SETTINGS_DATA_COLLECTION] };
}

/**
 * Whether view preferences may sync to the server. Always true outside
 * Firefox; fails closed if Firefox can't answer.
 */
export async function hasSettingsSyncConsent(): Promise<boolean> {
  if (!isFirefoxBuild()) {
    return true;
  }

  try {
    return await chrome.permissions.contains(settingsDataCollection());
  } catch {
    return false;
  }
}

/**
 * Shows Firefox's prompt for syncing view preferences. Call it synchronously
 * from a user input handler, before any await.
 */
export function requestSettingsSyncConsent(): Promise<boolean> {
  if (!isFirefoxBuild()) {
    return Promise.resolve(true);
  }

  return chrome.permissions.request(settingsDataCollection());
}

/** Withdraws the consent for syncing view preferences. */
export async function removeSettingsSyncConsent(): Promise<boolean> {
  if (!isFirefoxBuild()) {
    return true;
  }

  try {
    return await chrome.permissions.remove(settingsDataCollection());
  } catch {
    return false;
  }
}
```

In `wxt.config.ts`, extend the import with `FIREFOX_SETTINGS_DATA_COLLECTION` and replace:

```ts
              // What leaves the browser is documented next to each list in
              // lib/browser/data-collection-permissions.ts. Analytics is not
              // declared because Firefox builds never send it (lib/analytics.ts).
              data_collection_permissions: {
                required: [...FIREFOX_REQUIRED_DATA_COLLECTION],
                optional: [...FIREFOX_ACCOUNT_DATA_COLLECTION],
              },
```

with:

```ts
              // What leaves the browser is documented next to each list in
              // lib/browser/data-collection-permissions.ts. technicalAndInteraction
              // covers synced view preferences only; Firefox builds never send
              // analytics (lib/analytics.ts).
              data_collection_permissions: {
                required: [...FIREFOX_REQUIRED_DATA_COLLECTION],
                optional: [...FIREFOX_ACCOUNT_DATA_COLLECTION, ...FIREFOX_SETTINGS_DATA_COLLECTION],
              },
```

- [x] **Step 4: Run the tests**

Run: `bun test test/data-collection.test.ts test/wxt-config.test.ts && bun run compile`
Expected: all pass; compile exits 0.

- [x] **Step 5: Commit**

```bash
git add lib/browser/data-collection-permissions.ts lib/browser/data-collection.ts wxt.config.ts test/data-collection.test.ts test/wxt-config.test.ts
git commit -m "feat(firefox): declare optional consent for syncing view preferences

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: View preference model

**Files:**
- Create: `lib/view-preferences.ts`
- Test: `test/view-preferences.test.ts`

**Interfaces:**
- Consumes: `idbGet`, `idbPut` (`@/lib/idb`); `getPreferences`, `updatePreferences` (`@/lib/api`).
- Produces: `type BookmarkViewMode = "grid" | "list"`; `type BookmarkSortBy = "date-newest" | "date-oldest" | "alpha-az" | "alpha-za"`; `interface BookmarkViewPrefs { viewMode; sortBy; updatedAt: number }`; `interface StoredViewPrefs extends BookmarkViewPrefs { dirty: boolean }`; `interface PreferenceCredentials { baseUrl: string; accessToken: string }`; `type PullAction = "apply-remote" | "push-local" | "none"`; constants `VIEW_PREFS_KV_KEY = "bookmark-view-prefs"`, `VIEW_PREFS_SERVER_KEY = "bookmarkView"`, `DEFAULT_VIEW_MODE`, `DEFAULT_SORT_BY`; functions `parseViewPrefs(value: unknown): BookmarkViewPrefs | null`, `resolvePullAction(local, remote): PullAction`, `readLocalViewPrefs(): Promise<StoredViewPrefs | null>`, `writeLocalViewPrefs(prefs: StoredViewPrefs): Promise<void>`, `fetchRemoteViewPrefs(credentials): Promise<BookmarkViewPrefs | null>`, `pushViewPrefs(credentials, prefs: BookmarkViewPrefs): Promise<void>`.

- [x] **Step 1: Write the failing test**

`test/view-preferences.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import type { BookmarkViewPrefs, PullAction, StoredViewPrefs } from "@/lib/view-preferences";

const kv = new Map<string, unknown>();
let serverPreferences: Record<string, unknown> = {};
const updateCalls: Array<Record<string, unknown>> = [];
const credentials = { baseUrl: "https://sync.example.com", accessToken: "token" };
const replacer = createModuleReplacer();
let viewPrefs: typeof import("@/lib/view-preferences");

beforeAll(async () => {
  const realIdb = await importFresh<typeof import("@/lib/idb")>("lib/idb.ts");
  const realApi = await importFresh<typeof import("@/lib/api")>("lib/api.ts");
  await replacer.replace("@/lib/idb", {
    ...realIdb,
    idbGet: async (_store: string, key: string) => (kv.has(key) ? { key, value: kv.get(key) } : undefined),
    idbPut: async (_store: string, record: { key: string; value: unknown }) => {
      kv.set(record.key, record.value);
    },
  });
  await replacer.replace("@/lib/api", {
    ...realApi,
    getPreferences: async () => structuredClone(serverPreferences),
    updatePreferences: async (_baseUrl: string, _token: string, preferences: Record<string, unknown>) => {
      updateCalls.push(preferences);
      serverPreferences = structuredClone(preferences);
    },
  });
  viewPrefs = await importFresh<typeof import("@/lib/view-preferences")>("lib/view-preferences.ts");
});

afterAll(() => {
  replacer.restore();
});

beforeEach(() => {
  kv.clear();
  serverPreferences = {};
  updateCalls.length = 0;
});

describe("parseViewPrefs", () => {
  test("keeps valid values", () => {
    expect(viewPrefs.parseViewPrefs({ viewMode: "list", sortBy: "alpha-za", updatedAt: 42 })).toEqual({
      viewMode: "list",
      sortBy: "alpha-za",
      updatedAt: 42,
    });
  });
  test("falls back to defaults for values it does not know", () => {
    expect(viewPrefs.parseViewPrefs({ viewMode: "masonry", sortBy: "random" })).toEqual({
      viewMode: "grid",
      sortBy: "date-newest",
      updatedAt: 0,
    });
  });
  test("returns null when there is no preferences object", () => {
    expect(viewPrefs.parseViewPrefs("list")).toBeNull();
    expect(viewPrefs.parseViewPrefs(undefined)).toBeNull();
  });
});

describe("resolvePullAction", () => {
  const local = (updatedAt: number, dirty: boolean): StoredViewPrefs => ({
    viewMode: "list",
    sortBy: "alpha-az",
    updatedAt,
    dirty,
  });
  const remote = (updatedAt: number): BookmarkViewPrefs => ({ viewMode: "grid", sortBy: "date-oldest", updatedAt });
  const cases: Array<[string, StoredViewPrefs | null, BookmarkViewPrefs | null, PullAction]> = [
    ["nothing anywhere", null, null, "none"],
    ["only local", local(5, false), null, "push-local"],
    ["only remote", null, remote(5), "apply-remote"],
    ["remote newer", local(5, false), remote(9), "apply-remote"],
    ["remote newer than an unpushed local change", local(5, true), remote(9), "apply-remote"],
    ["local newer", local(9, false), remote(5), "push-local"],
    ["same time, local unpushed", local(5, true), remote(5), "push-local"],
    ["same time, in sync", local(5, false), remote(5), "none"],
  ];
  for (const [name, localPrefs, remotePrefs, expected] of cases) {
    test(name, () => {
      expect(viewPrefs.resolvePullAction(localPrefs, remotePrefs)).toBe(expected);
    });
  }
});

describe("local preferences", () => {
  test("round-trip through the kv store", async () => {
    const prefs: StoredViewPrefs = { viewMode: "list", sortBy: "alpha-az", updatedAt: 7, dirty: true };
    await viewPrefs.writeLocalViewPrefs(prefs);
    expect(await viewPrefs.readLocalViewPrefs()).toEqual(prefs);
  });
  test("ignore a stored value that is not a preferences object", async () => {
    kv.set("bookmark-view-prefs", "list");
    expect(await viewPrefs.readLocalViewPrefs()).toBeNull();
  });
});

describe("server preferences", () => {
  test("read the bookmarkView key", async () => {
    serverPreferences = { bookmarkView: { viewMode: "list", sortBy: "alpha-za", updatedAt: 3 } };
    expect(await viewPrefs.fetchRemoteViewPrefs(credentials)).toEqual({
      viewMode: "list",
      sortBy: "alpha-za",
      updatedAt: 3,
    });
  });
  test("push keeps the other keys on the server", async () => {
    serverPreferences = { theme: "dark", bookmarkView: { viewMode: "grid", sortBy: "date-newest", updatedAt: 1 } };
    await viewPrefs.pushViewPrefs(credentials, { viewMode: "list", sortBy: "alpha-az", updatedAt: 9 });
    expect(updateCalls).toEqual([
      { theme: "dark", bookmarkView: { viewMode: "list", sortBy: "alpha-az", updatedAt: 9 } },
    ]);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/view-preferences.test.ts`
Expected: FAIL — `Cannot find module` for `lib/view-preferences.ts`.

- [x] **Step 3: Implement `lib/view-preferences.ts`**

```ts
import { idbGet, idbPut } from "@/lib/idb";
import { getPreferences, updatePreferences } from "@/lib/api";

export type BookmarkViewMode = "grid" | "list";
export type BookmarkSortBy = "date-newest" | "date-oldest" | "alpha-az" | "alpha-za";

const VIEW_MODES: readonly BookmarkViewMode[] = ["grid", "list"];
const SORT_OPTIONS: readonly BookmarkSortBy[] = ["date-newest", "date-oldest", "alpha-az", "alpha-za"];

export const DEFAULT_VIEW_MODE: BookmarkViewMode = "grid";
export const DEFAULT_SORT_BY: BookmarkSortBy = "date-newest";
export const VIEW_PREFS_KV_KEY = "bookmark-view-prefs";
export const VIEW_PREFS_SERVER_KEY = "bookmarkView";

export interface BookmarkViewPrefs {
  viewMode: BookmarkViewMode;
  sortBy: BookmarkSortBy;
  /** Unix ms of the user's last change; the newer side wins. */
  updatedAt: number;
}

export interface StoredViewPrefs extends BookmarkViewPrefs {
  /** The local value has not reached the server yet. */
  dirty: boolean;
}

export interface PreferenceCredentials {
  baseUrl: string;
  accessToken: string;
}

export type PullAction = "apply-remote" | "push-local" | "none";

interface KvRecord {
  key: string;
  value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isViewMode(value: unknown): value is BookmarkViewMode {
  return VIEW_MODES.some((mode) => mode === value);
}

function isSortBy(value: unknown): value is BookmarkSortBy {
  return SORT_OPTIONS.some((option) => option === value);
}

/**
 * Reads a stored or synced value. Values this build doesn't know (older or
 * newer clients) fall back to the defaults instead of failing.
 */
export function parseViewPrefs(value: unknown): BookmarkViewPrefs | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    viewMode: isViewMode(value.viewMode) ? value.viewMode : DEFAULT_VIEW_MODE,
    sortBy: isSortBy(value.sortBy) ? value.sortBy : DEFAULT_SORT_BY,
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

/** Last write wins: the side with the newer updatedAt is kept. */
export function resolvePullAction(local: StoredViewPrefs | null, remote: BookmarkViewPrefs | null): PullAction {
  if (remote === null) {
    return local ? "push-local" : "none";
  }
  if (local === null || remote.updatedAt > local.updatedAt) {
    return "apply-remote";
  }
  if (local.dirty || local.updatedAt > remote.updatedAt) {
    return "push-local";
  }
  return "none";
}

export async function readLocalViewPrefs(): Promise<StoredViewPrefs | null> {
  const record = await idbGet<KvRecord>("kv", VIEW_PREFS_KV_KEY);
  const raw = record?.value;
  const prefs = parseViewPrefs(raw);
  if (!prefs) {
    return null;
  }
  return { ...prefs, dirty: isRecord(raw) && raw.dirty === true };
}

export async function writeLocalViewPrefs(prefs: StoredViewPrefs): Promise<void> {
  await idbPut<KvRecord>("kv", { key: VIEW_PREFS_KV_KEY, value: prefs });
}

export async function fetchRemoteViewPrefs(credentials: PreferenceCredentials): Promise<BookmarkViewPrefs | null> {
  const preferences = await getPreferences(credentials.baseUrl, credentials.accessToken);
  return parseViewPrefs(preferences[VIEW_PREFS_SERVER_KEY]);
}

/** Read-merge-write so other keys in /preferences survive. */
export async function pushViewPrefs(credentials: PreferenceCredentials, prefs: BookmarkViewPrefs): Promise<void> {
  const preferences = await getPreferences(credentials.baseUrl, credentials.accessToken);
  await updatePreferences(credentials.baseUrl, credentials.accessToken, {
    ...preferences,
    [VIEW_PREFS_SERVER_KEY]: { viewMode: prefs.viewMode, sortBy: prefs.sortBy, updatedAt: prefs.updatedAt },
  });
}
```

- [x] **Step 4: Run the test**

Run: `bun test test/view-preferences.test.ts && bun run compile`
Expected: all pass; compile exits 0.

- [x] **Step 5: Commit**

```bash
git add lib/view-preferences.ts test/view-preferences.test.ts
git commit -m "feat(preferences): add the bookmark view preference model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Settings store preference sync

**Files:**
- Modify: `store/bookmarks-store.ts` (view and sort types)
- Modify: `store/settings-store.ts`
- Modify: `entrypoints/newtab/App.tsx` (sync effect)
- Test: `test/settings-store-view-prefs.test.ts`

**Interfaces:**
- Consumes: Task 5 exports; `hasSettingsSyncConsent` (Task 4).
- Produces: `useSettingsStore` actions `hydrate()`, `reset()`, `startPreferenceSync(getCredentials: GetPreferenceCredentials): Promise<void>`, `resyncPreferences(): Promise<void>`, `stopPreferenceSync(): void`; `type GetPreferenceCredentials = () => PreferenceCredentials | null`. `pullFromServer` is removed.

- [x] **Step 1: Write the failing test**

`test/settings-store-view-prefs.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { setupDom, teardownDom } from "./helpers/dom-environment";

const kv = new Map<string, unknown>();
let serverPreferences: Record<string, unknown> = {};
let failPushes = false;
const updateCalls: Array<Record<string, unknown>> = [];
const credentials = { baseUrl: "https://sync.example.com", accessToken: "token" };
const replacer = createModuleReplacer();
let useBookmarksStore: typeof import("@/store/bookmarks-store").useBookmarksStore;
let useSettingsStore: typeof import("@/store/settings-store").useSettingsStore;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  setupDom();
  const realEnv = await importFresh<typeof import("@/lib/browser/env")>("lib/browser/env.ts");
  const realIdb = await importFresh<typeof import("@/lib/idb")>("lib/idb.ts");
  const realApi = await importFresh<typeof import("@/lib/api")>("lib/api.ts");
  // A Chromium build needs no consent; test/data-collection.test.ts leaves a Firefox build registered.
  await replacer.replace("@/lib/browser/env", {
    ...realEnv,
    isFirefoxBuild: () => false,
    isChromiumBuild: () => true,
  });
  await replacer.replace("@/lib/idb", {
    ...realIdb,
    idbGet: async (_store: string, key: string) => (kv.has(key) ? { key, value: kv.get(key) } : undefined),
    idbPut: async (_store: string, record: { key: string; value: unknown }) => {
      kv.set(record.key, record.value);
    },
  });
  await replacer.replace("@/lib/api", {
    ...realApi,
    getPreferences: async () => structuredClone(serverPreferences),
    updatePreferences: async (_baseUrl: string, _token: string, preferences: Record<string, unknown>) => {
      if (failPushes) {
        throw new Error("offline");
      }
      updateCalls.push(preferences);
      serverPreferences = structuredClone(preferences);
    },
  });
  const bookmarksStore = await importFresh<typeof import("@/store/bookmarks-store")>("store/bookmarks-store.ts");
  await replacer.replace("@/store/bookmarks-store", bookmarksStore);
  useBookmarksStore = bookmarksStore.useBookmarksStore;
  ({ useSettingsStore } = await importFresh<typeof import("@/store/settings-store")>("store/settings-store.ts"));
});

afterAll(async () => {
  useSettingsStore.getState().stopPreferenceSync();
  replacer.restore();
  await teardownDom();
});

beforeEach(async () => {
  // Resetting the view is a user change to the subscription an earlier test's
  // hydrate left behind. Let it settle, then drop what it wrote and the push it scheduled.
  useBookmarksStore.setState({ viewMode: "grid", sortBy: "date-newest" });
  await flush();
  useSettingsStore.getState().stopPreferenceSync();
  kv.clear();
  serverPreferences = {};
  failPushes = false;
  updateCalls.length = 0;
});

describe("view preference sync", () => {
  test("hydrate applies the locally stored preferences", async () => {
    kv.set("bookmark-view-prefs", { viewMode: "list", sortBy: "alpha-az", updatedAt: 5, dirty: false });

    await useSettingsStore.getState().hydrate();

    expect(useBookmarksStore.getState().viewMode).toBe("list");
    expect(useBookmarksStore.getState().sortBy).toBe("alpha-az");
  });

  test("a user change is stored locally as not yet pushed", async () => {
    await useSettingsStore.getState().hydrate();

    useBookmarksStore.getState().setViewMode("list");
    await flush();

    expect(kv.get("bookmark-view-prefs")).toMatchObject({ viewMode: "list", sortBy: "date-newest", dirty: true });
  });

  test("newer server preferences are applied and not pushed back", async () => {
    await useSettingsStore.getState().hydrate();
    kv.set("bookmark-view-prefs", { viewMode: "grid", sortBy: "date-newest", updatedAt: 50, dirty: false });
    serverPreferences = { bookmarkView: { viewMode: "list", sortBy: "alpha-za", updatedAt: 100 } };

    await useSettingsStore.getState().startPreferenceSync(() => credentials);

    expect(useBookmarksStore.getState().viewMode).toBe("list");
    expect(useBookmarksStore.getState().sortBy).toBe("alpha-za");
    expect(kv.get("bookmark-view-prefs")).toEqual({ viewMode: "list", sortBy: "alpha-za", updatedAt: 100, dirty: false });
    expect(updateCalls).toEqual([]);
  });

  test("newer local preferences are pushed and keep other server keys", async () => {
    kv.set("bookmark-view-prefs", { viewMode: "list", sortBy: "alpha-az", updatedAt: 50, dirty: true });
    serverPreferences = { theme: "dark", bookmarkView: { viewMode: "grid", sortBy: "date-newest", updatedAt: 10 } };

    await useSettingsStore.getState().startPreferenceSync(() => credentials);

    expect(updateCalls).toEqual([
      { theme: "dark", bookmarkView: { viewMode: "list", sortBy: "alpha-az", updatedAt: 50 } },
    ]);
    expect(kv.get("bookmark-view-prefs")).toMatchObject({ dirty: false });
  });

  test("a failed push keeps the local preferences marked as not pushed", async () => {
    kv.set("bookmark-view-prefs", { viewMode: "list", sortBy: "alpha-az", updatedAt: 50, dirty: true });
    failPushes = true;

    await useSettingsStore.getState().startPreferenceSync(() => credentials);

    expect(kv.get("bookmark-view-prefs")).toMatchObject({ dirty: true });
  });

  test("a change during an active session is pushed after the debounce", async () => {
    await useSettingsStore.getState().hydrate();
    await useSettingsStore.getState().startPreferenceSync(() => credentials);

    useBookmarksStore.getState().setSortBy("alpha-za");
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(updateCalls.at(-1)).toMatchObject({ bookmarkView: { viewMode: "grid", sortBy: "alpha-za" } });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/settings-store-view-prefs.test.ts`
Expected: FAIL — `startPreferenceSync is not a function` / preferences are not applied.

- [x] **Step 3: Share the view and sort types**

In `store/bookmarks-store.ts`, add `import type { BookmarkSortBy, BookmarkViewMode } from "@/lib/view-preferences";` after the existing type imports and replace:

```ts
type ViewMode = "grid" | "list";
type SortBy = "date-newest" | "date-oldest" | "alpha-az" | "alpha-za";
```

with:

```ts
type ViewMode = BookmarkViewMode;
type SortBy = BookmarkSortBy;
```

- [x] **Step 4: Replace `store/settings-store.ts`**

```ts
import { create } from "zustand";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { hasSettingsSyncConsent } from "@/lib/browser/data-collection";
import {
  fetchRemoteViewPrefs,
  pushViewPrefs,
  readLocalViewPrefs,
  resolvePullAction,
  writeLocalViewPrefs,
  type BookmarkViewPrefs,
  type PreferenceCredentials,
  type StoredViewPrefs,
} from "@/lib/view-preferences";

const PUSH_DEBOUNCE_MS = 1000;

export type GetPreferenceCredentials = () => PreferenceCredentials | null;

interface SettingsState {
  _hydrated: boolean;
  hydrate: () => Promise<void>;
  reset: () => void;
  /** Remembers how to reach the server for this sync session and reconciles view preferences once. */
  startPreferenceSync: (getCredentials: GetPreferenceCredentials) => Promise<void>;
  /** Reconciles view preferences again, e.g. after Firefox consent is granted. */
  resyncPreferences: () => Promise<void>;
  stopPreferenceSync: () => void;
}

let preferenceCredentials: GetPreferenceCredentials | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let applyingRemote = false;
let unsubscribeViewPrefs: (() => void) | null = null;

function clearPushTimer(): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
}

/** Server and stored values are not user changes, so the subscription ignores them. */
function applyViewPrefs(prefs: BookmarkViewPrefs): void {
  applyingRemote = true;
  try {
    const bookmarks = useBookmarksStore.getState();
    bookmarks.setViewMode(prefs.viewMode);
    bookmarks.setSortBy(prefs.sortBy);
  } finally {
    applyingRemote = false;
  }
}

async function eligibleCredentials(): Promise<PreferenceCredentials | null> {
  const credentials = preferenceCredentials?.() ?? null;
  if (!credentials || !(await hasSettingsSyncConsent())) {
    return null;
  }
  return credentials;
}

async function pushDirtyViewPrefs(): Promise<void> {
  const credentials = await eligibleCredentials();
  if (!credentials) {
    return;
  }
  const local = await readLocalViewPrefs();
  if (!local?.dirty) {
    return;
  }
  try {
    await pushViewPrefs(credentials, local);
  } catch {
    // Stays dirty; the next change or pull retries.
    return;
  }
  const latest = await readLocalViewPrefs();
  if (latest && latest.updatedAt === local.updatedAt) {
    await writeLocalViewPrefs({ ...latest, dirty: false });
  }
}

function schedulePush(): void {
  clearPushTimer();
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushDirtyViewPrefs().catch(() => {});
  }, PUSH_DEBOUNCE_MS);
}

async function recordLocalChange(): Promise<void> {
  const { viewMode, sortBy } = useBookmarksStore.getState();
  await writeLocalViewPrefs({ viewMode, sortBy, updatedAt: Date.now(), dirty: true });
  schedulePush();
}

async function reconcileViewPrefs(): Promise<void> {
  const sessionCredentials = preferenceCredentials;
  const credentials = await eligibleCredentials();
  if (!credentials) {
    return;
  }
  let remote: BookmarkViewPrefs | null;
  let local: StoredViewPrefs | null;
  try {
    [remote, local] = await Promise.all([fetchRemoteViewPrefs(credentials), readLocalViewPrefs()]);
  } catch {
    return;
  }
  if (preferenceCredentials !== sessionCredentials) {
    // The session stopped or restarted while the request was in flight.
    return;
  }
  const action = resolvePullAction(local, remote);
  if (action === "apply-remote" && remote) {
    applyViewPrefs(remote);
    await writeLocalViewPrefs({ ...remote, dirty: false });
    return;
  }
  if (action === "push-local" && local) {
    if (!local.dirty) {
      await writeLocalViewPrefs({ ...local, dirty: true });
    }
    await pushDirtyViewPrefs();
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  _hydrated: false,
  hydrate: async () => {
    try {
      const local = await readLocalViewPrefs();
      if (local) {
        applyViewPrefs(local);
      }
    } catch {
      // Unreadable preferences keep the defaults.
    }
    unsubscribeViewPrefs?.();
    unsubscribeViewPrefs = useBookmarksStore.subscribe((state, previous) => {
      if (applyingRemote || (state.viewMode === previous.viewMode && state.sortBy === previous.sortBy)) {
        return;
      }
      void recordLocalChange().catch(() => {});
    });
    set({ _hydrated: true });
  },
  reset: () => {
    clearPushTimer();
    preferenceCredentials = null;
    set({ _hydrated: true });
  },
  startPreferenceSync: async (getCredentials) => {
    preferenceCredentials = getCredentials;
    await reconcileViewPrefs().catch(() => {});
  },
  resyncPreferences: async () => {
    await reconcileViewPrefs().catch(() => {});
  },
  stopPreferenceSync: () => {
    clearPushTimer();
    preferenceCredentials = null;
  },
}));
```

- [x] **Step 5: Wire the sync effect in `entrypoints/newtab/App.tsx`**

Replace:

```ts
    // Pull user preferences from server on login
    useSettingsStore.getState().pullFromServer(serverUrl, accessToken);

    const engine = createSyncEngine(
      () => {
        const currentAuth = useAuthStore.getState();
        if (!currentAuth.accessToken || !currentAuth.serverUrl) {
          return null;
        }
        return {
          baseUrl: currentAuth.serverUrl,
          accessToken: currentAuth.accessToken,
        };
      },
```

with:

```ts
    const getCredentials = () => {
      const currentAuth = useAuthStore.getState();
      if (!currentAuth.accessToken || !currentAuth.serverUrl) {
        return null;
      }
      return {
        baseUrl: currentAuth.serverUrl,
        accessToken: currentAuth.accessToken,
      };
    };

    // Reconcile synced view preferences for this sync session.
    void useSettingsStore.getState().startPreferenceSync(getCredentials);

    const engine = createSyncEngine(
      getCredentials,
```

and in that effect's cleanup replace:

```ts
    return () => {
      // Capture the engine reference before async work begins.
```

with:

```ts
    return () => {
      useSettingsStore.getState().stopPreferenceSync();
      // Capture the engine reference before async work begins.
```

- [x] **Step 6: Run the tests**

Run: `bun test test/settings-store-view-prefs.test.ts && bun test && bun run compile`
Expected: 6 pass in the new file; the suite has 0 failures; compile exits 0.

- [x] **Step 7: Commit**

```bash
git add store/bookmarks-store.ts store/settings-store.ts entrypoints/newtab/App.tsx test/settings-store-view-prefs.test.ts
git commit -m "feat(preferences): remember and sync the bookmark view and sort

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Firefox preference sync switch

**Files:**
- Create: `hooks/use-preference-sync-consent.ts`
- Modify: `components/dashboard/settings-dialog.tsx`
- Modify: both `messages.json`
- Test: `test/preference-sync-consent.test.tsx`

**Interfaces:**
- Consumes: Task 4 consent functions; `subscribeToPermissionChanges`; `useSettingsStore.getState().resyncPreferences()` (Task 6).
- Produces: `usePreferenceSyncConsent(): { granted: boolean | null; setGranted: (enabled: boolean) => void }` (`granted` stays `null` outside Firefox).

- [x] **Step 1: Write the failing test**

`test/preference-sync-consent.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, render, setupDom, teardownDom, wait } from "./helpers/dom-environment";

const replacer = createModuleReplacer();
const originalChrome = Reflect.get(globalThis, "chrome");
let permissionGranted = false;
const resyncPreferences = mock(async () => {});
let createRoot: typeof import("react-dom/client").createRoot;
let usePreferenceSyncConsent: typeof import("@/hooks/use-preference-sync-consent").usePreferenceSyncConsent;

beforeAll(async () => {
  setupDom();
  Reflect.set(globalThis, "chrome", {
    permissions: {
      contains: async () => permissionGranted,
      request: async () => {
        permissionGranted = true;
        return true;
      },
      remove: async () => {
        permissionGranted = false;
        return true;
      },
      onAdded: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {}, removeListener: () => {} },
    },
  });
  const realEnv = await importFresh<typeof import("@/lib/browser/env")>("lib/browser/env.ts");
  const reactDomClient = await importFresh<typeof import("react-dom/client")>("node_modules/react-dom/client.js");
  await replacer.replace("react-dom/client", reactDomClient);
  await replacer.replace("@/lib/browser/env", { ...realEnv, isFirefoxBuild: () => true });
  await replacer.replace("@/store/settings-store", {
    useSettingsStore: { getState: () => ({ resyncPreferences }) },
  });
  createRoot = reactDomClient.createRoot;
  ({ usePreferenceSyncConsent } = await importFresh<typeof import("@/hooks/use-preference-sync-consent")>(
    "hooks/use-preference-sync-consent.ts",
  ));
});

afterAll(async () => {
  replacer.restore();
  Reflect.set(globalThis, "chrome", originalChrome);
  await teardownDom();
});

function Probe() {
  const { granted, setGranted } = usePreferenceSyncConsent();
  return createElement(
    "button",
    { id: "toggle", onClick: () => setGranted(!granted) },
    String(granted),
  );
}

describe("usePreferenceSyncConsent", () => {
  test("reflects, grants and withdraws the Firefox permission", async () => {
    const view = render({ createRoot }, createElement(Probe));
    await wait(0);
    const toggle = getBySelector("#toggle");
    expect(toggle.textContent).toBe("false");

    click(toggle);
    await wait(0);
    expect(toggle.textContent).toBe("true");
    expect(resyncPreferences).toHaveBeenCalledTimes(1);

    click(toggle);
    await wait(0);
    expect(toggle.textContent).toBe("false");
    expect(resyncPreferences).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/preference-sync-consent.test.tsx`
Expected: FAIL — `Cannot find module` for `hooks/use-preference-sync-consent.ts`.

- [x] **Step 3: Implement the hook**

`hooks/use-preference-sync-consent.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { isFirefoxBuild } from "@/lib/browser/env";
import {
  hasSettingsSyncConsent,
  removeSettingsSyncConsent,
  requestSettingsSyncConsent,
  subscribeToPermissionChanges,
} from "@/lib/browser/data-collection";
import { useSettingsStore } from "@/store/settings-store";

/**
 * Firefox-only switch for syncing view preferences, kept current when the
 * permission changes in about:addons. `granted` stays null outside Firefox.
 */
export function usePreferenceSyncConsent(): { granted: boolean | null; setGranted: (enabled: boolean) => void } {
  const [granted, setGrantedState] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isFirefoxBuild()) {
      return;
    }
    let active = true;
    const refresh = () => {
      void hasSettingsSyncConsent().then((value) => {
        if (active) {
          setGrantedState(value);
        }
      });
    };
    refresh();
    const unsubscribe = subscribeToPermissionChanges(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const setGranted = useCallback((enabled: boolean) => {
    if (enabled) {
      // Firefox only accepts the request while handling the click, before any await.
      void requestSettingsSyncConsent().then((value) => {
        setGrantedState(value);
        if (value) {
          void useSettingsStore.getState().resyncPreferences();
        }
      });
      return;
    }
    void removeSettingsSyncConsent().then((removed) => {
      if (removed) {
        setGrantedState(false);
      }
    });
  }, []);

  return { granted, setGranted };
}
```

- [x] **Step 4: Add the switch to the Settings dialog**

In `components/dashboard/settings-dialog.tsx`, add `import { usePreferenceSyncConsent } from "@/hooks/use-preference-sync-consent";`, call `const preferenceSync = usePreferenceSyncConsent();` next to the `searchOverlayEnabled` state, and insert after the search-overlay card (the `<div className="rounded-lg border p-3 shadow-sm bg-card/20">` block that contains `handleToggleSearchOverlay`):

```tsx
              {preferenceSync.granted !== null && (
                <div className="rounded-lg border p-3 shadow-sm bg-card/20">
                  <div className="flex flex-row items-center justify-between">
                    <div className="space-y-0.5">
                      <h3 className="text-sm font-semibold">{t("settings_generalPreferenceSyncTitle")}</h3>
                      <p className="text-xs text-muted-foreground mr-4 mt-0.5">
                        {t("settings_generalPreferenceSyncDesc")}
                      </p>
                    </div>
                    <Switch
                      checked={preferenceSync.granted}
                      onCheckedChange={preferenceSync.setGranted}
                      aria-label={t("settings_generalPreferenceSyncTitle")}
                    />
                  </div>
                </div>
              )}
```

Add to `public/_locales/en/messages.json`:

```json
  "settings_generalPreferenceSyncTitle": {
    "message": "Sync view preferences across devices"
  },
  "settings_generalPreferenceSyncDesc": {
    "message": "Firefox asks first, then TabSlate sends your bookmark view and sort order to your sync server."
  },
```

Add to `public/_locales/zh_CN/messages.json`:

```json
  "settings_generalPreferenceSyncTitle": {
    "message": "跨设备同步视图偏好"
  },
  "settings_generalPreferenceSyncDesc": {
    "message": "开启时 Firefox 会先征得你的同意，之后书签视图和排序方式会同步到你的服务器。"
  },
```

- [x] **Step 5: Run the tests**

Run: `bun test test/preference-sync-consent.test.tsx && bun run compile`
Expected: 1 pass; compile exits 0.

- [x] **Step 6: Commit**

```bash
git add hooks/use-preference-sync-consent.ts components/dashboard/settings-dialog.tsx public/_locales test/preference-sync-consent.test.tsx
git commit -m "feat(firefox): add a settings switch for syncing view preferences

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Tag dialog edit mode and validation

**Files:**
- Modify: `components/dashboard/sidebar/tag-dialog.tsx`
- Modify: `components/dashboard/sidebar/index.tsx` (create call site)
- Modify: `components/dashboard/shared/bookmark-tags-dialog.tsx` (create call site)
- Modify: both `messages.json`
- Test: `test/tag-dialog.test.tsx`

**Interfaces:**
- Consumes: test helpers (Task 1).
- Produces: `TagDialog` props `{ open: boolean; onOpenChange: (open: boolean) => void; initial?: Tag; takenNames: readonly string[]; onSubmit: (name: string, color: string) => void }`.

- [x] **Step 1: Write the failing test**

`test/tag-dialog.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Tag } from "@/lib/types";
import { createModuleReplacer } from "./helpers/module-replacer";
import {
  getBySelector,
  getByText,
  installAppModules,
  render,
  setupDom,
  submitForm,
  teardownDom,
  typeInto,
  type AppModules,
} from "./helpers/dom-environment";

const replacer = createModuleReplacer();
let app: AppModules;
let TagDialog: typeof import("@/components/dashboard/sidebar/tag-dialog").TagDialog;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ TagDialog } = await import("@/components/dashboard/sidebar/tag-dialog"));
});

afterAll(async () => {
  replacer.restore();
  await teardownDom();
});

const design: Tag = { id: "design", name: "Design", color: "bg-violet-500/10 text-violet-500", seq: 0 };

function renderDialog(initial: Tag | undefined, takenNames: string[]) {
  const submitted: Array<[string, string]> = [];
  const view = render(
    app,
    createElement(TagDialog, {
      open: true,
      onOpenChange: () => {},
      initial,
      takenNames,
      onSubmit: (name: string, color: string) => {
        submitted.push([name, color]);
      },
    }),
  );
  const input = getBySelector<HTMLInputElement>("#tag-name");
  const form = input.closest("form");
  if (!form) {
    throw new Error("tag dialog has no form");
  }
  return { view, input, form, submitted };
}

describe("TagDialog", () => {
  test("edit mode starts from the tag and saves the trimmed new name with its color", async () => {
    const dialog = renderDialog(design, ["Frontend"]);
    expect(getByText("tagDialog_editTitle")).toBeTruthy();
    expect(dialog.input.value).toBe("Design");

    typeInto(dialog.input, "  UI Design ");
    await submitForm(dialog.form);

    expect(dialog.submitted).toEqual([["UI Design", "bg-violet-500/10 text-violet-500"]]);
    dialog.view.unmount();
  });

  test("rejects an empty name", async () => {
    const dialog = renderDialog(undefined, []);
    typeInto(dialog.input, "   ");
    await submitForm(dialog.form);

    expect(getByText("tagDialog_errorEmpty")).toBeTruthy();
    expect(dialog.submitted).toEqual([]);
    dialog.view.unmount();
  });

  test("rejects a name another tag already uses, ignoring case", async () => {
    const dialog = renderDialog(undefined, ["Frontend"]);
    typeInto(dialog.input, "frontend");
    await submitForm(dialog.form);

    expect(getByText("tagDialog_errorDuplicate")).toBeTruthy();
    expect(dialog.submitted).toEqual([]);
    dialog.view.unmount();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/tag-dialog.test.tsx`
Expected: FAIL — no element with text `tagDialog_editTitle` (the title is still the hard-coded "New Tag").

- [x] **Step 3: Rewrite `components/dashboard/sidebar/tag-dialog.tsx`**

```tsx
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TAG_COLORS } from "@/store/workspace-store";
import { useTranslation } from "@/hooks/use-translation";
import type { Tag } from "@/lib/types";

interface TagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tag being edited; omitted when creating one. */
  initial?: Tag;
  /** Names of the other tags, used to reject duplicates. */
  takenNames: readonly string[];
  onSubmit: (name: string, color: string) => void;
}

export function TagDialog({ open, onOpenChange, initial, takenNames, onSubmit }: TagDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = React.useState(initial?.name ?? "");
  const [color, setColor] = React.useState<string>(initial?.color ?? TAG_COLORS[0]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setColor(initial?.color ?? TAG_COLORS[0]);
      setError(null);
    }
  }, [open, initial]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("tagDialog_errorEmpty"));
      return;
    }
    const lower = trimmed.toLowerCase();
    if (takenNames.some((taken) => taken.toLowerCase() === lower)) {
      setError(t("tagDialog_errorDuplicate"));
      return;
    }
    onSubmit(trimmed, color);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>{t(initial ? "tagDialog_editTitle" : "tagDialog_newTitle")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t(initial ? "tagDialog_editDesc" : "tagDialog_newDesc")}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4 pt-1" onSubmit={handleSubmit} noValidate>
          <Field>
            <FieldLabel htmlFor="tag-name">{t("tagDialog_nameLabel")}</FieldLabel>
            <Input
              id="tag-name"
              name="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder={t("tagDialog_namePlaceholder")}
              aria-invalid={error !== null}
              aria-describedby={error ? "tag-name-error" : undefined}
              autoFocus
            />
            {error && (
              <p id="tag-name-error" role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </Field>
          <Field>
            <FieldLabel>{t("tagDialog_colorLabel")}</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {TAG_COLORS.map((option, index) => (
                <button
                  key={option}
                  type="button"
                  aria-label={t("tagDialog_colorOption", [String(index + 1)])}
                  aria-pressed={color === option}
                  onClick={() => setColor(option)}
                  className={cn(
                    "size-7 rounded-full transition-all",
                    option.split(" ")[0].replace("/10", ""),
                    color === option ? "ring-2 ring-primary ring-offset-2" : "opacity-50 hover:opacity-100",
                  )}
                />
              ))}
            </div>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("settings_cancel")}
            </Button>
            <Button type="submit" size="sm">
              {t(initial ? "tagDialog_save" : "tagDialog_create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [x] **Step 4: Update the two create call sites**

In `components/dashboard/sidebar/index.tsx`, add `const tagNames = React.useMemo(() => tags.map((tag) => tag.name), [tags]);` after the `tags` selector and pass `takenNames={tagNames}` to the existing `<TagDialog ... />` (Task 9 moves this dialog into the tags section).

In `components/dashboard/shared/bookmark-tags-dialog.tsx`, add `const tagNames = React.useMemo(() => tags.map((tag) => tag.name), [tags]);` after the `tags` selector and pass `takenNames={tagNames}` to its `<TagDialog ... />`.

- [x] **Step 5: Add the strings**

`public/_locales/en/messages.json`:

```json
  "tagDialog_newTitle": { "message": "New tag" },
  "tagDialog_editTitle": { "message": "Edit tag" },
  "tagDialog_newDesc": { "message": "Create a tag to label your bookmarks." },
  "tagDialog_editDesc": { "message": "Change this tag's name and color." },
  "tagDialog_nameLabel": { "message": "Name" },
  "tagDialog_namePlaceholder": { "message": "Tag name" },
  "tagDialog_colorLabel": { "message": "Color" },
  "tagDialog_colorOption": { "message": "Color $1", "placeholders": { "1": { "content": "$1" } } },
  "tagDialog_create": { "message": "Create" },
  "tagDialog_save": { "message": "Save" },
  "tagDialog_errorEmpty": { "message": "Enter a tag name." },
  "tagDialog_errorDuplicate": { "message": "A tag with this name already exists." },
```

`public/_locales/zh_CN/messages.json`:

```json
  "tagDialog_newTitle": { "message": "新建标签" },
  "tagDialog_editTitle": { "message": "编辑标签" },
  "tagDialog_newDesc": { "message": "创建一个标签来标记书签。" },
  "tagDialog_editDesc": { "message": "修改这个标签的名称和颜色。" },
  "tagDialog_nameLabel": { "message": "名称" },
  "tagDialog_namePlaceholder": { "message": "标签名称" },
  "tagDialog_colorLabel": { "message": "颜色" },
  "tagDialog_colorOption": { "message": "颜色 $1", "placeholders": { "1": { "content": "$1" } } },
  "tagDialog_create": { "message": "创建" },
  "tagDialog_save": { "message": "保存" },
  "tagDialog_errorEmpty": { "message": "请输入标签名称。" },
  "tagDialog_errorDuplicate": { "message": "已有同名标签。" },
```

(Expand each entry to the file's multi-line 2-space style when inserting.)

- [x] **Step 6: Run the tests**

Run: `bun test test/tag-dialog.test.tsx && bun run compile`
Expected: 3 pass; compile exits 0.

- [x] **Step 7: Commit**

```bash
git add components/dashboard/sidebar/tag-dialog.tsx components/dashboard/sidebar/index.tsx components/dashboard/shared/bookmark-tags-dialog.tsx public/_locales test/tag-dialog.test.tsx
git commit -m "feat(tags): edit tags in the tag dialog and reject duplicate names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Sidebar tags section with counts and search

**Files:**
- Create: `components/dashboard/sidebar/section-header.tsx`
- Create: `components/dashboard/sidebar/tags-section.tsx`
- Modify: `components/dashboard/sidebar/index.tsx`
- Modify: both `messages.json`
- Test: `test/sidebar-tags-section.test.tsx`

**Interfaces:**
- Consumes: `TagDialog` (Task 8); `getActiveWorkspaceCollectionIds`.
- Produces: `SectionHeader({ label, open, onToggle, actions? })`; `SidebarTagsSection()` (no props). Chips render `data-tag-id={tag.id}`, `aria-pressed`, and a count `<span data-tag-count>`.

- [x] **Step 1: Write the failing test**

`test/sidebar-tags-section.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { createModuleReplacer } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  pressKey,
  render,
  setupDom,
  teardownDom,
  typeInto,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import {
  bookmarkMap,
  countsByCollection,
  makeBookmark,
  makeCollection,
  makeTag,
  makeWorkspace,
} from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let SidebarProvider: typeof import("@/components/ui/sidebar").SidebarProvider;
let SidebarTagsSection: typeof import("@/components/dashboard/sidebar/tags-section").SidebarTagsSection;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ SidebarProvider } = await import("@/components/ui/sidebar"));
  ({ SidebarTagsSection } = await import("@/components/dashboard/sidebar/tags-section"));
});

afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

beforeEach(() => {
  view?.unmount();
  const bookmarks = [
    makeBookmark("b1", { collectionId: "reading", tags: ["frontend", "go"] }),
    makeBookmark("b2", { collectionId: "reading", tags: ["frontend"] }),
    makeBookmark("b3", { collectionId: "", tags: ["frontend"] }),
    makeBookmark("b4", { collectionId: "projects", tags: ["frontend", "design"] }),
  ];
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home"), makeWorkspace("work")],
    collections: [makeCollection("reading", "home", { isDefault: true }), makeCollection("projects", "work")],
    tags: [makeTag("frontend", "Frontend"), makeTag("go", "Go"), makeTag("design", "Design")],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedTags: [],
  });
  view = render(app, createElement(SidebarProvider, null, createElement(SidebarTagsSection)));
  click(getByText("sidebar_tags"));
});

const chip = (tagId: string) => getBySelector(`[data-tag-id="${tagId}"]`);

describe("SidebarTagsSection", () => {
  test("shows how many bookmarks in the active workspace carry each tag", () => {
    expect(chip("frontend").querySelector("[data-tag-count]")?.textContent).toBe("3");
    expect(chip("go").querySelector("[data-tag-count]")?.textContent).toBe("1");
    expect(chip("design").querySelector("[data-tag-count]")?.textContent).toBe("0");
  });

  test("clicking a tag toggles it in the bookmark filter", () => {
    click(chip("go"));
    expect(app.useBookmarksStore.getState().selectedTags).toEqual(["go"]);
    expect(chip("go").getAttribute("aria-pressed")).toBe("true");
  });

  test("search narrows the tags, highlights the match and leaves the filter alone", () => {
    click(getBySelector('[aria-label="sidebar_searchTags"]'));
    const input = getBySelector<HTMLInputElement>('input[aria-label="sidebar_searchTags"]');
    typeInto(input, "DES");

    expect(document.querySelector('[data-tag-id="frontend"]')).toBeNull();
    expect(chip("design").querySelector("mark")?.textContent).toBe("Des");

    pressKey(input, "Escape");

    expect(document.querySelectorAll("[data-tag-id]").length).toBe(3);
    expect(app.useBookmarksStore.getState().selectedTags).toEqual([]);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/sidebar-tags-section.test.tsx`
Expected: FAIL — `Cannot find module` for `components/dashboard/sidebar/tags-section`.

- [x] **Step 3: Move `SectionHeader` into its own file**

`components/dashboard/sidebar/section-header.tsx`:

```tsx
import type * as React from "react";
import { ChevronDown } from "lucide-react";
import { SidebarGroupLabel } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  label: string;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}

export function SectionHeader({ label, open, onToggle, actions }: SectionHeaderProps) {
  return (
    <SidebarGroupLabel className="flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wider text-muted-foreground">
      <button onClick={onToggle} className="flex items-center gap-1.5 cursor-pointer">
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        {label}
      </button>
      {actions}
    </SidebarGroupLabel>
  );
}
```

In `components/dashboard/sidebar/index.tsx`, delete the `// SectionHeader` banner comment, the `SectionHeaderProps` interface and the `SectionHeader` function, and add `import { SectionHeader } from "./section-header";`.

- [x] **Step 4: Create `components/dashboard/sidebar/tags-section.tsx`**

```tsx
import * as React from "react";
import { Plus, Search, Tag as TagIcon, X } from "lucide-react";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { getActiveWorkspaceCollectionIds } from "@/lib/workspace-visibility";
import { useTranslation } from "@/hooks/use-translation";
import type { Bookmark } from "@/lib/types";
import { SectionHeader } from "./section-header";
import { TagDialog } from "./tag-dialog";

/** Bookmarks in the active workspace (its collections plus uncategorized) per tag. */
function countTagsInWorkspace(
  bookmarks: Map<string, Bookmark>,
  workspaceCollectionIds: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const bookmark of bookmarks.values()) {
    if (bookmark.collectionId !== "" && !workspaceCollectionIds.has(bookmark.collectionId)) {
      continue;
    }
    for (const tagId of bookmark.tags) {
      counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    }
  }
  return counts;
}

function HighlightedName({ name, query }: { name: string; query: string }) {
  const index = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (index === -1) {
    return <>{name}</>;
  }
  return (
    <>
      {name.slice(0, index)}
      <mark className="rounded-sm bg-yellow-300/60 text-inherit dark:bg-yellow-500/40">
        {name.slice(index, index + query.length)}
      </mark>
      {name.slice(index + query.length)}
    </>
  );
}

export function SidebarTagsSection() {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [newTagOpen, setNewTagOpen] = React.useState(false);

  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const selectedTags = useBookmarksStore((s) => s.selectedTags);
  const toggleTag = useBookmarksStore((s) => s.toggleTag);
  const clearTags = useBookmarksStore((s) => s.clearTags);
  const tags = useWorkspaceStore((s) => s.tags);
  const collections = useWorkspaceStore((s) => s.collections);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const createTag = useWorkspaceStore((s) => s.createTag);
  const deleteTag = useWorkspaceStore((s) => s.deleteTag);

  const workspaceCollectionIds = React.useMemo(
    () => getActiveWorkspaceCollectionIds(activeWorkspaceId, workspaces, collections),
    [activeWorkspaceId, workspaces, collections],
  );
  const tagCounts = React.useMemo(
    () => countTagsInWorkspace(bookmarks, workspaceCollectionIds),
    [bookmarks, workspaceCollectionIds],
  );
  const trimmedQuery = query.trim();
  const visibleTags = React.useMemo(() => {
    const needle = trimmedQuery.toLowerCase();
    return needle ? tags.filter((tag) => tag.name.toLowerCase().includes(needle)) : tags;
  }, [tags, trimmedQuery]);
  const tagNames = React.useMemo(() => tags.map((tag) => tag.name), [tags]);

  const handleToggleOpen = React.useCallback(() => setOpen((value) => !value), []);
  const handleOpenSearch = React.useCallback(() => {
    setOpen(true);
    setSearchOpen(true);
  }, []);
  const handleCloseSearch = React.useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  return (
    <SidebarGroup className="p-0">
      {searchOpen ? (
        <div className="flex items-center gap-1 px-1 py-1">
          <Input
            autoFocus
            value={query}
            aria-label={t("sidebar_searchTags")}
            placeholder={t("sidebar_searchTagsPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                handleCloseSearch();
              }
            }}
            className="h-7 text-xs"
          />
          <button
            type="button"
            aria-label={t("sidebar_closeTagSearch")}
            onClick={handleCloseSearch}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <SectionHeader
          label={t("sidebar_tags")}
          open={open}
          onToggle={handleToggleOpen}
          actions={
            <div className="ml-auto flex items-center gap-1">
              {selectedTags.length > 0 && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearTags();
                  }}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {t("sidebar_clearTags")}
                </button>
              )}
              <button
                type="button"
                aria-label={t("sidebar_searchTags")}
                onClick={handleOpenSearch}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Search className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={t("sidebar_newTag")}
                onClick={() => setNewTagOpen(true)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          }
        />
      )}

      {open && (
        <SidebarGroupContent>
          <div className="flex flex-wrap gap-1.5 mt-2 px-1">
            {tags.length === 0 && (
              <p className="text-xs text-muted-foreground w-full py-1">{t("sidebar_noTagsYet")}</p>
            )}
            {visibleTags.map((tag) => {
              const count = tagCounts.get(tag.id) ?? 0;
              const selected = selectedTags.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  data-tag-id={tag.id}
                  aria-pressed={selected}
                  onClick={() => toggleTag(tag.id)}
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors group/tag",
                    selected ? "bg-primary text-primary-foreground" : tag.color,
                  )}
                >
                  <TagIcon className="size-3" />
                  <HighlightedName name={tag.name} query={trimmedQuery} />
                  <span data-tag-count className={cn("tabular-nums", count === 0 ? "opacity-50" : "opacity-80")}>
                    {count}
                  </span>
                  <span
                    role="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteTag(tag.id);
                    }}
                    className="hidden group-hover/tag:inline ml-0.5 hover:opacity-70"
                  >
                    ×
                  </span>
                </button>
              );
            })}
          </div>
        </SidebarGroupContent>
      )}

      <TagDialog
        open={newTagOpen}
        onOpenChange={setNewTagOpen}
        takenNames={tagNames}
        onSubmit={(name, color) => {
          createTag(name, color);
        }}
      />
    </SidebarGroup>
  );
}
```

(The hover × is carried over unchanged so deletion keeps working until Task 10 replaces it with the context menu.)

- [x] **Step 5: Use the section in `components/dashboard/sidebar/index.tsx`**

- Replace the JSX from the line `{/* Tags */}` through the `</SidebarGroup>` that precedes `{/* Nav */}` with:

```tsx
          {/* Tags */}
          <SidebarTagsSection />
```

- Delete the `<TagDialog ... />` element rendered after `CollectionDialog`.
- Delete `const [tagsOpen, setTagsOpen] = React.useState(false);`, `const [newTagOpen, setNewTagOpen] = React.useState(false);`, `handleToggleTags`, the `tagNames` memo added in Task 8, and the selectors `selectedTags`, `toggleTag`, `tags`, `createTag`, `deleteTag`. Keep `clearTags` (collection links use it).
- Replace `import { TagDialog } from "./tag-dialog";` with `import { SidebarTagsSection } from "./tags-section";`.
- Remove the imports this task leaves unused: `Tag` and `ChevronDown` from `lucide-react`, and `SidebarGroupLabel` from `@/components/ui/sidebar`. Leave imports that were already unused (`Search`, `Input`, the `Collection` type) alone.

- [x] **Step 6: Add the strings**

`en`:

```json
  "sidebar_searchTags": { "message": "Search tags" },
  "sidebar_searchTagsPlaceholder": { "message": "Filter tags" },
  "sidebar_closeTagSearch": { "message": "Close tag search" },
  "sidebar_newTag": { "message": "New tag" },
```

`zh_CN`:

```json
  "sidebar_searchTags": { "message": "搜索标签" },
  "sidebar_searchTagsPlaceholder": { "message": "筛选标签" },
  "sidebar_closeTagSearch": { "message": "关闭标签搜索" },
  "sidebar_newTag": { "message": "新建标签" },
```

- [x] **Step 7: Run the tests**

Run: `bun test test/sidebar-tags-section.test.tsx && bun test && bun run compile`
Expected: 3 pass; suite 0 failures; compile exits 0.

- [x] **Step 8: Commit**

```bash
git add components/dashboard/sidebar public/_locales test/sidebar-tags-section.test.tsx
git commit -m "feat(tags): show tag counts and search tags in the sidebar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Tag right-click menu and delete confirmation

**Files:**
- Create: `components/ui/context-menu.tsx`
- Create: `components/dashboard/sidebar/tag-delete-dialog.tsx`
- Modify: `components/dashboard/sidebar/tags-section.tsx`
- Modify: both `messages.json`
- Test: `test/sidebar-tag-menu.test.tsx`

**Interfaces:**
- Consumes: `SidebarTagsSection` (Task 9), `TagDialog` (Task 8), `TAG_COLORS`, `updateTag`, `deleteTag`.
- Produces: `ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem` (`variant?: "default" | "destructive"`, `inset?`), `ContextMenuSeparator`, `ContextMenuSub`, `ContextMenuSubTrigger`, `ContextMenuSubContent`; `TagDeleteDialog({ tag: Tag; bookmarkCount: number; onClose: () => void; onConfirm: () => void })`.

- [x] **Step 1: Write the failing test**

`test/sidebar-tag-menu.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { createModuleReplacer } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  render,
  rightClick,
  setupDom,
  submitForm,
  teardownDom,
  typeInto,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import {
  bookmarkMap,
  countsByCollection,
  makeBookmark,
  makeCollection,
  makeTag,
  makeWorkspace,
} from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let SidebarProvider: typeof import("@/components/ui/sidebar").SidebarProvider;
let SidebarTagsSection: typeof import("@/components/dashboard/sidebar/tags-section").SidebarTagsSection;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ SidebarProvider } = await import("@/components/ui/sidebar"));
  ({ SidebarTagsSection } = await import("@/components/dashboard/sidebar/tags-section"));
});

afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

beforeEach(() => {
  view?.unmount();
  const bookmarks = [
    makeBookmark("b1", { collectionId: "reading", tags: ["frontend"] }),
    makeBookmark("b2", { collectionId: "reading", tags: ["frontend"] }),
    makeBookmark("b3", { collectionId: "", tags: ["frontend"] }),
    makeBookmark("b4", { collectionId: "projects", tags: ["frontend"] }),
  ];
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home"), makeWorkspace("work")],
    collections: [makeCollection("reading", "home", { isDefault: true }), makeCollection("projects", "work")],
    tags: [makeTag("frontend", "Frontend"), makeTag("go", "Go")],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedTags: [],
  });
  view = render(app, createElement(SidebarProvider, null, createElement(SidebarTagsSection)));
  click(getByText("sidebar_tags"));
});

const chip = (tagId: string) => getBySelector(`[data-tag-id="${tagId}"]`);
const tag = (tagId: string) => app.useWorkspaceStore.getState().tags.find((candidate) => candidate.id === tagId);

describe("tag context menu", () => {
  test("right-clicking a tag offers rename, color and delete", () => {
    rightClick(chip("frontend"));
    expect(getByText("tagMenu_rename")).toBeTruthy();
    expect(getByText("tagMenu_color")).toBeTruthy();
    expect(getByText("tagMenu_delete")).toBeTruthy();
  });

  test("rename saves the new name", async () => {
    rightClick(chip("frontend"));
    click(getByText("tagMenu_rename"));
    const input = getBySelector<HTMLInputElement>("#tag-name");
    expect(input.value).toBe("Frontend");

    typeInto(input, "Web");
    const form = input.closest("form");
    if (!form) {
      throw new Error("tag dialog has no form");
    }
    await submitForm(form);

    expect(tag("frontend")?.name).toBe("Web");
  });

  test("choosing a color recolors the tag immediately", () => {
    rightClick(chip("frontend"));
    click(getByText("tagMenu_color"));
    click(getByText("tagDialog_colorOption[2]"));

    expect(tag("frontend")?.color).toBe("bg-emerald-500/10 text-emerald-500");
  });

  test("delete asks first and names how many bookmarks in all workspaces lose the tag", () => {
    rightClick(chip("frontend"));
    click(getByText("tagMenu_delete"));
    expect(getByText("tagDeleteDialog_desc[4]")).toBeTruthy();

    click(getByText("tagDeleteDialog_confirm"));

    expect(tag("frontend")).toBeUndefined();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/sidebar-tag-menu.test.tsx`
Expected: FAIL — no element with text `tagMenu_rename`.

- [x] **Step 3: Create `components/ui/context-menu.tsx`**

```tsx
"use client"

import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "radix-ui"
import { ChevronRightIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-context-menu-content-available-height) min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md",
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  )
}

function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        data-slot="context-menu-sub-content"
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-lg",
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
}
```

- [x] **Step 4: Create `components/dashboard/sidebar/tag-delete-dialog.tsx`**

```tsx
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/use-translation";
import type { Tag } from "@/lib/types";

interface TagDeleteDialogProps {
  tag: Tag;
  /** Active bookmarks in every workspace that carry the tag. */
  bookmarkCount: number;
  onClose: () => void;
  onConfirm: () => void;
}

export function TagDeleteDialog({ tag, bookmarkCount, onClose, onConfirm }: TagDeleteDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("tagDeleteDialog_title", [tag.name])}</DialogTitle>
          <DialogDescription>{t("tagDeleteDialog_desc", [String(bookmarkCount)])}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t("settings_cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {t("tagDeleteDialog_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [x] **Step 5: Add the menu to `components/dashboard/sidebar/tags-section.tsx`**

Add imports:

```tsx
import { Check, Palette, Pencil, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TAG_COLORS } from "@/store/workspace-store";
import type { Tag } from "@/lib/types";
import { TagDeleteDialog } from "./tag-delete-dialog";
```

(Merge the lucide and `@/lib/types` imports with the existing ones.) Add helpers above the component:

```tsx
/** Active bookmarks in every workspace that carry the tag; tags are global. */
function countBookmarksWithTag(bookmarks: Map<string, Bookmark>, tagId: string): number {
  let count = 0;
  for (const bookmark of bookmarks.values()) {
    if (bookmark.tags.includes(tagId)) {
      count += 1;
    }
  }
  return count;
}

function swatchClass(color: string): string {
  return color.split(" ")[0].replace("/10", "");
}
```

Inside `SidebarTagsSection`, add state and selectors:

```tsx
  const [editingTag, setEditingTag] = React.useState<Tag | null>(null);
  const [deletingTag, setDeletingTag] = React.useState<Tag | null>(null);
  const updateTag = useWorkspaceStore((s) => s.updateTag);
  const deletingCount = React.useMemo(
    () => (deletingTag ? countBookmarksWithTag(bookmarks, deletingTag.id) : 0),
    [bookmarks, deletingTag],
  );
  const editingTakenNames = React.useMemo(
    () => (editingTag ? tags.filter((tag) => tag.id !== editingTag.id).map((tag) => tag.name) : []),
    [tags, editingTag],
  );
```

Replace the chip `<button ...>...</button>` in the map (including the hover `×` span, which is removed) with:

```tsx
                <Tooltip key={tag.id} delayDuration={1000}>
                  <ContextMenu>
                    <TooltipTrigger asChild>
                      <ContextMenuTrigger asChild>
                        <button
                          type="button"
                          data-tag-id={tag.id}
                          aria-pressed={selected}
                          onClick={() => toggleTag(tag.id)}
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors",
                            selected ? "bg-primary text-primary-foreground" : tag.color,
                          )}
                        >
                          <TagIcon className="size-3" />
                          <HighlightedName name={tag.name} query={trimmedQuery} />
                          <span data-tag-count className={cn("tabular-nums", count === 0 ? "opacity-50" : "opacity-80")}>
                            {count}
                          </span>
                        </button>
                      </ContextMenuTrigger>
                    </TooltipTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => setEditingTag(tag)}>
                        <Pencil className="size-4" />
                        {t("tagMenu_rename")}
                      </ContextMenuItem>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <Palette className="size-4" />
                          {t("tagMenu_color")}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          {TAG_COLORS.map((color, index) => (
                            <ContextMenuItem key={color} onSelect={() => updateTag(tag.id, { color })}>
                              <span className={cn("size-3 rounded-full", swatchClass(color))} />
                              {t("tagDialog_colorOption", [String(index + 1)])}
                              {tag.color === color && <Check className="ml-auto size-4" />}
                            </ContextMenuItem>
                          ))}
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onSelect={() => setDeletingTag(tag)}>
                        <Trash2 className="size-4" />
                        {t("tagMenu_delete")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  <TooltipContent side="top">{t("sidebar_tagRightClickHint")}</TooltipContent>
                </Tooltip>
```

Remove the now-unused `deleteTag` selector line from the chip block (it moves to the dialog below; keep the selector itself). After the create `<TagDialog />`, add:

```tsx
      {editingTag && (
        <TagDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setEditingTag(null);
            }
          }}
          initial={editingTag}
          takenNames={editingTakenNames}
          onSubmit={(name, color) => {
            updateTag(editingTag.id, { name, color });
          }}
        />
      )}
      {deletingTag && (
        <TagDeleteDialog
          tag={deletingTag}
          bookmarkCount={deletingCount}
          onClose={() => setDeletingTag(null)}
          onConfirm={() => {
            // A no-op when another device deleted the tag while the dialog was open.
            if (tags.some((tag) => tag.id === deletingTag.id)) {
              deleteTag(deletingTag.id);
            }
          }}
        />
      )}
```

- [x] **Step 6: Add the strings**

`en`:

```json
  "sidebar_tagRightClickHint": { "message": "Right-click to edit" },
  "tagMenu_rename": { "message": "Rename…" },
  "tagMenu_color": { "message": "Color" },
  "tagMenu_delete": { "message": "Delete…" },
  "tagDeleteDialog_title": { "message": "Delete \"$1\"?", "placeholders": { "1": { "content": "$1" } } },
  "tagDeleteDialog_desc": { "message": "This tag will be removed from $1 bookmarks. This can't be undone.", "placeholders": { "1": { "content": "$1" } } },
  "tagDeleteDialog_confirm": { "message": "Delete" },
```

`zh_CN`:

```json
  "sidebar_tagRightClickHint": { "message": "右键可编辑" },
  "tagMenu_rename": { "message": "重命名…" },
  "tagMenu_color": { "message": "颜色" },
  "tagMenu_delete": { "message": "删除…" },
  "tagDeleteDialog_title": { "message": "删除标签「$1」？", "placeholders": { "1": { "content": "$1" } } },
  "tagDeleteDialog_desc": { "message": "这个标签会从 $1 个书签上移除，此操作无法撤销。", "placeholders": { "1": { "content": "$1" } } },
  "tagDeleteDialog_confirm": { "message": "删除" },
```

- [x] **Step 7: Run the tests**

Run: `bun test test/sidebar-tag-menu.test.tsx test/sidebar-tags-section.test.tsx && bun run compile`
Expected: all pass; compile exits 0.

- [x] **Step 8: Commit**

```bash
git add components/ui/context-menu.tsx components/dashboard/sidebar public/_locales test/sidebar-tag-menu.test.tsx
git commit -m "feat(tags): rename, recolor and delete tags from a right-click menu

Deleting now asks for confirmation instead of removing the tag on one click.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Collection rows with shared menus and editing

**Files:**
- Create: `components/dashboard/shared/menu-primitives.tsx`
- Create: `components/dashboard/shared/collection-menu-items.tsx`
- Create: `components/dashboard/sidebar/collection-row.tsx`
- Modify: `components/dashboard/sidebar/collection-dialog.tsx` (strings)
- Modify: `components/dashboard/sidebar/index.tsx`
- Modify: both `messages.json`
- Test: `test/sidebar-collection-row.test.tsx`

**Interfaces:**
- Consumes: context menu (Task 10); `CollectionDialog` edit mode; `updateCollection`, `archiveCollection`, `deleteCollection`.
- Produces: `interface MenuItemProps { onSelect?: (event: Event) => void; variant?: "default" | "destructive"; className?: string; children: React.ReactNode }`; `interface MenuPrimitives { Item: React.ComponentType<MenuItemProps>; Separator: React.ComponentType }`; `dropdownMenuPrimitives`, `contextMenuPrimitives`; `CollectionMenuItems({ menu, collection, onEdit, onArchive, onDelete })`; `SidebarCollectionRow({ collection, count, isActive, isHighlighted, onSelect })`.

- [x] **Step 1: Write the failing test**

`test/sidebar-collection-row.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import type { Collection } from "@/lib/types";
import { createModuleReplacer } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  openDropdown,
  queryByText,
  render,
  rightClick,
  setupDom,
  submitForm,
  teardownDom,
  typeInto,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import { makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let sidebar: typeof import("@/components/ui/sidebar");
let SidebarCollectionRow: typeof import("@/components/dashboard/sidebar/collection-row").SidebarCollectionRow;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  sidebar = await import("@/components/ui/sidebar");
  ({ SidebarCollectionRow } = await import("@/components/dashboard/sidebar/collection-row"));
});

afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

const reading = makeCollection("reading", "home", { name: "Reading", isDefault: true });
const projects = makeCollection("projects", "home", { name: "Projects", position: 1 });
const onSelect = mock(() => {});

beforeEach(() => {
  view?.unmount();
  view = null;
  onSelect.mockClear();
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [reading, projects],
  });
});

function renderRow(collection: Collection) {
  view = render(
    app,
    createElement(
      MemoryRouter,
      null,
      createElement(
        sidebar.SidebarProvider,
        null,
        createElement(
          sidebar.SidebarMenu,
          null,
          createElement(SidebarCollectionRow, {
            collection,
            count: 2,
            isActive: false,
            isHighlighted: false,
            onSelect,
          }),
        ),
      ),
    ),
  );
  return getByText(collection.name);
}

describe("SidebarCollectionRow", () => {
  test("right-click offers edit, archive and delete", () => {
    rightClick(renderRow(projects));
    expect(getByText("collectionMenu_edit")).toBeTruthy();
    expect(getByText("sidebar_archiveCollection")).toBeTruthy();
    expect(getByText("sidebar_deleteCollection")).toBeTruthy();
  });

  test("the default collection can only be edited", () => {
    rightClick(renderRow(reading));
    expect(getByText("collectionMenu_edit")).toBeTruthy();
    expect(queryByText("sidebar_archiveCollection")).toBeNull();
    expect(queryByText("sidebar_deleteCollection")).toBeNull();
  });

  test("edit renames the collection", async () => {
    rightClick(renderRow(projects));
    click(getByText("collectionMenu_edit"));
    const input = getBySelector<HTMLInputElement>("#collection-name");
    expect(input.value).toBe("Projects");

    typeInto(input, "Side projects");
    const form = input.closest("form");
    if (!form) {
      throw new Error("collection dialog has no form");
    }
    await submitForm(form);

    expect(app.useWorkspaceStore.getState().collections.find((c) => c.id === "projects")?.name).toBe("Side projects");
  });

  test("the ⋯ button opens the same items, and choosing one does not select the row", () => {
    renderRow(projects);
    openDropdown(getBySelector('[aria-label="collectionMenu_more"]'));
    expect(getByText("sidebar_archiveCollection")).toBeTruthy();

    click(getByText("collectionMenu_edit"));

    expect(getBySelector<HTMLInputElement>("#collection-name").value).toBe("Projects");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/sidebar-collection-row.test.tsx`
Expected: FAIL — `Cannot find module` for `components/dashboard/sidebar/collection-row`.

- [x] **Step 3: Create the menu primitives and collection items**

`components/dashboard/shared/menu-primitives.tsx`:

```tsx
import type * as React from "react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";

export interface MenuItemProps {
  onSelect?: (event: Event) => void;
  variant?: "default" | "destructive";
  className?: string;
  children: React.ReactNode;
}

/** Menu parts an entity's items render with, so one item list serves both the ⋯ menu and the right-click menu. */
export interface MenuPrimitives {
  Item: React.ComponentType<MenuItemProps>;
  Separator: React.ComponentType;
}

export const dropdownMenuPrimitives: MenuPrimitives = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
};

export const contextMenuPrimitives: MenuPrimitives = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
};
```

`components/dashboard/shared/collection-menu-items.tsx`:

```tsx
import { Archive, Pencil, Trash2 } from "lucide-react";
import type { Collection } from "@/lib/types";
import { useTranslation } from "@/hooks/use-translation";
import type { MenuPrimitives } from "./menu-primitives";

interface CollectionMenuItemsProps {
  menu: MenuPrimitives;
  collection: Collection;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

/** The default collection can be edited but never archived or deleted. */
export function CollectionMenuItems({ menu, collection, onEdit, onArchive, onDelete }: CollectionMenuItemsProps) {
  const { t } = useTranslation();
  const { Item, Separator } = menu;
  return (
    <>
      <Item onSelect={onEdit}>
        <Pencil className="size-4" />
        {t("collectionMenu_edit")}
      </Item>
      {!collection.isDefault && (
        <>
          <Item onSelect={onArchive}>
            <Archive className="size-4" />
            {t("sidebar_archiveCollection")}
          </Item>
          <Separator />
          <Item variant="destructive" onSelect={onDelete}>
            <Trash2 className="size-4" />
            {t("sidebar_deleteCollection")}
          </Item>
        </>
      )}
    </>
  );
}
```

- [x] **Step 4: Create `components/dashboard/sidebar/collection-row.tsx`**

Move `ICON_MAP` and `CollectionIcon` (with their lucide icon imports) from `sidebar/index.tsx` into this file:

```tsx
import * as React from "react";
import { Link } from "react-router-dom";
import {
  Bookmark,
  BookOpen,
  ChevronRight,
  Code,
  Folder,
  Globe,
  Heart,
  Inbox,
  MoreHorizontal,
  Palette,
  Sparkles,
  Star,
  Wrench,
} from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useTranslation } from "@/hooks/use-translation";
import type { Collection } from "@/lib/types";
import { CollectionMenuItems } from "@/components/dashboard/shared/collection-menu-items";
import { contextMenuPrimitives, dropdownMenuPrimitives } from "@/components/dashboard/shared/menu-primitives";
import { CollectionDialog } from "./collection-dialog";

const ICON_MAP: Record<string, React.ElementType> = {
  folder: Folder,
  bookmark: Bookmark,
  code: Code,
  palette: Palette,
  wrench: Wrench,
  "book-open": BookOpen,
  sparkles: Sparkles,
  star: Star,
  heart: Heart,
  globe: Globe,
  inbox: Inbox,
};

function CollectionIcon({ icon }: { icon: string }) {
  const Icon = ICON_MAP[icon] ?? Folder;
  return <Icon className="size-4" />;
}

interface SidebarCollectionRowProps {
  collection: Collection;
  count: number;
  isActive: boolean;
  isHighlighted: boolean;
  onSelect: (collectionId: string) => void;
}

export function SidebarCollectionRow({ collection, count, isActive, isHighlighted, onSelect }: SidebarCollectionRowProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const updateCollection = useWorkspaceStore((s) => s.updateCollection);
  const archiveCollection = useWorkspaceStore((s) => s.archiveCollection);
  const deleteCollection = useWorkspaceStore((s) => s.deleteCollection);

  const handleEdit = React.useCallback(() => setEditing(true), []);
  const handleArchive = React.useCallback(() => archiveCollection(collection.id), [archiveCollection, collection.id]);
  const handleDelete = React.useCallback(() => deleteCollection(collection.id), [deleteCollection, collection.id]);

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarMenuButton
            asChild
            isActive={isActive}
            className={cn(
              "h-9 group/col transition-all",
              isHighlighted && "ring-2 ring-inset ring-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-500",
            )}
          >
            <Link to="/" onClick={() => onSelect(collection.id)}>
              <CollectionIcon icon={collection.icon} />
              <span className="flex-1 text-sm truncate">{collection.name}</span>
              <div className="flex items-center">
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("collectionMenu_more")}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      className={cn(
                        "flex items-center justify-center overflow-hidden text-muted-foreground hover:text-foreground transition-all duration-300 ease-out",
                        menuOpen
                          ? "w-4 mr-1 opacity-100 translate-x-0"
                          : "opacity-0 -translate-x-2 w-0 group-hover/col:w-4 group-hover/col:mr-1 group-hover/col:opacity-100 group-hover/col:translate-x-0",
                      )}
                    >
                      <MoreHorizontal className="size-3 shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  {/* The menu renders in a portal, but React still bubbles its clicks to the
                      row's Link; stop them so an action neither selects the collection nor navigates. */}
                  <DropdownMenuContent align="end" side="right" onClick={(event) => event.stopPropagation()}>
                    <CollectionMenuItems
                      menu={dropdownMenuPrimitives}
                      collection={collection}
                      onEdit={handleEdit}
                      onArchive={handleArchive}
                      onDelete={handleDelete}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className="text-muted-foreground text-xs shrink-0">{count}</span>
              </div>
              {isActive && <ChevronRight className="size-3.5 text-muted-foreground opacity-60 shrink-0 ml-1" />}
            </Link>
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <CollectionMenuItems
            menu={contextMenuPrimitives}
            collection={collection}
            onEdit={handleEdit}
            onArchive={handleArchive}
            onDelete={handleDelete}
          />
        </ContextMenuContent>
      </ContextMenu>
      {editing && (
        <CollectionDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setEditing(false);
            }
          }}
          initial={collection}
          onSubmit={(name, icon) => updateCollection(collection.id, { name, icon })}
        />
      )}
    </SidebarMenuItem>
  );
}
```

- [x] **Step 5: Translate `CollectionDialog` and use the row in the sidebar**

In `components/dashboard/sidebar/collection-dialog.tsx`, add `import { useTranslation } from "@/hooks/use-translation";`, call `const { t } = useTranslation();` first in the component, and replace the hard-coded strings:

| Current | Replacement |
|---|---|
| `{initial ? "Edit Collection" : "New Collection"}` | `{t(initial ? "collectionDialog_editTitle" : "collectionDialog_newTitle")}` |
| the two `DialogDescription` sentences | `{t(initial ? "collectionDialog_editDesc" : "collectionDialog_newDesc")}` |
| `Name` label | `{t("collectionDialog_nameLabel")}` |
| `placeholder="My Collection"` | `placeholder={t("collectionDialog_namePlaceholder")}` |
| `Icon` label | `{t("collectionDialog_iconLabel")}` |
| `Cancel` | `{t("settings_cancel")}` |
| `{initial ? "Save" : "Create"}` | `{t(initial ? "collectionDialog_save" : "collectionDialog_create")}` |

In `components/dashboard/sidebar/index.tsx`:

- Add `import { SidebarCollectionRow } from "./collection-row";`.
- Add after `bookmarkCounts`:

```tsx
  const handleSelectCollection = React.useCallback((collectionId: string) => {
    setSelectedCollection(collectionId);
    clearTags();
  }, [setSelectedCollection, clearTags]);
```

- Replace the body of `{workspaceCollections.map((col) => { ... })}` with:

```tsx
                  {workspaceCollections.map((col) => (
                    <DroppableZone key={col.id} id={`sidebar-collection-${col.id}`}>
                      <SidebarCollectionRow
                        collection={col}
                        count={bookmarkCounts[col.id] ?? 0}
                        isActive={isHomePage && selectedCollection === col.id}
                        isHighlighted={highlightedCollectionIds.includes(col.id)}
                        onSelect={handleSelectCollection}
                      />
                    </DroppableZone>
                  ))}
```

- Delete the `// Icon map` banner, `ICON_MAP`, `CollectionIcon`, and the `deleteCollection` and `archiveCollection` selectors.
- Remove the imports this leaves unused: the lucide icons `BookOpen`, `Code`, `Folder`, `Globe`, `Inbox`, `Palette`, `Sparkles`, `Star`, `Wrench`, `MoreHorizontal`, and the whole `@/components/ui/dropdown-menu` import. `Bookmark`, `ChevronRight`, `Heart`, `Archive`, `Trash2`, `Trash`, `Monitor` and `Plus` stay (the "All bookmarks" row, nav items, groups and add buttons use them). Leave imports that were already unused before this task (`Search`, `Input`, the `Collection` type) alone.

- [x] **Step 6: Add the strings**

`en`:

```json
  "collectionMenu_edit": { "message": "Edit…" },
  "collectionMenu_more": { "message": "Collection actions" },
  "collectionDialog_newTitle": { "message": "New collection" },
  "collectionDialog_editTitle": { "message": "Edit collection" },
  "collectionDialog_newDesc": { "message": "Create a collection to organize your bookmarks." },
  "collectionDialog_editDesc": { "message": "Change this collection's name and icon." },
  "collectionDialog_nameLabel": { "message": "Name" },
  "collectionDialog_namePlaceholder": { "message": "My collection" },
  "collectionDialog_iconLabel": { "message": "Icon" },
  "collectionDialog_create": { "message": "Create" },
  "collectionDialog_save": { "message": "Save" },
```

`zh_CN`:

```json
  "collectionMenu_edit": { "message": "编辑…" },
  "collectionMenu_more": { "message": "集合操作" },
  "collectionDialog_newTitle": { "message": "新建集合" },
  "collectionDialog_editTitle": { "message": "编辑集合" },
  "collectionDialog_newDesc": { "message": "创建一个集合来整理书签。" },
  "collectionDialog_editDesc": { "message": "修改这个集合的名称和图标。" },
  "collectionDialog_nameLabel": { "message": "名称" },
  "collectionDialog_namePlaceholder": { "message": "我的集合" },
  "collectionDialog_iconLabel": { "message": "图标" },
  "collectionDialog_create": { "message": "创建" },
  "collectionDialog_save": { "message": "保存" },
```

- [x] **Step 7: Run the tests**

Run: `bun test test/sidebar-collection-row.test.tsx && bun test && bun run compile`
Expected: 4 pass; suite 0 failures; compile exits 0.

- [x] **Step 8: Commit**

```bash
git add components/dashboard/shared/menu-primitives.tsx components/dashboard/shared/collection-menu-items.tsx components/dashboard/sidebar public/_locales test/sidebar-collection-row.test.tsx
git commit -m "feat(collections): edit collections and open their menu on right-click

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Bookmark card menu and clickable tags

**Files:**
- Create: `components/dashboard/shared/bookmark-menu-items.tsx`
- Modify: `components/ui/tag-list.tsx`
- Modify: `components/dashboard/bookmark-card.tsx`
- Modify: both `messages.json`
- Test: `test/bookmark-card-menu.test.tsx`

**Interfaces:**
- Consumes: `MenuPrimitives`, `dropdownMenuPrimitives`, `contextMenuPrimitives` (Task 11); context menu (Task 10).
- Produces: `BookmarkMenuItems({ menu, onOpenSmart, onOpenNewTab, onEdit, onAddTags, onArchive, onDelete })`; `TagList` gains optional `onTagClick?: (tagId: string) => void` and `selectedTagIds?: readonly string[]`.

- [x] **Step 1: Write the failing test**

`test/bookmark-card-menu.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  openDropdown,
  pressKey,
  render,
  rightClick,
  setupDom,
  teardownDom,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import {
  bookmarkMap,
  countsByCollection,
  makeBookmark,
  makeCollection,
  makeTag,
  makeWorkspace,
} from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
const smartOpenUrl = mock(async () => {});
const openInNewTab = mock(async () => {});
let app: AppModules;
let BookmarkCard: typeof import("@/components/dashboard/bookmark-card").BookmarkCard;
let view: RenderResult | null = null;

const MENU_ITEMS = [
  "bookmarkCard_openSmart",
  "bookmarkCard_openNewTab",
  "bookmarkCard_edit",
  "bookmarkCard_addTags",
  "bookmarkCard_archive",
  "bookmarkCard_delete",
];

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  const realTabs = await importFresh<typeof import("@/lib/chrome/tabs")>("lib/chrome/tabs.ts");
  await replacer.replace("@/lib/chrome/tabs", { ...realTabs, smartOpenUrl, openInNewTab });
  ({ BookmarkCard } = await importFresh<typeof import("@/components/dashboard/bookmark-card")>(
    "components/dashboard/bookmark-card.tsx",
  ));
});

afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

const article = makeBookmark("b1", { title: "Article", collectionId: "reading", tags: ["frontend"] });

beforeEach(() => {
  view?.unmount();
  smartOpenUrl.mockClear();
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
    tags: [makeTag("frontend", "Frontend")],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap([article]),
    countsByCollection: countsByCollection([article]),
    selectedTags: [],
  });
  view = render(app, createElement(BookmarkCard, { bookmark: article }));
});

const itemTexts = (slot: string) =>
  Array.from(document.querySelectorAll(`[data-slot="${slot}"]`)).map((item) => item.textContent?.trim());

describe("BookmarkCard menus", () => {
  test("right-click shows the same actions as the ⋯ menu", () => {
    rightClick(getBySelector('[data-bookmark-id="b1"]'));
    expect(itemTexts("context-menu-item")).toEqual(MENU_ITEMS);
    pressKey(getByText("bookmarkCard_openSmart"), "Escape");

    openDropdown(getBySelector('[aria-label="bookmarkCard_moreActions"]'));
    expect(itemTexts("dropdown-menu-item")).toEqual(MENU_ITEMS);
  });

  test("archiving from the right-click menu removes the bookmark from the active list", () => {
    rightClick(getBySelector('[data-bookmark-id="b1"]'));
    click(getByText("bookmarkCard_archive"));
    expect(app.useBookmarksStore.getState().bookmarks.has("b1")).toBe(false);
  });

  test("clicking a tag on the card filters by it without opening the bookmark", () => {
    click(getBySelector('button[data-tag-id="frontend"]'));
    expect(app.useBookmarksStore.getState().selectedTags).toEqual(["frontend"]);
    expect(getBySelector('button[data-tag-id="frontend"]').getAttribute("aria-pressed")).toBe("true");
    expect(smartOpenUrl).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/bookmark-card-menu.test.tsx`
Expected: FAIL — no `context-menu-item` elements after the right-click.

- [x] **Step 3: Create `components/dashboard/shared/bookmark-menu-items.tsx`**

```tsx
import { Archive, ExternalLink, Pencil, Tag as TagIcon, Trash2 } from "lucide-react";
import { useTranslation } from "@/hooks/use-translation";
import type { MenuPrimitives } from "./menu-primitives";

interface BookmarkMenuItemsProps {
  menu: MenuPrimitives;
  onOpenSmart: () => void;
  onOpenNewTab: () => void;
  onEdit: () => void;
  onAddTags: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

export function BookmarkMenuItems({
  menu,
  onOpenSmart,
  onOpenNewTab,
  onEdit,
  onAddTags,
  onArchive,
  onDelete,
}: BookmarkMenuItemsProps) {
  const { t } = useTranslation();
  const { Item, Separator } = menu;
  return (
    <>
      <Item onSelect={onOpenSmart}>
        <ExternalLink className="size-4" />
        {t("bookmarkCard_openSmart")}
      </Item>
      <Item onSelect={onOpenNewTab}>
        <ExternalLink className="size-4" />
        {t("bookmarkCard_openNewTab")}
      </Item>
      <Item onSelect={onEdit}>
        <Pencil className="size-4" />
        {t("bookmarkCard_edit")}
      </Item>
      <Item onSelect={onAddTags}>
        <TagIcon className="size-4" />
        {t("bookmarkCard_addTags")}
      </Item>
      <Separator />
      <Item onSelect={onArchive}>
        <Archive className="size-4" />
        {t("bookmarkCard_archive")}
      </Item>
      <Item variant="destructive" onSelect={onDelete}>
        <Trash2 className="size-4" />
        {t("bookmarkCard_delete")}
      </Item>
    </>
  );
}
```

- [x] **Step 4: Make `TagList` tags clickable**

Replace `components/ui/tag-list.tsx` with:

```tsx
import { cn } from "@/lib/utils";
import type { Tag } from "@/lib/types";

interface TagListProps {
  tags: Tag[];
  /** Maximum number of tags to show before "+N" overflow indicator */
  max?: number;
  className?: string;
  /** Whether tags should wrap to multiple lines (grid variant) */
  wrap?: boolean;
  /** Makes each tag a button; the click does not reach the surrounding card. */
  onTagClick?: (tagId: string) => void;
  /** Tags currently used as filters, announced with aria-pressed. */
  selectedTagIds?: readonly string[];
}

export function TagList({ tags, max = 3, className, wrap = false, onTagClick, selectedTagIds }: TagListProps) {
  if (tags.length === 0) { return null; }

  const visible = tags.slice(0, max);
  const overflow = tags.length - max;

  return (
    <div className={cn("flex items-center gap-1", wrap && "flex-wrap", className)}>
      {visible.map((tag) => {
        const tagClass = cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium", tag.color);
        if (!onTagClick) {
          return (
            <span key={tag.id} className={tagClass}>
              {tag.name}
            </span>
          );
        }
        const selected = selectedTagIds?.includes(tag.id) ?? false;
        return (
          <button
            key={tag.id}
            type="button"
            data-tag-id={tag.id}
            aria-pressed={selected}
            onClick={(event) => {
              event.stopPropagation();
              onTagClick(tag.id);
            }}
            className={cn(tagClass, "cursor-pointer hover:opacity-80", selected && "ring-1 ring-current")}
          >
            {tag.name}
          </button>
        );
      })}
      {overflow > 0 && (
        <span className="text-[10px] text-muted-foreground py-0.5">
          +{overflow}{wrap ? " more" : ""}
        </span>
      )}
    </div>
  );
}
```

- [x] **Step 5: Update `components/dashboard/bookmark-card.tsx`**

- Imports: remove `Pencil`, `Trash2`, `Tag as TagIcon` and `Archive` from `lucide-react` and `DropdownMenuItem` and `DropdownMenuSeparator` from the dropdown import (`ExternalLink` stays: the list variant's quick-open button uses it). Add:

```tsx
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { BookmarkMenuItems } from "@/components/dashboard/shared/bookmark-menu-items";
import {
  contextMenuPrimitives,
  dropdownMenuPrimitives,
  type MenuPrimitives,
} from "@/components/dashboard/shared/menu-primitives";
```
- Add selectors next to the existing ones:

```tsx
  const selectedTags = useBookmarksStore((s) => s.selectedTags);
  const toggleTag = useBookmarksStore((s) => s.toggleTag);
```

- Replace the whole `const actionsMenu = React.useMemo(...)` block with:

```tsx
  const handleEdit = React.useCallback(() => onEdit?.(bookmark), [onEdit, bookmark]);
  const handleAddTags = React.useCallback(() => onAddTags?.(bookmark), [onAddTags, bookmark]);
  const handleArchive = React.useCallback(() => archiveBookmark(bookmark.id), [archiveBookmark, bookmark.id]);
  const handleDelete = React.useCallback(() => trashBookmark(bookmark.id), [trashBookmark, bookmark.id]);

  const renderMenuItems = (menu: MenuPrimitives) => (
    <BookmarkMenuItems
      menu={menu}
      onOpenSmart={handleSmartOpen}
      onOpenNewTab={handleNewTabOpen}
      onEdit={handleEdit}
      onAddTags={handleAddTags}
      onArchive={handleArchive}
      onDelete={handleDelete}
    />
  );
```

- In both variants, replace `{actionsMenu}` with `<DropdownMenuContent align="end">{renderMenuItems(dropdownMenuPrimitives)}</DropdownMenuContent>`, and give the ⋯ trigger button `aria-label={t("bookmarkCard_moreActions")}`.
- In both variants, replace the outer fragment `<>` … `</>` around the card's root `<div data-bookmark-id=...>` with:

```tsx
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* the existing <div data-bookmark-id={bookmark.id} …> … </div> */}
        </ContextMenuTrigger>
        <ContextMenuContent>{renderMenuItems(contextMenuPrimitives)}</ContextMenuContent>
      </ContextMenu>
```

- Pass the filter props to both `TagList` usages:

```tsx
<TagList tags={bookmarkTags} max={2} className="hidden sm:flex" onTagClick={toggleTag} selectedTagIds={selectedTags} />
```

```tsx
<TagList tags={bookmarkTags} max={3} onTagClick={toggleTag} selectedTagIds={selectedTags} />
```

- [x] **Step 6: Add the string**

`en`: `"bookmarkCard_moreActions": { "message": "Bookmark actions" },` · `zh_CN`: `"bookmarkCard_moreActions": { "message": "书签操作" },`

- [x] **Step 7: Run the tests**

Run: `bun test test/bookmark-card-menu.test.tsx && bun test && bun run compile`
Expected: 3 pass; suite 0 failures; compile exits 0.

- [x] **Step 8: Commit**

```bash
git add components/dashboard/shared/bookmark-menu-items.tsx components/ui/tag-list.tsx components/dashboard/bookmark-card.tsx public/_locales test/bookmark-card-menu.test.tsx
git commit -m "feat(bookmarks): right-click bookmark cards and filter by their tags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Reveal a bookmark and the highlight deep link

**Files:**
- Create: `lib/reveal-bookmark.ts`
- Create: `lib/highlight-link.ts`
- Create: `hooks/use-workspace-collection-reset.ts`
- Create: `hooks/use-highlight-deep-link.ts`
- Modify: `components/dashboard/content.tsx`
- Tests: `test/reveal-bookmark.test.ts`, `test/workspace-collection-reset.test.tsx`, `test/highlight-deep-link.test.tsx`

**Interfaces:**
- Produces: `revealBookmark(bookmarkId: string): boolean`; `useWorkspaceCollectionReset(selectedCollection: string, workspaceCollectionIds: ReadonlySet<string>, setSelectedCollection: (collectionId: string) => void): void`; `HIGHLIGHT_PARAM = "highlight"` in `lib/highlight-link.ts` (no store imports, so the popup can use it); `useHighlightDeepLink(): void`.

- [x] **Step 1: Write the failing tests**

`test/reveal-bookmark.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { installAppModules, setupDom, teardownDom, type AppModules } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let revealBookmark: typeof import("@/lib/reveal-bookmark").revealBookmark;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ revealBookmark } = await importFresh<typeof import("@/lib/reveal-bookmark")>("lib/reveal-bookmark.ts"));
});

afterAll(async () => {
  app.useBookmarksStore.getState().setHighlightedBookmarkId(null);
  replacer.restore();
  await teardownDom();
});

beforeEach(() => {
  const bookmarks = [
    makeBookmark("in-projects", { collectionId: "projects" }),
    makeBookmark("loose", { collectionId: "" }),
    makeBookmark("in-archive", { collectionId: "old" }),
  ];
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home"), makeWorkspace("work")],
    collections: [
      makeCollection("reading", "home", { isDefault: true }),
      makeCollection("projects", "work", { isDefault: true }),
      makeCollection("old", "home", { archivedAt: 1 }),
    ],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedCollection: "reading",
    selectedTags: ["go"],
    filterType: "favorites",
    searchQuery: "draft",
    highlightedBookmarkId: null,
  });
});

describe("revealBookmark", () => {
  test("switches to the bookmark's workspace and collection and clears what could hide it", () => {
    expect(revealBookmark("in-projects")).toBe(true);

    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("work");
    const state = app.useBookmarksStore.getState();
    expect([state.selectedCollection, state.selectedTags, state.filterType, state.searchQuery, state.highlightedBookmarkId])
      .toEqual(["projects", [], "all", "", "in-projects"]);
  });

  test("shows an uncategorized bookmark under all bookmarks in the current workspace", () => {
    expect(revealBookmark("loose")).toBe(true);
    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("home");
    expect(app.useBookmarksStore.getState().selectedCollection).toBe("all");
  });

  test("refuses a bookmark the normal list never shows", () => {
    expect(revealBookmark("in-archive")).toBe(false);
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBeNull();
    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("home");
  });

  test("refuses an unknown bookmark", () => {
    expect(revealBookmark("missing")).toBe(false);
  });
});
```

`test/workspace-collection-reset.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { getBySelector, render, setupDom, teardownDom } from "./helpers/dom-environment";

const replacer = createModuleReplacer();
let createRoot: typeof import("react-dom/client").createRoot;
let useWorkspaceCollectionReset: typeof import("@/hooks/use-workspace-collection-reset").useWorkspaceCollectionReset;

beforeAll(async () => {
  setupDom();
  const reactDomClient = await importFresh<typeof import("react-dom/client")>("node_modules/react-dom/client.js");
  await replacer.replace("react-dom/client", reactDomClient);
  createRoot = reactDomClient.createRoot;
  ({ useWorkspaceCollectionReset } = await importFresh<typeof import("@/hooks/use-workspace-collection-reset")>(
    "hooks/use-workspace-collection-reset.ts",
  ));
});

afterAll(async () => {
  replacer.restore();
  await teardownDom();
});

function Probe({ ids, selected }: { ids: ReadonlySet<string>; selected: string }) {
  const [selection, setSelection] = useState(selected);
  useWorkspaceCollectionReset(selection, ids, setSelection);
  return createElement("span", { id: "selection" }, selection);
}

describe("useWorkspaceCollectionReset", () => {
  test("keeps a collection that belongs to the active workspace", () => {
    const view = render({ createRoot }, createElement(Probe, { ids: new Set(["projects"]), selected: "projects" }));
    expect(getBySelector("#selection").textContent).toBe("projects");
    view.unmount();
  });

  test("falls back to all bookmarks when the selection is not in the workspace", () => {
    const view = render({ createRoot }, createElement(Probe, { ids: new Set(["projects"]), selected: "reading" }));
    expect(getBySelector("#selection").textContent).toBe("all");
    view.unmount();
  });
});
```

`test/highlight-deep-link.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { getBySelector, installAppModules, render, setupDom, teardownDom, type AppModules } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let useHighlightDeepLink: typeof import("@/hooks/use-highlight-deep-link").useHighlightDeepLink;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ useHighlightDeepLink } = await importFresh<typeof import("@/hooks/use-highlight-deep-link")>(
    "hooks/use-highlight-deep-link.ts",
  ));
});

afterAll(async () => {
  app.useBookmarksStore.getState().setHighlightedBookmarkId(null);
  replacer.restore();
  await teardownDom();
});

beforeEach(() => {
  const bookmarks = [makeBookmark("b1", { collectionId: "reading" })];
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    highlightedBookmarkId: null,
  });
});

function Probe() {
  useHighlightDeepLink();
  return createElement("span", { id: "search" }, useLocation().search);
}

function renderAt(entry: string) {
  return render(app, createElement(MemoryRouter, { initialEntries: [entry] }, createElement(Probe)));
}

describe("useHighlightDeepLink", () => {
  test("reveals the bookmark and removes the parameter", () => {
    const view = renderAt("/?highlight=b1");
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBe("b1");
    expect(getBySelector("#search").textContent).toBe("");
    view.unmount();
  });

  test("removes the parameter for an unknown bookmark", () => {
    const view = renderAt("/?highlight=missing");
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBeNull();
    expect(getBySelector("#search").textContent).toBe("");
    view.unmount();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun test test/reveal-bookmark.test.ts test/workspace-collection-reset.test.tsx test/highlight-deep-link.test.tsx`
Expected: FAIL — the three modules do not exist.

- [x] **Step 3: Implement the three modules**

`lib/reveal-bookmark.ts`:

```ts
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { isActiveWorkspace } from "@/lib/workspace-visibility";

/**
 * Shows one bookmark in the main list: switches to its workspace and
 * collection, clears the tag, filter and search state that could hide it, and
 * flashes it. Returns false for an unknown bookmark or one the normal list
 * never shows (archived or trashed collection, retained workspace).
 */
export function revealBookmark(bookmarkId: string): boolean {
  const bookmarks = useBookmarksStore.getState();
  const bookmark = bookmarks.bookmarks.get(bookmarkId);
  if (!bookmark) {
    return false;
  }

  let targetCollection = "all";
  if (bookmark.collectionId !== "") {
    const workspaceState = useWorkspaceStore.getState();
    const collection = workspaceState.collections.find((candidate) => candidate.id === bookmark.collectionId);
    if (!collection || collection.deletedAt || collection.archivedAt) {
      return false;
    }
    const workspace = workspaceState.workspaces.find((candidate) => candidate.id === collection.workspaceId);
    if (!isActiveWorkspace(workspace)) {
      return false;
    }
    if (workspaceState.activeWorkspaceId !== workspace.id) {
      workspaceState.setActiveWorkspaceId(workspace.id);
    }
    targetCollection = collection.id;
  }

  bookmarks.setSelectedCollection(targetCollection);
  bookmarks.clearTags();
  bookmarks.setFilterType("all");
  bookmarks.setSearchQuery("");
  bookmarks.setHighlightedBookmarkId(bookmark.id);
  return true;
}
```

`hooks/use-workspace-collection-reset.ts`:

```ts
import { useEffect } from "react";

/**
 * Falls back to "All bookmarks" when the selected collection is not part of
 * the active workspace. A collection selected together with a workspace
 * switch (revealBookmark) already belongs to it and is kept.
 */
export function useWorkspaceCollectionReset(
  selectedCollection: string,
  workspaceCollectionIds: ReadonlySet<string>,
  setSelectedCollection: (collectionId: string) => void,
): void {
  useEffect(() => {
    if (selectedCollection !== "all" && !workspaceCollectionIds.has(selectedCollection)) {
      setSelectedCollection("all");
    }
  }, [selectedCollection, workspaceCollectionIds, setSelectedCollection]);
}
```

`lib/highlight-link.ts`:

```ts
/**
 * Query parameter of the newtab link that reveals one bookmark:
 * `newtab.html#/?highlight=<bookmarkId>`. Kept free of store imports because
 * the popup builds these links and must not load Zustand.
 */
export const HIGHLIGHT_PARAM = "highlight";
```

`hooks/use-highlight-deep-link.ts`:

```ts
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { revealBookmark } from "@/lib/reveal-bookmark";
import { HIGHLIGHT_PARAM } from "@/lib/highlight-link";

/** Reveals the bookmark named by `#/?highlight=<id>` once, then removes the parameter. */
export function useHighlightDeepLink(): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const bookmarkId = searchParams.get(HIGHLIGHT_PARAM);

  useEffect(() => {
    if (!bookmarkId) {
      return;
    }
    revealBookmark(bookmarkId);
    setSearchParams(
      (params) => {
        params.delete(HIGHLIGHT_PARAM);
        return params;
      },
      { replace: true },
    );
  }, [bookmarkId, setSearchParams]);
}
```

- [x] **Step 4: Use the hooks in `components/dashboard/content.tsx`**

- Add imports: `import { useWorkspaceCollectionReset } from "@/hooks/use-workspace-collection-reset";` and `import { useHighlightDeepLink } from "@/hooks/use-highlight-deep-link";`.
- Delete:

```tsx
  const prevWorkspaceIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (prevWorkspaceIdRef.current !== null && prevWorkspaceIdRef.current !== activeWorkspaceId) {
      setSelectedCollection("all");
    }
    prevWorkspaceIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId, setSelectedCollection]);
```

- Replace:

```tsx
  React.useEffect(() => {
    if (selectedCollection !== "all" && !workspaceCollectionIds.has(selectedCollection)) {
      setSelectedCollection("all");
    }
  }, [selectedCollection, setSelectedCollection, workspaceCollectionIds]);
```

with:

```tsx
  useWorkspaceCollectionReset(selectedCollection, workspaceCollectionIds, setSelectedCollection);
  useHighlightDeepLink();
```

- [x] **Step 5: Run the tests**

Run: `bun test test/reveal-bookmark.test.ts test/workspace-collection-reset.test.tsx test/highlight-deep-link.test.tsx && bun test && bun run compile`
Expected: all pass; suite 0 failures; compile exits 0.

- [x] **Step 6: Commit**

```bash
git add lib/reveal-bookmark.ts lib/highlight-link.ts hooks/use-workspace-collection-reset.ts hooks/use-highlight-deep-link.ts components/dashboard/content.tsx test/reveal-bookmark.test.ts test/workspace-collection-reset.test.tsx test/highlight-deep-link.test.tsx
git commit -m "feat(bookmarks): reveal a bookmark in the list and support highlight links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Duplicate notice in the add bookmark dialog

**Files:**
- Create: `components/dashboard/shared/duplicate-notice.tsx`
- Modify: `components/dashboard/add-bookmark-dialog.tsx`
- Modify: both `messages.json`
- Modify: `test/bookmarks-header-subscription.test.tsx` (the header now needs a router)
- Test: `test/add-bookmark-duplicates.test.tsx`

**Interfaces:**
- Consumes: `findVisibleDuplicates`, `DuplicateMatch` (Task 3); `revealBookmark` (Task 13); `bookmarksAsArray`.
- Produces: `DuplicateNotice({ matches: readonly DuplicateMatch[]; onOpenExisting: (bookmarkId: string) => void; className?: string })`, rendering `data-slot="duplicate-notice"` and nothing when `matches` is empty.

- [x] **Step 1: Write the failing test**

`test/add-bookmark-duplicates.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  queryByText,
  render,
  setupDom,
  teardownDom,
  typeInto,
  wait,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let AddBookmarkDialog: typeof import("@/components/dashboard/add-bookmark-dialog").AddBookmarkDialog;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ AddBookmarkDialog } = await importFresh<typeof import("@/components/dashboard/add-bookmark-dialog")>(
    "components/dashboard/add-bookmark-dialog.tsx",
  ));
});

afterAll(async () => {
  view?.unmount();
  app.useBookmarksStore.getState().setHighlightedBookmarkId(null);
  replacer.restore();
  await teardownDom();
});

function Host() {
  const [open, setOpen] = useState(true);
  return open ? createElement(AddBookmarkDialog, { open, onOpenChange: setOpen }) : createElement("p", null, "closed");
}

beforeEach(() => {
  view?.unmount();
  const saved = makeBookmark("saved", { collectionId: "projects", url: "https://example.com/post" });
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home", { name: "Home" }), makeWorkspace("work", { name: "Work" })],
    collections: [
      makeCollection("reading", "home", { name: "Reading", isDefault: true }),
      makeCollection("projects", "work", { name: "Projects", isDefault: true }),
    ],
    tags: [],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap([saved]),
    countsByCollection: countsByCollection([saved]),
    highlightedBookmarkId: null,
  });
  view = render(app, createElement(MemoryRouter, null, createElement(Host)));
});

describe("add bookmark duplicate notice", () => {
  test("warns about a saved variant of the address and shows where it lives", async () => {
    typeInto(getBySelector<HTMLInputElement>("#bm-url"), "http://www.example.com/post?utm_source=feed");
    await wait(350);

    const notice = getBySelector('[data-slot="duplicate-notice"]');
    expect(notice.textContent).toContain("duplicateNotice_location[Projects,Work]");
  });

  test("open existing bookmark closes the dialog and reveals the bookmark", async () => {
    typeInto(getBySelector<HTMLInputElement>("#bm-url"), "example.com/post");
    await wait(350);
    click(getByText("duplicateNotice_openExisting"));

    expect(getByText("closed")).toBeTruthy();
    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("work");
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBe("saved");
  });

  test("stays quiet for an address that is not saved", async () => {
    typeInto(getBySelector<HTMLInputElement>("#bm-url"), "https://example.com/other");
    await wait(350);

    expect(document.querySelector('[data-slot="duplicate-notice"]')).toBeNull();
    expect(queryByText("closed")).toBeNull();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/add-bookmark-duplicates.test.tsx`
Expected: FAIL — no element matches `[data-slot="duplicate-notice"]`.

- [x] **Step 3: Create `components/dashboard/shared/duplicate-notice.tsx`**

```tsx
import { Copy } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/use-translation";
import type { DuplicateMatch } from "@/lib/duplicate-lookup";

interface DuplicateNoticeProps {
  matches: readonly DuplicateMatch[];
  onOpenExisting: (bookmarkId: string) => void;
  className?: string;
}

/** Saving stays possible; this only says where the address is already saved. */
export function DuplicateNotice({ matches, onOpenExisting, className }: DuplicateNoticeProps) {
  const { t } = useTranslation();
  const first = matches[0];
  if (!first) {
    return null;
  }
  const location = first.collection && first.workspace
    ? t("duplicateNotice_location", [first.collection.name, first.workspace.name])
    : t("duplicateNotice_uncategorized");

  return (
    <Alert data-slot="duplicate-notice" role="status" className={cn("py-2", className)}>
      <Copy />
      <AlertDescription className="flex flex-wrap items-center gap-x-2">
        <span>{t("duplicateNotice_alreadySaved", [location])}</span>
        {matches.length > 1 && <span>{t("duplicateNotice_more", [String(matches.length - 1)])}</span>}
        <Button type="button" variant="link" size="xs" className="px-0" onClick={() => onOpenExisting(first.bookmark.id)}>
          {t("duplicateNotice_openExisting")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
```

- [x] **Step 4: Wire the dialog**

In `components/dashboard/add-bookmark-dialog.tsx`:

- Imports: change `import { useBookmarksStore } from "@/store/bookmarks-store";` to `import { bookmarksAsArray, useBookmarksStore } from "@/store/bookmarks-store";` and add:

```tsx
import { useNavigate } from "react-router-dom";
import { findVisibleDuplicates } from "@/lib/duplicate-lookup";
import { revealBookmark } from "@/lib/reveal-bookmark";
import { DuplicateNotice } from "@/components/dashboard/shared/duplicate-notice";
```

- After `const [targetUnavailable, setTargetUnavailable] = React.useState(false);` add:

```tsx
  const navigate = useNavigate();
  const bookmarks = useBookmarksStore(s => s.bookmarks);
  const [urlInput, setUrlInput] = React.useState("");
  const [duplicateUrl, setDuplicateUrl] = React.useState("");

  React.useEffect(() => {
    const timer = setTimeout(() => setDuplicateUrl(urlInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [urlInput]);

  const duplicateMatches = React.useMemo(() => {
    if (!duplicateUrl) {
      return [];
    }
    const candidate = /^https?:\/\//i.test(duplicateUrl) ? duplicateUrl : `https://${duplicateUrl}`;
    return findVisibleDuplicates(
      candidate,
      { bookmarks: bookmarksAsArray(bookmarks), collections, workspaces },
      "loose",
    );
  }, [duplicateUrl, bookmarks, collections, workspaces]);

  const handleOpenExisting = (bookmarkId: string) => {
    onOpenChange(false);
    navigate("/");
    revealBookmark(bookmarkId);
  };
```

- In the existing "Reset form when dialog opens" effect, add `setUrlInput("");` and `setDuplicateUrl("");` inside `if (open)`.
- On the URL `<Input id="bm-url" ...>`, add `value={urlInput}` and `onChange={(event) => setUrlInput(event.target.value)}`.
- Right after the URL `</Field>`, add `<DuplicateNotice matches={duplicateMatches} onOpenExisting={handleOpenExisting} />`.

- [x] **Step 5: Add the strings**

`en`:

```json
  "duplicateNotice_alreadySaved": { "message": "Already saved in $1", "placeholders": { "1": { "content": "$1" } } },
  "duplicateNotice_location": { "message": "$1 · $2", "placeholders": { "1": { "content": "$1" }, "2": { "content": "$2" } } },
  "duplicateNotice_uncategorized": { "message": "Uncategorized" },
  "duplicateNotice_more": { "message": "and $1 more", "placeholders": { "1": { "content": "$1" } } },
  "duplicateNotice_openExisting": { "message": "Open existing bookmark" },
```

`zh_CN`:

```json
  "duplicateNotice_alreadySaved": { "message": "已保存在 $1", "placeholders": { "1": { "content": "$1" } } },
  "duplicateNotice_location": { "message": "$1 · $2", "placeholders": { "1": { "content": "$1" }, "2": { "content": "$2" } } },
  "duplicateNotice_uncategorized": { "message": "未分类" },
  "duplicateNotice_more": { "message": "另有 $1 处", "placeholders": { "1": { "content": "$1" } } },
  "duplicateNotice_openExisting": { "message": "打开已有书签" },
```

- [x] **Step 6: Keep the header test inside a router**

`BookmarksHeader` always renders `AddBookmarkDialog`, which now calls `useNavigate()`; in the app the header already sits inside `HashRouter`. In `test/bookmarks-header-subscription.test.tsx`, add `import { MemoryRouter } from "react-router-dom";` after the `react` import and make `renderHeader` render:

```ts
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          SidebarProvider,
          null,
          createElement(
            Profiler,
            { id: "bookmarks-header", onRender: () => { commits += 1; } },
            createElement(BookmarksHeader),
          ),
        ),
      ),
    );
```

- [x] **Step 7: Run the tests**

Run: `bun test test/add-bookmark-duplicates.test.tsx test/bookmarks-header-subscription.test.tsx && bun test && bun run compile`
Expected: 5 pass; suite 0 failures; compile exits 0.

- [x] **Step 8: Commit**

```bash
git add components/dashboard/shared/duplicate-notice.tsx components/dashboard/add-bookmark-dialog.tsx public/_locales test/add-bookmark-duplicates.test.tsx test/bookmarks-header-subscription.test.tsx
git commit -m "feat(bookmarks): warn about saved duplicates in the add bookmark dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Duplicate notice in the popup

**Files:**
- Modify: `lib/storage.ts`
- Modify: `entrypoints/popup/App.tsx`
- Modify: both `messages.json`
- Test: `test/storage-duplicates.test.ts`

**Interfaces:**
- Consumes: `findVisibleDuplicates` (Task 3), `DuplicateNotice` (Task 14), `HIGHLIGHT_PARAM` from `lib/highlight-link.ts` (Task 13). The popup must not import stores or hooks that load them.
- Produces: `findSavedDuplicates(url: string): Promise<DuplicateMatch[]>` (never throws; returns `[]` when IndexedDB fails).

- [x] **Step 1: Write the failing test**

`test/storage-duplicates.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let failReads = false;
const stores: Record<string, unknown[]> = {
  bookmarks: [
    makeBookmark("saved", { collectionId: "reading", url: "https://example.com/post" }),
    makeBookmark("archived-parent", { collectionId: "old", url: "https://example.com/post" }),
  ],
  workspaces: [makeWorkspace("home")],
  collections: [makeCollection("reading", "home"), makeCollection("old", "home", { archivedAt: 1 })],
  tags: [],
};
let findSavedDuplicates: typeof import("@/lib/storage").findSavedDuplicates;

beforeAll(async () => {
  const realIdb = await importFresh<typeof import("@/lib/idb")>("lib/idb.ts");
  await replacer.replace("@/lib/idb", {
    ...realIdb,
    idbGetAll: async (store: string) => {
      if (failReads) {
        throw new Error("IndexedDB unavailable");
      }
      return stores[store] ?? [];
    },
    idbGet: async (_store: string, key: string) =>
      key === "activeWorkspaceId" ? { key, value: "home" } : undefined,
  });
  ({ findSavedDuplicates } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts"));
});

afterAll(() => {
  replacer.restore();
});

beforeEach(() => {
  failReads = false;
});

describe("findSavedDuplicates", () => {
  test("finds visible saved variants of the page", async () => {
    const matches = await findSavedDuplicates("http://www.example.com/post#comments");
    expect(matches.map((match) => match.bookmark.id)).toEqual(["saved"]);
  });

  test("reports no duplicates when IndexedDB cannot be read", async () => {
    failReads = true;
    expect(await findSavedDuplicates("https://example.com/post")).toEqual([]);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test test/storage-duplicates.test.ts`
Expected: FAIL — `findSavedDuplicates is not a function`.

- [x] **Step 3: Implement in `lib/storage.ts`**

Add `import { findVisibleDuplicates, type DuplicateMatch } from "@/lib/duplicate-lookup";` and append:

```ts
/**
 * Saved bookmarks that look like the given page (loose tier), for the popup's
 * notice. A failed lookup reports no duplicates so saving still works.
 */
export async function findSavedDuplicates(url: string): Promise<DuplicateMatch[]> {
  try {
    const [bookmarks, state] = await Promise.all([idbGetAll<Bookmark>("bookmarks"), getWorkspaceState()]);
    return findVisibleDuplicates(
      url,
      { bookmarks, collections: state.collections, workspaces: state.workspaces },
      "loose",
    );
  } catch (err) {
    console.warn("[TabSlate] duplicate lookup failed:", err);
    return [];
  }
}
```

- [x] **Step 4: Wire the popup (`entrypoints/popup/App.tsx`)**

- Change the storage import to `import { storageService, getWorkspaceState, findSavedDuplicates, type BookmarkInput } from "@/lib/storage";` and add:

```tsx
import { DuplicateNotice } from "@/components/dashboard/shared/duplicate-notice";
import type { DuplicateMatch } from "@/lib/duplicate-lookup";
import { HIGHLIGHT_PARAM } from "@/lib/highlight-link";
```

- Add state: `const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);`
- Inside the `chrome.tabs.query` callback, after the `if (activeTab) { setTab(...) }` block, add:

```tsx
          if (activeTab?.url) {
            void findSavedDuplicates(activeTab.url).then(setDuplicates);
          }
```

- Add next to `openTabSlate`:

```tsx
  const openExistingBookmark = (bookmarkId: string) => {
    chrome.tabs.create({
      url: `${chrome.runtime.getURL("newtab.html")}#/?${HIGHLIGHT_PARAM}=${encodeURIComponent(bookmarkId)}`,
    });
    window.close();
  };
```

- In the save form, right after the "Current page preview" block, add `<DuplicateNotice matches={duplicates} onOpenExisting={openExistingBookmark} />`.
- In the save button's idle branch, replace `{t("popup_saveBookmark")}` with `{duplicates.length > 0 ? t("popup_saveAnyway") : t("popup_saveBookmark")}`.

- [x] **Step 5: Add the string**

`en`: `"popup_saveAnyway": { "message": "Save anyway" },` · `zh_CN`: `"popup_saveAnyway": { "message": "仍然保存" },`

- [x] **Step 6: Run the tests**

Run: `bun test test/storage-duplicates.test.ts && bun run compile`
Expected: 2 pass; compile exits 0.

- [x] **Step 7: Commit**

```bash
git add lib/storage.ts entrypoints/popup/App.tsx public/_locales test/storage-duplicates.test.ts
git commit -m "feat(popup): warn when the page is already saved

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Context-menu saves skip duplicates and show a badge

**Files:**
- Create: `lib/context-menu-save.ts`
- Create: `lib/browser/action-badge.ts`
- Modify: `entrypoints/background.ts`
- Modify: both `messages.json`
- Tests: `test/context-menu-save.test.ts`, `test/action-badge.test.ts`

**Interfaces:**
- Consumes: `findVisibleDuplicates`, `BookmarkLibrary` (Task 3); `getWorkspaceState` (`lib/storage.ts`).
- Produces: `interface ContextMenuLibrary extends BookmarkLibrary { activeWorkspaceId: string }`; `type ContextMenuSaveOutcome = "save" | "duplicate"`; `resolveContextMenuSave(url: string, loadLibrary: () => Promise<ContextMenuLibrary>): Promise<ContextMenuSaveOutcome>`; `type SaveBadgeKind = "saved" | "duplicate"`; `flashSaveBadge(tabId: number, kind: SaveBadgeKind, durationMs?: number): Promise<void>` (default 3000 ms).

- [x] **Step 1: Write the failing tests**

`test/context-menu-save.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";
import { makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const { resolveContextMenuSave } =
  await importFresh<typeof import("@/lib/context-menu-save")>("lib/context-menu-save.ts");

const library = {
  activeWorkspaceId: "home",
  workspaces: [makeWorkspace("home"), makeWorkspace("work")],
  collections: [makeCollection("reading", "home"), makeCollection("projects", "work")],
  bookmarks: [
    makeBookmark("home-post", { collectionId: "reading", url: "https://example.com/post" }),
    makeBookmark("work-page", { collectionId: "projects", url: "https://example.com/work" }),
  ],
};
const load = async () => library;

describe("resolveContextMenuSave", () => {
  test("skips the same address in the active workspace", async () => {
    expect(await resolveContextMenuSave("https://EXAMPLE.com/post/", load)).toBe("duplicate");
  });
  test("saves an address that only exists in another workspace", async () => {
    expect(await resolveContextMenuSave("https://example.com/work", load)).toBe("save");
  });
  test("saves a variant that only the loose tier would match", async () => {
    expect(await resolveContextMenuSave("http://example.com/post", load)).toBe("save");
  });
  test("saves when the library cannot be read", async () => {
    expect(await resolveContextMenuSave("https://example.com/post", async () => {
      throw new Error("IndexedDB unavailable");
    })).toBe("save");
  });
});
```

`test/action-badge.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterEach, describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";

const originalChrome = Reflect.get(globalThis, "chrome");
const messages: Record<string, string> = {
  badge_alreadySavedShort: "Dup",
  badge_alreadySavedTitle: "Already saved in TabSlate",
};

function stubChrome(failBadge = false) {
  const calls: Array<[string, unknown]> = [];
  Reflect.set(globalThis, "chrome", {
    i18n: { getMessage: (key: string) => messages[key] ?? "" },
    action: {
      getTitle: async () => "TabSlate",
      setTitle: async (details: unknown) => {
        calls.push(["setTitle", details]);
      },
      setBadgeText: async (details: unknown) => {
        if (failBadge) {
          throw new Error("no action");
        }
        calls.push(["setBadgeText", details]);
      },
      setBadgeBackgroundColor: async (details: unknown) => {
        calls.push(["setBadgeBackgroundColor", details]);
      },
    },
  });
  return calls;
}

afterEach(() => {
  Reflect.set(globalThis, "chrome", originalChrome);
});

// Short badge durations keep the clearing timer inside each test, while the chrome stub is installed.
const outlast = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("flashSaveBadge", () => {
  test("marks a skipped duplicate in amber with an explanatory tooltip, then restores the action", async () => {
    const calls = stubChrome();
    const { flashSaveBadge } = await importFresh<typeof import("@/lib/browser/action-badge")>("lib/browser/action-badge.ts");

    await flashSaveBadge(7, "duplicate", 5);

    expect(calls).toEqual([
      ["setBadgeBackgroundColor", { tabId: 7, color: "#d97706" }],
      ["setBadgeText", { tabId: 7, text: "Dup" }],
      ["setTitle", { tabId: 7, title: "Already saved in TabSlate" }],
    ]);

    await outlast(30);

    expect(calls.slice(3)).toEqual([
      ["setBadgeText", { tabId: 7, text: "" }],
      ["setTitle", { tabId: 7, title: "TabSlate" }],
    ]);
  });

  test("marks a successful save with a green check, then clears it", async () => {
    const calls = stubChrome();
    const { flashSaveBadge } = await importFresh<typeof import("@/lib/browser/action-badge")>("lib/browser/action-badge.ts");

    await flashSaveBadge(7, "saved", 5);

    expect(calls).toEqual([
      ["setBadgeBackgroundColor", { tabId: 7, color: "#16a34a" }],
      ["setBadgeText", { tabId: 7, text: "✓" }],
    ]);

    await outlast(30);

    expect(calls.slice(2)).toEqual([["setBadgeText", { tabId: 7, text: "" }]]);
  });

  test("stops quietly when the action API fails, without scheduling a reset", async () => {
    const calls = stubChrome(true);
    const { flashSaveBadge } = await importFresh<typeof import("@/lib/browser/action-badge")>("lib/browser/action-badge.ts");

    await expect(flashSaveBadge(7, "saved", 5)).resolves.toBeUndefined();
    await outlast(30);

    expect(calls).toEqual([["setBadgeBackgroundColor", { tabId: 7, color: "#16a34a" }]]);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun test test/context-menu-save.test.ts test/action-badge.test.ts`
Expected: FAIL — both modules are missing.

- [x] **Step 3: Implement the modules**

`lib/context-menu-save.ts`:

```ts
import { findVisibleDuplicates, type BookmarkLibrary } from "@/lib/duplicate-lookup";

export interface ContextMenuLibrary extends BookmarkLibrary {
  activeWorkspaceId: string;
}

export type ContextMenuSaveOutcome = "save" | "duplicate";

/**
 * Context-menu saves have no UI to ask, so the same address (strict tier) in
 * the active workspace is skipped. A failed lookup never blocks the save.
 */
export async function resolveContextMenuSave(
  url: string,
  loadLibrary: () => Promise<ContextMenuLibrary>,
): Promise<ContextMenuSaveOutcome> {
  try {
    const library = await loadLibrary();
    const duplicates = findVisibleDuplicates(url, library, "strict", { workspaceId: library.activeWorkspaceId });
    return duplicates.length > 0 ? "duplicate" : "save";
  } catch (err) {
    console.warn("[TabSlate] duplicate check failed; saving anyway:", err);
    return "save";
  }
}
```

`lib/browser/action-badge.ts`:

```ts
export type SaveBadgeKind = "saved" | "duplicate";

const BADGE_DURATION_MS = 3000;
const SAVED_COLOR = "#16a34a";
const DUPLICATE_COLOR = "#d97706";

/**
 * Briefly marks the toolbar icon of one tab after a context-menu save. Badges
 * fit about four characters, so a duplicate shows a short word plus a full
 * tooltip. Best effort: failures are ignored.
 */
export async function flashSaveBadge(
  tabId: number,
  kind: SaveBadgeKind,
  durationMs = BADGE_DURATION_MS,
): Promise<void> {
  let defaultTitle = "";
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: kind === "saved" ? SAVED_COLOR : DUPLICATE_COLOR });
    await chrome.action.setBadgeText({
      tabId,
      text: kind === "saved" ? "✓" : chrome.i18n.getMessage("badge_alreadySavedShort"),
    });
    if (kind === "duplicate") {
      defaultTitle = await chrome.action.getTitle({});
      await chrome.action.setTitle({ tabId, title: chrome.i18n.getMessage("badge_alreadySavedTitle") });
    }
  } catch {
    return;
  }

  setTimeout(() => {
    void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    if (kind === "duplicate") {
      void chrome.action.setTitle({ tabId, title: defaultTitle }).catch(() => {});
    }
  }, durationMs);
}
```

- [x] **Step 4: Wire `entrypoints/background.ts`**

- Change `import { idbPut } from "@/lib/idb";` to `import { idbGetAll, idbPut } from "@/lib/idb";`, add the imports below after the existing ones, and add the function at module scope, just above `export default defineBackground(() => {`:

```ts
import { getWorkspaceState } from "@/lib/storage";
import { resolveContextMenuSave, type ContextMenuLibrary } from "@/lib/context-menu-save";
import { flashSaveBadge } from "@/lib/browser/action-badge";
import type { Bookmark } from "@/lib/types";

async function loadContextMenuLibrary(): Promise<ContextMenuLibrary> {
  const [bookmarks, state] = await Promise.all([idbGetAll<Bookmark>("bookmarks"), getWorkspaceState()]);
  return {
    bookmarks,
    collections: state.collections,
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
  };
}
```

- In the `chrome.contextMenus.onClicked` listener, right after the `bookmarkData` object, add:

```ts
    if (await resolveContextMenuSave(bookmarkData.url, loadContextMenuLibrary) === "duplicate") {
      await flashSaveBadge(tab.id, "duplicate");
      return;
    }
```

- In the newtab path, replace:

```ts
        await chrome.tabs.sendMessage(newtabTab.id, { type: "ADD_BOOKMARK", data: bookmarkData });
        return;
```

with:

```ts
        await chrome.tabs.sendMessage(newtabTab.id, { type: "ADD_BOOKMARK", data: bookmarkData });
        await flashSaveBadge(tab.id, "saved");
        return;
```

- After `chrome.runtime.sendMessage({ type: "BOOKMARKS_CHANGED" } as ExtensionMessage).catch(() => {});` add `await flashSaveBadge(tab.id, "saved");`.

- [x] **Step 5: Add the strings**

`en`:

```json
  "badge_alreadySavedShort": { "message": "Dup" },
  "badge_alreadySavedTitle": { "message": "Already saved in TabSlate" },
```

`zh_CN`:

```json
  "badge_alreadySavedShort": { "message": "已存" },
  "badge_alreadySavedTitle": { "message": "已保存在 TabSlate 中" },
```

- [x] **Step 6: Run the tests**

Run: `bun test test/context-menu-save.test.ts test/action-badge.test.ts && bun test && bun run compile`
Expected: 7 pass; suite 0 failures; compile exits 0.

- [x] **Step 7: Commit**

```bash
git add lib/context-menu-save.ts lib/browser/action-badge.ts entrypoints/background.ts public/_locales test/context-menu-save.test.ts test/action-badge.test.ts
git commit -m "feat(background): skip duplicate context-menu saves and show a badge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Save shortcut

**Files:**
- Create: `lib/browser/commands.ts`
- Modify: `wxt.config.ts`
- Modify: `entrypoints/popup/App.tsx`
- Modify: both `messages.json`
- Tests: `test/wxt-config.test.ts`, `test/browser-commands.test.ts`

**Interfaces:**
- Produces: `findSaveShortcut(commands: readonly chrome.commands.Command[]): string`; manifest command `_execute_action`.

- [x] **Step 1: Write the failing tests**

Add to `test/wxt-config.test.ts` inside `describe("wxt cross-browser manifest", ...)`:

```ts
  test("suggests a shortcut that opens the save popup", async () => {
    const chromium = await getManifest("chrome", 3);
    const firefox = await getManifest("firefox", 3);

    expect(chromium.commands?._execute_action?.suggested_key).toEqual({
      default: "Ctrl+Shift+S",
      mac: "Command+Shift+S",
    });
    // Firefox reserves Ctrl+Shift+S for its screenshot tool.
    expect(firefox.commands?._execute_action?.suggested_key).toEqual({ default: "Alt+Shift+S" });
  });
```

`test/browser-commands.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";

const { findSaveShortcut } = await importFresh<typeof import("@/lib/browser/commands")>("lib/browser/commands.ts");

describe("findSaveShortcut", () => {
  test("returns the keys bound to the popup", () => {
    expect(findSaveShortcut([
      { name: "open-search", shortcut: "Ctrl+Shift+K" },
      { name: "_execute_action", shortcut: "Ctrl+Shift+S" },
    ])).toBe("Ctrl+Shift+S");
  });
  test("returns an empty string when the user removed the binding", () => {
    expect(findSaveShortcut([{ name: "_execute_action", shortcut: "" }])).toBe("");
  });
  test("returns an empty string when the command is missing", () => {
    expect(findSaveShortcut([])).toBe("");
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun test test/wxt-config.test.ts test/browser-commands.test.ts`
Expected: FAIL — the manifest has no `_execute_action`; `lib/browser/commands.ts` is missing.

- [x] **Step 3: Implement**

`lib/browser/commands.ts`:

```ts
/** The keys bound to opening the popup, or "" when none are set. */
export function findSaveShortcut(commands: readonly chrome.commands.Command[]): string {
  return commands.find((command) => command.name === "_execute_action")?.shortcut ?? "";
}
```

In `wxt.config.ts`, add before `"open-search"` inside `commands`:

```ts
      _execute_action: {
        // Firefox reserves Ctrl+Shift+S for its screenshot tool.
        suggested_key: browser === "firefox"
          ? { default: "Alt+Shift+S" }
          : { default: "Ctrl+Shift+S", mac: "Command+Shift+S" },
      },
```

In `entrypoints/popup/App.tsx`, add `import { findSaveShortcut } from "@/lib/browser/commands";`, then:

```tsx
  const [saveShortcut, setSaveShortcut] = useState("");

  useEffect(() => {
    chrome.commands.getAll((commands) => setSaveShortcut(findSaveShortcut(commands)));
  }, []);
```

and below the existing footer `<p>` (the one that shows `popup_pressEnter`), add:

```tsx
          <p className="text-[11px] text-center text-muted-foreground">
            {saveShortcut ? t("popup_saveShortcutHint", [saveShortcut]) : t("popup_saveShortcutUnset")}
          </p>
```

- [x] **Step 4: Add the strings**

`en`:

```json
  "popup_saveShortcutHint": { "message": "Open this popup with $1", "placeholders": { "1": { "content": "$1" } } },
  "popup_saveShortcutUnset": { "message": "Set a shortcut for this popup in your browser's extension shortcut settings" },
```

`zh_CN`:

```json
  "popup_saveShortcutHint": { "message": "按 $1 可快速打开此窗口", "placeholders": { "1": { "content": "$1" } } },
  "popup_saveShortcutUnset": { "message": "可以在浏览器的扩展快捷键设置里为此窗口设置快捷键" },
```

- [x] **Step 5: Run the tests**

Run: `bun test test/wxt-config.test.ts test/browser-commands.test.ts && bun run compile`
Expected: all pass; compile exits 0.

- [x] **Step 6: Commit**

```bash
git add lib/browser/commands.ts wxt.config.ts entrypoints/popup/App.tsx public/_locales test/wxt-config.test.ts test/browser-commands.test.ts
git commit -m "feat(popup): add a keyboard shortcut for saving the current page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Documentation and full verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `ARCHITECTURE.md`

- [x] **Step 1: Update `CLAUDE.md`**

- In the IndexedDB `kv` row, after `` `searchEngines`、`` insert:
  `` `bookmark-view-prefs`（书签视图模式与排序的本机副本 `{ viewMode, sortBy, updatedAt, dirty }`，见 `lib/view-preferences.ts`）、``
- In the Firefox data-collection bullet, replace `因此不声明 \`technicalAndInteraction\`。` with:
  `` `technicalAndInteraction` 只用于视图偏好同步（`FIREFOX_SETTINGS_DATA_COLLECTION`），由设置里的开关单独请求/撤销（`requestSettingsSyncConsent()`/`removeSettingsSyncConsent()`）；偏好的拉取与推送还需要 `hasSettingsSyncConsent()`，拒绝只影响偏好同步，不影响登录与同步。``
- Replace the sentence `BookmarksContent` 在 `activeWorkspaceId` 变更时重置 `selectedCollection → "all"` (in the Workspace 切换 bullet) with:
  `` `BookmarksContent` 通过 `useWorkspaceCollectionReset` 在所选集合不属于当前工作区时重置为 `"all"`（与工作区切换同时设置的集合，如 `revealBookmark`，会被保留）``
- Add these bullets to 注意事项:

```markdown
- **视图偏好同步**（`lib/view-preferences.ts`、`store/settings-store.ts`）：`viewMode`/`sortBy` 仍在 `useBookmarksStore`；`useSettingsStore.hydrate()` 在仪表盘渲染前载入本机副本，并订阅这两个字段写回本机（`dirty=true`）、1 秒防抖推送。服务端存于 `/preferences` 的 `bookmarkView` 键（读取-合并-写回，保留其他键），按 `updatedAt` 较新者胜出。`App.tsx` 的同步 effect 调 `startPreferenceSync(getCredentials)`，cleanup 调 `stopPreferenceSync()`。未知取值回退默认值。
- **重复检测两级规则**（`lib/url-match.ts`、`lib/duplicate-lookup.ts`）：严格规则（协议与域名小写、去默认端口与末尾斜杠，路径/参数/片段区分大小写）用于拦截：拖拽、批量保存标签页、右键菜单保存；宽松规则（另忽略 http/https、`www.`、`#` 片段、跟踪参数）只用于提示：添加书签对话框与 popup，可“仍然保存”。只匹配活跃书签，且其集合与工作区都可见。`normalizeUrl` 即严格规则。
- **定位书签与深链**：`revealBookmark(id)`（`lib/reveal-bookmark.ts`）切到书签所在工作区与集合、清空标签/筛选/搜索并高亮；新标签页支持 `#/?highlight=<id>`（`useHighlightDeepLink`），处理后移除参数。
- **右键菜单**：`components/ui/context-menu.tsx`；集合与书签卡片的菜单项各定义一次（`components/dashboard/shared/*-menu-items.tsx`），通过 `menu-primitives.tsx` 同时用于 ⋯ 下拉和右键菜单；标签只用右键菜单（重命名、改色、删除前确认）。
```

- [x] **Step 2: Update `ARCHITECTURE.md`**

- Replace the persistence diagram lines

```
useSettingsStore   ──手动 idbPut/Get──▶  IndexedDB  kv["searchEngines"]
                   ──StoreGate 镜像──▶  chrome.storage.local  "tabslate-search-engines"（供 content script 读取）
```

with:

```
useSettingsStore   ──手动 idbPut/Get──▶  IndexedDB  kv["bookmark-view-prefs"]（视图模式与排序，跨设备经 /preferences 同步）
```

- Replace the `useSettingsStore` row of the store table with:

```markdown
| `useSettingsStore` | IndexedDB (kv) + `/preferences` | 书签视图偏好同步：`hydrate` 载入本机副本并订阅 `useBookmarksStore` 的 `viewMode`/`sortBy`；`startPreferenceSync(getCredentials)`/`resyncPreferences()`/`stopPreferenceSync()` 按 `updatedAt` 与服务端 `bookmarkView` 键协调（Firefox 另需 `technicalAndInteraction` 同意） |
```

- In the routes table, replace the `/` row with:

```markdown
| `/` | `BookmarksContent` | 书签主界面（grid/list）；顶部搜索栏（书签 + open tabs + Google 回退）；支持 `?highlight=<bookmarkId>` 深链（`useHighlightDeepLink`） |
```

- In the directory tree, replace the `settings-store.ts` line under `store/` with:

```
│   ├── settings-store.ts   # 书签视图偏好（viewMode/sortBy）：本机 kv["bookmark-view-prefs"] + 经 /preferences 跨设备同步
```

- Under `components/ui/`, insert after the `color-picker.tsx` line:

```
│   │   ├── context-menu.tsx    # 标准 shadcn ContextMenu（标签、集合行、书签卡片的右键菜单）
```

- Under `components/dashboard/sidebar/`, replace the three lines `collection-dialog.tsx`, `tag-dialog.tsx`, `group-dialog.tsx` with:

```
│       │   ├── section-header.tsx    # 可折叠分区标题
│       │   ├── collection-row.tsx    # 集合行：⋯ 与右键菜单、编辑对话框
│       │   ├── tags-section.tsx      # 标签分区：计数、搜索、右键菜单（重命名/改色/删除）
│       │   ├── collection-dialog.tsx
│       │   ├── tag-dialog.tsx        # 新建/编辑标签（名称不可为空、不可重名）
│       │   ├── tag-delete-dialog.tsx # 删除标签确认（显示受影响书签数）
│       │   └── group-dialog.tsx
```

- Under `components/dashboard/`, insert before the `tabs-dnd-provider.tsx` line:

```
│       ├── shared/             # 跨视图复用组件：书签/标签对话框、菜单项（menu-primitives + collection/bookmark-menu-items，⋯ 与右键共用）、duplicate-notice
```

- Under `lib/`, insert after the `bookmark-utils.ts` line:

```
│   ├── url-match.ts        # 重复检测 URL 规则：strictUrlKey()（拦截）/ looseUrlKey()（提示）/ findUrlMatches()
│   ├── duplicate-lookup.ts # findVisibleDuplicates()：只匹配可见书签，附带集合/工作区位置
│   ├── view-preferences.ts # 书签视图偏好：类型、校验、本机 kv 与 /preferences 读写、updatedAt 先后判定
│   ├── reveal-bookmark.ts  # revealBookmark(id)：切换到书签所在工作区/集合、清空筛选并高亮
│   ├── context-menu-save.ts # 右键菜单保存的重复判定（严格规则，当前工作区）
│   ├── browser/            # 浏览器差异封装：data-collection（Firefox 同意）、action-badge（保存角标）、commands（保存快捷键）等
```

- Under `hooks/`, insert before the `use-mobile.ts` line:

```
│   ├── use-preference-sync-consent.ts   # Firefox 视图偏好同步开关的授权状态
│   ├── use-workspace-collection-reset.ts # 所选集合不在当前工作区时回退到 "all"
│   ├── use-highlight-deep-link.ts       # 处理 #/?highlight=<id> 深链
```

- [x] **Step 3: Check translation parity**

Run:

```bash
python3 -c "import json;a=json.load(open('public/_locales/en/messages.json'));b=json.load(open('public/_locales/zh_CN/messages.json'));print('missing in zh_CN:',sorted(set(a)-set(b)));print('missing in en:',sorted(set(b)-set(a)))"
```

Expected: both lists are empty.

- [x] **Step 4: Run the full verification**

Run: `bun test && bun run compile && bun run build && bun run build:firefox`
Expected: 0 test failures; compile exits 0; both builds finish.

- [ ] **Step 5: Manual check**

Load `.output/chrome-mv3` and `.output/firefox-mv3` unpacked and confirm:
1. Ctrl/Cmd+Shift+S (Chrome) and Alt+Shift+S (Firefox) open the popup; the popup footer names the shortcut.
2. On a saved page the popup shows "Already saved in …" and "Save anyway"; "Open existing bookmark" opens TabSlate and flashes the bookmark.
3. Context-menu "Save to TabSlate" on a saved page shows the amber badge and saves nothing; on a new page it shows the green ✓.
4. Right-click works on tags (rename, color, delete with confirmation), collection rows, and bookmark cards; tag counts and tag search behave as specified.
5. View mode and sort survive a new tab, and follow the user to a second signed-in browser profile (on Firefox only after enabling "Sync view preferences across devices").

- [x] **Step 6: Commit**

```bash
git add CLAUDE.md ARCHITECTURE.md
git commit -m "docs: document library management basics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


## Execution status — 2026-10-15

- Tasks 1 and 1b, and Tasks 2–17: implemented, committed, and reviewed. Task 1b includes fresh IndexedDB module isolation and the header test’s shared setup.
- Task 18 documentation and automated verification: complete. Final verification after integration fixes: 334 tests passed; TypeScript, Chrome build, Firefox build, translation parity, and popup/background runtime import-boundary checks passed.
- Final whole-branch review findings were fixed in `7ef311d`; the scoped re-review approved all five integration fixes and two cleanups with no new actionable findings.
- Task 18 Step 5 remains pending: native shortcut activation, live popup/badge/menu behavior, Firefox consent prompt, and synchronization between signed-in browser profiles. Available UI surfaces expose only the Codex in-app browser and MCP Apps, with no Chrome/Firefox/native control; no manual pass is claimed.
- Accepted limits: the server’s read/replace preference API has no compare-and-swap, so simultaneous writes from different devices can still race. Existing Favorites Edit/Add tags callbacks and existing tag-deletion cleanup semantics remain outside this plan’s changes. Both builds retain the reported ineffective dynamic-import chunking warning.
