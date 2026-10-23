// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createTagIdb } from "./helpers/tag-idb";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { setupDom, teardownDom } from "./helpers/dom-environment";
import { idbGetAll } from "@/lib/idb";
import type { Tag } from "@/lib/types";

const db = createTagIdb();
const replacer = createModuleReplacer();
const originalChrome = Reflect.get(globalThis, "chrome");

let mockStorage: Record<string, unknown> = {};

beforeAll(async () => {
  setupDom();
  Reflect.set(globalThis, "chrome", {
    storage: {
      local: {
        get: async (key: string | string[], callback?: (result: Record<string, unknown>) => void) => {
          const keys = Array.isArray(key) ? key : [key];
          const result: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in mockStorage) {
              result[k] = mockStorage[k];
            }
          }
          if (callback) {
            callback(result);
            return undefined;
          }
          return result;
        },
        set: async (items: Record<string, unknown>, callback?: () => void) => {
          Object.assign(mockStorage, items);
          if (callback) { callback(); }
        },
      },
    },
  });
  await replacer.replace("@/lib/idb", { ...await import("@/lib/idb"), ...db.module });
});

afterAll(async () => {
  replacer.restore();
  Reflect.set(globalThis, "chrome", originalChrome);
  await teardownDom();
});

beforeEach(() => {
  db.tables.clear();
  db.state.transactions = 0;
  db.state.fail = false;
  mockStorage = {};
});

test("readTagCapacity reads max_tags from chrome.storage.local tabslate-plan", async () => {
  const { readTagCapacity } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts");

  mockStorage["tabslate-plan"] = JSON.stringify({ state: { limits: { max_tags: 5 } } });
  expect(await readTagCapacity()).toEqual({ limit: 5 });

  mockStorage["tabslate-plan"] = JSON.stringify({ state: { limits: { max_tags: -1 } } });
  expect(await readTagCapacity()).toEqual({ limit: -1 });

  mockStorage["tabslate-plan"] = JSON.stringify({ state: {} });
  expect(await readTagCapacity()).toEqual({ limit: -1 });

  delete mockStorage["tabslate-plan"];
  expect(await readTagCapacity()).toEqual({ limit: -1 });
});

test("popup_path_quota_is_atomic", async () => {
  const { storageService } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts");

  mockStorage["tabslate-plan"] = JSON.stringify({ state: { limits: { max_tags: 2 } } });
  expect(await storageService.addTagPath("编程/后端/Go", "blue")).toEqual({ ok: false, error: "quota" });
  expect(await idbGetAll<Tag>("tags")).toEqual([]);
});

test("creates complete path with parentId hierarchy and assigns leaf tagId", async () => {
  const { storageService } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts");

  mockStorage["tabslate-plan"] = JSON.stringify({ state: { limits: { max_tags: 10 } } });
  const result = await storageService.addTagPath("编程/后端/Go", "blue");
  expect(result.ok).toBe(true);
  if (!result.ok) { return; }

  const tags = await idbGetAll<Tag>("tags");
  expect(tags).toHaveLength(3);

  const root = tags.find((t) => t.name === "编程");
  expect(root).toBeDefined();
  expect(root?.parentId).toBeUndefined();
  expect(root?.color).toBe("blue");
  expect(root?.seq).toBe(0);

  const middle = tags.find((t) => t.name === "后端");
  expect(middle).toBeDefined();
  expect(middle?.parentId).toBe(root?.id);
  expect(middle?.color).toBe("blue");
  expect(middle?.seq).toBe(0);

  const leaf = tags.find((t) => t.name === "Go");
  expect(leaf).toBeDefined();
  expect(leaf?.parentId).toBe(middle?.id);
  expect(leaf?.color).toBe("blue");
  expect(leaf?.id).toBe(result.tagId);
});

test("all_existing_path_returns_leaf_without_writes", async () => {
  const { storageService } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts");

  db.seed([
    { id: "a", name: "编程", color: "blue", seq: 0 },
    { id: "b", name: "后端", parentId: "a", color: "blue", seq: 0 },
  ]);
  const initialTransactions = db.state.transactions;

  const result = await storageService.addTagPath("编程/后端", "red");
  expect(result).toEqual({ ok: true, tagId: "b" });
  expect(db.state.transactions).toBe(initialTransactions);
});

test("reusing existing prefix creates only remaining levels", async () => {
  const { storageService } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts");

  db.seed([{ id: "a", name: "编程", color: "blue", seq: 0 }]);

  const result = await storageService.addTagPath("编程/前端", "blue");
  expect(result.ok).toBe(true);

  const tags = await idbGetAll<Tag>("tags");
  expect(tags).toHaveLength(2);
  const child = tags.find((t) => t.name === "前端");
  expect(child?.parentId).toBe("a");
  expect(child?.id).toBe(result.ok ? result.tagId : undefined);
});

test("simultaneous popup path creation reuses one sibling set", async () => {
  const { storageService } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts");

  mockStorage["tabslate-plan"] = JSON.stringify({ state: { limits: { max_tags: 10 } } });

  const [res1, res2] = await Promise.all([
    storageService.addTagPath("编程/后端", "blue"),
    storageService.addTagPath("编程/前端", "blue"),
  ]);

  expect(res1.ok).toBe(true);
  expect(res2.ok).toBe(true);

  const tags = await idbGetAll<Tag>("tags");
  expect(tags).toHaveLength(3);
  const roots = tags.filter((t) => t.parentId === undefined);
  expect(roots).toHaveLength(1);
  expect(roots[0]?.name).toBe("编程");

  const children = tags.filter((t) => t.parentId === roots[0]?.id);
  expect(children).toHaveLength(2);
  expect(children.map((t) => t.name).sort()).toEqual(["前端", "后端"]);
});

test("quota check excludes pending durable tombstones", async () => {
  const { storageService } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts");

  db.seed([
    { id: "active-1", name: "活跃标签", color: "blue", seq: 0 },
    { id: "deleted-1", name: "已删除", color: "blue", seq: 0, deletedAt: Date.now() },
  ]);

  mockStorage["tabslate-plan"] = JSON.stringify({ state: { limits: { max_tags: 2 } } });

  // 1 active + 1 tombstone. Creating 1 tag should succeed because active count is 1, and 1 + 1 <= 2.
  const result = await storageService.addTagPath("新标签", "green");
  expect(result.ok).toBe(true);
});

test("snapshot mismatch retries once and reports stale on second mismatch", async () => {
  const { storageService } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts");

  let mismatches = 0;
  db.state.beforeRead = () => {
    if (mismatches < 1) {
      mismatches += 1;
      db.seed([{ id: "other", name: "其他", color: "blue", seq: 0 }]);
    }
  };

  const res = await storageService.addTagPath("新/路径", "blue");
  expect(res.ok).toBe(true);

  // Persistent mismatch across retries
  let persistentMismatches = true;
  Object.defineProperty(db.state, "beforeRead", {
    get: () => persistentMismatches ? () => {
      db.seed([{ id: `tag-${Math.random()}`, name: `并发-${Math.random()}`, color: "blue", seq: 0 }]);
    } : undefined,
    set: () => {},
    configurable: true,
  });
  const res2 = await storageService.addTagPath("另一个/路径", "blue");
  persistentMismatches = false;
  expect(res2).toEqual({ ok: false, error: "stale" });
});

test("validation errors return error without writes", async () => {
  const { storageService } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts");

  expect(await storageService.addTagPath("  ", "blue")).toEqual({ ok: false, error: "empty" });
  expect(await storageService.addTagPath("a//b", "blue")).toEqual({ ok: false, error: "empty_segment" });
  expect(await storageService.addTagPath("1/2/3/4/5/6", "blue")).toEqual({ ok: false, error: "depth" });
  expect(await idbGetAll<Tag>("tags")).toEqual([]);
});
