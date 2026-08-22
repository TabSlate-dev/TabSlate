import { api, ApiError, SyncPullResponse, SyncPushResponse, SyncPushPayload } from "@/lib/api";
import type { SyncPushEntities } from "@/lib/api";
import { analytics } from "@/lib/analytics";
import type { SyncConflictPolicy, SyncPushFailure } from "@/lib/sync-queue";

export type SyncStatus = "idle" | "syncing" | "error" | "offline";
export type { SyncConflictPolicy } from "@/lib/sync-queue";

type Credentials = { baseUrl: string; accessToken: string };
type GetCredentials = () => Credentials | null;
type GetLocalSeq = () => number;
export type OnPullSuccess = (
  resp: SyncPullResponse,
  isCurrent: () => boolean,
) => Promise<string | null>;
export type OnPushSuccess = (
  resp: SyncPushResponse,
  confirmedPayload: SyncPushPayload,
) => Promise<string | null>;
export type OnLegacyPushFailure = (failure: SyncPushFailure) => Promise<boolean>;
type OnStatusChange = (status: SyncStatus, errorMessage?: string) => void;

interface SyncQueueDriver {
  enqueue(entities: Partial<SyncPushEntities>, conflictPolicy?: SyncConflictPolicy): void;
  flush(): Promise<void>;
  isEmpty(): boolean;
  destroy(): void;
}

interface SSEClientDriver {
  readonly failureCount: number;
  start(): void | Promise<void>;
  destroy(): void;
}

export interface SyncEngineDependencies {
  createQueue?: (
    getCredentials: GetCredentials,
    onSuccess: (response: SyncPushResponse, confirmedPayload: SyncPushPayload) => Promise<void>,
    onFailure: (failure: SyncPushFailure) => Promise<boolean>,
  ) => SyncQueueDriver;
  createSseClient?: (
    getCredentials: GetCredentials,
    onSequence: (serverSeq: number) => void,
    onStatusChange: (connected: boolean) => void,
  ) => SSEClientDriver;
  syncPull?: (baseUrl: string, accessToken: string, localSeq: number) => Promise<SyncPullResponse>;
  refreshAuthentication?: () => Promise<boolean>;
  hasRefreshToken?: () => boolean;
}

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
  private queue: SyncQueueDriver;
  private sseClient: SSEClientDriver;
  private readonly syncPull: (baseUrl: string, accessToken: string, localSeq: number) => Promise<SyncPullResponse>;
  private readonly refreshAuthentication: () => Promise<boolean>;
  private readonly hasRefreshToken: () => boolean;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private status: SyncStatus = "idle";
  private lastErrorMessage: string | null = null;
  private persistentConflictMessage: string | null = null;
  private resolutionChain: Promise<void> = Promise.resolve();
  private pullRequested = false;
  private pullPromise: Promise<void> | null = null;
  private lastPulledCount = 0;
  private destroyed = false;
  private retirement: Promise<void> | null = null;

  constructor(
    private readonly getCredentials: GetCredentials,
    private readonly getLocalSeq: GetLocalSeq,
    private readonly onPullSuccess: OnPullSuccess,
    private readonly onPushSuccess: OnPushSuccess,
    private readonly onStatusChange: OnStatusChange,
    private readonly onLegacyPushFailure: OnLegacyPushFailure,
    dependencies: SyncEngineDependencies,
  ) {
    this.syncPull = dependencies.syncPull ?? ((baseUrl, accessToken, localSeq) =>
      api.syncPull(baseUrl, accessToken, localSeq));
    this.refreshAuthentication = dependencies.refreshAuthentication ?? (async () => false);
    this.hasRefreshToken = dependencies.hasRefreshToken ?? (() => false);

    const handleQueueSuccess = async (resp: SyncPushResponse, confirmedPayload: SyncPushPayload) => {
      if (this.destroyed) {
        return;
      }
      const conflictMessage = await this.serializeResolution(
        () => this.destroyed ? Promise.resolve(null) : this.onPushSuccess(resp, confirmedPayload),
      );
      if (this.destroyed) {
        return;
      }
      if (resp.rejected.length > 0) {
        this.applyPersistentConflict(conflictMessage);
        await this.requestPull();
        return;
      }
      this.applyPersistentConflict(conflictMessage);
    };
    const handleQueueFailure = async (failure: SyncPushFailure) => {
      if (this.destroyed) {
        return false;
      }
      if (failure.retryable && failure.status >= 500 && failure.status < 600) {
        try {
          const handled = await this.serializeResolution(
            () => this.destroyed ? Promise.resolve(false) : this.onLegacyPushFailure(failure),
          );
          if (this.destroyed) {
            return false;
          }
          if (handled) {
            this.setQueueStatus();
            return true;
          }
        } catch (error) {
          if (this.destroyed) {
            return false;
          }
          const message = error instanceof Error ? error.message : "Sync recovery failed";
          this.setStatus("error", sanitizeSyncErrorMessage(message));
          return false;
        }
      }
      this.setStatus("error", sanitizeSyncErrorMessage(failure.error.message));
      return false;
    };
    if (!dependencies.createQueue) {
      throw new Error("SyncEngine requires a queue factory");
    }
    this.queue = dependencies.createQueue(getCredentials, handleQueueSuccess, handleQueueFailure);

    const handleSequence = (serverSeq: number) => {
      if (serverSeq > this.getLocalSeq()) {
        void this.requestPull();
      }
    };
    const handleSseStatus = (connected: boolean) => {
      if (!connected) {
        if (this.sseClient.failureCount >= SSE_FAILURE_THRESHOLD) {
          this.setStatus("offline");
          this.ensurePeriodicPull();
        } else {
          // Before the threshold: probe connectivity immediately via pull().
          // If the backend is truly down, pull() will detect TypeError → "offline".
          void this.requestPull();
        }
      } else {
        this.cancelPeriodicPull();
        if (this.status === "offline") this.setQueueStatus();
      }
    };
    if (!dependencies.createSseClient) {
      throw new Error("SyncEngine requires an SSE client factory");
    }
    this.sseClient = dependencies.createSseClient(getCredentials, handleSequence, handleSseStatus);
  }

  start() {
    this.sseClient.start();
    void this.requestPull();
    this.ensurePeriodicPull();
  }

  enqueue(entities: Partial<SyncPushEntities>, conflictPolicy: SyncConflictPolicy = "clear") {
    this.setQueueStatus("syncing");
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

      const refreshed = await this.refreshAuthentication();
      const refreshedCreds = this.getCredentials();
      if (!refreshed || !refreshedCreds) {
        throw err;
      }

      await api.syncPush(refreshedCreds.baseUrl, refreshedCreds.accessToken, payload);
    }
  }

  async forceSync(): Promise<{ pushed: number; pulled: number }> {
    this.lastPulledCount = 0;
    this.setQueueStatus("syncing");
    await this.queue.flush().catch(() => { /* queue handles retries */ });
    await this.requestPull();
    return { pushed: 1, pulled: this.lastPulledCount };
  }

  private serializeResolution<Result>(operation: () => Promise<Result>): Promise<Result> {
    const next = this.resolutionChain.then(operation, operation);
    this.resolutionChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private requestPull(): Promise<void> {
    if (this.destroyed) {
      return Promise.resolve();
    }
    this.pullRequested = true;
    if (this.pullPromise) {
      return this.pullPromise;
    }

    const loop = this.runPullLoop();
    this.pullPromise = loop;
    void loop.then(
      () => this.completePullLoop(loop),
      () => this.completePullLoop(loop),
    );
    return loop;
  }

  private async runPullLoop(): Promise<void> {
    while (this.pullRequested && !this.destroyed) {
      this.pullRequested = false;
      await this.resolutionChain;
      if (this.destroyed) {
        return;
      }

      // A request received while reconciliation was pending is covered by this
      // current pull, whose local sequence is read immediately before fetching.
      this.pullRequested = false;
      await this.performPull();
    }
  }

  private async performPull(): Promise<void> {
    if (!this.getCredentials()) {
      return;
    }
    this.setQueueStatus("syncing");
    try {
      const resp = await this.pullWithAuthenticationRecovery();
      if (!resp || this.destroyed) {
        return;
      }
      this.lastPulledCount = this.countPulledEntities(resp);
      const conflictMessage = await this.serializeResolution(
        () => this.destroyed
          ? Promise.resolve(null)
          : this.onPullSuccess(resp, () => !this.destroyed),
      );
      if (this.destroyed) {
        return;
      }
      this.applyPersistentConflict(conflictMessage);
    } catch (err) {
      if (this.destroyed) {
        return;
      }
      // TypeError = network failure (connection refused / offline) — mirror forceSync() logic.
      if (err instanceof TypeError) {
        this.setStatus("offline");
        this.ensurePeriodicPull(); // keep retrying while offline
      } else {
        this.setStatus("error", err instanceof Error ? err.message : "Pull failed");
      }
    }
  }

  private async doPull(): Promise<SyncPullResponse | null> {
    const creds = this.getCredentials();
    if (!creds) return null;
    const localSeq = this.getLocalSeq();
    const resp = await this.syncPull(creds.baseUrl, creds.accessToken, localSeq);
    // Seq divergence (e.g. after account recovery) — full re-sync from 0.
    if (resp.server_seq < localSeq) {
      return this.syncPull(creds.baseUrl, creds.accessToken, 0);
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

      // A transport response can arrive after retirement. It must not restart
      // auth work or emit a status after the session cleanup boundary.
      if (this.destroyed) {
        return null;
      }

      const refreshed = await this.refreshAuthentication();
      if (this.destroyed) {
        return null;
      }
      if (!refreshed) {
        // silentRefresh clears the refresh token only after a definitive 401/403.
        // Preserve an error for transient refresh failures so they are not mistaken for logout.
        if (!this.hasRefreshToken()) {
          return null;
        }
        throw err;
      }

      return this.doPull();
    }
  }

  private ensurePeriodicPull() {
    if (this.periodicTimer) return;
    this.periodicTimer = setInterval(() => { void this.requestPull(); }, PERIODIC_INTERVAL_MS);
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
    void this.retire();
  }

  async retire(): Promise<void> {
    if (this.retirement) {
      return this.retirement;
    }
    this.destroyed = true;
    this.queue.destroy();
    this.sseClient.destroy();
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    this.retirement = Promise.all([
      this.resolutionChain.catch(() => undefined),
    ]).then(() => undefined);
    return this.retirement;
  }

  private applyPersistentConflict(conflictMessage: string | null) {
    this.persistentConflictMessage = conflictMessage;
    this.setQueueStatus();
  }

  private setQueueStatus(preferredStatus?: "syncing") {
    if (this.persistentConflictMessage !== null) {
      this.setStatus("error", this.persistentConflictMessage);
      return;
    }
    this.setStatus(preferredStatus ?? (this.queue.isEmpty() ? "idle" : "syncing"));
  }

  private countPulledEntities(resp: SyncPullResponse): number {
    return resp.entities.workspaces.length +
      resp.entities.collections.length +
      resp.entities.bookmarks.length +
      resp.entities.tags.length +
      (resp.entities.groups?.length ?? 0);
  }

  private completePullLoop(loop: Promise<void>) {
    if (this.pullPromise !== loop) {
      return;
    }
    this.pullPromise = null;
    if (this.pullRequested && !this.destroyed) {
      void this.requestPull();
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
