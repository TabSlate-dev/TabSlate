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
