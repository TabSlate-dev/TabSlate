import { beforeEach, describe, expect, mock, test } from "bun:test";

const clearDBCalls = [];

class MockApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const refresh = mock(async () => {
  throw new MockApiError("invalid refresh token", 401);
});

mock.module("@/lib/api", () => ({
  ApiError: MockApiError,
  api: { refresh },
}));

mock.module("@/lib/idb", () => ({
  clearDB: async () => {
    clearDBCalls.push("cleared");
  },
}));

mock.module("@/lib/sync-recovery", () => ({
  clearSyncRecoverySnapshot: () => {},
}));

mock.module("@/store/i18n-store", () => ({
  useI18nStore: { getState: () => ({ language: "en" }) },
  resolveAcceptLanguage: () => "en",
}));

mock.module("@/lib/auth-storage-adapter", () => ({
  authStorageAdapter: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

const { useAuthStore } = await import("../store/auth-store");

describe("invalid authenticated session cleanup", () => {
  beforeEach(() => {
    clearDBCalls.length = 0;
    refresh.mockClear();
    useAuthStore.setState({
      user: {
        id: "user-1",
        name: "User",
        email: "user@example.com",
        is_verified: true,
      },
      accessToken: null,
      refreshToken: "invalid-refresh",
      serverUrl: "https://api.tabslate.com",
      otpSentAt: null,
    });
  });

  test("clears account data before transitioning to guest", async () => {
    const refreshed = await useAuthStore.getState().silentRefresh();

    expect(refreshed).toBe(false);
    expect(clearDBCalls).toEqual(["cleared"]);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });
});
