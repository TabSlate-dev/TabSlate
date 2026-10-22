// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, openDropdown, render, setupDom, teardownDom, wait, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";
import type { Bookmark } from "@/lib/types";

const replacer = createModuleReplacer();
const openUrlsInBackground = mock(async (_urls: readonly string[]) => ({ tabIds: [1], failedCount: 0 }));
const openAsTabGroup = mock(async (_urls: string[], _title: string, _color: string) => ({ groupId: 7, failedCount: 0 }));
const copied: string[] = [];
let clipboardFails = false;
let tabGroupsSupported = true;
const storedTitles: object[] = [];
let useTabsStore: typeof import("@/store/tabs-store").useTabsStore;
let app: AppModules;
let BulkActionBar: typeof import("@/components/dashboard/bulk-actions").BulkActionBar;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let view: RenderResult | null = null;

const reading = [
  makeBookmark("a", { title: "Docs [beta]", url: "https://example.com/a b", collectionId: "reading" }),
  makeBookmark("c", { title: "C", url: "https://example.com/c", collectionId: "reading" }),
];
const project = makeBookmark("b", { title: "B", url: "https://example.com/b", collectionId: "projects" });

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  const realIdb = await import("@/lib/idb");
  await replacer.replace("@/lib/idb", { ...realIdb, idbPut: async (_store: string, value: object) => { storedTitles.push(value); } });
  const capabilities = await importFresh<typeof import("@/lib/browser/capabilities")>("lib/browser/capabilities.ts");
  await replacer.replace("@/lib/browser/capabilities", { ...capabilities, supportsTabGroups: () => tabGroupsSupported });
  const realTabs = await importFresh<typeof import("@/lib/chrome/tabs")>("lib/chrome/tabs.ts");
  await replacer.replace("@/lib/chrome/tabs", { ...realTabs, openUrlsInBackground, getCurrentWindowTabs: async () => [] });
  const realGroups = await importFresh<typeof import("@/lib/chrome/tab-groups")>("lib/chrome/tab-groups.ts");
  await replacer.replace("@/lib/chrome/tab-groups", { ...realGroups, openAsTabGroup, getCurrentWindowGroups: async () => [] });
  await replacer.replace("@/store/tabs-store", await importFresh<typeof import("@/store/tabs-store")>("store/tabs-store.ts"));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (clipboardFails) {
          throw new Error("Clipboard write denied");
        }
        copied.push(text);
      },
    },
  });
  ({ useTabsStore } = await import("@/store/tabs-store"));
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ SelectionOrdersProvider } = await import("@/components/dashboard/shared/selection-orders"));
  ({ BulkActionBar } = await importFresh<typeof import("@/components/dashboard/bulk-actions")>("components/dashboard/bulk-actions/index.tsx"));
});
afterAll(async () => {
  view?.unmount();
  Reflect.deleteProperty(navigator, "clipboard");
  replacer.restore();
  await teardownDom();
});

function renderBar(bookmarks: Bookmark[], viewOrder: readonly string[], selectedIds: readonly string[]): void {
  view?.unmount();
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks) });
  act(() => {
    useSelectionStore.getState().clear();
    useSelectionStore.getState().setMany(selectedIds, true);
  });
  view = render(app, createElement(MemoryRouter, null, createElement(SelectionOrdersProvider, {
    viewOrder,
    onScreenOrder: viewOrder,
    children: createElement(BulkActionBar),
  })));
}

beforeEach(() => {
  view?.unmount();
  view = null;
  openUrlsInBackground.mockClear();
  openAsTabGroup.mockClear();
  copied.length = 0;
  clipboardFails = false;
  tabGroupsSupported = true;
  storedTitles.length = 0;
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home", { name: "Home" })],
    collections: [
      makeCollection("reading", "home", { name: "Reading", isDefault: true }),
      makeCollection("projects", "home", { name: "Projects", position: 1 }),
    ],
    compactGroupTitles: false,
  });
});

async function chooseFromMenu(trigger: Element, item: string): Promise<void> {
  await act(async () => {
    openDropdown(trigger);
  });
  click(getByText(item));
  await wait(0);
}
const openMenu = () => getByText("bulkActions_open");
const moreMenu = () => getBySelector('[aria-label="bulkActions_more"]');

describe("opening a selection", () => {
  test("clearing selection discards a pending confirmation even if new selection is batched", async () => {
    const many = Array.from({ length: 11 }, (_, index) => makeBookmark(`m${index}`, { collectionId: "reading" }));
    const ids = many.map((bookmark) => bookmark.id);
    renderBar(many, ids, ids);
    await chooseFromMenu(openMenu(), "bulkActions_openAll");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => {
      useSelectionStore.getState().clear();
      useSelectionStore.getState().setMany(ids, true);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(openUrlsInBackground).not.toHaveBeenCalled();
    await chooseFromMenu(openMenu(), "bulkActions_openAll");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  test("actions read the current view order when the provider changes without rerendering the bar", async () => {
    renderBar(reading, ["a", "c"], ["a", "c"]);
    const bar = createElement(BulkActionBar);
    view?.rerender(createElement(MemoryRouter, null, createElement(SelectionOrdersProvider, {
      viewOrder: ["a", "c"], onScreenOrder: ["a", "c"], children: bar,
    })));
    view?.rerender(createElement(MemoryRouter, null, createElement(SelectionOrdersProvider, {
      viewOrder: ["c", "a"], onScreenOrder: ["c", "a"], children: bar,
    })));
    await chooseFromMenu(openMenu(), "bulkActions_openAll");
    await chooseFromMenu(moreMenu(), "bulkActions_copyLinks");
    expect(openUrlsInBackground.mock.calls[0]?.[0]).toEqual(["https://example.com/c", "https://example.com/a b"]);
    expect(copied).toEqual(["https://example.com/c\nhttps://example.com/a b"]);
  });

  test("ten tabs open immediately", async () => {
    const many = Array.from({ length: 10 }, (_, index) => makeBookmark(`m${index}`, { collectionId: "reading" }));
    const ids = many.map((bookmark) => bookmark.id);
    renderBar(many, ids, ids);
    await chooseFromMenu(openMenu(), "bulkActions_openAll");
    expect(openUrlsInBackground.mock.calls[0]?.[0]).toHaveLength(10);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("unsupported tab groups are absent from both menus", async () => {
    tabGroupsSupported = false;
    renderBar(reading, ["a"], ["a"]);
    await act(async () => { openDropdown(openMenu()); });
    expect(document.body.textContent).not.toContain("bulkActions_openAsGroup");
    click(getByText("bulkActions_openAll"));
    await act(async () => { openDropdown(moreMenu()); });
    expect(document.body.textContent).not.toContain("bulkActions_openAsGroup");
  });

  test("the shared opener honors compact settings, stores full titles and opens collections", async () => {
    renderBar(reading, ["a", "c"], ["a", "c"]);
    act(() => { app.useWorkspaceStore.setState({ compactGroupTitles: true }); });
    await chooseFromMenu(openMenu(), "bulkActions_openAsGroup");
    expect(openAsTabGroup.mock.calls[0]).toEqual([["https://example.com/a b", "https://example.com/c"], "R", "grey"]);
    expect(useTabsStore.getState().fullTitles[7]).toBe("Reading");
    expect(storedTitles).toContainEqual({ groupId: 7, title: "Reading" });
    await act(async () => { await useTabsStore.getState().openCollectionAsGroup("reading", "Collection", "blue", false); });
    expect(openAsTabGroup.mock.calls[1]).toEqual([["https://example.com/a b", "https://example.com/c"], "Collection", "blue"]);
    expect(useTabsStore.getState().fullTitles[7]).toBe("Collection");
  });

  test("Open all in new tabs opens the selection in view order as background tabs", async () => {
    renderBar([...reading, project], ["c", "b", "a"], ["a", "c"]);
    await chooseFromMenu(openMenu(), "bulkActions_openAll");
    expect(openUrlsInBackground.mock.calls[0]?.[0]).toEqual(["https://example.com/c", "https://example.com/a b"]);
  });

  test("more than 10 tabs ask first", async () => {
    const many = Array.from({ length: 11 }, (_, index) => makeBookmark(`m${index}`, { collectionId: "reading" }));
    const ids = many.map((bookmark) => bookmark.id);
    renderBar(many, ids, ids);

    await chooseFromMenu(openMenu(), "bulkActions_openAll");
    expect(getBySelector('[role="dialog"]').textContent).toContain("bulkActions_confirmOpenTitle[11]");
    expect(openUrlsInBackground).not.toHaveBeenCalled();

    click(getByText("bulkActions_confirmOpen"));
    await wait(0);
    expect(openUrlsInBackground.mock.calls[0]?.[0]).toHaveLength(11);
  });

  test("a tab group takes the shared collection's name, otherwise the workspace's", async () => {
    renderBar([...reading, project], ["a", "c", "b"], ["a", "c"]);
    await chooseFromMenu(openMenu(), "bulkActions_openAsGroup");
    expect(openAsTabGroup.mock.calls[0]).toEqual([["https://example.com/a b", "https://example.com/c"], "Reading", "grey"]);

    renderBar([...reading, project], ["a", "c", "b"], ["a", "b"]);
    await chooseFromMenu(openMenu(), "bulkActions_openAsGroup");
    expect(openAsTabGroup.mock.calls[1]?.[1]).toBe("Home");
  });

  test("a failure to open a group shows a notice", async () => {
    openAsTabGroup.mockImplementationOnce(async () => { throw new Error("Groups are blocked"); });
    renderBar(reading, ["a"], ["a"]);
    await chooseFromMenu(openMenu(), "bulkActions_openAsGroup");
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_openFailed");
  });

  test("a failure to open tabs shows a notice", async () => {
    openUrlsInBackground.mockImplementationOnce(async () => {
      throw new Error("Tabs are blocked");
    });
    renderBar(reading, ["a", "c"], ["a"]);
    await chooseFromMenu(openMenu(), "bulkActions_openAll");
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_openFailed");
  });

  test("tabs the browser refuses are counted in a notice once the rest open", async () => {
    openUrlsInBackground.mockImplementationOnce(async () => ({ tabIds: [1], failedCount: 1 }));
    renderBar(reading, ["a", "c"], ["a", "c"]);
    await chooseFromMenu(openMenu(), "bulkActions_openAll");
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_openSomeFailed[1]");
  });

  test("a group of the tabs that opened is kept, and the notice counts the refused ones", async () => {
    openAsTabGroup.mockImplementationOnce(async () => ({ groupId: 7, failedCount: 1 }));
    renderBar(reading, ["a", "c"], ["a", "c"]);
    await chooseFromMenu(openMenu(), "bulkActions_openAsGroup");
    expect(storedTitles).toEqual([{ groupId: 7, title: "Reading" }]);
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_openSomeFailed[1]");
  });
});

describe("copying a selection", () => {
  test("Copy links writes one URL per line in view order and says how many", async () => {
    renderBar(reading, ["c", "a"], ["a", "c"]);
    await chooseFromMenu(moreMenu(), "bulkActions_copyLinks");
    expect(copied).toEqual(["https://example.com/c\nhttps://example.com/a b"]);
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_copiedOther[2]");
  });

  test("Copy as Markdown list escapes titles and URLs", async () => {
    renderBar(reading, ["a"], ["a"]);
    await chooseFromMenu(moreMenu(), "bulkActions_copyMarkdown");
    expect(copied).toEqual(["- [Docs \\[beta\\]](https://example.com/a%20b)"]);
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_copiedOne");
  });

  test("a clipboard failure shows a notice", async () => {
    clipboardFails = true;
    renderBar(reading, ["a"], ["a"]);
    await chooseFromMenu(moreMenu(), "bulkActions_copyLinks");
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_copyFailed");
  });
});
