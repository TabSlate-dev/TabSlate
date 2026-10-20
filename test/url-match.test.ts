// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";
import { makeBookmark } from "./helpers/library-fixtures";

// Other test files register partial fakes for lib/bookmark-utils; load real copies.
const { strictUrlKey, looseUrlKey, findUrlMatches, siteSortKey } =
  await importFresh<typeof import("@/lib/url-match")>("lib/url-match.ts");
const { findDuplicateBookmark } =
  await importFresh<typeof import("@/lib/bookmark-utils")>("lib/bookmark-utils.ts");

describe("strictUrlKey", () => {
  const same: Array<[string, string]> = [
    ["HTTPS://Example.COM/Path", "https://example.com/Path"],
    ["https://example.com:443/a", "https://example.com/a"],
    ["HTTPS://alice:one@Example.COM:443/a", "https://alice:one@example.com/a"],
    ["http://example.com:80/a", "http://example.com/a"],
    ["https://example.com/docs/", "https://example.com/docs"],
    ["https://example.com/", "https://example.com"],
    ["  not a url ", "not a url"],
  ];
  const different: Array<[string, string]> = [
    ["https://bit.ly/3AbCd", "https://bit.ly/3abcd"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dqw4w9wgxcq"],
    ["https://app.example.com/#/inbox", "https://app.example.com/#/sent"],
    ["http://example.com/a", "https://example.com/a"],
    ["https://www.example.com/a", "https://example.com/a"],
    ["https://example.com:8443/a", "https://example.com/a"],
    ["https://alice:one@example.com/private", "https://bob:two@example.com/private"],
    ["https://alice:one@example.com/private", "https://example.com/private"],
    ["https://alice@example.com/private", "https://bob@example.com/private"],
  ];
  for (const [a, b] of same) {
    test(`treats ${a} and ${b} as the same address`, () => {
      expect(strictUrlKey(a)).toBe(strictUrlKey(b));
    });
  }
  for (const [a, b] of different) {
    test(`keeps ${a} and ${b} apart`, () => {
      expect(strictUrlKey(a)).not.toBe(strictUrlKey(b));
    });
  }
  test("lowercases only the scheme and host", () => {
    expect(strictUrlKey("HTTPS://Example.COM:443/Docs/?q=A#Top")).toBe("https://example.com/Docs?q=A#Top");
  });
});

describe("looseUrlKey", () => {
  const same: Array<[string, string]> = [
    ["http://example.com/a", "https://example.com/a"],
    ["https://www.example.com/a", "https://example.com/a"],
    ["https://example.com/a?utm_source=news&id=7", "https://example.com/a?id=7"],
    ["https://example.com/a?fbclid=abc", "https://example.com/a"],
    ["https://example.com/a#section", "https://example.com/a"],
    ["https://example.com/a/", "https://example.com/a"],
  ];
  const different: Array<[string, string]> = [
    ["https://bit.ly/3AbCd", "https://bit.ly/3abcd"],
    ["https://example.com/a?id=7", "https://example.com/a?id=8"],
    ["https://example.com/a", "https://example.org/a"],
    ["https://alice:one@example.com/a", "https://bob:two@example.com/a"],
    ["https://alice@example.com/a", "https://bob@example.com/a"],
  ];
  for (const [a, b] of same) {
    test(`treats ${a} and ${b} as the same page`, () => {
      expect(looseUrlKey(a)).toBe(looseUrlKey(b));
    });
  }
  for (const [a, b] of different) {
    test(`keeps ${a} and ${b} apart`, () => {
      expect(looseUrlKey(a)).not.toBe(looseUrlKey(b));
    });
  }
  test("drops the scheme, www, fragment and tracking parameters", () => {
    expect(looseUrlKey("http://www.Example.com/Docs/?utm_medium=x&q=A#top")).toBe("example.com/Docs?q=A");
  });
});

describe("findUrlMatches", () => {
  const bookmarks = [
    makeBookmark("exact", { url: "https://example.com/post" }),
    makeBookmark("tracked", { url: "http://www.example.com/post?utm_source=feed" }),
    makeBookmark("other", { url: "https://example.com/other" }),
  ];
  test("the strict tier only finds the same address", () => {
    expect(findUrlMatches("https://example.com/post/", bookmarks, "strict").map((b) => b.id)).toEqual(["exact"]);
  });
  test("the loose tier also finds scheme, www and tracking variants", () => {
    expect(findUrlMatches("https://example.com/post", bookmarks, "loose").map((b) => b.id)).toEqual(["exact", "tracked"]);
  });
});

describe("findDuplicateBookmark", () => {
  test("does not treat links that differ only in path case as duplicates", () => {
    const shortLink = makeBookmark("short", { url: "https://bit.ly/3AbCd" });
    expect(findDuplicateBookmark([shortLink], "https://bit.ly/3abcd")).toBeUndefined();
  });
  test("still matches the same address with a different host case and trailing slash", () => {
    const docs = makeBookmark("docs", { url: "https://Example.com/docs/" });
    expect(findDuplicateBookmark([docs], "https://example.com/docs")?.id).toBe("docs");
  });
});

describe("siteSortKey", () => {
  test("lowercases the host and drops a leading www.", () => {
    expect(siteSortKey("https://WWW.Example.com/Path")).toBe("example.com");
  });
  test("keeps subdomains apart", () => {
    expect(siteSortKey("https://docs.example.com")).toBe("docs.example.com");
  });
  test("returns null for an address that is not a web URL", () => {
    expect(siteSortKey("chrome://extensions")).toBeNull();
    expect(siteSortKey("not a url")).toBeNull();
  });
});
