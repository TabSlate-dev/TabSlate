// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GroupPurgeResult } from "@/store/groups-store";

mock.module("@/hooks/use-translation", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const groupsSnapshot = {
  groups: [],
  groupTabs: [],
  restoreGroup: () => undefined,
  createGroup: () => "group-created",
  addTabToGroup: () => undefined,
  deleteTabFromTrash: () => undefined,
  permanentlyDeleteGroup: async (): Promise<GroupPurgeResult> => ({ status: "completed" }),
};
const groupsHook = Object.assign(
  (selector: (state: typeof groupsSnapshot) => unknown) => selector(groupsSnapshot),
  { getState: () => groupsSnapshot },
);

mock.module("@/store/groups-store", () => ({
  useGroupsStore: groupsHook,
}));
mock.module("@/store/bookmarks-store", () => ({
  useBookmarksStore: () => undefined,
}));
mock.module("@/store/workspace-store", () => ({
  useWorkspaceStore: Object.assign(
    () => undefined,
    { getState: () => ({ activeWorkspaceId: "workspace-1" }) },
  ),
}));
mock.module("@/store/plan-store", () => ({
  usePlanStore: () => undefined,
}));
mock.module("@/lib/chrome/tab-groups", () => ({
  TAB_GROUP_COLORS: { blue: "#3b82f6" },
}));

const trashModule = await import(
  `../components/dashboard/trash-content.tsx?group-purge=${Date.now()}`
);

interface GroupPurgeActionInput {
  operation: () => Promise<GroupPurgeResult>;
  setPending: (pending: boolean) => void;
  onCompleted: () => void;
}

async function executeAction(input: GroupPurgeActionInput) {
  const action = trashModule.executeGroupPurgeAction;
  return action ? action(input) : undefined;
}

function deferredResult() {
  let resolve: (result: GroupPurgeResult) => void = () => undefined;
  const promise = new Promise<GroupPurgeResult>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Trash group purge outcomes", () => {
  test("keeps the dialog and selection for every recoverable purge outcome", async () => {
    const cases: Array<[GroupPurgeResult, string]> = [
      [{ status: "blocked", reason: "offline" }, "trashContent_groupPurgeOffline"],
      [{ status: "blocked", reason: "pending" }, "trashContent_groupPurgePending"],
      [{ status: "blocked", reason: "rejected" }, "trashContent_groupPurgeFailed"],
      [{ status: "blocked", reason: "storage" }, "trashContent_groupPurgeFailed"],
    ];

    for (const [result, messageKey] of cases) {
      let cleared = false;
      const outcome = await executeAction({
        operation: async () => result,
        setPending: () => undefined,
        onCompleted: () => {
          cleared = true;
        },
      });

      expect(outcome).toEqual({ shouldClose: false, messageKey });
      expect(cleared).toBe(false);
    }
  });

  test("converts a thrown Error into a visible failure without clearing selection", async () => {
    let cleared = false;

    const outcome = await executeAction({
      operation: async () => {
        throw new Error("network down");
      },
      setPending: () => undefined,
      onCompleted: () => {
        cleared = true;
      },
    });

    expect(outcome).toEqual({
      shouldClose: false,
      messageKey: "trashContent_groupPurgeFailed",
    });
    expect(cleared).toBe(false);
  });

  test("disables actions while awaiting completion and clears only after success", async () => {
    const deferred = deferredResult();
    const pendingStates: boolean[] = [];
    let cleared = false;

    const action = executeAction({
      operation: () => deferred.promise,
      setPending: (pending) => pendingStates.push(pending),
      onCompleted: () => {
        cleared = true;
      },
    });

    expect(pendingStates).toEqual([true]);
    expect(cleared).toBe(false);
    deferred.resolve({ status: "completed" });

    expect(await action).toEqual({ shouldClose: true, messageKey: null });
    expect(pendingStates).toEqual([true, false]);
    expect(cleared).toBe(true);
  });

  test("renders Group restore and purge controls disabled during a purge", () => {
    const Card = trashModule.TrashedGroupCard;
    const markup = Card
      ? renderToStaticMarkup(createElement(Card, {
          group: {
            id: "group-1",
            name: "Group",
            color: "blue",
            isCompact: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            seq: 1,
            deletedAt: 100,
            workspaceId: "workspace-1",
          },
          tabs: [],
          isGroupSelected: false,
          onToggleGroup: () => undefined,
          selectedTabIds: new Set<string>(),
          onToggleTab: () => undefined,
          onPermanentlyDeleteGroup: () => undefined,
          onPermanentlyDeleteTab: () => undefined,
          actionsDisabled: true,
        }))
      : "";

    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});
