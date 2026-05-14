import { api, ApiError } from "@/lib/api";
import type { SyncPushPayload, SyncPushResponse } from "@/lib/api";
import { bufferSyncRecoverySnapshot, takeSyncRecoverySnapshot } from "@/lib/sync-recovery";
import { useAuthStore } from "@/store/auth-store";

interface QueuedEntities {
  workspaces: Map<string, object>;
  collections: Map<string, object>;
  bookmarks: Map<string, object>;
  tags: Map<string, object>;
  groups: Map<string, object>;
}

type OnPushSuccess = (resp: SyncPushResponse) => void;
type OnPushError = (err: Error) => void;

/**
 * Batches local changes and pushes them to the server with a 2-second debounce.
 * Retries with exponential backoff (2s → 4s → 8s … max 60s) on network failure.
 * Updates for the same entity ID collapse to the latest value.
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

  constructor(
    private readonly getCredentials: () => { baseUrl: string; accessToken: string } | null,
    private readonly onSuccess: OnPushSuccess,
    private readonly onError: OnPushError,
  ) {
    const recoverySnapshot = takeSyncRecoverySnapshot();
    if (recoverySnapshot) {
      this.requeueSnapshot(recoverySnapshot);
      this.schedulePush(0);
    }
  }

  enqueue(entities: Partial<{ workspaces: object[]; collections: object[]; bookmarks: object[]; tags: object[]; groups: object[] }>) {
    const set = <T extends { id: string }>(map: Map<string, object>, items?: T[]) => {
      items?.forEach(item => map.set(item.id, item));
    };
    set(this.queue.workspaces, entities.workspaces as Array<{ id: string }>);
    set(this.queue.collections, entities.collections as Array<{ id: string }>);
    set(this.queue.bookmarks, entities.bookmarks as Array<{ id: string }>);
    set(this.queue.tags, entities.tags as Array<{ id: string }>);
    set(this.queue.groups, entities.groups as Array<{ id: string }>);

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
    if (this.isEmpty()) return;
    const creds = this.getCredentials();
    if (!creds) return;

    // Snapshot and clear the queue before the request so new changes
    // that arrive during the in-flight request are not lost.
    const snapshot: SyncPushPayload = {
      entities: {
        workspaces: Array.from(this.queue.workspaces.values()),
        collections: Array.from(this.queue.collections.values()),
        bookmarks: Array.from(this.queue.bookmarks.values()),
        tags: Array.from(this.queue.tags.values()),
        groups: Array.from(this.queue.groups.values()),
      },
    };
    this.queue = { workspaces: new Map(), collections: new Map(), bookmarks: new Map(), tags: new Map(), groups: new Map() };

    try {
      const resp = await api.syncPush(creds.baseUrl, creds.accessToken, snapshot);
      this.retryDelay = 2000;
      this.onSuccess(resp);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        bufferSyncRecoverySnapshot(snapshot);
        void useAuthStore.getState().silentRefresh();
        return;
      }

      // Re-enqueue snapshot so changes are not lost on failure.
      this.requeueSnapshot(snapshot);

      this.onError(err instanceof Error ? err : new Error(String(err)));
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.doPush();
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
    }
  }

  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private requeueSnapshot(snapshot: SyncPushPayload) {
    snapshot.entities.workspaces.forEach(e => this.queue.workspaces.set((e as { id: string }).id, e));
    snapshot.entities.collections.forEach(e => this.queue.collections.set((e as { id: string }).id, e));
    snapshot.entities.bookmarks.forEach(e => this.queue.bookmarks.set((e as { id: string }).id, e));
    snapshot.entities.tags.forEach(e => this.queue.tags.set((e as { id: string }).id, e));
    snapshot.entities.groups.forEach(e => this.queue.groups.set((e as { id: string }).id, e));
  }
}
