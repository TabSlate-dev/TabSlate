import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const pushedPayloads = [];

mock.module("../lib/api", () => ({
  api: {
    syncPush: async (_baseUrl, _accessToken, payload) => {
      pushedPayloads.push(payload);
      return { server_seq: 1, rejected: [] };
    },
  },
  ApiError: class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  },
}));

mock.module("../store/auth-store", () => ({
  useAuthStore: {
    getState: () => ({
      refreshToken: null,
      silentRefresh: async () => false,
    }),
  },
}));

mock.module("../lib/sync-queue-conflicts", () => ({
  syncQueueConflictRegistry: {
    ready: async () => {},
    clearEntities: async () => {},
    filterPayload: (payload) => payload,
    recordPayload: async () => {},
  },
}));

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function payload(bookmarks) {
  return {
    entities: {
      workspaces: [],
      collections: [],
      bookmarks,
      tags: [],
      groups: [],
    },
  };
}

const recovery = await import("../lib/sync-recovery.ts");
const { SyncQueue } = await import("../lib/sync-queue.ts");
const { SyncEngine } = await import("../lib/sync-engine.ts?deferred-capture");

describe("SyncEngine deferred capture", () => {
  beforeEach(() => {
    pushedPayloads.length = 0;
    recovery.clearSyncRecoverySnapshot();
  });

  afterEach(() => {
    recovery.clearSyncRecoverySnapshot();
  });

  test("keeps newer same-ID sources while pruning unchanged captured entities", async () => {
    const references = [
      { entityType: "bookmark", entityId: "bookmark-newer" },
      { entityType: "bookmark", entityId: "bookmark-unchanged" },
    ];
    const capturedLive = payload([
      { id: "bookmark-newer", title: "captured-live" },
      { id: "bookmark-unchanged", title: "unchanged" },
    ]);
    const capturedRecovery = payload([
      { id: "bookmark-newer", title: "captured-recovery" },
      { id: "bookmark-unchanged", title: "unchanged" },
    ]);
    const newerLive = { id: "bookmark-newer", title: "newer-live" };
    const newerRecovery = { id: "bookmark-newer", title: "newer-recovery" };
    const persistenceStarted = deferred();
    const releasePersistence = deferred();
    const captureFinished = deferred();
    const durablePayloads = [];
    let queue;
    let engine;

    try {
      recovery.bufferSyncRecoverySnapshot(capturedRecovery);
      queue = new SyncQueue(
        () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
        async () => {},
        async () => false,
      );
      queue.enqueue(capturedLive.entities);
      await queue.ready();

      engine = new SyncEngine(
        () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
        () => 0,
        async (_response, _isCurrent, context) => {
          await context.captureDeferredEntities("workspace-captured", references);
          captureFinished.resolve();
          return { errorMessage: null };
        },
        async () => null,
        () => {},
        async () => false,
        {
          createQueue: () => queue,
          createSseClient: () => ({ failureCount: 0, start() {}, destroy() {} }),
          syncPull: async () => ({
            entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] },
            server_seq: 1,
          }),
          mergeDeferredPayload: async (_workspaceId, deferredPayload) => {
            durablePayloads.push(deferredPayload);
            persistenceStarted.resolve();
            await releasePersistence.promise;
          },
        },
      );

      engine.start();
      await persistenceStarted.promise;
      engine.enqueue({ bookmarks: [newerLive] });
      recovery.bufferSyncRecoverySnapshot(payload([newerRecovery]));
      releasePersistence.resolve();
      await captureFinished.promise;
      await queue.flush();

      expect(durablePayloads).toEqual([payload([
        { id: "bookmark-newer", title: "captured-live" },
        { id: "bookmark-unchanged", title: "unchanged" },
      ])]);
      expect(pushedPayloads).toEqual([payload([newerLive])]);
      expect(await recovery.loadSyncRecoverySnapshot()).toEqual(payload([newerRecovery]));
    } finally {
      engine?.destroy();
      queue?.destroy();
    }
  });
});
