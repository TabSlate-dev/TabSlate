import { beforeEach, describe, expect, mock, test } from "bun:test";

class MockApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const syncPushCalls = [];
const onSuccessCalls = [];
const onErrorCalls = [];
const bufferedSnapshots = [];
const consumedSnapshots = [];
const silentRefreshCalls = [];

let syncPushImpl;
let loadRecoverySnapshotImpl;

mock.module("../lib/api", () => ({
  api: {
    syncPush: (_baseUrl, _accessToken, payload) => {
      syncPushCalls.push(payload);
      return syncPushImpl(payload);
    },
  },
  ApiError: MockApiError,
}));

mock.module("../store/auth-store", () => ({
  useAuthStore: {
    getState: () => ({
      silentRefresh: async () => {
        silentRefreshCalls.push("called");
        return true;
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

const { SyncQueue } = await import("../lib/sync-queue");

describe("SyncQueue", () => {
  beforeEach(() => {
    syncPushCalls.length = 0;
    onSuccessCalls.length = 0;
    onErrorCalls.length = 0;
    bufferedSnapshots.length = 0;
    consumedSnapshots.length = 0;
    silentRefreshCalls.length = 0;
    loadRecoverySnapshotImpl = async () => null;
    syncPushImpl = async () => ({ server_seq: 0, rejected: [] });
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
      (err) => {
        onErrorCalls.push(err.message);
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

  test("surfaces recovery hydration errors and continues pushing new work", async () => {
    loadRecoverySnapshotImpl = async () => {
      throw new Error("recovery load failed");
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
    expect(onErrorCalls).toEqual(["second chunk failed"]);
    expect(queue.isEmpty()).toBe(false);

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
      (err) => {
        onErrorCalls.push(err.message);
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
});
