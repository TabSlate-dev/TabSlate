// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";
import { makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const { findVisibleDuplicates } =
  await importFresh<typeof import("@/lib/duplicate-lookup")>("lib/duplicate-lookup.ts");

const POST = "https://example.com/post";
const library = {
  workspaces: [makeWorkspace("home"), makeWorkspace("work"), makeWorkspace("retired", { deletedAt: 1 })],
  collections: [
    makeCollection("reading", "home"),
    makeCollection("old", "home", { archivedAt: 1 }),
    makeCollection("binned", "home", { deletedAt: 1 }),
    makeCollection("projects", "work"),
    makeCollection("hidden", "retired"),
  ],
  bookmarks: [
    makeBookmark("in-reading", { collectionId: "reading", url: POST }),
    makeBookmark("in-archived-collection", { collectionId: "old", url: POST }),
    makeBookmark("in-trashed-collection", { collectionId: "binned", url: POST }),
    makeBookmark("in-projects", { collectionId: "projects", url: "http://www.example.com/post?utm_source=feed" }),
    makeBookmark("in-retired-workspace", { collectionId: "hidden", url: POST }),
    makeBookmark("uncategorized", { collectionId: "", url: POST }),
    makeBookmark("different-page", { collectionId: "reading", url: "https://example.com/other" }),
  ],
};

describe("findVisibleDuplicates", () => {
  test("returns visible matches with their location", () => {
    const matches = findVisibleDuplicates(POST, library, "loose");
    expect(matches.map((m) => [m.bookmark.id, m.collection?.id ?? null, m.workspace?.id ?? null])).toEqual([
      ["in-reading", "reading", "home"],
      ["in-projects", "projects", "work"],
      ["uncategorized", null, null],
    ]);
  });

  test("the strict tier skips scheme and tracking variants", () => {
    expect(findVisibleDuplicates(POST, library, "strict").map((m) => m.bookmark.id)).toEqual([
      "in-reading",
      "uncategorized",
    ]);
  });

  test("can be limited to one workspace plus uncategorized bookmarks", () => {
    expect(
      findVisibleDuplicates(POST, library, "loose", { workspaceId: "work" }).map((m) => m.bookmark.id),
    ).toEqual(["in-projects", "uncategorized"]);
  });
});
