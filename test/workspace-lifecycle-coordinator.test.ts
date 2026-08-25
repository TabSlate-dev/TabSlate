// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import type { SyncPushPayload } from "../lib/api";
import {
  reconcileWorkspaceLifecycleIntents,
  workspaceHasPendingDeleteIntent,
} from "../lib/workspace-lifecycle-coordinator";

function emptyPayload(): SyncPushPayload {
  return {
    entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("Workspace lifecycle coordinator", () => {
  test("a pending deleted Guest root is reserved for lifecycle reconciliation", () => {
    expect(workspaceHasPendingDeleteIntent([{
      workspaceId: "guest-delete",
      action: "delete",
      baseSeq: 0,
      previousActiveWorkspaceId: "account-workspace",
      createdAt: 1,
    }], "guest-delete")).toBe(true);
    expect(workspaceHasPendingDeleteIntent([{
      workspaceId: "guest-delete",
      action: "restore",
      baseSeq: 0,
      previousActiveWorkspaceId: "account-workspace",
      createdAt: 1,
    }], "guest-delete")).toBe(false);
  });

  test("confirms every accepted delete phase before starting its dependent phase", async () => {
    const confirmations = [deferred(), deferred(), deferred(), deferred()];
    const events: string[] = [];
    let pushIndex = 0;
    const reconciling = reconcileWorkspaceLifecycleIntents({
      context: {
        async pullConfirmed() { throw new Error("unexpected pull"); },
        async pushConfirmed(payload) {
          const phase = payload.entities.workspaces[0]?.lifecycle_action ??
            (payload.entities.workspaces.length > 0 ? "root" :
              payload.entities.collections.length + payload.entities.groups.length > 0 ? "children" : "bookmarks");
          events.push(`push:${phase}`);
          pushIndex += 1;
          return { server_seq: pushIndex, rejected: [] };
        },
        async captureDeferredEntities() { events.push("capture"); },
        blockEntities() {},
        async pruneEntities() {},
        isCurrent: () => true,
      },
      userId: "user-1",
      serverOrigin: "https://sync.example",
      authoritativeWorkspaces: [],
      async reportConflict() {},
      notify() {},
      services: {
        async readIntents() {
          return [{
            workspaceId: "workspace-offline",
            action: "delete",
            baseSeq: 0,
            previousActiveWorkspaceId: "workspace-other",
            createdAt: 10,
          }];
        },
        async loadAggregatePayload() {
          return {
            references: [
              { entityType: "workspace", entityId: "workspace-offline" },
              { entityType: "collection", entityId: "collection-1" },
              { entityType: "saved_group", entityId: "group-1" },
              { entityType: "bookmark", entityId: "bookmark-1" },
            ],
            activeWorkspacePayload: {
              ...emptyPayload(),
              entities: { ...emptyPayload().entities, workspaces: [{ id: "workspace-offline", name: "Offline" }] },
            },
            collectionsAndGroupsPayload: {
              ...emptyPayload(),
              entities: {
                ...emptyPayload().entities,
                collections: [{ id: "collection-1", workspace_id: "workspace-offline" }],
                groups: [{ id: "group-1", workspace_id: "workspace-offline" }],
              },
            },
            bookmarksPayload: {
              ...emptyPayload(),
              entities: {
                ...emptyPayload().entities,
                bookmarks: [{ id: "bookmark-1", collection_id: "collection-1" }],
              },
            },
          };
        },
        async confirmPayload(_payload, serverSeq) {
          events.push(`confirm:${serverSeq}:start`);
          await confirmations[serverSeq - 1]?.promise;
          events.push(`confirm:${serverSeq}:end`);
        },
      },
    });

    await flush();
    expect(events).toEqual(["capture", "push:root", "confirm:1:start"]);
    confirmations[0].resolve();
    await flush();
    expect(events).toContain("push:children");
    expect(events.indexOf("confirm:1:end")).toBeLessThan(events.indexOf("push:children"));
    confirmations[1].resolve();
    await flush();
    expect(events.indexOf("confirm:2:end")).toBeLessThan(events.indexOf("push:bookmarks"));
    confirmations[2].resolve();
    await flush();
    expect(events.indexOf("confirm:3:end")).toBeLessThan(events.indexOf("push:delete"));
    confirmations[3].resolve();
    await reconciling;
    expect(events.at(-1)).toBe("confirm:4:end");
  });

  test("a rejected child phase preserves the intent and never sends the parent delete", async () => {
    const pushedActions: string[] = [];
    const conflicts: string[] = [];
    let calls = 0;
    await reconcileWorkspaceLifecycleIntents({
      context: {
        async pullConfirmed() { throw new Error("unexpected pull"); },
        async pushConfirmed(payload) {
          pushedActions.push(payload.entities.workspaces[0]?.lifecycle_action ??
            (payload.entities.workspaces.length > 0 ? "root" : "children"));
          calls += 1;
          return calls === 2
            ? { server_seq: 12, rejected: [{ id: "collection-1", type: "collection", reason: "quota_exceeded" }] }
            : { server_seq: 11, rejected: [] };
        },
        async captureDeferredEntities() {},
        blockEntities() {},
        async pruneEntities() {},
        isCurrent: () => true,
      },
      userId: "user-1",
      serverOrigin: "https://sync.example",
      authoritativeWorkspaces: [],
      async reportConflict(conflict) { conflicts.push(`${conflict.entityType}:${conflict.reason}`); },
      notify() {},
      services: {
        async readIntents() {
          return [{ workspaceId: "workspace-1", action: "delete", baseSeq: 0, previousActiveWorkspaceId: "workspace-2", createdAt: 1 }];
        },
        async loadAggregatePayload() {
          return {
            references: [{ entityType: "collection", entityId: "collection-1" }],
            activeWorkspacePayload: { ...emptyPayload(), entities: { ...emptyPayload().entities, workspaces: [{ id: "workspace-1" }] } },
            collectionsAndGroupsPayload: { ...emptyPayload(), entities: { ...emptyPayload().entities, collections: [{ id: "collection-1" }] } },
            bookmarksPayload: emptyPayload(),
          };
        },
        async confirmPayload() {},
      },
    });

    expect(pushedActions).toEqual(["root", "children"]);
    expect(conflicts).toContain("workspace:quota_exceeded");
  });

  test("restores the root before deferred descendants and clears their conflict tree last", async () => {
    const events: string[] = [];
    await reconcileWorkspaceLifecycleIntents({
      context: {
        async pullConfirmed() { throw new Error("unexpected pull"); },
        async pushConfirmed(payload) {
          const phase = payload.entities.workspaces[0]?.lifecycle_action ??
            (payload.entities.collections.length > 0 ? "children" : "bookmarks");
          events.push(`push:${phase}`);
          return { server_seq: events.length, rejected: [] };
        },
        async captureDeferredEntities() {},
        blockEntities() {},
        async pruneEntities() {},
        isCurrent: () => true,
      },
      userId: "user-1",
      serverOrigin: "https://sync.example",
      authoritativeWorkspaces: [{
        id: "workspace-restore",
        user_id: "user-1",
        name: "Restore",
        color: "blue",
        position: 1,
        seq: 8,
        is_deleted: 1,
        deletion_model: 1,
        deleted_at: 5,
        created_at: 1,
        updated_at: 5,
      }],
      async reportConflict() {},
      notify() {},
      services: {
        async readIntents() {
          return [{ workspaceId: "workspace-restore", action: "restore", baseSeq: 8, previousActiveWorkspaceId: "workspace-other", createdAt: 9 }];
        },
        async loadAggregatePayload() {
          return {
            references: [],
            activeWorkspacePayload: { ...emptyPayload(), entities: { ...emptyPayload().entities, workspaces: [{ id: "workspace-restore", name: "Restore", color: "blue", position: 1 }] } },
            collectionsAndGroupsPayload: { ...emptyPayload(), entities: { ...emptyPayload().entities, collections: [{ id: "collection-restore" }] } },
            bookmarksPayload: { ...emptyPayload(), entities: { ...emptyPayload().entities, bookmarks: [{ id: "bookmark-restore" }] } },
          };
        },
        async confirmPayload(_payload, serverSeq) { events.push(`confirm:${serverSeq}`); },
        async completeIntent() { events.push("complete"); },
        async clearConflictTree() { events.push("clear-conflicts"); },
      },
    });

    expect(events).toEqual([
      "push:restore", "confirm:1",
      "push:children", "confirm:3",
      "push:bookmarks", "confirm:5",
      "complete", "clear-conflicts",
    ]);
  });
});
