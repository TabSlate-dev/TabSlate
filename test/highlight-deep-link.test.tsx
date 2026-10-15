// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement, useMemo } from "react";
import { getActiveWorkspaceCollectionIds } from "@/lib/workspace-visibility";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { getBySelector, installAppModules, render, setupDom, teardownDom, type AppModules } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let useWorkspaceCollectionReset: typeof import("@/hooks/use-workspace-collection-reset").useWorkspaceCollectionReset;
let useHighlightDeepLink: typeof import("@/hooks/use-highlight-deep-link").useHighlightDeepLink;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ useWorkspaceCollectionReset } = await importFresh<typeof import("@/hooks/use-workspace-collection-reset")>(
    "hooks/use-workspace-collection-reset.ts",
  ));
  ({ useHighlightDeepLink } = await importFresh<typeof import("@/hooks/use-highlight-deep-link")>(
    "hooks/use-highlight-deep-link.ts",
  ));
});

afterAll(async () => {
  app.useBookmarksStore.getState().setHighlightedBookmarkId(null);
  replacer.restore();
  await teardownDom();
});

beforeEach(() => {
  const bookmarks = [makeBookmark("b1", { collectionId: "reading" })];
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    highlightedBookmarkId: null,
    selectedCollection: "reading",
  });
});

function Probe() {
  const selectedCollection = app.useBookmarksStore(s => s.selectedCollection);
  const setSelectedCollection = app.useBookmarksStore(s => s.setSelectedCollection);
  const activeWorkspaceId = app.useWorkspaceStore(s => s.activeWorkspaceId);
  const workspaces = app.useWorkspaceStore(s => s.workspaces);
  const collections = app.useWorkspaceStore(s => s.collections);
  const ids = useMemo(
    () => getActiveWorkspaceCollectionIds(activeWorkspaceId, workspaces, collections),
    [activeWorkspaceId, workspaces, collections],
  );
  useWorkspaceCollectionReset(selectedCollection, ids, setSelectedCollection);
  useHighlightDeepLink();
  return createElement("span", { id: "search" }, useLocation().search);
}

function renderAt(entry: string) {
  return render(app, createElement(MemoryRouter, { initialEntries: [entry] }, createElement(Probe)));
}

describe("useHighlightDeepLink", () => {
  test("reveals the bookmark and removes the parameter", () => {
    const view = renderAt("/?highlight=b1");
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBe("b1");
    expect(getBySelector("#search").textContent).toBe("");
    view.unmount();
  });

  test("removes the parameter for an unknown bookmark", () => {
    const view = renderAt("/?highlight=missing");
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBeNull();
    expect(getBySelector("#search").textContent).toBe("");
    view.unmount();
  });
  test("removes the parameter for a bookmark under a retained workspace", () => {
    app.useWorkspaceStore.setState({ workspaces: [makeWorkspace("home", { deletedAt: 1 })] });
    const view = renderAt("/?keep=value&highlight=b1");
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBeNull();
    expect(getBySelector("#search").textContent).toBe("?keep=value");
    view.unmount();
  });

  test("consumes an empty highlight parameter while preserving other parameters", () => {
    const view = renderAt("/?highlight=&keep=value");
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBeNull();
    expect(getBySelector("#search").textContent).toBe("?keep=value");
    view.unmount();
  });

  test("keeps the revealed collection when the reset hook observes the workspace switch", () => {
    const bookmarks = [makeBookmark("b2", { collectionId: "projects" })];
    app.useWorkspaceStore.setState({
      workspaces: [makeWorkspace("home"), makeWorkspace("work")],
      collections: [makeCollection("reading", "home"), makeCollection("projects", "work")],
    });
    app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks) });
    const view = renderAt("/?highlight=b2&keep=value");
    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("work");
    expect(app.useBookmarksStore.getState().selectedCollection).toBe("projects");
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBe("b2");
    expect(getBySelector("#search").textContent).toBe("?keep=value");
    view.unmount();
  });

});
