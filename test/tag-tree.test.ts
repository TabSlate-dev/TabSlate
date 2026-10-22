// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { buildTagTree, displayTagPath, expandTagSelection, resolveTagPath, searchTagPaths, tagAncestors, tagDescendants, tagPath } from "@/lib/tag-tree";
import { makeTag, makeTagChain } from "./helpers/library-fixtures";

describe("tag graph", () => {
  test("legacy_graph_is_finite without rewriting orphan or cyclic inputs", () => {
    const tags = Object.freeze([
      makeTag("B", "Beta", { parentId: "A" }),
      makeTag("A", "Alpha", { parentId: "B" }),
      makeTag("orphan", "Orphan", { parentId: "missing" }),
      makeTag("dead", "Deleted", { deletedAt: 1 }),
      makeTag("child", "Child", { parentId: "dead" }),
      makeTag("self", "Self", { parentId: "self" }),
    ].map(tag => Object.freeze(tag)));
    const tree = buildTagTree(tags, "en");
    expect(tree.roots).toEqual(["A", "child", "orphan", "self"]);
    expect(tree.tagsById.has("dead")).toBe(false);
    expect(tagAncestors(tree, "B")).toEqual(["A"]);
    expect([...tagDescendants(tree, "A")]).toEqual(["A", "B"]);
    expect(tags[1]?.parentId).toBe("B");
    expect(tags[4]?.parentId).toBe("dead");
  });

  test("sorts display siblings by locale with stable ID ties", () => {
    const tree = buildTagTree([makeTag("z", "Alpha"), makeTag("a", "alpha"), makeTag("b", "Beta")], "en");
    expect(tree.locale).toBe("en");
    expect(tree.roots).toEqual(["a", "z", "b"]);
    expect(buildTagTree([makeTag("a", "ä"), makeTag("z", "z")], "sv").roots).toEqual(["z", "a"]);
  });

  test("paths and selection preserve literal legacy slash names", () => {
    const tree = buildTagTree([makeTag("p", "编程/工具"), makeTag("c", "后端", { parentId: "p" }), makeTag("g", "Go", { parentId: "c" })], "zh-CN");
    expect(tagAncestors(tree, "g")).toEqual(["p", "c"]);
    expect(tagPath(tree, "g").map(tag => tag.id)).toEqual(["p", "c", "g"]);
    expect(displayTagPath(tree, "g")).toBe("编程/工具 › 后端 › Go");
    expect([...expandTagSelection(tree, ["p", "c", "p", "missing"])]).toEqual(["p", "c", "g"]);
    expect(tagAncestors(tree, "missing")).toEqual([]);
    expect([...tagDescendants(tree, "missing")]).toEqual([]);
    expect(tagPath(tree, "missing")).toEqual([]);
    expect(displayTagPath(tree, "missing")).toBe("");
  });
});

describe("resolveTagPath", () => {
  test("path_reuses_siblings and creates only missing levels with inherited colors", () => {
    let serial = 0;
    const result = resolveTagPath(buildTagTree([], "en"), "编程/后端/Go", undefined, "blue", () => String(++serial));
    if (!result.ok) { throw new Error(result.error); }
    expect(result.created.map(tag => [tag.name, tag.parentId])).toEqual([["编程", undefined], ["后端", "1"], ["Go", "2"]]);
    expect(result.leaf.id).toBe("3");
    expect(result.created.map(tag => [tag.color, tag.seq])).toEqual([["blue", 0], ["blue", 0], ["blue", 0]]);
    const tree = buildTagTree(result.created.map(tag => Object.freeze(tag)), "en");
    const reused = resolveTagPath(tree, " 编程 / 后端 / go ", undefined, "red", () => String(++serial));
    if (!reused.ok) { throw new Error(reused.error); }
    expect(reused.leaf.id).toBe("3");
    expect(reused.created).toEqual([]);
    const added = resolveTagPath(tree, "编程/后端/Rust", undefined, "red", () => String(++serial));
    if (!added.ok) { throw new Error(added.error); }
    expect(added.created).toEqual([makeTag("4", "Rust", { parentId: "2", color: "blue" })]);
  });

  test("creates relative paths using the selected parent color", () => {
    const tree = buildTagTree([makeTag("p", "Programming", { color: "purple" })], "en");
    let serial = 0;
    const result = resolveTagPath(tree, "Tools/CLI", "p", "red", () => `new${++serial}`);
    if (!result.ok) { throw new Error(result.error); }
    expect(result.created.map(tag => [tag.name, tag.parentId, tag.color])).toEqual([["Tools", "p", "purple"], ["CLI", "new1", "purple"]]);
    expect(tree.tagsById.size).toBe(1);
  });

  test("identity ignores case and spaces but retains accents", () => {
    const tree = buildTagTree([makeTag("a", " Read "), makeTag("b", "Résumé")], "tr");
    const result = resolveTagPath(tree, "read", undefined, "blue", () => "new");
    if (!result.ok) { throw new Error(result.error); }
    expect(result.leaf.id).toBe("a");
    const distinct = resolveTagPath(tree, "Resume", undefined, "blue", () => "new");
    if (!distinct.ok) { throw new Error(distinct.error); }
    expect(distinct.created.map(tag => tag.name)).toEqual(["Resume"]);
  });

  test("rejects empty paths and empty segments", () => {
    for (const input of ["", "   "]) {
      expect(resolveTagPath(buildTagTree([], "en"), input, undefined, "blue", () => "new")).toEqual({ ok: false, error: "empty" });
    }
    for (const input of ["/Go", "Go/", "Go//Tools", "Go/ /Tools"]) {
      expect(resolveTagPath(buildTagTree([], "en"), input, undefined, "blue", () => "new")).toEqual({ ok: false, error: "empty_segment" });
    }
  });

  test("validates the entire path before allocating IDs", () => {
    let calls = 0;
    const result = resolveTagPath(buildTagTree([], "en"), `Good/${"x".repeat(51)}`, undefined, "blue", () => String(++calls));
    expect(result).toEqual({ ok: false, error: "too_long" });
    expect(calls).toBe(0);
  });

  test("counts the relative parent in the five-level limit", () => {
    const tree = buildTagTree(makeTagChain(["1", "2", "3", "4"]), "en");
    expect(resolveTagPath(tree, "5/6", "4", "blue", () => "new")).toEqual({ ok: false, error: "depth" });
    const allowed = resolveTagPath(tree, "5", "4", "blue", () => "5");
    expect(resolveTagPath(tree, "5", "4", "blue", () => "5")).toHaveProperty("ok", true);
    expect(resolveTagPath(tree, "X", "missing", "blue", () => "new")).toEqual({ ok: false, error: "invalid_parent" });
  });
});

describe("searchTagPaths", () => {
  test("ranks exact leaves before path-only matches and distinguishes identical leaves by full path", () => {
    const tags = [
      makeTag("go_root", "Go"),
      makeTag("tools", "Tools", { parentId: "go_root" }),
      makeTag("db", "Database"),
      makeTag("go_db", "Go", { parentId: "db" }),
      makeTag("dev", "编程"),
      makeTag("backend", "后端", { parentId: "dev" }),
      makeTag("go_backend", "Go", { parentId: "backend" }),
    ];
    const tree = buildTagTree(tags, "en");
    const results = searchTagPaths(tree, "Go");
    expect(results.map(t => t.id)).toEqual(["go_db", "go_root", "go_backend", "tools"]);
  });

  test("matches slash-separated input against corresponding path segments and resolves existing levels", () => {
    const tags = [
      makeTag("dev", "编程"),
      makeTag("backend", "后端", { parentId: "dev" }),
      makeTag("go", "Go", { parentId: "backend" }),
    ];
    const tree = buildTagTree(tags, "zh-CN");
    const results = searchTagPaths(tree, "编程/后端/Go");
    expect(results.map(t => t.id)).toEqual(["go"]);
  });

  test("preserves searchability of legacy tags with literal slashes", () => {
    const tags = [
      makeTag("legacy", "编程/工具"),
      makeTag("other", "其他"),
    ];
    const tree = buildTagTree(tags, "zh-CN");
    expect(searchTagPaths(tree, "编程/工具").map(t => t.id)).toEqual(["legacy"]);
    expect(searchTagPaths(tree, "工具").map(t => t.id)).toEqual(["legacy"]);
  });
});
