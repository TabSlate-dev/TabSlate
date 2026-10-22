// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, pressKey, render, setupDom, teardownDom, typeInto, type AppModules, type RenderResult } from "./helpers/dom-environment";
import type { TagActionResult } from "@/lib/tag-mutations";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeTag, makeWorkspace } from "./helpers/library-fixtures";

import { createTagIdb } from "./helpers/tag-idb";

const db = createTagIdb();
const replacer = createModuleReplacer();
let app: AppModules;
let BulkActionBar: typeof import("@/components/dashboard/bulk-actions").BulkActionBar;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let usePlanStore: typeof import("@/store/plan-store").usePlanStore;
let view: RenderResult | null = null;

const library = [
  makeBookmark("a", { collectionId: "reading", tags: ["frontend", "design"] }),
  makeBookmark("b", { collectionId: "reading", tags: ["frontend"] }),
];

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  await replacer.replace("@/lib/idb", { ...await import("@/lib/idb"), ...db.module });
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ usePlanStore } = await import("@/store/plan-store"));
  ({ SelectionOrdersProvider } = await import("@/components/dashboard/shared/selection-orders"));
  ({ BulkActionBar } = await importFresh<typeof import("@/components/dashboard/bulk-actions")>("components/dashboard/bulk-actions/index.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(async () => {
  view?.unmount();
  app.useWorkspaceStore.getState().reset();
  usePlanStore.setState({ limits: null, usage: null, fetchedAt: Date.now(), quotaAlert: null });
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
    tags: [makeTag("frontend", "Frontend"), makeTag("design", "Design"), makeTag("docs", "Docs")],
  });
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(library), countsByCollection: countsByCollection(library) });
  act(() => {
    useSelectionStore.getState().clear();
    useSelectionStore.getState().setMany(["a", "b"], true);
  });
  db.seed(app.useWorkspaceStore.getState().tags);
  view = render(app, createElement(MemoryRouter, null, createElement(SelectionOrdersProvider, {
    viewOrder: ["a", "b"],
    onScreenOrder: ["a", "b"],
    children: createElement(BulkActionBar),
  })));
  await act(async () => { click(getByText("bulkActions_tags")); });
});

const row = (name: string) => getByText(name).closest('[role="option"]');
const tagsOf = (id: string) => app.useBookmarksStore.getState().bookmarks.get(id)?.tags;

describe("bulk Tags menu", () => {
  test("cancel discards pending edits and reopening recomputes the selection", async () => {
    click(getByText("Docs"));
    click(getByText("settings_cancel"));
    expect(tagsOf("a")).toEqual(["frontend", "design"]);
    expect(tagsOf("b")).toEqual(["frontend"]);
    await act(async () => { click(getByText("bulkActions_tags")); });
    expect(row("Docs")?.getAttribute("aria-checked")).toBe("false");
    expect(getByText("bulkTags_apply").closest("button")?.disabled).toBe(true);
  });

  test("rows show checked, mixed and empty states from the selection", () => {
    expect(row("Frontend")?.getAttribute("aria-checked")).toBe("true");
    expect(row("Design")?.getAttribute("aria-checked")).toBe("mixed");
    expect(row("Docs")?.getAttribute("aria-checked")).toBe("false");
  });

  test("clicked rows apply to the whole selection in one update, and the selection stays", () => {
    click(getByText("Design"));
    click(getByText("Frontend"));
    expect(row("Design")?.getAttribute("aria-checked")).toBe("true");
    expect(row("Frontend")?.getAttribute("aria-checked")).toBe("false");

    let published = 0;
    const unsubscribe = app.useBookmarksStore.subscribe(() => { published += 1; });
    try {
      click(getByText("bulkTags_apply"));
      expect(published).toBe(1);
    } finally {
      unsubscribe();
    }

    expect(tagsOf("a")).toEqual(["design"]);
    expect(tagsOf("b")).toEqual(["design"]);
    expect([...useSelectionStore.getState().selectedIds].sort()).toEqual(["a", "b"]);
  });

  test("untouched rows keep each bookmark's tags", () => {
    click(getByText("Docs"));
    click(getByText("bulkTags_apply"));
    expect(tagsOf("a")).toEqual(["frontend", "design", "docs"]);
    expect(tagsOf("b")).toEqual(["frontend", "docs"]);
  });

  test("a new tag is created and checked for the whole selection", async () => {
    typeInto(getBySelector<HTMLInputElement>('[role="combobox"]'), "Reading");
    await act(async () => { pressKey(getBySelector('[role="combobox"]'), "Enter"); });
    const created = app.useWorkspaceStore.getState().tags.find((tag) => tag.name === "Reading");
    expect(created).toBeDefined();

    click(getByText("bulkTags_apply"));

    expect(tagsOf("a")).toContain(created?.id);
    expect(tagsOf("b")).toContain(created?.id);
  });

  test("a tag the quota blocks is not added", async () => {
    usePlanStore.setState({
      limits: { max_bookmarks: 100, max_collections: 100, max_tags: 3, max_workspaces: 10, max_saved_groups: 100, trash_grace_days: 30 },
      usage: { bookmarks: 2, collections: 1, tags: 3, workspaces: 1, saved_groups: 0 },
      fetchedAt: Date.now(),
    });
    typeInto(getBySelector<HTMLInputElement>('[role="combobox"]'), "Reading");
    await act(async () => { pressKey(getBySelector('[role="combobox"]'), "Enter"); });

    expect(app.useWorkspaceStore.getState().tags).toHaveLength(3);
    expect(usePlanStore.getState().quotaAlert).not.toBeNull();
    expect(getByText("bulkTags_apply").closest("button")?.disabled).toBe(true);
  });
  test("closing_during_tag_creation_discards_its_late_selection_change", async () => {
    const original = app.useWorkspaceStore.getState().createTagPath;
    let resolve: ((result: TagActionResult) => void) | undefined;
    const result = new Promise<TagActionResult>(done => { resolve = done; });
    act(() => { app.useWorkspaceStore.setState({ createTagPath: () => result }); });
    try {
      typeInto(getBySelector<HTMLInputElement>('[role="combobox"]'), "Reading");
      pressKey(getBySelector('[role="combobox"]'), "Enter");
      click(getByText("settings_cancel"));
      await act(async () => {
        const tags = [...app.useWorkspaceStore.getState().tags, makeTag("reading", "Reading")];
        db.seed(tags); app.useWorkspaceStore.setState({ tags });
        resolve?.({ ok: true, tagId: "reading" });
      });
      await act(async () => { click(getByText("bulkActions_tags")); });
      expect(row("Reading")?.getAttribute("aria-checked")).toBe("false");
      expect(getByText("bulkTags_apply").closest("button")?.disabled).toBe(true);
    } finally { act(() => { app.useWorkspaceStore.setState({ createTagPath: original }); }); }
  });

  test("bulk idle rows use an indented pre-order tree and filtered rows retain path context", async () => {
    click(getByText("settings_cancel"));
    const treeTags = [
      makeTag("backend", "Backend"),
      makeTag("go", "Go", { parentId: "backend" }),
      makeTag("design", "Design"),
    ];
    app.useWorkspaceStore.setState({ tags: treeTags });
    db.seed(treeTags);
    await act(async () => { click(getByText("bulkActions_tags")); });

    // Idle rows: pre-order indented
    const idleOptions = Array.from(document.querySelectorAll('[role="option"]')).map(el => el.textContent?.trim());
    expect(idleOptions).toEqual(["Backend", "Go", "Design"]);
    const goRow = row("Go");
    const goIndentContainer = goRow?.querySelector('[style*="padding-left"]') ?? goRow;
    expect(goIndentContainer?.getAttribute("style")?.includes("padding-left")).toBe(true);

    // Filtered rows: retain path context
    typeInto(getBySelector<HTMLInputElement>('[role="combobox"]'), "Go");
    const filteredOptions = Array.from(document.querySelectorAll('[role="option"]')).map(el => el.textContent?.trim());
    expect(filteredOptions).toEqual(["Backend › Go"]);
  });

  test("checking a parent in the bulk menu adds only its ID", async () => {
    click(getByText("settings_cancel"));
    const treeTags = [
      makeTag("backend", "Backend"),
      makeTag("go", "Go", { parentId: "backend" }),
    ];
    app.useWorkspaceStore.setState({ tags: treeTags });
    db.seed(treeTags);
    const emptyBookmarks = [
      makeBookmark("a", { collectionId: "reading", tags: [] }),
      makeBookmark("b", { collectionId: "reading", tags: [] }),
    ];
    app.useBookmarksStore.setState({
      bookmarks: bookmarkMap(emptyBookmarks),
      countsByCollection: countsByCollection(emptyBookmarks),
    });
    useSelectionStore.getState().setMany(["a", "b"], true);
    await act(async () => { click(getByText("bulkActions_tags")); });

    click(getByText("Backend"));
    click(getByText("bulkTags_apply"));

    expect(tagsOf("a")).toEqual(["backend"]);
    expect(tagsOf("b")).toEqual(["backend"]);
  });

  test("creates nested paths from top level and checks only the returned leaf", async () => {
    click(getByText("settings_cancel"));
    const treeTags = [
      makeTag("backend", "Backend"),
    ];
    app.useWorkspaceStore.setState({ tags: treeTags });
    db.seed(treeTags);
    await act(async () => { click(getByText("bulkActions_tags")); });

    typeInto(getBySelector<HTMLInputElement>('[role="combobox"]'), "Backend/Rust");
    await act(async () => { pressKey(getBySelector('[role="combobox"]'), "Enter"); });

    const rustTag = app.useWorkspaceStore.getState().tags.find(t => t.name === "Rust");
    expect(rustTag).toBeDefined();

    click(getByText("bulkTags_apply"));
    expect(tagsOf("a")).toContain(rustTag?.id);
    expect(tagsOf("b")).toContain(rustTag?.id);
  });
});
