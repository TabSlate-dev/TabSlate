// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Collection, Workspace } from "@/lib/types";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { installAppModules, setupDom, teardownDom, type AppModules } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let revealBookmark: typeof import("@/lib/reveal-bookmark").revealBookmark;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ revealBookmark } = await importFresh<typeof import("@/lib/reveal-bookmark")>("lib/reveal-bookmark.ts"));
});

afterAll(async () => {
  app.useBookmarksStore.getState().setHighlightedBookmarkId(null);
  replacer.restore();
  await teardownDom();
});

beforeEach(() => {
  const bookmarks = [
    makeBookmark("in-projects", { collectionId: "projects" }),
    makeBookmark("loose", { collectionId: "" }),
    makeBookmark("in-archive", { collectionId: "old" }),
  ];
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home"), makeWorkspace("work")],
    collections: [
      makeCollection("reading", "home", { isDefault: true }),
      makeCollection("projects", "work", { isDefault: true }),
      makeCollection("old", "home", { archivedAt: 1 }),
    ],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedCollection: "reading",
    selectedTags: ["go"],
    filterType: "favorites",
    searchQuery: "draft",
    highlightedBookmarkId: null,
  });
});

describe("revealBookmark", () => {
  test("switches to the bookmark's workspace and collection and clears what could hide it", () => {
    expect(revealBookmark("in-projects")).toBe(true);

    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("work");
    const state = app.useBookmarksStore.getState();
    expect([state.selectedCollection, state.selectedTags, state.filterType, state.searchQuery, state.highlightedBookmarkId])
      .toEqual(["projects", [], "all", "", "in-projects"]);
  });

  test("shows an uncategorized bookmark under all bookmarks in the current workspace", () => {
    expect(revealBookmark("loose")).toBe(true);
    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("home");
    expect(app.useBookmarksStore.getState().selectedCollection).toBe("all");
  });

  test("refuses a bookmark the normal list never shows", () => {
    expect(revealBookmark("in-archive")).toBe(false);
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBeNull();
    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("home");
  });

  test("refuses an unknown bookmark", () => {
    expect(revealBookmark("missing")).toBe(false);
  });
  test.each([
    ["deleted collection", [makeWorkspace("work")], [makeCollection("projects", "work", { deletedAt: 1 })]],
    ["missing collection", [makeWorkspace("work")], []],
    ["retained workspace", [makeWorkspace("work", { deletedAt: 1 })], [makeCollection("projects", "work")]],
    ["missing workspace", [], [makeCollection("projects", "work")]],
  ])("refuses a bookmark under a %s without changing the selection", (_label: string, workspaces: Workspace[], collections: Collection[]) => {
    app.useWorkspaceStore.setState({ workspaces, collections });
    expect(revealBookmark("in-projects")).toBe(false);
    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("home");
    const state = app.useBookmarksStore.getState();
    expect([state.selectedCollection, state.selectedTags, state.filterType, state.searchQuery, state.highlightedBookmarkId])
      .toEqual(["reading", ["go"], "favorites", "draft", null]);
  });

});
