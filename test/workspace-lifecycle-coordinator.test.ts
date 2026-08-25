// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import type { SyncPushPayload } from "../lib/api";
import {
  buildWorkspaceLifecycleAggregatePayload,
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
  test("keeps every deferred tag and refreshes referenced unsynced tags in the child phase", () => {
    const deferred = emptyPayload();
    deferred.entities.tags.push(
      { id: "tag-current", name: "Old", color: "old", seq: 0 },
      { id: "tag-deferred-only", name: "Deferred", color: "gray", seq: 0 },
    );
    const aggregate = buildWorkspaceLifecycleAggregatePayload("workspace-tags", {
      workspace: {
        id: "workspace-tags",
        name: "Tags",
        color: "blue",
        position: 0,
        seq: 0,
        deletedAt: 10,
      },
      collections: [{
        id: "collection-tags",
        workspaceId: "workspace-tags",
        name: "Tags",
        icon: "folder",
        position: 0,
        seq: 0,
      }],
      activeBookmarks: [{
        id: "bookmark-tags",
        title: "Tagged",
        url: "https://example.com",
        description: "",
        favicon: "",
        collectionId: "collection-tags",
        tags: ["tag-current"],
        createdAt: "2026-08-25T00:00:00.000Z",
        isFavorite: false,
        seq: 0,
      }],
      archivedBookmarks: [],
      trashedBookmarks: [],
      tags: [{ id: "tag-current", name: "Current", color: "blue", seq: 0 }],
      groups: [],
      groupTabs: [],
      deferred,
    });

    expect(aggregate.collectionsAndGroupsPayload.entities.tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
    }))).toEqual([
      { id: "tag-current", name: "Current" },
      { id: "tag-deferred-only", name: "Deferred" },
    ]);
    expect(aggregate.references).toContainEqual({
      entityType: "tag",
      entityId: "tag-deferred-only",
    });
  });

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

  test("reconciles the lifecycle action and authoritative root-state matrix", async () => {
    const scenarios = [
      { name: "delete-active", action: "delete", baseSeq: 5, state: 0, expected: ["capture", "push:root", "confirm", "push:delete", "confirm"] },
      { name: "delete-deleted", action: "delete", baseSeq: 5, state: 1, expected: ["remove-intent"] },
      { name: "delete-terminal", action: "delete", baseSeq: 5, state: 2, expected: ["clean-terminal"] },
      { name: "delete-local", action: "delete", baseSeq: 0, state: undefined, expected: ["capture", "push:root", "confirm", "push:delete", "confirm"] },
      { name: "restore-active", action: "restore", baseSeq: 5, state: 0, expected: ["complete", "clear-conflicts"] },
      { name: "restore-deleted", action: "restore", baseSeq: 5, state: 1, expected: ["push:restore", "confirm", "complete", "clear-conflicts"] },
      { name: "restore-terminal", action: "restore", baseSeq: 5, state: 2, expected: ["clean-terminal"] },
      { name: "restore-local", action: "restore", baseSeq: 0, state: undefined, expected: ["push:root", "confirm", "complete", "clear-conflicts"] },
    ] as const;

    for (const scenario of scenarios) {
      const events: string[] = [];
      const authoritativeWorkspaces = scenario.state === undefined ? [] : [{
        id: "workspace-matrix",
        user_id: "user-1",
        name: "Matrix",
        color: "blue",
        position: 0,
        seq: 5,
        is_deleted: scenario.state,
        deletion_model: 1 as const,
        deleted_at: scenario.state === 0 ? undefined : 5,
        created_at: 1,
        updated_at: 5,
      }];
      await reconcileWorkspaceLifecycleIntents({
        context: {
          async pullConfirmed() { throw new Error("unexpected pull"); },
          async pushConfirmed(payload) {
            events.push(`push:${payload.entities.workspaces[0]?.lifecycle_action ?? "root"}`);
            return { server_seq: 9, rejected: [] };
          },
          async captureDeferredEntities() { events.push("capture"); },
          blockEntities() {},
          async pruneEntities() {},
          isCurrent: () => true,
        },
        userId: "user-1",
        serverOrigin: "https://sync.example",
        authoritativeWorkspaces,
        authoritativeFullPull: true,
        async reportConflict() {},
        notify() {},
        services: {
          async readIntents() {
            return [{
              workspaceId: "workspace-matrix",
              action: scenario.action,
              baseSeq: scenario.baseSeq,
              previousActiveWorkspaceId: "workspace-other",
              createdAt: 1,
            }];
          },
          async loadAggregatePayload() {
            return {
              references: [{ entityType: "workspace", entityId: "workspace-matrix" }],
              activeWorkspacePayload: {
                ...emptyPayload(),
                entities: {
                  ...emptyPayload().entities,
                  workspaces: [{ id: "workspace-matrix", name: "Matrix" }],
                },
              },
              collectionsAndGroupsPayload: emptyPayload(),
              bookmarksPayload: emptyPayload(),
            };
          },
          async confirmPayload() { events.push("confirm"); },
          async hasDeferred() { return false; },
          async removeIntent() { events.push("remove-intent"); },
          async completeIntent() { events.push("complete"); },
          async cleanTerminal() { events.push("clean-terminal"); },
          async clearConflictTree() { events.push("clear-conflicts"); },
        },
      });
      expect([scenario.name, ...events]).toEqual([scenario.name, ...scenario.expected]);
    }
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
      authoritativeFullPull: true,
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
      authoritativeFullPull: true,
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

  test("a rejected deferred tag remains unconfirmed and blocks the parent delete", async () => {
    const pushed: string[] = [];
    const confirmed: string[] = [];
    await reconcileWorkspaceLifecycleIntents({
      context: {
        async pullConfirmed() { throw new Error("unexpected pull"); },
        async pushConfirmed(payload) {
          const tag = payload.entities.tags[0];
          pushed.push(tag ? `tag:${tag.id}` :
            (payload.entities.workspaces[0]?.lifecycle_action ?? "root"));
          return tag
            ? {
                server_seq: 2,
                rejected: [{ id: tag.id, type: "tag", reason: "quota_exceeded" }],
              }
            : { server_seq: 1, rejected: [] };
        },
        async captureDeferredEntities() {},
        blockEntities() {},
        async pruneEntities() {},
        isCurrent: () => true,
      },
      userId: "user-1",
      serverOrigin: "https://sync.example",
      authoritativeWorkspaces: [],
      authoritativeFullPull: true,
      async reportConflict() {},
      notify() {},
      services: {
        async readIntents() {
          return [{
            workspaceId: "workspace-tag-rejection",
            action: "delete",
            baseSeq: 0,
            previousActiveWorkspaceId: "workspace-other",
            createdAt: 1,
          }];
        },
        async loadAggregatePayload() {
          return {
            references: [
              { entityType: "workspace", entityId: "workspace-tag-rejection" },
              { entityType: "tag", entityId: "tag-rejected" },
            ],
            activeWorkspacePayload: {
              ...emptyPayload(),
              entities: {
                ...emptyPayload().entities,
                workspaces: [{ id: "workspace-tag-rejection", name: "Tags" }],
              },
            },
            collectionsAndGroupsPayload: {
              ...emptyPayload(),
              entities: {
                ...emptyPayload().entities,
                tags: [{ id: "tag-rejected", name: "Deferred", color: "blue" }],
              },
            },
            bookmarksPayload: emptyPayload(),
          };
        },
        async confirmPayload(payload) {
          confirmed.push(payload.entities.tags[0]?.id ?? "root");
        },
      },
    });

    expect(pushed).toEqual(["root", "tag:tag-rejected"]);
    expect(confirmed).toEqual(["root"]);
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
      authoritativeFullPull: true,
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

  test("does not classify a confirmed root omitted from an ordinary delta as terminal", async () => {
    const events: string[] = [];
    await reconcileWorkspaceLifecycleIntents({
      context: {
        async pullConfirmed() { throw new Error("unexpected pull"); },
        async pushConfirmed() { events.push("push"); return { server_seq: 10, rejected: [] }; },
        async captureDeferredEntities() { events.push("capture"); },
        blockEntities() {},
        async pruneEntities() {},
        isCurrent: () => true,
      },
      userId: "user-1",
      serverOrigin: "https://sync.example",
      authoritativeWorkspaces: [],
      authoritativeFullPull: false,
      async reportConflict(conflict) { events.push(`conflict:${conflict.reason}`); },
      notify() {},
      services: {
        async readIntents() {
          return [{
            workspaceId: "workspace-delta-omission",
            action: "delete",
            baseSeq: 9,
            previousActiveWorkspaceId: "workspace-other",
            createdAt: 1,
          }];
        },
        async loadAggregatePayload() {
          events.push("load");
          return {
            references: [{ entityType: "workspace", entityId: "workspace-delta-omission" }],
            activeWorkspacePayload: emptyPayload(),
            collectionsAndGroupsPayload: emptyPayload(),
            bookmarksPayload: emptyPayload(),
          };
        },
      },
    });

    expect(events).toEqual([]);
  });

  test("classifies a confirmed root omitted from an authoritative full pull as terminal", async () => {
    const events: string[] = [];
    await reconcileWorkspaceLifecycleIntents({
      context: {
        async pullConfirmed() { throw new Error("unexpected pull"); },
        async pushConfirmed() { throw new Error("unexpected push"); },
        async captureDeferredEntities() { events.push("capture"); },
        blockEntities() {},
        async pruneEntities() {},
        isCurrent: () => true,
      },
      userId: "user-1",
      serverOrigin: "https://sync.example",
      authoritativeWorkspaces: [],
      authoritativeFullPull: true,
      async reportConflict(conflict) { events.push(`conflict:${conflict.reason}`); },
      notify() {},
      services: {
        async readIntents() {
          return [{
            workspaceId: "workspace-full-omission",
            action: "restore",
            baseSeq: 9,
            previousActiveWorkspaceId: "workspace-other",
            createdAt: 1,
          }];
        },
        async loadAggregatePayload() {
          return {
            references: [{ entityType: "workspace", entityId: "workspace-full-omission" }],
            activeWorkspacePayload: emptyPayload(),
            collectionsAndGroupsPayload: emptyPayload(),
            bookmarksPayload: emptyPayload(),
          };
        },
      },
    });

    expect(events).toEqual(["capture", "conflict:permanently_deleted"]);
  });
});
