import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

class MockApiError extends Error {
  constructor(message, status, retryAfter) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const syncPushCalls = [];
const onSuccessCalls = [];
const onErrorCalls = [];
const bufferedSnapshots = [];
const consumedSnapshots = [];
const silentRefreshCalls = [];
const syncPushCredentials = [];
const clearedConflicts = [];
const recordedPayloadFailures = [];

let syncPushImpl;
let loadRecoverySnapshotImpl;
let silentRefreshImpl;
let currentRefreshToken;

mock.module("../lib/api", () => ({
  api: {
    syncPush: (_baseUrl, accessToken, payload) => {
      syncPushCalls.push(payload);
      syncPushCredentials.push(accessToken);
      return syncPushImpl(payload, accessToken);
    },
  },
  ApiError: MockApiError,
  isSyncEntityType: (value) => value === "workspace" || value === "collection" ||
    value === "bookmark" || value === "saved_group" || value === "tag",
  searchBookmarks: mock(async () => []),
}));

mock.module("../store/auth-store", () => ({
  useAuthStore: {
    getState: () => ({
      refreshToken: currentRefreshToken,
      silentRefresh: async () => {
        silentRefreshCalls.push("called");
        return silentRefreshImpl();
      },
    }),
  },
}));

mock.module("../lib/sync-recovery", () => ({
  bufferSyncRecoverySnapshot: (snapshot) => {
    bufferedSnapshots.push(snapshot);
  },
  loadSyncRecoverySnapshot: async () => {
    const snapshot = await loadRecoverySnapshotImpl();
    if (snapshot) {
      consumedSnapshots.push(snapshot);
    }
    return snapshot;
  },
  clearSyncRecoverySnapshot: () => {
    bufferedSnapshots.length = 0;
    consumedSnapshots.length = 0;
  },
}));

mock.module("../lib/sync-queue-conflicts", () => ({
  syncQueueConflictRegistry: {
    ready: async () => {},
    clearEntities: async (references) => {
      clearedConflicts.push(references);
    },
    filterPayload: (payload) => payload,
    recordPayload: async (payload, status) => {
      recordedPayloadFailures.push({ payload, status });
    },
  },
}));

const {
  SyncQueue,
  computeRetryDelay,
  isRetryablePushError,
} = await import("../lib/sync-queue");

describe("SyncQueue", () => {
  beforeEach(() => {
    syncPushCalls.length = 0;
    onSuccessCalls.length = 0;
    onErrorCalls.length = 0;
    bufferedSnapshots.length = 0;
    consumedSnapshots.length = 0;
    silentRefreshCalls.length = 0;
    syncPushCredentials.length = 0;
    clearedConflicts.length = 0;
    recordedPayloadFailures.length = 0;
    loadRecoverySnapshotImpl = async () => null;
    syncPushImpl = async () => ({ server_seq: 0, rejected: [] });
    silentRefreshImpl = async () => true;
    currentRefreshToken = "refresh-token";
  });

  test("rehydrates recovery state before normal pushes resume", async () => {
    const recoverySnapshot = {
      entities: {
        workspaces: [],
        collections: [],
        bookmarks: [{ id: "recovered-bookmark" }],
        tags: [],
        groups: [],
      },
    };

    let resolveRecovery = null;
    loadRecoverySnapshotImpl = () =>
      new Promise((resolve) => {
        resolveRecovery = resolve;
      });

    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      (resp) => {
        onSuccessCalls.push(resp);
      },
      (failure) => {
        onErrorCalls.push(failure.error.message);
        return false;
      },
    );

    queue.enqueue({
      bookmarks: [{ id: "new-bookmark" }],
    });

    const flushPromise = queue.flush();
    await Promise.resolve();

    expect(syncPushCalls).toHaveLength(0);

    if (!resolveRecovery) {
      throw new Error("recovery loader was not invoked");
    }
    resolveRecovery(recoverySnapshot);

    await flushPromise;

    expect(consumedSnapshots).toEqual([recoverySnapshot]);
    expect(syncPushCalls).toHaveLength(1);
    expect(syncPushCalls[0]?.entities.bookmarks.map((bookmark) => bookmark.id).sort()).toEqual([
      "new-bookmark",
      "recovered-bookmark",
    ]);

    queue.destroy();
  });

  test("waits for structured rejection resolution and discards unsent chunks", async () => {
    let releaseResolution;
    let notifyResolutionStarted;
    const resolutionStarted = new Promise((resolve) => {
      notifyResolutionStarted = resolve;
    });
    syncPushImpl = async () => ({
      server_seq: 9,
      rejected: [{ id: "bookmark-12", type: "bookmark", reason: "quota_exceeded" }],
    });

    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {
        notifyResolutionStarted();
        await new Promise((resolve) => {
          releaseResolution = resolve;
        });
      },
      async () => false,
    );

    queue.enqueue({
      bookmarks: Array.from({ length: 901 }, (_, index) => ({ id: `stale-bookmark-${index}` })),
    });
    const flushPromise = queue.flush();
    await resolutionStarted;

    let settled = false;
    void flushPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(syncPushCalls).toHaveLength(1);
    expect(settled).toBe(false);
    if (!releaseResolution) {
      throw new Error("rejection resolution was not started");
    }
    releaseResolution();
    await flushPromise;

    expect(syncPushCalls).toHaveLength(1);
    expect(queue.isEmpty()).toBe(true);
    queue.destroy();
  });

  test("classifies retryable push failures and applies deterministic jitter", () => {
    expect(isRetryablePushError(new MockApiError("timeout", 408))).toBe(true);
    expect(isRetryablePushError(new MockApiError("rate", 429))).toBe(true);
    expect(isRetryablePushError(new MockApiError("server", 500))).toBe(true);
    expect(isRetryablePushError(new MockApiError("invalid", 422))).toBe(false);
    expect(computeRetryDelay(2000, new MockApiError("server", 500), () => 0)).toBe(1600);
    expect(computeRetryDelay(2000, new MockApiError("server", 500), () => 1)).toBe(2400);
  });

  test("keeps an explicit edit clear when a later sweep respects the same conflict", async () => {
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
    );

    queue.enqueue({ bookmarks: [{ id: "edited-after-conflict" }] });
    queue.enqueue({ bookmarks: [{ id: "edited-after-conflict" }] }, "respect");
    await queue.flush();

    expect(clearedConflicts).toEqual([[{ entityType: "bookmark", entityId: "edited-after-conflict" }]]);
    queue.destroy();
  });

  test("records permanent failures without requeueing their payload", async () => {
    syncPushImpl = async () => {
      throw new MockApiError("unprocessable", 422);
    };
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
    );

    queue.enqueue({ bookmarks: [{ id: "permanent-bookmark" }] });
    await queue.flush();

    expect(recordedPayloadFailures).toEqual([{ payload: {
      entities: {
        workspaces: [], collections: [], bookmarks: [{ id: "permanent-bookmark" }], tags: [], groups: [],
      },
    }, status: 422 }]);
    expect(queue.isEmpty()).toBe(true);
    queue.destroy();
  });

  test("discards a failed snapshot when failure resolution handles it", async () => {
    syncPushImpl = async () => {
      throw new MockApiError("legacy failure", 500);
    };
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => true,
      { random: () => 0.5 },
    );

    queue.enqueue({ bookmarks: [{ id: "handled-bookmark" }] });
    await queue.flush();

    expect(queue.isEmpty()).toBe(true);
    expect(recordedPayloadFailures).toEqual([]);
    queue.destroy();
  });

  test("keeps a newer edit when a retryable in-flight snapshot is requeued", async () => {
    let rejectFirstPush;
    let notifyFirstPush;
    const firstPushStarted = new Promise((resolve) => {
      notifyFirstPush = resolve;
    });
    let calls = 0;
    syncPushImpl = async () => {
      calls += 1;
      if (calls === 1) {
        notifyFirstPush();
        await new Promise((_, reject) => {
          rejectFirstPush = reject;
        });
      }
      return { server_seq: 3, rejected: [] };
    };
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
      { random: () => 0.5 },
    );

    queue.enqueue({ bookmarks: [{ id: "edited-bookmark", title: "before failure" }] });
    const firstFlush = queue.flush();
    await firstPushStarted;
    queue.enqueue({ bookmarks: [{ id: "edited-bookmark", title: "after failure" }] });
    if (!rejectFirstPush) {
      throw new Error("first push did not become in-flight");
    }
    rejectFirstPush(new MockApiError("server", 500));
    await firstFlush;
    await queue.flush();

    expect(syncPushCalls.at(-1)?.entities.bookmarks).toEqual([
      { id: "edited-bookmark", title: "after failure" },
    ]);
    queue.destroy();
  });

  test("uses the capped probe delay after five identical server failures", async () => {
    const timeoutSpy = spyOn(globalThis, "setTimeout");
    syncPushImpl = async () => {
      throw new MockApiError("repeated server failure", 500);
    };
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
      { random: () => 0.5 },
    );

    for (let index = 0; index < 5; index += 1) {
      queue.enqueue({ bookmarks: [{ id: "repeat-bookmark" }] });
      await queue.flush();
    }

    expect(timeoutSpy.mock.calls.at(-1)?.[1]).toBe(300000);
    timeoutSpy.mockRestore();
    queue.destroy();
  });

  test("surfaces recovery hydration errors and continues pushing new work", async () => {
    loadRecoverySnapshotImpl = async () => {
      throw new Error("recovery load failed");
    };

    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      (resp) => {
        onSuccessCalls.push(resp);
      },
      (failure) => {
        onErrorCalls.push(failure.error.message);
        return false;
      },
    );

    queue.enqueue({
      bookmarks: [{ id: "new-after-error" }],
    });

    await queue.flush();

    expect(onErrorCalls).toEqual(["recovery load failed"]);
    expect(syncPushCalls).toHaveLength(1);
    expect(syncPushCalls[0]?.entities.bookmarks).toEqual([{ id: "new-after-error" }]);

    queue.destroy();
  });

  test("reports partial success before scheduling retry on a later chunk failure", async () => {
    let pushCount = 0;
    syncPushImpl = async (payload) => {
      pushCount += 1;
      if (pushCount === 1) {
        expect(payload.entities.bookmarks).toHaveLength(900);
        return {
          server_seq: 7,
          rejected: [{ id: "bookmark-12", reason: "quota_exceeded", type: "bookmark" }],
        };
      }
      throw new Error("second chunk failed");
    };

    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      (resp) => {
        onSuccessCalls.push(resp);
      },
      (err) => {
        onErrorCalls.push(err.message);
      },
    );

    const bookmarks = Array.from({ length: 901 }, (_, index) => ({ id: `bookmark-${index}` }));
    queue.enqueue({ bookmarks });

    await queue.flush();

    expect(onSuccessCalls).toEqual([
      {
        server_seq: 7,
        rejected: [{ id: "bookmark-12", reason: "quota_exceeded", type: "bookmark" }],
      },
    ]);
    expect(onErrorCalls).toEqual([]);
    expect(queue.isEmpty()).toBe(true);

    queue.destroy();
  });

  test("reports partial success even when confirmed chunks return server_seq 0 and no rejections", async () => {
    let pushCount = 0;
    syncPushImpl = async (payload) => {
      pushCount += 1;
      if (pushCount === 1) {
        expect(payload.entities.bookmarks).toHaveLength(900);
        return {
          server_seq: 0,
          rejected: [],
        };
      }
      throw new Error("second chunk failed");
    };

    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      (resp) => {
        onSuccessCalls.push(resp);
      },
      (failure) => {
        onErrorCalls.push(failure.error.message);
        return false;
      },
    );

    const bookmarks = Array.from({ length: 901 }, (_, index) => ({ id: `bookmark-zero-${index}` }));
    queue.enqueue({ bookmarks });

    await queue.flush();

    expect(onSuccessCalls).toEqual([
      {
        server_seq: 0,
        rejected: [],
      },
    ]);
    expect(onErrorCalls).toEqual(["second chunk failed"]);

    queue.destroy();
  });

  test("buffers a 401-failed chunk for recovery", async () => {
    syncPushImpl = async () => {
      throw new MockApiError("unauthorized", 401);
    };

    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      (resp) => {
        onSuccessCalls.push(resp);
      },
      (err) => {
        onErrorCalls.push(err.message);
      },
    );

    queue.enqueue({ bookmarks: [{ id: "bookmark-401" }] });

    await queue.flush();

    expect(bufferedSnapshots).toEqual([
      {
        entities: {
          workspaces: [],
          collections: [],
          bookmarks: [{ id: "bookmark-401" }],
          tags: [],
          groups: [],
        },
      },
    ]);
    expect(silentRefreshCalls).toEqual(["called"]);

    queue.destroy();
  });

  test("refreshes authentication when a push is forbidden", async () => {
    syncPushImpl = async () => {
      throw new MockApiError("forbidden", 403);
    };

    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      (resp) => {
        onSuccessCalls.push(resp);
      },
      (err) => {
        onErrorCalls.push(err.message);
      },
    );

    queue.enqueue({ bookmarks: [{ id: "bookmark-403" }] });

    await queue.flush();

    expect(silentRefreshCalls).toEqual(["called"]);
    expect(onErrorCalls).toEqual([]);

    queue.destroy();
  });

  test("retries a buffered push after authentication refreshes", async () => {
    let currentAccessToken = "expired-token";
    syncPushImpl = async (_payload, accessToken) => {
      if (accessToken === "expired-token") {
        throw new MockApiError("access token expired", 401);
      }
      return { server_seq: 1, rejected: [] };
    };
    silentRefreshImpl = async () => {
      currentAccessToken = "refreshed-token";
      return true;
    };

    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: currentAccessToken }),
      (resp) => {
        onSuccessCalls.push(resp);
      },
      (err) => {
        onErrorCalls.push(err.message);
      },
    );

    queue.enqueue({ bookmarks: [{ id: "bookmark-retry" }] });

    await queue.flush();
    await queue.flush();

    expect(silentRefreshCalls).toEqual(["called"]);
    expect(syncPushCredentials).toEqual(["expired-token", "refreshed-token"]);
    expect(onSuccessCalls).toEqual([{ server_seq: 1, rejected: [] }]);
    expect(onErrorCalls).toEqual([]);

    queue.destroy();
  });

  test("replays a buffered push after a transient refresh failure before pushing later work", async () => {
    let currentAccessToken = "expired-token";
    loadRecoverySnapshotImpl = async () => bufferedSnapshots.shift() ?? null;
    syncPushImpl = async (_payload, accessToken) => {
      if (accessToken === "expired-token") {
        throw new MockApiError("access token expired", 401);
      }
      return { server_seq: 1, rejected: [] };
    };
    silentRefreshImpl = async () => false;

    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: currentAccessToken }),
      (resp) => {
        onSuccessCalls.push(resp);
      },
      (err) => {
        onErrorCalls.push(err.message);
      },
    );

    queue.enqueue({ bookmarks: [{ id: "bookmark-buffered" }] });
    await queue.flush();

    currentAccessToken = "refreshed-token";
    queue.enqueue({ bookmarks: [{ id: "bookmark-later" }] });
    await queue.flush();

    expect(syncPushCalls.at(-1)?.entities.bookmarks.map((bookmark) => bookmark.id).sort()).toEqual([
      "bookmark-buffered",
      "bookmark-later",
    ]);
    expect(onErrorCalls).toEqual([]);

    queue.destroy();
  });

  test("keeps a newer queued edit when replaying an expired-token snapshot", async () => {
    let currentAccessToken = "expired-token";
    let resolveRefresh;
    let notifyRefreshStarted;
    const refreshStarted = new Promise((resolve) => {
      notifyRefreshStarted = resolve;
    });
    syncPushImpl = async (_payload, accessToken) => {
      if (accessToken === "expired-token") {
        throw new MockApiError("access token expired", 401);
      }
      return { server_seq: 1, rejected: [] };
    };
    silentRefreshImpl = () => {
      notifyRefreshStarted();
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    };

    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: currentAccessToken }),
      (resp) => {
        onSuccessCalls.push(resp);
      },
      (err) => {
        onErrorCalls.push(err.message);
      },
    );

    queue.enqueue({ bookmarks: [{ id: "bookmark-edited", title: "before refresh" }] });
    const firstFlush = queue.flush();
    await refreshStarted;

    queue.enqueue({ bookmarks: [{ id: "bookmark-edited", title: "after refresh" }] });
    currentAccessToken = "refreshed-token";
    if (!resolveRefresh) {
      throw new Error("refresh resolver was not assigned");
    }
    resolveRefresh(true);
    await firstFlush;
    await queue.flush();

    expect(syncPushCalls.at(-1)?.entities.bookmarks).toEqual([
      { id: "bookmark-edited", title: "after refresh" },
    ]);
    expect(onErrorCalls).toEqual([]);

    queue.destroy();
  });

  test("automatically retries a buffered push after a transient refresh failure", async () => {
    let currentAccessToken = "expired-token";
    loadRecoverySnapshotImpl = async () => bufferedSnapshots.shift() ?? null;
    syncPushImpl = async (_payload, accessToken) => {
      if (accessToken === "expired-token") {
        throw new MockApiError("access token expired", 401);
      }
      return { server_seq: 1, rejected: [] };
    };
    silentRefreshImpl = async () => false;

    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: currentAccessToken }),
      (resp) => {
        onSuccessCalls.push(resp);
      },
      (err) => {
        onErrorCalls.push(err.message);
      },
    );

    queue.enqueue({ bookmarks: [{ id: "bookmark-auto-retry" }] });
    await queue.flush();
    currentAccessToken = "refreshed-token";
    await new Promise((resolve) => setTimeout(resolve, 2_100));

    expect(syncPushCredentials).toEqual(["expired-token", "refreshed-token"]);
    expect(onSuccessCalls).toEqual([{ server_seq: 1, rejected: [] }]);
    expect(onErrorCalls).toEqual([]);

    queue.destroy();
  });
});
