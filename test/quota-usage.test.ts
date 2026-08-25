// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import type { Bookmark, Collection, Tag, Workspace } from "@/lib/types";
import type { PlanUsage } from "@/lib/api";
import type { SavedGroup } from "@/store/groups-store";
import {
  calculateGuestQuotaUsage,
  createQuotaBreakdown,
} from "@/lib/quota-usage";

function workspace(id: string, deletedAt?: number): Workspace {
  return { id, name: id, color: "blue", position: 0, seq: 0, deletedAt };
}

function collection(
  id: string,
  workspaceId: string,
  lifecycle: Pick<Collection, "deletedAt" | "archivedAt"> = {},
): Collection {
  return {
    id,
    workspaceId,
    name: id,
    icon: "folder",
    position: 0,
    seq: 0,
    ...lifecycle,
  };
}

function bookmark(id: string, collectionId: string): Bookmark {
  return {
    id,
    collectionId,
    title: id,
    url: `https://${id}.example`,
    description: "",
    favicon: "",
    tags: [],
    createdAt: "2026-08-25T00:00:00.000Z",
    isFavorite: false,
    seq: 0,
  };
}

function group(id: string, workspaceId: string, deletedAt?: number): SavedGroup {
  return {
    id,
    workspaceId,
    name: id,
    color: "blue",
    isCompact: false,
    createdAt: "2026-08-25T00:00:00.000Z",
    seq: 0,
    deletedAt,
  };
}

function tag(id: string): Tag {
  return { id, name: id, color: "blue", seq: 0 };
}

describe("quota usage breakdown", () => {
  test("counts effective nested trash once while archived resources stay in use", () => {
    const result = calculateGuestQuotaUsage({
      workspaces: [workspace("active"), workspace("retained", 100)],
      collections: [
        collection("active-col", "active"),
        collection("archived-col", "active", { archivedAt: 50 }),
        collection("trashed-col", "retained", { deletedAt: 75 }),
        collection("retained-child", "retained"),
      ],
      bookmarks: [
        bookmark("active-bookmark", "active-col"),
        bookmark("parent-trashed-bookmark", "trashed-col"),
        bookmark("workspace-trashed-bookmark", "retained-child"),
      ],
      archivedBookmarks: [bookmark("archived-bookmark", "archived-col")],
      trashedBookmarks: [
        // This row is individually trashed, belongs to a trashed Collection,
        // and that Collection belongs to a retained Workspace. It is one row.
        bookmark("nested-trash-bookmark", "trashed-col"),
      ],
      groups: [
        group("active-group", "active"),
        group("deleted-group", "active", 80),
        group("retained-group", "retained"),
      ],
      tags: [tag("first-tag"), tag("second-tag")],
    });

    expect(result).toEqual({
      total: {
        workspaces: 2,
        collections: 4,
        bookmarks: 5,
        tags: 2,
        saved_groups: 3,
      },
      trash: {
        workspaces: 1,
        collections: 2,
        bookmarks: 3,
        tags: 0,
        saved_groups: 2,
      },
      inUse: {
        workspaces: 1,
        collections: 2,
        bookmarks: 2,
        tags: 2,
        saved_groups: 1,
      },
    });
  });

  test("clamps malformed trash snapshots so in-use values never go negative", () => {
    const total: PlanUsage = {
      workspaces: 1,
      collections: 2,
      bookmarks: 3,
      tags: 0,
      saved_groups: 4,
    };
    const trash: PlanUsage = {
      workspaces: 2,
      collections: 1,
      bookmarks: 10,
      tags: 5,
      saved_groups: 0,
    };

    expect(createQuotaBreakdown(total, trash)).toEqual({
      total,
      trash: {
        workspaces: 1,
        collections: 1,
        bookmarks: 3,
        tags: 0,
        saved_groups: 0,
      },
      inUse: {
        workspaces: 0,
        collections: 1,
        bookmarks: 0,
        tags: 0,
        saved_groups: 4,
      },
    });
  });
});
