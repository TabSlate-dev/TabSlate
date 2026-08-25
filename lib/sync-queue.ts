import { api, ApiError } from "./api";
import type { SyncEntity, SyncEntityType, SyncPushEntities, SyncPushPayload, SyncPushResponse } from "./api";
import { syncQueueConflictRegistry } from "./sync-queue-conflicts";
import type { SyncEntityReference } from "./sync-conflicts";
import {
  bufferSyncRecoverySnapshot,
  createEmptySyncPushPayload,
  isSyncPushPayloadEmpty,
  loadSyncRecoverySnapshot,
  splitSyncPushPayload,
  SYNC_ENTITY_PAYLOAD_MAPPINGS,
  syncPayloadEntities,
} from "./sync-recovery";
import { useAuthStore } from "../store/auth-store";

export {
  MAX_SYNC_ENTITIES_PER_PUSH,
  splitSyncPushPayload,
} from "./sync-recovery";
const INITIAL_RETRY_DELAY = 2_000;
const MAX_RETRY_DELAY = 60_000;
const PROBE_RETRY_DELAY = 300_000;
const IDENTICAL_SERVER_FAILURES_BEFORE_PROBE = 5;

export type SyncConflictPolicy = "clear" | "respect";

export interface SyncQueueOptions {
  random?: () => number;
}

export interface SyncQueueLifecycleGate {
  shouldDeferOrdinaryPush(): Promise<boolean>;
}

export interface SyncPushFailure {
  error: Error;
  payload: SyncPushPayload;
  confirmedPayload: SyncPushPayload;
  retryable: boolean;
  status: number;
}

interface QueuedEntities {
  workspaces: Map<string, SyncEntity>;
  collections: Map<string, SyncEntity>;
  bookmarks: Map<string, SyncEntity>;
  tags: Map<string, SyncEntity>;
  groups: Map<string, SyncEntity>;
}

interface PushSnapshot {
  payload: SyncPushPayload;
  conflictClears: Map<string, SyncEntityReference>;
}

type OnPushSuccess = (response: SyncPushResponse, confirmedPayload: SyncPushPayload) => Promise<void>;
type OnPushFailure = (failure: SyncPushFailure) => Promise<boolean>;

function createQueuedEntities(): QueuedEntities {
  return { workspaces: new Map(), collections: new Map(), bookmarks: new Map(), tags: new Map(), groups: new Map() };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function entityReferenceKey(reference: SyncEntityReference): string {
  return `${reference.entityType}:${reference.entityId}`;
}

export function pushErrorStatus(error: Error): number {
  return error instanceof ApiError ? error.status : 0;
}

export function isRetryablePushError(error: Error): boolean {
  const status = pushErrorStatus(error);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export function computeRetryDelay(baseDelay: number, error: Error, random: () => number): number {
  const jittered = Math.round(baseDelay * (0.8 + random() * 0.4));
  if (error instanceof ApiError && error.status === 429 && error.retryAfter !== undefined) {
    return Math.max(error.retryAfter * 1000, jittered);
  }
  return jittered;
}

export class SyncQueue {
  private queue = createQueuedEntities();
  private readonly pendingConflictClears = new Map<string, SyncEntityReference>();
  private readonly blockedEntities = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = INITIAL_RETRY_DELAY;
  private readonly recoveryReady: Promise<void>;
  private pushTail: Promise<void> = Promise.resolve();
  private destroyed = false;
  private needsRecoveryReplay = false;
  private identicalFailureFingerprint: string | null = null;
  private identicalServerFailureCount = 0;

  constructor(
    private readonly getCredentials: () => { baseUrl: string; accessToken: string } | null,
    private readonly onSuccess: OnPushSuccess,
    private readonly onFailure: OnPushFailure,
    private readonly options: SyncQueueOptions = {},
    private readonly lifecycleGate?: SyncQueueLifecycleGate,
  ) {
    this.recoveryReady = Promise.all([
      syncQueueConflictRegistry.ready(),
      this.hydrateRecoverySnapshot(),
    ]).then(() => undefined);
  }

  enqueue(entities: Partial<SyncPushEntities>, conflictPolicy: SyncConflictPolicy = "clear") {
    if (this.destroyed) {
      return;
    }
    this.addEntities(this.queue, entities);
    if (conflictPolicy === "clear") {
      this.addPendingConflictClears(entities);
    }
    this.schedulePush(INITIAL_RETRY_DELAY);
  }

  flush(): Promise<void> {
    if (this.destroyed) {
      return Promise.resolve();
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    return this.requestPush(false);
  }

  ready(): Promise<void> {
    return this.recoveryReady;
  }

  extractEntities(references: readonly SyncEntityReference[]): SyncPushPayload {
    return this.selectEntities(references, true);
  }

  copyEntities(references: readonly SyncEntityReference[]): SyncPushPayload {
    return this.selectEntities(references, false);
  }

  private selectEntities(
    references: readonly SyncEntityReference[],
    remove: boolean,
  ): SyncPushPayload {
    const extracted = createEmptySyncPushPayload();
    for (const { entityType, payloadKey } of SYNC_ENTITY_PAYLOAD_MAPPINGS) {
      const queueMap = this.queue[payloadKey];
      const target = syncPayloadEntities(extracted, payloadKey);
      for (const reference of references) {
        if (reference.entityType !== entityType) {
          continue;
        }
        const entity = queueMap.get(reference.entityId);
        if (entity) {
          target.push(remove ? entity : structuredClone(entity));
          if (remove) {
            queueMap.delete(reference.entityId);
          }
        }
        if (remove) {
          this.pendingConflictClears.delete(entityReferenceKey(reference));
        }
      }
    }
    return extracted;
  }

  blockEntities(references: readonly SyncEntityReference[]): void {
    for (const reference of references) {
      this.blockedEntities.add(entityReferenceKey(reference));
    }
  }

  async pruneEntities(references: readonly SyncEntityReference[]): Promise<void> {
    await this.recoveryReady;
    this.extractEntities(references);
  }

  isEmpty(): boolean {
    return this.queue.workspaces.size === 0 && this.queue.collections.size === 0 &&
      this.queue.bookmarks.size === 0 && this.queue.tags.size === 0 && this.queue.groups.size === 0;
  }

  destroy() {
    this.destroyed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private schedulePush(delayMs: number) {
    if (this.destroyed) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.requestPush(true);
    }, delayMs);
  }

  private requestPush(automatic: boolean): Promise<void> {
    if (this.destroyed) {
      return Promise.resolve();
    }
    const requestedPush = this.pushTail.then(async () => {
      if (this.destroyed) {
        return;
      }
      await this.doPush(automatic);
    });
    this.pushTail = requestedPush.catch(() => {});
    return requestedPush;
  }

  private async doPush(automatic: boolean): Promise<void> {
    await this.recoveryReady;
    if (this.destroyed) {
      return;
    }
    if (this.needsRecoveryReplay) {
      await this.restoreRecoverySnapshot();
      if (this.destroyed) {
        return;
      }
      this.needsRecoveryReplay = false;
    }
    if (this.isEmpty()) {
      return;
    }
    if (automatic && await this.lifecycleGate?.shouldDeferOrdinaryPush()) {
      return;
    }
    const creds = this.getCredentials();
    if (!creds) {
      return;
    }

    const snapshot = this.takePushSnapshot();
    if (isSyncPushPayloadEmpty(snapshot.payload)) {
      return;
    }
    try {
      await this.clearSnapshotConflictClears(snapshot.conflictClears);
    } catch (caught) {
      if (this.destroyed) {
        return;
      }
      this.requeueSnapshot(snapshot.payload);
      await this.onFailure({
        error: asError(caught),
        payload: snapshot.payload,
        confirmedPayload: createEmptySyncPushPayload(),
        retryable: true,
        status: 0,
      });
      if (!this.destroyed) {
        this.scheduleRetry(this.nextRetryDelay(asError(caught), snapshot.payload));
      }
      return;
    }
    if (this.destroyed) {
      return;
    }
    this.removePersistedConflictClears(snapshot.conflictClears);
    const full = syncQueueConflictRegistry.filterPayload(snapshot.payload);
    if (isSyncPushPayloadEmpty(full)) {
      return;
    }

    const chunks = splitSyncPushPayload(full);
    const confirmedPayload = createEmptySyncPushPayload();
    let finalServerSeq = 0;
    let hadSuccessfulChunk = false;
    const allRejected: SyncPushResponse["rejected"] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      try {
        const response = await api.syncPush(creds.baseUrl, creds.accessToken, chunk);
        if (this.destroyed) {
          return;
        }
        hadSuccessfulChunk = true;
        finalServerSeq = response.server_seq;
        allRejected.push(...response.rejected);
        if (response.rejected.length > 0) {
          this.resetRetryState();
          await this.onSuccess(response, chunk);
          if (this.destroyed) {
            return;
          }
          return;
        }
        this.mergePayloadInto(confirmedPayload, chunk);
      } catch (caught) {
        const error = asError(caught);
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          if (hadSuccessfulChunk) {
            await this.onSuccess({ server_seq: finalServerSeq, rejected: allRejected }, confirmedPayload);
            if (this.destroyed) {
              return;
            }
          }
          await this.handleAuthenticationFailure(chunks, index);
          return;
        }

        const failedPayload = this.mergeChunks(chunks.slice(index));
        if (hadSuccessfulChunk) {
          await this.onSuccess({ server_seq: finalServerSeq, rejected: allRejected }, confirmedPayload);
          if (this.destroyed) {
            return;
          }
        }
        await this.handlePushFailure(error, failedPayload, confirmedPayload);
        return;
      }
    }

    this.resetRetryState();
    await this.onSuccess({ server_seq: finalServerSeq, rejected: allRejected }, full);
  }

  private async handleAuthenticationFailure(chunks: SyncPushPayload[], failedIndex: number): Promise<void> {
    if (this.destroyed) {
      return;
    }
    bufferSyncRecoverySnapshot(chunks[failedIndex]);
    if (this.destroyed) {
      return;
    }
    this.needsRecoveryReplay = true;
    for (let index = failedIndex + 1; index < chunks.length; index += 1) {
      this.requeueSnapshot(chunks[index]);
    }
    const refreshed = await useAuthStore.getState().silentRefresh();
    if (this.destroyed) {
      return;
    }
    if (refreshed) {
      this.requeueSnapshot(chunks[failedIndex]);
      this.schedulePush(0);
      return;
    }
    if (useAuthStore.getState().refreshToken) {
      this.scheduleRetry(INITIAL_RETRY_DELAY);
    }
  }

  private async handlePushFailure(error: Error, payload: SyncPushPayload, confirmedPayload: SyncPushPayload): Promise<void> {
    if (this.destroyed) {
      return;
    }
    const status = pushErrorStatus(error);
    const retryable = isRetryablePushError(error);
    const handled = await this.onFailure({ error, payload, confirmedPayload, retryable, status });
    if (this.destroyed) {
      return;
    }
    if (handled) {
      this.resetRetryState();
      return;
    }
    if (!retryable) {
      await syncQueueConflictRegistry.recordPayload(payload, status);
      if (this.destroyed) {
        return;
      }
      this.resetRetryState();
      return;
    }
    this.requeueSnapshot(payload);
    this.scheduleRetry(this.nextRetryDelay(error, payload));
  }

  private async clearSnapshotConflictClears(references: Map<string, SyncEntityReference>): Promise<void> {
    if (references.size === 0) {
      return;
    }
    await syncQueueConflictRegistry.clearEntities(Array.from(references.values()));
  }

  private removePersistedConflictClears(references: Map<string, SyncEntityReference>) {
    for (const [key, reference] of references) {
      if (this.pendingConflictClears.get(key) === reference) {
        this.pendingConflictClears.delete(key);
      }
    }
  }

  private async hydrateRecoverySnapshot(): Promise<void> {
    try {
      const restored = await this.restoreRecoverySnapshot();
      if (this.destroyed) {
        return;
      }
      if (restored) {
        this.schedulePush(0);
      }
    } catch (caught) {
      if (this.destroyed) {
        return;
      }
      await this.onFailure({
        error: asError(caught),
        payload: createEmptySyncPushPayload(),
        confirmedPayload: createEmptySyncPushPayload(),
        retryable: false,
        status: 0,
      });
    }
  }

  private async restoreRecoverySnapshot(): Promise<boolean> {
    try {
      const recoverySnapshot = await loadSyncRecoverySnapshot();
      if (this.destroyed) {
        return false;
      }
      if (!recoverySnapshot) {
        return false;
      }
      this.requeueSnapshot(recoverySnapshot);
      return true;
    } catch (caught) {
      if (this.destroyed) {
        return false;
      }
      await this.onFailure({
        error: asError(caught),
        payload: createEmptySyncPushPayload(),
        confirmedPayload: createEmptySyncPushPayload(),
        retryable: false,
        status: 0,
      });
      return false;
    }
  }

  private takeQueueSnapshot(): SyncPushPayload {
    const snapshot: SyncPushPayload = {
      entities: {
        workspaces: Array.from(this.queue.workspaces.values()),
        collections: Array.from(this.queue.collections.values()),
        bookmarks: Array.from(this.queue.bookmarks.values()),
        tags: Array.from(this.queue.tags.values()),
        groups: Array.from(this.queue.groups.values()),
      },
    };
    this.queue = createQueuedEntities();
    return snapshot;
  }

  private takePushSnapshot(): PushSnapshot {
    const payload = this.takeQueueSnapshot();
    const entityKeys = new Set<string>();
    const addKeys = (entityType: SyncEntityType, entities: SyncEntity[]) => {
      for (const entity of entities) {
        entityKeys.add(entityReferenceKey({ entityType, entityId: entity.id }));
      }
    };
    addKeys("workspace", payload.entities.workspaces);
    addKeys("collection", payload.entities.collections);
    addKeys("bookmark", payload.entities.bookmarks);
    addKeys("tag", payload.entities.tags);
    addKeys("saved_group", payload.entities.groups);

    const conflictClears = new Map<string, SyncEntityReference>();
    for (const [key, reference] of this.pendingConflictClears) {
      if (entityKeys.has(key)) {
        conflictClears.set(key, reference);
      }
    }
    return { payload, conflictClears };
  }

  private requeueSnapshot(snapshot: SyncPushPayload) {
    this.addEntities(this.queue, snapshot.entities, false);
  }

  private addEntities(target: QueuedEntities, entities: Partial<SyncPushEntities>, overwrite = true) {
    const merge = (
      entityType: SyncEntityType,
      map: Map<string, SyncEntity>,
      items?: SyncEntity[],
    ) => {
      for (const entity of items ?? []) {
        if (this.blockedEntities.has(entityReferenceKey({ entityType, entityId: entity.id }))) {
          continue;
        }
        if (overwrite || !map.has(entity.id)) {
          map.set(entity.id, entity);
        }
      }
    };
    merge("workspace", target.workspaces, entities.workspaces);
    merge("collection", target.collections, entities.collections);
    merge("bookmark", target.bookmarks, entities.bookmarks);
    merge("tag", target.tags, entities.tags);
    merge("saved_group", target.groups, entities.groups);
  }

  private addPendingConflictClears(entities: Partial<SyncPushEntities>) {
    const add = (entityType: SyncEntityType, items?: SyncEntity[]) => {
      for (const entity of items ?? []) {
        const reference = { entityType, entityId: entity.id };
        if (this.blockedEntities.has(entityReferenceKey(reference))) {
          continue;
        }
        this.pendingConflictClears.set(entityReferenceKey(reference), reference);
      }
    };
    add("workspace", entities.workspaces);
    add("collection", entities.collections);
    add("bookmark", entities.bookmarks);
    add("tag", entities.tags);
    add("saved_group", entities.groups);
  }

  private mergeChunks(chunks: SyncPushPayload[]): SyncPushPayload {
    const merged = createEmptySyncPushPayload();
    for (const chunk of chunks) {
      this.mergePayloadInto(merged, chunk);
    }
    return merged;
  }

  private mergePayloadInto(target: SyncPushPayload, incoming: SyncPushPayload) {
    const merge = (current: SyncEntity[], additions: SyncEntity[]) => {
      const byId = new Map(current.map((entity) => [entity.id, entity]));
      for (const entity of additions) {
        byId.set(entity.id, entity);
      }
      return Array.from(byId.values());
    };
    target.entities.workspaces = merge(target.entities.workspaces, incoming.entities.workspaces);
    target.entities.collections = merge(target.entities.collections, incoming.entities.collections);
    target.entities.bookmarks = merge(target.entities.bookmarks, incoming.entities.bookmarks);
    target.entities.tags = merge(target.entities.tags, incoming.entities.tags);
    target.entities.groups = merge(target.entities.groups, incoming.entities.groups);
  }

  private nextRetryDelay(error: Error, payload: SyncPushPayload): number {
    const fingerprint = JSON.stringify(payload.entities);
    const status = pushErrorStatus(error);
    if (status >= 500 && this.identicalFailureFingerprint === fingerprint) {
      this.identicalServerFailureCount += 1;
    } else if (status >= 500) {
      this.identicalFailureFingerprint = fingerprint;
      this.identicalServerFailureCount = 1;
    } else {
      this.identicalFailureFingerprint = null;
      this.identicalServerFailureCount = 0;
    }
    const baseDelay = status >= 500 && this.identicalServerFailureCount >= IDENTICAL_SERVER_FAILURES_BEFORE_PROBE
      ? PROBE_RETRY_DELAY
      : this.retryDelay;
    const delay = computeRetryDelay(baseDelay, error, this.options.random ?? Math.random);
    this.retryDelay = Math.min(baseDelay * 2, MAX_RETRY_DELAY);
    return delay;
  }

  private scheduleRetry(delayMs: number) {
    if (this.destroyed) {
      return;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.requestPush(true);
    }, delayMs);
  }

  private resetRetryState() {
    this.retryDelay = INITIAL_RETRY_DELAY;
    this.identicalFailureFingerprint = null;
    this.identicalServerFailureCount = 0;
  }

}
