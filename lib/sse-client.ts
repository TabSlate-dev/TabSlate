import { api } from "@/lib/api";

type OnSeqReceived = (seq: number) => void;
type OnStatusChange = (connected: boolean) => void;

const LEADER_KEY = "tabslate-sync-leader";
const LEADER_TTL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Manages a single EventSource connection to /sync/stream.
 * Uses leader election via chrome.storage.local so only one browser
 * window holds the SSE connection — others rely on periodic pull.
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
    const claimed = await this.tryClaimLeader();
    if (!claimed) {
      // Not the leader — poll to check if leadership slot opens up.
      this.heartbeatTimer = setInterval(() => this.start(), HEARTBEAT_INTERVAL_MS);
      return;
    }
    this.isLeader = true;
    this.startHeartbeat();
    await this.connect();
  }

  private tryClaimLeader(): Promise<boolean> {
    return new Promise(resolve => {
      chrome.storage.local.get(LEADER_KEY, result => {
        const entry = result[LEADER_KEY] as { ts: number } | undefined;
        const now = Date.now();
        if (entry && now - entry.ts < LEADER_TTL_MS) {
          resolve(false);
          return;
        }
        chrome.storage.local.set({ [LEADER_KEY]: { ts: now } }, () => resolve(true));
      });
    });
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      chrome.storage.local.set({ [LEADER_KEY]: { ts: Date.now() } });
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
      chrome.storage.local.remove(LEADER_KEY);
    }
  }
}
