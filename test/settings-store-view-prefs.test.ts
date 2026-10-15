// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { setupDom, teardownDom } from "./helpers/dom-environment";

const kv = new Map<string, unknown>();
let serverPreferences: Record<string, unknown> = {};
let failPushes = false;
let getWait: Promise<void> | null = null;
let getWaitCall = 1;
let updateWait: Promise<void> | null = null;
let consent = true;
let consentWait: Promise<void> | null = null;
let getCalls = 0;

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const updateCalls: Array<Record<string, unknown>> = [];
const credentials = { baseUrl: "https://sync.example.com", accessToken: "token" };
const replacer = createModuleReplacer();
let useBookmarksStore: typeof import("@/store/bookmarks-store").useBookmarksStore;
let useSettingsStore: typeof import("@/store/settings-store").useSettingsStore;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  setupDom();
  const realEnv = await importFresh<typeof import("@/lib/browser/env")>("lib/browser/env.ts");
  const realIdb = await importFresh<typeof import("@/lib/idb")>("lib/idb.ts");
  const realApi = await importFresh<typeof import("@/lib/api")>("lib/api.ts");
  // A Chromium build needs no consent; test/data-collection.test.ts leaves a Firefox build registered.
  await replacer.replace("@/lib/browser/env", {
    ...realEnv,
    isFirefoxBuild: () => false,
    isChromiumBuild: () => true,
  });
  await replacer.replace("@/lib/idb", {
    ...realIdb,
    idbGet: async (_store: string, key: string) => (kv.has(key) ? { key, value: kv.get(key) } : undefined),
    idbPut: async (_store: string, record: { key: string; value: unknown }) => {
      kv.set(record.key, record.value);
    },
  });
  const realConsent = await importFresh<typeof import("@/lib/browser/data-collection")>("lib/browser/data-collection.ts");
  await replacer.replace("@/lib/browser/data-collection", {
    ...realConsent,
    hasSettingsSyncConsent: async () => {
      await consentWait;
      return consent;
    },
  });
  await replacer.replace("@/lib/api", {
    ...realApi,
    getPreferences: async () => {
      getCalls += 1;
      const snapshot = structuredClone(serverPreferences);
      const wait = getCalls === getWaitCall ? getWait : null;
      if (wait) {
        getWait = null;
      }
      await wait;
      return snapshot;
    },
    updatePreferences: async (_baseUrl: string, _token: string, preferences: Record<string, unknown>) => {
      if (failPushes) {
        throw new Error("offline");
      }
      await updateWait;
      updateCalls.push(preferences);
      serverPreferences = structuredClone(preferences);
    },
  });
  const bookmarksStore = await importFresh<typeof import("@/store/bookmarks-store")>("store/bookmarks-store.ts");
  await replacer.replace("@/store/bookmarks-store", bookmarksStore);
  useBookmarksStore = bookmarksStore.useBookmarksStore;
  ({ useSettingsStore } = await importFresh<typeof import("@/store/settings-store")>("store/settings-store.ts"));
});

afterAll(async () => {
  useSettingsStore.getState().stopPreferenceSync();
  replacer.restore();
  await teardownDom();
});

beforeEach(async () => {
  // Resetting the view is a user change to the subscription an earlier test's
  // hydrate left behind. Let it settle, then drop what it wrote and the push it scheduled.
  useBookmarksStore.setState({ viewMode: "grid", sortBy: "date-newest" });
  await flush();
  useSettingsStore.getState().stopPreferenceSync();
  kv.clear();
  serverPreferences = {};
  failPushes = false;
  getWait = null;
  getWaitCall = 1;
  updateWait = null;
  consentWait = null;
  consent = true;
  getCalls = 0;
  updateCalls.length = 0;
});

describe("view preference sync", () => {
  test("hydrate applies the locally stored preferences", async () => {
    kv.set("bookmark-view-prefs", { viewMode: "list", sortBy: "alpha-az", updatedAt: 5, dirty: false });

    await useSettingsStore.getState().hydrate();

    expect(useBookmarksStore.getState().viewMode).toBe("list");
    expect(useBookmarksStore.getState().sortBy).toBe("alpha-az");
  });

  test("a user change is stored locally as not yet pushed", async () => {
    await useSettingsStore.getState().hydrate();

    useBookmarksStore.getState().setViewMode("list");
    await flush();

    expect(kv.get("bookmark-view-prefs")).toMatchObject({ viewMode: "list", sortBy: "date-newest", dirty: true });
  });

  test("newer server preferences are applied and not pushed back", async () => {
    await useSettingsStore.getState().hydrate();
    kv.set("bookmark-view-prefs", { viewMode: "grid", sortBy: "date-newest", updatedAt: 50, dirty: false });
    serverPreferences = { bookmarkView: { viewMode: "list", sortBy: "alpha-za", updatedAt: 100 } };

    await useSettingsStore.getState().startPreferenceSync(() => credentials);

    expect(useBookmarksStore.getState().viewMode).toBe("list");
    expect(useBookmarksStore.getState().sortBy).toBe("alpha-za");
    expect(kv.get("bookmark-view-prefs")).toEqual({ viewMode: "list", sortBy: "alpha-za", updatedAt: 100, dirty: false });
    expect(updateCalls).toEqual([]);
  });

  test("newer local preferences are pushed and keep other server keys", async () => {
    kv.set("bookmark-view-prefs", { viewMode: "list", sortBy: "alpha-az", updatedAt: 50, dirty: true });
    serverPreferences = { theme: "dark", bookmarkView: { viewMode: "grid", sortBy: "date-newest", updatedAt: 10 } };

    await useSettingsStore.getState().startPreferenceSync(() => credentials);

    expect(updateCalls).toEqual([
      { theme: "dark", bookmarkView: { viewMode: "list", sortBy: "alpha-az", updatedAt: 50 } },
    ]);
    expect(kv.get("bookmark-view-prefs")).toMatchObject({ dirty: false });
  });

  test("a failed push keeps the local preferences marked as not pushed", async () => {
    kv.set("bookmark-view-prefs", { viewMode: "list", sortBy: "alpha-az", updatedAt: 50, dirty: true });
    failPushes = true;

    await useSettingsStore.getState().startPreferenceSync(() => credentials);

    expect(kv.get("bookmark-view-prefs")).toMatchObject({ dirty: true });
  });

  test("a change during an active session is pushed after the debounce", async () => {
    await useSettingsStore.getState().hydrate();
    await useSettingsStore.getState().startPreferenceSync(() => credentials);

    useBookmarksStore.getState().setSortBy("alpha-za");
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(updateCalls.at(-1)).toMatchObject({ bookmarkView: { viewMode: "grid", sortBy: "alpha-za" } });
  });

  test("a local edit during a delayed pull wins over the older server value", async () => {
    await useSettingsStore.getState().hydrate();
    serverPreferences = { bookmarkView: { viewMode: "list", sortBy: "alpha-az", updatedAt: 100 } };
    const pull = deferred();
    getWait = pull.promise;
    const sync = useSettingsStore.getState().startPreferenceSync(() => credentials);
    await flush();

    useBookmarksStore.getState().setSortBy("alpha-za");
    await flush();
    pull.release();
    await sync;

    expect(useBookmarksStore.getState().sortBy).toBe("alpha-za");
    expect(kv.get("bookmark-view-prefs")).toMatchObject({ sortBy: "alpha-za" });
    expect(updateCalls.at(-1)).toMatchObject({ bookmarkView: { sortBy: "alpha-za" } });
  });

  test("stopping while consent is pending prevents a network request", async () => {
    const pendingConsent = deferred();
    consentWait = pendingConsent.promise;
    const sync = useSettingsStore.getState().startPreferenceSync(() => credentials);
    useSettingsStore.getState().stopPreferenceSync();
    pendingConsent.release();
    await sync;

    expect(getCalls).toBe(0);
  });

  test("restarting with the same credentials getter invalidates the old pull", async () => {
    await useSettingsStore.getState().hydrate();
    const getter = () => credentials;
    const pull = deferred();
    serverPreferences = { bookmarkView: { viewMode: "list", sortBy: "alpha-az", updatedAt: 100 } };
    getWait = pull.promise;
    const oldSync = useSettingsStore.getState().startPreferenceSync(getter);
    await flush();
    useSettingsStore.getState().stopPreferenceSync();
    serverPreferences = {};
    await useSettingsStore.getState().startPreferenceSync(getter);
    pull.release();
    await oldSync;

    expect(useBookmarksStore.getState().viewMode).toBe("grid");
    expect(kv.has("bookmark-view-prefs")).toBe(false);
  });

  test("a push completing after stop leaves the local value dirty", async () => {
    kv.set("bookmark-view-prefs", { viewMode: "list", sortBy: "alpha-az", updatedAt: 50, dirty: true });
    const update = deferred();
    updateWait = update.promise;
    const sync = useSettingsStore.getState().startPreferenceSync(() => credentials);
    await flush();
    useSettingsStore.getState().stopPreferenceSync();
    update.release();
    await sync;

    expect(kv.get("bookmark-view-prefs")).toMatchObject({ dirty: true });
  });

  test("a push completion does not clean a different local value with the same timestamp", async () => {
    kv.set("bookmark-view-prefs", { viewMode: "list", sortBy: "alpha-az", updatedAt: 50, dirty: true });
    const update = deferred();
    updateWait = update.promise;
    const sync = useSettingsStore.getState().startPreferenceSync(() => credentials);
    await flush();
    kv.set("bookmark-view-prefs", { viewMode: "grid", sortBy: "alpha-za", updatedAt: 50, dirty: true });
    update.release();
    await sync;

    expect(kv.get("bookmark-view-prefs")).toMatchObject({ sortBy: "alpha-za", dirty: true });
  });

  test("consent denial keeps changes local and resync retries after grant", async () => {
    kv.set("bookmark-view-prefs", { viewMode: "list", sortBy: "alpha-az", updatedAt: 50, dirty: true });
    consent = false;
    await useSettingsStore.getState().startPreferenceSync(() => credentials);
    expect(getCalls).toBe(0);
    expect(kv.get("bookmark-view-prefs")).toMatchObject({ dirty: true });

    consent = true;
    await useSettingsStore.getState().resyncPreferences();
    expect(updateCalls).toHaveLength(1);
    expect(kv.get("bookmark-view-prefs")).toMatchObject({ dirty: false });
  });


  test("stopping during the push merge read prevents dispatching the update", async () => {
    kv.set("bookmark-view-prefs", { viewMode: "list", sortBy: "alpha-az", updatedAt: 50, dirty: true });
    const read = deferred();
    getWait = read.promise;
    getWaitCall = 2;
    const sync = useSettingsStore.getState().startPreferenceSync(() => credentials);
    await flush();
    expect(getCalls).toBe(2);
    useSettingsStore.getState().stopPreferenceSync();
    read.release();
    await sync;

    expect(updateCalls).toEqual([]);
    expect(kv.get("bookmark-view-prefs")).toMatchObject({ dirty: true });
  });

});
