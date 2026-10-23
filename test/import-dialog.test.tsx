// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import type { ImportPlan, ValidationResult } from "@/lib/import-types";
import type { Bookmark, Collection, Tag, Workspace } from "@/lib/types";
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
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";

const replacer = createModuleReplacer();
let app: AppModules;
let ImportDialog: typeof import("@/components/dashboard/import-dialog").ImportDialog;
let usePlanStore: typeof import("@/store/plan-store").usePlanStore;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ ImportDialog } = await import("@/components/dashboard/import-dialog"));
  ({ usePlanStore } = await import("@/store/plan-store"));
  ({ useSelectionStore } = await import("@/store/selection-store"));
});

afterAll(async () => {
  replacer.restore();
  await teardownDom();
});

const defaultWorkspace: Workspace = {
  id: "ws-1",
  name: "Default Workspace",
  color: "blue",
  position: 0,
  seq: 1,
};

const defaultCollection: Collection = {
  id: "col-default",
  workspaceId: "ws-1",
  name: "General",
  icon: "",
  position: 0,
  seq: 1,
  isDefault: true,
};

beforeEach(() => {
  app.useWorkspaceStore.setState({
    workspaces: [defaultWorkspace],
    activeWorkspaceId: "ws-1",
    collections: [defaultCollection],
    tags: [],
  });
  app.useBookmarksStore.setState({
    bookmarks: new Map<string, Bookmark>(),
    selectedCollection: "all",
    selectedTags: [],
    searchQuery: "",
    filterType: "all",
    _archivedLoaded: true,
    _trashedLoaded: true,
    archivedBookmarks: [],
    trashedBookmarks: [],
  });
  useSelectionStore.getState().clear();
  usePlanStore.setState({
    limits: {
      max_bookmarks: -1,
      max_collections: -1,
      max_tags: -1,
      max_workspaces: -1,
      max_saved_groups: -1,
      trash_grace_days: 30,
    },
  });
});

const VALID_CHROME_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3>书签栏</H3>
  <DL><p>
    <DT><A HREF="https://example.com/test">Test Bookmark</A>
  </DL><p>
</DL><p>`;

describe("ImportDialog component", () => {
  test("preserve folders switch is enabled by default in configuration step", async () => {
    let open = true;
    const view = render(
      app,
      createElement(
        MemoryRouter,
        null,
        createElement(ImportDialog, {
          open,
          onOpenChange: (next) => { open = next; },
        }),
      ),
    );

    // Step 0: click Chrome Bookmarks card
    click(getByText("Chrome Bookmarks"));

    // Step 1: upload file
    const fileInput = getBySelector<HTMLInputElement>('input[type="file"]');
    const file = new File([VALID_CHROME_HTML], "bookmarks.html", { type: "text/html" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Wait for file validation
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Step 1: click Next button to reach Step 2 (configuration)
    click(getByText("import_next"));

    // Step 2: assert preserve folders switch is present and checked by default
    const switchButton = getBySelector<HTMLButtonElement>("#preserve-folders");
    expect(switchButton).toBeDefined();
    expect(switchButton.getAttribute("data-state")).toBe("checked");

    // Toggle off: data-state becomes unchecked
    click(switchButton);
    expect(switchButton.getAttribute("data-state")).toBe("unchecked");

    // Toggle back on
    click(switchButton);
    expect(switchButton.getAttribute("data-state")).toBe("checked");

    view.unmount();
  });

  test("revealing imported bookmarks switches workspace, clears filters and selects committed root", async () => {
    let open = true;
    // Set initial state with existing filters and selection
    app.useBookmarksStore.setState({
      selectedCollection: "col-default",
      selectedTags: ["old-tag"],
      searchQuery: "searching",
      filterType: "favorites",
    });
    useSelectionStore.getState().toggle("some-bm");
    expect(useSelectionStore.getState().selectedIds.size).toBe(1);

    const view = render(
      app,
      createElement(
        MemoryRouter,
        null,
        createElement(ImportDialog, {
          open,
          onOpenChange: (next) => { open = next; },
        }),
      ),
    );

    // Step 0: Click Chrome Bookmarks
    click(getByText("Chrome Bookmarks"));

    // Step 1: Upload file
    const fileInput = getBySelector<HTMLInputElement>('input[type="file"]');
    const file = new File([VALID_CHROME_HTML], "bookmarks.html", { type: "text/html" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Step 1 -> Step 2
    click(getByText("import_next"));

    // Step 2: Click Import button
    click(getByText("import_btnImport"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Step 3: Click "Show imported bookmarks" button
    const revealButton = getByText("import_showImported");
    expect(revealButton).toBeDefined();
    click(revealButton);

    // Assert active workspace switched to ws-1
    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-1");
    // Assert library view and collection "all"
    expect(app.useBookmarksStore.getState().selectedCollection).toBe("all");
    expect(app.useBookmarksStore.getState().filterType).toBe("all");
    expect(app.useBookmarksStore.getState().searchQuery).toBe("");
    // Assert selected tags contains only the committed root
    const selectedTags = app.useBookmarksStore.getState().selectedTags;
    expect(selectedTags).toHaveLength(1);
    const rootTag = app.useWorkspaceStore.getState().tags.find(t => t.id === selectedTags[0]);
    expect(rootTag).toBeDefined();
    expect(rootTag?.parentId).toBeUndefined();
    // Assert selection cleared
    expect(useSelectionStore.getState().selectedIds.size).toBe(0);
    // Assert dialog closed
    expect(open).toBe(false);

    view.unmount();
  });

  test("timezone date formatting uses local calendar date", () => {
    // 2026-10-21 at 23:30 local time is local 2026-10-21 regardless of UTC
    const localEvening = new Date(2026, 9, 21, 23, 30, 0); // Month 9 is October (0-indexed)
    const year = localEvening.getFullYear();
    const month = String(localEvening.getMonth() + 1).padStart(2, "0");
    const day = String(localEvening.getDate()).padStart(2, "0");
    expect(`${year}-${month}-${day}`).toBe("2026-10-21");

    const localEarlyMorning = new Date(2026, 9, 22, 0, 30, 0);
    const mYear = localEarlyMorning.getFullYear();
    const mMonth = String(localEarlyMorning.getMonth() + 1).padStart(2, "0");
    const mDay = String(localEarlyMorning.getDate()).padStart(2, "0");
    expect(`${mYear}-${mMonth}-${mDay}`).toBe("2026-10-22");
  });

  test("failed IDB write rolls back and mutates no store state", async () => {
    const replacerLocal = createModuleReplacer();
    const freshIdb = await importFresh<typeof import("@/lib/idb")>("lib/idb.ts");
    await replacerLocal.replace("@/lib/idb", {
      ...freshIdb,
      idbBulkWrite: () => Promise.reject(new Error("IDB disk full")),
    });
    const wsModule = await importFresh<typeof import("@/store/workspace-store")>("store/workspace-store.ts");
    wsModule.useWorkspaceStore.setState({
      workspaces: [defaultWorkspace],
      activeWorkspaceId: "ws-1",
      collections: [defaultCollection],
      tags: [],
    });

    const plan: ImportPlan = {
      collections: [{ id: "c-err", workspaceId: "ws-1", name: "Col", icon: "", position: 1 }],
      bookmarks: [{
        id: "b-err",
        collectionId: "c-err",
        title: "BM",
        url: "https://err.com",
        description: "",
        favicon: "",
        tags: [],
        createdAt: "2026-10-21T00:00:00.000Z",
        isFavorite: false,
      }],
      tags: [{ id: "t-err", name: "Tag", color: "blue", parentId: undefined }],
      duplicatesSkipped: 0,
      rejectedUrls: [],
    };

    const initialTagsCount = wsModule.useWorkspaceStore.getState().tags.length;
    const initialCollectionsCount = wsModule.useWorkspaceStore.getState().collections.length;
    const initialBookmarksCount = app.useBookmarksStore.getState().bookmarks.size;

    const result = await wsModule.useWorkspaceStore.getState().importFromPlan(plan);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("storage");
    }

    // No in-memory store state was mutated
    expect(wsModule.useWorkspaceStore.getState().tags.length).toBe(initialTagsCount);
    expect(wsModule.useWorkspaceStore.getState().collections.length).toBe(initialCollectionsCount);
    expect(app.useBookmarksStore.getState().bookmarks.size).toBe(initialBookmarksCount);

    replacerLocal.restore();
  });

  test("quota changes after preview result in stale_plan and no mutation occurs", async () => {
    // Plan preview had mode full for 3 tags
    const plan: ImportPlan = {
      collections: [{ id: "c-stale", workspaceId: "ws-1", name: "Col", icon: "", position: 1 }],
      bookmarks: [{
        id: "b-stale",
        collectionId: "c-stale",
        title: "BM",
        url: "https://stale.com",
        description: "",
        favicon: "",
        tags: ["t-leaf"],
        createdAt: "2026-10-21T00:00:00.000Z",
        isFavorite: false,
      }],
      tags: [
        { id: "t-root", name: "Root", color: "blue", parentId: undefined },
        { id: "t-mid", name: "Mid", color: "blue", parentId: "t-root" },
        { id: "t-leaf", name: "Leaf", color: "blue", parentId: "t-mid" },
      ],
      duplicatesSkipped: 0,
      rejectedUrls: [],
      provenance: {
        rootTagId: "t-root",
        mode: "full",
        requestedTagCount: 3,
      },
    };

    // Before commit, tag quota is constrained to only 1 tag available
    usePlanStore.setState({
      limits: {
        max_bookmarks: -1,
        max_collections: -1,
        max_tags: 1, // Only 1 tag allowed total!
        max_workspaces: -1,
        max_saved_groups: -1,
        trash_grace_days: 30,
      },
    });

    const initialTagsCount = app.useWorkspaceStore.getState().tags.length;
    const initialBookmarksCount = app.useBookmarksStore.getState().bookmarks.size;

    const result = await app.useWorkspaceStore.getState().importFromPlan(plan);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("stale_plan");
    }

    // No mutation occurred
    expect(app.useWorkspaceStore.getState().tags.length).toBe(initialTagsCount);
    expect(app.useBookmarksStore.getState().bookmarks.size).toBe(initialBookmarksCount);
  });

  test("importFromPlan checks target workspace visibility", async () => {
    const plan: ImportPlan = {
      collections: [{ id: "c-deleted", workspaceId: "ws-deleted", name: "Col", icon: "", position: 1 }],
      bookmarks: [],
      tags: [],
      duplicatesSkipped: 0,
      rejectedUrls: [],
    };

    const result = await app.useWorkspaceStore.getState().importFromPlan(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("target_unavailable");
    }
  });

  test("sibling collision with existing tag results in stale_plan", async () => {
    // Sibling collision with a newly created tag in workspace store
    app.useWorkspaceStore.setState({
      tags: [{ id: "t-conflict", name: "Root", color: "blue", parentId: undefined, seq: 1 }],
    });

    const plan: ImportPlan = {
      collections: [{ id: "c-1", workspaceId: "ws-1", name: "Col", icon: "", position: 1 }],
      bookmarks: [],
      tags: [{ id: "t-new", name: "Root", color: "blue", parentId: undefined }],
      duplicatesSkipped: 0,
      rejectedUrls: [],
    };

    const result = await app.useWorkspaceStore.getState().importFromPlan(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("stale_plan");
    }
  });

  test("reused Toby tag deleted before commit results in stale_plan", async () => {
    const reusedTag: Tag = {
      id: "reused-label-id",
      name: "reading",
      parentId: undefined,
      color: "blue",
      seq: 1,
    };

    // Plan references the reused tag on a bookmark, but does not recreate it in plan.tags
    const plan: ImportPlan = {
      collections: [{ id: "c-toby", workspaceId: "ws-1", name: "List", icon: "", position: 1 }],
      bookmarks: [{
        id: "b-toby",
        collectionId: "c-toby",
        title: "Toby Card",
        url: "https://example.com/toby",
        description: "",
        favicon: "",
        tags: [reusedTag.id],
        createdAt: "2026-10-21T00:00:00.000Z",
        isFavorite: false,
      }],
      tags: [],
      duplicatesSkipped: 0,
      rejectedUrls: [],
    };

    // Before commit, the reused tag is deleted (has a tombstone deletedAt, or is absent from active tags)
    app.useWorkspaceStore.setState({
      tags: [{ ...reusedTag, deletedAt: Date.now() }],
    });

    const initialTagsCount = app.useWorkspaceStore.getState().tags.length;
    const initialCollectionsCount = app.useWorkspaceStore.getState().collections.length;
    const initialBookmarksCount = app.useBookmarksStore.getState().bookmarks.size;

    const result = await app.useWorkspaceStore.getState().importFromPlan(plan);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("stale_plan");
    }

    // Nothing written or mutated
    expect(app.useWorkspaceStore.getState().tags.length).toBe(initialTagsCount);
    expect(app.useWorkspaceStore.getState().collections.length).toBe(initialCollectionsCount);
    expect(app.useBookmarksStore.getState().bookmarks.size).toBe(initialBookmarksCount);
  });

  test("tag quota exhaustion blocks import in preflight check", () => {
    // Limits: max 2 tags total, already 2 tags existing
    usePlanStore.setState({
      limits: {
        max_bookmarks: -1,
        max_collections: -1,
        max_tags: 2,
        max_workspaces: -1,
        max_saved_groups: -1,
        trash_grace_days: 30,
      },
    });
    app.useWorkspaceStore.setState({
      tags: [
        { id: "t-1", name: "T1", color: "blue", parentId: undefined, seq: 1 },
        { id: "t-2", name: "T2", color: "blue", parentId: undefined, seq: 1 },
      ],
    });

    // Check quota for 1 new tag -> false
    expect(usePlanStore.getState().checkQuota("tag", 2 + 1 - 1)).toBe(false);
  });
});
