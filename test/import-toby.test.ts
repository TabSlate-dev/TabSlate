// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { buildTobyImportPlan, type TobyImport } from "@/lib/import-toby";
import type { ImportTagOptions } from "@/lib/import-types";
import type { Tag } from "@/lib/types";

const SAMPLE_TOBY: TobyImport = {
  version: 3,
  lists: [
    {
      title: "Work List",
      cards: [
        { title: "Task 1", url: "https://example.com/task1" },
        { title: "Task 2", url: "https://example.com/task2" },
      ],
      labels: ["dev/ops", "reading"],
    },
  ],
};

const emptyTags: Tag[] = [];

describe("buildTobyImportPlan", () => {
  test("reuses existing literal top-level Toby labels by name first, including legacy /", () => {
    const existingTags: Tag[] = [
      { id: "tag-slash", name: "dev/ops", parentId: undefined, color: "blue", seq: 1 },
    ];
    const tagOptions: ImportTagOptions = {
      enabled: true,
      rootName: "Toby import 2026-10-21",
      existingTags,
      availableTags: -1,
    };

    const plan = buildTobyImportPlan(
      SAMPLE_TOBY,
      "ws-1",
      new Set(),
      existingTags,
      false,
      0,
      tagOptions,
    );

    // dev/ops should be reused (tag-slash), reading should be created as reading
    const bm = plan.bookmarks[0];
    expect(bm.tags).toContain("tag-slash");

    // Only reading and the provenance root tag should be newly created in plan.tags
    const devOpsCreated = plan.tags.find(t => t.id === "tag-slash");
    expect(devOpsCreated).toBeUndefined(); // Reused tag is not in plan.tags (only new tags are in plan.tags)
    expect(plan.tags.some(t => t.name === "reading")).toBe(true);
  });

  test("existing nested labels with the same name are not Toby reuse targets", () => {
    const existingTags: Tag[] = [
      { id: "nested-reading", name: "reading", parentId: "parent-1", color: "blue", seq: 1 },
    ];
    const tagOptions: ImportTagOptions = {
      enabled: true,
      rootName: "Toby import 2026-10-21",
      existingTags,
      availableTags: -1,
    };

    const plan = buildTobyImportPlan(
      SAMPLE_TOBY,
      "ws-1",
      new Set(),
      existingTags,
      false,
      0,
      tagOptions,
    );

    const bm = plan.bookmarks[0];
    expect(bm.tags).not.toContain("nested-reading");
    const readingTag = plan.tags.find(t => t.name === "reading");
    expect(readingTag).toBeDefined();
    expect(readingTag?.id).not.toBe("nested-reading");
    expect(readingTag?.parentId).toBeUndefined();
  });

  test("mandatory Toby label tags are reserved first; if optional root cannot fit, mode is none", () => {
    // 2 mandatory labels: "dev/ops" (becomes "dev／ops") and "reading".
    // availableTags: 2 -> exactly enough for mandatory labels, 0 left for optional root.
    const tagOptions: ImportTagOptions = {
      enabled: true,
      rootName: "Toby import 2026-10-21",
      existingTags: emptyTags,
      availableTags: 2,
    };

    const plan = buildTobyImportPlan(
      SAMPLE_TOBY,
      "ws-1",
      new Set(),
      emptyTags,
      false,
      0,
      tagOptions,
    );

    expect(plan.provenance?.mode).toBe("none");
    expect(plan.tags).toHaveLength(2); // Only the 2 mandatory labels
    expect(plan.tags.some(t => t.name.startsWith("Toby import"))).toBe(false);

    // Bookmarks carry the 2 mandatory label tags, but no root tag
    const bm = plan.bookmarks[0];
    expect(bm.tags).toHaveLength(2);
  });

  test("mandatory labels exceeding available tags are not partially applied", () => {
    // 2 mandatory labels, but only 1 available tag slot
    const tagOptions: ImportTagOptions = {
      enabled: true,
      rootName: "Toby import 2026-10-21",
      existingTags: emptyTags,
      availableTags: 1,
    };

    const plan = buildTobyImportPlan(
      SAMPLE_TOBY,
      "ws-1",
      new Set(),
      emptyTags,
      false,
      0,
      tagOptions,
    );

    // Both mandatory tags must be present in plan.tags so quota check can fail atomically
    expect(plan.tags.length).toBeGreaterThanOrEqual(2);
  });

  test("when space allows, bookmarks carry mandatory labels and provenance root tag", () => {
    const tagOptions: ImportTagOptions = {
      enabled: true,
      rootName: "Toby import 2026-10-21",
      existingTags: emptyTags,
      availableTags: -1,
    };

    const plan = buildTobyImportPlan(
      SAMPLE_TOBY,
      "ws-1",
      new Set(),
      emptyTags,
      false,
      0,
      tagOptions,
    );

    expect(plan.provenance?.mode).toBe("full");
    const rootTag = plan.tags.find(t => t.id === plan.provenance?.rootTagId);
    expect(rootTag).toBeDefined();

    const bm = plan.bookmarks[0];
    expect(bm.tags).toContain(rootTag!.id);
    expect(bm.tags).toHaveLength(3); // 2 labels + 1 root
  });

  test("calling without tagOptions preserves prior behavior", () => {
    const plan = buildTobyImportPlan(SAMPLE_TOBY, "ws-1", new Set(), emptyTags, false);

    expect(plan.provenance).toBeUndefined();
    // 2 mandatory label tags
    expect(plan.tags).toHaveLength(2);
    const bm = plan.bookmarks[0];
    expect(bm.tags).toHaveLength(2);
  });

  test("empty label yields supplied localized untitledLabel", () => {
    const tobyWithEmpty: TobyImport = {
      version: 3,
      lists: [
        {
          title: "List",
          cards: [{ title: "Task", url: "https://example.com/task" }],
          labels: ["   "],
        },
      ],
    };
    const tagOptions: ImportTagOptions = {
      enabled: true,
      rootName: "Toby import 2026-10-21",
      existingTags: emptyTags,
      availableTags: -1,
      untitledLabel: "未命名",
    };

    const plan = buildTobyImportPlan(tobyWithEmpty, "ws-1", new Set(), emptyTags, false, 0, tagOptions);

    expect(plan.tags.some(t => t.name === "未命名")).toBe(true);
  });
});
