import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const syncPullCalls = [];
const syncPushCalls = [];
const queueFlushEvents = [];
let syncPullImpl;
let syncPushImpl;
let queueFlushImpl;
let queueExtractImpl;
let queueCopyImpl;
let queuePruneImpl;
let queueEnqueueImpl;
let queueSuccessHandler = null;
let queueFailureHandler = null;
let sseSequenceHandler = null;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

class OrderingTestQueue {
  constructor(_getCredentials, onSuccess, onFailure) {
    queueSuccessHandler = onSuccess;
    queueFailureHandler = onFailure;
  }

  enqueue(entities) { queueEnqueueImpl(entities); }
  async flush() {
    queueFlushEvents.push("queue-flush");
    await queueFlushImpl();
  }
  extractEntities(references) { return queueExtractImpl(references); }
  copyEntities(references) { return queueCopyImpl(references); }
  blockEntities() {}
  async pruneEntities(references, capturedPayload) {
    await queuePruneImpl(references, capturedPayload);
  }
  async ready() {}
  isEmpty() { return true; }
  destroy() {}
}

class OrderingTestSSEClient {
  failureCount = 0;

  constructor(_getCredentials, onSequence) {
    sseSequenceHandler = onSequence;
  }

  start() {}
  destroy() {}
}

function orderingDependencies(overrides = {}) {
  return {
    createQueue: (getCredentials, onSuccess, onFailure) =>
      new OrderingTestQueue(getCredentials, onSuccess, onFailure),
    createSseClient: (getCredentials, onSequence, onStatusChange) =>
      new OrderingTestSSEClient(getCredentials, onSequence, onStatusChange),
    syncPull: (...args) => {
      syncPullCalls.push(args);
      return syncPullImpl(...args);
    },
    syncPush: (...args) => {
      syncPushCalls.push(args);
      return syncPushImpl(...args);
    },
    ...overrides,
  };
}

const { ApiError } = await import("../lib/api.ts");
const {
  SyncEngine,
  SyncRejectedError,
} = await import(`../lib/sync-engine.ts?ordering=${Date.now()}-${Math.random()}`);

describe("SyncEngine ordering", () => {
  beforeEach(() => {
    syncPullCalls.length = 0;
    syncPushCalls.length = 0;
    queueFlushEvents.length = 0;
    queueSuccessHandler = null;
    queueFailureHandler = null;
    sseSequenceHandler = null;
    syncPullImpl = async () => emptyResponse();
    syncPushImpl = async () => ({ server_seq: 1, rejected: [] });
    queueFlushImpl = async () => {};
    queueExtractImpl = () => emptyPayload();
    queueCopyImpl = () => emptyPayload();
    queuePruneImpl = async () => {};
    queueEnqueueImpl = () => {};
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
      orderingDependencies(),
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

  test("confirmed push returns the response body inside pull reconciliation", async () => {
    const expected = { server_seq: 17, rejected: [] };
    syncPushImpl = async () => expected;
    let confirmedResponse;
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async (_response, _isCurrent, context) => {
        confirmedResponse = await context.pushConfirmed({
          entities: {
            workspaces: [{ id: "workspace-confirmed" }],
            collections: [], bookmarks: [], tags: [], groups: [],
          },
        });
        return { errorMessage: null };
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies(),
    );

    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(confirmedResponse).toEqual(expected);
    expect(syncPushCalls).toEqual([[
      "http://localhost:8080",
      "token",
      {
        entities: {
          workspaces: [{ id: "workspace-confirmed" }],
          collections: [], bookmarks: [], tags: [], groups: [],
        },
      },
    ]]);
    engine.destroy();
  });

  test("confirmed push refreshes authentication once after a 401", async () => {
    let accessToken = "expired-token";
    let refreshCalls = 0;
    syncPushImpl = async (_baseUrl, token) => {
      if (token === "expired-token") {
        throw new ApiError("expired", 401);
      }
      return { server_seq: 23, rejected: [] };
    };
    let confirmedResponse;
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken }),
      () => 0,
      async (_response, _isCurrent, context) => {
        confirmedResponse = await context.pushConfirmed(emptyPayload());
        return { errorMessage: null };
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies({
        refreshAuthentication: async () => {
          refreshCalls += 1;
          accessToken = "fresh-token";
          return true;
        },
      }),
    );

    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(refreshCalls).toBe(1);
    expect(syncPushCalls.map((call) => call[1])).toEqual(["expired-token", "fresh-token"]);
    expect(confirmedResponse).toEqual({ server_seq: 23, rejected: [] });
    engine.destroy();
  });

  test("confirmed push uses dependency-safe 900-entity chunks", async () => {
    let confirmedResponse;
    syncPushImpl = async () => ({ server_seq: syncPushCalls.length, rejected: [] });
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async (_response, _isCurrent, context) => {
        confirmedResponse = await context.pushConfirmed({
          entities: {
            workspaces: [{ id: "workspace-root" }],
            collections: Array.from({ length: 899 }, (_, index) => ({ id: `collection-${index}` })),
            bookmarks: [{ id: "bookmark-child" }],
            tags: [],
            groups: [],
          },
        });
        return { errorMessage: null };
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies(),
    );

    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncPushCalls).toHaveLength(2);
    expect(syncPushCalls[0]?.[2].entities.workspaces).toEqual([{ id: "workspace-root" }]);
    expect(syncPushCalls[0]?.[2].entities.collections).toHaveLength(899);
    expect(syncPushCalls[0]?.[2].entities.bookmarks).toEqual([]);
    expect(syncPushCalls[1]?.[2].entities.bookmarks).toEqual([{ id: "bookmark-child" }]);
    expect(confirmedResponse).toEqual({ server_seq: 2, rejected: [] });
    engine.destroy();
  });

  test("captures live and restart-recovery entities with the newest snapshot per ID", async () => {
    const references = [
      { entityType: "workspace", entityId: "workspace-captured" },
      { entityType: "collection", entityId: "collection-captured" },
      { entityType: "bookmark", entityId: "bookmark-captured" },
    ];
    const events = [];
    queueCopyImpl = (receivedReferences) => {
      expect(receivedReferences).toEqual(references);
      return {
        entities: {
          workspaces: [{ id: "workspace-captured" }],
          collections: [],
          bookmarks: [{ id: "bookmark-captured", title: "live-newest" }],
          tags: [], groups: [],
        },
      };
    };
    queuePruneImpl = async (receivedReferences) => {
      expect(receivedReferences).toEqual(references);
      events.push("queue-pruned");
    };
    const deferredMerges = [];
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async (_response, _isCurrent, context) => {
        await context.captureDeferredEntities("workspace-captured", references);
        return { errorMessage: null };
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies({
        copyRecoveryEntities: async (receivedReferences) => {
          expect(receivedReferences).toEqual(references);
          return {
            entities: {
              workspaces: [],
              collections: [{ id: "collection-captured" }],
              bookmarks: [{ id: "bookmark-captured", title: "recovery-older" }],
              tags: [], groups: [],
            },
          };
        },
        mergeDeferredPayload: async (workspaceId, payload) => {
          events.push("deferred-persisted");
          deferredMerges.push({ workspaceId, payload });
        },
        pruneRecoveryEntities: async (receivedReferences) => {
          expect(receivedReferences).toEqual(references);
          events.push("recovery-pruned");
        },
      }),
    );

    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deferredMerges).toEqual([{
      workspaceId: "workspace-captured",
      payload: {
        entities: {
          workspaces: [{ id: "workspace-captured" }],
          collections: [{ id: "collection-captured" }],
          bookmarks: [{ id: "bookmark-captured", title: "live-newest" }],
          tags: [], groups: [],
        },
      },
    }]);
    expect(events).toEqual([
      "deferred-persisted",
      "queue-pruned",
      "recovery-pruned",
    ]);
    engine.destroy();
  });

  test("keeps newer same-ID queue and recovery updates after deferred capture persists", async () => {
    const references = [{ entityType: "bookmark", entityId: "bookmark-captured" }];
    const capturedLiveSnapshot = {
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "captured-live" }],
        tags: [], groups: [],
      },
    };
    const capturedRecoverySnapshot = {
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "captured-recovery" }],
        tags: [], groups: [],
      },
    };
    const newerLiveSnapshot = {
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "newer-live" }],
        tags: [], groups: [],
      },
    };
    const newerRecoverySnapshot = {
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "newer-recovery" }],
        tags: [], groups: [],
      },
    };
    let liveState = structuredClone(capturedLiveSnapshot);
    let recoveryState = structuredClone(capturedRecoverySnapshot);
    const persistenceStarted = deferred();
    const releasePersistence = deferred();
    const captureFinished = deferred();
    const durablePayloads = [];
    queueCopyImpl = () => structuredClone(liveState);
    queueEnqueueImpl = (entities) => {
      liveState = { entities: {
        workspaces: [], collections: [],
        bookmarks: structuredClone(entities.bookmarks ?? []),
        tags: [], groups: [],
      } };
    };
    queuePruneImpl = async (_receivedReferences, capturedPayload) => {
      const capturedBookmark = capturedPayload?.entities.bookmarks[0];
      const currentBookmark = liveState.entities.bookmarks[0];
      if (!capturedBookmark || capturedBookmark.title === currentBookmark?.title) {
        liveState = emptyPayload();
      }
    };

    const engine = new SyncEngine(
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
      orderingDependencies({
        copyRecoveryEntities: async () => structuredClone(recoveryState),
        pruneRecoveryEntities: async (_receivedReferences, capturedPayload) => {
          const capturedBookmark = capturedPayload?.entities.bookmarks[0];
          const currentBookmark = recoveryState.entities.bookmarks[0];
          if (!capturedBookmark || capturedBookmark.title === currentBookmark?.title) {
            recoveryState = emptyPayload();
          }
        },
        mergeDeferredPayload: async (_workspaceId, payload) => {
          durablePayloads.push(payload);
          persistenceStarted.resolve();
          await releasePersistence.promise;
        },
      }),
    );

    engine.start();
    await persistenceStarted.promise;
    engine.enqueue({ bookmarks: newerLiveSnapshot.entities.bookmarks });
    recoveryState = structuredClone(newerRecoverySnapshot);
    releasePersistence.resolve();
    await captureFinished.promise;

    expect(durablePayloads).toEqual([{
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "captured-live" }],
        tags: [], groups: [],
      },
    }]);
    expect(liveState).toEqual(newerLiveSnapshot);
    expect(recoveryState).toEqual(newerRecoverySnapshot);
    engine.destroy();
  });

  test("keeps queue and recovery snapshots exact when deferred persistence fails", async () => {
    const references = [{ entityType: "bookmark", entityId: "bookmark-captured" }];
    const liveSnapshot = {
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "live" }],
        tags: [], groups: [],
      },
    };
    const recoverySnapshot = {
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "recovery" }],
        tags: [], groups: [],
      },
    };
    let liveState = structuredClone(liveSnapshot);
    let recoveryState = structuredClone(recoverySnapshot);
    const deferredStorage = {
      version: 1,
      payloadsByWorkspaceId: {
        "workspace-existing": {
          entities: {
            workspaces: [{ id: "workspace-existing" }],
            collections: [], bookmarks: [], tags: [], groups: [],
          },
        },
      },
    };
    queueExtractImpl = () => {
      const extracted = liveState;
      liveState = emptyPayload();
      return extracted;
    };
    queueCopyImpl = () => structuredClone(liveState);
    queuePruneImpl = async () => {
      liveState = emptyPayload();
    };
    let captureError;
    const captureFinished = deferred();
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async (_response, _isCurrent, context) => {
        try {
          await context.captureDeferredEntities("workspace-captured", references);
        } catch (error) {
          captureError = error;
        }
        captureFinished.resolve();
        return { errorMessage: null };
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies({
        extractRecoveryEntities: async () => {
          const extracted = recoveryState;
          recoveryState = emptyPayload();
          return extracted;
        },
        copyRecoveryEntities: async () => structuredClone(recoveryState),
        pruneRecoveryEntities: async () => {
          recoveryState = emptyPayload();
        },
        mergeDeferredPayload: async () => {
          expect(deferredStorage).toEqual({
            version: 1,
            payloadsByWorkspaceId: {
              "workspace-existing": {
                entities: {
                  workspaces: [{ id: "workspace-existing" }],
                  collections: [], bookmarks: [], tags: [], groups: [],
                },
              },
            },
          });
          throw new Error("deferred persistence failed");
        },
      }),
    );

    engine.start();
    await captureFinished.promise;

    expect(captureError).toEqual(new Error("deferred persistence failed"));
    expect(liveState).toEqual(liveSnapshot);
    expect(recoveryState).toEqual(recoverySnapshot);
    expect(deferredStorage).toEqual({
      version: 1,
      payloadsByWorkspaceId: {
        "workspace-existing": {
          entities: {
            workspaces: [{ id: "workspace-existing" }],
            collections: [], bookmarks: [], tags: [], groups: [],
          },
        },
      },
    });
    engine.destroy();
  });

  test("keeps the live queue exact when recovery snapshot copying fails", async () => {
    const references = [{ entityType: "bookmark", entityId: "bookmark-captured" }];
    const liveSnapshot = {
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "live" }],
        tags: [], groups: [],
      },
    };
    let liveState = structuredClone(liveSnapshot);
    const recoverySnapshot = {
      entities: {
        workspaces: [], collections: [],
        bookmarks: [{ id: "bookmark-captured", title: "recovery" }],
        tags: [], groups: [],
      },
    };
    const recoveryState = structuredClone(recoverySnapshot);
    const deferredStorage = {
      version: 1,
      payloadsByWorkspaceId: {},
    };
    queueExtractImpl = () => {
      const extracted = liveState;
      liveState = emptyPayload();
      return extracted;
    };
    queueCopyImpl = () => structuredClone(liveState);
    queuePruneImpl = async () => {
      liveState = emptyPayload();
    };
    let captureError;
    const captureFinished = deferred();
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async (_response, _isCurrent, context) => {
        try {
          await context.captureDeferredEntities("workspace-captured", references);
        } catch (error) {
          captureError = error;
        }
        captureFinished.resolve();
        return { errorMessage: null };
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies({
        extractRecoveryEntities: async () => {
          throw new Error("recovery read failed");
        },
        copyRecoveryEntities: async () => {
          expect(recoveryState).toEqual(recoverySnapshot);
          throw new Error("recovery read failed");
        },
        mergeDeferredPayload: async () => {},
      }),
    );

    engine.start();
    await captureFinished.promise;

    expect(captureError).toEqual(new Error("recovery read failed"));
    expect(liveState).toEqual(liveSnapshot);
    expect(recoveryState).toEqual(recoverySnapshot);
    expect(deferredStorage).toEqual({ version: 1, payloadsByWorkspaceId: {} });
    engine.destroy();
  });

  test("resolution context rejects use after its pull merge is no longer current", async () => {
    let capturedContext;
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async (_response, _isCurrent, context) => {
        capturedContext = context;
        return { errorMessage: null };
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies(),
    );
    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!capturedContext) {
      throw new Error("pull merge did not receive a resolution context");
    }

    await expect(capturedContext.pushConfirmed(emptyPayload())).rejects.toThrow(
      "Sync resolution is no longer current",
    );
    expect(syncPushCalls).toHaveLength(0);
    engine.destroy();
  });

  test("confirmed push rejects when retirement occurs during transport I/O", async () => {
    const transport = deferred();
    const pushStarted = deferred();
    syncPushImpl = async () => {
      pushStarted.resolve();
      return transport.promise;
    };
    let contextError;
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async (_response, _isCurrent, context) => {
        try {
          await context.pushConfirmed(emptyPayload());
        } catch (error) {
          contextError = error;
        }
        return { errorMessage: null };
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies(),
    );
    engine.start();
    await pushStarted.promise;
    const retiring = engine.retire();
    transport.resolve({ server_seq: 3, rejected: [] });
    await retiring;

    expect(contextError).toBeInstanceOf(Error);
    expect(contextError.message).toBe("Sync resolution is no longer current");
  });

  test("forcePush serializes behind an active pull merge and returns its response", async () => {
    const pullMerge = deferred();
    const pullMergeStarted = deferred();
    const response = { server_seq: 31, rejected: [] };
    syncPushImpl = async () => response;
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => {
        pullMergeStarted.resolve();
        await pullMerge.promise;
        return { errorMessage: null };
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies(),
    );
    engine.start();
    await pullMergeStarted.promise;

    const forcing = engine.forcePush({ bookmarks: [{ id: "bookmark-forced" }] });
    await Promise.resolve();
    expect(syncPushCalls).toHaveLength(0);
    pullMerge.resolve();

    expect(await forcing).toEqual(response);
    engine.destroy();
  });

  test("forcePush resolves a target rejection and throws SyncRejectedError", async () => {
    const rejected = [{ id: "collection-root", type: "collection", reason: "last_active_workspace" }];
    syncPushImpl = async () => ({ server_seq: 41, rejected });
    const resolvedResponses = [];
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => ({ errorMessage: null }),
      async (response) => {
        resolvedResponses.push(response);
        return null;
      },
      () => {},
      async () => false,
      orderingDependencies(),
    );

    const forcing = engine.forcePush({ collections: [{ id: "collection-root" }] });

    await expect(forcing).rejects.toBeInstanceOf(SyncRejectedError);
    await expect(forcing).rejects.toMatchObject({ rejected });
    expect(resolvedResponses).toEqual([{ server_seq: 41, rejected }]);
    engine.destroy();
  });

  test("startup resolves a lifecycle intent by pull before flushing the ordinary queue", async () => {
    const events = [];
    let lifecyclePending = true;
    syncPullImpl = async () => {
      events.push("pull-request");
      return emptyResponse();
    };
    queueFlushImpl = async () => {
      events.push("ordinary-flush");
    };
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => {
        events.push("lifecycle-resolution");
        lifecyclePending = false;
        return { errorMessage: null };
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies({
        workspaceLifecycleSyncGate: {
          shouldResolveWorkspaceLifecycleBeforePush: async () => lifecyclePending,
        },
      }),
    );

    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["pull-request", "lifecycle-resolution", "ordinary-flush"]);
    engine.destroy();
  });

  test("manual sync resolves a lifecycle intent by pull before flushing the ordinary queue", async () => {
    const events = [];
    let lifecyclePending = true;
    syncPullImpl = async () => {
      events.push("pull-request");
      return emptyResponse();
    };
    queueFlushImpl = async () => {
      events.push("ordinary-flush");
    };
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => {
        events.push("lifecycle-resolution");
        lifecyclePending = false;
        return { errorMessage: null };
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies({
        workspaceLifecycleSyncGate: {
          shouldResolveWorkspaceLifecycleBeforePush: async () => lifecyclePending,
        },
      }),
    );

    await engine.forceSync();

    expect(events).toEqual(["pull-request", "lifecycle-resolution", "ordinary-flush"]);
    engine.destroy();
  });

  test("retires a running pull callback before resolving teardown", async () => {
    const pullStarted = deferred();
    const releasePull = deferred();
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async (_response, isCurrent) => {
        pullStarted.resolve();
        await releasePull.promise;
        return isCurrent() ? null : "should not be applied";
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies(),
    );
    engine.start();
    await pullStarted.promise;
    let retired = false;
    const retiring = engine.retire().then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);
    releasePull.resolve();
    await retiring;
    expect(retired).toBe(true);
  });

  test("retires before a transport pull can enter durable callback work", async () => {
    const pullResponse = deferred();
    let pullCallbacks = 0;
    syncPullImpl = async () => pullResponse.promise;
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => {
        pullCallbacks += 1;
        return null;
      },
      async () => null,
      () => {},
      async () => false,
      orderingDependencies(),
    );
    engine.start();
    await Promise.resolve();

    await engine.retire();
    pullResponse.resolve(emptyResponse());
    await Promise.resolve();

    expect(pullCallbacks).toBe(0);
  });

  test("does not start a queued push resolution after retirement", async () => {
    const pullStarted = deferred();
    const releasePull = deferred();
    let pushResolutions = 0;
    syncPullImpl = async () => emptyResponse();
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => {
        pullStarted.resolve();
        await releasePull.promise;
        return null;
      },
      async () => {
        pushResolutions += 1;
        return null;
      },
      () => {},
      async () => false,
      orderingDependencies(),
    );
    engine.start();
    await pullStarted.promise;
    if (!queueSuccessHandler) {
      throw new Error("queue success handler was not registered");
    }
    const queuedResolution = queueSuccessHandler(
      { server_seq: 1, rejected: [] },
      emptyPayload(),
    );
    const retiring = engine.retire();
    releasePull.resolve();
    await Promise.all([queuedResolution, retiring]);

    expect(pushResolutions).toBe(0);
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
      orderingDependencies(),
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
        return {
          errorMessage: pullSuccessCount === 1 ? "Local data needs attention" : null,
        };
      },
      async () => null,
      (status, errorMessage) => statuses.push({ status, errorMessage }),
      async () => false,
      orderingDependencies(),
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

  test("treats a failed 5xx legacy diagnosis as retryable queue failure", async () => {
    const statuses = [];
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => null,
      async () => null,
      (status, errorMessage) => statuses.push({ status, errorMessage }),
      async () => {
        throw new Error("diagnosis failed access_token=secret-token");
      },
      orderingDependencies(),
    );

    if (!queueFailureHandler) {
      throw new Error("queue failure handler was not registered");
    }

    const handled = await queueFailureHandler({
      error: new Error("push failed"),
      payload: emptyPayload(),
      confirmedPayload: emptyPayload(),
      retryable: true,
      status: 500,
    });

    expect(handled).toBe(false);
    expect(engine.currentStatus).toBe("error");
    expect(engine.currentErrorMessage).toBe("diagnosis failed access_token=[redacted]");
    expect(statuses.at(-1)).toEqual({
      status: "error",
      errorMessage: "diagnosis failed access_token=[redacted]",
    });
    engine.destroy();
  });

  test("does not emit a status after destruction when a legacy diagnosis resolves false", async () => {
    const statuses = [];
    const diagnosis = deferred();
    let diagnosisStarted = false;
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => null,
      async () => null,
      (status, errorMessage) => statuses.push({ status, errorMessage }),
      async () => {
        diagnosisStarted = true;
        return diagnosis.promise;
      },
      orderingDependencies(),
    );

    if (!queueFailureHandler) {
      throw new Error("queue failure handler was not registered");
    }

    const handling = queueFailureHandler({
      error: new Error("old engine 500"),
      payload: emptyPayload(),
      confirmedPayload: emptyPayload(),
      retryable: true,
      status: 500,
    });
    await Promise.resolve();
    expect(diagnosisStarted).toBe(true);
    engine.destroy();
    diagnosis.resolve(false);

    expect(await handling).toBe(false);
    expect(statuses).toEqual([]);
  });

  test("does not emit a status after destruction when a legacy diagnosis rejects", async () => {
    const statuses = [];
    const diagnosis = deferred();
    let diagnosisStarted = false;
    const engine = new SyncEngine(
      () => ({ baseUrl: "http://localhost:8080", accessToken: "token" }),
      () => 0,
      async () => null,
      async () => null,
      (status, errorMessage) => statuses.push({ status, errorMessage }),
      async () => {
        diagnosisStarted = true;
        return diagnosis.promise;
      },
      orderingDependencies(),
    );

    if (!queueFailureHandler) {
      throw new Error("queue failure handler was not registered");
    }

    const handling = queueFailureHandler({
      error: new Error("old engine 500"),
      payload: emptyPayload(),
      confirmedPayload: emptyPayload(),
      retryable: true,
      status: 500,
    });
    await Promise.resolve();
    expect(diagnosisStarted).toBe(true);
    engine.destroy();
    diagnosis.reject(new Error("old engine diagnosis failed"));

    expect(await handling).toBe(false);
    expect(statuses).toEqual([]);
  });
});
