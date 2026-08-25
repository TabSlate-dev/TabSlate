// Acceptance coverage for the workspace-management lifecycle redesign (Task 17).
//
// This drives the REAL production stack — lib/sync-engine.ts, lib/sync-confirmation.ts,
// lib/workspace-lifecycle-coordinator.ts, lib/workspace-lifecycle-state.ts,
// lib/workspace-aggregate.ts, and store/workspace-store.ts — end to end against a
// minimal fake HTTP backend, from two independently isolated "device" processes.
//
// Why subprocesses: lib/idb.ts, lib/sync-engine.ts (`syncEngine` global),
// lib/sync-lifecycle.ts (`activeLifecycle` global), lib/sync-recovery.ts (in-memory
// recovery snapshot cache), and every store/*.ts are module-level singletons.
// Re-importing a module under a cache-busting specifier does not change what its
// own internal `import "./idb"` resolves to, so two independent, believable
// "devices" cannot coexist inside one JS module graph without either patching
// production code or duplicating its logic — both against the task's brief. Each
// device therefore runs as a genuinely separate OS process
// (test/fixtures/workspace-management-device-runner.ts), talking to a shared fake
// sync backend over real HTTP via the real lib/api.ts client, and is driven
// interactively by the RpcDevice wrapper below over newline-delimited JSON on
// stdio. "Restart" kills a device's process and spawns a fresh one against the
// same on-disk IndexedDB/chrome.storage state file, matching a real browser
// restart: durable storage survives, in-memory JS state does not.
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Minimal shape of a Bun.spawn() subprocess handle — just what this file uses.
// Avoids depending on @types/bun, which isn't installed anywhere else in this
// repo; every other *.test.ts file keeps bun:test itself behind the same
// ts-expect-error convention used above.
interface DeviceProcess {
  stdin: { write(data: string): void; flush(): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(): void;
  exited: Promise<number>;
}

// ---------------------------------------------------------------------------
// Fake sync backend — a minimal, real HTTP server standing in for
// TabSlate-server. It is intentionally not a reimplementation of any CLIENT
// lifecycle algorithm (that logic all lives in, and is exercised through, the
// real lib/workspace-lifecycle-coordinator.ts); it only holds server-side
// state (per-user entities, monotonic seq, workspace is_deleted 0/1/2) the way
// any acceptance test's fake remote counterpart must.
// ---------------------------------------------------------------------------
interface ServerWorkspaceRecord {
  id: string;
  user_id: string;
  name: string;
  color: string;
  position: number;
  seq: number;
  is_deleted: 0 | 1 | 2;
  deletion_model: 0 | 1;
  deleted_at?: number;
  created_at: number;
  updated_at: number;
}

interface ServerEntityRecord {
  id: string;
  seq: number;
  [key: string]: unknown;
}

interface UserState {
  seq: number;
  workspaces: Map<string, ServerWorkspaceRecord>;
  collections: Map<string, ServerEntityRecord>;
  bookmarks: Map<string, ServerEntityRecord>;
  tags: Map<string, ServerEntityRecord>;
  groups: Map<string, ServerEntityRecord>;
}

function createUserState(): UserState {
  return {
    seq: 0,
    workspaces: new Map(),
    collections: new Map(),
    bookmarks: new Map(),
    tags: new Map(),
    groups: new Map(),
  };
}

class FakeSyncServer {
  private readonly users = new Map<string, UserState>();
  private server: { port: number; stop(closeActiveConnections?: boolean): void } | null = null;

  get url(): string {
    if (!this.server) {
      throw new Error("FakeSyncServer is not started");
    }
    return `http://localhost:${this.server.port}`;
  }

  userState(userId: string): UserState {
    let state = this.users.get(userId);
    if (!state) {
      state = createUserState();
      this.users.set(userId, state);
    }
    return state;
  }

  start(): void {
    // @ts-expect-error Bun provides this global at runtime.
    this.server = Bun.serve({
      port: 0,
      fetch: (request: Request) => this.handle(request),
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private userIdFromRequest(request: Request): string | null {
    const auth = request.headers.get("authorization") ?? "";
    const match = /^Bearer test-token-(.+)$/.exec(auth);
    return match ? match[1] : null;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = this.userIdFromRequest(request);
    if (!userId) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const state = this.userState(userId);

    if (request.method === "POST" && url.pathname === "/sync/push") {
      const body = await request.json() as {
        entities: {
          workspaces?: Array<Record<string, unknown>>;
          collections?: Array<Record<string, unknown>>;
          bookmarks?: Array<Record<string, unknown>>;
          tags?: Array<Record<string, unknown>>;
          groups?: Array<Record<string, unknown>>;
        };
      };
      state.seq += 1;
      const newSeq = state.seq;

      for (const raw of body.entities.workspaces ?? []) {
        const { lifecycle_action, ...fields } = raw as Record<string, unknown> & { id: string };
        const existing = state.workspaces.get(fields.id);
        if (lifecycle_action === "purge") {
          if (existing) {
            state.workspaces.set(fields.id, {
              ...existing,
              is_deleted: 2,
              seq: newSeq,
              updated_at: Date.now(),
            });
          }
          continue;
        }
        const isDeleted: 0 | 1 = lifecycle_action === "delete"
          ? 1
          : lifecycle_action === "restore"
            ? 0
            : (existing?.is_deleted === 1 ? 1 : 0);
        const deletedAt = lifecycle_action === "delete"
          ? (typeof fields.deleted_at === "number" ? fields.deleted_at : Date.now())
          : lifecycle_action === "restore"
            ? undefined
            : existing?.deleted_at;
        state.workspaces.set(fields.id, {
          id: fields.id,
          user_id: userId,
          name: typeof fields.name === "string" ? fields.name : existing?.name ?? "",
          color: typeof fields.color === "string" ? fields.color : existing?.color ?? "",
          position: typeof fields.position === "number" ? fields.position : existing?.position ?? 0,
          seq: newSeq,
          is_deleted: isDeleted,
          deletion_model: 1,
          deleted_at: deletedAt,
          created_at: existing?.created_at ?? Date.now(),
          updated_at: Date.now(),
        });
      }

      for (const raw of body.entities.collections ?? []) {
        const fields = raw as Record<string, unknown> & { id: string };
        const existing = state.collections.get(fields.id);
        state.collections.set(fields.id, {
          ...fields,
          user_id: userId,
          seq: newSeq,
          is_deleted: fields.deleted_at ? 1 : 0,
          created_at: existing?.created_at ?? Date.now(),
          updated_at: Date.now(),
        });
      }
      for (const raw of body.entities.bookmarks ?? []) {
        const fields = raw as Record<string, unknown> & { id: string };
        const existing = state.bookmarks.get(fields.id);
        state.bookmarks.set(fields.id, {
          ...fields,
          user_id: userId,
          seq: newSeq,
          created_at: existing?.created_at ?? Date.now(),
          updated_at: Date.now(),
        });
      }
      for (const raw of body.entities.tags ?? []) {
        const fields = raw as Record<string, unknown> & { id: string };
        state.tags.set(fields.id, { ...fields, user_id: userId, seq: newSeq, updated_at: Date.now() });
      }
      for (const raw of body.entities.groups ?? []) {
        const fields = raw as Record<string, unknown> & { id: string };
        const existing = state.groups.get(fields.id);
        state.groups.set(fields.id, {
          ...fields,
          user_id: userId,
          seq: newSeq,
          is_deleted: fields.deleted_at ? 1 : 0,
          created_at: existing?.created_at ?? Date.now(),
          updated_at: Date.now(),
          tabs: fields.tabs ?? [],
        });
      }

      return Response.json({ server_seq: newSeq, rejected: [] });
    }

    if (request.method === "GET" && url.pathname === "/sync/pull") {
      const afterSeq = Number(url.searchParams.get("after_seq") ?? "0");
      const collect = <T extends ServerEntityRecord>(map: Map<string, T>) =>
        [...map.values()].filter((entity) => entity.seq > afterSeq);
      return Response.json({
        entities: {
          // Unlike every other entity type, Workspaces are always returned in
          // full on every pull (never seq-filtered) — the lifecycle coordinator
          // needs an always-current view of every root's is_deleted state to
          // reconcile safely; see docs/superpowers/specs/2026-08-23-workspace-
          // management-redesign-design.md: "Sync pull continues returning
          // Workspace states 0, 1, and 2."
          workspaces: [...state.workspaces.values()],
          collections: collect(state.collections),
          bookmarks: collect(state.bookmarks),
          tags: collect(state.tags),
          groups: collect(state.groups),
        },
        server_seq: state.seq,
        capabilities: { workspace_parent_tombstone: true },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/plan") {
      return Response.json({
        subscription: { plan: "test", status: "active", expires_at: null },
        limits: {
          max_workspaces: 1000,
          max_bookmarks: 100000,
          max_collections: 10000,
          max_tags: 10000,
          max_saved_groups: 10000,
          trash_grace_days: 30,
        },
        usage: {
          workspaces: state.workspaces.size,
          bookmarks: state.bookmarks.size,
          collections: state.collections.size,
          tags: state.tags.size,
          saved_groups: state.groups.size,
        },
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// RpcDevice — spawns test/fixtures/workspace-management-device-runner.ts as a
// child process and drives it over newline-delimited JSON on stdio.
// ---------------------------------------------------------------------------
interface WorkspaceActionResult {
  status: "queued" | "completed" | "blocked" | "unsupported";
  reason?: string;
}

interface DeviceAggregate {
  workspace?: { id: string; deletedAt?: number; deletionModel?: number };
  collections: Array<{ id: string; deletedAt?: number; archivedAt?: number }>;
  bookmarks: Array<{ id: string }>;
  groups: Array<{ id: string }>;
  groupTabs: Array<{ id: string }>;
}

const RUNNER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "workspace-management-device-runner.ts",
);

class RpcDevice {
  private proc: DeviceProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private stdoutBuffer = "";
  private readStdoutPromise: Promise<void> | null = null;

  constructor(
    readonly deviceId: string,
    readonly stateFile: string,
    private readonly serverUrl: string,
    private readonly userId: string,
  ) {}

  async spawn(): Promise<void> {
    // @ts-expect-error Bun provides this global at runtime.
    const proc = Bun.spawn({
      cmd: ["bun", RUNNER_PATH],
      env: {
        ...process.env,
        DEVICE_STATE_FILE: this.stateFile,
        DEVICE_SERVER_URL: this.serverUrl,
        DEVICE_USER_ID: this.userId,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as DeviceProcess;
    this.proc = proc;
    this.stdoutBuffer = "";
    this.readStdoutPromise = this.pumpStdout(proc);
    void this.pumpStderr(proc);
    // The runner writes an initial {id:0, ok:true, result:"ready"} line once its
    // RPC loop is installed — wait for it so calls never race process startup.
    await this.waitForReady();
  }

  private async waitForReady(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.pending.set(0, { resolve: () => resolve(), reject });
      setTimeout(() => {
        if (this.pending.has(0)) {
          this.pending.delete(0);
          reject(new Error(`Device ${this.deviceId} did not become ready in time`));
        }
      }, 15000);
    });
  }

  private async pumpStdout(proc: DeviceProcess): Promise<void> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      this.stdoutBuffer += decoder.decode(value, { stream: true });
      let newlineIndex = this.stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.stdoutBuffer.slice(0, newlineIndex);
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        this.handleLine(line);
        newlineIndex = this.stdoutBuffer.indexOf("\n");
      }
    }
  }

  private async pumpStderr(proc: DeviceProcess): Promise<void> {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      const text = decoder.decode(value, { stream: true });
      if (text.trim()) {
        // Surface child crashes/stack traces in the parent's test output.
        console.error(`[device:${this.deviceId}] ${text}`);
      }
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: { id: number; ok: boolean; result?: unknown; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) {
      return;
    }
    this.pending.delete(message.id);
    if (message.ok) {
      waiter.resolve(message.result);
    } else {
      waiter.reject(new Error(message.error ?? "RPC call failed"));
    }
  }

  async call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    if (!this.proc) {
      throw new Error(`Device ${this.deviceId} is not running`);
    }
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Device ${this.deviceId} RPC "${method}" timed out`));
        }
      }, 20000);
    });
    this.proc.stdin.write(payload);
    this.proc.stdin.flush();
    return promise as Promise<T>;
  }

  async killAbruptly(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc) {
      return;
    }
    proc.kill();
    await proc.exited;
    await this.readStdoutPromise?.catch(() => {});
  }

  /** Simulates the browser closing normally: an orderly engine.retire(). */
  async shutdown(): Promise<void> {
    if (!this.proc) {
      return;
    }
    try {
      await this.call("shutdown");
    } catch {
      // The process exits as part of shutdown; a timeout/EPIPE racing that is expected.
    }
    await this.killAbruptly();
  }

  /** Simulates a browser restart: kill the process, respawn against the same on-disk state. */
  async restart(): Promise<void> {
    await this.killAbruptly();
    await this.spawn();
  }

  // Convenience wrappers over the runner's RPC surface -----------------------
  createWorkspace(name: string, color: string) {
    return this.call<{ id: string; name: string; position: number }>("createWorkspace", name, color);
  }
  createCollection(workspaceId: string, name: string, icon: string) {
    return this.call<{ id: string }>("createCollection", workspaceId, name, icon);
  }
  archiveCollection(id: string) {
    return this.call<boolean>("archiveCollection", id);
  }
  deleteWorkspace(id: string) {
    return this.call<WorkspaceActionResult>("deleteWorkspace", id);
  }
  restoreWorkspace(id: string) {
    return this.call<WorkspaceActionResult>("restoreWorkspace", id);
  }
  permanentlyDeleteWorkspace(id: string) {
    return this.call<WorkspaceActionResult>("permanentlyDeleteWorkspace", id);
  }
  forceSync() {
    return this.call<{ pushed: number; pulled: number }>("forceSync");
  }
  goOffline() {
    return this.call<boolean>("goOffline");
  }
  goOnline() {
    return this.call<boolean>("goOnline");
  }
  readAggregate(workspaceId: string) {
    return this.call<DeviceAggregate>("readAggregate", workspaceId);
  }
  readRecoverySnapshot() {
    return this.call<unknown>("readRecoverySnapshot");
  }
  readIntents() {
    return this.call<Array<{ workspaceId: string; action: string }>>("readIntents");
  }
  readCapability(serverUrl: string, userId: string) {
    return this.call<unknown>("readCapability", serverUrl, userId);
  }
  getActiveWorkspaceId() {
    return this.call<string>("getActiveWorkspaceId");
  }
  getWorkspaces() {
    return this.call<Array<{ id: string; deletedAt?: number }>>("getWorkspaces");
  }
}

// ---------------------------------------------------------------------------
// Test harness plumbing
// ---------------------------------------------------------------------------
let server: FakeSyncServer;
let workDir: string;
let deviceCounter = 0;
const activeDevices: RpcDevice[] = [];

function stateFileFor(name: string): string {
  return path.join(workDir, `${name}.json`);
}

async function makeDevice(userId: string, label = "device"): Promise<RpcDevice> {
  deviceCounter += 1;
  const device = new RpcDevice(`${label}-${deviceCounter}`, stateFileFor(`${label}-${deviceCounter}`), server.url, userId);
  await device.spawn();
  activeDevices.push(device);
  return device;
}

beforeAll(() => {
  server = new FakeSyncServer();
  server.start();
  workDir = mkdtempSync(path.join(tmpdir(), "tabslate-workspace-acceptance-"));
});

afterAll(async () => {
  for (const device of activeDevices) {
    await device.killAbruptly().catch(() => {});
  }
  server.stop();
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario: delete on one device propagates through pull to a second device,
// which switches its own active workspace away from the now-deleted one.
// ---------------------------------------------------------------------------
describe("multi-device workspace lifecycle", () => {
  test("delete on device A reaches device B through pull and switches its active workspace", async () => {
    const userId = "user-multidevice";
    const deviceA = await makeDevice(userId, "delete-a");
    const deviceB = await makeDevice(userId, "delete-b");

    const workOne = await deviceA.createWorkspace("Work", "blue");
    const workTwo = await deviceA.createWorkspace("Personal", "emerald");
    await deviceA.forceSync();

    // Device B has never synced before; this pull both discovers the two
    // workspaces and caches the lifecycle capability for (origin, user).
    await deviceB.forceSync();
    expect(await deviceB.getActiveWorkspaceId()).toBe(workOne.id);

    const deleteResult = await deviceA.deleteWorkspace(workOne.id);
    expect(deleteResult.status).toBe("queued");
    expect(await deviceA.getActiveWorkspaceId()).toBe(workTwo.id);

    await deviceA.forceSync();
    expect(await deviceA.readIntents()).toEqual([]);

    const serverWorkspace = server.userState(userId).workspaces.get(workOne.id);
    expect(serverWorkspace?.is_deleted).toBe(1);

    await deviceB.forceSync();

    // Retained-parent content still hydrates into device B's IndexedDB...
    const aggregateOnB = await deviceB.readAggregate(workOne.id);
    expect(aggregateOnB.workspace?.id).toBe(workOne.id);
    expect(aggregateOnB.workspace?.deletedAt).toBeGreaterThan(0);
    // ...but device B's own active-workspace selection moves off it, exactly
    // as device A's did locally.
    expect(await deviceB.getActiveWorkspaceId()).toBe(workTwo.id);
    const workspacesOnB = await deviceB.getWorkspaces();
    expect(workspacesOnB.map((w) => w.id).sort()).toEqual([workOne.id, workTwo.id].sort());

    await deviceA.shutdown();
    await deviceB.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Scenario: restore only touches the parent aggregate root — children keep
// exactly the lifecycle state they had before the delete/restore round trip.
// ---------------------------------------------------------------------------
describe("restore preserves child lifecycle states", () => {
  test("restoring a workspace leaves its archived collection archived and its active collection active", async () => {
    const userId = "user-restore";
    const device = await makeDevice(userId, "restore");

    const primary = await device.createWorkspace("Alpha", "blue");
    await device.createWorkspace("Beta", "violet"); // second workspace so delete isn't the last-active
    await device.forceSync();

    const activeCollection = await device.createCollection(primary.id, "Docs", "folder");
    const archivedCollection = await device.createCollection(primary.id, "Old Docs", "folder");
    await device.archiveCollection(archivedCollection.id);
    await device.forceSync();

    const beforeDelete = await device.readAggregate(primary.id);
    const beforeIds = beforeDelete.collections.map((c) => c.id);
    expect(beforeIds).toContain(activeCollection.id);
    expect(beforeIds).toContain(archivedCollection.id);

    expect((await device.deleteWorkspace(primary.id)).status).toBe("queued");
    await device.forceSync();
    expect(server.userState(userId).workspaces.get(primary.id)?.is_deleted).toBe(1);

    expect((await device.restoreWorkspace(primary.id)).status).toBe("queued");
    await device.forceSync();
    expect(server.userState(userId).workspaces.get(primary.id)?.is_deleted).toBe(0);
    expect(await device.readIntents()).toEqual([]);

    const after = await device.readAggregate(primary.id);
    expect(after.workspace?.id).toBe(primary.id);
    expect(after.workspace?.deletedAt).toBeUndefined();
    const afterIds = after.collections.map((c) => c.id);
    expect(afterIds).toContain(activeCollection.id);
    expect(afterIds).toContain(archivedCollection.id);
    const restoredActive = after.collections.find((c) => c.id === activeCollection.id);
    const restoredArchived = after.collections.find((c) => c.id === archivedCollection.id);
    expect(restoredActive?.deletedAt).toBeUndefined();
    expect(restoredActive?.archivedAt).toBeUndefined();
    // The parent's restore must not have un-archived a child that was archived
    // independently — child lifecycle state is preserved exactly.
    expect(restoredArchived?.archivedAt).toBeGreaterThan(0);

    await device.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Scenario: permanent delete is server-confirmed and then wipes every local
// aggregate record — workspace, collections, and bookmarks together.
// ---------------------------------------------------------------------------
describe("purge performs complete local cleanup", () => {
  test("permanentlyDeleteWorkspace clears the entire local aggregate once the server confirms", async () => {
    const userId = "user-purge";
    const device = await makeDevice(userId, "purge");

    const primary = await device.createWorkspace("ToPurge", "rose");
    await device.createWorkspace("Keep", "amber");
    await device.forceSync();

    const collection = await device.createCollection(primary.id, "Docs", "folder");
    await device.forceSync();

    expect((await device.deleteWorkspace(primary.id)).status).toBe("queued");
    await device.forceSync();
    expect(server.userState(userId).workspaces.get(primary.id)?.is_deleted).toBe(1);

    const purgeResult = await device.permanentlyDeleteWorkspace(primary.id);
    expect(purgeResult.status).toBe("completed");

    expect(server.userState(userId).workspaces.get(primary.id)?.is_deleted).toBe(2);

    const aggregate = await device.readAggregate(primary.id);
    expect(aggregate.workspace).toBeUndefined();
    expect(aggregate.collections).toEqual([]);
    const remainingIds = (await device.getWorkspaces()).map((w) => w.id);
    expect(remainingIds).not.toContain(primary.id);
    expect(remainingIds).not.toContain(collection.id);

    await device.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Scenario: a delete intent left pending by an interruption (offline before
// the browser closed) is resolved once the device restarts and reconnects.
// ---------------------------------------------------------------------------
describe("restart resolves a pending lifecycle intent", () => {
  test("a delete committed while offline survives an abrupt restart and resolves once back online", async () => {
    const userId = "user-restart";
    const device = await makeDevice(userId, "restart");

    const primary = await device.createWorkspace("Restart", "cyan");
    await device.createWorkspace("Other", "orange");
    await device.forceSync(); // caches lifecycle capability, needed before deleteWorkspace can commit an intent

    await device.goOffline();
    const deleteResult = await device.deleteWorkspace(primary.id);
    expect(deleteResult.status).toBe("queued");

    const intentsBeforeRestart = await device.readIntents();
    expect(intentsBeforeRestart).toEqual([{
      workspaceId: primary.id,
      action: "delete",
      baseSeq: expect.any(Number),
      previousActiveWorkspaceId: expect.any(String),
      createdAt: expect.any(Number),
    }]);
    // Not yet confirmed server-side — the interruption happened before the
    // delete could sync, so the server still shows the workspace active.
    expect(server.userState(userId).workspaces.get(primary.id)?.is_deleted).toBe(0);

    // Abrupt restart: kill the process without an orderly shutdown/forceSync,
    // then respawn against the same on-disk IndexedDB state file.
    await device.restart();

    // Durable state survived the restart even though the in-memory engine did not.
    expect(await device.readIntents()).toEqual(intentsBeforeRestart);

    await device.forceSync();

    expect(await device.readIntents()).toEqual([]);
    const serverWorkspace = server.userState(userId).workspaces.get(primary.id);
    expect(serverWorkspace?.is_deleted).toBe(1);
    const aggregate = await device.readAggregate(primary.id);
    expect(aggregate.workspace?.deletedAt).toBeGreaterThan(0);

    await device.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Scenario: the workspace-lifecycle capability cache is scoped to exactly
// (server origin, user id) — it must not leak across accounts sharing a
// browser, or across servers sharing an account.
// ---------------------------------------------------------------------------
describe("lifecycle capability cache is scoped to user and origin", () => {
  test("capability observed for one user/origin pair is not visible for another user or another origin", async () => {
    const userId = "user-capability-1";
    const otherUserId = "user-capability-2";
    const device = await makeDevice(userId, "capability");

    await device.forceSync(); // any pull is enough to observe + cache the capability

    const ownCapability = await device.readCapability(server.url, userId);
    expect(ownCapability).toBeDefined();

    const otherUserCapability = await device.readCapability(server.url, otherUserId);
    expect(otherUserCapability).toBeUndefined();

    const otherOriginCapability = await device.readCapability("https://different-server.example", userId);
    expect(otherOriginCapability).toBeUndefined();

    await device.shutdown();
  });
});
