// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, render, setupDom, teardownDom, wait, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let BulkActionBar: typeof import("@/components/dashboard/bulk-actions").BulkActionBar;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let view: RenderResult | null = null;
let retireMoveTargets = false;

const library = [
  makeBookmark("a", { title: "A", collectionId: "reading" }),
  makeBookmark("b", { title: "B", collectionId: "projects", isFavorite: true }),
  makeBookmark("c", { title: "C", collectionId: "reading" }),
];

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  const visibility = await importFresh<typeof import("@/lib/workspace-visibility")>("lib/workspace-visibility.ts");
  // Lets a test retire the Move target between choosing it and the move running.
  await replacer.replace("@/lib/workspace-visibility", {
    ...visibility,
    resolveActiveWorkspaceCollectionTarget: (...args: Parameters<typeof visibility.resolveActiveWorkspaceCollectionTarget>) =>
      retireMoveTargets ? undefined : visibility.resolveActiveWorkspaceCollectionTarget(...args),
  });
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ SelectionOrdersProvider } = await import("@/components/dashboard/shared/selection-orders"));
  ({ BulkActionBar } = await importFresh<typeof import("@/components/dashboard/bulk-actions")>("components/dashboard/bulk-actions/index.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

function renderBar(viewOrder: readonly string[] = ["a", "b", "c"], onScreenOrder: readonly string[] = viewOrder): void {
  view?.unmount();
  view = render(app, createElement(MemoryRouter, null, createElement(SelectionOrdersProvider, {
    viewOrder,
    onScreenOrder,
    children: createElement(BulkActionBar),
  })));
}

beforeEach(() => {
  view?.unmount();
  view = null;
  retireMoveTargets = false;
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home", { name: "Home" })],
    collections: [
      makeCollection("reading", "home", { name: "Reading", isDefault: true }),
      makeCollection("projects", "home", { name: "Projects", position: 1 }),
    ],
    tags: [],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(library),
    countsByCollection: countsByCollection(library),
    archivedBookmarks: [],
    trashedBookmarks: [],
    _archivedLoaded: true,
    _trashedLoaded: true,
  });
  act(() => {
    useSelectionStore.getState().clear();
  });
  renderBar();
});

function select(...ids: string[]): void {
  act(() => {
    useSelectionStore.getState().setMany(ids, true);
  });
}
const selected = () => [...useSelectionStore.getState().selectedIds].sort();
const bookmark = (id: string) => app.useBookmarksStore.getState().bookmarks.get(id);

describe("BulkActionBar", () => {
  test("a replacement notice stays for its own three seconds after the toolbar disappears", async () => {
    select("a");
    click(getByText("bulkActions_archive"));
    await wait(1000);
    select("b");
    click(getByText("bulkActions_delete"));
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    await wait(2150);
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_trashedOne");
    await wait(1000);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  test("unmounting removes a notice and does not carry it into a new view", async () => {
    select("a");
    click(getByText("bulkActions_archive"));
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    renderBar();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  test("Favorite publishes one bookmark change for the whole selection", () => {
    select("a", "c");
    let changes = 0;
    const unsubscribe = app.useBookmarksStore.subscribe(() => { changes += 1; });
    try {
      click(getByText("bulkActions_favorite"));
      expect([bookmark("a")?.isFavorite, bookmark("c")?.isFavorite]).toEqual([true, true]);
      expect(changes).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  test("appears with a selection and announces the count", () => {
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    select("a", "b");
    expect(getBySelector('[role="toolbar"]').getAttribute("aria-label")).toBe("bulkActions_toolbarLabel");
    expect(getBySelector('[aria-live="polite"]').textContent).toBe("bulkActions_selectedCount[2]");
  });

  test("Move to moves the bookmarks that live elsewhere and clears the selection", async () => {
    select("a", "b");
    await act(async () => { click(getByText("bulkActions_moveTo")); });
    click(getByText("Projects"));

    expect(bookmark("a")?.collectionId).toBe("projects");
    expect(bookmark("b")?.updatedAt).toBeUndefined();
    expect(selected()).toEqual([]);
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_movedOne[Projects]");
  });

  test("a Move target that is no longer available writes nothing and says so", async () => {
    select("a");
    await act(async () => { click(getByText("bulkActions_moveTo")); });
    retireMoveTargets = true;
    click(getByText("Projects"));

    expect(bookmark("a")?.collectionId).toBe("reading");
    expect(selected()).toEqual(["a"]);
    expect(getBySelector('[role="status"]').textContent).toContain("workspaceVisibility_targetUnavailable");
  });

  test("Favorite favorites every bookmark unless all are favorites, and the label follows", () => {
    select("a", "b");
    click(getByText("bulkActions_favorite"));
    expect([bookmark("a")?.isFavorite, bookmark("b")?.isFavorite]).toEqual([true, true]);

    click(getByText("bulkActions_unfavorite"));
    expect([bookmark("a")?.isFavorite, bookmark("b")?.isFavorite]).toEqual([false, false]);
    expect(selected()).toEqual(["a", "b"]);
  });

  test("Archive archives the selection, clears it and links to the Archive page", () => {
    select("a", "c");
    click(getByText("bulkActions_archive"));

    const state = app.useBookmarksStore.getState();
    expect([...state.bookmarks.keys()]).toEqual(["b"]);
    expect(state.archivedBookmarks.map((archived) => archived.id)).toEqual(["a", "c"]);
    expect(selected()).toEqual([]);
    const notice = getBySelector('[role="status"]');
    expect(notice.textContent).toContain("bulkActions_archivedOther[2]");
    expect(notice.className).toContain("pointer-events-auto");
    expect(getBySelector('[role="status"] a').getAttribute("href")).toBe("/archive");
  });

  test("Delete moves the selection to the trash, clears it and links to the Trash page", () => {
    select("b");
    click(getByText("bulkActions_delete"));

    const state = app.useBookmarksStore.getState();
    expect(state.bookmarks.has("b")).toBe(false);
    expect(state.trashedBookmarks.map((trashed) => trashed.id)).toEqual(["b"]);
    expect(selected()).toEqual([]);
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_trashedOne");
    expect(getBySelector('[role="status"] a').getAttribute("href")).toBe("/trash");
  });

  test("Select all selects the bookmarks on screen, not those in collapsed groups", () => {
    renderBar(["a", "b", "c"], ["a", "b"]);
    select("a");
    click(getByText("bulkActions_selectAll"));
    expect(selected()).toEqual(["a", "b"]);
  });

  test("the close button clears the selection", () => {
    select("a", "b");
    click(getBySelector('[aria-label="bulkActions_clear"]'));
    expect(selected()).toEqual([]);
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
  });
});
