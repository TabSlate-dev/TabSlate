import { beforeEach, describe, expect, test } from "bun:test";

const sessionStore = new Map();
const sessionSetCalls = [];
const sessionRemoveCalls = [];
const pendingStorageOps = [];
let deferStorageOps = false;

function createSessionArea() {
  return {
    async get(keys) {
      if (typeof keys === "string") {
        return { [keys]: sessionStore.get(keys) };
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, sessionStore.get(key)]));
      }
      if (keys && typeof keys === "object") {
        return Object.fromEntries(
          Object.entries(keys).map(([key, defaultValue]) => [key, sessionStore.get(key) ?? defaultValue]),
        );
      }
      return Object.fromEntries(sessionStore.entries());
    },
    async set(items) {
      sessionSetCalls.push(items);
      if (deferStorageOps) {
        await new Promise((resolve) => {
          pendingStorageOps.push(() => {
            for (const [key, value] of Object.entries(items)) {
              sessionStore.set(key, value);
            }
            resolve();
          });
        });
        return;
      }
      for (const [key, value] of Object.entries(items)) {
        sessionStore.set(key, value);
      }
    },
    async remove(keys) {
      sessionRemoveCalls.push(keys);
      const keyList = Array.isArray(keys) ? keys : [keys];
      if (deferStorageOps) {
        await new Promise((resolve) => {
          pendingStorageOps.push(() => {
            for (const key of keyList) {
              sessionStore.delete(key);
            }
            resolve();
          });
        });
        return;
      }
      for (const key of keyList) {
        sessionStore.delete(key);
      }
    },
  };
}

Reflect.set(globalThis, "chrome", {
  storage: {
    session: createSessionArea(),
  },
});

const recoveryModule = await import("../lib/sync-recovery.ts?real-sync-recovery");

async function waitForStorageWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("sync recovery persistence", () => {
  beforeEach(async () => {
    sessionStore.clear();
    sessionSetCalls.length = 0;
    sessionRemoveCalls.length = 0;
    pendingStorageOps.length = 0;
    deferStorageOps = false;
    await Promise.resolve(recoveryModule.clearSyncRecoverySnapshot());
    await waitForStorageWork();
    sessionSetCalls.length = 0;
    sessionRemoveCalls.length = 0;
  });

  test("bufferSyncRecoverySnapshot persists the snapshot to session storage", async () => {
    const snapshot = {
      entities: {
        workspaces: [],
        collections: [],
        bookmarks: [{ id: "bookmark-1", seq: 0 }],
        tags: [],
        groups: [],
      },
    };

    await Promise.resolve(recoveryModule.bufferSyncRecoverySnapshot(snapshot));
    await waitForStorageWork();

    expect(sessionSetCalls.length).toBeGreaterThan(0);
    expect(
      sessionSetCalls.some((call) =>
        Object.values(call).some((value) => typeof value === "string" && value === JSON.stringify(snapshot)),
      ),
    ).toBe(true);
  });

  test("can load a persisted recovery snapshot from session storage", async () => {
    const snapshot = {
      entities: {
        workspaces: [{ id: "workspace-1" }],
        collections: [],
        bookmarks: [{ id: "bookmark-1", seq: 0 }],
        tags: [],
        groups: [],
      },
    };

    sessionStore.set("tabslate-sync-recovery", JSON.stringify(snapshot));

    const loaded = await recoveryModule.loadSyncRecoverySnapshot();

    expect(loaded).toEqual(snapshot);
    expect(sessionStore.size).toBe(0);
  });

  test("clearSyncRecoverySnapshot clears session storage", async () => {
    const snapshot = {
      entities: {
        workspaces: [],
        collections: [],
        bookmarks: [{ id: "bookmark-2", seq: 0 }],
        tags: [],
        groups: [],
      },
    };

    await Promise.resolve(recoveryModule.bufferSyncRecoverySnapshot(snapshot));
    await waitForStorageWork();
    await Promise.resolve(recoveryModule.clearSyncRecoverySnapshot());
    await waitForStorageWork();

    expect(sessionRemoveCalls.length).toBeGreaterThan(0);
    expect(sessionStore.size).toBe(0);
  });

  test("serializes storage persistence so older writes cannot land after clear", async () => {
    deferStorageOps = true;

    recoveryModule.bufferSyncRecoverySnapshot({
      entities: {
        workspaces: [],
        collections: [],
        bookmarks: [{ id: "bookmark-stale", seq: 0 }],
        tags: [],
        groups: [],
      },
    });
    recoveryModule.clearSyncRecoverySnapshot();
    await waitForStorageWork();

    expect(sessionSetCalls).toHaveLength(1);
    expect(sessionRemoveCalls).toHaveLength(0);
    expect(pendingStorageOps).toHaveLength(1);

    const resolveSet = pendingStorageOps.shift();
    if (!resolveSet) {
      throw new Error("missing queued set op");
    }
    resolveSet();
    await waitForStorageWork();

    expect(sessionRemoveCalls).toHaveLength(1);
    expect(pendingStorageOps).toHaveLength(1);

    const resolveRemove = pendingStorageOps.shift();
    if (!resolveRemove) {
      throw new Error("missing queued remove op");
    }
    resolveRemove();
    await waitForStorageWork();

    expect(sessionStore.size).toBe(0);
  });
});
