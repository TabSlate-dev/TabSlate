// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@/lib/api";

// The tests below replace this module for the rest of the run, so keep the current one to put back afterwards.
const realBrowserEnv = { ...(await import("@/lib/browser/env")) };

afterAll(() => {
  mock.module("@/lib/browser/env", () => realBrowserEnv);
});

function importApiModule() {
  return import(`../lib/api.ts?test=${Date.now()}-${Math.random()}`);
}

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

/** Stubs Firefox's answer to permissions.contains({ data_collection }). */
function stubAccountDataConsent(granted: boolean) {
  const contains = mock(async () => granted);
  (globalThis as { chrome?: unknown }).chrome = { permissions: { contains } };
  return contains;
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

describe("api Firefox network error diagnostics", () => {
  test("maps Firefox fetch failures to an actionable ApiError", async () => {
    mock.module("@/lib/browser/env", () => ({
      isFirefoxBuild: () => true,
      getBrowserBuild: () => "firefox",
      isChromiumBuild: () => false,
    }));
    stubAccountDataConsent(true);

    globalThis.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const { api } = await importApiModule();

    await expect(
      api.login("https://sync.tabslate.com", "user@example.test", "not-a-real-password"),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      message:
        "Network request failed. If you are using Firefox, ensure the server allows requests from Firefox extension origins (moz-extension://...).",
    } satisfies Partial<ApiError>);
  });
});

describe("api Firefox data collection consent", () => {
  test("never contacts the sync server before account data consent is granted", async () => {
    mock.module("@/lib/browser/env", () => ({
      isFirefoxBuild: () => true,
      getBrowserBuild: () => "firefox",
      isChromiumBuild: () => false,
    }));
    const contains = stubAccountDataConsent(false);
    const fetchMock = mock(async () => new Response("{}"));
    globalThis.fetch = fetchMock as typeof fetch;

    const { api, searchBookmarks } = await importApiModule();

    await expect(
      api.login("https://sync.tabslate.com", "user@example.test", "not-a-real-password"),
    ).rejects.toMatchObject({ name: "ApiError", status: 0 } satisfies Partial<ApiError>);
    await expect(
      searchBookmarks("https://sync.tabslate.com", "access-token", "private query"),
    ).rejects.toMatchObject({ name: "ApiError", status: 0 } satisfies Partial<ApiError>);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(contains).toHaveBeenCalledWith({
      data_collection: [
        "authenticationInfo",
        "personallyIdentifyingInfo",
        "searchTerms",
        "websiteContent",
      ],
    });
  });
});
