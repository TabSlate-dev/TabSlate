// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";
import { makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const { resolveContextMenuSave } =
  await importFresh<typeof import("@/lib/context-menu-save")>("lib/context-menu-save.ts");

const library = {
  activeWorkspaceId: "home",
  workspaces: [makeWorkspace("home"), makeWorkspace("work")],
  collections: [makeCollection("reading", "home"), makeCollection("projects", "work")],
  bookmarks: [
    makeBookmark("home-post", { collectionId: "reading", url: "https://example.com/post" }),
    makeBookmark("work-page", { collectionId: "projects", url: "https://example.com/work" }),
  ],
};
const load = async () => library;

describe("resolveContextMenuSave", () => {
  test("skips the same address in the active workspace", async () => {
    expect(await resolveContextMenuSave("https://EXAMPLE.com/post/", load)).toBe("duplicate");
  });
  test("saves an address that only exists in another workspace", async () => {
    expect(await resolveContextMenuSave("https://example.com/work", load)).toBe("save");
  });
  test("saves a variant that only the loose tier would match", async () => {
    expect(await resolveContextMenuSave("http://example.com/post", load)).toBe("save");
  });
  test("saves when the library cannot be read", async () => {
    const originalWarn = console.warn;
    const warnings: Array<Array<string | Error>> = [];
    const failure = new Error("IndexedDB unavailable");
    console.warn = (...args: Array<string | Error>) => { warnings.push(args); };
    try {
      expect(await resolveContextMenuSave("https://example.com/post", async () => {
        throw failure;
      })).toBe("save");
      expect(warnings).toEqual([["[TabSlate] duplicate check failed; saving anyway:", failure]]);
    } finally {
      console.warn = originalWarn;
    }
  });
});
