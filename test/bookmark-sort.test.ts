// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";
import { makeBookmark } from "./helpers/library-fixtures";

// Other test files register partial fakes for lib/bookmark-utils; load a real copy.
const { sortBookmarks } = await importFresh<typeof import("@/lib/bookmark-utils")>("lib/bookmark-utils.ts");

const ids = (bookmarks: ReturnType<typeof sortBookmarks>) => bookmarks.map((bookmark) => bookmark.id);

describe("sortBookmarks by edit time", () => {
  const bookmarks = [
    makeBookmark("old-edit", { createdAt: "2026-01-05T00:00:00.000Z", updatedAt: Date.parse("2026-01-06T00:00:00.000Z") }),
    makeBookmark("never-edited", { createdAt: "2026-01-07T00:00:00.000Z" }),
    makeBookmark("recent-edit", { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: Date.parse("2026-01-09T00:00:00.000Z") }),
    makeBookmark("tie-b", { updatedAt: 1 }),
    makeBookmark("tie-a", { updatedAt: 1 }),
  ];

  test("newest first falls back to the creation time and breaks ties by ID", () => {
    expect(ids(sortBookmarks(bookmarks, "updated-newest"))).toEqual(["recent-edit", "never-edited", "old-edit", "tie-a", "tie-b"]);
  });

  test("oldest first reverses the times and still breaks ties by ID", () => {
    expect(ids(sortBookmarks(bookmarks, "updated-oldest"))).toEqual(["tie-a", "tie-b", "old-edit", "never-edited", "recent-edit"]);
  });
});

describe("sortBookmarks by website", () => {
  test("orders by host without www., then title, then ID, with unparseable addresses last", () => {
    const bookmarks = [
      makeBookmark("note", { title: "Note", url: "notes:offline" }),
      makeBookmark("docs", { title: "Docs", url: "https://docs.example.com/a" }),
      makeBookmark("www-b", { title: "B", url: "https://www.example.com/b" }),
      makeBookmark("apex-a", { title: "A", url: "http://EXAMPLE.com/a" }),
      makeBookmark("alpha", { title: "Z", url: "https://alpha.dev" }),
      makeBookmark("same-2", { title: "Same", url: "https://example.com/2" }),
      makeBookmark("same-1", { title: "Same", url: "https://example.com/1" }),
    ];
    expect(ids(sortBookmarks(bookmarks, "site-az"))).toEqual(["alpha", "docs", "apex-a", "www-b", "same-1", "same-2", "note"]);
  });

  test("returns a sorted copy", () => {
    const bookmarks = [makeBookmark("b", { url: "https://b.example" }), makeBookmark("a", { url: "https://a.example" })];
    const sorted = sortBookmarks(bookmarks, "site-az");
    expect(sorted).not.toBe(bookmarks);
    expect(ids(bookmarks)).toEqual(["b", "a"]);
  });
});

describe("sortBookmarks existing orders", () => {
  const bookmarks = [
    makeBookmark("b", { title: "Same", createdAt: "1767398400000" }),
    makeBookmark("a", { title: "Same", createdAt: "2026-01-03T00:00:00.000Z" }),
    makeBookmark("old", { title: "Zebra", createdAt: "2026-01-01T00:00:00.000Z" }),
  ];

  test("keeps creation dates and the existing tie direction for each date order", () => {
    expect(ids(sortBookmarks(bookmarks, "date-newest"))).toEqual(["a", "b", "old"]);
    expect(ids(sortBookmarks(bookmarks, "date-oldest"))).toEqual(["old", "b", "a"]);
  });

  test("orders titles in both directions with ascending ID ties", () => {
    expect(ids(sortBookmarks(bookmarks, "alpha-az"))).toEqual(["a", "b", "old"]);
    expect(ids(sortBookmarks(bookmarks, "alpha-za"))).toEqual(["old", "a", "b"]);
  });

  test("edit-time fallback accepts epoch-string creation times and preserves an explicit zero", () => {
    const entries = [
      makeBookmark("legacy", { createdAt: "1767398400000" }),
      makeBookmark("iso", { createdAt: "2026-01-02T00:00:00.000Z" }),
      makeBookmark("zero", { createdAt: "2026-01-04T00:00:00.000Z", updatedAt: 0 }),
    ];
    expect(ids(sortBookmarks(entries, "updated-newest"))).toEqual(["legacy", "iso", "zero"]);
    expect(ids(sortBookmarks(entries, "updated-oldest"))).toEqual(["zero", "iso", "legacy"]);
  });
});
