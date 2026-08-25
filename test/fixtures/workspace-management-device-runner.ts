// Acceptance-test device process for test/workspace-management-acceptance.test.ts.
//
// Each "device" in the acceptance suite is a real, isolated OS process running this
// script. That is deliberate: lib/idb.ts caches its IndexedDB connection in a
// module-level singleton, lib/sync-lifecycle.ts and lib/sync-engine.ts keep
// module-level globals (`activeLifecycle`, `syncEngine`), lib/sync-recovery.ts
// caches a pending recovery snapshot in a module-level variable, and
// store/*.ts are Zustand singletons. None of that can be safely duplicated
// for two independent "devices" inside one JS module graph — re-importing a
// module under a different specifier does not change what its own internal
// `import "./idb"` resolves to. Running each device as its own process gives
// every one of those singletons for free, with no production code changes.
//
// The parent test drives this process over newline-delimited JSON on
// stdin/stdout (see RpcDevice in the test file). "Restart" is simulated by
// killing this process and spawning a fresh one pointed at the same on-disk
// state file — durable IndexedDB + chrome.storage state survives; in-memory
// JS state (SyncEngine, Zustand stores, sync-recovery's in-memory shortcut)
// does not, exactly like a real browser restart.
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

interface DeviceStateFile {
  idb: Record<string, Record<string, unknown>>;
  chromeLocal: Record<string, unknown>;
  chromeSession: Record<string, unknown>;
}

const stateFile = process.env.DEVICE_STATE_FILE;
if (!stateFile) {
  throw new Error("DEVICE_STATE_FILE is required");
}
const serverUrl = process.env.DEVICE_SERVER_URL;
if (!serverUrl) {
  throw new Error("DEVICE_SERVER_URL is required");
}
const userId = process.env.DEVICE_USER_ID ?? "user-1";
const accessToken = `test-token-${userId}`;

const STORE_NAMES = [
  "bookmarks",
  "archived-bookmarks",
  "trashed-bookmarks",
  "workspaces",
  "collections",
  "tags",
  "groups",
  "group-tabs",
  "tab-group-titles",
  "kv",
] as const;

const INDEX_FIELDS: Record<string, Record<string, string>> = {
  bookmarks: { collectionId: "collectionId" },
  "archived-bookmarks": { collectionId: "collectionId" },
  "trashed-bookmarks": { collectionId: "collectionId" },
  collections: { workspaceId: "workspaceId", position: "position" },
  groups: { workspaceId: "workspaceId" },
  "group-tabs": { groupId: "groupId" },
  workspaces: { position: "position" },
};

function loadStateFile(): DeviceStateFile {
  if (!existsSync(stateFile!)) {
    return { idb: Object.fromEntries(STORE_NAMES.map((name) => [name, {}])), chromeLocal: {}, chromeSession: {} };
  }
  const parsed = JSON.parse(readFileSync(stateFile!, "utf8")) as DeviceStateFile;
  for (const name of STORE_NAMES) {
    parsed.idb[name] ??= {};
  }
  return parsed;
}

const persisted = loadStateFile();

// ---------------------------------------------------------------------------
// Fake IndexedDB — same shape as the FakeDatabase used by
// test/workspace-aggregate.test.ts, extended with disk persistence so state
// survives a simulated "restart" (a fresh OS process against the same file).
// ---------------------------------------------------------------------------
type FakeRecord = Record<string, unknown>;

function cloneRecord<T>(record: T): T {
  return structuredClone(record);
}

class FakeRequest {
  result: unknown;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeIndex {
  constructor(
    private readonly records: Map<string, FakeRecord>,
    private readonly field: string,
    private readonly schedule: (run: () => unknown) => FakeRequest,
  ) {}

  getAll(value: unknown): FakeRequest {
    return this.schedule(() =>
      [...this.records.values()].filter((record) => record[this.field] === value).map(cloneRecord));
  }
}

class FakeObjectStore {
  constructor(
    private readonly name: string,
    private readonly records: Map<string, FakeRecord>,
    private readonly schedule: (run: () => unknown) => FakeRequest,
  ) {}

  index(name: string): FakeIndex {
    const field = INDEX_FIELDS[this.name]?.[name];
    if (!field) {
      throw new Error(`Unknown index ${this.name}.${name}`);
    }
    return new FakeIndex(this.records, field, this.schedule);
  }

  get(key: string): FakeRequest {
    return this.schedule(() => {
      const record = this.records.get(key);
      return record ? cloneRecord(record) : undefined;
    });
  }

  getAll(): FakeRequest {
    return this.schedule(() => [...this.records.values()].map(cloneRecord));
  }

  put(record: FakeRecord): FakeRequest {
    return this.schedule(() => {
      const key = (record.key ?? record.id) as string | undefined;
      if (!key) {
        throw new Error(`Missing key for ${this.name}`);
      }
      this.records.set(key, cloneRecord(record));
      return key;
    });
  }

  delete(key: string): FakeRequest {
    return this.schedule(() => {
      this.records.delete(key);
      return undefined;
    });
  }

  count(): FakeRequest {
    return this.schedule(() => this.records.size);
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  private pending = 0;
  private done = false;

  constructor(
    private readonly database: FakeDatabase,
    readonly storeNames: string[],
  ) {}

  objectStore(name: string): FakeObjectStore {
    const records = this.database.stores.get(name);
    if (!records || !this.storeNames.includes(name)) {
      throw new Error(`Store ${name} is not part of this transaction`);
    }
    return new FakeObjectStore(name, records, (run) => this.schedule(run));
  }

  private schedule(run: () => unknown): FakeRequest {
    const request = new FakeRequest();
    this.pending += 1;
    queueMicrotask(() => {
      try {
        request.result = run();
        request.onsuccess?.();
        this.pending -= 1;
        this.maybeComplete();
      } catch (error) {
        this.error = error instanceof Error ? error : new Error("IndexedDB request failed");
        request.error = this.error;
        request.onerror?.();
        this.done = true;
        this.onerror?.();
      }
    });
    return request;
  }

  private maybeComplete(): void {
    if (this.pending !== 0 || this.done) {
      return;
    }
    queueMicrotask(() => {
      if (this.pending !== 0 || this.done) {
        return;
      }
      this.done = true;
      this.database.persist();
      this.oncomplete?.();
    });
  }

  abort(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.onabort?.();
  }
}

class FakeDatabase {
  stores = new Map<string, Map<string, FakeRecord>>();
  onversionchange: (() => void) | null = null;

  constructor(initial: Record<string, Record<string, unknown>>) {
    for (const name of STORE_NAMES) {
      const records = Object.entries(initial[name] ?? {}) as Array<[string, FakeRecord]>;
      this.stores.set(name, new Map(records));
    }
  }

  transaction(names: string | string[]): FakeTransaction {
    return new FakeTransaction(this, typeof names === "string" ? [names] : names);
  }

  close(): void {}

  persist(): void {
    saveStateFile();
  }
}

const fakeDatabase = new FakeDatabase(persisted.idb);

class FakeOpenRequest {
  result: FakeDatabase;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  constructor(database: FakeDatabase) {
    this.result = database;
  }
}

const fakeIndexedDB = {
  open(): FakeOpenRequest {
    const request = new FakeOpenRequest(fakeDatabase);
    queueMicrotask(() => request.onsuccess?.());
    return request;
  },
  deleteDatabase() {
    const request = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
    queueMicrotask(() => {
      for (const name of STORE_NAMES) {
        fakeDatabase.stores.set(name, new Map());
      }
      saveStateFile();
      request.onsuccess?.();
    });
    return request;
  },
};

Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB });

// ---------------------------------------------------------------------------
// Fake chrome.storage.{local,session} — dual promise/callback signature to
// match the real chrome.storage API surface production code calls against
// (see lib/auth-storage-adapter.ts, which uses both styles).
// ---------------------------------------------------------------------------
function makeStorageArea(seed: Record<string, unknown>) {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    map,
    get(keys?: string | string[] | null, callback?: (result: Record<string, unknown>) => void) {
      const list = keys == null ? [...map.keys()] : Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of list) {
        if (map.has(key)) {
          result[key] = map.get(key);
        }
      }
      if (callback) {
        callback(result);
        return undefined;
      }
      return Promise.resolve(result);
    },
    set(items: Record<string, unknown>, callback?: () => void) {
      for (const [key, value] of Object.entries(items)) {
        map.set(key, value);
      }
      saveStateFile();
      if (callback) {
        callback();
        return undefined;
      }
      return Promise.resolve();
    },
    remove(keys: string | string[], callback?: () => void) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        map.delete(key);
      }
      saveStateFile();
      if (callback) {
        callback();
        return undefined;
      }
      return Promise.resolve();
    },
  };
}

const chromeLocalArea = makeStorageArea(persisted.chromeLocal);
const chromeSessionArea = makeStorageArea(persisted.chromeSession);

interface FakeChromeGlobal {
  storage: {
    local: ReturnType<typeof makeStorageArea>;
    session: ReturnType<typeof makeStorageArea>;
    AccessLevel: { TRUSTED_CONTEXTS: string };
  };
  runtime: { id: string };
}

// The double cast through `unknown` deliberately bypasses the real
// @types/chrome ambient `chrome` global — this fake only needs to satisfy the
// handful of storage calls production code actually makes (see
// lib/sync-recovery.ts, lib/auth-storage-adapter.ts, lib/analytics.ts), not
// the full chrome.* surface.
(globalThis as unknown as { chrome: FakeChromeGlobal }).chrome = {
  storage: {
    local: chromeLocalArea,
    session: chromeSessionArea,
    AccessLevel: { TRUSTED_CONTEXTS: "TRUSTED_CONTEXTS" },
  },
  runtime: { id: "test-extension" },
};

function dumpStores(): Record<string, Record<string, unknown>> {
  const dump: Record<string, Record<string, unknown>> = {};
  for (const [name, records] of fakeDatabase.stores) {
    dump[name] = Object.fromEntries(records);
  }
  return dump;
}

function saveStateFile(): void {
  const data: DeviceStateFile = {
    idb: dumpStores(),
    chromeLocal: Object.fromEntries(chromeLocalArea.map),
    chromeSession: Object.fromEntries(chromeSessionArea.map),
  };
  writeFileSync(stateFile!, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Production module wiring — mirrors entrypoints/newtab/App.tsx's SyncProvider,
// minus React-only concerns (notifications, translation, render state).
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { useAuthStore } = await import("@/store/auth-store");
  const { useWorkspaceStore } = await import("@/store/workspace-store");
  const { useBookmarksStore } = await import("@/store/bookmarks-store");
  const { useGroupsStore } = await import("@/store/groups-store");
  const { usePlanStore } = await import("@/store/plan-store");
  const { syncConflictRegistry } = await import("@/lib/sync-conflicts");
  const { createSyncEngine } = await import("@/lib/sync-engine-runtime");
  const { initSyncEngine, releaseSyncEngine } = await import("@/lib/sync-engine");
  const { registerSyncLifecycle, unregisterSyncLifecycle } = await import("@/lib/sync-lifecycle");
  const {
    orchestrateWorkspacePull,
    resolveAuthoritativeWorkspacePull,
    commitWorkspacePullCheckpoint,
    reconcileWorkspaceLifecycleIntents,
    blockPruneAndCleanTerminalAggregates,
  } = await import("@/lib/workspace-lifecycle-coordinator");
  const { confirmSyncPayload } = await import("@/lib/sync-confirmation");
  const {
    readWorkspaceLifecycleCapability,
    readWorkspaceLifecycleIntents,
  } = await import("@/lib/workspace-lifecycle-state");
  const {
    prepareGuestWorkspaceForPull,
    confirmGuestWorkspaceFromPull,
    resolveGuestPushRejections,
    sweepAllUnsynced,
    getPersistentSyncErrorKey,
  } = await import("@/lib/guest-workspace-reconciliation");
  const { idbGetAll } = await import("@/lib/idb");

  if (typeof useAuthStore.persist?.hasHydrated === "function" && !useAuthStore.persist.hasHydrated()) {
    await new Promise<void>((resolve) => {
      useAuthStore.persist.onFinishHydration(() => resolve());
    });
  }
  useAuthStore.setState({
    user: {
      id: userId,
      name: "Acceptance",
      email: `${userId}@example.com`,
      is_verified: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    },
    accessToken,
    refreshToken: `refresh-${userId}`,
    serverUrl,
  });

  await Promise.all([
    useWorkspaceStore.getState().hydrate(),
    useBookmarksStore.getState().hydrate(),
    useGroupsStore.getState().hydrate(),
  ]);

  async function reportLifecycleConflict(conflict: {
    entityType: "workspace" | "collection" | "bookmark" | "saved_group" | "tag";
    entityId: string;
    reason: string;
    parentType?: "workspace" | "collection" | "bookmark" | "saved_group" | "tag";
    parentId?: string;
  }): Promise<void> {
    await syncConflictRegistry.recordRejections([{
      id: conflict.entityId,
      type: conflict.entityType,
      reason: conflict.reason,
      parent_id: conflict.parentId,
      parent_type: conflict.parentType,
    }]);
  }

  async function clearReenabledLifecycleConflictTrees(): Promise<void> {
    const unsupportedRoots = new Set(
      syncConflictRegistry.list()
        .filter((conflict) => conflict.entityType === "workspace" && conflict.reason === "unsupported_server")
        .map((conflict) => conflict.entityId),
    );
    for (const workspaceId of unsupportedRoots) {
      await syncConflictRegistry.clearRoot("workspace", workspaceId);
    }
  }

  const localSeqRef = { current: useWorkspaceStore.getState().localSeq };
  let offline = false;

  const engine = createSyncEngine(
    () => {
      if (offline) {
        return null;
      }
      const currentAuth = useAuthStore.getState();
      if (!currentAuth.accessToken || !currentAuth.serverUrl) {
        return null;
      }
      return { baseUrl: currentAuth.serverUrl, accessToken: currentAuth.accessToken };
    },
    () => localSeqRef.current,
    async (resp, isCurrent, context, responseIsAuthoritativeFullPull) => {
      if (!isCurrent()) {
        return { errorMessage: null };
      }
      const currentUser = useAuthStore.getState().user;
      const currentServerUrl = useAuthStore.getState().serverUrl;
      if (!currentUser || !currentServerUrl) {
        return { errorMessage: null };
      }
      const authoritative = await resolveAuthoritativeWorkspacePull({
        context,
        response: resp,
        responseIsAuthoritativeFullPull,
        serverUrl: currentServerUrl,
        userId: currentUser.id,
      });
      const authoritativeResponse = authoritative.response;
      const capabilitySupported = authoritative.capabilitySupported;
      const authoritativeFullPull = authoritative.authoritativeFullPull;
      if (!isCurrent()) {
        return { errorMessage: null };
      }
      if (capabilitySupported) {
        await clearReenabledLifecycleConflictTrees();
      }
      if (!isCurrent()) {
        return { errorMessage: null };
      }
      const needsInitialPush = localSeqRef.current === 0 && authoritativeResponse.server_seq === 0;
      const checkpointCommitted = await orchestrateWorkspacePull({
        isCurrent,
        prepareGuest: async () => {
          await prepareGuestWorkspaceForPull(authoritativeResponse);
        },
        mergeWorkspaces: () => useWorkspaceStore.getState().mergeFromServer(authoritativeResponse),
        mergeGroups: () => useGroupsStore.getState().mergeFromServer(authoritativeResponse),
        mergeBookmarks: () => useBookmarksStore.getState().mergeFromServer(authoritativeResponse),
        cleanTerminalAggregates: (summary) =>
          blockPruneAndCleanTerminalAggregates(context, summary.terminalWorkspaceIds),
        clearRestoredConflictTrees: async (summary) => {
          for (const workspaceId of summary.restoredWorkspaceIds) {
            await syncConflictRegistry.clearRoot("workspace", workspaceId);
          }
        },
        confirmGuest: () => confirmGuestWorkspaceFromPull(authoritativeResponse),
        reconcileLifecycle: async () => {
          await usePlanStore.getState().fetchPlan();
          if (!isCurrent()) {
            return;
          }
          if (capabilitySupported) {
            await reconcileWorkspaceLifecycleIntents({
              context,
              userId: currentUser.id,
              serverOrigin: new URL(currentServerUrl).origin,
              authoritativeWorkspaces: authoritativeResponse.entities.workspaces,
              authoritativeFullPull,
              reportConflict: reportLifecycleConflict,
              notify: () => {},
            });
          }
          if (!isCurrent()) {
            return;
          }
          if (needsInitialPush && useWorkspaceStore.getState().workspaces.length === 0) {
            await useWorkspaceStore.getState().initializeGuestWorkspace({
              isSessionCurrent: () => isCurrent() && useAuthStore.getState().accessToken === accessToken,
            });
          }
        },
        sweepUnsynced: sweepAllUnsynced,
        commitCheckpoint: () => commitWorkspacePullCheckpoint({
          serverUrl: currentServerUrl,
          userId: currentUser.id,
          serverSeq: authoritativeResponse.server_seq,
          capabilitySupported,
          isCurrent,
        }),
      });
      if (!checkpointCommitted || !isCurrent()) {
        return { errorMessage: null };
      }
      localSeqRef.current = authoritativeResponse.server_seq;
      const persistentErrorKey = await getPersistentSyncErrorKey();
      return { errorMessage: persistentErrorKey };
    },
    async (pushResp, confirmedPayload) => {
      await confirmSyncPayload(confirmedPayload, pushResp.server_seq);
      const reconciliation = await resolveGuestPushRejections(pushResp);
      if (reconciliation.kind === "migrated") {
        await sweepAllUnsynced();
      }
      return getPersistentSyncErrorKey();
    },
    () => {},
    async () => false,
    {
      shouldResolveWorkspaceLifecycleBeforePush: async () => {
        const currentAuth = useAuthStore.getState();
        if (!currentAuth.user || !currentAuth.serverUrl) {
          return false;
        }
        const intents = await readWorkspaceLifecycleIntents();
        if (intents.length === 0 ||
          !await readWorkspaceLifecycleCapability(currentAuth.serverUrl, currentAuth.user.id)) {
          return false;
        }
        const conflicts = syncConflictRegistry.list();
        return intents.some((intent) => {
          const rootConflict = conflicts.find((conflict) =>
            conflict.entityType === "workspace" && conflict.entityId === intent.workspaceId);
          if (!rootConflict) {
            return true;
          }
          return intent.action === "restore" && rootConflict.reason === "parent_deleted";
        });
      },
    },
  );

  initSyncEngine(engine);
  registerSyncLifecycle(engine);

  async function readAggregate(workspaceId: string) {
    const [workspaces, collections, bookmarks, groups, groupTabs] = await Promise.all([
      idbGetAll<{ id: string }>("workspaces"),
      idbGetAll<{ id: string; workspaceId?: string }>("collections"),
      idbGetAll<{ id: string; collectionId?: string }>("bookmarks"),
      idbGetAll<{ id: string; workspaceId?: string }>("groups"),
      idbGetAll<{ id: string; groupId?: string }>("group-tabs"),
    ]);
    const collectionIds = new Set(
      collections.filter((c) => c.workspaceId === workspaceId).map((c) => c.id),
    );
    const groupIds = new Set(groups.filter((g) => g.workspaceId === workspaceId).map((g) => g.id));
    return {
      workspace: workspaces.find((w) => w.id === workspaceId),
      collections: collections.filter((c) => c.workspaceId === workspaceId),
      bookmarks: bookmarks.filter((b) => b.collectionId && collectionIds.has(b.collectionId)),
      groups: groups.filter((g) => g.workspaceId === workspaceId),
      groupTabs: groupTabs.filter((t) => t.groupId && groupIds.has(t.groupId)),
    };
  }

  type RpcRequest = { id: number; method: string; params?: unknown[] };
  type RpcResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

  // Left untyped so each handler keeps its own specific parameter types;
  // params arriving over the RPC boundary are inherently untyped JSON, so the
  // dispatch call below narrows through `unknown` rather than `any`.
  const handlers = {
    ping: () => "pong",
    start: () => {
      engine.start();
      return true;
    },
    createWorkspace: (name: string, color: string) => {
      const workspace = useWorkspaceStore.getState().createWorkspace(name, color);
      return workspace;
    },
    createCollection: (workspaceId: string, name: string, icon: string) =>
      useWorkspaceStore.getState().createCollection(workspaceId, name, icon),
    archiveCollection: (id: string) => {
      useWorkspaceStore.getState().archiveCollection(id);
      return true;
    },
    deleteWorkspace: (id: string) => useWorkspaceStore.getState().deleteWorkspace(id),
    restoreWorkspace: (id: string) => useWorkspaceStore.getState().restoreWorkspace(id),
    permanentlyDeleteWorkspace: (id: string) => useWorkspaceStore.getState().permanentlyDeleteWorkspace(id),
    forceSync: async () => {
      await syncConflictRegistry.clearAllForManualRetry();
      await sweepAllUnsynced();
      return engine.forceSync();
    },
    goOffline: () => {
      offline = true;
      return true;
    },
    goOnline: async () => {
      offline = false;
      await engine.forceSync();
      return true;
    },
    readAggregate: (workspaceId: string) => readAggregate(workspaceId),
    readRecoverySnapshot: async () => {
      const stored = await chromeSessionArea.get("tabslate-sync-recovery") as Record<string, unknown>;
      const raw = stored["tabslate-sync-recovery"];
      if (typeof raw !== "string" || raw.length === 0) {
        return null;
      }
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    readIntents: () => readWorkspaceLifecycleIntents(),
    readCapability: (targetServerUrl: string, targetUserId: string) =>
      readWorkspaceLifecycleCapability(targetServerUrl, targetUserId),
    getLocalSeq: () => useWorkspaceStore.getState().localSeq,
    getWorkspaces: () => useWorkspaceStore.getState().workspaces,
    getActiveWorkspaceId: () => useWorkspaceStore.getState().activeWorkspaceId,
    shutdown: () => {
      void engine.retire().finally(() => {
        unregisterSyncLifecycle(engine);
        releaseSyncEngine(engine);
        process.exit(0);
      });
      return true;
    },
  };

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    void (async () => {
      let request: RpcRequest;
      try {
        request = JSON.parse(line) as RpcRequest;
      } catch (error) {
        return;
      }
      let response: RpcResponse;
      try {
        const handler = handlers[request.method as keyof typeof handlers] as
          | ((...args: unknown[]) => unknown)
          | undefined;
        if (!handler) {
          throw new Error(`Unknown method: ${request.method}`);
        }
        const result = await handler(...(request.params ?? []));
        saveStateFile();
        response = { id: request.id, ok: true, result };
      } catch (error) {
        response = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      process.stdout.write(`${JSON.stringify(response)}\n`);
    })();
  });

  process.stdout.write(`${JSON.stringify({ id: 0, ok: true, result: "ready" })}\n`);
}

void main();
