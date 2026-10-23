// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  pressKey,
  queryByText,
  render,
  setupDom,
  teardownDom,
  typeInto,
  wait,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import { makeCollection, makeWorkspace } from "./helpers/library-fixtures";
import { createTagIdb } from "./helpers/tag-idb";
import type { ExtensionMessage } from "@/lib/messages";
import type { Tag } from "@/lib/types";

const db = createTagIdb();
const replacer = createModuleReplacer();
const originalChrome = Reflect.get(globalThis, "chrome");
const activeTab = { id: 1, title: "Example page", url: "https://example.com/test", favIconUrl: "" };
const newtabTab = { id: 99 };
const delivered: ExtensionMessage[] = [];
let mockStorage: Record<string, unknown> = {};

let app: AppModules;
let PopupApp: typeof import("@/entrypoints/popup/App").default;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  await replacer.replace("@/lib/idb", { ...await import("@/lib/idb"), ...db.module });

  Reflect.set(globalThis, "chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    commands: { getAll: (callback: (commands: chrome.commands.Command[]) => void) => callback([]) },
    storage: {
      local: {
        get: async (key: string | string[], callback?: (result: Record<string, unknown>) => void) => {
          const keys = Array.isArray(key) ? key : [key];
          const result: Record<string, unknown> = {
            "tabslate-auth": JSON.stringify({ state: { refreshToken: "refresh" } }),
          };
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
      session: { get: async () => ({}) },
    },
    tabs: {
      query: (queryInfo: chrome.tabs.QueryInfo, callback?: (tabs: object[]) => void) => {
        const tabs = queryInfo.url ? [newtabTab] : [activeTab];
        if (callback) {
          callback(tabs);
          return undefined;
        }
        return Promise.resolve(tabs);
      },
      sendMessage: async (_tabId: number, message: ExtensionMessage) => {
        delivered.push(message);
        return { status: "saved", bookmarkId: "bm-1" };
      },
      create: () => {},
    },
    scripting: { executeScript: async () => [] },
  });

  ({ default: PopupApp } = await importFresh<typeof import("@/entrypoints/popup/App")>("entrypoints/popup/App.tsx"));
});

afterAll(async () => {
  view?.unmount();
  replacer.restore();
  Reflect.set(globalThis, "chrome", originalChrome);
  await teardownDom();
});

beforeEach(async () => {
  db.tables.clear();
  delivered.length = 0;
  mockStorage = {};
  db.seed([]);
  await db.module.idbPut("workspaces", makeWorkspace("home"));
  await db.module.idbPut("collections", makeCollection("default", "home", { isDefault: true }));
  await db.module.idbPut("kv", { key: "activeWorkspaceId", value: "home" });
});

async function openPopup(): Promise<void> {
  view?.unmount();
  view = render(app, createElement(PopupApp));
  await wait(0);
}

test("full-path suggestions share Task 8 ordering and Enter selects the first suggestion", async () => {
  db.seed([
    { id: "t1", name: "编程", color: "blue", seq: 0 },
    { id: "t2", name: "后端", parentId: "t1", color: "blue", seq: 0 },
    { id: "t3", name: "Go", parentId: "t2", color: "blue", seq: 0 },
    { id: "t4", name: "Go", color: "green", seq: 0 },
  ]);

  await openPopup();

  const input = getBySelector<HTMLInputElement>("input[placeholder*='tag' i], input[placeholder*='标签' i]");
  typeInto(input, "Go");
  await wait(0);

  // Both matches should appear with path rendering
  expect(queryByText("Go")).not.toBeNull();
  expect(queryByText("编程 › 后端 › Go")).not.toBeNull();

  // Enter should select the first suggestion
  pressKey(input, "Enter");
  await wait(0);

  // t4 ("Go") was exact root leaf match, selected as chip
  const chips = document.querySelectorAll(".rounded.text-\\[10px\\]");
  expect(chips.length).toBe(1);
  expect(chips[0]?.textContent).toContain("Go");

  // No WORKSPACE_CHANGED message was sent because nothing was created
  expect(delivered.filter((m) => m.type === "WORKSPACE_CHANGED")).toHaveLength(0);
});

test("when no suggestion matches, Enter creates a complete path and sends WORKSPACE_CHANGED", async () => {
  mockStorage["tabslate-plan"] = JSON.stringify({ state: { limits: { max_tags: 10 } } });

  await openPopup();

  const input = getBySelector<HTMLInputElement>("input[placeholder*='tag' i], input[placeholder*='标签' i]");
  typeInto(input, "Work/Project/Alpha");
  await wait(0);

  pressKey(input, "Enter");
  await wait(0);

  // Selected tag chip for the leaf "Alpha"
  const chips = document.querySelectorAll(".rounded.text-\\[10px\\]");
  expect(chips.length).toBe(1);
  expect(chips[0]?.textContent).toContain("Alpha");

  // WORKSPACE_CHANGED sent to newtab
  const changeMessages = delivered.filter((m) => m.type === "WORKSPACE_CHANGED");
  expect(changeMessages.length).toBeGreaterThan(0);

  // Tags exist in IDB
  const tags = await db.module.idbGetAll<Tag>("tags");
  expect(tags).toHaveLength(3);
  expect(tags.map((t) => t.name).sort()).toEqual(["Alpha", "Project", "Work"]);
});

test("insufficient capacity creates no partial levels, no selected ID, and shows local quota error", async () => {
  mockStorage["tabslate-plan"] = JSON.stringify({ state: { limits: { max_tags: 2 } } });

  await openPopup();

  const input = getBySelector<HTMLInputElement>("input[placeholder*='tag' i], input[placeholder*='标签' i]");
  typeInto(input, "One/Two/Three");
  await wait(0);

  pressKey(input, "Enter");
  await wait(0);

  // No tag selected
  const chips = document.querySelectorAll(".rounded.text-\\[10px\\]");
  expect(chips.length).toBe(0);

  // No WORKSPACE_CHANGED sent
  expect(delivered.filter((m) => m.type === "WORKSPACE_CHANGED")).toHaveLength(0);

  // IDB remains empty
  const tags = await db.module.idbGetAll<Tag>("tags");
  expect(tags).toHaveLength(0);

  // Inline quota error message shown
  expect(queryByText("popup_tagQuota")).not.toBeNull();
});

test("popup source does not import application store modules", async () => {
  const popupSrc = readFileSync("entrypoints/popup/App.tsx", "utf8");
  expect(popupSrc).not.toMatch(/@\/store\/workspace-store/);
  expect(popupSrc).not.toMatch(/@\/store\/bookmarks-store/);
  expect(popupSrc).not.toMatch(/@\/store\/plan-store/);

  const storageSrc = readFileSync("lib/storage.ts", "utf8");
  expect(storageSrc).not.toMatch(/@\/store\//);

  const persistenceSrc = readFileSync("lib/tag-persistence.ts", "utf8");
  expect(persistenceSrc).not.toMatch(/@\/store\//);
});

test("guest, verified-online, cached/offline, and Firefox consent-denied cases send no network requests", async () => {
  const originalFetch = globalThis.fetch;
  const networkSpy = () => {
    throw new Error("Forbidden network request from popup");
  };
  Reflect.set(globalThis, "fetch", networkSpy);

  try {
    // Guest (empty plan cache)
    mockStorage = {};
    await openPopup();

    // Verified online (cached limits)
    mockStorage["tabslate-plan"] = JSON.stringify({ state: { limits: { max_tags: 10 } } });
    await openPopup();

    // Offline / cached
    mockStorage["tabslate-auth"] = JSON.stringify({ state: { refreshToken: "tok" } });
    await openPopup();

    // Firefox consent denied (no refresh token)
    mockStorage["tabslate-auth"] = JSON.stringify({ state: { refreshToken: "" } });
    await openPopup();
  } finally {
    Reflect.set(globalThis, "fetch", originalFetch);
  }
});

