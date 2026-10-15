// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { getBySelector, render, setupDom, teardownDom } from "./helpers/dom-environment";

const replacer = createModuleReplacer();
let createRoot: typeof import("react-dom/client").createRoot;
let useWorkspaceCollectionReset: typeof import("@/hooks/use-workspace-collection-reset").useWorkspaceCollectionReset;

beforeAll(async () => {
  setupDom();
  const reactDomClient = await importFresh<typeof import("react-dom/client")>("node_modules/react-dom/client.js");
  await replacer.replace("react-dom/client", reactDomClient);
  createRoot = reactDomClient.createRoot;
  ({ useWorkspaceCollectionReset } = await importFresh<typeof import("@/hooks/use-workspace-collection-reset")>(
    "hooks/use-workspace-collection-reset.ts",
  ));
});

afterAll(async () => {
  replacer.restore();
  await teardownDom();
});

function Probe({ ids, selected }: { ids: ReadonlySet<string>; selected: string }) {
  const [selection, setSelection] = useState(selected);
  useWorkspaceCollectionReset(selection, ids, setSelection);
  return createElement("span", { id: "selection" }, selection);
}

describe("useWorkspaceCollectionReset", () => {
  test("keeps a collection that belongs to the active workspace", () => {
    const view = render({ createRoot }, createElement(Probe, { ids: new Set(["projects"]), selected: "projects" }));
    expect(getBySelector("#selection").textContent).toBe("projects");
    view.unmount();
  });

  test("falls back to all bookmarks when the selection is not in the workspace", () => {
    const view = render({ createRoot }, createElement(Probe, { ids: new Set(["projects"]), selected: "reading" }));
    expect(getBySelector("#selection").textContent).toBe("all");
    view.unmount();
  });
});
