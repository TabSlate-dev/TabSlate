// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// The tests below replace this module for the rest of the run, so keep the current one to put back afterwards.
const realBrowserEnv = { ...(await import("@/lib/browser/env")) };

afterAll(() => {
  mock.module("@/lib/browser/env", () => realBrowserEnv);
});

async function importSearchModule() {
  return import(`../lib/browser/search.ts?test=${Date.now()}-${Math.random()}`);
}

describe("runWebSearch", () => {
  beforeEach(() => {
    mock.module("@/lib/browser/env", () => ({
      isFirefoxBuild: () => false,
      getBrowserBuild: () => "chrome",
      isChromiumBuild: () => true,
    }));

    globalThis.chrome = {
      search: {
        query: mock(async () => {}),
      },
    } as typeof chrome;

    const browserGlobals = globalThis as typeof globalThis & { browser: typeof browser };
    browserGlobals.browser = {
      search: {
        query: mock(async () => {}),
      },
    } as typeof browser;
  });

  test("dispatches to chrome.search.query for Chromium builds", async () => {
    const { runWebSearch } = await importSearchModule();

    await runWebSearch({ text: "alpha", disposition: "CURRENT_TAB" });

    expect(chrome.search.query).toHaveBeenCalledWith({
      text: "alpha",
      disposition: "CURRENT_TAB",
    });
  });

  test("dispatches to browser.search.query for Firefox builds", async () => {
    mock.module("@/lib/browser/env", () => ({
      isFirefoxBuild: () => true,
      getBrowserBuild: () => "firefox",
      isChromiumBuild: () => false,
    }));

    const { runWebSearch } = await importSearchModule();

    await runWebSearch({ text: "beta", disposition: "NEW_TAB" });

    expect(browser.search.query).toHaveBeenCalledWith({
      text: "beta",
      disposition: "NEW_TAB",
    });
  });

  test("returns early when the query is blank", async () => {
    const { runWebSearch } = await importSearchModule();

    await runWebSearch({ text: "   ", disposition: "NEW_WINDOW" });

    expect(chrome.search.query).not.toHaveBeenCalled();
    expect(browser.search.query).not.toHaveBeenCalled();
  });
});
