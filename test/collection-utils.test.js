import { describe, expect, test } from "bun:test";
import { compareActiveCollections } from "../lib/collection-utils";

describe("active collection ordering", () => {
  test("pins Default first and orders remaining collections by descending position", () => {
    const collections = [
      { id: "old", isDefault: false, position: 1 },
      { id: "default", isDefault: true, position: 0 },
      { id: "newest", isDefault: false, position: 9 },
      { id: "middle", isDefault: false, position: 4 },
    ];

    const sortedIds = [...collections]
      .sort(compareActiveCollections)
      .map((collection) => collection.id);

    expect(sortedIds).toEqual(["default", "newest", "middle", "old"]);
  });
});
