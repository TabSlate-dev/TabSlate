import type {
  SyncEntity,
  SyncPushPayload,
  WorkspaceLifecycleAction,
} from "@/lib/api";

export type { WorkspaceLifecycleAction } from "@/lib/api";

export const WORKSPACE_LIFECYCLE_INTENTS_KEY = "workspace-lifecycle-intents-v1";
export const WORKSPACE_CAPABILITY_KEY_PREFIX = "workspace-parent-tombstone-capability-v1";
export const WORKSPACE_FULL_PULL_KEY_PREFIX = "workspace-parent-tombstone-full-pull-v1";
export const WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY =
  "workspace-lifecycle-deferred-sync-v1";

const WORKSPACE_LIFECYCLE_LOCK_NAME = "tabslate-workspace-lifecycle-v1";
const WORKSPACE_LIFECYCLE_LOCK_LEASE_MS = 30_000;
const WORKSPACE_LIFECYCLE_LOCK_RETRY_MS = 10;

export interface WorkspaceLifecycleIntent {
  workspaceId: string;
  action: Exclude<WorkspaceLifecycleAction, "purge">;
  baseSeq: number;
  previousActiveWorkspaceId: string;
  createdAt: number;
}

export interface WorkspaceLifecycleIntentRecord {
  version: 1;
  intents: WorkspaceLifecycleIntent[];
}

export interface WorkspaceLifecycleCapabilityRecord {
  version: 1;
  userId: string;
  serverOrigin: string;
  supported: true;
  observedAt: number;
}

export interface WorkspaceFullPullRecord {
  version: 1;
  userId: string;
  serverOrigin: string;
  serverSeq: number;
  completedAt: number;
}

export interface WorkspaceLifecycleDeferredSyncRecord {
  version: 1;
  payloadsByWorkspaceId: Record<string, SyncPushPayload>;
}

export type WorkspaceLifecycleStoredRecord =
  | WorkspaceLifecycleIntentRecord
  | WorkspaceLifecycleCapabilityRecord
  | WorkspaceFullPullRecord
  | WorkspaceLifecycleDeferredSyncRecord;

export interface WorkspaceLifecycleStateStorage {
  read(key: string): Promise<WorkspaceLifecycleStoredRecord | undefined>;
  write(key: string, value: WorkspaceLifecycleStoredRecord): Promise<void>;
  remove(key: string): Promise<void>;
  update(
    key: string,
    mutate: (
      current: WorkspaceLifecycleStoredRecord | undefined,
    ) => WorkspaceLifecycleStoredRecord | undefined,
  ): Promise<void>;
}

export interface WorkspaceLifecycleLockGuard {
  renew(): Promise<boolean>;
}

async function withIndexedDBWorkspaceLifecycleLock<Result>(
  operation: (guard: WorkspaceLifecycleLockGuard) => Promise<Result>,
): Promise<Result> {
  const idb = await import("@/lib/idb");
  const owner = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const key = `${WORKSPACE_LIFECYCLE_LOCK_NAME}-fallback`;
  while (!await idb.idbTryAcquireLock(
    key,
    owner,
    Date.now() + WORKSPACE_LIFECYCLE_LOCK_LEASE_MS,
  )) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, WORKSPACE_LIFECYCLE_LOCK_RETRY_MS);
    });
  }
  const guard: WorkspaceLifecycleLockGuard = {
    renew: () => idb.idbRenewLock(
      key,
      owner,
      Date.now() + WORKSPACE_LIFECYCLE_LOCK_LEASE_MS,
    ),
  };
  try {
    return await operation(guard);
  } finally {
    try {
      await idb.idbReleaseLock(key, owner);
    } catch {
      // The lease expires independently; cleanup cannot replace the operation result.
    }
  }
}

/** Holds lifecycle reads, commits, and synchronous enqueue across contexts. */
export async function withWorkspaceLifecycleLock<Result>(
  operation: (guard: WorkspaceLifecycleLockGuard) => Promise<Result>,
): Promise<Result> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      WORKSPACE_LIFECYCLE_LOCK_NAME,
      { mode: "exclusive" },
      () => operation({ renew: async () => true }),
    );
  }
  return withIndexedDBWorkspaceLifecycleLock(operation);
}

interface KVRecord<T> {
  key: string;
  value: T;
}

const indexedDBStorage: WorkspaceLifecycleStateStorage = {
  async read(key) {
    const { idbGet } = await import("@/lib/idb");
    const stored = await idbGet<KVRecord<WorkspaceLifecycleStoredRecord>>("kv", key);
    return stored?.value;
  },
  async write(key, value) {
    const { idbPut } = await import("@/lib/idb");
    await idbPut("kv", { key, value });
  },
  async remove(key) {
    const { idbDelete } = await import("@/lib/idb");
    await idbDelete("kv", key);
  },
  async update(key, mutate) {
    const { idbUpdateKV } = await import("@/lib/idb");
    await idbUpdateKV(
      key,
      (value) => isWorkspaceLifecycleStoredRecord(value) ? value : undefined,
      mutate,
    );
  },
};

function isIntentRecord(
  value: unknown,
): value is WorkspaceLifecycleIntentRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("intents" in value) ||
    !Array.isArray(value.intents)
  ) {
    return false;
  }
  return value.intents.every(isWorkspaceLifecycleIntent);
}

function isCapabilityRecord(
  value: unknown,
): value is WorkspaceLifecycleCapabilityRecord {
  return typeof value === "object" &&
    value !== null &&
    "version" in value && value.version === 1 &&
    "userId" in value && typeof value.userId === "string" &&
    "serverOrigin" in value && typeof value.serverOrigin === "string" &&
    "supported" in value && value.supported === true &&
    "observedAt" in value && typeof value.observedAt === "number";
}

function isFullPullRecord(
  value: unknown,
): value is WorkspaceFullPullRecord {
  return typeof value === "object" &&
    value !== null &&
    "version" in value && value.version === 1 &&
    "userId" in value && typeof value.userId === "string" &&
    "serverOrigin" in value && typeof value.serverOrigin === "string" &&
    "serverSeq" in value && typeof value.serverSeq === "number" &&
    "completedAt" in value && typeof value.completedAt === "number";
}

function isDeferredSyncRecord(
  value: unknown,
): value is WorkspaceLifecycleDeferredSyncRecord {
  return typeof value === "object" &&
    value !== null &&
    "version" in value && value.version === 1 &&
    "payloadsByWorkspaceId" in value &&
    typeof value.payloadsByWorkspaceId === "object" &&
    value.payloadsByWorkspaceId !== null;
}

function isWorkspaceLifecycleIntent(value: unknown): value is WorkspaceLifecycleIntent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return "workspaceId" in value && typeof value.workspaceId === "string" &&
    "action" in value && (value.action === "delete" || value.action === "restore") &&
    "baseSeq" in value && typeof value.baseSeq === "number" &&
    "previousActiveWorkspaceId" in value && typeof value.previousActiveWorkspaceId === "string" &&
    "createdAt" in value && typeof value.createdAt === "number";
}

function isWorkspaceLifecycleStoredRecord(
  value: unknown,
): value is WorkspaceLifecycleStoredRecord {
  return isIntentRecord(value) ||
    isCapabilityRecord(value) ||
    isFullPullRecord(value) ||
    isDeferredSyncRecord(value);
}

/**
 * A malformed or scheme-less serverUrl (e.g. "myserver.example:8080") makes
 * `new URL()` throw, and a self-hosted server entered without a scheme would
 * otherwise collapse to the constant `new URL("x").origin === "null"` for
 * every such input — defeating the (userId, serverOrigin) scoping this value
 * exists for, since two different malformed URLs would collide on the same
 * scoped key. Falling back to the raw string keeps distinct inputs distinct
 * and never throws.
 */
export function normalizedOrigin(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.origin;
    }
  } catch {
    // fall through to the raw-string fallback below
  }
  return serverUrl;
}

function scopedKey(prefix: string, serverUrl: string, userId: string): string {
  const origin = normalizedOrigin(serverUrl);
  return `${prefix}:${encodeURIComponent(origin)}:${encodeURIComponent(userId)}`;
}

export function workspaceLifecycleCapabilityKey(serverUrl: string, userId: string): string {
  return scopedKey(WORKSPACE_CAPABILITY_KEY_PREFIX, serverUrl, userId);
}

export function workspaceFullPullKey(serverUrl: string, userId: string): string {
  return scopedKey(WORKSPACE_FULL_PULL_KEY_PREFIX, serverUrl, userId);
}

export async function readWorkspaceLifecycleIntents(
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<WorkspaceLifecycleIntent[]> {
  const stored = await storage.read(
    WORKSPACE_LIFECYCLE_INTENTS_KEY,
  );
  if (!isIntentRecord(stored)) {
    return [];
  }
  return stored.intents;
}

export async function mergeWorkspaceLifecycleIntent(
  intent: WorkspaceLifecycleIntent,
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<void> {
  await storage.update(WORKSPACE_LIFECYCLE_INTENTS_KEY, (stored) => {
    const current = isIntentRecord(stored) ? stored.intents : [];
    const remaining = current.filter((candidate) => candidate.workspaceId !== intent.workspaceId);
    return {
      version: 1,
      intents: [...remaining, intent],
    };
  });
}

export async function removeWorkspaceLifecycleIntent(
  workspaceId: string,
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<void> {
  await storage.update(WORKSPACE_LIFECYCLE_INTENTS_KEY, (stored) => {
    const current = isIntentRecord(stored) ? stored.intents : [];
    const intents = current.filter((intent) => intent.workspaceId !== workspaceId);
    if (intents.length === 0) {
      return undefined;
    }
    return { version: 1, intents };
  });
}

export function invalidateWorkspaceLifecycleIntents(
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<void> {
  return storage.remove(WORKSPACE_LIFECYCLE_INTENTS_KEY);
}

export async function readWorkspaceLifecycleCapability(
  serverUrl: string,
  userId: string,
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<WorkspaceLifecycleCapabilityRecord | undefined> {
  const origin = normalizedOrigin(serverUrl);
  const key = workspaceLifecycleCapabilityKey(serverUrl, userId);
  const value = await storage.read(key);
  if (
    !isCapabilityRecord(value) ||
    value.userId !== userId ||
    value.serverOrigin !== origin
  ) {
    return undefined;
  }
  return value;
}

export async function mergeWorkspaceLifecycleCapability(
  serverUrl: string,
  userId: string,
  supported: boolean | undefined,
  observedAt: number = Date.now(),
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<void> {
  if (supported !== true) {
    await invalidateWorkspaceLifecycleCapability(serverUrl, userId, storage);
    return;
  }
  const key = workspaceLifecycleCapabilityKey(serverUrl, userId);
  const value: WorkspaceLifecycleCapabilityRecord = {
    version: 1,
    userId,
    serverOrigin: normalizedOrigin(serverUrl),
    supported: true,
    observedAt,
  };
  await storage.write(key, value);
}

export function invalidateWorkspaceLifecycleCapability(
  serverUrl: string,
  userId: string,
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<void> {
  return storage.remove(workspaceLifecycleCapabilityKey(serverUrl, userId));
}

export async function readWorkspaceFullPull(
  serverUrl: string,
  userId: string,
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<WorkspaceFullPullRecord | undefined> {
  const origin = normalizedOrigin(serverUrl);
  const key = workspaceFullPullKey(serverUrl, userId);
  const value = await storage.read(key);
  if (
    !isFullPullRecord(value) ||
    value.userId !== userId ||
    value.serverOrigin !== origin
  ) {
    return undefined;
  }
  return value;
}

export async function mergeWorkspaceFullPull(
  serverUrl: string,
  userId: string,
  serverSeq: number,
  completedAt: number = Date.now(),
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<void> {
  const key = workspaceFullPullKey(serverUrl, userId);
  const value: WorkspaceFullPullRecord = {
    version: 1,
    userId,
    serverOrigin: normalizedOrigin(serverUrl),
    serverSeq,
    completedAt,
  };
  await storage.write(key, value);
}

export function invalidateWorkspaceFullPull(
  serverUrl: string,
  userId: string,
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<void> {
  return storage.remove(workspaceFullPullKey(serverUrl, userId));
}

function mergeSyncEntities<T extends SyncEntity>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const merged = new Map<string, T>();
  for (const entity of current) {
    merged.set(entity.id, entity);
  }
  for (const entity of incoming) {
    merged.set(entity.id, entity);
  }
  return [...merged.values()];
}

function mergeSyncPayloads(current: SyncPushPayload, incoming: SyncPushPayload): SyncPushPayload {
  return {
    entities: {
      workspaces: mergeSyncEntities(current.entities.workspaces, incoming.entities.workspaces),
      collections: mergeSyncEntities(current.entities.collections, incoming.entities.collections),
      bookmarks: mergeSyncEntities(current.entities.bookmarks, incoming.entities.bookmarks),
      tags: mergeSyncEntities(current.entities.tags, incoming.entities.tags),
      groups: mergeSyncEntities(current.entities.groups, incoming.entities.groups),
    },
  };
}

export async function readWorkspaceLifecycleDeferredSync(
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<
  WorkspaceLifecycleDeferredSyncRecord
> {
  const stored = await storage.read(
    WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY,
  );
  if (!isDeferredSyncRecord(stored)) {
    return { version: 1, payloadsByWorkspaceId: {} };
  }
  return stored;
}

export async function mergeWorkspaceLifecycleDeferredPayload(
  workspaceId: string,
  payload: SyncPushPayload,
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<void> {
  await storage.update(WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY, (stored) => {
    const current: WorkspaceLifecycleDeferredSyncRecord = isDeferredSyncRecord(stored)
      ? stored
      : { version: 1, payloadsByWorkspaceId: {} };
    const existingPayload = current.payloadsByWorkspaceId[workspaceId];
    const mergedPayload = existingPayload ? mergeSyncPayloads(existingPayload, payload) : payload;
    return {
      version: 1,
      payloadsByWorkspaceId: {
        ...current.payloadsByWorkspaceId,
        [workspaceId]: mergedPayload,
      },
    };
  });
}

export async function removeWorkspaceLifecycleDeferredPayload(
  workspaceId: string,
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<void> {
  await storage.update(WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY, (stored) => {
    const current = isDeferredSyncRecord(stored)
      ? stored.payloadsByWorkspaceId
      : {};
    const entries = Object.entries(current)
      .filter(([candidateId]) => candidateId !== workspaceId);
    if (entries.length === 0) {
      return undefined;
    }
    return {
      version: 1,
      payloadsByWorkspaceId: Object.fromEntries(entries),
    };
  });
}

export function invalidateWorkspaceLifecycleDeferredSync(
  storage: WorkspaceLifecycleStateStorage = indexedDBStorage,
): Promise<void> {
  return storage.remove(WORKSPACE_LIFECYCLE_DEFERRED_SYNC_KEY);
}
