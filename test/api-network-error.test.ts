// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, mock, test } from "bun:test";
import { ApiError } from "@/lib/api";

function importApiModule() {
  return import(`../lib/api.ts?test=${Date.now()}-${Math.random()}`);
}

describe("api Firefox network error diagnostics", () => {
  test("maps Firefox fetch failures to an actionable ApiError", async () => {
    mock.module("@/lib/browser/env", () => ({
      isFirefoxBuild: () => true,
    }));

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
