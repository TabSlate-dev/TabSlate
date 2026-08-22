import { beforeEach, describe, expect, mock, test } from "bun:test";

const trackCalls = [];
const silentRefreshCalls = [];
const syncPullCalls = [];
const syncPushCalls = [];

let syncPullImpl;
let silentRefreshImpl;
let syncPushImpl;
let queueErrorHandler = null;

class MockApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

mock.module("@/lib/api", () => ({
  api: {
    syncPull: (...args) => {
      syncPullCalls.push(args);
      return syncPullImpl(...args);
    },
    syncPush: (...args) => {
      syncPushCalls.push(args);
      return syncPushImpl(...args);
    },
  },
  ApiError: MockApiError,
}));

mock.module("@/lib/analytics", () => ({
  analytics: {
    track: (name, properties) => {
      trackCalls.push({ name, properties });
    },
  },
}));

class AnalyticsTestQueue {
  constructor(_getCredentials, _onSuccess, onFailure) {
    queueErrorHandler = onFailure;
  }

  enqueue() {}
  async flush() {}
  isEmpty() { return true; }
  destroy() {}
}

class AnalyticsTestSSEClient {
  failureCount = 0;

  start() {}
  destroy() {}
}

function analyticsDependencies() {
  return {
    createQueue: (getCredentials, onSuccess, onFailure) =>
      new AnalyticsTestQueue(getCredentials, onSuccess, onFailure),
    createSseClient: () => new AnalyticsTestSSEClient(),
    syncPull: (...args) => {
      syncPullCalls.push(args);
      return syncPullImpl(...args);
    },
    refreshAuthentication: async () => {
      silentRefreshCalls.push("called");
      return silentRefreshImpl();
    },
    hasRefreshToken: () => true,
  };
}

const { SyncEngine } = await import(`../lib/sync-engine.ts?test=${Date.now()}-${Math.random()}`);

describe("SyncEngine analytics", () => {
  beforeEach(() => {
    trackCalls.length = 0;
    silentRefreshCalls.length = 0;
    syncPullCalls.length = 0;
    syncPushCalls.length = 0;
    queueErrorHandler = null;
    silentRefreshImpl = async () => true;
    syncPushImpl = async () => ({ server_seq: 0, rejected: [] });
    syncPullImpl = async () => {
      throw new Error(`pull failed access_token=super-secret-token&foo=bar ${"x".repeat(150)}`);
    };
  });

  test("tracks sanitized sync errors", async () => {
    const statusCalls = [];
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => null,
      async () => null,
      (status, errorMessage) => {
        statusCalls.push({ status, errorMessage });
      },
      async () => false,
      analyticsDependencies(),
    );

    await engine.forceSync();

    expect(statusCalls.at(-1)?.status).toBe("error");
    expect(trackCalls).toHaveLength(1);
    expect(trackCalls[0]?.name).toBe("sync_error");
    expect(trackCalls[0]?.properties?.message).toContain("access_token=[redacted]");
    expect(trackCalls[0]?.properties?.message).not.toContain("super-secret-token");
    expect(trackCalls[0]?.properties?.message.length).toBeLessThanOrEqual(100);

    engine.destroy();
  });

  test("refreshes authentication instead of reporting an expired access token as a sync error", async () => {
    const statusCalls = [];
    let currentAccessToken = "expired-token";
    syncPullImpl = async (_baseUrl, accessToken) => {
      if (accessToken === "expired-token") {
        throw new MockApiError("access token expired", 401);
      }
      return {
        entities: { workspaces: [], collections: [], bookmarks: [{ id: "bookmark-1" }], tags: [], groups: [] },
        server_seq: 1,
      };
    };
    silentRefreshImpl = async () => {
      currentAccessToken = "refreshed-token";
      return true;
    };

    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: currentAccessToken }),
      () => 0,
      async () => null,
      async () => null,
      (status, errorMessage) => {
        statusCalls.push({ status, errorMessage });
      },
      async () => false,
      analyticsDependencies(),
    );

    const result = await engine.forceSync();

    expect(silentRefreshCalls).toEqual(["called"]);
    expect(syncPullCalls.map(([, accessToken]) => accessToken)).toEqual([
      "expired-token",
      "refreshed-token",
    ]);
    expect(result.pulled).toBe(1);
    expect(statusCalls.some(({ status }) => status === "error")).toBe(false);

    engine.destroy();
  });

  test("refreshes authentication when a background pull receives an expired access token", async () => {
    const statusCalls = [];
    const pullSuccesses = [];
    let currentAccessToken = "expired-token";
    syncPullImpl = async (_baseUrl, accessToken) => {
      if (accessToken === "expired-token") {
        throw new MockApiError("access token expired", 401);
      }
      return {
        entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] },
        server_seq: 1,
      };
    };
    silentRefreshImpl = async () => {
      currentAccessToken = "refreshed-token";
      return true;
    };

    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: currentAccessToken }),
      () => 0,
      async (resp) => {
        pullSuccesses.push(resp.server_seq);
        return null;
      },
      async () => null,
      (status, errorMessage) => {
        statusCalls.push({ status, errorMessage });
      },
      async () => false,
      analyticsDependencies(),
    );

    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(silentRefreshCalls).toEqual(["called"]);
    expect(syncPullCalls.map(([, accessToken]) => accessToken)).toEqual([
      "expired-token",
      "refreshed-token",
    ]);
    expect(pullSuccesses).toEqual([1]);
    expect(statusCalls.some(({ status }) => status === "error")).toBe(false);

    engine.destroy();
  });

  test("retries a force push with refreshed credentials after an expired access token", async () => {
    let currentAccessToken = "expired-token";
    syncPushImpl = async (_baseUrl, accessToken) => {
      if (accessToken === "expired-token") {
        throw new MockApiError("access token expired", 401);
      }
      return { server_seq: 1, rejected: [] };
    };
    silentRefreshImpl = async () => {
      currentAccessToken = "refreshed-token";
      return true;
    };

    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: currentAccessToken }),
      () => 0,
      async () => null,
      async () => null,
      () => {},
      async () => false,
      analyticsDependencies(),
    );

    await engine.forcePush({ bookmarks: [{ id: "bookmark-1" }] });

    expect(silentRefreshCalls).toEqual(["called"]);
    expect(syncPushCalls.map(([, accessToken]) => accessToken)).toEqual([
      "expired-token",
      "refreshed-token",
    ]);

    engine.destroy();
  });

  test("reports a second unauthorized pull without refreshing a second time", async () => {
    const statusCalls = [];
    syncPullImpl = async () => {
      throw new MockApiError("access token expired", 401);
    };

    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "expired-token" }),
      () => 0,
      async () => null,
      async () => null,
      (status, errorMessage) => {
        statusCalls.push({ status, errorMessage });
      },
      async () => false,
      analyticsDependencies(),
    );

    await engine.forceSync();

    expect(silentRefreshCalls).toEqual(["called"]);
    expect(statusCalls.at(-1)?.status).toBe("error");

    engine.destroy();
  });

  test("does not emit duplicate sync_error events for the same repeated error", async () => {
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => null,
      async () => null,
      () => {},
      async () => false,
      analyticsDependencies(),
    );

    if (!queueErrorHandler) {
      throw new Error("queue error handler was not registered");
    }

    const failure = {
      error: new Error("push failed access_token=duplicate-secret"),
      payload: { entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] } },
      retryable: true,
      status: 0,
    };
    queueErrorHandler(failure);
    queueErrorHandler(failure);

    expect(trackCalls).toHaveLength(1);

    engine.destroy();
  });

  test("delegates only retryable 5xx queue failures to the legacy recovery handler", async () => {
    const legacyFailures = [];
    const statuses = [];
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => null,
      async () => null,
      (status) => statuses.push(status),
      async (failure) => {
        legacyFailures.push(failure.status);
        return true;
      },
      analyticsDependencies(),
    );

    if (!queueErrorHandler) {
      throw new Error("queue error handler was not registered");
    }
    const failure = {
      error: new Error("server failed"),
      payload: { entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] } },
      confirmedPayload: { entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] } },
      retryable: true,
      status: 503,
    };
    expect(await queueErrorHandler(failure)).toBe(true);
    expect(legacyFailures).toEqual([503]);
    expect(statuses).not.toContain("error");

    expect(await queueErrorHandler({ ...failure, retryable: false })).toBe(false);
    expect(await queueErrorHandler({ ...failure, status: 429 })).toBe(false);
    expect(await queueErrorHandler({ ...failure, status: 600 })).toBe(false);
    expect(legacyFailures).toEqual([503]);
    expect(statuses.at(-1)).toBe("error");
    engine.destroy();
  });
});
