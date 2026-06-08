import { beforeEach, describe, expect, mock, test } from "bun:test";

const addListenerCalls = [];
const removeListenerCalls = [];

let registeredListener = null;
let invalidatedHandler = null;

globalThis.defineContentScript = (config) => config;
globalThis.createShadowRootUi = mock(async () => ({
  mount: () => {},
  remove: () => {},
  shadow: document.createElement("div").attachShadow({ mode: "open" }),
}));

mock.module("react", () => ({
  default: {
    createElement: () => null,
  },
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

beforeEach(() => {
  addListenerCalls.length = 0;
  removeListenerCalls.length = 0;
  registeredListener = null;
  invalidatedHandler = null;

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
