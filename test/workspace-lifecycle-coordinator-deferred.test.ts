// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkspaceLifecycleStateStorage, WorkspaceLifecycleStoredRecord } from "@/lib/workspace-lifecycle-state";
import type { SyncPushPayload } from "@/lib/api";
import { hasDeferred } from "@/lib/workspace-lifecycle-coordinator";
import { mergeWorkspaceLifecycleDeferredPayload } from "@/lib/workspace-lifecycle-state";

// An injected in-memory storage, matching the DI pattern every sibling
// function in workspace-lifecycle-state.ts already uses — avoids the
// cross-file `mock.module("@/lib/idb", ...)` collisions that plague this
// shared Bun test process (many other files mock that same specifier).
const records = new Map<string, WorkspaceLifecycleStoredRecord>();
const storage: WorkspaceLifecycleStateStorage = {
  async read(key) {
    return records.get(key);
  },
  async write(key, value) {
    records.set(key, structuredClone(value));
  },
  async remove(key) {
    records.delete(key);
  },
  async update(key, mutate) {
    const next = mutate(records.get(key));
    if (next) {
      records.set(key, structuredClone(next));
      return;
    }
    records.delete(key);
  },
};

function emptyPayload(): SyncPushPayload {
  return { entities: { workspaces: [], collections: [], bookmarks: [], tags: [], groups: [] } };
}

describe("hasDeferred", () => {
  beforeEach(() => {
    records.clear();
  });

  test("returns false when nothing was ever captured for the workspace", async () => {
    expect(await hasDeferred("workspace-a", storage)).toBe(false);
  });

  test("returns false for a captured entry whose merged payload is empty", async () => {
    // The normal case for a freshly deleted workspace with nothing pending
    // in the live/recovery queues: captureDeferredEntities still writes a
    // key, but with no entities inside it.
    await mergeWorkspaceLifecycleDeferredPayload("workspace-a", emptyPayload(), storage);
    expect(await hasDeferred("workspace-a", storage)).toBe(false);
  });

  test("returns true once the merged payload actually holds an entity", async () => {
    const payload = emptyPayload();
    payload.entities.collections.push({
      id: "collection-a", workspaceId: "workspace-a", name: "Collection", icon: "folder", position: 0, seq: 0,
    });
    await mergeWorkspaceLifecycleDeferredPayload("workspace-a", payload, storage);
    expect(await hasDeferred("workspace-a", storage)).toBe(true);
  });

  test("does not leak an empty entry into a different workspace's check", async () => {
    await mergeWorkspaceLifecycleDeferredPayload("workspace-empty", emptyPayload(), storage);
    const payload = emptyPayload();
    payload.entities.tags.push({ id: "tag-a", name: "Tag", color: "blue", seq: 0 });
    await mergeWorkspaceLifecycleDeferredPayload("workspace-nonempty", payload, storage);

    expect(await hasDeferred("workspace-empty", storage)).toBe(false);
    expect(await hasDeferred("workspace-nonempty", storage)).toBe(true);
  });
});
