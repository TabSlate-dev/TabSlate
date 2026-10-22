// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeTag, makeWorkspace } from "./helpers/library-fixtures";
import { buildTagTree } from "@/lib/tag-tree";
import { countTagUsage } from "@/lib/tag-counts";

import { installMeasuredVirtualizer, installQuietTabsStore } from "./helpers/virtualizer";

const replacer = createModuleReplacer();
let app: AppModules;
let FavoritesContent: typeof import("@/components/dashboard/favorites-content").FavoritesContent;
let BookmarksContent: typeof import("@/components/dashboard/content").BookmarksContent;
let revealBookmark: typeof import("@/lib/reveal-bookmark").revealBookmark;
let view: RenderResult | null = null;
const scrollOffsets: number[] = [];

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  await installMeasuredVirtualizer(replacer, scrollOffsets);
  await installQuietTabsStore(replacer);
  ({ FavoritesContent } = await importFresh<typeof import("@/components/dashboard/favorites-content")>("components/dashboard/favorites-content.tsx"));
  ({ BookmarksContent } = await importFresh<typeof import("@/components/dashboard/content")>("components/dashboard/content.tsx"));
  ({ revealBookmark } = await importFresh<typeof import("@/lib/reveal-bookmark")>("lib/reveal-bookmark.ts"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  view = null;
  scrollOffsets.length = 0;
  app.useWorkspaceStore.setState({ activeWorkspaceId: "home", workspaces: [makeWorkspace("home")], collections: [makeCollection("reading", "home")], tags: [makeTag("frontend", "Frontend"), makeTag("other", "Other")] });
  app.useBookmarksStore.setState({ selectedCollection: "all", selectedTags: [], filterType: "all", searchQuery: "", viewMode: "grid", sortBy: "date-newest", highlightedBookmarkId: null });
});

test("Favorites card tags visibly filter favorites and toggling off restores them", () => {
  const bookmarks = [
    makeBookmark("tagged", { collectionId: "reading", isFavorite: true, tags: ["frontend"] }),
    makeBookmark("other", { collectionId: "reading", isFavorite: true, tags: ["other"] }),
    makeBookmark("not-favorite", { collectionId: "reading", tags: ["frontend"] }),
  ];
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks) });
  view = render(app, createElement(FavoritesContent));
  expect(document.querySelectorAll("[data-bookmark-id]").length).toBe(2);
  click(getBySelector('[data-tag-id="frontend"]'));
  expect(document.querySelector('[data-bookmark-id="tagged"]')).not.toBeNull();
  expect(document.querySelector('[data-bookmark-id="other"]') === null).toBe(true);
  expect(document.querySelector('[data-bookmark-id="not-favorite"]')).toBeNull();
  click(getBySelector('[data-tag-id="frontend"]'));
  expect(document.querySelectorAll("[data-bookmark-id]").length).toBe(2);
});

test("Favorites shows a tag filter carried over from the library and says when it hides every favorite", () => {
  const bookmarks = [makeBookmark("favorite", { collectionId: "reading", isFavorite: true, tags: ["other"] })];
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), selectedTags: ["frontend"] });
  view = render(app, createElement(FavoritesContent));
  expect(document.querySelector('[data-bookmark-id="favorite"]')).toBeNull();
  expect(getBySelector('[aria-label="activeFilterChips_removeTag[Frontend]"]')).toBeTruthy();
  expect(document.body.textContent).toContain("favoritesContent_count_other[0]");
  expect(document.body.textContent).toContain("favoritesContent_filtered");
  expect(document.body.textContent).toContain("favoritesContent_noMatchTitle");
  expect(document.body.textContent).not.toContain("favoritesContent_emptyTitle");

  click(getByText("favoritesContent_clearTagFilter"));

  expect(app.useBookmarksStore.getState().selectedTags).toEqual([]);
  expect(document.querySelector('[data-bookmark-id="favorite"]')).not.toBeNull();
  expect(document.body.textContent).toContain("favoritesContent_count_one[1]");
  expect(document.body.textContent).not.toContain("favoritesContent_filtered");
  expect(document.querySelector('[aria-label="activeFilterChips_removeTag[Frontend]"]')).toBeNull();
});

test("Favorites tag chips remove one tag at a time or clear them all", () => {
  const bookmarks = [
    makeBookmark("tagged", { collectionId: "reading", isFavorite: true, tags: ["frontend"] }),
    makeBookmark("other", { collectionId: "reading", isFavorite: true, tags: ["other"] }),
  ];
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), selectedTags: ["frontend", "other"] });
  view = render(app, createElement(FavoritesContent));
  expect(document.querySelectorAll("[data-bookmark-id]").length).toBe(2);

  click(getBySelector('[aria-label="activeFilterChips_removeTag[Other]"]'));
  expect(app.useBookmarksStore.getState().selectedTags).toEqual(["frontend"]);
  expect(document.querySelector('[data-bookmark-id="other"]')).toBeNull();

  click(getByText("activeFilterChips_clearAll"));
  expect(app.useBookmarksStore.getState().selectedTags).toEqual([]);
  expect(document.querySelectorAll("[data-bookmark-id]").length).toBe(2);
});

test("the library shows the same chips plus its type filter, and clearing resets both", () => {
  const bookmarks = [makeBookmark("article", { collectionId: "reading", tags: ["frontend"] })];
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks), selectedTags: ["frontend"], filterType: "with-tags" });
  view = render(app, createElement(MemoryRouter, null, createElement(BookmarksContent)));
  expect(getByText("bookmarksContent_withTags")).toBeTruthy();
  expect(getBySelector('[aria-label="activeFilterChips_removeTag[Frontend]"]')).toBeTruthy();

  click(getByText("activeFilterChips_clearAll"));

  expect(app.useBookmarksStore.getState().selectedTags).toEqual([]);
  expect(app.useBookmarksStore.getState().filterType).toBe("all");
  expect(document.querySelector('[aria-label="activeFilterChips_removeTag[Frontend]"]')).toBeNull();
});

test("a saved sort keeps the new-tab hero and does not mark the list as filtered", () => {
  const bookmarks = [makeBookmark("article", { collectionId: "reading" })];
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks), sortBy: "alpha-az" });
  view = render(app, createElement(MemoryRouter, null, createElement(BookmarksContent)));
  expect(document.querySelector('input[placeholder="search_placeholderGlobal"]')).not.toBeNull();
  expect(document.body.textContent).toContain("bookmarksContent_bookmarkCount_one[1]");
  expect(document.body.textContent).not.toContain("bookmarksContent_filtered");
});

test("reveal expands a collapsed Uncategorized group before rendering and scrolling to its highlighted card", () => {
  const bookmarks = [makeBookmark("uncategorized", { collectionId: "" })];
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks) });
  view = render(app, createElement(MemoryRouter, null, createElement(BookmarksContent)));
  expect(document.body.textContent).toContain("bookmarksContent_uncategorized");
  expect(document.querySelector('[data-bookmark-id="uncategorized"]')).toBeNull();
  scrollOffsets.length = 0;
  act(() => { expect(revealBookmark("uncategorized")).toBe(true); });
  const card = getBySelector('[data-bookmark-id="uncategorized"]');
  expect(card.className).toContain("ring-2");
  expect(scrollOffsets.length).toBeGreaterThan(0);
});

test("Favorites lists favorites in the current sort order", () => {
  const bookmarks = [
    makeBookmark("zeta", { title: "Zeta", collectionId: "reading", isFavorite: true }),
    makeBookmark("alpha", { title: "Alpha", collectionId: "reading", isFavorite: true }),
  ];
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), sortBy: "alpha-az" });
  view = render(app, createElement(FavoritesContent));
  const order = () => Array.from(document.querySelectorAll("[data-bookmark-id]")).map((card) => card.getAttribute("data-bookmark-id"));
  expect(order()).toEqual(["alpha", "zeta"]);
  act(() => { app.useBookmarksStore.getState().setSortBy("alpha-za"); });
  expect(order()).toEqual(["zeta", "alpha"]);
});

test("the large card view shows covers in the library and in Favorites", () => {
  const bookmarks = [
    makeBookmark("covered", { collectionId: "reading", isFavorite: true, imageUrl: "https://cdn.example.com/covered.png" }),
    makeBookmark("bare", { collectionId: "reading", isFavorite: true }),
  ];
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks), selectedCollection: "reading", viewMode: "gallery" });

  view = render(app, createElement(MemoryRouter, null, createElement(BookmarksContent)));
  expect(getBySelector('[data-bookmark-id="covered"] [data-bookmark-cover] img').getAttribute("src")).toBe("https://cdn.example.com/covered.png");
  expect(getBySelector('[data-bookmark-id="bare"] [data-bookmark-cover] [data-cover-placeholder]')).toBeTruthy();

  view.unmount();
  view = render(app, createElement(FavoritesContent));
  expect(getBySelector('[data-bookmark-id="covered"] [data-bookmark-cover] img').getAttribute("src")).toBe("https://cdn.example.com/covered.png");
});

test("parent_filter_matches_child", () => {
  const pTag = { id: "p", name: "Parent", color: "blue", seq: 1 };
  const cTag = { id: "c", parentId: "p", name: "Child", color: "blue", seq: 1 };
  const tree = buildTagTree([pTag, cTag], "en");
  const childBookmark = makeBookmark("child-bookmark", { collectionId: "collection", tags: ["c"] });
  const parentAndChildBookmark = makeBookmark("parent-and-child", { collectionId: "collection", tags: ["p", "c"] });

  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap([childBookmark]),
    selectedTags: ["p"],
  });

  const ids = app.useBookmarksStore.getState().getFilteredBookmarks(new Set(["collection"]), new Set(["p", "c"]));
  expect(ids.map(bookmark => bookmark.id)).toEqual(["child-bookmark"]);
  expect(countTagUsage(tree, [childBookmark, parentAndChildBookmark]).get("p")).toBe(2);
});

test("Selecting a parent matches a child-only bookmark in library and Favorites", () => {
  const pTag = { id: "p", name: "Parent", color: "blue", seq: 1 };
  const cTag = { id: "c", parentId: "p", name: "Child", color: "blue", seq: 1 };
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
    tags: [pTag, cTag],
  });
  const bookmarks = [
    makeBookmark("child-bm", { collectionId: "reading", isFavorite: true, tags: ["c"] }),
    makeBookmark("other-bm", { collectionId: "reading", isFavorite: true, tags: ["other"] }),
  ];
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedTags: ["p"],
  });

  // Library view
  view = render(app, createElement(MemoryRouter, null, createElement(BookmarksContent)));
  expect(document.querySelector('[data-bookmark-id="child-bm"]')).not.toBeNull();
  expect(document.querySelector('[data-bookmark-id="other-bm"]')).toBeNull();

  view.unmount();

  // Favorites view
  view = render(app, createElement(FavoritesContent));
  expect(document.querySelector('[data-bookmark-id="child-bm"]')).not.toBeNull();
  expect(document.querySelector('[data-bookmark-id="other-bm"]')).toBeNull();
});

test("several selections use OR", () => {
  const tagA = { id: "a", name: "A", color: "blue", seq: 1 };
  const tagB = { id: "b", name: "B", color: "blue", seq: 1 };
  const tagC = { id: "c", name: "C", color: "blue", seq: 1 };
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
    tags: [tagA, tagB, tagC],
  });
  const bookmarks = [
    makeBookmark("bm-a", { collectionId: "reading", tags: ["a"] }),
    makeBookmark("bm-b", { collectionId: "reading", tags: ["b"] }),
    makeBookmark("bm-c", { collectionId: "reading", tags: ["c"] }),
  ];
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedTags: ["a", "b"],
  });

  view = render(app, createElement(MemoryRouter, null, createElement(BookmarksContent)));
  expect(document.querySelector('[data-bookmark-id="bm-a"]')).not.toBeNull();
  expect(document.querySelector('[data-bookmark-id="bm-b"]')).not.toBeNull();
  expect(document.querySelector('[data-bookmark-id="bm-c"]')).toBeNull();
});

test("Moving a tag updates results without changing selected IDs", () => {
  const pTag = { id: "p", name: "Parent", color: "blue", seq: 1 };
  const orphanTag = { id: "orphan", name: "Orphan", color: "blue", seq: 1 };
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
    tags: [pTag, orphanTag],
  });
  const bookmarks = [
    makeBookmark("orphan-bm", { collectionId: "reading", tags: ["orphan"] }),
  ];
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedTags: ["p"],
  });

  view = render(app, createElement(MemoryRouter, null, createElement(BookmarksContent)));
  expect(document.querySelector('[data-bookmark-id="orphan-bm"]')).toBeNull();

  act(() => {
    app.useWorkspaceStore.setState({
      tags: [pTag, { ...orphanTag, parentId: "p" }],
    });
  });

  expect(app.useBookmarksStore.getState().selectedTags).toEqual(["p"]);
  expect(document.querySelector('[data-bookmark-id="orphan-bm"]')).not.toBeNull();
});

test("workspace switching preserves parent tag descendant filtering in the new workspace", () => {
  const pTag = { id: "p", name: "Parent", color: "blue", seq: 1 };
  const cTag = { id: "c", parentId: "p", name: "Child", color: "blue", seq: 1 };
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home"), makeWorkspace("work")],
    collections: [
      makeCollection("col-home", "home", { isDefault: true }),
      makeCollection("col-work", "work", { isDefault: true }),
    ],
    tags: [pTag, cTag],
  });
  const bookmarks = [
    makeBookmark("bm-home", { collectionId: "col-home", tags: ["c"] }),
    makeBookmark("bm-work", { collectionId: "col-work", tags: ["c"] }),
  ];
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedTags: ["p"],
  });

  view = render(app, createElement(MemoryRouter, null, createElement(BookmarksContent)));
  expect(document.querySelector('[data-bookmark-id="bm-home"]')).not.toBeNull();
  expect(document.querySelector('[data-bookmark-id="bm-work"]')).toBeNull();

  // Switch to work workspace
  act(() => {
    app.useWorkspaceStore.setState({ activeWorkspaceId: "work" });
  });

  expect(document.querySelector('[data-bookmark-id="bm-home"]')).toBeNull();
  expect(document.querySelector('[data-bookmark-id="bm-work"]')).not.toBeNull();
});
