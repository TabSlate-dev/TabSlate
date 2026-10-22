// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createModuleReplacer } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  render,
  rightClick,
  setupDom,
  submitForm,
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
  app.useWorkspaceStore.getState().reset();
  db.state.fail = false;
  const bookmarks = [
    makeBookmark("b1", { collectionId: "reading", tags: ["frontend"] }),
    makeBookmark("b2", { collectionId: "reading", tags: ["frontend"] }),
    makeBookmark("b3", { collectionId: "", tags: ["frontend"] }),
    makeBookmark("b4", { collectionId: "projects", tags: ["frontend"] }),
  ];
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home"), makeWorkspace("work")],
    collections: [makeCollection("reading", "home", { isDefault: true }), makeCollection("projects", "work")],
    tags: [makeTag("frontend", "Frontend"), makeTag("go", "Go")],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedTags: [],
  });
  db.seed(app.useWorkspaceStore.getState().tags);
  view = render(app, createElement(SidebarProvider, null, createElement(SidebarTagsSection)));
  click(getByText("sidebar_tags"));
});

const chip = (tagId: string) => getBySelector(`[data-tag-id="${tagId}"]`);
const tag = (tagId: string) => app.useWorkspaceStore.getState().tags.find((candidate) => candidate.id === tagId);

async function openTagMenu(tagId: string): Promise<void> {
  await act(async () => {
    rightClick(chip(tagId));
  });
}

describe("tag context menu", () => {
  test("right-clicking a tag offers rename, color and delete", async () => {
    await openTagMenu("frontend");
    expect(getByText("tagMenu_rename")).toBeTruthy();
    expect(getByText("tagMenu_color")).toBeTruthy();
    expect(getByText("tagMenu_delete")).toBeTruthy();
  });

  test("rename saves the new name", async () => {
    await openTagMenu("frontend");
    click(getByText("tagMenu_rename"));
    const input = getBySelector<HTMLInputElement>("#tag-name");
    expect(input.value).toBe("Frontend");

    typeInto(input, "Web");
    const form = input.closest("form");
    if (!form) {
      throw new Error("tag dialog has no form");
    }
    await submitForm(form);

    expect(tag("frontend")?.name).toBe("Web");
  });

  test("choosing a color recolors the tag after commit", async () => {
    await openTagMenu("frontend");
    click(getByText("tagMenu_color"));
    await act(async () => { click(getByText("tagDialog_colorOption[2]")); });

    expect(tag("frontend")?.color).toBe("bg-emerald-500/10 text-emerald-500");
  });

  test("delete asks first and names how many bookmarks in all workspaces lose the tag", async () => {
    await openTagMenu("frontend");
    click(getByText("tagMenu_delete"));
    expect(getByText("tagDeleteDialog_desc_other[4]")).toBeTruthy();
    expect(tag("frontend")?.name).toBe("Frontend");

    await act(async () => { click(getByText("tagDeleteDialog_confirm")); });

    expect(tag("frontend")).toBeUndefined();
  });

  test("delete names a single bookmark in the singular", async () => {
    act(() => {
      app.useBookmarksStore.setState({ bookmarks: bookmarkMap([makeBookmark("b5", { collectionId: "reading", tags: ["go"] })]) });
    });
    await openTagMenu("go");
    click(getByText("tagMenu_delete"));

    expect(getByText("tagDeleteDialog_desc_one[1]")).toBeTruthy();
    click(getByText("settings_cancel"));
  });

  test("deleting a selected tag also takes it out of the bookmark filter", async () => {
    act(() => {
      app.useBookmarksStore.setState({ selectedTags: ["frontend", "go"] });
    });
    await openTagMenu("frontend");
    click(getByText("tagMenu_delete"));
    await act(async () => { click(getByText("tagDeleteDialog_confirm")); });

    expect(tag("frontend")).toBeUndefined();
    expect(app.useBookmarksStore.getState().selectedTags).toEqual(["go"]);
  });

  test("cancel leaves the tag available", async () => {
    await openTagMenu("frontend");
    click(getByText("tagMenu_delete"));
    click(getByText("settings_cancel"));

    expect(tag("frontend")?.name).toBe("Frontend");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("confirmation after a remote delete does not decrement tag usage again", async () => {
    const { usePlanStore } = await import("@/store/plan-store");
    usePlanStore.setState({ usage: { workspaces: 2, bookmarks: 4, collections: 2, saved_groups: 0, tags: 2 } });
    await openTagMenu("frontend");
    click(getByText("tagMenu_delete"));
    act(() => {
      app.useWorkspaceStore.setState({ tags: [makeTag("go", "Go")] });
    });
    await act(async () => { click(getByText("tagDeleteDialog_confirm")); });

    expect(usePlanStore.getState().usage?.tags).toBe(2);
    expect(tag("go")?.name).toBe("Go");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  test("failed_color_save_keeps_translated_feedback_after_menu_closes", async () => {
    db.state.fail = true;
    await openTagMenu("frontend"); click(getByText("tagMenu_color"));
    await act(async () => { click(getByText("tagDialog_colorOption[2]")); });
    expect(tag("frontend")?.color).toBe("bg-blue-500/10 text-blue-500");
    expect(getByText("tagAction_errorStorage").closest('[role="alert"]')).toBeTruthy();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

});
