// @ts-expect-error Bun provides this test module at runtime.
import { afterEach, describe, expect, mock, test } from "bun:test";

const ACCOUNT_DATA_COLLECTION = {
  data_collection: [
    "authenticationInfo",
    "personallyIdentifyingInfo",
    "searchTerms",
    "websiteContent",
  ],
};

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

function useBuild(browser: "chrome" | "firefox") {
  mock.module("@/lib/browser/env", () => ({
    isFirefoxBuild: () => browser === "firefox",
  }));
}

function stubPermissions(permissions: Record<string, unknown>) {
  (globalThis as { chrome?: unknown }).chrome = { permissions };
}

function importDataCollectionModule() {
  return import(`../lib/browser/data-collection.ts?test=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

describe("account data consent", () => {
  test("Chromium builds have no built-in consent and never touch the permissions API", async () => {
    useBuild("chrome");
    const contains = mock(async () => false);
    const request = mock(async () => false);
    stubPermissions({ contains, request });

    const { hasAccountDataConsent, requestAccountDataConsent } = await importDataCollectionModule();

    expect(await hasAccountDataConsent()).toBe(true);
    expect(await requestAccountDataConsent()).toBe(true);
    expect(contains).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  test("Firefox builds check and request the optional account data collection", async () => {
    useBuild("firefox");
    const contains = mock(async () => false);
    const request = mock(async () => true);
    stubPermissions({ contains, request });

    const { hasAccountDataConsent, requestAccountDataConsent } = await importDataCollectionModule();

    expect(await hasAccountDataConsent()).toBe(false);
    expect(await requestAccountDataConsent()).toBe(true);
    expect(contains).toHaveBeenCalledWith(ACCOUNT_DATA_COLLECTION);
    expect(request).toHaveBeenCalledWith(ACCOUNT_DATA_COLLECTION);
  });

  test("Firefox consent fails closed when the permissions API errors", async () => {
    useBuild("firefox");
    stubPermissions({
      contains: mock(async () => {
        throw new Error("permissions unavailable");
      }),
    });

    const { hasAccountDataConsent } = await importDataCollectionModule();

    expect(await hasAccountDataConsent()).toBe(false);
  });
});
