import { api, ApiError } from "./api";
import type { SyncEntity, SyncEntityType, SyncPushEntities, SyncPushPayload, SyncPushResponse } from "./api";
import { syncQueueConflictRegistry } from "./sync-queue-conflicts";
import type { SyncEntityReference } from "./sync-conflicts";
import { bufferSyncRecoverySnapshot, loadSyncRecoverySnapshot } from "./sync-recovery";
import { useAuthStore } from "../store/auth-store";

const MAX_PER_PUSH = 900;
const INITIAL_RETRY_DELAY = 2_000;
const MAX_RETRY_DELAY = 60_000;
const PROBE_RETRY_DELAY = 300_000;
const IDENTICAL_SERVER_FAILURES_BEFORE_PROBE = 5;

export type SyncConflictPolicy = "clear" | "respect";

export interface SyncQueueOptions {
  random?: () => number;
}

export interface SyncPushFailure {
  error: Error;
  payload: SyncPushPayload;
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

type OnPushSuccess = (response: SyncPushResponse, confirmedPayload: SyncPushPayload) => Promise<void>;
type OnPushFailure = (failure: SyncPushFailure) => Promise<boolean>;

function createQueuedEntities(): QueuedEntities {
  return { workspaces: new Map(), collections: new Map(), bookmarks: new Map(), tags: new Map(), groups: new Map() };
}

function createEmptyPayload(): SyncPushPayload {
  return { entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] } };
}

function isPayloadEmpty(payload: SyncPushPayload): boolean {
  const { entities } = payload;
  return entities.workspaces.length === 0 && entities.collections.length === 0 &&
    entities.bookmarks.length === 0 && entities.tags.length === 0 && entities.groups.length === 0;
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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = INITIAL_RETRY_DELAY;
  private readonly recoveryReady: Promise<void>;
  private needsRecoveryReplay = false;
  private identicalFailureFingerprint: string | null = null;
  private identicalServerFailureCount = 0;

  constructor(
    private readonly getCredentials: () => { baseUrl: string; accessToken: string } | null,
    private readonly onSuccess: OnPushSuccess,
    private readonly onFailure: OnPushFailure,
    private readonly options: SyncQueueOptions = {},
  ) {
    this.recoveryReady = Promise.all([
      syncQueueConflictRegistry.ready(),
      this.hydrateRecoverySnapshot(),
    ]).then(() => undefined);
  }

  enqueue(entities: Partial<SyncPushEntities>, conflictPolicy: SyncConflictPolicy = "clear") {
    this.addEntities(this.queue, entities);
    if (conflictPolicy === "clear") {
      this.addPendingConflictClears(entities);
    }
    this.schedulePush(INITIAL_RETRY_DELAY);
  }

  flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    return this.doPush();
  }

  isEmpty(): boolean {
    return this.queue.workspaces.size === 0 && this.queue.collections.size === 0 &&
      this.queue.bookmarks.size === 0 && this.queue.tags.size === 0 && this.queue.groups.size === 0;
  }

  destroy() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
  }

  private schedulePush(delayMs: number) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.doPush();
    }, delayMs);
  }

  private async doPush(): Promise<void> {
    await this.recoveryReady;
    if (this.needsRecoveryReplay) {
      await this.restoreRecoverySnapshot();
      this.needsRecoveryReplay = false;
    }
    if (this.isEmpty()) {
      return;
    }
    const creds = this.getCredentials();
    if (!creds) {
      return;
    }

    await this.clearPendingConflictClears();
    const full = syncQueueConflictRegistry.filterPayload(this.takeQueueSnapshot());
    if (isPayloadEmpty(full)) {
      return;
    }

    const chunks = this.splitPayload(full);
    const confirmedPayload = createEmptyPayload();
    let finalServerSeq = 0;
    let hadSuccessfulChunk = false;
    const allRejected: SyncPushResponse["rejected"] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      try {
        const response = await api.syncPush(creds.baseUrl, creds.accessToken, chunk);
        hadSuccessfulChunk = true;
        finalServerSeq = response.server_seq;
        allRejected.push(...response.rejected);
        if (response.rejected.length > 0) {
          this.resetRetryState();
          await this.onSuccess(response, chunk);
          return;
        }
        this.mergePayloadInto(confirmedPayload, chunk);
      } catch (caught) {
        const error = asError(caught);
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          if (hadSuccessfulChunk) {
            await this.onSuccess({ server_seq: finalServerSeq, rejected: allRejected }, confirmedPayload);
          }
          await this.handleAuthenticationFailure(chunks, index);
          return;
        }

        const failedPayload = this.mergeChunks(chunks.slice(index));
        if (hadSuccessfulChunk) {
          await this.onSuccess({ server_seq: finalServerSeq, rejected: allRejected }, confirmedPayload);
        }
        await this.handlePushFailure(error, failedPayload);
        return;
      }
    }

    this.resetRetryState();
    await this.onSuccess({ server_seq: finalServerSeq, rejected: allRejected }, full);
  }

  private async handleAuthenticationFailure(chunks: SyncPushPayload[], failedIndex: number): Promise<void> {
    bufferSyncRecoverySnapshot(chunks[failedIndex]);
    this.needsRecoveryReplay = true;
    for (let index = failedIndex + 1; index < chunks.length; index += 1) {
      this.requeueSnapshot(chunks[index]);
    }
    const refreshed = await useAuthStore.getState().silentRefresh();
    if (refreshed) {
      this.requeueSnapshot(chunks[failedIndex]);
      this.schedulePush(0);
      return;
    }
    if (useAuthStore.getState().refreshToken) {
      this.scheduleRetry(INITIAL_RETRY_DELAY);
    }
  }

  private async handlePushFailure(error: Error, payload: SyncPushPayload): Promise<void> {
    const status = pushErrorStatus(error);
    const retryable = isRetryablePushError(error);
    const handled = await this.onFailure({ error, payload, retryable, status });
    if (handled) {
      this.resetRetryState();
      return;
    }
    if (!retryable) {
      await syncQueueConflictRegistry.recordPayload(payload, status);
      this.resetRetryState();
      return;
    }
    this.requeueSnapshot(payload);
    this.scheduleRetry(this.nextRetryDelay(error, payload));
  }

  private async clearPendingConflictClears(): Promise<void> {
    if (this.pendingConflictClears.size === 0) {
      return;
    }
    const references = Array.from(this.pendingConflictClears.values());
    await syncQueueConflictRegistry.clearEntities(references);
    for (const reference of references) {
      this.pendingConflictClears.delete(entityReferenceKey(reference));
    }
  }

  private async hydrateRecoverySnapshot(): Promise<void> {
    try {
      if (await this.restoreRecoverySnapshot()) {
        this.schedulePush(0);
      }
    } catch (caught) {
      await this.onFailure({ error: asError(caught), payload: createEmptyPayload(), retryable: false, status: 0 });
    }
  }

  private async restoreRecoverySnapshot(): Promise<boolean> {
    try {
      const recoverySnapshot = await loadSyncRecoverySnapshot();
      if (!recoverySnapshot) {
        return false;
      }
      this.requeueSnapshot(recoverySnapshot);
      return true;
    } catch (caught) {
      await this.onFailure({ error: asError(caught), payload: createEmptyPayload(), retryable: false, status: 0 });
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

  private requeueSnapshot(snapshot: SyncPushPayload) {
    this.addEntities(this.queue, snapshot.entities, false);
  }

  private addEntities(target: QueuedEntities, entities: Partial<SyncPushEntities>, overwrite = true) {
    const merge = (map: Map<string, SyncEntity>, items?: SyncEntity[]) => {
      for (const entity of items ?? []) {
        if (overwrite || !map.has(entity.id)) {
          map.set(entity.id, entity);
        }
      }
    };
    merge(target.workspaces, entities.workspaces);
    merge(target.collections, entities.collections);
    merge(target.bookmarks, entities.bookmarks);
    merge(target.tags, entities.tags);
    merge(target.groups, entities.groups);
  }

  private addPendingConflictClears(entities: Partial<SyncPushEntities>) {
    const add = (entityType: SyncEntityType, items?: SyncEntity[]) => {
      for (const entity of items ?? []) {
        const reference = { entityType, entityId: entity.id };
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
    const merged = createEmptyPayload();
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
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.doPush();
    }, delayMs);
  }

  private resetRetryState() {
    this.retryDelay = INITIAL_RETRY_DELAY;
    this.identicalFailureFingerprint = null;
    this.identicalServerFailureCount = 0;
  }

  private splitPayload(full: SyncPushPayload): SyncPushPayload[] {
    const { workspaces: ws, collections: col, bookmarks: bm, tags: tag, groups: grp } = full.entities;
    const total = ws.length + col.length + bm.length + tag.length + grp.length;
    if (total <= MAX_PER_PUSH) {
      return [full];
    }
    const chunks: SyncPushPayload[] = [];
    type NonBookmarkKey = "workspaces" | "collections" | "tags" | "groups";
    type NonBookmarkEntry = [NonBookmarkKey, SyncEntity];
    const nonBookmarks: NonBookmarkEntry[] = [
      ...ws.map((entity) => ["workspaces", entity] as NonBookmarkEntry),
      ...col.map((entity) => ["collections", entity] as NonBookmarkEntry),
      ...tag.map((entity) => ["tags", entity] as NonBookmarkEntry),
      ...grp.map((entity) => ["groups", entity] as NonBookmarkEntry),
    ];
    for (let index = 0; index < nonBookmarks.length; index += MAX_PER_PUSH) {
      const entities = createEmptyPayload().entities;
      for (const [key, entity] of nonBookmarks.slice(index, index + MAX_PER_PUSH)) {
        entities[key].push(entity);
      }
      chunks.push({ entities });
    }
    for (let index = 0; index < bm.length; index += MAX_PER_PUSH) {
      chunks.push({ entities: { ...createEmptyPayload().entities, bookmarks: bm.slice(index, index + MAX_PER_PUSH) } });
    }
    return chunks;
  }
}
