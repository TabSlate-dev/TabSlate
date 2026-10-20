// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { tagNameError } from "@/lib/tag-name";

describe("tagNameError", () => {
  test("requires a name", () => {
    expect(tagNameError("   ", ["Read"])).toBe("empty");
  });
  test("rejects another tag's name, ignoring case and surrounding spaces", () => {
    expect(tagNameError("  read ", ["  Read "])).toBe("duplicate");
  });
  test("accepts a new name", () => {
    expect(tagNameError("Reading", ["Read"])).toBeNull();
  });
});
