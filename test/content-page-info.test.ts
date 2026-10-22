// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";
import { setupDom, teardownDom } from "./helpers/dom-environment";

type MessageListener = (message: { type?: string }, sender: object, respond: (response?: unknown) => void) => boolean;

interface ContentScriptModule {
  default: { main: (ctx: { onInvalidated: (handler: () => void) => void }) => Promise<void> };
}

const originalChrome = Reflect.get(globalThis, "chrome");
const originalDefine = Reflect.get(globalThis, "defineContentScript");
let listener: MessageListener | undefined;

beforeAll(async () => {
  setupDom();
  Reflect.set(globalThis, "defineContentScript", (config: object) => config);
  Reflect.set(globalThis, "chrome", {
    runtime: {
      onMessage: {
        addListener: (registered: MessageListener) => {
          listener = registered;
        },
        removeListener: () => {},
      },
    },
  });
  const content = await importFresh<ContentScriptModule>("entrypoints/content.ts");
  await content.default.main({ onInvalidated: () => {} });
});
afterAll(async () => {
  Reflect.set(globalThis, "chrome", originalChrome);
  Reflect.set(globalThis, "defineContentScript", originalDefine);
  await teardownDom();
});

test("answers GET_PAGE_INFO with the page reader's result, including the cover", () => {
  document.head.innerHTML = '<meta property="og:title" content="OG article"><meta property="og:image" content="https://cdn.example.com/a.png">';
  document.title = "Article";
  let answer: unknown;

  listener?.({ type: "GET_PAGE_INFO" }, {}, (response) => {
    answer = response;
  });

  expect(answer).toMatchObject({
    title: "Article",
    url: location.href,
    ogTitle: "OG article",
    ogImage: "https://cdn.example.com/a.png",
  });
});
