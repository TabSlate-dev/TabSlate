// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, openDropdown, render, rightClick, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeTag, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let FavoritesContent: typeof import("@/components/dashboard/favorites-content").FavoritesContent;
let BookmarkDialog: typeof import("@/components/dashboard/shared/bookmark-dialog").BookmarkDialog;
let view: RenderResult | null = null;

const favorite = makeBookmark("fav", { title: "Favorite page", collectionId: "reading", isFavorite: true });

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ FavoritesContent } = await importFresh<typeof import("@/components/dashboard/favorites-content")>("components/dashboard/favorites-content.tsx"));
  ({ BookmarkDialog } = await importFresh<typeof import("@/components/dashboard/shared/bookmark-dialog")>("components/dashboard/shared/bookmark-dialog.tsx"));
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
    collections: [makeCollection("reading", "home", { isDefault: true })],
    tags: [makeTag("frontend", "Frontend")],
  });
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap([favorite]), countsByCollection: countsByCollection([favorite]), selectedTags: [] });
  view = render(app, createElement(
    MemoryRouter,
    { initialEntries: ["/favorites"] },
    createElement(FavoritesContent),
    createElement(BookmarkDialog),
  ));
});

describe("editing from the Favorites page", () => {
  test("Edit opens the form for the bookmark", async () => {
    await act(async () => {
      rightClick(getBySelector('[data-bookmark-id="fav"]'));
    });
    await act(async () => {
      click(getByText("bookmarkCard_edit"));
    });
    const title = getBySelector<HTMLInputElement>('[role="dialog"] [name="title"]');
    expect(title.value).toBe("Favorite page");
    expect(document.activeElement === title).toBe(true);
  });

  test("Add tags opens the form at the tag field", async () => {
    await act(async () => {
      openDropdown(getBySelector('[aria-label="bookmarkCard_moreActions"]'));
    });
    await act(async () => {
      click(getByText("bookmarkCard_addTags"));
    });
    expect(document.activeElement === getBySelector('[role="dialog"] [role="combobox"]')).toBe(true);
  });
});
