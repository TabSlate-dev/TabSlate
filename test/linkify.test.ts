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

  test("keeps balanced parentheses in a URL followed by sentence punctuation", () => {
    expect(linkifySegments("Read https://en.wikipedia.org/wiki/Function_(mathematics).")).toEqual([
      { kind: "text", text: "Read " },
      { kind: "link", text: "https://en.wikipedia.org/wiki/Function_(mathematics)" },
      { kind: "text", text: "." },
    ]);
  });

  test("keeps nested parentheses but trims unmatched wrapping parentheses and sentence punctuation", () => {
    expect(linkifySegments("(See https://example.com/a_(b_(c))). Next https://example.com/docs))!?;")).toEqual([
      { kind: "text", text: "(See " },
      { kind: "link", text: "https://example.com/a_(b_(c))" },
      { kind: "text", text: "). Next " },
      { kind: "link", text: "https://example.com/docs" },
      { kind: "text", text: "))!?;" },
    ]);
  });

  test("does not mistake an earlier unmatched parenthesis for the balanced closing parenthesis at the end", () => {
    expect(linkifySegments("https://example.com/a)b(c).")).toEqual([
      { kind: "link", text: "https://example.com/a)b(c)" },
      { kind: "text", text: "." },
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
