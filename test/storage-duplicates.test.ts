// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let failReads = false;
const stores = new Map<string, object[]>([
  ["bookmarks", [
    makeBookmark("saved", { collectionId: "reading", url: "https://example.com/post" }),
    makeBookmark("archived-parent", { collectionId: "old", url: "https://example.com/post" }),
  ]],
  ["workspaces", [makeWorkspace("home")]],
  ["collections", [makeCollection("reading", "home"), makeCollection("old", "home", { archivedAt: 1 })]],
  ["tags", []],
]);
let findSavedDuplicates: typeof import("@/lib/storage").findSavedDuplicates;

beforeAll(async () => {
  const realIdb = await importFresh<typeof import("@/lib/idb")>("lib/idb.ts");
  await replacer.replace("@/lib/idb", {
    ...realIdb,
    idbGetAll: async (store: string) => {
      if (failReads) {
        throw new Error("IndexedDB unavailable");
      }
      return stores.get(store) ?? [];
    },
    idbGet: async (_store: string, key: string) =>
      key === "activeWorkspaceId" ? { key, value: "home" } : undefined,
  });
  ({ findSavedDuplicates } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts"));
});

afterAll(() => {
  replacer.restore();
});

beforeEach(() => {
  failReads = false;
});

describe("findSavedDuplicates", () => {
  test("finds visible saved variants of the page", async () => {
    const matches = await findSavedDuplicates("http://www.example.com/post#comments");
    expect(matches.map((match) => match.bookmark.id)).toEqual(["saved"]);
  });

  test("reports no duplicates when IndexedDB cannot be read", async () => {
    failReads = true;
    expect(await findSavedDuplicates("https://example.com/post")).toEqual([]);
  });
});
