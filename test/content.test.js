import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const addListenerCalls = [];
const removeListenerCalls = [];

let registeredListener = null;
let invalidatedHandler = null;
let backgroundStartupListener = null;
let backgroundInstalledListeners = [];
let backgroundPermissionAddedListener = null;
let backgroundPermissionRemovedListener = null;

function importBackgroundModule() {
  return import(`../entrypoints/background.ts?test=${Date.now()}-${Math.random()}`);
}

function importTabGroupsModule() {
  return import(`../lib/chrome/tab-groups.ts?test=${Date.now()}-${Math.random()}`);
}

globalThis.defineContentScript = (config) => config;
globalThis.defineBackground = (main) => {
  main();
  return { main };
};
globalThis.createShadowRootUi = mock(async () => ({
  mount: () => {},
  remove: () => {},
  shadow: document.createElement("div").attachShadow({ mode: "open" }),
}));

mock.module("react-dom/client", () => ({
  default: {
    createRoot: () => ({
      render: () => {},
      unmount: () => {},
    }),
  },
  createRoot: () => ({
    render: () => {},
    unmount: () => {},
  }),
}));

mock.module("@/components/search/search-overlay", () => ({
  SearchOverlay: () => null,
}));

mock.module("@/assets/globals.css", () => ({}));
mock.module("@/lib/id", () => ({
  generateId: () => "bookmark-id",
}));
mock.module("@/lib/idb", () => ({
  idbPut: mock(async () => {}),
}));
mock.module("@/lib/chrome/tabs", () => ({
  getAllTabs: mock(async () => []),
  focusTab: mock(async () => {}),
}));
mock.module("@/lib/browser/search", () => ({
  runWebSearch: mock(async () => {}),
}));
mock.module("@/lib/api", () => ({
  searchBookmarks: mock(async () => []),
  api: {
    getPlan: mock(async () => ({
      subscription: null,
      limits: null,
      usage: null,
    })),
  },
}));
mock.module("@/lib/analytics", () => ({
  analytics: {
    init: mock(async () => {}),
    track: mock(() => {}),
  },
}));

beforeEach(() => {
  addListenerCalls.length = 0;
  removeListenerCalls.length = 0;
  registeredListener = null;
  invalidatedHandler = null;
  backgroundStartupListener = null;
  backgroundInstalledListeners = [];
  backgroundPermissionAddedListener = null;
  backgroundPermissionRemovedListener = null;

  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: (listener) => {
          addListenerCalls.push(listener);
          registeredListener = listener;
        },
        removeListener: (listener) => {
          removeListenerCalls.push(listener);
        },
      },
    },
  };
});

function createBackgroundChrome(overrides = {}) {
  return {
    runtime: {
      onInstalled: {
        addListener: (listener) => {
          backgroundInstalledListeners.push(listener);
        },
      },
      onStartup: {
        addListener: (listener) => {
          backgroundStartupListener = listener;
        },
      },
      onMessage: {
        addListener: mock(() => {}),
      },
      getManifest: () => ({ version: "0.2.0" }),
      sendMessage: mock(() => Promise.resolve()),
      getURL: (path) => `chrome-extension://test/${path}`,
    },
    permissions: {
      contains: mock(async () => true),
      onAdded: {
        addListener: (listener) => {
          backgroundPermissionAddedListener = listener;
        },
      },
      onRemoved: {
        addListener: (listener) => {
          backgroundPermissionRemovedListener = listener;
        },
      },
    },
    scripting: {
      getRegisteredContentScripts: mock(async () => []),
      registerContentScripts: mock(async () => {}),
      unregisterContentScripts: mock(async () => {}),
    },
    storage: {
      AccessLevel: {
        TRUSTED_CONTEXTS: "TRUSTED_CONTEXTS",
      },
      session: {
        setAccessLevel: mock(() => {}),
        get: mock(async () => ({})),
        set: mock(async () => {}),
      },
      local: {
        get: mock(async () => ({})),
        set: mock(async () => {}),
      },
    },
    contextMenus: {
      create: mock(() => {}),
      onClicked: {
        addListener: mock(() => {}),
      },
    },
    tabs: {
      onCreated: { addListener: mock(() => {}) },
      onRemoved: { addListener: mock(() => {}) },
      onUpdated: { addListener: mock(() => {}) },
      onActivated: { addListener: mock(() => {}) },
      onMoved: { addListener: mock(() => {}) },
      query: mock(async () => []),
      sendMessage: mock(async () => {}),
      create: mock(async () => {}),
    },
    tabGroups: {
      onCreated: { addListener: mock(() => {}) },
      onRemoved: { addListener: mock(() => {}) },
      onUpdated: { addListener: mock(() => {}) },
      onMoved: { addListener: mock(() => {}) },
    },
    commands: {
      onCommand: {
        addListener: mock(() => {}),
      },
    },
    windows: {
      WINDOW_ID_CURRENT: -2,
    },
    ...overrides,
  };
}

describe("content script message listener lifecycle", () => {
  test("removes the runtime message listener when the content script is invalidated", async () => {
    const mod = await import("../entrypoints/content");

    await mod.default.main({
      onInvalidated: (handler) => {
        invalidatedHandler = handler;
      },
    });

    expect(addListenerCalls).toHaveLength(1);
    expect(registeredListener).toBeTruthy();
    expect(removeListenerCalls).toHaveLength(0);

    invalidatedHandler?.();

    expect(removeListenerCalls).toEqual([registeredListener]);
  });
});

describe("tab group helpers", () => {
  test("queries groups through promise-based tabGroups APIs", async () => {
    globalThis.chrome = {
      windows: {
        WINDOW_ID_CURRENT: -2,
      },
      tabGroups: {
        query: mock((queryInfo, callback) => {
          if (callback) {
            throw new Error("expected promise-based tabGroups.query");
          }

          return Promise.resolve([
            {
              id: 7,
              title: "Docs",
              color: "blue",
              collapsed: false,
              windowId: 3,
            },
          ]);
        }),
      },
    };

    const { getCurrentWindowGroups } = await importTabGroupsModule();
    const groups = await getCurrentWindowGroups();

    expect(groups).toEqual([
      {
        id: 7,
        title: "Docs",
        color: "blue",
        collapsed: false,
        windowId: 3,
      },
    ]);
  });

  test("creates groups through promise-based tabs and tabGroups APIs", async () => {
    globalThis.chrome = {
      tabs: {
        group: mock((options, callback) => {
          if (callback) {
            throw new Error("expected promise-based tabs.group");
          }

          return Promise.resolve(42);
        }),
      },
      tabGroups: {
        update: mock((groupId, patch, callback) => {
          if (callback) {
            throw new Error("expected promise-based tabGroups.update");
          }

          return Promise.resolve({
            id: groupId,
            title: patch.title ?? "",
            color: patch.color ?? "grey",
            collapsed: false,
            windowId: 1,
          });
        }),
      },
    };

    const { groupTabs } = await importTabGroupsModule();
    const groupId = await groupTabs([1, 2], "Work", "green");

    expect(groupId).toBe(42);
  });
});

describe("background content script sync", () => {
  test("omits the Chromium-only storage session access-level API from the Firefox background bundle", () => {
    const result = spawnSync(
      "bunx",
      ["wxt", "build", "-b", "firefox", "--mv3", "--filter-entrypoint", "background"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);

    const backgroundBundle = readFileSync(
      join(process.cwd(), ".output", "firefox-mv3", "background.js"),
      "utf8",
    );
    expect(backgroundBundle).not.toContain("setAccessLevel");
  });

  test("exits early when the scripting API is unavailable", async () => {
    const consoleError = mock(() => {});
    globalThis.console = { ...console, error: consoleError };
    globalThis.chrome = createBackgroundChrome({ scripting: undefined });

    await importBackgroundModule();
    await backgroundStartupListener?.();

    expect(chrome.permissions.contains).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("registers the search overlay script when permission is granted", async () => {
    globalThis.chrome = createBackgroundChrome();

    await importBackgroundModule();
    await backgroundStartupListener?.();

    expect(chrome.permissions.contains).toHaveBeenCalledWith({ origins: ["<all_urls>"] });
    expect(chrome.scripting.getRegisteredContentScripts).toHaveBeenCalled();
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([{
      id: "search-overlay",
      matches: ["<all_urls>"],
      js: ["content-scripts/content.js"],
      runAt: "document_idle",
    }]);
  });
});
