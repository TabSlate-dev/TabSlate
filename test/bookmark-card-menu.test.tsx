// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, type PointerEvent as ReactPointerEvent } from "react";
import type { PointerSensorOptions } from "@dnd-kit/core";
import { OPEN_BOOKMARK_DIALOG_EVENT, readOpenBookmarkDialogRequest, type OpenBookmarkDialogRequest } from "@/lib/bookmark-dialog-events";
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
  wait,
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
let SmartPointerSensor: typeof import("@/lib/drag-sensors").SmartPointerSensor;
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
  ({ SmartPointerSensor } = await import("@/lib/drag-sensors"));
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

/** A primary mouse press, like the ones that start a card drag. */
function pointerDown(target: EventTarget): void {
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerType: "mouse" }));
  });
}

const variants: Array<"grid" | "gallery"> = ["grid", "gallery"];
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

    test("Edit and Add tags open the bookmark form", async () => {
      const requests: OpenBookmarkDialogRequest[] = [];
      const handleOpenRequest = (event: Event) => {
        requests.push(readOpenBookmarkDialogRequest(event));
      };
      window.addEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
      try {
        await act(async () => {
          rightClick(getBySelector('[data-bookmark-id="b1"]'));
        });
        click(getByText("bookmarkCard_edit"));
        await act(async () => {
          openDropdown(getBySelector('[aria-label="bookmarkCard_moreActions"]'));
        });
        click(getByText("bookmarkCard_addTags"));
      } finally {
        window.removeEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
      }
      expect(requests).toEqual([{ bookmarkId: "b1" }, { bookmarkId: "b1", focus: "tags" }]);
    });

    test("the drag sensor ignores presses inside an open card menu but not presses on the card", async () => {
      const presses: ReactPointerEvent[] = [];
      view?.rerender(createElement(
        "div",
        { onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { presses.push(event); } },
        createElement(BookmarkCard, { bookmark: article, variant, dragHandleProps: { "data-drag-handle": true } }),
      ));
      const [activator] = SmartPointerSensor.activators;
      // Card menus render in portals, but React still bubbles their presses to the card's drag wrapper.
      const activates = (target: EventTarget, options: PointerSensorOptions = {}): boolean => {
        const before = presses.length;
        pointerDown(target);
        const press = presses[before];
        if (!press) {
          throw new Error("the press did not reach the card's parent");
        }
        return activator.handler(press, options);
      };

      await act(async () => {
        rightClick(getBySelector('[data-bookmark-id="b1"]'));
      });
      const archive = getByText("bookmarkCard_archive");
      expect(activates(archive)).toBe(false);
      const archiveLabel = Array.from(archive.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
      if (!archiveLabel) {
        throw new Error("the menu item has no text node");
      }
      expect(activates(archiveLabel)).toBe(false);
      pressKey(archive, "Escape");

      await act(async () => {
        openDropdown(getBySelector('[aria-label="bookmarkCard_moreActions"]'));
      });
      expect(activates(getByText("bookmarkCard_delete"))).toBe(false);
      pressKey(getByText("bookmarkCard_delete"), "Escape");

      expect(activates(getBySelector('[data-bookmark-id="b1"] h3'))).toBe(true);
      const handleOptions: PointerSensorOptions = { activationConstraint: { delay: 250, tolerance: 5 } };
      expect(activates(getBySelector("[data-drag-handle]"), handleOptions)).toBe(true);
      expect(handleOptions.activationConstraint).toEqual({ distance: 1 });
    });

    test("after a press on an open menu's padding, an outside press still closes the menu", async () => {
      const outside = document.createElement("div");
      document.body.appendChild(outside);
      try {
        await act(async () => {
          rightClick(getBySelector('[data-bookmark-id="b1"]'));
        });
        // Radix starts listening for outside presses on the next tick.
        await wait(10);
        pointerDown(getBySelector('[data-slot="context-menu-content"]'));
        pointerDown(outside);
        await wait(0);
        expect(document.querySelector('[data-slot="context-menu-content"]')).toBeNull();

        await act(async () => {
          openDropdown(getBySelector('[aria-label="bookmarkCard_moreActions"]'));
        });
        await wait(10);
        pointerDown(getBySelector('[data-slot="dropdown-menu-content"]'));
        pointerDown(outside);
        await wait(0);
        expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
      } finally {
        outside.remove();
      }
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
