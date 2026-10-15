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

const replacer = createModuleReplacer();
let app: AppModules;
let SidebarProvider: typeof import("@/components/ui/sidebar").SidebarProvider;
let SidebarTagsSection: typeof import("@/components/dashboard/sidebar/tags-section").SidebarTagsSection;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
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
});
