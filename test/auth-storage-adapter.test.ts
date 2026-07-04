// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, describe, expect, mock, test } from "bun:test";

async function importAuthStorageAdapter() {
  return import(`../lib/auth-storage-adapter.ts?test=${Date.now()}-${Math.random()}`);
}

describe("authStorageAdapter Firefox storage compatibility", () => {
  beforeEach(() => {
    globalThis.chrome = {
      storage: {
        local: {
          get: mock(async () => ({})),
          set: mock(() => {
            throw new Error("chrome.storage.local.set should not be used in Firefox mode");
          }),
          remove: mock(() => {
            throw new Error("chrome.storage.local.remove should not be used in Firefox mode");
          }),
        },
        session: {
          get: mock(async () => ({})),
          set: mock(() => {
            throw new Error("chrome.storage.session.set should not be used in Firefox mode");
          }),
          remove: mock(() => {
            throw new Error("chrome.storage.session.remove should not be used in Firefox mode");
          }),
        },
      },
    } as typeof chrome;

    const browserGlobals = globalThis as typeof globalThis & { browser: typeof browser };
    browserGlobals.browser = {
      storage: {
        local: {
          get: mock(async () => ({})),
          set: mock(async () => {}),
          remove: mock(async () => {}),
        },
        session: {
          get: mock(async () => ({})),
          set: mock(async () => {}),
          remove: mock(async () => {}),
        },
      },
    } as typeof browser;
  });

  test("writes through the Firefox browser.storage APIs when they are available", async () => {
    const { authStorageAdapter } = await importAuthStorageAdapter();

    await expect(authStorageAdapter.setItem("tabslate-auth", JSON.stringify({
      state: {
        user: { id: "u1" },
        accessToken: "token-1",
        refreshToken: "refresh-1",
      },
    }))).resolves.toBeUndefined();

    expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
    expect(browser.storage.session.set).toHaveBeenCalledTimes(1);
  });
});
