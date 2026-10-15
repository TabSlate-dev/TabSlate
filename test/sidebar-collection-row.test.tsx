// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import type { Collection } from "@/lib/types";
import { createModuleReplacer } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  openDropdown,
  queryByText,
  render,
  rightClick,
  setupDom,
  submitForm,
  teardownDom,
  typeInto,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import { makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let sidebar: typeof import("@/components/ui/sidebar");
let SidebarCollectionRow: typeof import("@/components/dashboard/sidebar/collection-row").SidebarCollectionRow;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  sidebar = await import("@/components/ui/sidebar");
  ({ SidebarCollectionRow } = await import("@/components/dashboard/sidebar/collection-row"));
});

afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

const reading = makeCollection("reading", "home", { name: "Reading", isDefault: true });
const projects = makeCollection("projects", "home", { name: "Projects", position: 1 });
const onSelect = mock(() => {});

beforeEach(() => {
  view?.unmount();
  view = null;
  onSelect.mockClear();
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [reading, projects],
  });
});

function renderRow(collection: Collection) {
  view = render(
    app,
    createElement(
      MemoryRouter,
      null,
      createElement(
        sidebar.SidebarProvider,
        null,
        createElement(
          sidebar.SidebarMenu,
          null,
          createElement(SidebarCollectionRow, {
            collection,
            count: 2,
            isActive: false,
            isHighlighted: false,
            onSelect,
          }),
        ),
      ),
    ),
  );
  return getByText(collection.name);
}

describe("SidebarCollectionRow", () => {
  test("right-click offers edit, archive and delete", async () => {
    const row = renderRow(projects);
    await act(async () => {
      rightClick(row);
    });
    expect(getByText("collectionMenu_edit")).toBeTruthy();
    expect(getByText("sidebar_archiveCollection")).toBeTruthy();
    expect(getByText("sidebar_deleteCollection")).toBeTruthy();
  });

  test("the default collection can only be edited", async () => {
    const row = renderRow(reading);
    await act(async () => {
      rightClick(row);
    });
    expect(getByText("collectionMenu_edit")).toBeTruthy();
    expect(queryByText("sidebar_archiveCollection")).toBeNull();
    expect(queryByText("sidebar_deleteCollection")).toBeNull();
  });

  test("edit renames the collection", async () => {
    const row = renderRow(projects);
    await act(async () => {
      rightClick(row);
    });
    click(getByText("collectionMenu_edit"));
    const input = getBySelector<HTMLInputElement>("#collection-name");
    expect(input.value).toBe("Projects");

    typeInto(input, "Side projects");
    const form = input.closest("form");
    if (!form) {
      throw new Error("collection dialog has no form");
    }
    await submitForm(form);

    expect(app.useWorkspaceStore.getState().collections.find((c) => c.id === "projects")?.name).toBe("Side projects");
  });

  test("the ⋯ button opens the same items, and choosing one does not select the row", async () => {
    renderRow(projects);
    await act(async () => {
      openDropdown(getBySelector('[aria-label="collectionMenu_more"]'));
    });
    expect(getByText("sidebar_archiveCollection")).toBeTruthy();

    click(getByText("collectionMenu_edit"));

    expect(getBySelector<HTMLInputElement>("#collection-name").value).toBe("Projects");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
