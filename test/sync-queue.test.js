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
let clearEntitiesImpl;
let conflictRegistryReadyImpl;

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
  extractSyncRecoveryEntities: async () => ({
    entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] },
  }),
}));

mock.module("../lib/sync-queue-conflicts", () => ({
  syncQueueConflictRegistry: {
    ready: () => conflictRegistryReadyImpl(),
    clearEntities: async (references) => {
      clearedConflicts.push(references);
      await clearEntitiesImpl(references);
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
    clearEntitiesImpl = async () => {};
    conflictRegistryReadyImpl = async () => {};
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
    expect(computeRetryDelay(2000, new MockApiError("rate", 429, 3), () => 0)).toBe(3000);
    expect(computeRetryDelay(2000, new MockApiError("rate", 429, 1), () => 1)).toBe(2400);
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

  test("extracts only matching live entities and their pending conflict clears", async () => {
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
    );
    queue.enqueue({
      workspaces: [{ id: "workspace-captured" }, { id: "workspace-kept" }],
      collections: [{ id: "collection-captured" }, { id: "collection-kept" }],
      bookmarks: [{ id: "bookmark-captured" }, { id: "bookmark-kept" }],
      tags: [{ id: "tag-captured" }, { id: "tag-kept" }],
      groups: [{ id: "group-captured" }, { id: "group-kept" }],
    });
    const references = [
      { entityType: "workspace", entityId: "workspace-captured" },
      { entityType: "collection", entityId: "collection-captured" },
      { entityType: "bookmark", entityId: "bookmark-captured" },
      { entityType: "tag", entityId: "tag-captured" },
      { entityType: "saved_group", entityId: "group-captured" },
    ];

    expect(queue.extractEntities(references)).toEqual({
      entities: {
        workspaces: [{ id: "workspace-captured" }],
        collections: [{ id: "collection-captured" }],
        bookmarks: [{ id: "bookmark-captured" }],
        tags: [{ id: "tag-captured" }],
        groups: [{ id: "group-captured" }],
      },
    });
    await queue.flush();

    expect(syncPushCalls).toEqual([{
      entities: {
        workspaces: [{ id: "workspace-kept" }],
        collections: [{ id: "collection-kept" }],
        bookmarks: [{ id: "bookmark-kept" }],
        tags: [{ id: "tag-kept" }],
        groups: [{ id: "group-kept" }],
      },
    }]);
    expect(clearedConflicts).toEqual([[
      { entityType: "workspace", entityId: "workspace-kept" },
      { entityType: "collection", entityId: "collection-kept" },
      { entityType: "bookmark", entityId: "bookmark-kept" },
      { entityType: "tag", entityId: "tag-kept" },
      { entityType: "saved_group", entityId: "group-kept" },
    ]]);
    queue.destroy();
  });

  test("conditionally prunes only the queue snapshot captured before a newer same-ID enqueue", async () => {
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
    );
    const references = [{ entityType: "bookmark", entityId: "bookmark-captured" }];
    queue.enqueue({ bookmarks: [{ id: "bookmark-captured", title: "captured" }] });
    const captured = queue.copyEntities(references);

    queue.enqueue({ bookmarks: [{ id: "bookmark-captured", title: "newer" }] });
    await queue.pruneEntities(references, captured);
    await queue.flush();

    expect(syncPushCalls).toEqual([{
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "newer" }],
        tags: [], groups: [],
      },
    }]);
    queue.destroy();
  });

  test("prunes idempotently and blocks captured aggregate entities from re-entering", async () => {
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
    );
    const references = [
      { entityType: "workspace", entityId: "workspace-blocked" },
      { entityType: "collection", entityId: "collection-blocked" },
      { entityType: "bookmark", entityId: "bookmark-blocked" },
      { entityType: "tag", entityId: "tag-blocked" },
      { entityType: "saved_group", entityId: "group-blocked" },
    ];
    const blockedEntities = {
      workspaces: [{ id: "workspace-blocked" }],
      collections: [{ id: "collection-blocked" }],
      bookmarks: [{ id: "bookmark-blocked" }],
      tags: [{ id: "tag-blocked" }],
      groups: [{ id: "group-blocked" }],
    };
    queue.enqueue(blockedEntities);

    await queue.pruneEntities(references);
    await queue.pruneEntities(references);
    queue.blockEntities(references);
    queue.enqueue(blockedEntities);
    queue.enqueue({ bookmarks: [{ id: "bookmark-allowed" }] });
    await queue.flush();

    expect(syncPushCalls).toEqual([{
      entities: {
        workspaces: [],
        collections: [],
        bookmarks: [{ id: "bookmark-allowed" }],
        tags: [],
        groups: [],
      },
    }]);
    expect(clearedConflicts).toEqual([[
      { entityType: "bookmark", entityId: "bookmark-allowed" },
    ]]);
    queue.destroy();
  });

  test("defers an automatic push without taking the queued snapshot", async () => {
    const scheduledCallbacks = [];
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      scheduledCallbacks.push(callback);
      return 1;
    });
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
      {},
      { shouldDeferOrdinaryPush: async () => true },
    );
    queue.enqueue({ bookmarks: [{ id: "lifecycle-child" }] });
    await Promise.resolve();
    const pushCallback = scheduledCallbacks.at(-1);
    if (!pushCallback) {
      throw new Error("automatic push was not scheduled");
    }

    pushCallback();
    await new Promise((resolve) => setImmediate(resolve));

    expect(syncPushCalls).toHaveLength(0);
    expect(queue.isEmpty()).toBe(false);
    timerSpy.mockRestore();
    await queue.flush();
    expect(syncPushCalls[0]?.entities.bookmarks).toEqual([{ id: "lifecycle-child" }]);
    queue.destroy();
  });

  test("keeps a clear edit queued when another clear persists first", async () => {
    let releaseFirstClear;
    let notifyFirstClear;
    const firstClearStarted = new Promise((resolve) => {
      notifyFirstClear = resolve;
    });
    let clearCalls = 0;
    clearEntitiesImpl = async () => {
      clearCalls += 1;
      if (clearCalls !== 1) {
        return;
      }
      notifyFirstClear();
      await new Promise((resolve) => {
        releaseFirstClear = resolve;
      });
    };
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
    );

    queue.enqueue({ bookmarks: [{ id: "clear-a" }] });
    const firstFlush = queue.flush();
    await firstClearStarted;
    queue.enqueue({ bookmarks: [{ id: "clear-b" }] });
    if (!releaseFirstClear) {
      throw new Error("first conflict clear did not start");
    }
    releaseFirstClear();
    await firstFlush;

    expect(syncPushCalls).toHaveLength(1);
    expect(syncPushCalls[0]?.entities.bookmarks).toEqual([{ id: "clear-a" }]);
    await queue.flush();
    expect(syncPushCalls[1]?.entities.bookmarks).toEqual([{ id: "clear-b" }]);
    expect(clearedConflicts).toEqual([
      [{ entityType: "bookmark", entityId: "clear-a" }],
      [{ entityType: "bookmark", entityId: "clear-b" }],
    ]);
    queue.destroy();
  });

  test("retains a newer clear marker for an overlapping entity edit", async () => {
    let releaseFirstClear;
    let notifyFirstClear;
    const firstClearStarted = new Promise((resolve) => {
      notifyFirstClear = resolve;
    });
    let clearCalls = 0;
    clearEntitiesImpl = async () => {
      clearCalls += 1;
      if (clearCalls !== 1) {
        return;
      }
      notifyFirstClear();
      await new Promise((resolve) => {
        releaseFirstClear = resolve;
      });
    };
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
    );

    queue.enqueue({ bookmarks: [{ id: "clear-overlap", title: "A" }] });
    const firstFlush = queue.flush();
    await firstClearStarted;
    queue.enqueue({ bookmarks: [{ id: "clear-overlap", title: "B" }] });
    if (!releaseFirstClear) {
      throw new Error("first conflict clear did not start");
    }
    releaseFirstClear();
    await firstFlush;
    await queue.flush();

    expect(syncPushCalls.map((payload) => payload.entities.bookmarks)).toEqual([
      [{ id: "clear-overlap", title: "A" }],
      [{ id: "clear-overlap", title: "B" }],
    ]);
    expect(clearedConflicts).toEqual([
      [{ entityType: "bookmark", entityId: "clear-overlap" }],
      [{ entityType: "bookmark", entityId: "clear-overlap" }],
    ]);
    queue.destroy();
  });

  test("retains a snapshot and clear marker when conflict persistence fails", async () => {
    let clearCalls = 0;
    clearEntitiesImpl = async () => {
      clearCalls += 1;
      if (clearCalls === 1) {
        throw new Error("conflict persistence failed");
      }
    };
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => true,
      { random: () => 0.5 },
    );

    queue.enqueue({ bookmarks: [{ id: "clear-retry" }] });
    await queue.flush();
    expect(syncPushCalls).toHaveLength(0);
    await queue.flush();

    expect(syncPushCalls[0]?.entities.bookmarks).toEqual([{ id: "clear-retry" }]);
    expect(clearedConflicts).toEqual([
      [{ entityType: "bookmark", entityId: "clear-retry" }],
      [{ entityType: "bookmark", entityId: "clear-retry" }],
    ]);
    queue.destroy();
  });

  test("does not let an older in-flight failure restore over a newer successful edit", async () => {
    let releaseFirstPush;
    let notifyFirstPush;
    const firstPushStarted = new Promise((resolve) => {
      notifyFirstPush = resolve;
    });
    let callCount = 0;
    syncPushImpl = async () => {
      callCount += 1;
      if (callCount === 1) {
        notifyFirstPush();
        return new Promise((_, reject) => {
          releaseFirstPush = reject;
        });
      }
      return { server_seq: 11, rejected: [] };
    };
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
      { random: () => 0.5 },
    );

    queue.enqueue({ bookmarks: [{ id: "serialized-edit", title: "A" }] });
    const firstFlush = queue.flush();
    await firstPushStarted;
    queue.enqueue({ bookmarks: [{ id: "serialized-edit", title: "B" }] });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(syncPushCalls).toHaveLength(1);
    if (!releaseFirstPush) {
      throw new Error("first request is not in flight");
    }
    releaseFirstPush(new MockApiError("late A failure", 500));
    await firstFlush;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncPushCalls).toHaveLength(2);
    expect(syncPushCalls[1]?.entities.bookmarks).toEqual([{ id: "serialized-edit", title: "B" }]);
    queue.destroy();
  });

  test("waits for a structured rejection callback before sending a queued resweep", async () => {
    let releaseSuccess;
    let notifySuccess;
    const successStarted = new Promise((resolve) => {
      notifySuccess = resolve;
    });
    let callCount = 0;
    syncPushImpl = async () => {
      callCount += 1;
      if (callCount === 1) {
        return { server_seq: 1, rejected: [{ id: "blocked", type: "bookmark", reason: "stale_parent" }] };
      }
      return { server_seq: 2, rejected: [] };
    };
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {
        notifySuccess();
        await new Promise((resolve) => {
          releaseSuccess = resolve;
        });
      },
      async () => false,
    );

    queue.enqueue({ bookmarks: [{ id: "blocked" }] });
    const firstFlush = queue.flush();
    await successStarted;
    queue.enqueue({ bookmarks: [{ id: "resweep" }] }, "respect");
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(syncPushCalls).toHaveLength(1);
    if (!releaseSuccess) {
      throw new Error("success callback did not start");
    }
    releaseSuccess();
    await firstFlush;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncPushCalls).toHaveLength(2);
    expect(syncPushCalls[1]?.entities.bookmarks).toEqual([{ id: "resweep" }]);
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

  test("passes already confirmed chunks to the later failure handler", async () => {
    let pushCount = 0;
    let receivedFailure;
    syncPushImpl = async () => {
      pushCount += 1;
      if (pushCount === 1) {
        return { server_seq: 4, rejected: [] };
      }
      throw new MockApiError("later failure", 500);
    };
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async (failure) => {
        receivedFailure = failure;
        return true;
      },
    );

    queue.enqueue({ bookmarks: Array.from({ length: 901 }, (_, index) => ({ id: `confirmed-${index}` })) });
    await queue.flush();

    expect(receivedFailure.confirmedPayload.entities.bookmarks).toHaveLength(900);
    expect(receivedFailure.confirmedPayload.entities.bookmarks[0]).toEqual({ id: "confirmed-0" });
    expect(receivedFailure.payload.entities.bookmarks).toEqual([{ id: "confirmed-900" }]);
    queue.destroy();
  });

  test("does not re-arm a retry after destruction during a network failure", async () => {
    let rejectPush;
    let notifyPush;
    const pushStarted = new Promise((resolve) => {
      notifyPush = resolve;
    });
    syncPushImpl = async () => {
      notifyPush();
      return new Promise((_, reject) => {
        rejectPush = reject;
      });
    };
    const timerSpy = spyOn(globalThis, "setTimeout");
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
    );

    queue.enqueue({ bookmarks: [{ id: "destroy-network" }] });
    const flushPromise = queue.flush();
    await pushStarted;
    queue.destroy();
    const timerCallsAfterDestroy = timerSpy.mock.calls.length;
    if (!rejectPush) {
      throw new Error("push did not become in flight");
    }
    rejectPush(new MockApiError("network failure", 500));
    await flushPromise;

    expect(timerSpy.mock.calls).toHaveLength(timerCallsAfterDestroy);
    expect(syncPushCalls).toHaveLength(1);
    timerSpy.mockRestore();
  });

  test("does not push after destruction during recovery hydration", async () => {
    let releaseRecovery;
    loadRecoverySnapshotImpl = () => new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    const timerSpy = spyOn(globalThis, "setTimeout");
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
    );

    queue.enqueue({ bookmarks: [{ id: "destroy-recovery" }] });
    const flushPromise = queue.flush();
    await Promise.resolve();
    queue.destroy();
    const timerCallsAfterDestroy = timerSpy.mock.calls.length;
    if (!releaseRecovery) {
      throw new Error("recovery hydration did not start");
    }
    releaseRecovery(null);
    await flushPromise;

    expect(syncPushCalls).toHaveLength(0);
    expect(timerSpy.mock.calls).toHaveLength(timerCallsAfterDestroy);
    timerSpy.mockRestore();
  });

  test("does not schedule authentication recovery after destruction", async () => {
    let releaseRefresh;
    let notifyRefresh;
    const refreshStarted = new Promise((resolve) => {
      notifyRefresh = resolve;
    });
    syncPushImpl = async () => {
      throw new MockApiError("unauthorized", 401);
    };
    silentRefreshImpl = () => {
      notifyRefresh();
      return new Promise((resolve) => {
        releaseRefresh = resolve;
      });
    };
    const timerSpy = spyOn(globalThis, "setTimeout");
    const queue = new SyncQueue(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      async () => {},
      async () => false,
    );

    queue.enqueue({ bookmarks: [{ id: "destroy-auth" }] });
    const flushPromise = queue.flush();
    await refreshStarted;
    queue.destroy();
    const timerCallsAfterDestroy = timerSpy.mock.calls.length;
    if (!releaseRefresh) {
      throw new Error("refresh did not start");
    }
    releaseRefresh(true);
    await flushPromise;

    expect(timerSpy.mock.calls).toHaveLength(timerCallsAfterDestroy);
    expect(syncPushCalls).toHaveLength(1);
    timerSpy.mockRestore();
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
