// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import type { OpenBookmarkDialogRequest } from "@/lib/bookmark-dialog-events";
import type { Bookmark } from "@/lib/types";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  pressKey,
  queryByText,
  render,
  setupDom,
  submitForm,
  teardownDom,
  typeInto,
  wait,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeTag, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let BookmarkDialog: typeof import("@/components/dashboard/shared/bookmark-dialog").BookmarkDialog;
let openBookmarkDialog: typeof import("@/lib/bookmark-dialog-events").openBookmarkDialog;
let usePlanStore: typeof import("@/store/plan-store").usePlanStore;
let view: RenderResult | null = null;

const saved = makeBookmark("saved", {
  title: "Saved",
  url: "https://example.com/saved",
  description: "Desc",
  notes: "Old note",
  collectionId: "reading",
  tags: ["frontend"],
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: Date.parse("2026-03-04T00:00:00.000Z"),
});

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ usePlanStore } = await import("@/store/plan-store"));
  ({ openBookmarkDialog } = await import("@/lib/bookmark-dialog-events"));
  ({ BookmarkDialog } = await importFresh<typeof import("@/components/dashboard/shared/bookmark-dialog")>("components/dashboard/shared/bookmark-dialog.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

function renderDialog(path = "/"): void {
  view?.unmount();
  view = render(app, createElement(MemoryRouter, { initialEntries: [path] }, createElement(BookmarkDialog)));
}

function seed(bookmarks: Bookmark[]): void {
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks) });
}

beforeEach(() => {
  view?.unmount();
  view = null;
  usePlanStore.setState({ limits: null, usage: null, fetchedAt: Date.now(), quotaAlert: null });
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [
      makeCollection("reading", "home", { name: "Reading", isDefault: true }),
      makeCollection("projects", "home", { name: "Projects", position: 1 }),
    ],
    tags: [makeTag("frontend", "Frontend")],
  });
  app.useBookmarksStore.setState({
    selectedCollection: "all",
    archivedBookmarks: [],
    trashedBookmarks: [],
    _archivedLoaded: true,
    _trashedLoaded: true,
    highlightedBookmarkId: null,
  });
  seed([saved]);
  renderDialog();
});

function open(request?: OpenBookmarkDialogRequest): void {
  act(() => {
    openBookmarkDialog(request);
  });
}
function field<T extends Element = HTMLInputElement>(name: string): T {
  return getBySelector<T>(`[role="dialog"] [name="${name}"]`);
}
async function save(): Promise<void> {
  await submitForm(getBySelector<HTMLFormElement>('[role="dialog"] form'));
}
const dialogOpen = () => document.querySelector('[role="dialog"]') !== null;
const added = () => [...app.useBookmarksStore.getState().bookmarks.values()].find((bookmark) => bookmark.id !== "saved");
const tagField = () => getBySelector<HTMLInputElement>('[role="dialog"] [role="combobox"]');

function fillRequired(title: string, url: string): void {
  typeInto(field("title"), title);
  typeInto(field("url"), url);
}

describe("adding a bookmark", () => {
  test("requires a title and a valid address", async () => {
    open();
    await save();
    expect(getByText("bookmarkForm_errorTitle")).toBeTruthy();
    expect(getByText("bookmarkForm_errorUrl")).toBeTruthy();

    fillRequired("Page", "not a url");
    await save();
    expect(getByText("bookmarkForm_errorUrl")).toBeTruthy();
    expect(app.useBookmarksStore.getState().bookmarks.size).toBe(1);
  });

  test("an address without a scheme gets https://, and the bookmark keeps its notes and tags", async () => {
    open();
    fillRequired("Docs", "example.com/docs");
    typeInto(field<HTMLTextAreaElement>("notes"), "  Read before Friday  ");
    act(() => tagField().focus());
    typeInto(tagField(), "front");
    pressKey(tagField(), "Enter");
    await save();

    const bookmark = added();
    expect(bookmark?.url).toBe("https://example.com/docs");
    expect(bookmark?.notes).toBe("Read before Friday");
    expect(bookmark?.tags).toEqual(["frontend"]);
    expect(bookmark?.collectionId).toBe("reading");
    expect(dialogOpen()).toBe(false);
  });

  test("an address with a scheme is kept as typed", async () => {
    open();
    fillRequired("Files", "ftp://files.example.com/a");
    await save();
    expect(added()?.url).toBe("ftp://files.example.com/a");
  });

  test("starts in the collection being viewed, otherwise in the default collection", async () => {
    act(() => {
      app.useBookmarksStore.setState({ selectedCollection: "projects" });
    });
    open();
    fillRequired("In projects", "example.com/p");
    await save();
    expect(added()?.collectionId).toBe("projects");

    seed([saved]);
    renderDialog("/favorites");
    open();
    fillRequired("From favorites", "example.com/f");
    await save();
    expect(added()?.collectionId).toBe("reading");
  });

  test("Cmd or Ctrl+Enter saves from the notes field, and plain Enter does not", () => {
    open();
    fillRequired("Docs", "example.com/docs");
    pressKey(field<HTMLTextAreaElement>("notes"), "Enter");
    expect(dialogOpen()).toBe(true);

    pressKey(field<HTMLTextAreaElement>("notes"), "Enter", { ctrlKey: true });
    expect(added()?.title).toBe("Docs");
    expect(dialogOpen()).toBe(false);
  });

  test("notes take up to 10,000 characters and show a counter above 9,000", () => {
    open();
    const notes = field<HTMLTextAreaElement>("notes");
    expect(notes.getAttribute("maxlength")).toBe("10000");
    typeInto(notes, "x".repeat(9_000));
    expect(queryByText("bookmarkForm_notesCounter[9000,10000]")).toBeNull();
    typeInto(notes, "x".repeat(9_001));
    expect(getByText("bookmarkForm_notesCounter[9001,10000]")).toBeTruthy();
  });

  test("a save the bookmark quota blocks keeps the form open", async () => {
    usePlanStore.setState({
      limits: { max_bookmarks: 1, max_collections: 100, max_tags: 100, max_workspaces: 10, max_saved_groups: 100, trash_grace_days: 30 },
      usage: { bookmarks: 1, collections: 2, tags: 1, workspaces: 1, saved_groups: 0 },
      fetchedAt: Date.now(),
    });
    open();
    fillRequired("Over quota", "example.com/over");
    await save();
    expect(added()).toBeUndefined();
    expect(dialogOpen()).toBe(true);
    expect(field("title").value).toBe("Over quota");
  });
  test("a stale add destination keeps values and offers the current default", async () => {
    act(() => app.useBookmarksStore.setState({ selectedCollection: "projects" }));
    open();
    fillRequired("Keep me", "example.com/keep");
    typeInto(field<HTMLTextAreaElement>("notes"), "Keep my notes");
    act(() => app.useWorkspaceStore.setState({ collections: [makeCollection("reading", "home", { name: "Reading", isDefault: true }), makeCollection("projects", "home", { archivedAt: 1 })] }));
    await save();
    expect(added()).toBeUndefined();
    expect(field("title").value).toBe("Keep me");
    expect(field<HTMLTextAreaElement>("notes").value).toBe("Keep my notes");
    expect(getByText("workspaceVisibility_targetUnavailable")).toBeTruthy();
    await save();
    expect(added()?.collectionId).toBe("reading");
  });

  test("Cmd+Enter saves from tags without activating its pending suggestion", () => {
    open({ focus: "tags" });
    fillRequired("Page", "example.com/page");
    typeInto(tagField(), "front");
    pressKey(tagField(), "Enter", { metaKey: true });
    expect(added()?.tags).toEqual([]);
    expect(dialogOpen()).toBe(false);
  });

  test("Esc in the tag field closes its suggestions before it closes the dialog", () => {
    open({ focus: "tags" });
    typeInto(field<HTMLTextAreaElement>("notes"), "A long note");
    typeInto(tagField(), "fro");
    expect(tagField().getAttribute("aria-expanded")).toBe("true");

    pressKey(tagField(), "Escape");
    expect(dialogOpen()).toBe(true);
    expect(tagField().getAttribute("aria-expanded")).toBe("false");
    expect(field<HTMLTextAreaElement>("notes").value).toBe("A long note");

    typeInto(tagField(), "fron");
    expect(tagField().getAttribute("aria-expanded")).toBe("true");
    pressKey(tagField(), "Escape");
    pressKey(tagField(), "Escape");
    expect(dialogOpen()).toBe(false);
  });

  // The picker renders in a portal, outside the form element.
  test("Cmd or Ctrl+Enter saves while the collection picker is open", async () => {
    open();
    fillRequired("Docs", "example.com/docs");
    await act(async () => click(getByText("Reading")));
    pressKey(getBySelector('[placeholder="collectionPicker_filterPlaceholder"]'), "Enter", { ctrlKey: true });
    expect(added()?.title).toBe("Docs");
    expect(dialogOpen()).toBe(false);
  });

});

describe("editing a bookmark", () => {
  test("starts from the bookmark and closes without writing when nothing changed", async () => {
    open({ bookmarkId: "saved" });
    expect(field("title").value).toBe("Saved");
    expect(field<HTMLTextAreaElement>("notes").value).toBe("Old note");
    const before = app.useBookmarksStore.getState().bookmarks.get("saved");

    await save();

    expect(dialogOpen()).toBe(false);
    expect(app.useBookmarksStore.getState().bookmarks.get("saved")).toBe(before);
  });

  test("writes only the fields the user changed", async () => {
    open({ bookmarkId: "saved" });
    act(() => {
      seed([{ ...saved, description: "Changed on another device" }]);
    });
    typeInto(field("title"), "Renamed");
    await save();

    const stored = app.useBookmarksStore.getState().bookmarks.get("saved");
    expect(stored?.title).toBe("Renamed");
    expect(stored?.description).toBe("Changed on another device");
    expect(stored?.notes).toBe("Old note");
    expect(stored?.updatedAt).not.toBe(saved.updatedAt);
  });

  test("an untouched edit preserves concurrent changes to every field without stamping", async () => {
    open({ bookmarkId: "saved" });
    const concurrent = { ...saved, title: "Remote title", url: "https://remote.example.com", description: "Remote description", notes: "Remote notes", collectionId: "projects", tags: [], updatedAt: 123 };
    act(() => seed([concurrent]));
    await save();
    expect(dialogOpen()).toBe(false);
    expect(app.useBookmarksStore.getState().bookmarks.get("saved")).toBe(concurrent);
  });

  test("text edited back to its saved value is a no-op", async () => {
    open({ bookmarkId: "saved" });
    typeInto(field("title"), "Changed");
    typeInto(field("title"), " Saved ");
    typeInto(field<HTMLTextAreaElement>("notes"), " Old note ");
    const before = app.useBookmarksStore.getState().bookmarks.get("saved");
    await save();
    expect(app.useBookmarksStore.getState().bookmarks.get("saved")).toBe(before);
    expect(dialogOpen()).toBe(false);
  });

  test("an untouched legacy URL is preserved when changing another field", async () => {
    seed([{ ...saved, url: "legacy address" }]);
    open({ bookmarkId: "saved" });
    typeInto(field("title"), "Renamed");
    await save();
    expect(app.useBookmarksStore.getState().bookmarks.get("saved")?.url).toBe("legacy address");
    expect(app.useBookmarksStore.getState().bookmarks.get("saved")?.title).toBe("Renamed");
  });

  test("a retired parent blocks editing even while the bookmark remains loaded", async () => {
    open({ bookmarkId: "saved" });
    act(() => app.useWorkspaceStore.setState({ workspaces: [makeWorkspace("home", { deletedAt: 1 })] }));
    typeInto(field("title"), "Renamed");
    await save();
    expect(getByText("bookmarkForm_changedElsewhere")).toBeTruthy();
    expect(app.useBookmarksStore.getState().bookmarks.get("saved")?.title).toBe("Saved");
    expect(dialogOpen()).toBe(true);
  });

  test("a request under an archived collection does not open", () => {
    act(() => app.useWorkspaceStore.setState({ collections: [makeCollection("reading", "home", { archivedAt: 1 })] }));
    open({ bookmarkId: "saved" });
    expect(dialogOpen()).toBe(false);
  });

  test("an edit cannot move into a collection that retired while the form was open", async () => {
    open({ bookmarkId: "saved" });
    click(getByText("Reading"));
    click(getByText("Projects"));
    act(() => app.useWorkspaceStore.setState({ collections: [makeCollection("reading", "home", { name: "Reading", isDefault: true }), makeCollection("projects", "home", { name: "Projects", archivedAt: 1 })] }));
    await save();
    expect(getByText("workspaceVisibility_targetUnavailable")).toBeTruthy();
    expect(app.useBookmarksStore.getState().bookmarks.get("saved")?.collectionId).toBe("reading");
    expect(dialogOpen()).toBe(true);
  });

  test("a bookmark archived on another device meanwhile is not saved", async () => {
    open({ bookmarkId: "saved" });
    act(() => {
      app.useBookmarksStore.getState().archiveBookmark("saved");
    });
    typeInto(field("title"), "Renamed");
    await save();

    expect(getByText("bookmarkForm_changedElsewhere")).toBeTruthy();
    expect(app.useBookmarksStore.getState().archivedBookmarks.find((bookmark) => bookmark.id === "saved")?.title).toBe("Saved");
    expect(dialogOpen()).toBe(true);
  });

  test("a request for a bookmark that is no longer active does not open the dialog", () => {
    open({ bookmarkId: "missing" });
    expect(dialogOpen()).toBe(false);
  });

  test("a focus request puts the cursor in the notes or the tags field", () => {
    open({ bookmarkId: "saved", focus: "notes" });
    const notes = field<HTMLTextAreaElement>("notes");
    expect(document.activeElement === notes).toBe(true);
    expect(notes.selectionStart).toBe(notes.value.length);
    click(getByText("settings_cancel"));

    open({ bookmarkId: "saved", focus: "tags" });
    expect(document.activeElement === tagField()).toBe(true);
  });

  test("shows when the bookmark was added and last updated", () => {
    const format = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
    open({ bookmarkId: "saved" });
    const text = getBySelector('[role="dialog"]').textContent ?? "";
    expect(text).toContain(`bookmarkForm_added[${format.format(Date.parse("2026-01-02T00:00:00.000Z"))}]`);
    expect(text).toContain(`bookmarkForm_updated[${format.format(Date.parse("2026-03-04T00:00:00.000Z"))}]`);
  });

  test("leaves out the update time for a bookmark saved before edit times existed", () => {
    seed([makeBookmark("legacy", { collectionId: "reading" })]);
    open({ bookmarkId: "legacy" });
    const text = getBySelector('[role="dialog"]').textContent ?? "";
    expect(text).toContain("bookmarkForm_added[");
    expect(text).not.toContain("bookmarkForm_updated[");
  });

  test("an uncategorized bookmark shows Uncategorized until another collection is picked", () => {
    seed([makeBookmark("loose", { collectionId: "" })]);
    open({ bookmarkId: "loose" });
    expect(getByText("bookmarkForm_uncategorized")).toBeTruthy();
  });
});


describe("nested collection creation", () => {
  for (const editing of [false, true]) {
    for (const gesture of ["submit", "ctrl", "meta"]) {
      test(`${editing ? "edit" : "add"}: child ${gesture} creates a collection without saving the parent`, async () => {
        open(editing ? { bookmarkId: "saved" } : undefined);
        fillRequired("Draft title", "https://draft.example.com");
        typeInto(field("description"), "Draft description");
        typeInto(field<HTMLTextAreaElement>("notes"), "Draft notes");
        const before = app.useBookmarksStore.getState().bookmarks;
        await act(async () => click(getByText("Reading")));
        click(getByText("groupsPanel_newCollection"));
        const name = getBySelector<HTMLInputElement>("#collection-name");
        typeInto(name, "Ideas");
        pressKey(name, "Enter", { ctrlKey: true, isComposing: true });
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
        expect(app.useWorkspaceStore.getState().collections.some((collection) => collection.name === "Ideas")).toBe(false);
        if (gesture === "submit") {
          // The submit event is also the browser default action of plain Enter.
          pressKey(name, "Enter");
          const childForm = name.form;
          if (!childForm) { throw new Error("Missing child form"); }
          await submitForm(childForm);
        } else {
          await act(async () => pressKey(name, "Enter", { ctrlKey: gesture === "ctrl", metaKey: gesture === "meta" }));
        }
        const created = app.useWorkspaceStore.getState().collections.find((collection) => collection.name === "Ideas");
        expect(created?.id).toBeTruthy();
        expect(app.useBookmarksStore.getState().bookmarks).toBe(before);
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
        expect(getByText("Ideas")).toBeTruthy();
        expect(field("title").value).toBe("Draft title");
        expect(field("url").value).toBe("https://draft.example.com");
        expect(field("description").value).toBe("Draft description");
        expect(field<HTMLTextAreaElement>("notes").value).toBe("Draft notes");
        pressKey(field<HTMLTextAreaElement>("notes"), "Enter", { metaKey: true });
        const stored = editing ? app.useBookmarksStore.getState().bookmarks.get("saved") : added();
        expect(stored?.collectionId).toBe(created?.id);
        expect(stored?.title).toBe("Draft title");
        expect(dialogOpen()).toBe(false);
      });
    }
  }
});

test("a cross-workspace edit shows the saved parent but move options stay in the active workspace", async () => {
  act(() => {
    app.useWorkspaceStore.setState({
      workspaces: [makeWorkspace("home"), makeWorkspace("other")],
      collections: [...app.useWorkspaceStore.getState().collections, makeCollection("remote", "other", { name: "Remote collection" })],
    });
    seed([{ ...saved, collectionId: "remote" }]);
  });
  open({ bookmarkId: "saved" });
  await act(async () => click(getByText("Remote collection")));
  const options = Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent);
  expect(options).toEqual(["Reading", "Projects"]);
  pressKey(getBySelector('[role="listbox"]'), "Escape");
  await save();
  expect(app.useBookmarksStore.getState().bookmarks.get("saved")?.collectionId).toBe("remote");
});

describe("fetching details", () => {
  const page = '<html><head><title>Fetched title</title><meta property="og:description" content="Fetched description"><meta property="og:image" content="/cover.png"></head></html>';
  const accessRequests: string[][] = [];
  const fetchedUrls: string[] = [];
  let originalChrome: unknown;
  let originalFetch: unknown;
  let grantAccess = true;
  let responseType = "text/html; charset=utf-8";

  beforeEach(() => {
    originalChrome = Reflect.get(globalThis, "chrome");
    originalFetch = Reflect.get(globalThis, "fetch");
    accessRequests.length = 0;
    fetchedUrls.length = 0;
    grantAccess = true;
    responseType = "text/html; charset=utf-8";
    Reflect.set(globalThis, "chrome", {
      permissions: {
        request: async (permissions: { origins: string[] }) => {
          accessRequests.push(permissions.origins);
          return grantAccess;
        },
      },
    });
    Reflect.set(globalThis, "fetch", async (input: string) => {
      fetchedUrls.push(input);
      return new Response(page, { headers: { "content-type": responseType } });
    });
  });
  afterEach(() => {
    Reflect.set(globalThis, "chrome", originalChrome);
    Reflect.set(globalThis, "fetch", originalFetch);
  });

  async function fetchDetails(): Promise<void> {
    click(getByText("bookmarkForm_fetchDetails"));
    await wait(20);
  }
  const formCover = () => document.querySelector('[role="dialog"] [data-form-cover]');
  const stored = () => app.useBookmarksStore.getState().bookmarks.get("saved");

  test("the button waits for a web address", () => {
    open();
    const button = () => getByText("bookmarkForm_fetchDetails").closest("button");
    expect(button()?.disabled).toBe(true);
    typeInto(field("url"), "ftp://files.example.com/a");
    expect(button()?.disabled).toBe(true);
    typeInto(field("url"), "example.com");
    expect(button()?.disabled).toBe(false);
  });

  test("asks for the site during the click, then fills the empty fields and the cover", async () => {
    open();
    typeInto(field("url"), "example.com/article");
    click(getByText("bookmarkForm_fetchDetails"));
    expect(accessRequests).toEqual([["https://example.com/*"]]);
    await wait(20);

    expect(fetchedUrls).toEqual(["https://example.com/article"]);
    expect(field("title").value).toBe("Fetched title");
    expect(field("description").value).toBe("Fetched description");
    expect(formCover()?.getAttribute("src")).toBe("https://example.com/cover.png");
    await save();
    expect(added()?.imageUrl).toBe("https://example.com/cover.png");
  });

  test("offers fetched values for filled fields without overwriting them", async () => {
    open();
    fillRequired("My title", "https://example.com/article");
    typeInto(field("description"), "My description");
    await fetchDetails();

    expect(field("title").value).toBe("My title");
    expect(field("description").value).toBe("My description");
    click(getByText("bookmarkForm_useFetched[Fetched title]"));
    expect(field("title").value).toBe("Fetched title");
    expect(queryByText("bookmarkForm_useFetched[Fetched title]")).toBeNull();
    expect(queryByText("bookmarkForm_useFetched[Fetched description]")).not.toBeNull();
  });

  test("a refused site access says so and fetches nothing", async () => {
    grantAccess = false;
    open();
    typeInto(field("url"), "https://example.com/article");
    await fetchDetails();

    expect(getByText("bookmarkForm_fetchAccessDenied")).toBeTruthy();
    expect(fetchedUrls).toEqual([]);
    expect(field("title").value).toBe("");
  });

  test("a page that is not HTML shows an error and changes nothing", async () => {
    responseType = "application/pdf";
    open();
    typeInto(field("url"), "https://example.com/file.pdf");
    await fetchDetails();

    expect(getByText("bookmarkForm_fetchNotHtml")).toBeTruthy();
    expect(field("title").value).toBe("");
    expect(formCover()).toBeNull();
  });

  test("a cover fetched for one address is not saved under another", async () => {
    open();
    typeInto(field("url"), "https://example.com/article");
    await fetchDetails();
    typeInto(field("url"), "https://example.com/other");

    expect(formCover()).toBeNull();
    await save();
    expect(added()?.url).toBe("https://example.com/other");
    expect(added()?.imageUrl).toBe("");
  });

  test("an edit keeps the cover, and a new address clears it on save", async () => {
    act(() => seed([{ ...saved, imageUrl: "https://cdn.example.com/saved.png" }]));
    open({ bookmarkId: "saved" });
    expect(formCover()?.getAttribute("src")).toBe("https://cdn.example.com/saved.png");
    typeInto(field("title"), "Renamed");
    await save();
    expect(stored()?.imageUrl).toBe("https://cdn.example.com/saved.png");

    open({ bookmarkId: "saved" });
    typeInto(field("url"), "https://example.com/moved");
    await save();
    expect(stored()?.url).toBe("https://example.com/moved");
    expect(stored()?.imageUrl).toBe("");
  });

  test("changing the address clears a cover that arrived elsewhere after the form opened", async () => {
    open({ bookmarkId: "saved" });
    act(() => seed([{ ...saved, imageUrl: "https://cdn.example.com/arrived.png" }]));
    typeInto(field("url"), "https://example.com/moved");
    await save();
    expect(stored()?.url).toBe("https://example.com/moved");
    expect(stored()?.imageUrl).toBe("");
  });

  test("details fetched for a new address keep its cover", async () => {
    act(() => seed([{ ...saved, imageUrl: "https://cdn.example.com/saved.png" }]));
    open({ bookmarkId: "saved" });
    typeInto(field("url"), "https://example.com/moved");
    await fetchDetails();
    await save();

    expect(stored()?.url).toBe("https://example.com/moved");
    expect(stored()?.imageUrl).toBe("https://example.com/cover.png");
  });

  for (const hasFetchedCover of [true, false]) {
    test(`a remote URL change preserves its cover after fetching ${hasFetchedCover ? "an image" : "no image"} for the old URL`, async () => {
      if (!hasFetchedCover) {
        Reflect.set(globalThis, "fetch", async () => new Response("<title>No cover</title>", { headers: { "content-type": "text/html" } }));
      }
      open({ bookmarkId: "saved" });
      await fetchDetails();
      act(() => seed([{ ...saved, url: "https://remote.example.com/page", imageUrl: "https://remote.example.com/cover.png" }]));
      typeInto(field("title"), "Local title");
      await save();
      expect(stored()?.title).toBe("Local title");
      expect(stored()?.url).toBe("https://remote.example.com/page");
      expect(stored()?.imageUrl).toBe("https://remote.example.com/cover.png");
    });
  }

  test("an explicitly edited URL saves its fetched cover despite a concurrent remote URL change", async () => {
    open({ bookmarkId: "saved" });
    typeInto(field("url"), "https://example.com/local");
    await fetchDetails();
    act(() => seed([{ ...saved, url: "https://remote.example.com/page", imageUrl: "https://remote.example.com/cover.png" }]));
    await save();
    expect(stored()?.url).toBe("https://example.com/local");
    expect(stored()?.imageUrl).toBe("https://example.com/cover.png");
  });

  test("fetching only changes the form until save, and its thumbnail is decorative", async () => {
    open();
    typeInto(field("url"), "https://example.com/article");
    await fetchDetails();
    expect(added()).toBeUndefined();
    expect(formCover()?.getAttribute("alt")).toBe("");
    expect(formCover()?.getAttribute("loading")).toBe("lazy");
    expect(formCover()?.getAttribute("decoding")).toBe("async");
    expect(formCover()?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(formCover()?.getAttribute("draggable")).toBe("false");
  });

  test("successful details without an image replace an existing cover", async () => {
    Reflect.set(globalThis, "fetch", async () => new Response("<title>No cover</title>", { headers: { "content-type": "text/html" } }));
    act(() => seed([{ ...saved, imageUrl: "https://cdn.example.com/saved.png" }]));
    open({ bookmarkId: "saved" });
    await fetchDetails();
    expect(formCover()).toBeNull();
    expect(stored()?.imageUrl).toBe("https://cdn.example.com/saved.png");
    await save();
    expect(stored()?.imageUrl).toBe("");
  });

  test("fetching an empty cover also replaces one that arrived elsewhere", async () => {
    Reflect.set(globalThis, "fetch", async () => new Response("<title>No cover</title>", { headers: { "content-type": "text/html" } }));
    open({ bookmarkId: "saved" });
    act(() => seed([{ ...saved, imageUrl: "https://cdn.example.com/arrived.png" }]));
    await fetchDetails();
    await save();
    expect(stored()?.imageUrl).toBe("");
  });

  test("a late response cannot fill fields after the address changes, even if changed back", async () => {
    let finish: (response: Response) => void = () => { throw new Error("Fetch has not started"); };
    Reflect.set(globalThis, "fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
    open();
    typeInto(field("url"), "https://example.com/article");
    click(getByText("bookmarkForm_fetchDetails"));
    await wait(0);
    typeInto(field("url"), "https://example.com/other");
    typeInto(field("url"), "https://example.com/article");
    finish(new Response(page, { headers: { "content-type": "text/html" } }));
    await wait(20);
    expect(field("title").value).toBe("");
    expect(field("description").value).toBe("");
    expect(formCover()).toBeNull();
  });

  test("changing the address while access is pending prevents a stale fetch and error", async () => {
    let finish: (allowed: boolean) => void = () => { throw new Error("Access has not been requested"); };
    Reflect.set(globalThis, "chrome", { permissions: { request: () => new Promise<boolean>((resolve) => { finish = resolve; }) } });
    open();
    typeInto(field("url"), "https://example.com/article");
    click(getByText("bookmarkForm_fetchDetails"));
    typeInto(field("url"), "https://example.com/other");
    finish(false);
    await wait(20);
    expect(fetchedUrls).toEqual([]);
    expect(queryByText("bookmarkForm_fetchAccessDenied")).toBeNull();
  });

  test("failed thumbnails are not retried when the form reopens", () => {
    act(() => seed([{ ...saved, imageUrl: "https://cdn.example.com/broken-form.png" }]));
    open({ bookmarkId: "saved" });
    expect(formCover()?.getAttribute("src")).toBe("https://cdn.example.com/broken-form.png");
    act(() => formCover()?.dispatchEvent(new Event("error")));
    expect(formCover()).toBeNull();
    click(getByText("settings_cancel"));
    open({ bookmarkId: "saved" });
    expect(formCover()).toBeNull();
  });

});
