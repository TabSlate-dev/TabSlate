// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, installAppModules, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeTag, makeWorkspace } from "./helpers/library-fixtures";
import { installMeasuredVirtualizer, installQuietTabsStore } from "./helpers/virtualizer";

const replacer = createModuleReplacer();
let app: AppModules;
let TagList: typeof import("@/components/ui/tag-list").TagList;
let BookmarkCard: typeof import("@/components/dashboard/bookmark-card").BookmarkCard;
let ArchiveContent: typeof import("@/components/dashboard/archive-content").ArchiveContent;
let TrashContent: typeof import("@/components/dashboard/trash-content").TrashContent;
let ActiveFilterChips: typeof import("@/components/dashboard/shared/active-filter-chips").ActiveFilterChips;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let view: RenderResult | null = null;
const scrollOffsets: number[] = [];

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  await installMeasuredVirtualizer(replacer, scrollOffsets);
  await installQuietTabsStore(replacer);
  ({ TagList } = await importFresh<typeof import("@/components/ui/tag-list")>("components/ui/tag-list.tsx"));
  ({ BookmarkCard } = await importFresh<typeof import("@/components/dashboard/bookmark-card")>("components/dashboard/bookmark-card.tsx"));
  ({ ArchiveContent } = await importFresh<typeof import("@/components/dashboard/archive-content")>("components/dashboard/archive-content.tsx"));
  ({ TrashContent } = await importFresh<typeof import("@/components/dashboard/trash-content")>("components/dashboard/trash-content.tsx"));
  ({ ActiveFilterChips } = await importFresh<typeof import("@/components/dashboard/shared/active-filter-chips")>("components/dashboard/shared/active-filter-chips.tsx"));
  ({ SelectionOrdersProvider } = await importFresh<typeof import("@/components/dashboard/shared/selection-orders")>("components/dashboard/shared/selection-orders.tsx"));
  ({ useSelectionStore } = await importFresh<typeof import("@/store/selection-store")>("store/selection-store.ts"));
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
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home")],
    tags: [
      { id: "parent", name: "Parent", color: "blue", seq: 1 },
      { id: "child", parentId: "parent", name: "Child", color: "blue", seq: 1 },
    ],
  });
  app.useBookmarksStore.setState({
    selectedCollection: "all",
    selectedTags: [],
    filterType: "all",
    searchQuery: "",
    viewMode: "grid",
    sortBy: "date-newest",
    highlightedBookmarkId: null,
    bookmarks: new Map(),
    archivedBookmarks: [],
    trashedBookmarks: [],
  });
});

test("TagList renders leaf name as visible text and full path in accessible label and tooltip", () => {
  const tag = { id: "child", parentId: "parent", name: "Child", color: "blue", seq: 1 };
  const pathByTagId = new Map([["child", "Parent › Child"]]);

  view = render(app, createElement(TagList, { tags: [tag], pathByTagId, onTagClick: () => {} }));
  const button = getBySelector('button[data-tag-id="child"]');
  expect(button.textContent?.trim()).toBe("Child");
  expect(button.getAttribute("aria-label")).toBe("Parent › Child");
});

test("active BookmarkCard renders leaf name on chip and full path from complete tag graph", () => {
  const bookmark = makeBookmark("bm-1", { collectionId: "reading", tags: ["child"] });
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap([bookmark]), countsByCollection: countsByCollection([bookmark]) });

  const viewOrder = [bookmark.id];
  view = render(app, createElement(
    SelectionOrdersProvider,
    {
      viewOrder,
      onScreenOrder: viewOrder,
      children: createElement(BookmarkCard, { bookmark }),
    }
  ));

  const tagBtn = getBySelector('button[data-tag-id="child"]');
  expect(tagBtn.textContent?.trim()).toBe("Child");
  expect(tagBtn.getAttribute("aria-label")).toBe("Parent › Child");

  // Clicking tag filters by tag and does not select the card
  click(tagBtn);
  expect(app.useBookmarksStore.getState().selectedTags).toEqual(["child"]);
  expect(useSelectionStore.getState().selectedIds.has("bm-1")).toBe(false);
});

test("ArchiveContent renders tag chips with leaf name and full path accessible text", () => {
  const bookmark = makeBookmark("archived-1", { collectionId: "reading", tags: ["child"] });
  app.useBookmarksStore.setState({ archivedBookmarks: [bookmark] });

  view = render(app, createElement(ArchiveContent));
  const chip = getBySelector('[aria-label="Parent › Child"]');
  expect(chip).toBeTruthy();
  expect(chip.textContent?.trim()).toBe("Child");
});

test("TrashContent renders tag chips with leaf name and full path accessible text", () => {
  const bookmark = makeBookmark("trashed-1", { collectionId: "reading", tags: ["child"] });
  app.useBookmarksStore.setState({ trashedBookmarks: [bookmark] });

  view = render(app, createElement(TrashContent));
  const chip = getBySelector('[aria-label="Parent › Child"]');
  expect(chip).toBeTruthy();
  expect(chip.textContent?.trim()).toBe("Child");
});

test("ActiveFilterChips shows truncated path with full path tooltip", () => {
  app.useBookmarksStore.setState({ selectedTags: ["child"] });

  view = render(app, createElement(ActiveFilterChips));
  const chip = getBySelector(".truncate");
  expect(chip.textContent?.trim()).toBe("Parent › Child");
});
