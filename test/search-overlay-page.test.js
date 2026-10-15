import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { SEARCH_OVERLAY_CLOSE_MESSAGE } from "../lib/messages";
import { SearchOverlaySessionStore } from "../lib/search-overlay-session";

const SESSION = "a49f0fa8-2f92-467f-bda2-c1a2e5906d25";
const TAB_ID = 7;

const render = mock(() => {});
const createRoot = mock(() => ({ render, unmount: () => {} }));

mock.module("react-dom/client", () => ({
  default: { createRoot },
  createRoot,
}));
mock.module("@/components/search/search-overlay", () => ({
  SearchOverlay: () => null,
}));
mock.module("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }) => children,
}));
mock.module("@/assets/globals.css", () => ({}));

const fakedGlobals = ["chrome", "document", "location", "window", "setInterval", "clearInterval"];
let savedGlobals = {};
let postMessage;
let intervals;
let clearedIntervals;

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stubValidation(validate) {
  globalThis.chrome = { runtime: { sendMessage: mock(validate) } };
}

async function openOverlayPage(search) {
  globalThis.location = { search };
  await import(`../entrypoints/search-overlay/main.tsx?test=${Date.now()}-${Math.random()}`);
  await flush();
}

beforeEach(() => {
  savedGlobals = Object.fromEntries(
    fakedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  render.mockClear();
  createRoot.mockClear();
  postMessage = mock(() => {});
  intervals = [];
  clearedIntervals = [];

  globalThis.window = { parent: { postMessage } };
  globalThis.document = {
    documentElement: { style: {} },
    body: { style: {} },
    getElementById: (id) => (id === "root" ? { id } : null),
  };
  globalThis.setInterval = (callback, delay) => {
    intervals.push({ callback, delay });
    return intervals.length;
  };
  globalThis.clearInterval = (handle) => {
    clearedIntervals.push(handle);
  };
});

afterEach(() => {
  for (const name of fakedGlobals) {
    const descriptor = savedGlobals[name];
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }
});

describe("search overlay page", () => {
  test("asks the host page to remove it when the URL carries no session", async () => {
    stubValidation(async () => ({ ok: true }));

    await openOverlayPage("");

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: SEARCH_OVERLAY_CLOSE_MESSAGE }, "*");
  });

  test("asks the host page to remove it when background rejects the session", async () => {
    stubValidation(async () => ({ ok: false }));

    await openOverlayPage(`?session=${SESSION}`);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "VALIDATE_SEARCH_OVERLAY_SESSION",
      session: SESSION,
    });
    expect(render).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: SEARCH_OVERLAY_CLOSE_MESSAGE }, "*");
  });

  test("asks the host page to remove it when the session check cannot reach background", async () => {
    stubValidation(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });

    await openOverlayPage(`?session=${SESSION}`);

    expect(render).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: SEARCH_OVERLAY_CLOSE_MESSAGE }, "*");
  });

  test("keeps its session valid while open and closes once the session is revoked", async () => {
    const sessions = new SearchOverlaySessionStore();
    let now = 0;
    sessions.register(SESSION, TAB_ID, now);
    stubValidation(async (message) => ({ ok: sessions.validate(message.session, TAB_ID, now) }));

    await openOverlayPage(`?session=${SESSION}`);

    expect(render).toHaveBeenCalledTimes(1);
    expect(intervals).toHaveLength(1);
    const [{ callback: heartbeat, delay }] = intervals;

    // Five idle minutes with the overlay open: only the heartbeat reaches background.
    while (now < 5 * 60_000) {
      now += delay;
      heartbeat();
      await flush();
    }
    expect(postMessage).not.toHaveBeenCalled();

    sessions.revoke(SESSION, TAB_ID);
    now += delay;
    heartbeat();
    await flush();

    expect(postMessage).toHaveBeenCalledWith({ type: SEARCH_OVERLAY_CLOSE_MESSAGE }, "*");
    expect(clearedIntervals).toEqual([1]);
  });
});
