import {
  api,
  ApiError,
  SyncPullResponse,
  SyncPushResponse,
  SyncPushPayload,
} from "@/lib/api";
import type { SyncPushEntities, SyncRejected } from "@/lib/api";
import { analytics } from "@/lib/analytics";
import type {
  SyncConflictPolicy,
  SyncPushFailure,
  SyncQueueLifecycleGate,
} from "@/lib/sync-queue";
import type { SyncEntityReference } from "@/lib/sync-conflicts";
import {
  createEmptySyncPushPayload,
  copySyncRecoveryEntities,
  extractSyncRecoveryEntities,
  pruneSyncRecoveryEntities,
  splitSyncPushPayload,
  SYNC_ENTITY_PAYLOAD_MAPPINGS,
  syncPayloadEntities,
} from "@/lib/sync-recovery";
import { mergeWorkspaceLifecycleDeferredPayload } from "@/lib/workspace-lifecycle-state";

export type SyncStatus = "idle" | "syncing" | "error" | "offline";
export type { SyncConflictPolicy } from "@/lib/sync-queue";

type Credentials = { baseUrl: string; accessToken: string };
type GetCredentials = () => Credentials | null;
type GetLocalSeq = () => number;
export interface SyncResolutionContext {
  pullConfirmed(afterSeq: number): Promise<SyncPullResponse>;
  pushConfirmed(payload: SyncPushPayload): Promise<SyncPushResponse>;
  captureDeferredEntities(
    workspaceId: string,
    references: readonly SyncEntityReference[],
  ): Promise<void>;
  blockEntities(references: readonly SyncEntityReference[]): void;
  pruneEntities(references: readonly SyncEntityReference[]): Promise<void>;
  isCurrent(): boolean;
}

export interface PullMergeResult {
  errorMessage: string | null;
}

export interface WorkspaceLifecycleSyncGate {
  shouldResolveWorkspaceLifecycleBeforePush(): Promise<boolean>;
}

export type OnPullSuccess = (
  response: SyncPullResponse,
  isCurrent: () => boolean,
  context: SyncResolutionContext,
) => Promise<PullMergeResult>;
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
  ready(): Promise<void>;
  extractEntities(references: readonly SyncEntityReference[]): SyncPushPayload;
  copyEntities(references: readonly SyncEntityReference[]): SyncPushPayload;
  blockEntities(references: readonly SyncEntityReference[]): void;
  pruneEntities(references: readonly SyncEntityReference[]): Promise<void>;
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
    lifecycleGate: SyncQueueLifecycleGate,
  ) => SyncQueueDriver;
  createSseClient?: (
    getCredentials: GetCredentials,
    onSequence: (serverSeq: number) => void,
    onStatusChange: (connected: boolean) => void,
  ) => SSEClientDriver;
  syncPull?: (baseUrl: string, accessToken: string, localSeq: number) => Promise<SyncPullResponse>;
  syncPush?: (baseUrl: string, accessToken: string, payload: SyncPushPayload) => Promise<SyncPushResponse>;
  refreshAuthentication?: () => Promise<boolean>;
  hasRefreshToken?: () => boolean;
  workspaceLifecycleSyncGate?: WorkspaceLifecycleSyncGate;
  extractRecoveryEntities?: (
    references: readonly SyncEntityReference[],
  ) => Promise<SyncPushPayload>;
  copyRecoveryEntities?: (
    references: readonly SyncEntityReference[],
  ) => Promise<SyncPushPayload>;
  pruneRecoveryEntities?: (
    references: readonly SyncEntityReference[],
  ) => Promise<void>;
  mergeDeferredPayload?: (
    workspaceId: string,
    payload: SyncPushPayload,
  ) => Promise<void>;
}

const PERIODIC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SSE_FAILURE_THRESHOLD = 3;

function sanitizeSyncErrorMessage(errorMessage?: string): string {
  const normalizedMessage = errorMessage ?? "unknown";
  return normalizedMessage
    .replace(/(access_token=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 100);
}

function mergeSyncPayloads(
  current: SyncPushPayload,
  incoming: SyncPushPayload,
): SyncPushPayload {
  const merged = createEmptySyncPushPayload();
  for (const { payloadKey } of SYNC_ENTITY_PAYLOAD_MAPPINGS) {
    const byId = new Map(
      syncPayloadEntities(current, payloadKey).map((entity) => [entity.id, entity]),
    );
    for (const entity of syncPayloadEntities(incoming, payloadKey)) {
      byId.set(entity.id, entity);
    }
    syncPayloadEntities(merged, payloadKey).push(...byId.values());
  }
  return merged;
}

export class SyncRejectedError extends Error {
  constructor(readonly rejected: readonly SyncRejected[]) {
    super("Sync push was rejected");
    this.name = "SyncRejectedError";
  }
}

class AuthenticationSessionEndedError extends Error {
  constructor() {
    super("Authentication session ended");
    this.name = "AuthenticationSessionEndedError";
  }
}

/**
 * Orchestrates push (via SyncQueue), SSE real-time pull (via SSEClient),
 * and periodic pull fallback. Instantiated once in App.tsx after auth hydration.
 */
export class SyncEngine {
  private queue: SyncQueueDriver;
  private sseClient: SSEClientDriver;
  private readonly syncPull: (baseUrl: string, accessToken: string, localSeq: number) => Promise<SyncPullResponse>;
  private readonly syncPush: (baseUrl: string, accessToken: string, payload: SyncPushPayload) => Promise<SyncPushResponse>;
  private readonly refreshAuthentication: () => Promise<boolean>;
  private readonly hasRefreshToken: () => boolean;
  private readonly workspaceLifecycleSyncGate: WorkspaceLifecycleSyncGate;
  private readonly extractRecoveryEntities: (
    references: readonly SyncEntityReference[],
  ) => Promise<SyncPushPayload>;
  private readonly copyRecoveryEntities: (
    references: readonly SyncEntityReference[],
  ) => Promise<SyncPushPayload>;
  private readonly pruneRecoveryEntities: (
    references: readonly SyncEntityReference[],
  ) => Promise<void>;
  private readonly mergeDeferredPayload: (
    workspaceId: string,
    payload: SyncPushPayload,
  ) => Promise<void>;
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
    this.syncPush = dependencies.syncPush ?? ((baseUrl, accessToken, payload) =>
      api.syncPush(baseUrl, accessToken, payload));
    this.refreshAuthentication = dependencies.refreshAuthentication ?? (async () => false);
    this.hasRefreshToken = dependencies.hasRefreshToken ?? (() => false);
    this.workspaceLifecycleSyncGate = dependencies.workspaceLifecycleSyncGate ?? {
      shouldResolveWorkspaceLifecycleBeforePush: async () => false,
    };
    this.extractRecoveryEntities = dependencies.extractRecoveryEntities ??
      extractSyncRecoveryEntities;
    this.copyRecoveryEntities = dependencies.copyRecoveryEntities ??
      copySyncRecoveryEntities;
    this.pruneRecoveryEntities = dependencies.pruneRecoveryEntities ??
      pruneSyncRecoveryEntities;
    this.mergeDeferredPayload = dependencies.mergeDeferredPayload ??
      mergeWorkspaceLifecycleDeferredPayload;

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
    this.queue = dependencies.createQueue(
      getCredentials,
      handleQueueSuccess,
      handleQueueFailure,
      {
        shouldDeferOrdinaryPush: () =>
          this.workspaceLifecycleSyncGate.shouldResolveWorkspaceLifecycleBeforePush(),
      },
    );

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
    void this.runInitialSync().catch(() => undefined);
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
  async forcePush(entities: Partial<SyncPushEntities>): Promise<SyncPushResponse> {
    const payload: SyncPushPayload = {
      entities: {
        workspaces: entities.workspaces ?? [],
        collections: entities.collections ?? [],
        bookmarks: entities.bookmarks ?? [],
        tags: entities.tags ?? [],
        groups: entities.groups ?? [],
      },
    };

    const { response, conflictMessage } = await this.serializeResolutionWithContext(
      async (context) => {
        const response = await context.pushConfirmed(payload);
        this.assertResolutionCurrent(context.isCurrent);
        const conflictMessage = await this.onPushSuccess(response, payload);
        return { response, conflictMessage };
      },
    );
    this.applyPersistentConflict(conflictMessage);
    if (response.rejected.length > 0) {
      await this.requestPull();
    }
    const targetRejections = this.targetRejections(payload, response.rejected);
    if (targetRejections.length > 0) {
      throw new SyncRejectedError(targetRejections);
    }
    return response;
  }

  async forceSync(): Promise<{ pushed: number; pulled: number }> {
    this.lastPulledCount = 0;
    this.setQueueStatus("syncing");
    const lifecyclePending = await this.shouldResolveWorkspaceLifecycleBeforePush();
    if (lifecyclePending) {
      await this.requestPull();
      if (await this.shouldResolveWorkspaceLifecycleBeforePush()) {
        return { pushed: 0, pulled: this.lastPulledCount };
      }
    }
    await this.queue.flush().catch(() => { /* queue handles retries */ });
    if (!lifecyclePending) {
      await this.requestPull();
    }
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

  private serializeResolutionWithContext<Result>(
    operation: (context: SyncResolutionContext) => Promise<Result>,
  ): Promise<Result> {
    return this.serializeResolution(async () => {
      let active = true;
      const isCurrent = () => active && !this.destroyed;
      const context = this.createResolutionContext(isCurrent);
      try {
        return await operation(context);
      } finally {
        active = false;
      }
    });
  }

  private createResolutionContext(isCurrent: () => boolean): SyncResolutionContext {
    return {
      pullConfirmed: (afterSeq) => this.pullWithRefresh(afterSeq, isCurrent),
      pushConfirmed: (payload) => this.pushConfirmed(payload, isCurrent),
      captureDeferredEntities: async (workspaceId, references) => {
        this.assertResolutionCurrent(isCurrent);
        await this.queue.ready();
        this.assertResolutionCurrent(isCurrent);
        const livePayload = this.queue.copyEntities(references);
        const recoveryPayload = await this.copyRecoveryEntities(references);
        this.assertResolutionCurrent(isCurrent);
        await this.mergeDeferredPayload(
          workspaceId,
          mergeSyncPayloads(recoveryPayload, livePayload),
        );
        this.assertResolutionCurrent(isCurrent);
        await this.queue.pruneEntities(references);
        this.assertResolutionCurrent(isCurrent);
        await this.pruneRecoveryEntities(references);
        this.assertResolutionCurrent(isCurrent);
      },
      blockEntities: (references) => {
        this.assertResolutionCurrent(isCurrent);
        this.queue.blockEntities(references);
      },
      pruneEntities: async (references) => {
        this.assertResolutionCurrent(isCurrent);
        await this.queue.pruneEntities(references);
        await this.extractRecoveryEntities(references);
        this.assertResolutionCurrent(isCurrent);
      },
      isCurrent,
    };
  }

  private assertResolutionCurrent(isCurrent: () => boolean): void {
    if (!isCurrent()) {
      throw new Error("Sync resolution is no longer current");
    }
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
      const resp = await this.doPull();
      if (!resp || this.destroyed) {
        return;
      }
      this.lastPulledCount = this.countPulledEntities(resp);
      const mergeResult = await this.serializeResolutionWithContext(
        (context) => this.destroyed
          ? Promise.resolve({ errorMessage: null })
          : this.onPullSuccess(resp, context.isCurrent, context),
      );
      if (this.destroyed) {
        return;
      }
      this.applyPersistentConflict(mergeResult?.errorMessage ?? null);
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
    if (!this.getCredentials()) {
      return null;
    }
    const localSeq = this.getLocalSeq();
    const isCurrent = () => !this.destroyed;
    try {
      const resp = await this.pullWithRefresh(localSeq, isCurrent);
      // Seq divergence (e.g. after account recovery) — full re-sync from 0.
      if (resp.server_seq < localSeq) {
        return this.pullWithRefresh(0, isCurrent);
      }
      return resp;
    } catch (error) {
      if (error instanceof AuthenticationSessionEndedError) {
        return null;
      }
      throw error;
    }
  }

  private async pullWithRefresh(
    afterSeq: number,
    isCurrent: () => boolean,
  ): Promise<SyncPullResponse> {
    this.assertResolutionCurrent(isCurrent);
    const creds = this.getCredentials();
    if (!creds) {
      throw new Error("not authenticated");
    }
    try {
      const response = await this.syncPull(creds.baseUrl, creds.accessToken, afterSeq);
      this.assertResolutionCurrent(isCurrent);
      return response;
    } catch (error) {
      this.assertResolutionCurrent(isCurrent);
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) {
        throw error;
      }
      const refreshed = await this.refreshAuthentication();
      this.assertResolutionCurrent(isCurrent);
      const refreshedCreds = this.getCredentials();
      if (!refreshed || !refreshedCreds) {
        if (!this.hasRefreshToken()) {
          throw new AuthenticationSessionEndedError();
        }
        throw error;
      }
      const response = await this.syncPull(
        refreshedCreds.baseUrl,
        refreshedCreds.accessToken,
        afterSeq,
      );
      this.assertResolutionCurrent(isCurrent);
      return response;
    }
  }

  private async pushWithRefresh(
    payload: SyncPushPayload,
    isCurrent: () => boolean,
  ): Promise<SyncPushResponse> {
    this.assertResolutionCurrent(isCurrent);
    const creds = this.getCredentials();
    if (!creds) {
      throw new Error("not authenticated");
    }
    try {
      const response = await this.syncPush(creds.baseUrl, creds.accessToken, payload);
      this.assertResolutionCurrent(isCurrent);
      return response;
    } catch (error) {
      this.assertResolutionCurrent(isCurrent);
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) {
        throw error;
      }
      const refreshed = await this.refreshAuthentication();
      this.assertResolutionCurrent(isCurrent);
      const refreshedCreds = this.getCredentials();
      if (!refreshed || !refreshedCreds) {
        throw error;
      }
      const response = await this.syncPush(
        refreshedCreds.baseUrl,
        refreshedCreds.accessToken,
        payload,
      );
      this.assertResolutionCurrent(isCurrent);
      return response;
    }
  }

  private async pushConfirmed(
    payload: SyncPushPayload,
    isCurrent: () => boolean,
  ): Promise<SyncPushResponse> {
    let serverSeq = 0;
    const rejected: SyncRejected[] = [];
    for (const chunk of splitSyncPushPayload(payload)) {
      const response = await this.pushWithRefresh(chunk, isCurrent);
      serverSeq = response.server_seq;
      rejected.push(...response.rejected);
      if (response.rejected.length > 0) {
        break;
      }
    }
    return { server_seq: serverSeq, rejected };
  }

  private async runInitialSync(): Promise<void> {
    const lifecycleDecision = this.shouldResolveWorkspaceLifecycleBeforePush();
    const pull = this.requestPull();
    const lifecyclePending = await lifecycleDecision;
    await pull;
    if (this.destroyed || !lifecyclePending) {
      return;
    }
    if (await this.shouldResolveWorkspaceLifecycleBeforePush()) {
      return;
    }
    await this.queue.flush().catch(() => { /* queue handles retries */ });
  }

  private shouldResolveWorkspaceLifecycleBeforePush(): Promise<boolean> {
    if (this.destroyed) {
      return Promise.resolve(false);
    }
    return this.workspaceLifecycleSyncGate.shouldResolveWorkspaceLifecycleBeforePush();
  }

  private targetRejections(
    payload: SyncPushPayload,
    rejected: readonly SyncRejected[],
  ): SyncRejected[] {
    const targetKeys = new Set<string>();
    const targetIds = new Set<string>();
    for (const { entityType, payloadKey } of SYNC_ENTITY_PAYLOAD_MAPPINGS) {
      for (const entity of syncPayloadEntities(payload, payloadKey)) {
        targetKeys.add(`${entityType}:${entity.id}`);
        targetIds.add(entity.id);
      }
    }
    return rejected.filter((item) => {
      if (!targetIds.has(item.id)) {
        return false;
      }
      const hasKnownType = SYNC_ENTITY_PAYLOAD_MAPPINGS.some(
        ({ entityType }) => entityType === item.type,
      );
      if (!hasKnownType) {
        return true;
      }
      return targetKeys.has(`${item.type}:${item.id}`);
    });
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
