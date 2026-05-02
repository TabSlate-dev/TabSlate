import { api, SyncPullResponse, SyncPushResponse } from "@/lib/api";
import { SyncQueue } from "@/lib/sync-queue";
import { SSEClient } from "@/lib/sse-client";

export type SyncStatus = "idle" | "syncing" | "error" | "offline";

type Credentials = { baseUrl: string; accessToken: string };
type GetCredentials = () => Credentials | null;
type GetLocalSeq = () => number;
type OnPullSuccess = (resp: SyncPullResponse) => void;
type OnPushSuccess = (resp: SyncPushResponse) => void;
type OnStatusChange = (status: SyncStatus) => void;

const PERIODIC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SSE_FAILURE_THRESHOLD = 3;

/**
 * Orchestrates push (via SyncQueue), SSE real-time pull (via SSEClient),
 * and periodic pull fallback. Instantiated once in App.tsx after auth hydration.
 */
export class SyncEngine {
  private queue: SyncQueue;
  private sseClient: SSEClient;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private status: SyncStatus = "idle";

  constructor(
    private readonly getCredentials: GetCredentials,
    private readonly getLocalSeq: GetLocalSeq,
    private readonly onPullSuccess: OnPullSuccess,
    private readonly onPushSuccess: OnPushSuccess,
    private readonly onStatusChange: OnStatusChange,
  ) {
    this.queue = new SyncQueue(
      getCredentials,
      (resp) => {
        this.onPushSuccess(resp);
        if (resp.rejected.length > 0) {
          this.pull();
        }
        this.setStatus("idle");
      },
      (_err) => this.setStatus("error"),
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
          }
        } else {
          if (this.status === "offline") this.setStatus("idle");
        }
      },
    );
  }

  start() {
    this.sseClient.start();
    this.pull();
    this.ensurePeriodicPull();
  }

  enqueue(entities: Parameters<SyncQueue["enqueue"]>[0]) {
    this.setStatus("syncing");
    this.queue.enqueue(entities);
  }

  async forceSync(): Promise<{ pushed: number; pulled: number }> {
    this.setStatus("syncing");
    let pulled = 0;

    await this.queue.flush().catch(() => { /* queue handles retries */ });

    try {
      const resp = await this.doPull();
      if (resp) {
        pulled =
          resp.entities.workspaces.length +
          resp.entities.collections.length +
          resp.entities.bookmarks.length +
          resp.entities.tags.length;
      }
    } catch { /* ignore */ }

    this.setStatus("idle");
    return { pushed: 1, pulled };
  }

  private async pull() {
    const creds = this.getCredentials();
    if (!creds) return;
    this.setStatus("syncing");
    try {
      const resp = await this.doPull();
      if (resp) this.onPullSuccess(resp);
      this.setStatus("idle");
    } catch {
      this.setStatus("error");
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

  private ensurePeriodicPull() {
    if (this.periodicTimer) return;
    this.periodicTimer = setInterval(() => this.pull(), PERIODIC_INTERVAL_MS);
  }

  private setStatus(s: SyncStatus) {
    if (this.status !== s) {
      this.status = s;
      this.onStatusChange(s);
    }
  }

  get currentStatus(): SyncStatus { return this.status; }

  destroy() {
    this.queue.destroy();
    this.sseClient.destroy();
    if (this.periodicTimer) clearInterval(this.periodicTimer);
  }
}

export let syncEngine: SyncEngine | null = null;
export function initSyncEngine(engine: SyncEngine) { syncEngine = engine; }
export function destroySyncEngine() {
  syncEngine?.destroy();
  syncEngine = null;
}
