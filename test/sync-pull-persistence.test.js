import { describe, expect, test } from "bun:test";
import { persistPulledSyncResponse } from "../lib/sync-pull-persistence";
import {
  commitWorkspacePullCheckpoint,
  resolveAuthoritativeWorkspacePull,
} from "../lib/workspace-lifecycle-coordinator";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

const response = {
  entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] },
  server_seq: 7,
};

describe("pull persistence boundary", () => {
  test("a newly discovered capability performs an after_seq=0 authoritative pull", async () => {
    const calls = [];
    const delta = {
      ...response,
      server_seq: 7,
      capabilities: { workspace_parent_tombstone: true },
    };
    const full = {
      ...response,
      server_seq: 71,
      capabilities: { workspace_parent_tombstone: true },
    };
    const resolved = await resolveAuthoritativeWorkspacePull({
      context: {
        async pullConfirmed(afterSeq) { calls.push(`pull:${afterSeq}`); return full; },
        async pushConfirmed() { throw new Error("unexpected push"); },
        async captureDeferredEntities() {},
        blockEntities() {},
        async pruneEntities() {},
        isCurrent: () => true,
      },
      response: delta,
      serverUrl: "https://sync.example",
      userId: "user-1",
      services: {
        async readFullPull() { calls.push("read-marker"); return undefined; },
        async persistCapability(supported) { calls.push(`capability:${supported}`); },
        async invalidateFullPull() { calls.push("invalidate-marker"); },
      },
    });

    expect(resolved).toEqual({ response: full, capabilitySupported: true });
    expect(calls).toEqual(["capability:true", "read-marker", "pull:0"]);
  });

  test("a later omitted capability invalidates the scoped migration without an unsafe pull", async () => {
    const calls = [];
    const resolved = await resolveAuthoritativeWorkspacePull({
      context: {
        async pullConfirmed() { calls.push("unsafe-pull"); return response; },
        async pushConfirmed() { throw new Error("unexpected push"); },
        async captureDeferredEntities() {},
        blockEntities() {},
        async pruneEntities() {},
        isCurrent: () => true,
      },
      response,
      serverUrl: "https://sync.example",
      userId: "user-1",
      services: {
        async readFullPull() { return { version: 1 }; },
        async persistCapability(supported) { calls.push(`capability:${supported}`); },
        async invalidateFullPull() { calls.push("invalidate-marker"); },
      },
    });

    expect(resolved).toEqual({ response, capabilitySupported: false });
    expect(calls).toEqual(["capability:false", "invalidate-marker"]);
  });

  test("commits the scoped full-pull marker and authoritative localSeq before Zustand", async () => {
    const transaction = deferred();
    const events = [];
    const operationsSeen = [];
    const committing = commitWorkspacePullCheckpoint({
      serverUrl: "https://sync.example/path",
      userId: "user-1",
      serverSeq: 73,
      capabilitySupported: true,
    }, {
      async commit(operations) {
        operationsSeen.push(...operations);
        events.push("transaction-start");
        await transaction.promise;
        events.push("transaction-commit");
      },
      apply(sequence) {
        events.push(`zustand:${sequence}`);
      },
    });

    await flush();
    expect(events).toEqual(["transaction-start"]);
    transaction.resolve();
    await committing;
    expect(events).toEqual(["transaction-start", "transaction-commit", "zustand:73"]);
    expect(operationsSeen).toContainEqual({
      type: "put",
      store: "kv",
      value: { key: "localSeq", value: 73 },
    });
    expect(operationsSeen.find((operation) => operation.value?.value?.version === 1)?.value.value)
      .toMatchObject({ userId: "user-1", serverOrigin: "https://sync.example", serverSeq: 73 });
  });

  test("does not advance seq or sweep before all durable writes resolve", async () => {
    const workspaces = deferred();
    const groups = deferred();
    const bookmarks = deferred();
    const sequence = deferred();
    const calls = [];
    let localSequence = 0;
    const persisting = persistPulledSyncResponse(response, {
      mergeWorkspaces: async () => { calls.push("workspaces"); await workspaces.promise; },
      mergeGroups: async () => { calls.push("groups"); await groups.promise; },
      mergeBookmarks: async () => { calls.push("bookmarks"); await bookmarks.promise; },
      setLocalSeq: async () => { calls.push("sequence"); await sequence.promise; },
      setLocalSeqRef: (value) => { localSequence = value; },
      sweepAll: async () => { calls.push("sweep"); },
    });

    await flush();
    expect(calls).toEqual(["workspaces"]);
    expect(localSequence).toBe(0);
    workspaces.resolve();
    await flush();
    expect(calls).toEqual(["workspaces", "groups"]);
    expect(localSequence).toBe(0);
    groups.resolve();
    await flush();
    expect(calls).toEqual(["workspaces", "groups", "bookmarks"]);
    expect(localSequence).toBe(0);
    bookmarks.resolve();
    await flush();
    expect(calls).toEqual(["workspaces", "groups", "bookmarks", "sequence"]);
    expect(localSequence).toBe(0);
    sequence.resolve();
    await persisting;
    expect(calls).toEqual(["workspaces", "groups", "bookmarks", "sequence", "sweep"]);
    expect(localSequence).toBe(7);
  });

  test("does not advance seq or sweep when durable persistence rejects", async () => {
    const workspaces = deferred();
    const calls = [];
    let localSequence = 0;
    const persisting = persistPulledSyncResponse(response, {
      mergeWorkspaces: async () => { calls.push("workspaces"); await workspaces.promise; },
      mergeGroups: async () => { calls.push("groups"); },
      mergeBookmarks: async () => { calls.push("bookmarks"); },
      setLocalSeq: async () => { calls.push("sequence"); },
      setLocalSeqRef: (value) => { localSequence = value; },
      sweepAll: async () => { calls.push("sweep"); },
    });

    await flush();
    workspaces.reject(new Error("indexeddb write failed"));
    await expect(persisting).rejects.toThrow("indexeddb write failed");
    expect(calls).toEqual(["workspaces"]);
    expect(localSequence).toBe(0);
  });
});
