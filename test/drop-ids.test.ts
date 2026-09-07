// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import {
  contentCollectionDropId,
  isCollectionDropId,
  isSavedGroupDropId,
  parseCollectionDropId,
  parseSavedGroupDropId,
  savedGroupDropId,
} from "@/lib/drop-ids";

describe("collection drop ids", () => {
  test("a suffixed content id still names its collection", () => {
    const collectionId = "6f1c0a2e-9d3b-4c77-8a51-2f0e6b4d9c13";
    expect(parseCollectionDropId(contentCollectionDropId(collectionId))).toBe(collectionId);
    expect(parseCollectionDropId(contentCollectionDropId(collectionId, "row-0"))).toBe(collectionId);
    expect(parseCollectionDropId(contentCollectionDropId(collectionId, "dropzone"))).toBe(collectionId);
    expect(parseCollectionDropId(contentCollectionDropId(collectionId, "empty-state"))).toBe(collectionId);
  });

  test("every row of one collection is a distinct droppable", () => {
    const ids = new Set([
      contentCollectionDropId("col-1"),
      contentCollectionDropId("col-1", "row-0"),
      contentCollectionDropId("col-1", "row-1"),
      contentCollectionDropId("col-1", "dropzone"),
    ]);
    expect(ids.size).toBe(4);
  });

  test("sidebar ids keep parsing", () => {
    expect(parseCollectionDropId("sidebar-collection-col-1")).toBe("col-1");
    expect(parseCollectionDropId("sidebar-collection-all")).toBe("all");
  });

  test("the all sentinel survives the round trip", () => {
    expect(parseCollectionDropId(contentCollectionDropId("all", "row-2"))).toBe("all");
  });

  test("saved-group ids stay distinct from collection ids", () => {
    const dropId = savedGroupDropId("group-7");
    expect(isSavedGroupDropId(dropId)).toBe(true);
    expect(isCollectionDropId(dropId)).toBe(false);
    expect(parseSavedGroupDropId(dropId)).toBe("group-7");
  });

  test("a chrome group-drop id is not mistaken for a saved group", () => {
    expect(isSavedGroupDropId("group-drop-42")).toBe(false);
    expect(isCollectionDropId("group-drop-42")).toBe(false);
  });
});
