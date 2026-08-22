import { api, ApiError, SyncPullResponse, SyncPushResponse, SyncPushPayload } from "@/lib/api";
import type { SyncPushEntities } from "@/lib/api";
import { analytics } from "@/lib/analytics";
import { SyncQueue, type SyncConflictPolicy } from "@/lib/sync-queue";
import { SSEClient } from "@/lib/sse-client";
import { useAuthStore } from "@/store/auth-store";

export type SyncStatus = "idle" | "syncing" | "error" | "offline";
export type { SyncConflictPolicy } from "@/lib/sync-queue";

type Credentials = { baseUrl: string; accessToken: string };
type GetCredentials = () => Credentials | null;
type GetLocalSeq = () => number;
type OnPullSuccess = (resp: SyncPullResponse) => Promise<string | null | void> | string | null | void;
type OnPushSuccess = (resp: SyncPushResponse) => void;
type OnStatusChange = (status: SyncStatus, errorMessage?: string) => void;

const PERIODIC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SSE_FAILURE_THRESHOLD = 3;

function sanitizeSyncErrorMessage(errorMessage?: string): string {
  const normalizedMessage = errorMessage ?? "unknown";
  return normalizedMessage
    .replace(/(access_token=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 100);
}

/**
 * Orchestrates push (via SyncQueue), SSE real-time pull (via SSEClient),
 * and periodic pull fallback. Instantiated once in App.tsx after auth hydration.
 */
export class SyncEngine {
  private queue: SyncQueue;
  private sseClient: SSEClient;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private status: SyncStatus = "idle";
  private lastErrorMessage: string | null = null;
  private isPulling = false;

  constructor(
    private readonly getCredentials: GetCredentials,
    private readonly getLocalSeq: GetLocalSeq,
    private readonly onPullSuccess: OnPullSuccess,
    private readonly onPushSuccess: OnPushSuccess,
    private readonly onStatusChange: OnStatusChange,
  ) {
    this.queue = new SyncQueue(
      getCredentials,
      async (resp) => {
        await this.onPushSuccess(resp);
        if (resp.rejected.length > 0) {
          this.pull();
        }
        this.setStatus(this.queue.isEmpty() ? "idle" : "syncing");
      },
      async (failure) => {
        this.setStatus("error", failure.error.message);
        return false;
      },
    );

    this.sseClient = new SSEClient(
      getCredentials,
      (serverSeq) => {
        if (serverSeq > this.getLocalSeq()) {
          this.pull();
        }
      },
      (connected) => {
        if (!connected) {
          if (this.sseClient.failureCount >= SSE_FAILURE_THRESHOLD) {
            this.setStatus("offline");
            this.ensurePeriodicPull();
          } else {
            // Before the threshold: probe connectivity immediately via pull().
            // If the backend is truly down, pull() will detect TypeError → "offline".
            // If pull is already in progress the isPulling guard makes this a no-op.
            this.pull();
          }
        } else {
          this.cancelPeriodicPull();
          if (this.status === "offline") this.setStatus(this.queue.isEmpty() ? "idle" : "syncing");
        }
      },
    );
  }

  start() {
    this.sseClient.start();
    this.pull();
    this.ensurePeriodicPull();
  }

  enqueue(entities: Partial<SyncPushEntities>, conflictPolicy: SyncConflictPolicy = "clear") {
    this.setStatus("syncing");
    this.queue.enqueue(entities, conflictPolicy);
  }

  /**
   * Push a payload directly to the server, bypassing the debounce queue.
   * Used for permanent-delete operations: the server must confirm before local
   * IDB cleanup, so that a page refresh mid-operation leaves the item in IDB
   * (still visible in trash) rather than creating a server-side orphan.
   */
  async forcePush(entities: Partial<SyncPushEntities>): Promise<void> {
    const creds = this.getCredentials();
    if (!creds) { throw new Error("not authenticated"); }
    const payload: SyncPushPayload = {
      entities: {
        workspaces: entities.workspaces ?? [],
        collections: entities.collections ?? [],
        bookmarks: entities.bookmarks ?? [],
        tags: entities.tags ?? [],
        groups: entities.groups ?? [],
      },
    };

    try {
      await api.syncPush(creds.baseUrl, creds.accessToken, payload);
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) {
        throw err;
      }

      const refreshed = await useAuthStore.getState().silentRefresh();
      const refreshedCreds = this.getCredentials();
      if (!refreshed || !refreshedCreds) {
        throw err;
      }

      await api.syncPush(refreshedCreds.baseUrl, refreshedCreds.accessToken, payload);
    }
  }

  async forceSync(): Promise<{ pushed: number; pulled: number }> {
    this.setStatus("syncing");
    let pulled = 0;

    await this.queue.flush().catch(() => { /* queue handles retries */ });

    try {
      const resp = await this.pullWithAuthenticationRecovery();
      if (resp) {
        await this.onPullSuccess(resp);
        pulled =
          resp.entities.workspaces.length +
          resp.entities.collections.length +
          resp.entities.bookmarks.length +
          resp.entities.tags.length +
          (resp.entities.groups?.length ?? 0);
      }
    } catch (err) {
      // TypeError = network failure (connection refused / offline)
      if (err instanceof TypeError) {
        this.setStatus("offline");
      } else {
        this.setStatus("error", err instanceof Error ? err.message : "Sync failed");
      }
      return { pushed: 1, pulled };
    }

    // Only reset if no error was already set by the push path (onError callback).
    if (this.status === "syncing") {
      this.setStatus(this.queue.isEmpty() ? "idle" : "syncing");
    }
    return { pushed: 1, pulled };
  }

  private async pull() {
    if (this.isPulling) return;
    this.isPulling = true;
    const creds = this.getCredentials();
    if (!creds) { this.isPulling = false; return; }
    this.setStatus("syncing");
    try {
      const resp = await this.pullWithAuthenticationRecovery();
      if (resp) await this.onPullSuccess(resp);
      this.setStatus(this.queue.isEmpty() ? "idle" : "syncing");
    } catch (err) {
      // TypeError = network failure (connection refused / offline) — mirror forceSync() logic.
      if (err instanceof TypeError) {
        this.setStatus("offline");
        this.ensurePeriodicPull(); // keep retrying while offline
      } else {
        this.setStatus("error", err instanceof Error ? err.message : "Pull failed");
      }
    } finally {
      this.isPulling = false;
    }
  }

  private async doPull(): Promise<SyncPullResponse | null> {
    const creds = this.getCredentials();
    if (!creds) return null;
    const localSeq = this.getLocalSeq();
    const resp = await api.syncPull(creds.baseUrl, creds.accessToken, localSeq);
    // Seq divergence (e.g. after account recovery) — full re-sync from 0.
    if (resp.server_seq < localSeq) {
      return api.syncPull(creds.baseUrl, creds.accessToken, 0);
    }
    return resp;
  }

  /** Refresh a rejected access token once, then retry the pull with current credentials. */
  private async pullWithAuthenticationRecovery(): Promise<SyncPullResponse | null> {
    try {
      return await this.doPull();
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) {
        throw err;
      }

      const refreshed = await useAuthStore.getState().silentRefresh();
      if (!refreshed) {
        // silentRefresh clears the refresh token only after a definitive 401/403.
        // Preserve an error for transient refresh failures so they are not mistaken for logout.
        if (!useAuthStore.getState().refreshToken) {
          return null;
        }
        throw err;
      }

      return this.doPull();
    }
  }

  private ensurePeriodicPull() {
    if (this.periodicTimer) return;
    this.periodicTimer = setInterval(() => this.pull(), PERIODIC_INTERVAL_MS);
  }

  private cancelPeriodicPull() {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  private setStatus(s: SyncStatus, errorMessage?: string) {
    const nextErrorMessage = s === "error" ? (errorMessage ?? null) : null;
    const shouldTrackError =
      s === "error" &&
      (this.status !== s || this.lastErrorMessage !== nextErrorMessage);

    this.lastErrorMessage = nextErrorMessage;
    if (this.status !== s) {
      this.status = s;
      this.onStatusChange(s, this.lastErrorMessage ?? undefined);
    } else if (s === "error" && errorMessage !== undefined) {
      this.onStatusChange(s, errorMessage);
    }

    if (shouldTrackError) {
      analytics.track("sync_error", {
        message: sanitizeSyncErrorMessage(errorMessage),
      });
    }
  }

  get currentStatus(): SyncStatus { return this.status; }
  get currentErrorMessage(): string | null { return this.lastErrorMessage; }

  destroy() {
    this.queue.destroy();
    this.sseClient.destroy();
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }
}

export let syncEngine: SyncEngine | null = null;
export function initSyncEngine(engine: SyncEngine) { syncEngine = engine; }
export function destroySyncEngine() {
  syncEngine?.destroy();
  syncEngine = null;
}
/** Clears the global syncEngine ref only if it still points to `engine`. */
export function releaseSyncEngine(engine: SyncEngine) {
  if (syncEngine === engine) { syncEngine = null; }
}
