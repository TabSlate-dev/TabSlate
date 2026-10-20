// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import type { OpenBookmarkDialogRequest } from "@/lib/bookmark-dialog-events";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  render,
  setupDom,
  submitForm,
  teardownDom,
  typeInto,
  wait,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let BookmarkDialog: typeof import("@/components/dashboard/shared/bookmark-dialog").BookmarkDialog;
let openBookmarkDialog: typeof import("@/lib/bookmark-dialog-events").openBookmarkDialog;
let view: RenderResult | null = null;

const saved = makeBookmark("saved", { collectionId: "projects", url: "https://example.com/post" });
const twin = makeBookmark("twin", { collectionId: "reading", url: "https://example.com/twin" });

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ openBookmarkDialog } = await import("@/lib/bookmark-dialog-events"));
  ({ BookmarkDialog } = await importFresh<typeof import("@/components/dashboard/shared/bookmark-dialog")>("components/dashboard/shared/bookmark-dialog.tsx"));
});
afterAll(async () => {
  view?.unmount();
  act(() => app.useBookmarksStore.getState().setHighlightedBookmarkId(null));
  replacer.restore();
  await teardownDom();
});

beforeEach(() => {
  view?.unmount();
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home", { name: "Home" }), makeWorkspace("work", { name: "Work" })],
    collections: [
      makeCollection("reading", "home", { name: "Reading", isDefault: true }),
      makeCollection("projects", "work", { name: "Projects", isDefault: true }),
    ],
    tags: [],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap([saved, twin]),
    countsByCollection: countsByCollection([saved, twin]),
    highlightedBookmarkId: null,
  });
  view = render(app, createElement(MemoryRouter, null, createElement(BookmarkDialog)));
  open();
});

function open(request?: OpenBookmarkDialogRequest): void {
  act(() => {
    openBookmarkDialog(request);
  });
}
const urlField = () => getBySelector<HTMLInputElement>('[role="dialog"] [name="url"]');
const notice = () => document.querySelector('[data-slot="duplicate-notice"]');
const dialogOpen = () => document.querySelector('[role="dialog"]') !== null;

describe("duplicate notice in the bookmark form", () => {
  test("warns about a saved variant of the address and shows where it lives", async () => {
    typeInto(urlField(), "http://www.example.com/post?utm_source=feed");
    await wait(350);
    expect(notice()?.textContent).toContain("duplicateNotice_location[Projects,Work]");
  });

  test("open existing bookmark closes the dialog and reveals the bookmark", async () => {
    typeInto(urlField(), "example.com/post");
    await wait(350);
    click(getByText("duplicateNotice_openExisting"));

    expect(dialogOpen()).toBe(false);
    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("work");
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBe("saved");
  });

  test("reopening uses the latest saved bookmarks and locations", async () => {
    click(getByText("settings_cancel"));
    const latest = makeBookmark("latest", { collectionId: "projects", url: "https://example.com/latest" });
    act(() => {
      app.useBookmarksStore.setState({ bookmarks: bookmarkMap([latest]) });
      app.useWorkspaceStore.setState({
        workspaces: [makeWorkspace("home", { name: "Home" }), makeWorkspace("work", { name: "Updated work" })],
        collections: [
          makeCollection("reading", "home", { name: "Reading", isDefault: true }),
          makeCollection("projects", "work", { name: "Updated projects", isDefault: true }),
        ],
      });
    });
    open();
    expect(urlField().value).toBe("");
    typeInto(urlField(), "example.com/latest");
    await wait(350);
    expect(notice()?.textContent).toContain("duplicateNotice_location[Updated projects,Updated work]");
  });

  test("stays quiet for an address that is not saved", async () => {
    typeInto(urlField(), "https://example.com/other");
    await wait(350);
    expect(notice()).toBeNull();
    expect(dialogOpen()).toBe(true);
  });

  test("a duplicate notice never blocks saving", async () => {
    typeInto(getBySelector<HTMLInputElement>('[role="dialog"] [name="title"]'), "Again");
    typeInto(urlField(), "example.com/post");
    await wait(350);
    expect(notice()).not.toBeNull();
    await submitForm(getBySelector<HTMLFormElement>('[role="dialog"] form'));
    expect(app.useBookmarksStore.getState().bookmarks.size).toBe(3);
  });

  test("edit mode checks only after the address changes and never matches the bookmark itself", async () => {
    click(getByText("settings_cancel"));
    open({ bookmarkId: "saved" });
    await wait(350);
    expect(notice()).toBeNull();

    typeInto(urlField(), "https://example.com/twin");
    await wait(350);
    expect(notice()?.textContent).toContain("duplicateNotice_location[Reading,Home]");

    typeInto(urlField(), "https://example.com/post");
    await wait(350);
    expect(notice()).toBeNull();
  });
});
