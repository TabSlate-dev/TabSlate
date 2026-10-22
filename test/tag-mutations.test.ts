// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { buildTagTree } from "@/lib/tag-tree";
import { planTagDeletion, planTagEdit, planTagMerge, tagTargetError } from "@/lib/tag-mutations";
import { makeTag, makeTagChain } from "./helpers/library-fixtures";

describe("tag edit planning", () => {
  test("depth_includes_subtree when moving to a level-four parent", () => {
    const tree = buildTagTree([...makeTagChain(["a", "b", "c"]), ...makeTagChain(["1", "2", "3", "4"])], "en");
    expect(tagTargetError(tree, "a", "4", "move")).toBe("depth");
    expect(planTagEdit(tree, "a", { parentId: "4" })).toEqual({ ok: false, error: "depth" });
    expect(tagTargetError(tree, "a", "2", "move")).toBeNull();
  });

  test("rejects self, descendant and nonexistent targets", () => {
    const tree = buildTagTree(makeTagChain(["a", "b", "c"]), "en");
    for (const operation of ["move", "merge"] as const) {
      expect(tagTargetError(tree, "a", "a", operation)).toBe("cycle");
      expect(tagTargetError(tree, "a", "c", operation)).toBe("cycle");
      expect(tagTargetError(tree, "a", "absent", operation)).toBe("invalid_parent");
      expect(tagTargetError(tree, "absent", "a", operation)).toBe("missing");
    }
    expect(tagTargetError(tree, "a", undefined, "move")).toBeNull();
    expect(tagTargetError(tree, "a", undefined, "merge")).toBe("invalid_parent");
  });

  test("checks trimmed sibling identity on rename and move", () => {
    const tree = buildTagTree([makeTag("a", "Go"), makeTag("b", "Rust"), makeTag("p", "Programming"), makeTag("c", "go", { parentId: "p" })], "en");
    expect(planTagEdit(tree, "b", { name: " GO " })).toEqual({ ok: false, error: "duplicate" });
    expect(planTagEdit(tree, "c", { parentId: undefined })).toEqual({ ok: false, error: "duplicate" });
    expect(planTagEdit(tree, "a", { parentId: "p" })).toEqual({ ok: false, error: "duplicate" });
    expect(planTagEdit(tree, "a", { name: " A/B " })).toEqual({ ok: false, error: "slash" });
    expect(planTagEdit(tree, "absent", {})).toEqual({ ok: false, error: "missing" });
  });

  test("plans trimmed edits without changing frozen records and skips no-ops", () => {
    const tag = Object.freeze(makeTag("a", "Go", { seq: 42 }));
    const tree = buildTagTree(Object.freeze([tag]), "en");
    expect(planTagEdit(tree, "a", { name: " Rust ", color: "red" })).toEqual({ ok: true, plan: { upserts: [{ ...tag, name: "Rust", color: "red", seq: 0 }], tombstones: [], replacements: new Map() } });
    expect(planTagEdit(tree, "a", { name: " Go " })).toEqual({ ok: true, plan: { upserts: [], tombstones: [], replacements: new Map() } });
    expect(tag.name).toBe("Go");
  });

  test("preserves legacy literal slash names when editing color or moving", () => {
    const tree = buildTagTree([makeTag("a", "Dev/Ops"), makeTag("p", "Work")], "en");
    const result = planTagEdit(tree, "a", { color: "red", parentId: "p" });
    if (!result.ok) { throw new Error(result.error); }
    expect(result.plan.upserts).toEqual([makeTag("a", "Dev/Ops", { color: "red", parentId: "p" })]);
  });

  test("an explicit move to root repairs an orphan without rewriting it for color edits", () => {
    const tree = buildTagTree([makeTag("a", "Legacy", { parentId: "missing", seq: 7 })], "en");
    const moved = planTagEdit(tree, "a", { parentId: undefined });
    if (!moved.ok) { throw new Error(moved.error); }
    expect(moved.plan.upserts).toEqual([makeTag("a", "Legacy", { parentId: undefined })]);
    const recolored = planTagEdit(tree, "a", { color: "red" });
    if (!recolored.ok) { throw new Error(recolored.error); }
    expect(recolored.plan.upserts).toEqual([makeTag("a", "Legacy", { parentId: "missing", color: "red" })]);
  });
});

describe("tag deletion planning", () => {
  test("delete_promotes_without_identity_loss and reserves unaffected names", () => {
    const tags = Object.freeze([makeTag("root", "Go"), makeTag("second", "Go (2)"), makeTag("p", "编程"), makeTag("child", "Go", { parentId: "p", color: "red", seq: 9 })].map(tag => Object.freeze(tag)));
    const result = planTagDeletion(buildTagTree(tags, "en"), ["p"], 100);
    if (!result.ok) { throw new Error(result.error); }
    expect(result.plan.upserts).toEqual([makeTag("child", "Go (3)", { parentId: undefined, color: "red", seq: 0 })]);
    expect(result.plan.tombstones).toEqual([makeTag("p", "编程", { deletedAt: 100 })]);
    expect([...result.plan.replacements]).toEqual([]);
    expect(tags[3]?.parentId).toBe("p");
  });

  test("allocates competing promoted suffixes in stable ID order ignoring case", () => {
    const tags = [makeTag("root", "GO"), makeTag("p", "P"), makeTag("q", "Q"), makeTag("z", "Go", { parentId: "p" }), makeTag("a", "go", { parentId: "q" })];
    const result = planTagDeletion(buildTagTree(tags, "en"), ["q", "p", "p"], 100);
    if (!result.ok) { throw new Error(result.error); }
    expect(result.plan.upserts.map(tag => [tag.id, tag.name, tag.parentId])).toEqual([["a", "go (2)", undefined], ["z", "Go (3)", undefined]]);
  });

  test("promotes through deleted chains to the closest surviving ancestor", () => {
    const tags = makeTagChain(["root", "a", "b", "c", "d"]);
    const result = planTagDeletion(buildTagTree(tags, "en"), ["a", "b"], 100);
    if (!result.ok) { throw new Error(result.error); }
    expect(result.plan.upserts).toEqual([makeTag("c", "c", { parentId: "root" })]);
    expect(result.plan.tombstones.map(tag => tag.id)).toEqual(["a", "b"]);
  });

  test("keeps Unicode promotion names within fifty code points", () => {
    const name = "😀".repeat(50);
    const tree = buildTagTree([makeTag("root", name), makeTag("p", "P"), makeTag("child", name, { parentId: "p" })], "en");
    const result = planTagDeletion(tree, ["p"], 100);
    if (!result.ok) { throw new Error(result.error); }
    expect(result.plan.upserts[0]?.name).toBe(`${"😀".repeat(46)} (2)`);
  });

  test("missing deletion targets reject the entire plan", () => {
    expect(planTagDeletion(buildTagTree([makeTag("a", "A")], "en"), ["a", "missing"], 1)).toEqual({ ok: false, error: "missing" });
    expect(planTagDeletion(buildTagTree([], "en"), [], 1)).toEqual({ ok: true, plan: { upserts: [], tombstones: [], replacements: new Map() } });
  });
});

describe("tag merge planning", () => {
  test("recursively coalesces siblings while preserving unmatched descendant IDs", () => {
    const tags = Object.freeze([
      makeTag("s", "Source"), makeTag("t", "Target", { color: "red" }),
      makeTag("sc", " Tools ", { parentId: "s" }), makeTag("tc", "tools", { parentId: "t" }),
      makeTag("sg", "CLI", { parentId: "sc" }), makeTag("tg", "cli", { parentId: "tc" }),
      makeTag("leaf", "Shell", { parentId: "sg", seq: 99 }), makeTag("unique", "Other", { parentId: "s" }),
    ].map(tag => Object.freeze(tag)));
    const result = planTagMerge(buildTagTree(tags, "en"), "s", "t", 100);
    if (!result.ok) { throw new Error(result.error); }
    expect([...result.plan.replacements]).toEqual([["s", "t"], ["sc", "tc"], ["sg", "tg"]]);
    expect(result.plan.tombstones.map(tag => [tag.id, tag.deletedAt, tag.seq])).toEqual([["s", 100, 0], ["sc", 100, 0], ["sg", 100, 0]]);
    expect(result.plan.upserts.map(tag => [tag.id, tag.parentId, tag.seq])).toEqual([["leaf", "tg", 0], ["unique", "t", 0]]);
    expect(tags[6]?.parentId).toBe("sg");
  });

  test("merge depth simulates coalescing instead of appending the source root", () => {
    const tree = buildTagTree([...makeTagChain(["1", "2", "3", "4", "5"]), makeTag("s", "Source"), makeTag("sc", "5", { parentId: "s" })], "en");
    expect(tagTargetError(tree, "s", "4", "move")).toBe("depth");
    expect(tagTargetError(tree, "s", "4", "merge")).toBeNull();
    const result = planTagMerge(tree, "s", "4", 1);
    if (!result.ok) { throw new Error(result.error); }
    expect([...result.plan.replacements]).toEqual([["s", "4"], ["sc", "5"]]);
    expect(result.plan.upserts).toEqual([]);
  });

  test("merge rejects unmatched child subtrees that would exceed depth five", () => {
    const tree = buildTagTree([...makeTagChain(["1", "2", "3", "4", "5"]), ...makeTagChain(["s", "child"])], "en");
    expect(tagTargetError(tree, "s", "5", "merge")).toBe("depth");
    expect(planTagMerge(tree, "s", "5", 1)).toEqual({ ok: false, error: "depth" });
  });

  test("can merge into an ancestor without deleting the surviving target", () => {
    const tree = buildTagTree(makeTagChain(["a", "b", "c"]), "en");
    const result = planTagMerge(tree, "b", "a", 1);
    if (!result.ok) { throw new Error(result.error); }
    expect(result.plan.tombstones.map(tag => tag.id)).toEqual(["b"]);
    expect(result.plan.upserts).toEqual([makeTag("c", "c", { parentId: "a" })]);
  });
});
