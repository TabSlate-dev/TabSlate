// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import type { Collection, Workspace } from "@/lib/types";
import {
  belongsToActiveWorkspace,
  getActiveWorkspaceCollectionIds,
  getCollectionsUnderActiveWorkspace,
  purgeTargetsRemainVisible,
  resolveActiveWorkspaceCollectionTarget,
  type PurgeVisibilityInput,
} from "@/lib/workspace-visibility";

function workspace(id: string, deletedAt?: number): Workspace {
  return {
    id,
    name: id,
    color: "blue",
    position: 0,
    seq: 1,
    deletedAt,
  };
}

function collection(
  id: string,
  workspaceId: string,
  lifecycle: Pick<Collection, "deletedAt" | "archivedAt"> = {},
  isDefault = false,
): Collection {
  return {
    id,
    workspaceId,
    name: id,
    icon: "folder",
    position: isDefault ? 0 : 10,
    isDefault,
    seq: 1,
    ...lifecycle,
  };
}

describe("active-parent Workspace visibility", () => {
  test("a retained parent hides active, favorite, archived, and trashed descendants", () => {
    const workspaces = [
      workspace("active"),
      workspace("retained", Date.UTC(2026, 7, 20)),
    ];
    const collections = [
      collection("active-default", "active", {}, true),
      collection("retained-active", "retained"),
      collection("retained-archived", "retained", { archivedAt: 10 }),
      collection("retained-trashed", "retained", { deletedAt: 20 }),
    ];

    const activeIds = getActiveWorkspaceCollectionIds(
      "retained",
      workspaces,
      collections,
    );
    const scopedIds = new Set(
      getCollectionsUnderActiveWorkspace("retained", workspaces, collections)
        .map((candidate) => candidate.id),
    );

    expect(Array.from(activeIds)).toEqual([]);
    expect(Array.from(scopedIds)).toEqual([]);
    expect(belongsToActiveWorkspace("retained-active", activeIds)).toBe(false);
    expect(belongsToActiveWorkspace("retained-archived", scopedIds)).toBe(false);
    expect(belongsToActiveWorkspace("retained-trashed", scopedIds)).toBe(false);
  });

  test("an unresolved parent never falls back into the current Workspace trash", () => {
    const workspaces = [workspace("active")];
    const collections = [
      collection("active-default", "active", {}, true),
      collection("orphan-trash", "missing-parent", { deletedAt: 20 }),
    ];

    const scopedIds = new Set(
      getCollectionsUnderActiveWorkspace("active", workspaces, collections)
        .map((candidate) => candidate.id),
    );

    expect(Array.from(scopedIds)).toEqual(["active-default"]);
    expect(belongsToActiveWorkspace("orphan-trash", scopedIds)).toBe(false);
  });
});

describe("active Workspace mutation targets", () => {
  test("dialogs and popup cannot keep a stale Collection under a retained Workspace", () => {
    const workspaces = [
      workspace("active"),
      workspace("retained", Date.UTC(2026, 7, 20)),
    ];
    const collections = [
      collection("active-default", "active", {}, true),
      collection("active-newest", "active"),
      collection("retained-target", "retained"),
    ];

    expect(resolveActiveWorkspaceCollectionTarget(
      "retained-target",
      "active",
      workspaces,
      collections,
    )).toBeUndefined();
  });

  test("target refresh preserves Default-first and position-descending ordering", () => {
    const workspaces = [workspace("active")];
    const collections = [
      { ...collection("older", "active"), position: 1 },
      { ...collection("default", "active", {}, true), position: 0 },
      { ...collection("newest", "active"), position: 20 },
      collection("archived", "active", { archivedAt: 10 }),
    ];

    expect(Array.from(getActiveWorkspaceCollectionIds(
      "active",
      workspaces,
      collections,
    ))).toEqual(["default", "newest", "older"]);
    expect(resolveActiveWorkspaceCollectionTarget(
      "newest",
      "active",
      workspaces,
      collections,
    )?.id).toBe("newest");
    expect(resolveActiveWorkspaceCollectionTarget(
      "archived",
      "active",
      workspaces,
      collections,
    )).toBeUndefined();
  });
});

describe("purge target revalidation", () => {
  // Models the window between opening a confirm dialog and clicking Confirm,
  // during which a remote pull can retire the parent workspace.
  function scene(activeWorkspaceId: string, retainedAt?: number): PurgeVisibilityInput {
    return {
      activeWorkspaceId,
      workspaces: [workspace("ws-a"), workspace("ws-b", retainedAt)],
      collections: [
        collection("col-a", "ws-a", { deletedAt: Date.UTC(2026, 7, 1) }),
        collection("col-b", "ws-b", { deletedAt: Date.UTC(2026, 7, 1) }),
      ],
      groups: [
        { id: "grp-a", workspaceId: "ws-a" },
        { id: "grp-b", workspaceId: "ws-b" },
      ],
      groupTabs: [
        { id: "tab-a", groupId: "grp-a" },
        { id: "tab-b", groupId: "grp-b" },
      ],
      trashedBookmarks: [
        { id: "bm-a", collectionId: "col-a" },
        { id: "bm-b", collectionId: "col-b" },
        { id: "bm-uncategorized", collectionId: "" },
      ],
    };
  }

  test("accepts targets that still belong to the active workspace", () => {
    expect(purgeTargetsRemainVisible(scene("ws-a"), {
      collectionIds: ["col-a"],
      groupIds: ["grp-a"],
      bookmarkIds: ["bm-a"],
      tabIds: ["tab-a"],
    })).toBe(true);
  });

  test("rejects a collection, group, tab, or bookmark under another workspace", () => {
    const input = scene("ws-a");
    expect(purgeTargetsRemainVisible(input, { collectionIds: ["col-b"] })).toBe(false);
    expect(purgeTargetsRemainVisible(input, { groupIds: ["grp-b"] })).toBe(false);
    expect(purgeTargetsRemainVisible(input, { tabIds: ["tab-b"] })).toBe(false);
    expect(purgeTargetsRemainVisible(input, { bookmarkIds: ["bm-b"] })).toBe(false);
  });

  test("rejects every target once the active workspace itself is retired mid-dialog", () => {
    // Captured while ws-b was active; a pull then soft-deleted ws-b.
    const retired = scene("ws-b", Date.UTC(2026, 7, 25));
    expect(purgeTargetsRemainVisible(retired, { collectionIds: ["col-b"] })).toBe(false);
    expect(purgeTargetsRemainVisible(retired, { groupIds: ["grp-b"] })).toBe(false);
    expect(purgeTargetsRemainVisible(retired, { bookmarkIds: ["bm-b"] })).toBe(false);
  });

  test("keeps uncategorized bookmarks purgeable and rejects vanished ids", () => {
    const input = scene("ws-a");
    expect(purgeTargetsRemainVisible(input, { bookmarkIds: ["bm-uncategorized"] })).toBe(true);
    expect(purgeTargetsRemainVisible(input, { bookmarkIds: ["bm-gone"] })).toBe(false);
    expect(purgeTargetsRemainVisible(input, { tabIds: ["tab-gone"] })).toBe(false);
  });

  test("treats an empty target set as nothing to invalidate", () => {
    expect(purgeTargetsRemainVisible(scene("ws-a"), {})).toBe(true);
  });
});
