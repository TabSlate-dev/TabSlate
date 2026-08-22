import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const syncPullCalls = [];
let syncPullImpl;
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

  enqueue() {}
  async flush() {}
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

function orderingDependencies() {
  return {
    createQueue: (getCredentials, onSuccess, onFailure) =>
      new OrderingTestQueue(getCredentials, onSuccess, onFailure),
    createSseClient: (getCredentials, onSequence, onStatusChange) =>
      new OrderingTestSSEClient(getCredentials, onSequence, onStatusChange),
    syncPull: (...args) => {
      syncPullCalls.push(args);
      return syncPullImpl(...args);
    },
  };
}

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
        return pullSuccessCount === 1 ? "Local data needs attention" : null;
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
