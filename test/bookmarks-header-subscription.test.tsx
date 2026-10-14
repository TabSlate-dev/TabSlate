// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, Profiler } from "react";

const FRESH = "?bookmarks-header-subscription";
const previousExports = new Map<string, object>();
let createRoot: typeof import("react-dom/client").createRoot;
let useBookmarksStore: typeof import("../store/bookmarks-store").useBookmarksStore;
let SidebarProvider: typeof import("../components/ui/sidebar").SidebarProvider;
let BookmarksHeader: typeof import("../components/dashboard/header").BookmarksHeader;

// Bun runs afterAll even when beforeAll fails part-way, so a broken setup
// cannot leave the DOM globals or module replacements behind for later files.
afterAll(async () => {
  for (const [specifier, exports] of previousExports) {
    mock.module(specifier, () => exports);
  }
  Reflect.deleteProperty(globalThis, "indexedDB");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

beforeAll(async () => {
  // react-dom/client checks for a DOM when it is first imported.
  GlobalRegistrator.register();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  // Store modules open IndexedDB while loading. A request that never settles
  // keeps persistence inert so the test only exercises rendering.
  Reflect.set(globalThis, "indexedDB", { open: () => ({}) });

  // Other test files replace these modules with partial fakes, and Bun keeps
  // module mocks for the rest of the run, patching already-loaded modules in
  // place. Point them at fresh real copies (a query string bypasses a mock)
  // and remember the previous exports so afterAll can put them back. Bun
  // ignores a module namespace returned from a mock factory, so replacements
  // are handed over as plain object copies.
  const replaceModule = async (specifier: string, replacement: object) => {
    previousExports.set(specifier, { ...(await import(specifier)) });
    mock.module(specifier, () => ({ ...replacement }));
  };
  const reactDomClient: typeof import("react-dom/client") = await import(`../node_modules/react-dom/client.js${FRESH}`);
  const bookmarksStore: typeof import("../store/bookmarks-store") = await import(`../store/bookmarks-store.ts${FRESH}`);
  await replaceModule("react-dom/client", reactDomClient);
  await replaceModule("@/hooks/use-translation", { useTranslation: () => ({ t: (key: string) => key }) });
  await replaceModule("@/store/bookmarks-store", bookmarksStore);
  await replaceModule("@/store/workspace-store", await import(`../store/workspace-store.ts${FRESH}`));
  await replaceModule("@/store/i18n-store", await import(`../store/i18n-store.ts${FRESH}`));

  createRoot = reactDomClient.createRoot;
  useBookmarksStore = bookmarksStore.useBookmarksStore;
  ({ SidebarProvider } = await import("../components/ui/sidebar"));
  ({ BookmarksHeader } = await import("../components/dashboard/header"));
});

function renderHeader() {
  let commits = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      createElement(
        SidebarProvider,
        null,
        createElement(
          Profiler,
          { id: "bookmarks-header", onRender: () => { commits += 1; } },
          createElement(BookmarksHeader),
        ),
      ),
    );
  });

  return {
    container,
    getCommits: () => commits,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("BookmarksHeader store subscription", () => {
  test("does not re-render when bookmark data changes", () => {
    const header = renderHeader();
    const commitsAfterMount = header.getCommits();

    act(() => {
      useBookmarksStore.setState({ bookmarks: new Map() });
    });

    expect(header.getCommits()).toBe(commitsAfterMount);
    header.unmount();
  });

  test("highlights the list toggle after switching to list view", () => {
    act(() => {
      useBookmarksStore.getState().setViewMode("grid");
    });
    const header = renderHeader();

    act(() => {
      useBookmarksStore.getState().setViewMode("list");
    });

    const [gridButton, listButton] = Array.from(header.container.querySelectorAll(".border.rounded-md button"));
    expect(listButton.className).toContain("bg-muted");
    expect(gridButton.className).not.toContain("bg-muted");
    header.unmount();
  });
});
