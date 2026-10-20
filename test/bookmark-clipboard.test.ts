// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { formatLinkList, formatMarkdownLinkList } from "@/lib/bookmark-clipboard";

describe("bookmark link lists", () => {
  test("plain links are one URL per line", () => {
    expect(formatLinkList([{ url: "https://a.example" }, { url: "https://b.example/x" }])).toBe("https://a.example\nhttps://b.example/x");
  });

  test("a Markdown list escapes link text and percent-encodes the characters that end a link target", () => {
    expect(formatMarkdownLinkList([
      { title: "Docs [beta] \\ notes", url: "https://example.com/a b(c)" },
      { title: "Line one\nLine two\r\nLine three", url: "https://example.com/x" },
    ])).toBe(
      "- [Docs \\[beta\\] \\\\ notes](https://example.com/a%20b%28c%29)\n" +
      "- [Line one Line two Line three](https://example.com/x)",
    );
  });
});
