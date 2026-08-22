import { describe, expect, test } from "bun:test";
import { persistPulledSyncResponse } from "../lib/sync-pull-persistence";

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
