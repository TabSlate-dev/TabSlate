// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BrowserTab } from "@/lib/chrome/tabs";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { installAppModules, setupDom, teardownDom, type AppModules } from "./helpers/dom-environment";
import { makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
const originalChrome = Reflect.get(globalThis, "chrome");
const answers = new Map<number, object>();
let injections = 0;
let app: AppModules;
let useTabsStore: typeof import("@/store/tabs-store").useTabsStore;
let usePlanStore: typeof import("@/store/plan-store").usePlanStore;

function makeTab(id: number, url: string): BrowserTab {
  return { id, title: `Tab ${id}`, url, favIconUrl: "", windowId: 1, active: false, index: id, groupId: -1 };
}

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ usePlanStore } = await import("@/store/plan-store"));
  Reflect.set(globalThis, "chrome", {
    tabs: {
      sendMessage: async (tabId: number) => {
        const answer = answers.get(tabId);
        if (!answer) {
          throw new Error("Receiving end does not exist.");
        }
        return answer;
      },
    },
    scripting: {
      executeScript: async () => {
        injections += 1;
        return [];
      },
    },
  });
  ({ useTabsStore } = await importFresh<typeof import("@/store/tabs-store")>("store/tabs-store.ts"));
});
afterAll(async () => {
  replacer.restore();
  Reflect.set(globalThis, "chrome", originalChrome);
  await teardownDom();
});
beforeEach(() => {
  answers.clear();
  injections = 0;
  usePlanStore.setState({ limits: null, usage: null, fetchedAt: Date.now(), quotaAlert: null });
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
    tags: [],
  });
  app.useBookmarksStore.setState({ bookmarks: new Map(), countsByCollection: {} });
});

test("saving a window stores each tab's cover from its content script, without injecting", async () => {
  answers.set(1, { url: "https://one.example.com/", ogTitle: "One", ogImage: "https://cdn.example.com/one.png" });
  answers.set(2, { url: "https://two.example.com/", ogImage: "data:image/png;base64,AAAA" });
  useTabsStore.setState({
    openTabs: [makeTab(1, "https://one.example.com/"), makeTab(2, "https://two.example.com/"), makeTab(3, "https://three.example.com/")],
  });

  const result = await useTabsStore.getState().saveWindowAsCollection("Window", false);

  expect(result.saved).toBe(3);
  const byUrl = new Map([...app.useBookmarksStore.getState().bookmarks.values()].map((bookmark) => [bookmark.url, bookmark]));
  expect(byUrl.get("https://one.example.com/")?.title).toBe("One");
  expect(byUrl.get("https://one.example.com/")?.imageUrl).toBe("https://cdn.example.com/one.png");
  expect(byUrl.get("https://two.example.com/")?.imageUrl).toBe("");
  expect(byUrl.get("https://three.example.com/")?.imageUrl).toBe("");
  expect(injections).toBe(0);
});
