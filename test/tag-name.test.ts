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
  test("rejects literal slashes in new names", () => {
    expect(tagNameError("Programming/Go", [])).toBe("slash");
  });
  test("limits names to fifty Unicode code points after trimming", () => {
    expect(tagNameError(` ${"😀".repeat(50)} `, [])).toBeNull();
    expect(tagNameError("😀".repeat(51), [])).toBe("too_long");
  });
});
