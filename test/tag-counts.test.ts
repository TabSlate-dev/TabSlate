// @ts-expect-error Bun provides this test module at runtime.
import { expect, test } from "bun:test";
import { buildTagTree } from "@/lib/tag-tree";
import { makeBookmark } from "./helpers/library-fixtures";
import type { Tag } from "@/lib/types";

const counts = await import("@/lib/tag-counts").catch(() => undefined);
const tags: Tag[] = [
  { id: "parent", name: "parent", color: "blue", seq: 1 },
  { id: "child", parentId: "parent", name: "child", color: "blue", seq: 1 },
  { id: "unused", name: "unused", color: "blue", seq: 1 },
];
test("ancestor_usage_counts_each_bookmark_once_and_ignores_missing_ids", () => {
  expect(counts?.countTagUsage).toBeFunction();
  expect(counts?.countTagUsage(buildTagTree(tags, "en"), [
    makeBookmark("one", { tags: ["parent", "child", "child", "missing"] }),
    makeBookmark("two", { tags: ["child"] }),
  ])).toEqual(new Map([["parent", 2], ["child", 2], ["unused", 0]]));
});
test("unused_parent_is_retained_when_only_its_descendant_is_used", () => {
  expect(counts?.unusedTagIds).toBeFunction();
  expect(counts?.unusedTagIds(buildTagTree(tags, "en"), [makeBookmark("trash", { tags: ["child"] })])).toEqual(new Set(["unused"]));
});

test("active_workspace_count_excludes_hidden_archived_collections_and_other_workspaces", () => {
  const tree = buildTagTree(tags, "en");
  const activeWorkspaceCollectionIds = new Set(["col-active"]);
  const bookmarks = [
    makeBookmark("b-active", { collectionId: "col-active", tags: ["child"] }),
    makeBookmark("b-uncategorized", { collectionId: "", tags: ["child"] }),
    makeBookmark("b-other-workspace", { collectionId: "col-other", tags: ["child"] }),
    makeBookmark("b-archived-col", { collectionId: "col-archived", tags: ["child"] }),
  ];
  const visibleBookmarks = bookmarks.filter(
    (b) => b.collectionId === "" || activeWorkspaceCollectionIds.has(b.collectionId)
  );
  const result = counts?.countTagUsage(tree, visibleBookmarks);
  expect(result?.get("parent")).toBe(2);
  expect(result?.get("child")).toBe(2);
});

test("bookmark_tagged_parent_and_child_counts_once", () => {
  const tree = buildTagTree(tags, "en");
  const bookmarks = [
    makeBookmark("b-both", { tags: ["parent", "child"] }),
  ];
  const result = counts?.countTagUsage(tree, bookmarks);
  expect(result?.get("parent")).toBe(1);
  expect(result?.get("child")).toBe(1);
});
