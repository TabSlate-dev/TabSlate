import { api } from "@/lib/api";
import { getDB, idbPut, idbDelete } from "@/lib/idb";

type OnSeqReceived = (seq: number) => void;
type OnStatusChange = (connected: boolean) => void;
const LEADER_TTL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Manages a single EventSource connection to /sync/stream.
 * Uses leader election via IndexedDB (kv store, "sync-leader" key) so only one
 * browser window holds the SSE connection — others rely on periodic pull.
 */
export class SSEClient {
  private es: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30_000;
  private failures = 0;
  private isLeader = false;
  private destroyed = false;

  constructor(
    private readonly getCredentials: () => { baseUrl: string; accessToken: string } | null,
    private readonly onSeq: OnSeqReceived,
    private readonly onStatusChange: OnStatusChange,
  ) {}

  async start() {
    if (this.destroyed) return;
    let claimed: boolean;
    try {
      claimed = await this.tryClaimLeader();
    } catch {
      claimed = false;
    }
    if (this.destroyed) return;
    if (!claimed) {
      // Not the leader — poll to check if leadership slot opens up.
      // Guard: only create one poll interval; without this check each start() call
      // stacks a new setInterval on top of old ones, causing exponential growth.
      if (!this.heartbeatTimer) {
        this.heartbeatTimer = setInterval(() => this.start(), HEARTBEAT_INTERVAL_MS);
      }
      return;
    }
    this.isLeader = true;
    this.startHeartbeat();
    await this.connect();
  }

  private tryClaimLeader(): Promise<boolean> {
    return getDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(["kv"], "readwrite");
          const store = tx.objectStore("kv");
          const req = store.get("sync-leader");
          req.onsuccess = () => {
            const entry = (
              req.result as { key: string; value: { ts: number } } | undefined
            )?.value;
            const now = Date.now();
            if (entry && now - entry.ts < LEADER_TTL_MS) {
              resolve(false);
              return;
            }
            store.put({ key: "sync-leader", value: { ts: now } });
          };
          req.onerror = () => reject(req.error);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => resolve(false);
        }),
    );
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); }
    this.heartbeatTimer = setInterval(() => {
      idbPut("kv", { key: "sync-leader", value: { ts: Date.now() } });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async connect() {
    if (this.destroyed) return;
    const creds = this.getCredentials();
    if (!creds) return;

    let token: string;
    try {
      const resp = await api.issueSSEToken(creds.baseUrl, creds.accessToken);
      token = resp.token;
    } catch {
      this.failures++;
      this.onStatusChange(false);
      this.scheduleReconnect();
      return;
    }

    const url = `${creds.baseUrl}/sync/stream?token=${encodeURIComponent(token)}`;
    this.es = new EventSource(url);

    this.es.onopen = () => {
      this.failures = 0;
      this.reconnectDelay = 1000;
      this.onStatusChange(true);
    };

    this.es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { seq: number };
        if (typeof data.seq === "number") {
          this.onSeq(data.seq);
        }
      } catch { /* ignore malformed events */ }
    };

    this.es.onerror = () => {
      this.es?.close();
      this.es = null;
      this.failures++;
      this.onStatusChange(false);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  get failureCount(): number { return this.failures; }

  destroy() {
    this.destroyed = true;
    this.es?.close();
    this.es = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.isLeader) {
      idbDelete("kv", "sync-leader");
    }
  }
}
