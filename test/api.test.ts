// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SyncPullResponse, SyncPushPayload } from "@/lib/api";

const { api, isKnownSyncRejectionReason } = await import(
  `../lib/api.ts?workspace-lifecycle=${Date.now()}-${Math.random()}`
);

interface FetchCall {
  input: string | URL | Request;
  init?: RequestInit;
}

const fetchCalls: FetchCall[] = [];
const responseBodies: object[] = [];

beforeEach(() => {
  fetchCalls.length = 0;
  responseBodies.length = 0;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    const body = responseBodies.shift();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

function emptyPushPayload(): SyncPushPayload {
  return {
    entities: {
      workspaces: [],
      collections: [],
      bookmarks: [],
      tags: [],
      groups: [],
    },
  };
}

describe("workspace lifecycle API DTOs", () => {
  test("syncPush injects protocol version 2 and preserves only explicit lifecycle actions", async () => {
    responseBodies.push(
      { server_seq: 8, rejected: [] },
      { server_seq: 9, rejected: [] },
    );
    const lifecyclePayload = emptyPushPayload();
    lifecyclePayload.entities.workspaces.push({
      id: "workspace-delete",
      lifecycle_action: "delete",
    });
    const ordinaryPayload = emptyPushPayload();
    ordinaryPayload.entities.workspaces.push({ id: "workspace-update", name: "Renamed" });

    await api.syncPush("https://sync.example.test/", "token", lifecyclePayload);
    await api.syncPush("https://sync.example.test/", "token", ordinaryPayload);

    const lifecycleBody = JSON.parse(String(fetchCalls[0]?.init?.body));
    const ordinaryBody = JSON.parse(String(fetchCalls[1]?.init?.body));
    expect(lifecycleBody.protocol_version).toBe(2);
    expect(lifecycleBody.entities.workspaces[0].lifecycle_action).toBe("delete");
    expect(ordinaryBody.protocol_version).toBe(2);
    expect("lifecycle_action" in ordinaryBody.entities.workspaces[0]).toBe(false);
  });

  test("syncPull retains v2 state and capability fields", async () => {
    responseBodies.push({
      entities: {
        workspaces: [{
          id: "workspace-terminal",
          user_id: "user-a",
          name: "Terminal",
          icon: null,
          color: null,
          position: 4,
          seq: 12,
          deleted_at: 9000,
          is_deleted: 2,
          deletion_model: 1,
          created_at: 100,
          updated_at: 9000,
        }],
        collections: [],
        bookmarks: [],
        tags: [],
        groups: [],
      },
      server_seq: 12,
      capabilities: { workspace_parent_tombstone: true },
    });

    const response: SyncPullResponse = await api.syncPull(
      "https://sync.example.test",
      "token",
      0,
    );

    expect(response.entities.workspaces[0]?.is_deleted).toBe(2);
    expect(response.entities.workspaces[0]?.deletion_model).toBe(1);
    expect(response.capabilities?.workspace_parent_tombstone).toBe(true);
  });

  test("syncPull normalizes lifecycle fields omitted by an older server", async () => {
    responseBodies.push({
      entities: {
        workspaces: [
          {
            id: "workspace-active",
            user_id: "user-a",
            name: "Active",
            color: "blue",
            position: 1,
            seq: 3,
            created_at: 100,
            updated_at: 200,
          },
          {
            id: "workspace-legacy-deleted",
            user_id: "user-a",
            name: "Legacy deleted",
            color: "red",
            position: 2,
            seq: 4,
            deleted_at: 500,
            created_at: 100,
            updated_at: 500,
          },
        ],
        collections: [],
        bookmarks: [],
        tags: [],
        groups: [],
      },
      server_seq: 4,
    });

    const response: SyncPullResponse = await api.syncPull(
      "https://old-sync.example.test",
      "token",
      0,
    );

    expect(response.entities.workspaces.map((workspace) => ({
      id: workspace.id,
      isDeleted: workspace.is_deleted,
      deletionModel: workspace.deletion_model,
    }))).toEqual([
      { id: "workspace-active", isDeleted: 0, deletionModel: 1 },
      { id: "workspace-legacy-deleted", isDeleted: 1, deletionModel: 0 },
    ]);
    expect(response.capabilities).toBeUndefined();
  });

  test("getPlan decodes trash usage while accepting an older omitted field", async () => {
    const basePlan = {
      subscription: { plan: "free", status: "active", expires_at: null },
      limits: {
        max_workspaces: 3,
        max_bookmarks: 100,
        max_collections: 20,
        max_tags: 20,
        max_saved_groups: 10,
        trash_grace_days: 30,
      },
      usage: { workspaces: 2, bookmarks: 5, collections: 4, tags: 1, saved_groups: 2 },
    };
    responseBodies.push({
      ...basePlan,
      trash_usage: { workspaces: 1, bookmarks: 2, collections: 1, tags: 0, saved_groups: 1 },
    });
    responseBodies.push(basePlan);

    const current = await api.getPlan("https://sync.example.test", "token");
    const legacy = await api.getPlan("https://old-sync.example.test", "token");

    expect(current.trash_usage).toEqual({
      workspaces: 1,
      bookmarks: 2,
      collections: 1,
      tags: 0,
      saved_groups: 1,
    });
    expect(legacy.trash_usage).toBeUndefined();
  });

  test("recognizes every structured workspace lifecycle rejection reason", () => {
    expect([
      "last_active_workspace",
      "workspace_deleted",
      "parent_deleted",
      "permanently_deleted",
    ].every(isKnownSyncRejectionReason)).toBe(true);
  });
});
