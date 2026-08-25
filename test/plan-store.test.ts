// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PlanResponse } from "../lib/api";

const zeroUsage = {
  bookmarks: 0,
  collections: 0,
  tags: 0,
  workspaces: 0,
  saved_groups: 0,
};

const planResponse: PlanResponse = {
  subscription: { plan: "free", status: "active", expires_at: null },
  limits: {
    max_bookmarks: 3000,
    max_collections: 30,
    max_tags: 100,
    max_workspaces: 1,
    max_saved_groups: 15,
    trash_grace_days: 30,
  },
  usage: {
    bookmarks: 3,
    collections: 2,
    tags: 0,
    workspaces: 1,
    saved_groups: 0,
  },
  trash_usage: {
    bookmarks: 2,
    collections: 1,
    tags: 0,
    workspaces: 1,
    saved_groups: 0,
  },
};

const getPlanMock = mock(async (): Promise<PlanResponse> => planResponse);

let persistedPlanValue: string | null = null;

const authSession = {
  serverUrl: "https://sync.tabslate.com",
  accessToken: "token",
};

mock.module("@/lib/api", () => ({
  api: {
    getPlan: getPlanMock,
  },
  searchBookmarks: mock(async () => []),
}));

mock.module("@/store/auth-store", () => ({
  useAuthStore: {
    getState: () => authSession,
  },
}));

mock.module("@/store/bookmarks-store", () => ({
  useBookmarksStore: {
    getState: () => ({
      _trashedLoaded: false,
      pruneExpiredTrash: mock(() => {}),
    }),
  },
}));

mock.module("@/lib/chrome-storage-adapter", () => ({
  chromeStorageAdapter: {
    getItem: async () => persistedPlanValue,
    setItem: async (_name: string, value: string) => {
      persistedPlanValue = value;
    },
    removeItem: async () => {
      persistedPlanValue = null;
    },
  },
}));

async function importPlanStore() {
  return import(`../store/plan-store.ts?test=${Date.now()}-${Math.random()}`);
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

describe("plan store refresh policy", () => {
  beforeEach(async () => {
    getPlanMock.mockClear();
    authSession.serverUrl = "https://sync.tabslate.com";
    authSession.accessToken = "token";
    persistedPlanValue = null;
    const { usePlanStore } = await importPlanStore();
    usePlanStore.setState({
      subscription: null,
      limits: null,
      usage: null,
      trashUsage: null,
      inUseUsage: null,
      fetchedAt: null,
      isFetching: false,
      quotaAlert: null,
    });
  });

  test("force refreshes the plan even when the cached value is still fresh", async () => {
    const { usePlanStore } = await importPlanStore();
    usePlanStore.setState({
      fetchedAt: Date.now(),
      isFetching: false,
    });

    usePlanStore.getState().ensureFresh(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(getPlanMock).toHaveBeenCalledTimes(1);
  });

  test("shares one authoritative in-flight result for matching credentials", async () => {
    const deferredPlan = createDeferred<typeof planResponse>();
    getPlanMock.mockImplementationOnce(() => deferredPlan.promise);
    const { usePlanStore } = await importPlanStore();

    const first = usePlanStore.getState().fetchPlan();
    const second = usePlanStore.getState().fetchPlan();
    await Promise.resolve();

    expect(getPlanMock).toHaveBeenCalledTimes(1);

    deferredPlan.resolve(planResponse);

    await expect(first).resolves.toEqual(planResponse);
    await expect(second).resolves.toEqual(planResponse);
  });

  test("discards a plan response after the session is cleared", async () => {
    const deferredPlan = createDeferred<typeof planResponse>();
    getPlanMock.mockImplementationOnce(() => deferredPlan.promise);
    const { usePlanStore } = await importPlanStore();

    const fetching = usePlanStore.getState().fetchPlan();
    await Promise.resolve();
    authSession.accessToken = "";
    deferredPlan.resolve(planResponse);
    await fetching;

    expect(usePlanStore.getState().limits).toBeNull();
    expect(usePlanStore.getState().usage).toBeNull();
    expect(usePlanStore.getState().fetchedAt).toBeNull();
    expect(usePlanStore.getState().isFetching).toBe(false);
  });

  test("does not clear a newer session's plan request", async () => {
    const stalePlan = createDeferred<typeof planResponse>();
    const currentPlan = createDeferred<typeof planResponse>();
    getPlanMock.mockImplementationOnce(() => stalePlan.promise);
    getPlanMock.mockImplementationOnce(() => currentPlan.promise);
    const { usePlanStore } = await importPlanStore();

    const staleFetching = usePlanStore.getState().fetchPlan();
    await Promise.resolve();
    authSession.accessToken = "new-token";
    usePlanStore.getState().clear();
    const currentFetching = usePlanStore.getState().fetchPlan();
    await Promise.resolve();
    stalePlan.resolve(planResponse);
    await expect(staleFetching).resolves.toBeNull();

    expect(usePlanStore.getState().isFetching).toBe(true);

    currentPlan.resolve(planResponse);
    await currentFetching;
  });

  test("notifies capacity observers after every successful plan refresh", async () => {
    const { registerPlanRefreshObserver } = await import("../lib/plan-refresh-observer");
    const { usePlanStore } = await importPlanStore();
    const observed: PlanResponse[] = [];
    const unregister = registerPlanRefreshObserver((plan) => {
      observed.push(plan);
    });

    try {
      await usePlanStore.getState().fetchPlan();
    } finally {
      unregister();
    }

    expect(observed).toEqual([planResponse]);
  });

  test("retains the authoritative trash breakdown in state and persistence", async () => {
    const { usePlanStore } = await importPlanStore();

    await usePlanStore.getState().fetchPlan();
    await Promise.resolve();

    expect(usePlanStore.getState().trashUsage).toEqual(planResponse.trash_usage);
    expect(usePlanStore.getState().inUseUsage).toEqual({
      bookmarks: 1,
      collections: 1,
      tags: 0,
      workspaces: 0,
      saved_groups: 0,
    });
    expect(persistedPlanValue).not.toBeNull();
    const persisted = JSON.parse(persistedPlanValue ?? "{}");
    expect(persisted.state.trashUsage).toEqual(planResponse.trash_usage);
    expect(persisted.state.inUseUsage).toEqual(usePlanStore.getState().inUseUsage);
  });

  test("defaults an older server's omitted trash snapshot to zero", async () => {
    const olderResponse: PlanResponse = {
      subscription: planResponse.subscription,
      limits: planResponse.limits,
      usage: planResponse.usage,
    };
    getPlanMock.mockImplementationOnce(async () => olderResponse);
    const { usePlanStore } = await importPlanStore();

    await usePlanStore.getState().fetchPlan();

    expect(usePlanStore.getState().trashUsage).toEqual(zeroUsage);
    expect(usePlanStore.getState().inUseUsage).toEqual(planResponse.usage);
  });

  test("clears every quota snapshot on logout without changing total-usage policy", async () => {
    const { usePlanStore } = await importPlanStore();
    await usePlanStore.getState().fetchPlan();

    usePlanStore.getState().clear();

    expect(usePlanStore.getState().usage).toBeNull();
    expect(usePlanStore.getState().trashUsage).toBeNull();
    expect(usePlanStore.getState().inUseUsage).toBeNull();
  });

  test("permanent deletion releases retained total and recycle-bin usage together", async () => {
    const { usePlanStore } = await importPlanStore();
    usePlanStore.setState({
      usage: { ...zeroUsage, bookmarks: 5 },
      trashUsage: { ...zeroUsage, bookmarks: 2 },
      inUseUsage: { ...zeroUsage, bookmarks: 3 },
    });

    usePlanStore.getState().decrementUsage("bookmark");

    expect(usePlanStore.getState().usage?.bookmarks).toBe(4);
    expect(usePlanStore.getState().trashUsage?.bookmarks).toBe(1);
    expect(usePlanStore.getState().inUseUsage?.bookmarks).toBe(3);
  });
});
