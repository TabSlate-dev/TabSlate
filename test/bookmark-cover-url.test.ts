// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { MAX_BOOKMARK_IMAGE_URL_LENGTH, normalizeCoverUrl } from "@/lib/bookmark-utils";

describe("normalizeCoverUrl", () => {
  test("resolves relative and protocol-relative covers against the page", () => {
    expect(normalizeCoverUrl("/img/cover.png", "https://example.com/post/1")).toBe("https://example.com/img/cover.png");
    expect(normalizeCoverUrl("cover.png", "https://example.com/post/1")).toBe("https://example.com/post/cover.png");
    expect(normalizeCoverUrl("//cdn.example.com/a.jpg", "https://example.com/")).toBe("https://cdn.example.com/a.jpg");
  });

  test("keeps absolute http and https covers in their serialized form", () => {
    expect(normalizeCoverUrl("http://example.com/a.jpg", "https://example.com/")).toBe("http://example.com/a.jpg");
    expect(normalizeCoverUrl("  https://example.com/a b.png  ", "")).toBe("https://example.com/a%20b.png");
  });

  test("drops other schemes, data URIs and empty values", () => {
    expect(normalizeCoverUrl("javascript:alert(1)", "https://example.com/")).toBeUndefined();
    expect(normalizeCoverUrl("data:image/png;base64,AAAA", "https://example.com/")).toBeUndefined();
    expect(normalizeCoverUrl("ftp://example.com/a.png", "https://example.com/")).toBeUndefined();
    expect(normalizeCoverUrl("   ", "https://example.com/")).toBeUndefined();
  });

  test("drops a relative cover when the page URL does not parse", () => {
    expect(normalizeCoverUrl("/img/cover.png", "")).toBeUndefined();
  });

  test("accepts covers up to the length limit", () => {
    const prefix = "https://example.com/";
    const atLimit = prefix + "a".repeat(MAX_BOOKMARK_IMAGE_URL_LENGTH - prefix.length);
    expect(normalizeCoverUrl(atLimit, "")).toBe(atLimit);
    expect(normalizeCoverUrl(`${atLimit}a`, "")).toBeUndefined();
  });
});
