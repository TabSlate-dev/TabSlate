// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installAppModules, setupDom, teardownDom } from "./helpers/dom-environment";
import { createModuleReplacer } from "./helpers/module-replacer";
import { act, createElement, Profiler } from "react";

const replacer = createModuleReplacer();
let createRoot: typeof import("react-dom/client").createRoot;
let useBookmarksStore: typeof import("../store/bookmarks-store").useBookmarksStore;
let SidebarProvider: typeof import("../components/ui/sidebar").SidebarProvider;
let BookmarksHeader: typeof import("../components/dashboard/header").BookmarksHeader;

// Bun runs afterAll even when beforeAll fails part-way, so a broken setup
// cannot leave the DOM globals or module replacements behind for later files.
afterAll(async () => {
  replacer.restore();
  await teardownDom();
});

beforeAll(async () => {
  // react-dom/client checks for a DOM when it is first imported.
  setupDom();
  const app = await installAppModules(replacer);
  createRoot = app.createRoot;
  useBookmarksStore = app.useBookmarksStore;
  ({ SidebarProvider } = await import("../components/ui/sidebar"));
  ({ BookmarksHeader } = await import("../components/dashboard/header"));
});

function renderHeader() {
  let commits = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      createElement(
        SidebarProvider,
        null,
        createElement(
          Profiler,
          { id: "bookmarks-header", onRender: () => { commits += 1; } },
          createElement(BookmarksHeader),
        ),
      ),
    );
  });

  return {
    container,
    getCommits: () => commits,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("BookmarksHeader store subscription", () => {
  test("does not re-render when bookmark data changes", () => {
    const header = renderHeader();
    const commitsAfterMount = header.getCommits();

    act(() => {
      useBookmarksStore.setState({ bookmarks: new Map() });
    });

    expect(header.getCommits()).toBe(commitsAfterMount);
    header.unmount();
  });

  test("highlights the list toggle after switching to list view", () => {
    act(() => {
      useBookmarksStore.getState().setViewMode("grid");
    });
    const header = renderHeader();

    act(() => {
      useBookmarksStore.getState().setViewMode("list");
    });

    const [gridButton, listButton] = Array.from(header.container.querySelectorAll(".border.rounded-md button"));
    expect(listButton.className).toContain("bg-muted");
    expect(gridButton.className).not.toContain("bg-muted");
    header.unmount();
  });
});
