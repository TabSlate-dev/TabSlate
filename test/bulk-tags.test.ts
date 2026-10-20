// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { bulkTagPatches, nextTagCheckState, tagCheckStates, type TagCheckState } from "@/lib/bulk-tags";
import { makeBookmark } from "./helpers/library-fixtures";

const a = makeBookmark("a", { tags: ["frontend", "design"] });
const b = makeBookmark("b", { tags: ["frontend"] });

describe("bulk tags", () => {
  test("a tag is checked when every bookmark has it, mixed when some do, empty when none do", () => {
    expect(Object.fromEntries(tagCheckStates([a, b], ["frontend", "design", "docs"]))).toEqual({
      frontend: "checked",
      design: "indeterminate",
      docs: "unchecked",
    });
  });

  test("a click checks an empty or mixed box and empties a checked one", () => {
    expect(nextTagCheckState("unchecked")).toBe("checked");
    expect(nextTagCheckState("indeterminate")).toBe("checked");
    expect(nextTagCheckState("checked")).toBe("unchecked");
  });

  test("checked rows add the tag to every bookmark and unchecked rows remove it", () => {
    const changes = new Map<string, TagCheckState>([["design", "checked"], ["frontend", "unchecked"]]);
    expect(bulkTagPatches([a, b], changes)).toEqual([
      { id: "a", patch: { tags: ["design"] } },
      { id: "b", patch: { tags: ["design"] } },
    ]);
  });

  test("untouched tags keep each bookmark's state", () => {
    expect(bulkTagPatches([a, b], new Map<string, TagCheckState>([["docs", "checked"]]))).toEqual([
      { id: "a", patch: { tags: ["frontend", "design", "docs"] } },
      { id: "b", patch: { tags: ["frontend", "docs"] } },
    ]);
  });

  test("bookmarks whose tags would not change get no patch", () => {
    expect(bulkTagPatches([a, b], new Map<string, TagCheckState>([["frontend", "checked"]]))).toEqual([]);
  });
});
