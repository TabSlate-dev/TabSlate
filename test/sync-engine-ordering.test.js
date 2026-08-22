import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const syncPullCalls = [];
let syncPullImpl;
let queueSuccessHandler = null;
let queueFailureHandler = null;
let sseSequenceHandler = null;

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function emptyResponse(sequence = 1) {
  return {
    entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] },
    server_seq: sequence,
  };
}

function emptyPayload() {
  return {
    entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] },
  };
}

mock.module("@/lib/api", () => ({
  api: {
    syncPull: (...args) => {
      syncPullCalls.push(args);
      return syncPullImpl(...args);
    },
  },
  ApiError: class MockApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  },
}));

mock.module("@/lib/analytics", () => ({
  analytics: { track() {} },
}));

mock.module("@/store/auth-store", () => ({
  useAuthStore: { getState: () => ({ silentRefresh: async () => true, refreshToken: "refresh" }) },
}));

mock.module("@/lib/sync-queue", () => ({
  SyncQueue: class MockSyncQueue {
    constructor(_getCredentials, onSuccess, onFailure) {
      queueSuccessHandler = onSuccess;
      queueFailureHandler = onFailure;
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

    constructor(_getCredentials, onSequence) {
      sseSequenceHandler = onSequence;
    }

    start() {}
    destroy() {}
  },
}));

const { SyncEngine } = await import(`../lib/sync-engine.ts?ordering=${Date.now()}-${Math.random()}`);

describe("SyncEngine ordering", () => {
  beforeEach(() => {
    syncPullCalls.length = 0;
    queueSuccessHandler = null;
    queueFailureHandler = null;
    sseSequenceHandler = null;
    syncPullImpl = async () => emptyResponse();
  });

  afterEach(() => {
    queueSuccessHandler = null;
    queueFailureHandler = null;
    sseSequenceHandler = null;
  });

  test("waits for rejected push reconciliation before pulling", async () => {
    const events = [];
    const pushResolution = deferred();
    const pullMerge = deferred();
    syncPullImpl = async () => {
      events.push("pull-request");
      return emptyResponse();
    };
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => {
        events.push("pull-merge-start");
        await pullMerge.promise;
        events.push("pull-merge-end");
        return null;
      },
      async () => {
        events.push("push-resolution-start");
        await pushResolution.promise;
        events.push("push-resolution-end");
        return null;
      },
      () => {},
      async () => false,
    );

    if (!queueSuccessHandler) {
      throw new Error("queue success handler was not registered");
    }
    const pushed = queueSuccessHandler({ server_seq: 1, rejected: [{ id: "c1", reason: "invalid_parent" }] }, emptyPayload());
    await Promise.resolve();
    expect(events).toEqual(["push-resolution-start"]);

    pushResolution.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["push-resolution-start", "push-resolution-end", "pull-request", "pull-merge-start"]);

    pullMerge.resolve();
    await pushed;
    expect(events).toEqual([
      "push-resolution-start",
      "push-resolution-end",
      "pull-request",
      "pull-merge-start",
      "pull-merge-end",
    ]);
    engine.destroy();
  });

  test("coalesces SSE requests arriving during a pull into a later non-overlapping pass", async () => {
    const firstMerge = deferred();
    const mergeStarts = [];
    let pullCount = 0;
    syncPullImpl = async () => {
      pullCount += 1;
      return emptyResponse(pullCount);
    };
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async (response) => {
        mergeStarts.push(response.server_seq);
        if (response.server_seq === 1) {
          await firstMerge.promise;
        }
        return null;
      },
      async () => null,
      () => {},
      async () => false,
    );

    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mergeStarts).toEqual([1]);
    if (!sseSequenceHandler) {
      throw new Error("SSE sequence handler was not registered");
    }
    sseSequenceHandler(2);
    sseSequenceHandler(3);
    await Promise.resolve();
    expect(mergeStarts).toEqual([1]);

    firstMerge.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pullCount).toBe(2);
    expect(mergeStarts).toEqual([1, 2]);
    engine.destroy();
  });

  test("keeps a persistent conflict error until a later pull clears it", async () => {
    const statuses = [];
    let pullSuccessCount = 0;
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => {
        pullSuccessCount += 1;
        return pullSuccessCount === 1 ? "Local data needs attention" : null;
      },
      async () => null,
      (status, errorMessage) => statuses.push({ status, errorMessage }),
      async () => false,
    );

    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.currentStatus).toBe("error");
    expect(engine.currentErrorMessage).toBe("Local data needs attention");
    if (!sseSequenceHandler) {
      throw new Error("SSE sequence handler was not registered");
    }
    sseSequenceHandler(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.currentStatus).toBe("idle");
    expect(statuses.at(-1)).toEqual({ status: "idle", errorMessage: undefined });
    engine.destroy();
  });
});
