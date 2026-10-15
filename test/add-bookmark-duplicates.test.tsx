// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  queryByText,
  render,
  setupDom,
  teardownDom,
  typeInto,
  wait,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let AddBookmarkDialog: typeof import("@/components/dashboard/add-bookmark-dialog").AddBookmarkDialog;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ AddBookmarkDialog } = await importFresh<typeof import("@/components/dashboard/add-bookmark-dialog")>(
    "components/dashboard/add-bookmark-dialog.tsx",
  ));
});

afterAll(async () => {
  view?.unmount();
  act(() => app.useBookmarksStore.getState().setHighlightedBookmarkId(null));
  replacer.restore();
  await teardownDom();
});

function Host() {
  const [open, setOpen] = useState(true);
  return createElement(
    "div",
    null,
    createElement(AddBookmarkDialog, { open, onOpenChange: setOpen }),
    !open && createElement("button", { onClick: () => setOpen(true) }, "closed"),
  );
}

beforeEach(() => {
  view?.unmount();
  const saved = makeBookmark("saved", { collectionId: "projects", url: "https://example.com/post" });
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
    bookmarks: bookmarkMap([saved]),
    countsByCollection: countsByCollection([saved]),
    highlightedBookmarkId: null,
  });
  view = render(app, createElement(MemoryRouter, null, createElement(Host)));
});

describe("add bookmark duplicate notice", () => {
  test("warns about a saved variant of the address and shows where it lives", async () => {
    typeInto(getBySelector<HTMLInputElement>("#bm-url"), "http://www.example.com/post?utm_source=feed");
    await wait(350);

    const notice = getBySelector('[data-slot="duplicate-notice"]');
    expect(notice.textContent).toContain("duplicateNotice_location[Projects,Work]");
  });

  test("open existing bookmark closes the dialog and reveals the bookmark", async () => {
    typeInto(getBySelector<HTMLInputElement>("#bm-url"), "example.com/post");
    await wait(350);
    click(getByText("duplicateNotice_openExisting"));

    expect(getByText("closed")).toBeTruthy();
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
    click(getByText("closed"));
    expect(getBySelector<HTMLInputElement>("#bm-url").value).toBe("");
    typeInto(getBySelector<HTMLInputElement>("#bm-url"), "example.com/latest");
    await wait(350);

    expect(getBySelector('[data-slot="duplicate-notice"]').textContent).toContain(
      "duplicateNotice_location[Updated projects,Updated work]",
    );
  });

  test("stays quiet for an address that is not saved", async () => {
    typeInto(getBySelector<HTMLInputElement>("#bm-url"), "https://example.com/other");
    await wait(350);

    expect(document.querySelector('[data-slot="duplicate-notice"]')).toBeNull();
    expect(queryByText("closed")).toBeNull();
  });
});
