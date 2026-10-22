// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
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
const puts: object[] = [];
let storageService: typeof import("@/lib/storage").storageService;
let findSavedDuplicates: typeof import("@/lib/storage").findSavedDuplicates;

beforeAll(async () => {
  const realIdb = await importFresh<typeof import("@/lib/idb")>("lib/idb.ts");
  await replacer.replace("@/lib/idb", {
    ...realIdb,
    idbPut: async (_store: string, value: object) => { puts.push(value); },
    idbGetAll: async (store: string) => {
      if (failReads) {
        throw new Error("IndexedDB unavailable");
      }
      return stores.get(store) ?? [];
    },
    idbGet: async (_store: string, key: string) =>
      key === "activeWorkspaceId" ? { key, value: "home" } : undefined,
  });
  ({ findSavedDuplicates, storageService } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts"));
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
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await findSavedDuplicates("https://example.com/post")).toEqual([]);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});


describe("storageService.addBookmark", () => {
  test("writes the cover, and an empty cover when the page has none", async () => {
    const withCover = await storageService.addBookmark({
      title: "Page", url: "https://example.com/cover", favicon: "", collectionId: "reading",
      imageUrl: "https://cdn.example.com/cover.png",
    });
    const withoutCover = await storageService.addBookmark({
      title: "Page", url: "https://example.com/plain", favicon: "", collectionId: "reading",
    });
    expect(withCover.imageUrl).toBe("https://cdn.example.com/cover.png");
    expect(withoutCover.imageUrl).toBe("");
    expect(puts.at(-1)).toEqual(withoutCover);
  });

  test("writes the note and stamps the edit time", async () => {
    setSystemTime(new Date(70_000));
    try {
      const saved = await storageService.addBookmark({
        title: "Page", url: "https://example.com/new", favicon: "", collectionId: "reading", notes: "Why",
      });
      expect(saved.notes).toBe("Why");
      expect(saved.updatedAt).toBe(70_000);
      expect(puts.at(-1)).toEqual(saved);
    } finally {
      setSystemTime();
    }
  });
});
