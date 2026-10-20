// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, useState } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, pressKey, queryByText, render, setupDom, teardownDom, typeInto, type AppModules, type RenderResult } from "./helpers/dom-environment";

const replacer = createModuleReplacer();
const handleActivate = mock((_item: { id: string; label: string }) => {});
const handleCreate = mock((_name: string) => {});
let app: AppModules;
let FilterableList: typeof import("@/components/dashboard/shared/filterable-list").FilterableList;
let view: RenderResult | null = null;
let creatable = true;
let listHidden = false;

const ITEMS = [
  { id: "alpha", label: "Alpha" },
  { id: "beta", label: "Beta" },
  { id: "alphabet", label: "Alphabet" },
];

function Host() {
  const [query, setQuery] = useState("");
  return createElement(FilterableList<{ id: string; label: string }>, {
    items: ITEMS,
    listHidden,
    query,
    onQueryChange: setQuery,
    onActivate: handleActivate,
    create: { canCreate: () => creatable, onCreate: handleCreate },
    placeholder: "filter",
    emptyText: "nothing",
  });
}

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ FilterableList } = await importFresh<typeof import("@/components/dashboard/shared/filterable-list")>("components/dashboard/shared/filterable-list.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  handleActivate.mockClear();
  handleCreate.mockClear();
  creatable = true;
  listHidden = false;
  view = render(app, createElement(Host));
});

const input = () => getBySelector<HTMLInputElement>('[role="combobox"]');
const options = () => Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent?.trim());

describe("FilterableList", () => {
  test("filters items by the typed text, ignoring case", () => {
    typeInto(input(), "ALPH");
    expect(options()).toEqual(["Alpha", "Alphabet", "filterableList_create[ALPH]"]);
  });

  test("arrow keys move the highlight and Enter activates the highlighted item", () => {
    typeInto(input(), "alph");
    pressKey(input(), "ArrowDown");
    expect(getBySelector('[role="option"][aria-selected="true"]').textContent).toBe("Alphabet");
    pressKey(input(), "Enter");
    expect(handleActivate).toHaveBeenCalledWith(ITEMS[2]);
  });

  test("Enter with an empty query activates nothing until the user picks a row", () => {
    pressKey(input(), "Enter");
    expect(handleActivate).not.toHaveBeenCalled();
    pressKey(input(), "ArrowDown");
    pressKey(input(), "Enter");
    expect(handleActivate).toHaveBeenCalledWith(ITEMS[1]);
  });

  test("offers to create a name no item has, and creates it with the trimmed name", () => {
    typeInto(input(), "  Gamma ");
    pressKey(input(), "Enter");
    expect(handleCreate).toHaveBeenCalledWith("Gamma");
  });

  test("does not offer to create a name that exists or that the owner refuses", () => {
    typeInto(input(), "beta");
    expect(queryByText("filterableList_create[beta]")).toBeNull();
    creatable = false;
    typeInto(input(), "Gamma");
    expect(queryByText("filterableList_create[Gamma]")).toBeNull();
    expect(getByText("nothing")).toBeTruthy();
  });

  test("leaves Cmd or Ctrl+Enter to the surrounding form", () => {
    typeInto(input(), "alpha");
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ctrlKey: true });
    input().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(handleActivate).not.toHaveBeenCalled();
  });

  test("leaves Meta+Enter and composition Enter untouched", () => {
    typeInto(input(), "alpha");
    pressKey(input(), "Enter", { metaKey: true });
    pressKey(input(), "Enter", { isComposing: true });
    expect(handleActivate).not.toHaveBeenCalled();
    expect(handleCreate).not.toHaveBeenCalled();
  });

  test("does not navigate or activate a hidden list", () => {
    listHidden = true;
    typeInto(input(), "alpha");
    pressKey(input(), "ArrowDown");
    pressKey(input(), "Enter");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    expect(handleActivate).not.toHaveBeenCalled();
  });

  test("clicking an option activates it", () => {
    click(getByText("Beta"));
    expect(handleActivate).toHaveBeenCalledWith(ITEMS[1]);
  });
});
