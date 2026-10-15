// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
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
  openInNewTab.mockClear();
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

function pointerDown(element: Element): void {
  act(() => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  });
}

const variants: Array<"grid" | "list"> = ["grid", "list"];
for (const variant of variants) {
  describe(`BookmarkCard ${variant} menus`, () => {
    beforeEach(() => {
      view?.rerender(createElement(BookmarkCard, { bookmark: article, variant }));
    });
    test("right-click shows the same actions as the ⋯ menu", async () => {
      await act(async () => {
        rightClick(getBySelector('[data-bookmark-id="b1"]'));
      });
      expect(itemTexts("context-menu-item")).toEqual(MENU_ITEMS);
      pressKey(getByText("bookmarkCard_openSmart"), "Escape");

      await act(async () => {
        openDropdown(getBySelector('[aria-label="bookmarkCard_moreActions"]'));
      });
      expect(itemTexts("dropdown-menu-item")).toEqual(MENU_ITEMS);
    });

    test("presses inside an open card menu never reach a parent pointerdown handler", async () => {
      const handleParentPointerDown = mock(() => {});
      view?.rerender(createElement(
        "div",
        { onPointerDown: handleParentPointerDown },
        createElement(BookmarkCard, { bookmark: article, variant }),
      ));

      await act(async () => {
        rightClick(getBySelector('[data-bookmark-id="b1"]'));
      });
      pointerDown(getBySelector('[data-slot="context-menu-item"]'));
      expect(handleParentPointerDown).not.toHaveBeenCalled();
      pressKey(getByText("bookmarkCard_openSmart"), "Escape");

      await act(async () => {
        openDropdown(getBySelector('[aria-label="bookmarkCard_moreActions"]'));
      });
      // Opening the ⋯ menu is itself a press on the card.
      handleParentPointerDown.mockClear();
      pointerDown(getBySelector('[data-slot="dropdown-menu-item"]'));
      expect(handleParentPointerDown).not.toHaveBeenCalled();

      pointerDown(getBySelector('[data-bookmark-id="b1"]'));
      expect(handleParentPointerDown).toHaveBeenCalledTimes(1);
    });

    test("archiving from the right-click menu removes the bookmark from the active list", async () => {
      await act(async () => {
        rightClick(getBySelector('[data-bookmark-id="b1"]'));
      });
      click(getByText("bookmarkCard_archive"));
      expect(app.useBookmarksStore.getState().bookmarks.has("b1")).toBe(false);
    });

    test("clicking a tag on the card filters by it without opening the bookmark", () => {
      click(getBySelector('button[data-tag-id="frontend"]'));
      expect(app.useBookmarksStore.getState().selectedTags).toEqual(["frontend"]);
      expect(getBySelector('button[data-tag-id="frontend"]').getAttribute("aria-pressed")).toBe("true");
      expect(smartOpenUrl).not.toHaveBeenCalled();
      click(getBySelector('button[data-tag-id="frontend"]'));
      expect(app.useBookmarksStore.getState().selectedTags).toEqual([]);
      expect(getBySelector('button[data-tag-id="frontend"]').getAttribute("aria-pressed")).toBe("false");
    });
    test("card clicks still open the bookmark and drag handle pointer events remain available", () => {
      const handleDragStart = mock(() => {});
      view?.rerender(createElement(BookmarkCard, {
        bookmark: article,
        variant,
        dragHandleProps: { "data-drag-handle": true, onPointerDown: handleDragStart },
      }));
      const handle = getBySelector("[data-drag-handle]");
      act(() => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
      });
      expect(handleDragStart).toHaveBeenCalledTimes(1);
      click(handle);
      expect(smartOpenUrl).not.toHaveBeenCalled();
      click(getBySelector('[data-bookmark-id="b1"]'));
      expect(smartOpenUrl).toHaveBeenCalledWith(article.url);
    });
  });
}
