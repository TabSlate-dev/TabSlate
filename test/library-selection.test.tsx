// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { installMeasuredVirtualizer, installQuietTabsStore } from "./helpers/virtualizer";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let BookmarksContent: typeof import("@/components/dashboard/content").BookmarksContent;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let view: RenderResult | null = null;

const bookmarks = [
  makeBookmark("r1", { title: "R1", collectionId: "reading" }),
  makeBookmark("r2", { title: "R2", collectionId: "reading" }),
  makeBookmark("p1", { title: "P1", collectionId: "projects" }),
  makeBookmark("p2", { title: "P2", collectionId: "projects" }),
  makeBookmark("u1", { title: "U1", collectionId: "" }),
];

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  await installMeasuredVirtualizer(replacer);
  await installQuietTabsStore(replacer);
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ BookmarksContent } = await importFresh<typeof import("@/components/dashboard/content")>("components/dashboard/content.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [
      makeCollection("reading", "home", { isDefault: true, position: 0 }),
      makeCollection("projects", "home", { position: 1 }),
    ],
    tags: [],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedCollection: "all",
    selectedTags: [],
    filterType: "all",
    searchQuery: "",
    sortBy: "alpha-az",
    viewMode: "grid",
    highlightedBookmarkId: null,
  });
  act(() => {
    useSelectionStore.getState().clear();
  });
  view = render(app, createElement(MemoryRouter, null, createElement(BookmarksContent)));
});

const headerCheckbox = (name: string) => getBySelector(`[aria-label="bookmarksContent_selectCollection[${name}]"]`);
const selected = () => [...useSelectionStore.getState().selectedIds].sort();

describe("selecting collection groups", () => {
  test("a header checkbox selects its whole group, even collapsed, and clears it again", () => {
    expect(document.querySelector('[data-bookmark-id="p1"]')).toBeNull();

    click(headerCheckbox("projects"));

    expect(selected()).toEqual(["p1", "p2"]);
    expect(headerCheckbox("projects").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[data-bookmark-id="p1"]')).toBeNull();

    click(headerCheckbox("projects"));
    expect(selected()).toEqual([]);
  });

  test("a header shows a mixed checkbox when part of its group is selected", () => {
    click(getBySelector('[data-bookmark-id="r1"] [role="checkbox"]'));
    expect(headerCheckbox("reading").getAttribute("aria-checked")).toBe("mixed");
    expect(headerCheckbox("projects").getAttribute("aria-checked")).toBe("false");
  });

  test("Shift+click ranges skip the bookmarks of collapsed groups", () => {
    click(getByText("bookmarksContent_uncategorized"));
    click(getBySelector('[data-bookmark-id="r1"] [role="checkbox"]'));
    click(getBySelector('[data-bookmark-id="u1"]'), { shiftKey: true });
    expect(selected()).toEqual(["r1", "r2", "u1"]);
  });

  test("choosing another collection clears the selection", () => {
    click(headerCheckbox("projects"));
    act(() => {
      app.useBookmarksStore.getState().setSelectedCollection("projects");
    });
    expect(selected()).toEqual([]);
  });

  test("leaving the page clears the selection", () => {
    click(headerCheckbox("projects"));
    view?.unmount();
    view = null;
    expect(selected()).toEqual([]);
  });

  test("collapsing a group retains its selected bookmarks in the full view", () => {
    click(getBySelector('[data-bookmark-id="r1"] [role="checkbox"]'));
    click(getByText("reading"));
    expect(document.querySelector('[data-bookmark-id="r1"]')).toBeNull();
    expect(selected()).toEqual(["r1"]);
    expect(headerCheckbox("reading").getAttribute("aria-checked")).toBe("mixed");
    click(headerCheckbox("reading"));
    expect(selected()).toEqual(["r1", "r2"]);
  });

  test("a collection checkbox selects only the bookmarks matching the current filter", () => {
    act(() => { app.useBookmarksStore.setState({ searchQuery: "R1" }); });
    click(headerCheckbox("reading"));
    expect(selected()).toEqual(["r1"]);
    expect(headerCheckbox("reading").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[aria-label="bookmarksContent_selectCollection[projects]"]')).toBeNull();
  });

});
