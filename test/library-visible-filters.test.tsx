// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeTag, makeWorkspace } from "./helpers/library-fixtures";

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
  const virtual = await import("@tanstack/react-virtual");
  const useRealVirtualizer = virtual.useVirtualizer;
  await replacer.replace("@tanstack/react-virtual", {
    ...virtual,
    useVirtualizer: (options: Parameters<typeof virtual.useVirtualizer>[0]) => useRealVirtualizer({
      ...options,
      initialRect: { width: 1200, height: 2000 },
      observeElementRect: (_instance, callback) => {
        callback({ width: 1200, height: 2000 });
        return () => {};
      },
      scrollToFn: (offset) => { scrollOffsets.push(offset); },
    }),
  });
  const tabs = await importFresh<typeof import("@/store/tabs-store")>("store/tabs-store.ts");
  tabs.useTabsStore.setState({ loadTabs: async () => {} });
  await replacer.replace("@/store/tabs-store", tabs);
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
  app.useBookmarksStore.setState({ selectedCollection: "all", selectedTags: [], filterType: "all", searchQuery: "", viewMode: "list", sortBy: "date-newest", highlightedBookmarkId: null });
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
