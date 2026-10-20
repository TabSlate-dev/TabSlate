// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import type { BookmarkViewPrefs, PullAction, StoredViewPrefs } from "@/lib/view-preferences";

const kv = new Map<string, unknown>();
let serverPreferences: Record<string, unknown> = {};
const updateCalls: Array<Record<string, unknown>> = [];
const credentials = { baseUrl: "https://sync.example.com", accessToken: "token" };
const replacer = createModuleReplacer();
let viewPrefs: typeof import("@/lib/view-preferences");

beforeAll(async () => {
  const realIdb = await importFresh<typeof import("@/lib/idb")>("lib/idb.ts");
  const realApi = await importFresh<typeof import("@/lib/api")>("lib/api.ts");
  await replacer.replace("@/lib/idb", {
    ...realIdb,
    idbGet: async (_store: string, key: string) => (kv.has(key) ? { key, value: kv.get(key) } : undefined),
    idbPut: async (_store: string, record: { key: string; value: unknown }) => {
      kv.set(record.key, record.value);
    },
  });
  await replacer.replace("@/lib/api", {
    ...realApi,
    getPreferences: async () => structuredClone(serverPreferences),
    updatePreferences: async (_baseUrl: string, _token: string, preferences: Record<string, unknown>) => {
      updateCalls.push(preferences);
      serverPreferences = structuredClone(preferences);
    },
  });
  viewPrefs = await importFresh<typeof import("@/lib/view-preferences")>("lib/view-preferences.ts");
});

afterAll(() => {
  replacer.restore();
});

beforeEach(() => {
  kv.clear();
  serverPreferences = {};
  updateCalls.length = 0;
});

describe("parseViewPrefs", () => {
  test("keeps the edit time and website orders", () => {
    for (const sortBy of ["updated-newest", "updated-oldest", "site-az"]) {
      expect(viewPrefs.parseViewPrefs({ viewMode: "grid", sortBy, updatedAt: 1 })?.sortBy).toBe(sortBy);
    }
  });

  test("keeps valid values", () => {
    expect(viewPrefs.parseViewPrefs({ viewMode: "list", sortBy: "alpha-za", updatedAt: 42 })).toEqual({
      viewMode: "list",
      sortBy: "alpha-za",
      updatedAt: 42,
    });
  });
  test("falls back to defaults for values it does not know", () => {
    expect(viewPrefs.parseViewPrefs({ viewMode: "masonry", sortBy: "random" })).toEqual({
      viewMode: "grid",
      sortBy: "date-newest",
      updatedAt: 0,
    });
  });
  test("returns null when there is no preferences object", () => {
    expect(viewPrefs.parseViewPrefs("list")).toBeNull();
    expect(viewPrefs.parseViewPrefs(undefined)).toBeNull();
  });
});

describe("resolvePullAction", () => {
  const local = (updatedAt: number, dirty: boolean): StoredViewPrefs => ({
    viewMode: "list",
    sortBy: "alpha-az",
    updatedAt,
    dirty,
  });
  const remote = (updatedAt: number): BookmarkViewPrefs => ({ viewMode: "grid", sortBy: "date-oldest", updatedAt });
  const cases: Array<[string, StoredViewPrefs | null, BookmarkViewPrefs | null, PullAction]> = [
    ["nothing anywhere", null, null, "none"],
    ["only local", local(5, false), null, "push-local"],
    ["only remote", null, remote(5), "apply-remote"],
    ["remote newer", local(5, false), remote(9), "apply-remote"],
    ["remote newer than an unpushed local change", local(5, true), remote(9), "apply-remote"],
    ["local newer", local(9, false), remote(5), "push-local"],
    ["same time, local unpushed", local(5, true), remote(5), "push-local"],
    ["same time, in sync", local(5, false), remote(5), "none"],
  ];
  for (const [name, localPrefs, remotePrefs, expected] of cases) {
    test(name, () => {
      expect(viewPrefs.resolvePullAction(localPrefs, remotePrefs)).toBe(expected);
    });
  }
});

describe("local preferences", () => {
  test("round-trip through the kv store", async () => {
    const prefs: StoredViewPrefs = { viewMode: "list", sortBy: "alpha-az", updatedAt: 7, dirty: true };
    await viewPrefs.writeLocalViewPrefs(prefs);
    expect(await viewPrefs.readLocalViewPrefs()).toEqual(prefs);
  });
  test("ignore a stored value that is not a preferences object", async () => {
    kv.set("bookmark-view-prefs", "list");
    expect(await viewPrefs.readLocalViewPrefs()).toBeNull();
  });
});

describe("server preferences", () => {
  test("read the bookmarkView key", async () => {
    serverPreferences = { bookmarkView: { viewMode: "list", sortBy: "alpha-za", updatedAt: 3 } };
    expect(await viewPrefs.fetchRemoteViewPrefs(credentials)).toEqual({
      viewMode: "list",
      sortBy: "alpha-za",
      updatedAt: 3,
    });
  });
  test("push keeps the other keys on the server", async () => {
    serverPreferences = { theme: "dark", bookmarkView: { viewMode: "grid", sortBy: "date-newest", updatedAt: 1 } };
    await viewPrefs.pushViewPrefs(credentials, { viewMode: "list", sortBy: "alpha-az", updatedAt: 9 });
    expect(updateCalls).toEqual([
      { theme: "dark", bookmarkView: { viewMode: "list", sortBy: "alpha-az", updatedAt: 9 } },
    ]);
  });
  test("does not dispatch an update when the push is no longer eligible", async () => {
    await viewPrefs.pushViewPrefs(credentials, { viewMode: "list", sortBy: "alpha-az", updatedAt: 9 }, () => false);
    expect(updateCalls).toEqual([]);
  });

  test("push returns the newer remote winner without replacing server preferences", async () => {
    const remote = { viewMode: "grid", sortBy: "alpha-za", updatedAt: 200 };
    serverPreferences = { theme: "dark", bookmarkView: remote };
    expect(await viewPrefs.pushViewPrefs(credentials, { viewMode: "list", sortBy: "date-newest", updatedAt: 100 }))
      .toEqual({ status: "remote-newer", prefs: remote });
    expect(updateCalls).toEqual([]);
    expect(serverPreferences).toEqual({ theme: "dark", bookmarkView: remote });
  });

});
