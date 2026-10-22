// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";

const originalChrome = Reflect.get(globalThis, "chrome");
const created: chrome.tabs.CreateProperties[] = [];
const grouped: number[][] = [];
const groupUpdates: Array<[number, chrome.tabGroups.UpdateProperties]> = [];
let openUrlsInBackground: typeof import("@/lib/chrome/tabs").openUrlsInBackground;
let openAsTabGroup: typeof import("@/lib/chrome/tab-groups").openAsTabGroup;

beforeAll(async () => {
  Reflect.set(globalThis, "chrome", {
    tabs: {
      // Browsers refuse some addresses, e.g. file: URLs without file access.
      create: async (properties: chrome.tabs.CreateProperties) => {
        if (properties.url?.startsWith("file:")) {
          throw new Error("Cannot open a file URL");
        }
        created.push(properties);
        return { id: created.length };
      },
      group: async (options: { tabIds: number[] }) => {
        grouped.push([...options.tabIds]);
        return 42;
      },
    },
    tabGroups: {
      update: async (groupId: number, properties: chrome.tabGroups.UpdateProperties) => {
        groupUpdates.push([groupId, properties]);
        return { id: groupId };
      },
    },
  });
  ({ openUrlsInBackground } = await importFresh<typeof import("@/lib/chrome/tabs")>("lib/chrome/tabs.ts"));
  ({ openAsTabGroup } = await importFresh<typeof import("@/lib/chrome/tab-groups")>("lib/chrome/tab-groups.ts"));
});
afterAll(() => {
  Reflect.set(globalThis, "chrome", originalChrome);
});
beforeEach(() => {
  created.length = 0;
  grouped.length = 0;
  groupUpdates.length = 0;
});

test("opens each URL in order as a background tab", async () => {
  await openUrlsInBackground(["https://a.example", "https://b.example"]);
  expect(created).toEqual([
    { url: "https://a.example", active: false },
    { url: "https://b.example", active: false },
  ]);
});

test("a URL the browser refuses is skipped and reported, and the rest still open", async () => {
  const opened = await openUrlsInBackground(["https://a.example", "file:///spec.pdf", "https://b.example"]);
  expect(created.map((properties) => properties.url)).toEqual(["https://a.example", "https://b.example"]);
  expect(opened).toEqual({ tabIds: [1, 2], failedCount: 1 });
});

test("a tab group holds the tabs that opened and reports the refused URLs", async () => {
  const opened = await openAsTabGroup(["https://a.example", "file:///spec.pdf", "https://b.example"], "Reading", "grey");
  expect(opened).toEqual({ groupId: 42, failedCount: 1 });
  expect(grouped).toEqual([[1, 2]]);
  expect(groupUpdates).toEqual([[42, { title: "Reading", color: "grey" }]]);
});

test("a tab group fails when no tab opened", async () => {
  await expect(openAsTabGroup(["file:///spec.pdf"], "Reading", "grey")).rejects.toThrow();
  expect(grouped).toEqual([]);
});
