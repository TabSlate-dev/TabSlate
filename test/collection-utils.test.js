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

  test("orders multiple default collections by descending position", () => {
    const olderDefault = { id: "older-default", isDefault: true, position: 2 };
    const newerDefault = { id: "newer-default", isDefault: true, position: 8 };

    const sortedIds = [olderDefault, newerDefault]
      .sort(compareActiveCollections)
      .map((collection) => collection.id);

    expect(sortedIds).toEqual(["newer-default", "older-default"]);
    expect(compareActiveCollections(olderDefault, newerDefault)).toBeGreaterThan(0);
    expect(compareActiveCollections(newerDefault, olderDefault)).toBeLessThan(0);
  });

  test("orders false and omitted default flags by descending position", () => {
    const explicitFalse = { id: "explicit-false", isDefault: false, position: 2 };
    const omitted = { id: "omitted", position: 8 };

    const sortedIds = [explicitFalse, omitted]
      .sort(compareActiveCollections)
      .map((collection) => collection.id);

    expect(sortedIds).toEqual(["omitted", "explicit-false"]);
    expect(compareActiveCollections(explicitFalse, omitted)).toBeGreaterThan(0);
    expect(compareActiveCollections(omitted, explicitFalse)).toBeLessThan(0);
  });
});
