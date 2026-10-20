// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, memo, type MouseEvent as ReactMouseEvent } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, installAppModules, pressKey, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let useSelectionScope: typeof import("@/hooks/use-selection-scope").useSelectionScope;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let useSelectionOrders: typeof import("@/components/dashboard/shared/selection-orders").useSelectionOrders;
let view: RenderResult | null = null;

interface HostProps {
  viewOrder: readonly string[];
}

function Host({ viewOrder }: HostProps) {
  useSelectionScope(viewOrder);
  return null;
}

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ useSelectionScope } = await importFresh<typeof import("@/hooks/use-selection-scope")>("hooks/use-selection-scope.ts"));
  ({ SelectionOrdersProvider, useSelectionOrders } = await importFresh<typeof import("@/components/dashboard/shared/selection-orders")>("components/dashboard/shared/selection-orders.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  app.useWorkspaceStore.setState({ activeWorkspaceId: "home", workspaces: [makeWorkspace("home"), makeWorkspace("work")] });
  app.useBookmarksStore.setState({ selectedCollection: "all", selectedTags: [], filterType: "all", searchQuery: "" });
  view = render(app, createElement(Host, { viewOrder: ["a", "b", "c"] }));
  act(() => {
    useSelectionStore.getState().setMany(["a", "b"], true);
  });
});

const selected = () => [...useSelectionStore.getState().selectedIds].sort();

describe("useSelectionScope", () => {
  test("keeps only bookmarks that are still in the view", () => {
    view?.rerender(createElement(Host, { viewOrder: ["a", "c"] }));
    expect(selected()).toEqual(["a"]);
  });

  test("clears the selection when the workspace, collection, tags, filter or search change", () => {
    const changes: Array<() => void> = [
      () => app.useWorkspaceStore.setState({ activeWorkspaceId: "work" }),
      () => app.useBookmarksStore.setState({ selectedCollection: "reading" }),
      () => app.useBookmarksStore.setState({ selectedTags: ["frontend"] }),
      () => app.useBookmarksStore.setState({ filterType: "with-tags" }),
      () => app.useBookmarksStore.setState({ searchQuery: "docs" }),
    ];
    for (const change of changes) {
      act(() => {
        useSelectionStore.getState().setMany(["a"], true);
      });
      act(change);
      expect(selected()).toEqual([]);
    }
  });

  test("clears the selection when the view unmounts", () => {
    view?.unmount();
    view = null;
    expect(selected()).toEqual([]);
  });

  test("Esc clears the selection", () => {
    pressKey(document.body, "Escape");
    expect(selected()).toEqual([]);
  });

  test("Esc typed in a field keeps the selection", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      pressKey(input, "Escape");
      expect(selected()).toEqual(["a", "b"]);
    } finally {
      input.remove();
    }
  });

  test("Esc in textarea, select and nested editable content keeps the selection", () => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    const nested = document.createElement("span");
    editable.appendChild(nested);
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    document.body.append(editable, textarea, select);
    try {
      for (const target of [editable, nested, textarea, select]) {
        pressKey(target, "Escape");
        expect(selected()).toEqual(["a", "b"]);
      }
    } finally {
      editable.remove();
      textarea.remove();
      select.remove();
    }
  });

  test("unrelated keys and display sorting preserve the selection", () => {
    pressKey(document.body, "Enter");
    act(() => app.useBookmarksStore.setState({ sortBy: "alpha-az" }));
    view?.rerender(createElement(Host, { viewOrder: ["c", "b", "a"] }));
    expect(selected()).toEqual(["a", "b"]);
  });

  test("Esc another component already handled keeps the selection", () => {
    const handleKeyDown = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    try {
      pressKey(document.body, "Escape");
      expect(selected()).toEqual(["a", "b"]);
    } finally {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    }
  });
});

describe("selection orders", () => {
  test("events read the latest orders without rerendering a memoized consumer", () => {
    let renders = 0;
    const Consumer = memo(function Consumer() {
      renders += 1;
      const orders = useSelectionOrders();
      const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
        const current = orders?.current;
        event.currentTarget.textContent = current ? `${current.viewOrder.join(",")}/${current.onScreenOrder.join(",")}` : "none";
      };
      return createElement("button", { onClick: handleClick }, "Read orders");
    });
    const child = createElement(Consumer);
    view?.unmount();
    view = render(app, createElement(SelectionOrdersProvider, { viewOrder: ["a", "b"], onScreenOrder: ["a"], children: child }));
    const button = getBySelector("button", view.container);
    click(button);
    expect(button.textContent).toBe("a,b/a");
    view.rerender(createElement(SelectionOrdersProvider, { viewOrder: ["b", "c"], onScreenOrder: ["c"], children: child }));
    click(button);
    expect(button.textContent).toBe("b,c/c");
    expect(renders).toBe(1);
  });

  test("returns null outside a selectable view", () => {
    function Consumer() {
      const orders = useSelectionOrders();
      return createElement("span", null, orders === null ? "No selection scope" : "Has scope");
    }
    view?.rerender(createElement(Consumer));
    expect(view?.container.textContent).toBe("No selection scope");
  });
});
