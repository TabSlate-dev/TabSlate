import { beforeEach, describe, expect, mock, test } from "bun:test";

const clearDBCalls = [];
const events = [];
let clearDBImpl = async () => {
  clearDBCalls.push("cleared");
  events.push("cleared");
};
let retireImpl = async () => {};

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

const login = mock(async () => ({
  access_token: "new-access",
  refresh_token: "new-refresh",
  user: {
    id: "user-2",
    name: "New User",
    email: "new@example.com",
    is_verified: true,
  },
}));

mock.module("@/lib/api", () => ({
  ApiError: MockApiError,
  api: { refresh, login },
}));

mock.module("@/lib/idb", () => ({
  clearDB: () => clearDBImpl(),
}));

mock.module("@/lib/sync-recovery", () => ({
  clearSyncRecoverySnapshot: () => {},
}));

mock.module("@/lib/sync-lifecycle", () => ({
  retireActiveSyncLifecycle: () => retireImpl(),
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
    events.length = 0;
    refresh.mockClear();
    login.mockClear();
    clearDBImpl = async () => {
      clearDBCalls.push("cleared");
      events.push("cleared");
    };
    retireImpl = async () => {};
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
    const unsubscribe = useAuthStore.subscribe((state, previousState) => {
      if (
        previousState.user !== null &&
        state.user === null &&
        state.refreshToken === null
      ) {
        events.push("guest");
      }
    });
    const refreshed = await useAuthStore.getState().silentRefresh();
    unsubscribe();

    expect(refreshed).toBe(false);
    expect(clearDBCalls).toEqual(["cleared"]);
    expect(events).toEqual(["cleared", "guest"]);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });

  test("retires active sync work before clearing a definitively expired session", async () => {
    const releaseRetirement = {};
    let finishRetirement;
    const retirement = new Promise((resolve) => {
      finishRetirement = resolve;
    });
    retireImpl = async () => {
      events.push("retire");
      await retirement;
    };
    const refreshed = useAuthStore.getState().silentRefresh();
    await Promise.resolve();
    expect(events).toEqual(["retire"]);
    finishRetirement(releaseRetirement);
    await refreshed;
    expect(events).toEqual(["retire", "cleared"]);
  });

  test("retains a newer authenticated session after delayed cleanup", async () => {
    let resumeClearDB;
    let notifyClearDBStarted;
    const clearDBStarted = new Promise((resolve) => {
      notifyClearDBStarted = resolve;
    });
    const clearDBFinished = new Promise((resolve) => {
      resumeClearDB = resolve;
    });
    clearDBImpl = () => {
      clearDBCalls.push("cleared");
      events.push("cleared");
      notifyClearDBStarted();
      return clearDBFinished;
    };

    const refreshed = useAuthStore.getState().silentRefresh();
    await clearDBStarted;
    await useAuthStore.getState().login("new@example.com", "password1234");
    resumeClearDB();
    await refreshed;

    expect(useAuthStore.getState().user?.id).toBe("user-2");
    expect(useAuthStore.getState().accessToken).toBe("new-access");
    expect(useAuthStore.getState().refreshToken).toBe("new-refresh");
  });
});
