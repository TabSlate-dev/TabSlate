// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { addImportTags } from "@/lib/import-tags";
import type { ImportPlan, ImportTagOptions } from "@/lib/import-types";
import { buildTagTree, displayTagPath } from "@/lib/tag-tree";
import type { Tag } from "@/lib/types";

function createBasePlan(options?: { bookmarkCount?: number }): ImportPlan {
  const bookmarkCount = options?.bookmarkCount ?? 1;
  const bookmarks = Array.from({ length: bookmarkCount }, (_, index) => ({
    id: `b-${index + 1}`,
    collectionId: "col-1",
    title: `Bookmark ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    description: "",
    favicon: "",
    tags: [] as string[],
    createdAt: "2026-10-21T00:00:00.000Z",
    isFavorite: false,
  }));

  return {
    collections: [
      { id: "col-1", workspaceId: "ws-1", name: "开发", icon: "", position: 0 },
    ],
    bookmarks,
    tags: [],
    duplicatesSkipped: 0,
    rejectedUrls: [],
  };
}

describe("addImportTags", () => {
  test("chrome_falls_back_to_root", () => {
    const basePlan = createBasePlan({ bookmarkCount: 2 });
    const pathsByBookmarkId = new Map<string, readonly string[]>([
      ["b-1", ["前端", "React"]],
      ["b-2", ["前端", "Vue"]],
    ]);
    const options: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: 1,
    };

    const plan = addImportTags(basePlan, "chrome", pathsByBookmarkId, options);

    expect(plan.provenance?.mode).toBe("root-only");
    expect(plan.tags).toHaveLength(1);
    expect(plan.bookmarks.every(bookmark => bookmark.tags.length === 1 && bookmark.tags[0] === plan.provenance?.rootTagId)).toBe(true);
    expect(plan.provenance?.requestedTagCount).toBeGreaterThan(1);
  });

  test("mode none when zero available", () => {
    const basePlan = createBasePlan({ bookmarkCount: 2 });
    const pathsByBookmarkId = new Map<string, readonly string[]>([
      ["b-1", ["前端", "React"]],
      ["b-2", ["前端", "Vue"]],
    ]);
    const options: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: 0,
    };

    const plan = addImportTags(basePlan, "chrome", pathsByBookmarkId, options);

    expect(plan.provenance?.mode).toBe("none");
    expect(plan.tags).toHaveLength(0);
    expect(plan.bookmarks.every(bookmark => bookmark.tags.length === 0)).toBe(true);
  });

  test("mode full when unlimited or sufficient", () => {
    const basePlan = createBasePlan({ bookmarkCount: 1 });
    const pathsByBookmarkId = new Map<string, readonly string[]>([
      ["b-1", ["前端", "React"]],
    ]);
    const options: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: -1,
    };

    const plan = addImportTags(basePlan, "chrome", pathsByBookmarkId, options);

    expect(plan.provenance?.mode).toBe("full");
    expect(plan.provenance?.requestedTagCount).toBe(4); // root, 开发, 前端, React
    expect(plan.tags).toHaveLength(4);

    const tree = buildTagTree(plan.tags as Tag[], "en");
    const leafTagId = plan.bookmarks[0].tags[0];
    expect(displayTagPath(tree, leafTagId)).toBe("Chrome import 2026-10-21 › 开发 › 前端 › React");
  });

  test("allocates a unique root against effective top-level tags using trimmed/case-insensitive comparison", () => {
    const basePlan = createBasePlan({ bookmarkCount: 1 });
    const pathsByBookmarkId = new Map<string, readonly string[]>([["b-1", []]]);
    const existingTags: Tag[] = [
      { id: "existing-root", name: "  chrome import 2026-10-21  ", parentId: undefined, color: "blue", seq: 1 },
    ];
    const options: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags,
      availableTags: -1,
    };

    const plan = addImportTags(basePlan, "chrome", pathsByBookmarkId, options);

    const rootTag = plan.tags.find(t => t.id === plan.provenance?.rootTagId);
    expect(rootTag?.name).toBe("Chrome import 2026-10-21 (2)");
  });

  test("literal slash in segment is replaced with full-width slash", () => {
    const basePlan = createBasePlan({ bookmarkCount: 1 });
    const pathsByBookmarkId = new Map<string, readonly string[]>([["b-1", ["CI/CD"]]]);
    const options: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: -1,
    };

    const plan = addImportTags(basePlan, "chrome", pathsByBookmarkId, options);

    const tag = plan.tags.find(t => t.name === "CI／CD");
    expect(tag).toBeDefined();
    expect(tag?.name.includes("/")).toBe(false);
  });

  test("empty segment becomes localized Untitled", () => {
    const basePlan = createBasePlan({ bookmarkCount: 1 });
    const pathsByBookmarkId = new Map<string, readonly string[]>([["b-1", ["   "]]]);
    const options: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: -1,
    };

    const plan = addImportTags(basePlan, "chrome", pathsByBookmarkId, options);

    const tag = plan.tags.find(t => t.name === "Untitled");
    expect(tag).toBeDefined();
  });

  test("limits newly created segments to 50 Unicode code points with suffix space", () => {
    const longName1 = "A".repeat(60);
    const longName2 = "A".repeat(50) + "B";
    const basePlan = createBasePlan({ bookmarkCount: 2 });
    const pathsByBookmarkId = new Map<string, readonly string[]>([
      ["b-1", [longName1]],
      ["b-2", [longName2]],
    ]);
    const options: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: -1,
    };

    const plan = addImportTags(basePlan, "chrome", pathsByBookmarkId, options);

    const createdSegmentTags = plan.tags.filter(t => t.id !== plan.provenance?.rootTagId && t.name !== "开发");
    expect(createdSegmentTags).toHaveLength(2);
    for (const tag of createdSegmentTags) {
      expect(Array.from(tag.name).length).toBeLessThanOrEqual(50);
    }
    expect(createdSegmentTags.some(t => t.name.endsWith(" (2)"))).toBe(true);
  });

  test("different original folder names normalizing to same allocate distinct suffixed names", () => {
    const basePlan = createBasePlan({ bookmarkCount: 2 });
    const pathsByBookmarkId = new Map<string, readonly string[]>([
      ["b-1", ["dev/ops"]],
      ["b-2", ["dev／ops"]],
    ]);
    const options: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: -1,
    };

    const plan = addImportTags(basePlan, "chrome", pathsByBookmarkId, options);

    const tagNames = plan.tags.map(t => t.name);
    expect(tagNames).toContain("dev／ops");
    expect(tagNames).toContain("dev／ops (2)");
  });

  test("equivalent original sibling names coalesce", () => {
    const basePlan = createBasePlan({ bookmarkCount: 2 });
    const pathsByBookmarkId = new Map<string, readonly string[]>([
      ["b-1", ["React"]],
      ["b-2", ["react"]],
    ]);
    const options: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: -1,
    };

    const plan = addImportTags(basePlan, "chrome", pathsByBookmarkId, options);

    const reactTags = plan.tags.filter(t => t.name.toLowerCase() === "react");
    expect(reactTags).toHaveLength(1);
    expect(plan.bookmarks[0].tags[0]).toBe(plan.bookmarks[1].tags[0]);
  });

  test("depth beyond five maps to the level-five ancestor", () => {
    const basePlan = createBasePlan({ bookmarkCount: 1 });
    // Root = 1, col 开发 = 2, f1 = 3, f2 = 4, f3 = 5, f4 = 6, f5 = 7
    const pathsByBookmarkId = new Map<string, readonly string[]>([
      ["b-1", ["f1", "f2", "f3", "f4", "f5"]],
    ]);
    const options: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: -1,
    };

    const plan = addImportTags(basePlan, "chrome", pathsByBookmarkId, options);

    const tree = buildTagTree(plan.tags as Tag[], "en");
    const leafTagId = plan.bookmarks[0].tags[0];
    expect(displayTagPath(tree, leafTagId)).toBe("Chrome import 2026-10-21 › 开发 › f1 › f2 › f3");
    expect(plan.tags.some(t => t.name === "f4")).toBe(false);
    expect(plan.tags.some(t => t.name === "f5")).toBe(false);
  });

  test("option off preserves previous plan and adds no provenance", () => {
    const basePlan = createBasePlan({ bookmarkCount: 1 });
    const pathsByBookmarkId = new Map<string, readonly string[]>([["b-1", ["前端"]]]);
    const options: ImportTagOptions = {
      enabled: false,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: 10,
    };

    const plan = addImportTags(basePlan, "chrome", pathsByBookmarkId, options);

    expect(plan.provenance).toBeUndefined();
    expect(plan.tags).toHaveLength(0);
    expect(plan.bookmarks[0].tags).toHaveLength(0);
  });
});
