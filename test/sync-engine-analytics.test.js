import { beforeEach, describe, expect, mock, test } from "bun:test";

const trackCalls = [];

let syncPullImpl;
let queueErrorHandler = null;

mock.module("@/lib/api", () => ({
  api: {
    syncPull: (...args) => syncPullImpl(...args),
    syncPush: async () => ({ server_seq: 0, rejected: [] }),
  },
}));

mock.module("@/lib/analytics", () => ({
  analytics: {
    track: (name, properties) => {
      trackCalls.push({ name, properties });
    },
  },
}));

mock.module("@/lib/sync-queue", () => ({
  SyncQueue: class MockSyncQueue {
    constructor(_getCredentials, _onSuccess, onError) {
      queueErrorHandler = onError;
    }

    enqueue() {}
    async flush() {}
    isEmpty() { return true; }
    destroy() {}
  },
}));

mock.module("@/lib/sse-client", () => ({
  SSEClient: class MockSSEClient {
    failureCount = 0;

    start() {}
    destroy() {}
  },
}));

const { SyncEngine } = await import("../lib/sync-engine");

describe("SyncEngine analytics", () => {
  beforeEach(() => {
    trackCalls.length = 0;
    queueErrorHandler = null;
    syncPullImpl = async () => {
      throw new Error(`pull failed access_token=super-secret-token&foo=bar ${"x".repeat(150)}`);
    };
  });

  test("tracks sanitized sync errors", async () => {
    const statusCalls = [];
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      () => {},
      () => {},
      (status, errorMessage) => {
        statusCalls.push({ status, errorMessage });
      },
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

  test("does not emit duplicate sync_error events for the same repeated error", async () => {
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      () => {},
      () => {},
      () => {},
    );

    if (!queueErrorHandler) {
      throw new Error("queue error handler was not registered");
    }

    queueErrorHandler(new Error("push failed access_token=duplicate-secret"));
    queueErrorHandler(new Error("push failed access_token=duplicate-secret"));

    expect(trackCalls).toHaveLength(1);

    engine.destroy();
  });
});
