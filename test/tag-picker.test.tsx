// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, installAppModules, pressKey, render, setupDom, teardownDom, typeInto, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { makeTag } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
const handleChange = mock((_tagIds: string[]) => {});
let app: AppModules;
let TagPicker: typeof import("@/components/dashboard/shared/tag-picker").TagPicker;
let usePlanStore: typeof import("@/store/plan-store").usePlanStore;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ usePlanStore } = await import("@/store/plan-store"));
  ({ TagPicker } = await importFresh<typeof import("@/components/dashboard/shared/tag-picker")>("components/dashboard/shared/tag-picker.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  handleChange.mockClear();
  usePlanStore.setState({ limits: null, usage: null, fetchedAt: Date.now(), quotaAlert: null });
  app.useWorkspaceStore.setState({ tags: [makeTag("frontend", "Frontend"), makeTag("design", "Design")] });
  view = render(app, createElement(TagPicker, { value: ["design"], onChange: handleChange }));
});

const input = () => getBySelector<HTMLInputElement>('[role="combobox"]');

describe("TagPicker", () => {
  test("shows the selected tags as removable chips", () => {
    click(getBySelector('[aria-label="tagPicker_remove[Design]"]'));
    expect(handleChange).toHaveBeenCalledWith([]);
  });

  test("Enter picks the highlighted tag, reusing it regardless of case", () => {
    act(() => input().focus());
    typeInto(input(), "FRONT");
    pressKey(input(), "Enter");
    expect(handleChange).toHaveBeenCalledWith(["design", "frontend"]);
  });

  test("Enter on a new name creates the tag and adds it", () => {
    act(() => input().focus());
    typeInto(input(), "Reading");
    pressKey(input(), "Enter");
    const created = app.useWorkspaceStore.getState().tags.find((tag) => tag.name === "Reading");
    expect(created).toBeDefined();
    expect(handleChange).toHaveBeenCalledWith(["design", created?.id]);
  });

  test("a tag the quota blocks is not added", () => {
    usePlanStore.setState({
      limits: { max_bookmarks: 100, max_collections: 100, max_tags: 2, max_workspaces: 10, max_saved_groups: 100, trash_grace_days: 30 },
      usage: { bookmarks: 0, collections: 0, tags: 2, workspaces: 0, saved_groups: 0 },
      fetchedAt: Date.now(),
    });
    act(() => input().focus());
    typeInto(input(), "Reading");
    pressKey(input(), "Enter");
    expect(app.useWorkspaceStore.getState().tags).toHaveLength(2);
    expect(handleChange).not.toHaveBeenCalled();
    expect(usePlanStore.getState().quotaAlert).not.toBeNull();
  });

  test("Backspace in an empty field removes the last chip", () => {
    pressKey(input(), "Backspace");
    expect(handleChange).toHaveBeenCalledWith([]);
  });
  test("does not recreate a selected tag with case or surrounding spaces changed", () => {
    act(() => input().focus());
    typeInto(input(), "  DESIGN ");
    pressKey(input(), "Enter");
    expect(app.useWorkspaceStore.getState().tags).toHaveLength(2);
    expect(handleChange).not.toHaveBeenCalled();
  });

});
