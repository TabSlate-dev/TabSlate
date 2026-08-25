// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import type { Collection, Workspace } from "@/lib/types";
import {
  belongsToActiveWorkspace,
  getActiveWorkspaceCollectionIds,
  getCollectionsUnderActiveWorkspace,
  resolveActiveWorkspaceCollectionTarget,
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
