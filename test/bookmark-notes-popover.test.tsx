// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, Fragment, type PointerEvent as ReactPointerEvent } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";
import {
  OPEN_BOOKMARK_DIALOG_EVENT,
  readOpenBookmarkDialogRequest,
  type OpenBookmarkDialogRequest,
} from "@/lib/bookmark-dialog-events";

const replacer = createModuleReplacer();
const smartOpenUrl = mock(async () => {});
let app: AppModules;
let BookmarkCard: typeof import("@/components/dashboard/bookmark-card").BookmarkCard;
let BookmarkDialog: typeof import("@/components/dashboard/shared/bookmark-dialog").BookmarkDialog;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let SmartPointerSensor: typeof import("@/lib/drag-sensors").SmartPointerSensor;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let view: RenderResult | null = null;

const noted = makeBookmark("noted", {
  title: "Noted",
  collectionId: "reading",
  notes: "Line one <b>not bold</b>\nRead https://example.com/docs.",
});
const plain = makeBookmark("plain", { title: "Plain", collectionId: "reading" });

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  const realTabs = await importFresh<typeof import("@/lib/chrome/tabs")>("lib/chrome/tabs.ts");
  await replacer.replace("@/lib/chrome/tabs", { ...realTabs, smartOpenUrl });
  ({ BookmarkDialog } = await importFresh<typeof import("@/components/dashboard/shared/bookmark-dialog")>("components/dashboard/shared/bookmark-dialog.tsx"));
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ SelectionOrdersProvider } = await import("@/components/dashboard/shared/selection-orders"));
  ({ SmartPointerSensor } = await import("@/lib/drag-sensors"));
  ({ BookmarkCard } = await importFresh<typeof import("@/components/dashboard/bookmark-card")>("components/dashboard/bookmark-card.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

function renderCards(): void {
  view?.unmount();
  view = render(app, createElement(SelectionOrdersProvider, {
    viewOrder: ["noted", "plain"],
    onScreenOrder: ["noted", "plain"],
    children: [
      createElement(BookmarkCard, { key: "noted", bookmark: noted, variant: "list" }),
      createElement(BookmarkCard, { key: "plain", bookmark: plain, variant: "grid" }),
    ],
  }));
}

beforeEach(() => {
  view?.unmount();
  view = null;
  smartOpenUrl.mockClear();
  app.useWorkspaceStore.setState({ activeWorkspaceId: "home", workspaces: [makeWorkspace("home")], collections: [makeCollection("reading", "home")], tags: [] });
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap([noted, plain]), countsByCollection: countsByCollection([noted, plain]) });
  act(() => {
    useSelectionStore.getState().clear();
  });
  renderCards();
});

const notesButton = () => getBySelector('[data-bookmark-id="noted"] [aria-label="bookmarkNotes_show"]');
const popover = () => getBySelector('[data-slot="popover-content"]');

describe("bookmark notes on cards", () => {
  test("only a card with notes shows the notes button", () => {
    expect(notesButton()).toBeTruthy();
    expect(document.querySelector('[data-bookmark-id="plain"] [aria-label="bookmarkNotes_show"]')).toBeNull();
  });

  test("grid cards show the notes control, but whitespace-only notes have none", () => {
    view?.unmount();
    view = render(app, createElement(Fragment, null,
      createElement(BookmarkCard, { bookmark: noted, variant: "grid" }),
      createElement(BookmarkCard, { bookmark: { ...plain, notes: " \n\t " }, variant: "list" }),
    ));
    expect(notesButton()).toBeTruthy();
    expect(document.querySelector('[data-bookmark-id="plain"] [aria-label="bookmarkNotes_show"]')).toBeNull();
  });

  test("a long multiline note is complete and scrolls without collapsing newlines", async () => {
    const notes = `First line\n${"More notes ".repeat(998)}\nLast line`;
    view?.unmount();
    view = render(app, createElement(BookmarkCard, { bookmark: { ...noted, notes }, variant: "list" }));
    await act(async () => { click(notesButton()); });
    const content = getByText(notes);
    expect(content.textContent).toBe(notes);
    expect(content.classList.contains("overflow-y-auto")).toBe(true);
    expect(content.classList.contains("max-h-64")).toBe(true);
    expect(content.classList.contains("whitespace-pre-wrap")).toBe(true);
  });

  test("the popover shows the whole note as text, with links that open in a new tab", async () => {
    await act(async () => { click(notesButton()); });
    expect(popover().textContent).toContain("Line one <b>not bold</b>");
    expect(popover().querySelector("b")).toBeNull();
    const link = getBySelector<HTMLAnchorElement>('[data-slot="popover-content"] a');
    expect(link.textContent).toBe("https://example.com/docs");
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("clicks on the button and inside the popover neither open the bookmark nor change the selection", async () => {
    act(() => {
      useSelectionStore.getState().toggle("plain");
    });
    await act(async () => { click(notesButton()); });
    click(getByText("bookmarkNotes_heading"));
    expect(smartOpenUrl).not.toHaveBeenCalled();
    expect([...useSelectionStore.getState().selectedIds]).toEqual(["plain"]);
  });

  test("Edit note opens the form with the cursor in the notes", async () => {
    const requests: OpenBookmarkDialogRequest[] = [];
    const handleOpenRequest = (event: Event) => {
      requests.push(readOpenBookmarkDialogRequest(event));
    };
    window.addEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
    try {
      await act(async () => { click(notesButton()); });
      await act(async () => { click(getByText("bookmarkNotes_edit")); });
    } finally {
      window.removeEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
    }
    expect(requests).toEqual([{ bookmarkId: "noted", focus: "notes" }]);
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  test("Edit note hands focus to the mounted dialog and leaves the caret at the end", async () => {
    view?.unmount();
    view = render(app, createElement(MemoryRouter, null,
      createElement(Fragment, null,
        createElement(BookmarkCard, { bookmark: noted, variant: "list" }),
        createElement(BookmarkDialog),
      ),
    ));
    await act(async () => { click(notesButton()); });
    await act(async () => { click(getByText("bookmarkNotes_edit")); });
    const notes = getBySelector<HTMLTextAreaElement>('[role="dialog"] textarea[name="notes"]');
    expect(document.activeElement === notes).toBe(true);
    expect(notes.value).toBe(noted.notes);
    expect(notes.selectionStart).toBe(notes.value.length);
    expect(notes.selectionEnd).toBe(notes.value.length);
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  test("pressing the notes button never reaches the card drag wrapper", () => {
    const handleDragPress = mock(() => {});
    view?.unmount();
    view = render(app, createElement("div", { onPointerDown: handleDragPress },
      createElement(BookmarkCard, { bookmark: noted, variant: "list" }),
    ));
    act(() => {
      notesButton().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerType: "mouse" }));
    });
    expect(handleDragPress).not.toHaveBeenCalled();
  });

  test("a press inside the popover never starts a card drag", async () => {
    // Card menus and popovers render in portals, but React still bubbles their presses to the card's drag wrapper.
    const presses: ReactPointerEvent[] = [];
    view?.unmount();
    view = render(app, createElement(
      "div",
      { onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { presses.push(event); } },
      createElement(BookmarkCard, { bookmark: noted, variant: "list" }),
    ));
    await act(async () => { click(notesButton()); });
    act(() => {
      popover().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerType: "mouse" }));
    });
    const [press] = presses;
    if (!press) {
      throw new Error("the press did not reach the card's parent");
    }
    const [activator] = SmartPointerSensor.activators;
    expect(activator.handler(press, {})).toBe(false);
  });
});
