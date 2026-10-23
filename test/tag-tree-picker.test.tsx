// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import en from "../public/_locales/en/messages.json";
import zhCN from "../public/_locales/zh_CN/messages.json";
import { buildTagTree, type TagTree } from "@/lib/tag-tree";
import type { Tag } from "@/lib/types";
import { createModuleReplacer } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  pressKey,
  render,
  setupDom,
  teardownDom,
  typeInto,
  type AppModules,
} from "./helpers/dom-environment";

const replacer = createModuleReplacer();
let app: AppModules;
let TagTreePicker: typeof import("@/components/dashboard/shared/tag-tree-picker").TagTreePicker;
let TAG_TREE_ROOT_ID: typeof import("@/components/dashboard/shared/tag-tree-picker").TAG_TREE_ROOT_ID;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ TagTreePicker, TAG_TREE_ROOT_ID } = await import("@/components/dashboard/shared/tag-tree-picker"));
});

afterAll(async () => {
  replacer.restore();
  await teardownDom();
});

const makeTag = (id: string, name: string, parentId?: string): Tag => ({
  id,
  name,
  parentId,
  color: "bg-blue-500/10 text-blue-500",
  seq: 0,
});

describe("TagTreePicker", () => {
  test("includes root row with distinct id by default and excludes it when includeTopLevel is false", () => {
    const tags = [makeTag("prog", "Programming"), makeTag("go", "Go", "prog")];
    const tree = buildTagTree(tags, "en");
    const changes: (string | undefined)[] = [];

    const withRoot = render(
      app,
      createElement(TagTreePicker, {
        tree,
        value: undefined,
        onChange: (val) => changes.push(val),
        disabledReason: () => undefined,
        includeTopLevel: true,
        label: "Target tag",
      }),
    );
    expect(getBySelector(`[data-tag-id="${TAG_TREE_ROOT_ID}"]`)).toBeTruthy();
    withRoot.unmount();

    const withoutRoot = render(
      app,
      createElement(TagTreePicker, {
        tree,
        value: undefined,
        onChange: (val) => changes.push(val),
        disabledReason: () => undefined,
        includeTopLevel: false,
        label: "Target tag",
      }),
    );
    expect(document.querySelector(`[data-tag-id="${TAG_TREE_ROOT_ID}"]`)).toBeNull();
    withoutRoot.unmount();
  });

  test("separately labeled aria-expanded on branch nodes and aria-pressed on selected target", () => {
    const tags = [makeTag("prog", "Programming"), makeTag("go", "Go", "prog")];
    const tree = buildTagTree(tags, "en");

    const view = render(
      app,
      createElement(TagTreePicker, {
        tree,
        value: "prog",
        onChange: () => {},
        disabledReason: () => undefined,
        includeTopLevel: true,
        label: "Target tag",
      }),
    );

    const progButton = getBySelector('[data-tag-id="prog"]');
    expect(progButton.getAttribute("aria-pressed")).toBe("true");

    const expandButton = getBySelector('[aria-label="tagTree_expandTag[Programming]"]');
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");

    click(expandButton);
    expect(expandButton.getAttribute("aria-expanded")).toBe("true");
    expect(getBySelector('[data-tag-id="go"]')).toBeTruthy();

    view.unmount();
  });

  test("keyboard target activation selects target and disabled target attempts do not call onChange", () => {
    const tags = [makeTag("prog", "Programming"), makeTag("go", "Go", "prog")];
    const tree = buildTagTree(tags, "en");
    const changes: (string | undefined)[] = [];

    const view = render(
      app,
      createElement(TagTreePicker, {
        tree,
        value: undefined,
        onChange: (val) => changes.push(val),
        disabledReason: (id) => (id === "prog" ? "tagAction_targetDescendant" : undefined),
        includeTopLevel: true,
        label: "Target tag",
      }),
    );

    const progButton = getBySelector('[data-tag-id="prog"]');
    expect(progButton.getAttribute("aria-disabled")).toBe("true");
    click(progButton);
    expect(changes).toEqual([]);

    const rootButton = getBySelector(`[data-tag-id="${TAG_TREE_ROOT_ID}"]`);
    click(rootButton);
    expect(changes).toEqual([undefined]);

    view.unmount();
  });

  test("clamps activeIndex when collapsing a branch shrinks visibleRows", () => {
    const tags = [makeTag("prog", "Programming"), makeTag("go", "Go", "prog")];
    const tree = buildTagTree(tags, "en");
    const changes: (string | undefined)[] = [];

    const view = render(
      app,
      createElement(TagTreePicker, {
        tree,
        value: undefined,
        onChange: (val) => changes.push(val),
        disabledReason: () => undefined,
        includeTopLevel: true,
        label: "Target tag",
      }),
    );

    // Expand Programming so visibleRows = [__root__, prog, go] (length 3)
    click(getBySelector('[aria-label="tagTree_expandTag[Programming]"]'));
    const searchInput = getBySelector<HTMLInputElement>('input[aria-label="tagTreePicker_search"]');

    // Move activeIndex to the last row (index 2 = "go")
    pressKey(searchInput, "ArrowDown");
    pressKey(searchInput, "ArrowDown");

    // Collapse Programming so visibleRows shrinks to [__root__, prog] (length 2)
    click(getBySelector('[aria-label="tagTree_collapseTag[Programming]"]'));

    // Pressing Enter now should activate the clamped last visible row ("prog"), not out-of-bounds
    pressKey(searchInput, "Enter");
    expect(changes).toEqual(["prog"]);

    view.unmount();
  });

  test("defines all new tag hierarchy messages in both en and zh_CN with matching placeholders", () => {
    const keys = [
      "tagMenu_newChild",
      "tagMenu_move",
      "tagMenu_merge",
      "tagTree_expandTag",
      "tagTree_collapseTag",
      "tagTreePicker_root",
      "tagTreePicker_search",
      "tagTreePicker_searchPlaceholder",
      "tagTreePicker_empty",
      "tagDialog_parentLabel",
      "tagDialog_parentNone",
      "tagDialog_changeParent",
      "tagDeleteDialog_promoted_one",
      "tagDeleteDialog_promoted_other",
      "tagDeleteDialog_renames_preview",
      "tagMergeDialog_title",
      "tagMergeDialog_targetLabel",
      "tagMergeDialog_confirm",
      "tagMergeDialog_loadingCounts",
      "tagMergeDialog_affectedBookmarks_one",
      "tagMergeDialog_affectedBookmarks_other",
      "tagMergeDialog_descendantNotice",
      "unusedTagsDialog_title",
      "unusedTagsDialog_desc",
      "unusedTagsDialog_empty",
      "unusedTagsDialog_remainder",
      "unusedTagsDialog_confirm",
      "sidebar_tagActions",
      "sidebar_cleanupUnusedTags",
      "tagAction_targetSelf",
      "tagAction_targetDescendant",
      "tagAction_targetDepth",
      "tagAction_targetDuplicate",
    ] as const;

    for (const key of keys) {
      const enEntry = Reflect.get(en, key);
      const zhEntry = Reflect.get(zhCN, key);
      expect(enEntry).toBeDefined();
      expect(zhEntry).toBeDefined();
      expect(enEntry.message.length).toBeGreaterThan(0);
      expect(zhEntry.message.length).toBeGreaterThan(0);
      if ("placeholders" in enEntry && enEntry.placeholders) {
        expect("placeholders" in zhEntry).toBe(true);
        if ("placeholders" in zhEntry && zhEntry.placeholders) {
          expect(Object.keys(enEntry.placeholders).sort()).toEqual(Object.keys(zhEntry.placeholders).sort());
        }
      }
    }
  });
});
