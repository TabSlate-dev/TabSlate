// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, render, setupDom, submitForm, teardownDom, typeInto, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
const handleSelect = mock((_collectionId: string) => {});
let app: AppModules;
let CollectionPicker: typeof import("@/components/dashboard/shared/collection-picker").CollectionPicker;
let view: RenderResult | null = null;
let usePlanStore: typeof import("@/store/plan-store").usePlanStore;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ usePlanStore } = await import("@/store/plan-store"));
  ({ CollectionPicker } = await importFresh<typeof import("@/components/dashboard/shared/collection-picker")>("components/dashboard/shared/collection-picker.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(async () => {
  view?.unmount();
  handleSelect.mockClear();
  usePlanStore.setState({ limits: null, usage: null, fetchedAt: Date.now(), quotaAlert: null });
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home"), makeWorkspace("work")],
    collections: [
      makeCollection("older", "home", { name: "Older", position: 1 }),
      makeCollection("newer", "home", { name: "Newer", position: 5 }),
      makeCollection("inbox", "home", { name: "Inbox", isDefault: true, position: 0 }),
      makeCollection("trashed", "home", { name: "Trashed", deletedAt: 1 }),
      makeCollection("archived", "home", { name: "Archived", position: 9, archivedAt: 1 }),
      makeCollection("elsewhere", "work", { name: "Elsewhere", position: 3 }),
    ],
  });
  view = render(app, createElement(CollectionPicker, {
    selectedId: "older",
    onSelect: handleSelect,
    children: createElement("button", { type: "button" }, "pick"),
  }));
  await act(async () => {
    click(getByText("pick"));
  });
});

const options = () => Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent?.trim());

describe("CollectionPicker", () => {
  test("lists the workspace's active collections, default first, then newest", () => {
    expect(options()).toEqual(["Inbox", "Newer", "Older"]);
  });

  test("typing filters the list and choosing a collection selects it and closes the picker", () => {
    typeInto(getBySelector<HTMLInputElement>('[role="combobox"]'), "new");
    expect(options()).toEqual(["Newer"]);
    click(getByText("Newer"));
    expect(handleSelect).toHaveBeenCalledWith("newer");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  test("New collection creates one in the active workspace and selects it", async () => {
    click(getByText("groupsPanel_newCollection"));
    typeInto(getBySelector<HTMLInputElement>("#collection-name"), "Ideas");
    await submitForm(getBySelector<HTMLFormElement>('[role="dialog"] form'));

    const created = app.useWorkspaceStore.getState().collections.find((collection) => collection.name === "Ideas");
    expect(created?.workspaceId).toBe("home");
    expect(handleSelect).toHaveBeenCalledWith(created?.id);
  });
  test("does not offer collections from a retired workspace", () => {
    act(() => app.useWorkspaceStore.setState({ workspaces: [makeWorkspace("home", { deletedAt: 1 })] }));
    expect(options()).toEqual([]);
  });

  test("does not create a collection after the workspace retires while the dialog is open", async () => {
    click(getByText("groupsPanel_newCollection"));
    typeInto(getBySelector<HTMLInputElement>("#collection-name"), "Ideas");
    act(() => app.useWorkspaceStore.setState({ workspaces: [makeWorkspace("home", { deletedAt: 1 })] }));
    await submitForm(getBySelector<HTMLFormElement>('[role="dialog"] form'));
    expect(app.useWorkspaceStore.getState().collections.some((collection) => collection.name === "Ideas")).toBe(false);
    expect(handleSelect).not.toHaveBeenCalled();
  });

  test("does not select an empty ID when collection quota blocks creation", async () => {
    usePlanStore.setState({
      limits: { max_bookmarks: 100, max_collections: 1, max_tags: 100, max_workspaces: 10, max_saved_groups: 100, trash_grace_days: 30 },
      usage: { bookmarks: 0, collections: 6, tags: 0, workspaces: 0, saved_groups: 0 },
      fetchedAt: Date.now(),
    });
    click(getByText("groupsPanel_newCollection"));
    typeInto(getBySelector<HTMLInputElement>("#collection-name"), "Ideas");
    await submitForm(getBySelector<HTMLFormElement>('[role="dialog"] form'));
    expect(app.useWorkspaceStore.getState().collections.some((collection) => collection.name === "Ideas")).toBe(false);
    expect(handleSelect).not.toHaveBeenCalled();
    expect(usePlanStore.getState().quotaAlert).not.toBeNull();
  });

});
