// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { installAppModules, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import type { ExtensionMessage } from "@/lib/messages";

const replacer = createModuleReplacer();
const originalChrome = Reflect.get(globalThis, "chrome");
const originalDefineBackground = Reflect.get(globalThis, "defineBackground");
let app: AppModules;
let view: RenderResult | null = null;
let App: typeof import("@/entrypoints/newtab/App").default;
let plan: typeof import("@/store/plan-store").usePlanStore;
const responses: object[] = [];
const listeners: Array<(message: ExtensionMessage, sender: chrome.runtime.MessageSender, respond: (response: object) => void) => boolean | void> = [];
let handleSave: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => Promise<void> = async () => {};
const badges: string[] = [];
let fallbackWrites = 0;
let transportFails = false;
const event = { addListener: () => {}, removeListener: () => {} };
const input = { title: "New bookmark", url: "https://new.example.com", favicon: "", description: "", collectionId: "", tags: [], seq: 0 };

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  plan = (await import("@/store/plan-store")).usePlanStore;
  const realIdb = await import("@/lib/idb");
  await replacer.replace("@/lib/idb", { ...realIdb, idbPut: async () => { fallbackWrites += 1; }, idbGetAll: async () => [] });
  const realStorage = await import("@/lib/storage");
  await replacer.replace("@/lib/storage", { ...realStorage, getWorkspaceState: async () => ({ activeWorkspaceId: "", workspaces: [], collections: [], tags: [] }) });
  const realBadge = await import("@/lib/browser/action-badge");
  await replacer.replace("@/lib/browser/action-badge", { ...realBadge, flashSaveBadge: async (_id: number, outcome: string) => { badges.push(outcome); } });
  const realAnalytics = await import("@/lib/analytics");
  await replacer.replace("@/lib/analytics", { ...realAnalytics, analytics: { init: async () => {}, track: () => {} } });
  const realSession = await import("@/lib/browser/storage-session");
  await replacer.replace("@/lib/browser/storage-session", { ...realSession, restrictSessionStorageToTrustedContexts: async () => {} });
  Reflect.set(globalThis, "chrome", {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onInstalled: event, onStartup: event,
      onMessage: { addListener: (listener: typeof listeners[number]) => { listeners.push(listener); }, removeListener: () => {} },
      sendMessage: async () => {},
    },
    permissions: { onAdded: event, onRemoved: event, contains: async () => false },
    contextMenus: { onClicked: { addListener: (listener: typeof handleSave) => { handleSave = listener; } } },
    commands: { onCommand: event },
    tabs: {
      query: async () => [{ id: 99 }],
      sendMessage: async (_id: number, message: ExtensionMessage | { type: "GET_PAGE_INFO" }) => {
        if (message.type === "GET_PAGE_INFO") { return input; }
        if (transportFails) { throw new Error("newtab unavailable"); }
        let response: object | undefined;
        for (const listener of listeners) { listener(message, {}, (result) => { response = result; responses.push(result); }); }
        return response;
      },
      onCreated: event, onRemoved: event, onUpdated: event, onActivated: event, onMoved: event,
    },
    tabGroups: { onCreated: event, onRemoved: event, onUpdated: event, onMoved: event },
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}) }, onChanged: event },
  });
  Reflect.set(globalThis, "defineBackground", (callback: () => void) => callback());
  ({ default: App } = await importFresh<typeof import("@/entrypoints/newtab/App")>("entrypoints/newtab/App.tsx"));
  view = render(app, createElement(App));
  await importFresh("entrypoints/background.ts");
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  Reflect.set(globalThis, "chrome", originalChrome);
  Reflect.set(globalThis, "defineBackground", originalDefineBackground);
  await teardownDom();
});

function setBookmarkQuota(limit: number) {
  plan.setState({ limits: { max_bookmarks: limit, max_collections: 100, max_tags: 100, max_workspaces: 10, max_saved_groups: 100, trash_grace_days: 30 }, usage: { bookmarks: 0, collections: 0, tags: 0, workspaces: 0, saved_groups: 0 }, fetchedAt: Date.now() });
}
const page: chrome.tabs.Tab = { id: 1, index: 0, pinned: false, highlighted: true, windowId: 1, active: true, incognito: false, selected: true, discarded: false, autoDiscardable: true, groupId: -1, frozen: false };

beforeEach(() => {
  badges.length = 0;
  responses.length = 0;
  fallbackWrites = 0;
  transportFails = false;
  app.useBookmarksStore.setState({ bookmarks: new Map(), countsByCollection: {} });
});

test("quota rejection is acknowledged and shows no saved badge or fallback persistence", async () => {
  setBookmarkQuota(0);
  let response: object | undefined;
  for (const listener of listeners) { listener({ type: "ADD_BOOKMARK", data: input }, {}, (result) => { response = result; }); }
  expect(response).toEqual({ status: "rejected" });
  await handleSave({ menuItemId: "save-to-tabslate", editable: false }, page);
  expect(badges).toEqual([]);
  expect(fallbackWrites).toBe(0);
  expect(app.useBookmarksStore.getState().bookmarks.size).toBe(0);
});

test("background does not flash success or bypass quota after a delivered rejection", async () => {
  setBookmarkQuota(0);
  await handleSave({ menuItemId: "save-to-tabslate", editable: false }, page);
  expect(badges).toEqual([]);
  expect(fallbackWrites).toBe(0);
});

test("accepted saves acknowledge the nonempty ID before showing success", async () => {
  setBookmarkQuota(100);
  await handleSave({ menuItemId: "save-to-tabslate", editable: false }, page);
  expect(app.useBookmarksStore.getState().bookmarks.size).toBe(1);
  expect(badges).toEqual(["saved"]);
  const [bookmark] = app.useBookmarksStore.getState().bookmarks.values();
  expect(bookmark.id.length).toBeGreaterThan(0);
  expect(responses).toContainEqual({ status: "saved", bookmarkId: bookmark.id });
});

test("transport failure retains direct persistence and success feedback", async () => {
  transportFails = true;
  const writesBefore = fallbackWrites;
  await handleSave({ menuItemId: "save-to-tabslate", editable: false }, page);
  expect(fallbackWrites).toBe(writesBefore + 1);
  expect(badges).toEqual(["saved"]);
});
