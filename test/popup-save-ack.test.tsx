// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import {
  click,
  getByText,
  getBySelector,
  installAppModules,
  queryByText,
  render,
  setupDom,
  teardownDom,
  typeInto,
  wait,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import { makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";
import type { BookmarkInput } from "@/lib/storage";
import type { AddBookmarkResponse, ExtensionMessage } from "@/lib/messages";

const replacer = createModuleReplacer();
const originalChrome = Reflect.get(globalThis, "chrome");
const activeTab = { id: 1, title: "Example page", url: "https://page.example.com/article", favIconUrl: "" };
const newtabTab = { id: 99 };
const fallbackWrite = mock(async (input: BookmarkInput) => makeBookmark("fallback", { url: input.url }));
const delivered: ExtensionMessage[] = [];
let answerSave: () => Promise<AddBookmarkResponse | undefined> = async () => undefined;
let pageInfoAnswer: () => Promise<unknown> = async () => ({});
let injectionAnswer: () => Promise<unknown[]> = async () => [];
let app: AppModules;
let PopupApp: typeof import("@/entrypoints/popup/App").default;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  const realStorage = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts");
  await replacer.replace("@/lib/storage", {
    ...realStorage,
    getWorkspaceState: async () => ({
      activeWorkspaceId: "home",
      workspaces: [makeWorkspace("home")],
      collections: [makeCollection("reading", "home", { isDefault: true })],
      tags: [],
    }),
    findSavedDuplicates: async () => [],
    storageService: { ...realStorage.storageService, addBookmark: fallbackWrite },
  });
  Reflect.set(globalThis, "chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    commands: { getAll: (callback: (commands: chrome.commands.Command[]) => void) => callback([]) },
    storage: {
      local: { get: async () => ({ "tabslate-auth": JSON.stringify({ state: { refreshToken: "refresh" } }) }) },
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
      sendMessage: async (_tabId: number, message: ExtensionMessage | { type: "GET_PAGE_INFO" }) => {
        if (message.type === "GET_PAGE_INFO") {
          return pageInfoAnswer();
        }
        delivered.push(message);
        return answerSave();
      },
      create: () => {},
    },
    scripting: { executeScript: async () => injectionAnswer() },
  });
  ({ default: PopupApp } = await importFresh<typeof import("@/entrypoints/popup/App")>("entrypoints/popup/App.tsx"));
});

afterAll(async () => {
  view?.unmount();
  replacer.restore();
  Reflect.set(globalThis, "chrome", originalChrome);
  await teardownDom();
});

async function openPopup(): Promise<void> {
  view?.unmount();
  view = render(app, createElement(PopupApp));
  await wait(0);
}

beforeEach(async () => {
  delivered.length = 0;
  fallbackWrite.mockClear();
  pageInfoAnswer = async () => ({});
  injectionAnswer = async () => [];
  await openPopup();
});

async function save(): Promise<void> {
  click(getByText("popup_saveBookmark"));
  await wait(0);
}

test("a save the newtab rejects shows the rejection and is not written directly", async () => {
  answerSave = async () => ({ status: "rejected" });
  await save();

  expect(delivered.map((message) => message.type)).toEqual(["ADD_BOOKMARK"]);
  expect(queryByText("popup_saveRejected")).not.toBeNull();
  expect(queryByText("popup_saved")).toBeNull();
  expect(fallbackWrite).not.toHaveBeenCalled();
});

test("a save the newtab accepts shows success without a direct write", async () => {
  answerSave = async () => ({ status: "saved", bookmarkId: "saved-1" });
  await save();

  expect(queryByText("popup_saved")).not.toBeNull();
  expect(queryByText("popup_saveRejected")).toBeNull();
  expect(fallbackWrite).not.toHaveBeenCalled();
});

test("a delivery without an answer falls back to the direct write", async () => {
  answerSave = async () => undefined;
  await save();

  expect(fallbackWrite).toHaveBeenCalledTimes(1);
  expect(queryByText("popup_saved")).not.toBeNull();
});

test("a newtab that cannot be reached falls back to the direct write", async () => {
  answerSave = async () => {
    throw new Error("Receiving end does not exist.");
  };
  await save();

  expect(fallbackWrite).toHaveBeenCalledTimes(1);
  expect(queryByText("popup_saved")).not.toBeNull();
});


test("a note added in the popup travels with the save", async () => {
  answerSave = async () => ({ status: "saved", bookmarkId: "saved-1" });
  expect(document.querySelector("#popup-note")).toBeNull();
  click(getByText("popup_addNote"));
  const field = getBySelector<HTMLTextAreaElement>("#popup-note");
  expect(field.maxLength).toBe(10_000);
  typeInto(field, "  Read before Friday  ");
  await save();

  const [message] = delivered;
  expect(message?.type === "ADD_BOOKMARK" ? message.data.notes : undefined).toBe("Read before Friday");
});

test("the storage fallback keeps the trimmed note", async () => {
  answerSave = async () => undefined;
  click(getByText("popup_addNote"));
  typeInto(getBySelector<HTMLTextAreaElement>("#popup-note"), "  Fallback note  ");
  await save();

  expect(fallbackWrite.mock.calls[0]?.[0].notes).toBe("Fallback note");
});

function deliveredCover(): string | undefined {
  const [message] = delivered;
  return message?.type === "ADD_BOOKMARK" ? message.data.imageUrl : undefined;
}

test("the page's cover from the content script travels with the save, resolved against the page", async () => {
  answerSave = async () => ({ status: "saved", bookmarkId: "saved-1" });
  pageInfoAnswer = async () => ({ url: activeTab.url, ogImage: "/cover.png" });
  await openPopup();
  await save();

  expect(deliveredCover()).toBe("https://page.example.com/cover.png");
});

test("without a content script, the popup reads the page through activeTab", async () => {
  answerSave = async () => ({ status: "saved", bookmarkId: "saved-1" });
  pageInfoAnswer = async () => {
    throw new Error("Receiving end does not exist.");
  };
  injectionAnswer = async () => [{ result: { url: activeTab.url, ogTitle: "Injected title", ogImage: "https://cdn.example.com/injected.png" } }];
  await openPopup();
  await save();

  const [message] = delivered;
  expect(message?.type === "ADD_BOOKMARK" ? message.data.title : undefined).toBe("Injected title");
  expect(deliveredCover()).toBe("https://cdn.example.com/injected.png");
});

test("a cover that is not http or https is dropped", async () => {
  answerSave = async () => ({ status: "saved", bookmarkId: "saved-1" });
  pageInfoAnswer = async () => ({ url: activeTab.url, ogImage: "javascript:alert(1)" });
  await openPopup();
  await save();

  expect(deliveredCover()).toBe("");
});

test("the storage fallback keeps the cover", async () => {
  answerSave = async () => undefined;
  pageInfoAnswer = async () => ({ url: activeTab.url, ogImage: "https://cdn.example.com/fallback.png" });
  await openPopup();
  await save();

  expect(fallbackWrite.mock.calls[0]?.[0].imageUrl).toBe("https://cdn.example.com/fallback.png");
});

test("bookmark save acknowledgement behavior stays intact with tags", async () => {
  answerSave = async () => ({ status: "saved", bookmarkId: "saved-tag-bm" });
  await openPopup();
  await save();

  const [message] = delivered;
  expect(message?.type === "ADD_BOOKMARK" ? message.data.tags : undefined).toEqual([]);
  expect(queryByText("popup_saved")).not.toBeNull();
  expect(queryByText("popup_saveRejected")).toBeNull();
  expect(fallbackWrite).not.toHaveBeenCalled();
});

