import { beforeEach, describe, expect, mock, test } from "bun:test";

const clearDBCalls = [];
const events = [];
let clearDBImpl = async () => {
  clearDBCalls.push("cleared");
  events.push("cleared");
};
let retireImpl = async () => {};
let refreshImpl = async () => {
  throw new MockApiError("invalid refresh token", 401);
};

class MockApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const refresh = mock((...args) => refreshImpl(...args));

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
  retireActiveSyncLifecycle: (options) => retireImpl(options),
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
    refreshImpl = async () => {
      throw new MockApiError("invalid refresh token", 401);
    };
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

  test("upgrades a shared refresh when the active pull joins it", async () => {
    let releaseRefresh;
    let notifyRefreshStarted;
    const refreshStarted = new Promise((resolve) => {
      notifyRefreshStarted = resolve;
    });
    const refreshRelease = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    let retirementOptions;
    refreshImpl = async () => {
      notifyRefreshStarted();
      await refreshRelease;
      throw new MockApiError("invalid refresh token", 401);
    };
    retireImpl = async (options) => {
      retirementOptions = options;
    };

    const queueLikeRefresh = useAuthStore.getState().silentRefresh();
    await refreshStarted;
    const pullLikeRefresh = useAuthStore.getState().silentRefresh({ fromCurrentPull: true });
    releaseRefresh();
    await Promise.all([queueLikeRefresh, pullLikeRefresh]);

    expect(retirementOptions).toEqual({ awaitCurrentPull: false });
  });

  test("keeps full retirement for a refresh with no active pull consumer", async () => {
    let retirementOptions = "not-called";
    retireImpl = async (options) => {
      retirementOptions = options;
    };

    await useAuthStore.getState().silentRefresh();

    expect(retirementOptions).toBeUndefined();
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
