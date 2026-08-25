// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Bookmark, Collection, Workspace } from "@/lib/types";
import type { SavedGroup } from "@/store/groups-store";
import type {
  WorkspaceLifecycleAction,
  WorkspaceLifecycleActionAvailabilityInput,
} from "@/components/dashboard/workspace-manager/model";

mock.module("@/hooks/use-translation", () => ({
  useTranslation: () => ({
    t: (key: string, substitutions?: string | string[]) => {
      const values = substitutions
        ? Array.isArray(substitutions) ? substitutions : [substitutions]
        : [];
      return `${key}${values.length > 0 ? `:${values.join("|")}` : ""}`;
    },
  }),
}));

function unusedStoreHook(): never {
  throw new Error("The pure WorkspaceManagerContent render must not read application stores");
}

mock.module("@/store/workspace-store", () => ({
  useWorkspaceStore: unusedStoreHook,
  WORKSPACE_COLORS: ["blue"],
  WORKSPACE_GRADIENTS: { blue: "from-blue-400 to-blue-600" },
}));
mock.module("@/store/auth-store", () => ({ useAuthStore: unusedStoreHook }));
mock.module("@/store/bookmarks-store", () => ({ useBookmarksStore: unusedStoreHook }));
mock.module("@/store/groups-store", () => ({ useGroupsStore: unusedStoreHook }));
mock.module("@/store/plan-store", () => ({ usePlanStore: unusedStoreHook }));
mock.module("@/lib/workspace-lifecycle-state", () => ({
  readWorkspaceLifecycleCapability: () => Promise.resolve(true),
}));

const {
  canConfirmPermanentDelete,
  createDeleteWorkspaceConfirmation,
  createWorkspaceManagerViewModel,
  executeWorkspaceManagerAction,
  getWorkspaceActionResultMessageKey,
  getWorkspaceLifecycleActionAvailability,
  resolveWorkspaceManagerOnlineStatus,
} = await import("../components/dashboard/workspace-manager/model");
const { WorkspaceManagerContent } = await import(
  `../components/dashboard/workspace-manager/index.tsx?test=${Date.now()}`
);

function workspace(
  id: string,
  name: string,
  position: number,
  deletedAt?: number,
): Workspace {
  return { id, name, color: "blue", position, seq: 1, deletedAt };
}

function collection(id: string, workspaceId: string): Collection {
  return {
    id,
    workspaceId,
    name: id,
    icon: "inbox",
    position: 0,
    seq: 1,
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
    createdAt: "2026-01-01T00:00:00.000Z",
    isFavorite: false,
    seq: 1,
  };
}

function group(id: string, workspaceId: string): SavedGroup {
  return {
    id,
    workspaceId,
    name: id,
    color: "blue",
    isCompact: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
  };
}

const noOp = () => undefined;

describe("createWorkspaceManagerViewModel", () => {
  test("partitions active and deleted roots while counting every descendant bookmark bucket", () => {
    const deletedAt = Date.UTC(2026, 7, 1);
    const model = createWorkspaceManagerViewModel({
      workspaces: [
        workspace("active", "Active", 0),
        workspace("deleted", "Deleted", 1, deletedAt),
      ],
      collections: [
        collection("active-col", "active"),
        collection("deleted-col", "deleted"),
      ],
      bookmarks: {
        active: [bookmark("active-bookmark", "deleted-col")],
        archived: [bookmark("archived-bookmark", "deleted-col")],
        trashed: [bookmark("trashed-bookmark", "deleted-col")],
      },
      groups: [group("deleted-group", "deleted")],
      now: Date.UTC(2026, 7, 11),
      trashGraceDays: 30,
      isGuest: false,
    });

    expect(model.inUse.map((card) => card.workspace.id)).toEqual(["active"]);
    expect(model.deleted.map((card) => card.workspace.id)).toEqual(["deleted"]);
    expect(model.deleted[0]?.counts).toEqual({
      collections: 1,
      bookmarks: 3,
      savedGroups: 1,
    });
    expect(model.deleted[0]?.retention).toEqual({ kind: "remaining", days: 20 });
    expect(model.inUse[0]?.retention).toEqual({ kind: "remaining", days: 30 });
    expect(model.inUse[0]?.canDelete).toBe(false);
  });

  test("models expired, unlimited, and Guest retention without inventing an expiry", () => {
    const deleted = workspace("deleted", "Deleted", 0, Date.UTC(2026, 7, 1));
    const common = {
      workspaces: [deleted],
      collections: [],
      bookmarks: { active: [], archived: [], trashed: [] },
      groups: [],
      now: Date.UTC(2026, 8, 1),
    };

    expect(createWorkspaceManagerViewModel({
      ...common,
      trashGraceDays: 30,
      isGuest: false,
    }).deleted[0]?.retention).toEqual({ kind: "expired" });
    expect(createWorkspaceManagerViewModel({
      ...common,
      trashGraceDays: -1,
      isGuest: false,
    }).deleted[0]?.retention).toEqual({ kind: "unlimited" });
    expect(createWorkspaceManagerViewModel({
      ...common,
      trashGraceDays: 30,
      isGuest: true,
    }).deleted[0]?.retention).toEqual({ kind: "guest" });
  });

  test("deduplicates one bookmark ID across active, archived, and trashed buckets", () => {
    const model = createWorkspaceManagerViewModel({
      workspaces: [workspace("workspace", "Workspace", 0)],
      collections: [collection("collection", "workspace")],
      bookmarks: {
        active: [bookmark("same", "collection")],
        archived: [bookmark("same", "collection")],
        trashed: [bookmark("same", "collection")],
      },
      groups: [],
      now: Date.UTC(2026, 7, 11),
      trashGraceDays: 30,
      isGuest: false,
    });

    expect(model.inUse[0]?.counts.bookmarks).toBe(1);
  });
});

describe("Workspace lifecycle guards", () => {
  test("requires another active Workspace before opening soft-delete confirmation", () => {
    expect(getWorkspaceLifecycleActionAvailability({
      action: "delete",
      activeWorkspaceCount: 1,
      isGuest: false,
      isOnline: true,
      capabilitySupported: true,
    })).toEqual({
      enabled: false,
      messageKey: "workspaceManager_lastActiveGuard",
    });
  });

  test("requires a current server capability for authenticated lifecycle actions", () => {
    expect(getWorkspaceLifecycleActionAvailability({
      action: "restore",
      activeWorkspaceCount: 1,
      isGuest: false,
      isOnline: true,
      capabilitySupported: false,
    })).toEqual({
      enabled: false,
      messageKey: "workspaceManager_updateServerRequired",
    });
  });

  test("allows cached-capability soft actions offline but blocks authenticated purge", () => {
    expect(getWorkspaceLifecycleActionAvailability({
      action: "delete",
      activeWorkspaceCount: 2,
      isGuest: false,
      isOnline: false,
      capabilitySupported: true,
    }).enabled).toBe(true);
    expect(getWorkspaceLifecycleActionAvailability({
      action: "purge",
      activeWorkspaceCount: 1,
      isGuest: false,
      isOnline: false,
      capabilitySupported: true,
    })).toEqual({
      enabled: false,
      messageKey: "workspaceManager_offlinePurge",
    });
  });

  test("requires the exact case-sensitive Workspace name before permanent deletion", () => {
    expect(canConfirmPermanentDelete("alpha", "Alpha")).toBe(false);
    expect(canConfirmPermanentDelete("Alpha ", "Alpha")).toBe(false);
    expect(canConfirmPermanentDelete("Alpha", "Alpha")).toBe(true);
  });

  test("carries aggregate, retention, and quota facts into soft-delete confirmation", () => {
    const confirmation = createDeleteWorkspaceConfirmation({
      workspace: workspace("workspace", "Workspace", 0),
      counts: { collections: 2, bookmarks: 7, savedGroups: 3 },
      retention: { kind: "remaining", days: 14 },
      canDelete: true,
    });

    expect(confirmation).toEqual({
      workspaceId: "workspace",
      workspaceName: "Workspace",
      counts: { collections: 2, bookmarks: 7, savedGroups: 3 },
      retention: { kind: "remaining", days: 14 },
      quotaMessageKey: "workspaceManager_stillCountsTowardQuota",
    });
  });

  test("does not treat an unconfirmed purge as permanent-deletion success", () => {
    expect(getWorkspaceActionResultMessageKey(
      { status: "queued" },
      "purge",
    )).toBe("workspaceManager_purgePending");
    expect(getWorkspaceActionResultMessageKey(
      { status: "completed" },
      "purge",
    )).toBeNull();
  });

  test("uses browser and sync state instead of token presence as connectivity", () => {
    expect(resolveWorkspaceManagerOnlineStatus(true, "offline")).toBe(false);
    expect(resolveWorkspaceManagerOnlineStatus(false, "idle")).toBe(false);
    expect(resolveWorkspaceManagerOnlineStatus(true, "idle")).toBe(true);
  });

  test("resets busy and returns a visible recoverable failure when any lifecycle action rejects", async () => {
    const actions: WorkspaceLifecycleAction[] = ["delete", "restore", "purge"];
    for (const action of actions) {
      const busyStates: boolean[] = [];
      const outcome = await executeWorkspaceManagerAction({
        action,
        operation: async () => {
          throw new Error("network down");
        },
        setBusy: (busy: boolean) => {
          busyStates.push(busy);
        },
      });

      expect(busyStates).toEqual([true, false]);
      expect(outcome).toEqual({
        shouldClose: false,
        messageKey: "workspaceManager_actionFailed",
      });
    }
  });

  test("blocks lifecycle actions while aggregate buckets are loading", () => {
    const loadingInput: WorkspaceLifecycleActionAvailabilityInput = {
      action: "purge",
      activeWorkspaceCount: 1,
      isGuest: false,
      isOnline: true,
      capabilitySupported: true,
      dataReady: false,
    };

    expect(getWorkspaceLifecycleActionAvailability(loadingInput)).toEqual({
      enabled: false,
      messageKey: "workspaceManager_loadingData",
    });
  });
});

describe("WorkspaceManagerContent", () => {
  const model = createWorkspaceManagerViewModel({
    workspaces: [
      workspace("active", "Active", 0),
      workspace("deleted", "Deleted", 1, Date.UTC(2026, 7, 1)),
    ],
    collections: [collection("deleted-col", "deleted")],
    bookmarks: { active: [], archived: [], trashed: [] },
    groups: [],
    now: Date.UTC(2026, 7, 11),
    trashGraceDays: 30,
    isGuest: false,
  });

  const handlers = {
    onTabChange: noOp,
    onCreate: noOp,
    onSwitch: noOp,
    onRename: noOp,
    onRecolor: noOp,
    onDelete: noOp,
    onRestore: noOp,
    onPermanentlyDelete: noOp,
  };

  test("renders semantic In use and Deleted tabs with matching panels", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceManagerContent, {
      model,
      selectedTab: "in_use",
      ...handlers,
    }));

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-controls="workspace-manager-panel-in-use"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('aria-labelledby="workspace-manager-tab-in-use"');
    expect(markup).toContain('id="workspace-manager-panel-in-use"');
    expect(markup).toContain('id="workspace-manager-panel-deleted"');
    expect(markup).toContain("hidden");
    expect(markup).toContain("inert");
  });

  test("puts create, switch, rename, recolor, and delete actions in In use", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceManagerContent, {
      model,
      selectedTab: "in_use",
      ...handlers,
    }));

    expect(markup).toContain("workspaceManager_create");
    expect(markup).toContain("workspaceManager_switch");
    expect(markup).toContain("workspaceManager_rename");
    expect(markup).toContain("workspaceManager_recolor");
    expect(markup).toContain("workspaceManager_delete");
    expect(markup).toContain("workspaceManager_lastActiveGuard");
  });

  test("shows retained aggregate facts and quota warning in the Deleted panel", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceManagerContent, {
      model,
      selectedTab: "deleted",
      ...handlers,
    }));

    expect(markup).toContain("Deleted");
    expect(markup).toContain("workspaceManager_collectionCount_one:1");
    expect(markup).toContain("workspaceManager_deletedAt:");
    expect(markup).toContain("workspaceManager_retentionRemaining_other:20");
    expect(markup).toContain("workspaceManager_stillCountsTowardQuota");
    expect(markup).toContain("workspaceManager_restore");
    expect(markup).toContain("workspaceManager_permanentlyDelete");
  });

  test("shows loading instead of incomplete aggregate cards until both buckets load", () => {
    const loadingAvailability = {
      isGuest: false,
      isOnline: true,
      capabilitySupported: true,
      dataReady: false,
    };
    const markup = renderToStaticMarkup(createElement(WorkspaceManagerContent, {
      model,
      selectedTab: "deleted",
      availability: loadingAvailability,
      ...handlers,
    }));

    expect(markup).toContain("workspaceManager_loadingData");
    expect(markup).not.toContain("workspaceManager_stillCountsTowardQuota");
  });
});
