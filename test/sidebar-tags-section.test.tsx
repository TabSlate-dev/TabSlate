// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createModuleReplacer } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  pressKey,
  render,
  setupDom,
  teardownDom,
  typeInto,
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
import { createTagIdb } from "./helpers/tag-idb";

const db = createTagIdb();
const replacer = createModuleReplacer();
let app: AppModules;
let SidebarProvider: typeof import("@/components/ui/sidebar").SidebarProvider;
let SidebarTagsSection: typeof import("@/components/dashboard/sidebar/tags-section").SidebarTagsSection;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  await replacer.replace("@/lib/idb", { ...await import("@/lib/idb"), ...db.module });
  ({ SidebarProvider } = await import("@/components/ui/sidebar"));
  ({ SidebarTagsSection } = await import("@/components/dashboard/sidebar/tags-section"));
});

afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

beforeEach(() => {
  view?.unmount();
  db.tables.clear();
  const bookmarks = [
    makeBookmark("b1", { collectionId: "reading", tags: ["frontend", "go"] }),
    makeBookmark("b2", { collectionId: "reading", tags: ["frontend"] }),
    makeBookmark("b3", { collectionId: "", tags: ["frontend"] }),
    makeBookmark("b4", { collectionId: "projects", tags: ["frontend", "design"] }),
  ];
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home"), makeWorkspace("work")],
    collections: [makeCollection("reading", "home", { isDefault: true }), makeCollection("projects", "work")],
    tags: [makeTag("frontend", "Frontend"), makeTag("go", "Go"), makeTag("design", "Design")],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedTags: [],
  });
  view = render(app, createElement(SidebarProvider, null, createElement(SidebarTagsSection)));
  click(getByText("sidebar_tags"));
});

const chip = (tagId: string) => getBySelector(`[data-tag-id="${tagId}"]`);

describe("SidebarTagsSection", () => {
  test("shows how many bookmarks in the active workspace carry each tag", () => {
    expect(chip("frontend").querySelector("[data-tag-count]")?.textContent).toBe("3");
    expect(chip("go").querySelector("[data-tag-count]")?.textContent).toBe("1");
    expect(chip("design").querySelector("[data-tag-count]")?.textContent).toBe("0");
  });

  test("clicking a tag toggles it in the bookmark filter", () => {
    click(chip("go"));
    expect(app.useBookmarksStore.getState().selectedTags).toEqual(["go"]);
    expect(chip("go").getAttribute("aria-pressed")).toBe("true");
  });

  test("a selected tag deleted on another device drops out of the bookmark filter", () => {
    click(chip("go"));
    click(chip("design"));
    expect(app.useBookmarksStore.getState().selectedTags).toEqual(["go", "design"]);

    act(() => {
      app.useWorkspaceStore.setState({ tags: [makeTag("frontend", "Frontend"), makeTag("design", "Design")] });
    });

    expect(app.useBookmarksStore.getState().selectedTags).toEqual(["design"]);
  });

  test("search narrows the tags, highlights the match and leaves the filter alone", () => {
    click(getBySelector('[aria-label="sidebar_searchTags"]'));
    const input = getBySelector<HTMLInputElement>('input[aria-label="sidebar_searchTags"]');
    typeInto(input, "DES");

    expect(document.querySelector('[data-tag-id="frontend"]')).toBeNull();
    expect(chip("design").querySelector("mark")?.textContent).toBe("Des");

    pressKey(input, "Escape");

    expect(document.querySelectorAll("[data-tag-id]").length).toBe(3);
    expect(app.useBookmarksStore.getState().selectedTags).toEqual([]);
  });

  test("selected_descendant_expands_ancestors", async () => {
    act(() => {
      app.useWorkspaceStore.setState({
        tags: [
          makeTag("frontend", "Frontend"),
          makeTag("go", "Go", { parentId: "frontend" }),
          makeTag("design", "Design"),
        ],
      });
    });
    // Roots start collapsed, so "go" is not in the document initially
    expect(document.querySelector('[data-tag-id="go"]')).toBeNull();
    act(() => {
      app.useBookmarksStore.getState().toggleTag("go");
    });
    expect(getBySelector('[data-tag-id="go"]').getAttribute("aria-pressed")).toBe("true");
    expect(app.useBookmarksStore.getState().selectedTags).toEqual(["go"]);
  });

  test("manual expansion survives unmount/remount", async () => {
    act(() => {
      app.useWorkspaceStore.setState({
        tags: [
          makeTag("frontend", "Frontend"),
          makeTag("go", "Go", { parentId: "frontend" }),
        ],
      });
    });
    expect(document.querySelector('[data-tag-id="go"]')).toBeNull();
    click(getBySelector('[aria-label="tagTree_expandTag[Frontend]"]'));
    expect(getBySelector('[data-tag-id="go"]')).toBeTruthy();

    view?.unmount();
    view = render(app, createElement(SidebarProvider, null, createElement(SidebarTagsSection)));
    click(getByText("sidebar_tags"));
    await act(async () => { await Promise.resolve(); });
    expect(getBySelector('[data-tag-id="go"]')).toBeTruthy();
  });

  test("expansion arrow clicks never toggle selection", () => {
    act(() => {
      app.useWorkspaceStore.setState({
        tags: [
          makeTag("frontend", "Frontend"),
          makeTag("go", "Go", { parentId: "frontend" }),
        ],
      });
    });
    click(getBySelector('[aria-label="tagTree_expandTag[Frontend]"]'));
    expect(app.useBookmarksStore.getState().selectedTags).toEqual([]);
  });

  test("search displays matching nested tags and ancestors, expanding their path, and Esc leaves selection unchanged", () => {
    act(() => {
      app.useWorkspaceStore.setState({
        tags: [
          makeTag("frontend", "Frontend"),
          makeTag("go", "Go", { parentId: "frontend" }),
          makeTag("design", "Design"),
        ],
      });
    });
    expect(document.querySelector('[data-tag-id="go"]')).toBeNull();
    click(getBySelector('[aria-label="sidebar_searchTags"]'));
    const input = getBySelector<HTMLInputElement>('input[aria-label="sidebar_searchTags"]');
    typeInto(input, "go");

    expect(document.querySelector('[data-tag-id="design"]')).toBeNull();
    expect(getBySelector('[data-tag-id="frontend"]')).toBeTruthy();
    expect(getBySelector('[data-tag-id="go"]')).toBeTruthy();
    expect(getBySelector('[data-tag-id="go"]').querySelector("mark")?.textContent).toBe("Go");

    pressKey(input, "Escape");
    expect(app.useBookmarksStore.getState().selectedTags).toEqual([]);
  });

  test("missing stale expansion IDs are harmless", async () => {
    await db.module.idbPut("kv", { key: "tag-tree-expanded", value: ["stale-1", "frontend"] });
    act(() => {
      app.useWorkspaceStore.setState({
        tags: [
          makeTag("frontend", "Frontend"),
          makeTag("go", "Go", { parentId: "frontend" }),
        ],
      });
    });
    view?.unmount();
    view = render(app, createElement(SidebarProvider, null, createElement(SidebarTagsSection)));
    click(getByText("sidebar_tags"));
    await act(async () => { await Promise.resolve(); });
    expect(getBySelector('[data-tag-id="go"]')).toBeTruthy();
  });

  test("a late IDB read cannot overwrite a click made during hydration and persists merged tags", async () => {
    let resolveRead: ((value: { key: string; value: string[] }) => void) | undefined;
    const pendingRead = new Promise<{ key: string; value: string[] }>((resolve) => { resolveRead = resolve; });
    db.state.onGet = (store: string, key: string) => {
      if (store === "kv" && key === "tag-tree-expanded") {
        return pendingRead;
      }
      return undefined;
    };

    act(() => {
      app.useWorkspaceStore.setState({
        tags: [
          makeTag("frontend", "Frontend"),
          makeTag("go", "Go", { parentId: "frontend" }),
        ],
      });
    });
    view?.unmount();
    view = render(app, createElement(SidebarProvider, null, createElement(SidebarTagsSection)));
    click(getByText("sidebar_tags"));

    // User clicks expand before IDB resolves
    click(getBySelector('[aria-label="tagTree_expandTag[Frontend]"]'));
    expect(getBySelector('[data-tag-id="go"]')).toBeTruthy();

    // Now IDB resolves with pre-existing persisted tags ["a", "b"]
    await act(async () => {
      resolveRead?.({ key: "tag-tree-expanded", value: ["a", "b"] });
      await Promise.resolve();
    });

    // User's click should not have been overwritten
    expect(getBySelector('[data-tag-id="go"]')).toBeTruthy();

    // The final persisted value in kv must contain "a", "b" and "frontend"
    db.state.onGet = undefined;
    const record = await db.module.idbGet<{ key: string; value: string[] }>("kv", "tag-tree-expanded");
    expect(record?.value).toEqual(expect.arrayContaining(["a", "b", "frontend"]));
  });
});
