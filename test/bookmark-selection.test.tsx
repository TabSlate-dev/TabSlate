// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, openDropdown, pressKey, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeTag, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
const smartOpenUrl = mock(async () => {});
let app: AppModules;
let FavoritesContent: typeof import("@/components/dashboard/favorites-content").FavoritesContent;
let BookmarkCard: typeof import("@/components/dashboard/bookmark-card").BookmarkCard;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let isMacPlatform: typeof import("@/lib/platform").isMacPlatform;
let view: RenderResult | null = null;

const favorites = ["a", "b", "c", "d"].map((id) => makeBookmark(id, {
  title: id.toUpperCase(),
  collectionId: "reading",
  isFavorite: true,
  tags: id === "a" ? ["frontend"] : [],
}));

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  const realTabs = await importFresh<typeof import("@/lib/chrome/tabs")>("lib/chrome/tabs.ts");
  await replacer.replace("@/lib/chrome/tabs", { ...realTabs, smartOpenUrl });
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ isMacPlatform } = await import("@/lib/platform"));
  ({ BookmarkCard } = await importFresh<typeof import("@/components/dashboard/bookmark-card")>("components/dashboard/bookmark-card.tsx"));
  ({ FavoritesContent } = await importFresh<typeof import("@/components/dashboard/favorites-content")>("components/dashboard/favorites-content.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
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
    bookmarks: bookmarkMap(favorites),
    countsByCollection: countsByCollection(favorites),
    selectedCollection: "all",
    selectedTags: [],
    filterType: "all",
    searchQuery: "",
    sortBy: "alpha-az",
    viewMode: "grid",
  });
  act(() => {
    useSelectionStore.getState().clear();
  });
  view = render(app, createElement(MemoryRouter, null, createElement(FavoritesContent)));
});

const card = (id: string) => getBySelector(`[data-bookmark-id="${id}"]`);
const checkbox = (id: string) => getBySelector(`[data-bookmark-id="${id}"] [role="checkbox"]`);
const selected = () => [...useSelectionStore.getState().selectedIds].sort();
const toggleModifier = (): MouseEventInit => (isMacPlatform() ? { metaKey: true } : { ctrlKey: true });

describe("selecting bookmark cards", () => {
  test("archiving all Favorites keeps its result notice visible in the empty view", () => {
    for (const id of ["a", "b", "c", "d"]) {
      click(checkbox(id));
    }
    click(getByText("bulkActions_archive"));
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    expect(document.querySelector('[data-bookmark-id]')).toBeNull();
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_archivedOther[4]");
  });

  test("selecting a card shows the bulk action bar", () => {
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    click(checkbox("b"));
    expect(document.querySelector('[role="toolbar"]')).not.toBeNull();
  });

  test("each card offers a labeled checkbox, and checking it does not open the bookmark", () => {
    expect(checkbox("a").getAttribute("aria-label")).toBe("bookmarkCard_select[A]");
    expect(checkbox("a").getAttribute("aria-checked")).toBe("false");

    click(checkbox("a"));

    expect(selected()).toEqual(["a"]);
    expect(checkbox("a").getAttribute("aria-checked")).toBe("true");
    expect(card("a").hasAttribute("data-selected")).toBe(true);
    expect(smartOpenUrl).not.toHaveBeenCalled();
  });

  test("while a selection is active, clicking a card toggles it instead of opening it", () => {
    click(checkbox("a"));
    click(card("b"));
    expect(selected()).toEqual(["a", "b"]);
    click(card("a"));
    expect(selected()).toEqual(["b"]);
    expect(smartOpenUrl).not.toHaveBeenCalled();

    click(card("b"));
    expect(selected()).toEqual([]);
    click(card("c"));
    expect(smartOpenUrl).toHaveBeenCalledWith(favorites[2].url);
  });

  test("Shift+click selects the range from the anchor and keeps the anchor", () => {
    click(checkbox("b"));
    click(card("d"), { shiftKey: true });
    expect(selected()).toEqual(["b", "c", "d"]);
    click(card("a"), { shiftKey: true });
    expect(selected()).toEqual(["a", "b", "c", "d"]);
    expect(smartOpenUrl).not.toHaveBeenCalled();
  });

  test("Shift+click without an anchor toggles the card", () => {
    click(card("c"), { shiftKey: true });
    expect(selected()).toEqual(["c"]);
  });

  test("Cmd or Ctrl+click toggles a card and starts a selection", () => {
    click(card("c"), toggleModifier());
    expect(selected()).toEqual(["c"]);
    expect(smartOpenUrl).not.toHaveBeenCalled();
  });

  test("Shift+press does not start a text selection", () => {
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true });
    act(() => {
      card("b").dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
  });

  test("clicking a tag on a card filters by it and clears the selection", () => {
    click(checkbox("b"));
    click(getBySelector('[data-bookmark-id="a"] button[data-tag-id="frontend"]'));
    expect(app.useBookmarksStore.getState().selectedTags).toEqual(["frontend"]);
    expect(selected()).toEqual([]);
  });

  test("Esc clears the selection", () => {
    click(checkbox("b"));
    click(checkbox("c"));
    pressKey(document.body, "Escape");
    expect(selected()).toEqual([]);
  });

  test("a bookmark that leaves the view drops out of the selection", () => {
    click(checkbox("a"));
    click(checkbox("b"));
    act(() => {
      app.useBookmarksStore.getState().toggleFavorite("a");
    });
    expect(selected()).toEqual(["b"]);
  });

  test("a card outside a selectable view has no checkbox and still opens on click", () => {
    view?.unmount();
    act(() => { useSelectionStore.getState().setMany(["b"], true); });
    view = render(app, createElement(BookmarkCard, { bookmark: favorites[0] }));
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    click(card("a"));
    expect(smartOpenUrl).toHaveBeenCalledWith(favorites[0].url);
  });

  test("memoized cards read the latest display order after another bookmark moves", () => {
    click(checkbox("b"));
    act(() => {
      app.useBookmarksStore.setState({ bookmarks: bookmarkMap(favorites.map((bookmark) => (
        bookmark.id === "c" ? { ...bookmark, title: "Z" } : bookmark
      ))) });
    });
    click(card("d"), { shiftKey: true });
    expect(selected()).toEqual(["b", "d"]);
  });

  test("large cards expose the same selectable checkbox, on the cover", () => {
    act(() => { app.useBookmarksStore.setState({ viewMode: "gallery" }); });
    expect(checkbox("c").closest("[data-bookmark-cover]")).not.toBeNull();
    click(checkbox("c"));
    expect(checkbox("c").getAttribute("aria-checked")).toBe("true");
    expect(card("c").hasAttribute("data-selected")).toBe(true);
    expect(smartOpenUrl).not.toHaveBeenCalled();
  });

  test("checkbox button activation selects without opening the bookmark", () => {
    const button = getBySelector<HTMLButtonElement>('[data-bookmark-id="a"] button[role="checkbox"]');
    act(() => { button.focus(); button.click(); });
    expect(document.activeElement).toBe(button);
    expect(selected()).toEqual(["a"]);
    expect(smartOpenUrl).not.toHaveBeenCalled();
  });


  test("the explicit menu open action still opens while a selection is active", async () => {
    click(checkbox("a"));
    await act(async () => {
      openDropdown(getBySelector('[data-bookmark-id="b"] [aria-label="bookmarkCard_moreActions"]'));
    });
    click(getByText("bookmarkCard_openSmart"));
    expect(selected()).toEqual(["a"]);
    expect(smartOpenUrl).toHaveBeenCalledWith(favorites[1].url);
  });

});
