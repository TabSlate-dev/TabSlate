// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { linkifySegments } from "@/lib/linkify";

describe("linkifySegments", () => {
  test("turns http and https addresses into links and leaves sentence punctuation outside", () => {
    expect(linkifySegments("Read https://example.com/docs. Then (see http://a.example/x?y=1)!")).toEqual([
      { kind: "text", text: "Read " },
      { kind: "link", text: "https://example.com/docs" },
      { kind: "text", text: ". Then (see " },
      { kind: "link", text: "http://a.example/x?y=1" },
      { kind: "text", text: ")!" },
    ]);
  });

  test("keeps text without links, and other schemes, as text", () => {
    expect(linkifySegments("javascript:alert(1) and ftp://files.example")).toEqual([
      { kind: "text", text: "javascript:alert(1) and ftp://files.example" },
    ]);
  });

  test("returns nothing for an empty note", () => {
    expect(linkifySegments("")).toEqual([]);
  });
});
