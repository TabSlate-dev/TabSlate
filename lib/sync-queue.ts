import { api, ApiError } from "./api";
import type { SyncEntity, SyncPushEntities, SyncPushPayload, SyncPushResponse } from "./api";
import { bufferSyncRecoverySnapshot, loadSyncRecoverySnapshot } from "./sync-recovery";
import { useAuthStore } from "../store/auth-store";

// Stay well under the server's hard limit of 1000 entities per push.
// Non-bookmark entities (workspaces, collections, tags, groups) are always
// pushed first so that collection FK targets exist before bookmarks arrive.
const MAX_PER_PUSH = 900;

interface QueuedEntities {
  workspaces: Map<string, SyncEntity>;
  collections: Map<string, SyncEntity>;
  bookmarks: Map<string, SyncEntity>;
  tags: Map<string, SyncEntity>;
  groups: Map<string, SyncEntity>;
}

type OnPushSuccess = (resp: SyncPushResponse) => void;
type OnPushError = (err: Error) => void;

/**
 * Batches local changes and pushes them to the server with a 2-second debounce.
 * Retries with exponential backoff (2s → 4s → 8s … max 60s) on network failure.
 * Updates for the same entity ID collapse to the latest value.
 * Large payloads (>MAX_PER_PUSH entities) are automatically split into ordered
 * sequential chunks: non-bookmarks first, then bookmarks.
 */
export class SyncQueue {
  private queue: QueuedEntities = {
    workspaces: new Map(),
    collections: new Map(),
    bookmarks: new Map(),
    tags: new Map(),
    groups: new Map(),
  };
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 2000;
  private readonly maxRetryDelay = 60_000;
  private readonly recoveryReady: Promise<void>;
  private needsRecoveryReplay = false;

  constructor(
    private readonly getCredentials: () => { baseUrl: string; accessToken: string } | null,
    private readonly onSuccess: OnPushSuccess,
    private readonly onError: OnPushError,
  ) {
    this.recoveryReady = this.hydrateRecoverySnapshot();
  }

  enqueue(entities: Partial<SyncPushEntities>) {
    const set = (map: Map<string, SyncEntity>, items?: SyncEntity[]) => {
      items?.forEach(item => map.set(item.id, item));
    };
    set(this.queue.workspaces, entities.workspaces);
    set(this.queue.collections, entities.collections);
    set(this.queue.bookmarks, entities.bookmarks);
    set(this.queue.tags, entities.tags);
    set(this.queue.groups, entities.groups);

    this.schedulePush(2000);
  }

  flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    return this.doPush();
  }

  private schedulePush(delayMs: number) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.doPush();
    }, delayMs);
  }

  isEmpty(): boolean {
    return (
      this.queue.workspaces.size === 0 &&
      this.queue.collections.size === 0 &&
      this.queue.bookmarks.size === 0 &&
      this.queue.tags.size === 0 &&
      this.queue.groups.size === 0
    );
  }

  private async doPush(): Promise<void> {
    await this.recoveryReady;
    if (this.needsRecoveryReplay) {
      await this.restoreRecoverySnapshot();
      this.needsRecoveryReplay = false;
    }
    if (this.isEmpty()) return;
    const creds = this.getCredentials();
    if (!creds) return;

    // Snapshot and clear the queue before the request so new changes
    // that arrive during the in-flight request are not lost.
    const full: SyncPushPayload = {
      entities: {
        workspaces: Array.from(this.queue.workspaces.values()),
        collections: Array.from(this.queue.collections.values()),
        bookmarks: Array.from(this.queue.bookmarks.values()),
        tags: Array.from(this.queue.tags.values()),
        groups: Array.from(this.queue.groups.values()),
      },
    };
    this.queue = { workspaces: new Map(), collections: new Map(), bookmarks: new Map(), tags: new Map(), groups: new Map() };

    const chunks = this.splitPayload(full);
    let finalServerSeq = 0;
    let hadSuccessfulChunk = false;
    const allRejected: SyncPushResponse["rejected"] = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        const resp = await api.syncPush(creds.baseUrl, creds.accessToken, chunks[i]);
        hadSuccessfulChunk = true;
        finalServerSeq = resp.server_seq;
        allRejected.push(...resp.rejected);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          // Buffer the first unsent chunk for recovery; re-enqueue the rest.
          bufferSyncRecoverySnapshot(chunks[i]);
          this.needsRecoveryReplay = true;
          for (let j = i + 1; j < chunks.length; j++) {
            this.requeueSnapshot(chunks[j]);
          }

          const refreshed = await useAuthStore.getState().silentRefresh();
          if (refreshed) {
            this.requeueSnapshot(chunks[i]);
            this.schedulePush(0);
          } else if (useAuthStore.getState().refreshToken) {
            // Match auth-store's retry cadence so recovery resumes after a transient refresh failure.
            this.scheduleRetry();
          }
          return;
        }

        // Re-enqueue all remaining chunks so changes are not lost on failure.
        for (let j = i; j < chunks.length; j++) {
          this.requeueSnapshot(chunks[j]);
        }

        if (hadSuccessfulChunk) {
          this.onSuccess({ server_seq: finalServerSeq, rejected: allRejected });
        }
        this.onError(err instanceof Error ? err : new Error(String(err)));
        this.scheduleRetry();
        return;
      }
    }

    this.retryDelay = 2000;
    this.onSuccess({ server_seq: finalServerSeq, rejected: allRejected });
  }

  private async hydrateRecoverySnapshot() {
    try {
      if (await this.restoreRecoverySnapshot()) {
        this.schedulePush(0);
      }
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Replays any persisted 401/403 recovery data before the next push attempt. */
  private async restoreRecoverySnapshot(): Promise<boolean> {
    try {
      const recoverySnapshot = await loadSyncRecoverySnapshot();
      if (!recoverySnapshot) {
        return false;
      }

      this.requeueSnapshot(recoverySnapshot);
      return true;
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private requeueSnapshot(snapshot: SyncPushPayload) {
    const merge = (map: Map<string, SyncEntity>, entities: SyncEntity[]) => {
      for (const entity of entities) {
        const id = entity.id;
        if (!map.has(id)) {
          map.set(id, entity);
        }
      }
    };

    merge(this.queue.workspaces, snapshot.entities.workspaces);
    merge(this.queue.collections, snapshot.entities.collections);
    merge(this.queue.bookmarks, snapshot.entities.bookmarks);
    merge(this.queue.tags, snapshot.entities.tags);
    merge(this.queue.groups, snapshot.entities.groups);
  }

  private scheduleRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.doPush();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
  }

  /**
   * Splits a payload that exceeds MAX_PER_PUSH into ordered sequential chunks.
   * Non-bookmark entities (workspaces → collections → tags → groups) come first
   * so FK targets exist before bookmark references arrive.
   */
  private splitPayload(full: SyncPushPayload): SyncPushPayload[] {
    const { workspaces: ws, collections: col, bookmarks: bm, tags: tag, groups: grp } = full.entities;
    const total = ws.length + col.length + bm.length + tag.length + grp.length;
    if (total <= MAX_PER_PUSH) return [full];

    const emptyEntities = (): SyncPushPayload["entities"] => ({
      workspaces: [],
      collections: [],
      bookmarks: [],
      tags: [],
      groups: [],
    });

    const chunks: SyncPushPayload[] = [];

    // Phase 1: non-bookmark entities in FK-safe order (bookmarks reference collections)
    type NonBmKey = "workspaces" | "collections" | "tags" | "groups";
    type NonBmEntry = [NonBmKey, SyncEntity];
    const nonBm: NonBmEntry[] = [
      ...ws.map(e => ["workspaces", e] as NonBmEntry),
      ...col.map(e => ["collections", e] as NonBmEntry),
      ...tag.map(e => ["tags", e] as NonBmEntry),
      ...grp.map(e => ["groups", e] as NonBmEntry),
    ];
    for (let i = 0; i < nonBm.length; i += MAX_PER_PUSH) {
      const entities = emptyEntities();
      for (const [key, e] of nonBm.slice(i, i + MAX_PER_PUSH)) {
        entities[key].push(e);
      }
      chunks.push({ entities });
    }

    // Phase 2: bookmarks in chunks (collection FKs already pushed above)
    for (let i = 0; i < bm.length; i += MAX_PER_PUSH) {
      chunks.push({ entities: { ...emptyEntities(), bookmarks: bm.slice(i, i + MAX_PER_PUSH) } });
    }

    return chunks;
  }
}
