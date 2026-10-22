// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { Bookmark } from "@/lib/types";
import type { BookmarkViewMode } from "@/lib/view-preferences";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, installAppModules, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { makeBookmark } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let BookmarkCard: typeof import("@/components/dashboard/bookmark-card").BookmarkCard;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let view: RenderResult | null = null;

const covered = makeBookmark("covered", { title: "Covered", collectionId: "reading", imageUrl: "https://cdn.example.com/covered.png" });
const bare = makeBookmark("bare", { title: "Bare", url: "https://www.bare.example.com/page", collectionId: "reading" });

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ SelectionOrdersProvider } = await import("@/components/dashboard/shared/selection-orders"));
  ({ BookmarkCard } = await importFresh<typeof import("@/components/dashboard/bookmark-card")>("components/dashboard/bookmark-card.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  view = null;
  act(() => useSelectionStore.getState().clear());
});

function renderCard(bookmark: Bookmark, variant: BookmarkViewMode): HTMLElement {
  view = render(app, createElement(SelectionOrdersProvider, {
    viewOrder: [bookmark.id],
    onScreenOrder: [bookmark.id],
    children: createElement(BookmarkCard, { bookmark, variant }),
  }));
  return getBySelector(`[data-bookmark-id="${bookmark.id}"]`);
}

test("a large card shows the cover above the small card's title, address and menu", () => {
  const card = renderCard(covered, "gallery");

  expect(card.firstElementChild?.hasAttribute("data-bookmark-cover")).toBe(true);
  expect(card.querySelector("[data-bookmark-cover] img")?.getAttribute("src")).toBe("https://cdn.example.com/covered.png");
  expect(card.querySelector("h3")?.className).toContain("line-clamp-2");
  expect(card.textContent).toContain("https://example.com/covered");
  expect(card.querySelector('[aria-label="bookmarkCard_moreActions"]')).not.toBeNull();
});

test("a large card without a cover shows the site's placeholder", () => {
  const card = renderCard(bare, "gallery");
  expect(card.querySelector("[data-bookmark-cover] [data-cover-placeholder]")?.textContent).toBe("bare.example.com");
});

test("the selection checkbox sits on the cover, and only there", () => {
  const card = renderCard(covered, "gallery");
  const boxes = card.querySelectorAll('[role="checkbox"]');
  expect(boxes).toHaveLength(1);
  expect(boxes[0]?.closest("[data-bookmark-cover]")).not.toBeNull();

  click(getBySelector('[data-bookmark-id="covered"] [role="checkbox"]'));

  expect(useSelectionStore.getState().selectedIds.has("covered")).toBe(true);
  expect(getBySelector('[data-bookmark-id="covered"] [role="checkbox"]').getAttribute("aria-checked")).toBe("true");
});

test("a small card has no cover and keeps its checkbox on the favicon", () => {
  const card = renderCard(covered, "grid");
  expect(card.querySelector("[data-bookmark-cover]")).toBeNull();
  expect(card.querySelector('img[src="https://cdn.example.com/covered.png"]')).toBeNull();
  expect(card.querySelector('[role="checkbox"]')).not.toBeNull();
  expect(card.querySelector("h3")?.className).toContain("truncate");
});
