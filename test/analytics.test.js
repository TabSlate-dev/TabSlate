import { beforeEach, describe, expect, mock, test } from "bun:test";

const STORAGE_KEY = "tabslate-analytics-id";

let storedId;
const getCalls = [];
const lockCalls = [];
const setCalls = [];
const fetchCalls = [];

async function importAnalyticsModule() {
  return import(`../lib/analytics.ts?test=${Date.now()}-${Math.random()}`);
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  storedId = undefined;
  getCalls.length = 0;
  lockCalls.length = 0;
  setCalls.length = 0;
  fetchCalls.length = 0;

  process.env.VITE_OPENPANEL_URL = "https://openpanel.example.test";
  process.env.VITE_OPENPANEL_CLIENT_ID = "client-123";

  globalThis.chrome = {
    storage: {
      local: {
        get: mock(async (key) => {
          getCalls.push(key);
          return storedId ? { [STORAGE_KEY]: storedId } : {};
        }),
        set: mock(async (items) => {
          setCalls.push(items);
          storedId = items[STORAGE_KEY];
        }),
      },
    },
  };

  globalThis.fetch = mock(async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
    };
  });

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: mock(async (name, options, callback) => {
          lockCalls.push({ name, options });
          return callback();
        }),
      },
    },
  });
});

describe("analytics", () => {
  test("track lazily reuses the stored analytics id", async () => {
    storedId = "stored-profile-id";

    const { analytics } = await importAnalyticsModule();

    analytics.track("bookmark_added", { source: "popup" });
    await flushAsyncWork();

    expect(getCalls).toEqual([STORAGE_KEY]);
    expect(setCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatchObject({
      url: "https://openpanel.example.test/api/track",
      options: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "openpanel-client-id": "client-123",
        },
      },
    });
    expect(JSON.parse(fetchCalls[0].options.body)).toEqual({
      type: "track",
      payload: {
        name: "bookmark_added",
        profileId: "stored-profile-id",
        properties: {
          source: "popup",
        },
      },
    });
  });

  test("init creates and stores a new analytics id when one is missing", async () => {
    const { analytics } = await importAnalyticsModule();

    await analytics.init();

    expect(lockCalls).toEqual([{
      name: "tabslate-analytics-id",
      options: { mode: "exclusive" },
    }]);
    expect(getCalls).toEqual([STORAGE_KEY, STORAGE_KEY]);
    expect(setCalls).toHaveLength(1);
    expect(typeof storedId).toBe("string");
    expect(storedId.length).toBeGreaterThan(0);
    expect(setCalls[0]).toEqual({
      [STORAGE_KEY]: storedId,
    });
  });

  test("track does not hit the network when analytics env vars are absent", async () => {
    delete process.env.VITE_OPENPANEL_URL;
    delete process.env.VITE_OPENPANEL_CLIENT_ID;

    const { analytics } = await importAnalyticsModule();

    analytics.track("bookmark_added", { source: "popup" });
    await flushAsyncWork();

    expect(getCalls).toHaveLength(0);
    expect(setCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  test("init does not touch storage when analytics is disabled", async () => {
    delete process.env.VITE_OPENPANEL_URL;
    delete process.env.VITE_OPENPANEL_CLIENT_ID;

    const { analytics } = await importAnalyticsModule();

    await analytics.init();

    expect(getCalls).toHaveLength(0);
    expect(setCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });
});
