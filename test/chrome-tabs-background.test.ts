// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";

const originalChrome = Reflect.get(globalThis, "chrome");
const created: chrome.tabs.CreateProperties[] = [];
let openUrlsInBackground: typeof import("@/lib/chrome/tabs").openUrlsInBackground;

beforeAll(async () => {
  Reflect.set(globalThis, "chrome", {
    tabs: {
      create: async (properties: chrome.tabs.CreateProperties) => {
        created.push(properties);
        return { id: created.length };
      },
    },
  });
  ({ openUrlsInBackground } = await importFresh<typeof import("@/lib/chrome/tabs")>("lib/chrome/tabs.ts"));
});
afterAll(() => {
  Reflect.set(globalThis, "chrome", originalChrome);
});

test("opens each URL in order as a background tab", async () => {
  await openUrlsInBackground(["https://a.example", "https://b.example"]);
  expect(created).toEqual([
    { url: "https://a.example", active: false },
    { url: "https://b.example", active: false },
  ]);
});
